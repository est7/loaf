// journal-append — append a typed JournalEntry to `.loaf/<feature>/journal.jsonl`.
//
// Stage 1 scope: single-entry append with envelope validation and atomic
// single-write semantics. Full §11.2 10-step transaction (preflight reducer
// dry-run, sidecar promotion, snapshot rebuild, _meta fast-check, monotonic
// seq invariant, batch markers) lands in later stages per docs/plan.md.

import { promises as fsp } from "node:fs";
import { O_APPEND, O_CREAT, O_WRONLY } from "node:constants";

import { ENTRY_BYTE_LIMIT, JournalEntry, PER_KIND_PAYLOAD } from "./journal-entry.js";

// readTailSeq — return the seq of the last entry in the journal file, or -1
// if the file does not exist or is empty. Stage 1 minimal: full-file read is
// fine for short journals; later stages (Gate #5 / _meta.json fast check)
// replace this with constant-time tail seek.
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
 * `appendEntry` is §11.2 step 5+6 (final validate + atomic single-write) only.
 * It does NOT run preflight (cursor / ceremony / authority checks), does NOT
 * promote sidecars, does NOT call reducer.apply. Calling it directly skips
 * the rest of the §11.2 transaction and can leave a journal entry without
 * a matching projection mutation (a corruption marker).
 *
 * **Use `mutate()` from `src/core/journal-mutate.ts` instead.** That is the
 * single sanctioned public mutator path; it composes preflight + sidecar +
 * appendEntry + reducer apply atomically per the audit r2 ordering fix.
 *
 * Internal callers (migration bootstrap, sidecar/atomicity tests) may still
 * use `appendEntry` directly when they need raw append semantics, but every
 * such call MUST be paired with a comment explaining why mutate() is bypassed.
 */
export async function appendEntry(
  filePath: string,
  entry: JournalEntry,
  opts: AppendOptions = {},
): Promise<void> {
  // §11.2 step 5 (final validate, Gate #2) — re-Zod-parse the entry in its
  // final form before opening the journal file.
  const parsed = JournalEntry.safeParse(entry);
  if (!parsed.success) {
    throw new AppendError(
      "INVALID_ENVELOPE",
      "JournalEntry failed envelope schema validation",
      { issues: parsed.error.issues },
    );
  }

  // Step 5 also enforces per-kind payload narrowing (audit r1 fix #4).
  // Without this gate a caller can hand appendEntry an envelope-valid entry
  // whose payload is a literal string / scalar / arbitrary shape — Gate #2
  // is then envelope-only, not contract-level.
  const payloadSchema = PER_KIND_PAYLOAD[parsed.data.kind];
  const payloadParsed = payloadSchema.safeParse(parsed.data.payload);
  if (!payloadParsed.success) {
    throw new AppendError(
      "INVALID_PAYLOAD",
      `payload schema validation failed for kind=${parsed.data.kind}`,
      { kind: parsed.data.kind, issues: payloadParsed.error.issues },
    );
  }

  // Monotonic seq invariant: a new entry must extend the tail by exactly +1.
  // First entry into an empty/absent journal must have seq=0.
  const tailSeq = await readTailSeq(filePath);
  const expectedSeq = tailSeq + 1;
  if (parsed.data.seq !== expectedSeq) {
    throw new AppendError(
      "SEQ_NOT_MONOTONIC",
      `entry.seq=${parsed.data.seq} but expected ${expectedSeq} (tail seq=${tailSeq})`,
      { got: parsed.data.seq, expected: expectedSeq, tail_seq: tailSeq },
    );
  }

  const fsyncEnabled = opts.fsync ?? true;
  const line = JSON.stringify(parsed.data) + "\n";
  const buf = Buffer.from(line, "utf8");

  // §11.2 step 5b — hard byte ceiling per entry. LongTextField sidecar
  // promotion (Stage 4) is the proper escape path for oversize payloads;
  // Stage 1 simply rejects.
  if (buf.length > ENTRY_BYTE_LIMIT) {
    throw new AppendError(
      "ENTRY_OVERSIZE",
      `entry serialized to ${buf.length} bytes; limit ${ENTRY_BYTE_LIMIT}`,
      { kind: parsed.data.kind, bytes: buf.length, limit: ENTRY_BYTE_LIMIT },
    );
  }

  const fh = await fsp.open(filePath, O_APPEND | O_WRONLY | O_CREAT, 0o644);
  try {
    const result = await fh.write(buf, 0, buf.length);
    if (result.bytesWritten !== buf.length) {
      throw new AppendError(
        "SHORT_WRITE",
        `wrote ${result.bytesWritten} of ${buf.length} bytes — append integrity broken`,
        { wrote: result.bytesWritten, want: buf.length },
      );
    }
    if (fsyncEnabled) {
      await fh.sync();
    }
  } finally {
    await fh.close();
  }
}
