// journal-append — append typed JournalEntry/-ies to `.loaf/<feature>/journal.jsonl`.
//
// `appendMany` is the low-level §11.2 step 5+6 append primitive for
// final-form entries: pre-validate every entry, then one newline-joined
// `write()` for the whole batch. `appendEntry` is the single-entry
// shorthand for `appendMany([entry])`.
//
// Contract:
//   - prevalidate all entries (envelope + per-kind payload + monotonic seq
//     + per-entry byte cap + batch-total byte cap) BEFORE opening the file
//     → journal untouched on prevalidation failure
//   - one buffer, one `write()` + optional `fsync()` → atomic from the
//     filesystem's view of this process
//   - if a short-write or fsync error fires AFTER `write()` has started,
//     the journal is left in a possibly-corrupt state and a hard
//     SHORT_WRITE error is thrown; recovery is doctor's job (§10.15
//     tail-corruption check), NOT in-process rollback
//
// `appendEntry` / `appendMany` do NOT run preflight (cursor / ceremony /
// authority), do NOT promote sidecars, do NOT call reducer.apply. Use
// `mutate()` or `mutateBatch()` from `src/core/journal-mutate.ts` — those
// compose preflight + sidecar + reducer dry-run (Pass 1) + sidecar
// promotion (Pass 2) + final dry-run on promoted entries (Pass 3) + this
// primitive (Pass 4 = single fsync'd append).

import { promises as fsp } from "node:fs";
import { O_APPEND, O_CREAT, O_WRONLY } from "node:constants";

import { ENTRY_BYTE_LIMIT, JournalEntry, PER_KIND_PAYLOAD } from "./journal-entry.js";

// readTailSeq — return the seq of the last entry in the journal file, or -1
// if the file does not exist or is empty. Full-file read is fine for short
// journals; Gate #5 / _meta.json fast check supersedes later.
async function readTailSeq(filePath: string): Promise<number> {
  let text: string;
  try {
    text = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return -1;
    throw err;
  }
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return -1;
  const lastNl = trimmed.lastIndexOf("\n");
  const lastLine = lastNl === -1 ? trimmed : trimmed.slice(lastNl + 1);
  const parsed = JSON.parse(lastLine) as { seq: unknown };
  if (typeof parsed.seq !== "number" || !Number.isInteger(parsed.seq)) {
    throw new AppendError(
      "TAIL_CORRUPTION",
      "journal tail line has non-integer seq; rebuild required",
      { tail: lastLine.slice(0, 200) },
    );
  }
  return parsed.seq;
}

export interface AppendOptions {
  fsync?: boolean;
}

export class AppendError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = "AppendError";
  }
}

/**
 * **Internal primitive — do not call from CLI or skill code.**
 *
 * `appendMany` is §11.2 step 5+6 for batches: pre-validate every entry, then
 * one newline-joined `write()`. It does NOT run preflight, NOT promote
 * sidecars, NOT call reducer.apply. Use `mutate()` or `mutateBatch()` from
 * `src/core/journal-mutate.ts` for the sanctioned mutation path —
 * `mutateBatch` wraps this primitive after preflight + sidecar promotion +
 * Pass-3 final dry-run on promoted entries.
 *
 * Atomicity boundary:
 *   - Failures DURING prevalidation (INVALID_ENVELOPE / INVALID_PAYLOAD /
 *     SEQ_NOT_MONOTONIC / ENTRY_OVERSIZE) leave the journal file untouched.
 *   - Failures DURING the write or fsync (SHORT_WRITE with `phase` detail)
 *     leave the journal in a potentially-corrupt state. The caller MUST
 *     treat this as non-recoverable in-process; `loaf doctor --check-tail`
 *     handles repair.
 */
export async function appendMany(
  filePath: string,
  entries: JournalEntry[],
  opts: AppendOptions = {},
): Promise<void> {
  if (entries.length === 0) {
    throw new AppendError(
      "INVALID_ENVELOPE",
      "appendMany called with empty entries array; pass at least one entry",
      { entries_length: 0 },
    );
  }

  const fsyncEnabled = opts.fsync ?? true;
  const tailSeq = await readTailSeq(filePath);
  let nextExpected = tailSeq + 1;
  const lineBuffers: Buffer[] = [];

  for (const entry of entries) {
    const parsed = JournalEntry.safeParse(entry);
    if (!parsed.success) {
      throw new AppendError(
        "INVALID_ENVELOPE",
        "JournalEntry failed envelope schema validation",
        { issues: parsed.error.issues },
      );
    }
    const payloadSchema = PER_KIND_PAYLOAD[parsed.data.kind];
    const payloadParsed = payloadSchema.safeParse(parsed.data.payload);
    if (!payloadParsed.success) {
      throw new AppendError(
        "INVALID_PAYLOAD",
        `payload schema validation failed for kind=${parsed.data.kind}`,
        { kind: parsed.data.kind, issues: payloadParsed.error.issues },
      );
    }
    if (parsed.data.seq !== nextExpected) {
      throw new AppendError(
        "SEQ_NOT_MONOTONIC",
        `entry.seq=${parsed.data.seq} but expected ${nextExpected} (tail seq=${tailSeq})`,
        { got: parsed.data.seq, expected: nextExpected, tail_seq: tailSeq },
      );
    }
    const line = JSON.stringify(parsed.data) + "\n";
    const lineBuf = Buffer.from(line, "utf8");
    if (lineBuf.length > ENTRY_BYTE_LIMIT) {
      throw new AppendError(
        "ENTRY_OVERSIZE",
        `entry serialized to ${lineBuf.length} bytes; limit ${ENTRY_BYTE_LIMIT}`,
        { kind: parsed.data.kind, bytes: lineBuf.length, limit: ENTRY_BYTE_LIMIT },
      );
    }
    lineBuffers.push(lineBuf);
    nextExpected += 1;
  }

  const buf = Buffer.concat(lineBuffers);

  // Batch-total byte cap per protocol.md §11.2 step 5b: a single write() must
  // be ≤ ENTRY_BYTE_LIMIT regardless of how many entries it carries. Each
  // entry was already individually capped above; this catches the case where
  // N under-limit entries together exceed the per-write ceiling.
  if (buf.length > ENTRY_BYTE_LIMIT) {
    throw new AppendError(
      "ENTRY_OVERSIZE",
      `batch serialized to ${buf.length} bytes; per-write limit ${ENTRY_BYTE_LIMIT}`,
      { scope: "batch", bytes: buf.length, limit: ENTRY_BYTE_LIMIT, entries: entries.length },
    );
  }

  const fh = await fsp.open(filePath, O_APPEND | O_WRONLY | O_CREAT, 0o644);
  try {
    const result = await fh.write(buf, 0, buf.length);
    if (result.bytesWritten !== buf.length) {
      throw new AppendError(
        "SHORT_WRITE",
        `wrote ${result.bytesWritten} of ${buf.length} bytes — append integrity broken; journal may be corrupt, run \`loaf doctor --check-tail\``,
        { phase: "write", wrote: result.bytesWritten, want: buf.length },
      );
    }
    if (fsyncEnabled) {
      try {
        await fh.sync();
      } catch (err) {
        throw new AppendError(
          "SHORT_WRITE",
          `fsync failed after write — journal may be corrupt, run \`loaf doctor --check-tail\``,
          { phase: "fsync", err: String(err) },
        );
      }
    }
  } finally {
    await fh.close();
  }
}

/**
 * **Internal primitive — do not call from CLI or skill code.**
 *
 * `appendEntry` is the single-entry shorthand for `appendMany([entry])`; it
 * preserves the original surface for callers that have always emitted one
 * entry. Identical semantics: pre-validate then one write.
 *
 * Use `mutate()` from `src/core/journal-mutate.ts` for the sanctioned
 * mutation path — `appendEntry` skips preflight / sidecar / reducer.
 */
export async function appendEntry(
  filePath: string,
  entry: JournalEntry,
  opts: AppendOptions = {},
): Promise<void> {
  await appendMany(filePath, [entry], opts);
}
