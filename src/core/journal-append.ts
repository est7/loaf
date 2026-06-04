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
//   - the caller supplies the prior `SnapshotMeta` (the `_meta.json` /
//     replay-accumulated meta as of the current journal tail); `appendMany`
//     validates it against the actual journal tail BEFORE writing — a stale
//     or wrong-prefix meta is a hard PRIOR_META_STALE failure (journal
//     untouched)
//   - one buffer, one `write()` + optional `fsync()` → atomic from the
//     filesystem's view of this process
//   - on success `appendMany` RETURNS the post-append `SnapshotMeta` — the
//     incremental fold of `computeLineHash` / `extendRollingChecksum` over
//     the appended lines. It is byte-identical to what `replayJournal` would
//     compute for the same final journal file (only `written_at`, a fresh
//     timestamp, differs). Phase 15 SC2 threads this return value into
//     `writeProjections` so `_meta.json` stays fresh on every mutation.
//   - if a short-write or fsync error fires AFTER `write()` has started,
//     the journal is left in a possibly-corrupt state and a hard
//     SHORT_WRITE error is thrown; recovery is doctor's job (§10.15
//     tail-corruption check), NOT in-process rollback — NO meta is returned
//
// `appendEntry` / `appendMany` do NOT run preflight (cursor / ceremony /
// authority), do NOT promote sidecars, do NOT call reducer.apply. Use
// `mutate()` or `mutateBatch()` from `src/core/journal-mutate.ts` — those
// compose preflight + sidecar + reducer dry-run (Pass 1) + sidecar
// promotion (Pass 2) + final dry-run on promoted entries (Pass 3) + this
// primitive (Pass 4 = single fsync'd append) + projection writes (step 8).

import { promises as fsp } from "node:fs";
import { O_APPEND, O_CREAT, O_WRONLY } from "node:constants";

import { ENTRY_BYTE_LIMIT, JournalEntry } from "./journal-entry.js";
import { PER_KIND_PAYLOAD } from "./kind-registry.js";
import {
  computeLineHash,
  extendRollingChecksum,
  FEATURE_SCHEMA_VERSION,
  isEmptyMeta,
  type SnapshotMeta,
} from "./snapshot.js";

// readJournalTail — read the journal file ONCE and return the facts the
// append primitive needs about the current tail:
//   - `tailSeq`   — seq of the last entry, or -1 if the file is empty/absent
//   - `fileSize`  — current byte length (the offset where the next append
//                   begins; the LAST appended line for a 1-entry batch starts
//                   exactly here)
//   - `tailLine`  — the last complete line WITHOUT its trailing `\n`, or null
//                   for an empty/absent journal; used to verify the prior
//                   meta's `last_entry_line_hash` against on-disk truth
// Full-file read is fine for short journals; Gate #5 / _meta.json fast check
// supersedes later.
async function readJournalTail(
  filePath: string,
): Promise<{ tailSeq: number; fileSize: number; tailLine: string | null }> {
  let text: string;
  try {
    text = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { tailSeq: -1, fileSize: 0, tailLine: null };
    }
    throw err;
  }
  const fileSize = Buffer.byteLength(text, "utf8");
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) {
    return { tailSeq: -1, fileSize, tailLine: null };
  }
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
  return { tailSeq: parsed.seq, fileSize, tailLine: lastLine };
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
 * `priorMeta` is the `SnapshotMeta` as of the current journal tail (the
 * caller's replay-accumulated meta / `_meta.json`). `appendMany` validates
 * it against the actual journal tail BEFORE writing — a `last_applied_seq`
 * or `last_entry_line_hash` mismatch is a hard PRIOR_META_STALE failure with
 * the journal left untouched. On success the returned `SnapshotMeta` is the
 * post-append meta: its `last_applied_seq` / `last_entry_offset` /
 * `last_entry_line_hash` / `rolling_checksum` are byte-identical to what
 * `replayJournal` would compute for the same final journal (`written_at`
 * differs — a fresh timestamp).
 *
 * Atomicity boundary:
 *   - Failures DURING prevalidation (PRIOR_META_STALE / INVALID_ENVELOPE /
 *     INVALID_PAYLOAD / SEQ_NOT_MONOTONIC / ENTRY_OVERSIZE) leave the journal
 *     file untouched and return NO meta (they throw).
 *   - Failures DURING the write or fsync (SHORT_WRITE with `phase` detail)
 *     leave the journal in a potentially-corrupt state and return NO meta.
 *     The caller MUST treat this as non-recoverable in-process; `loaf doctor
 *     --check-tail` handles repair.
 */
export async function appendMany(
  filePath: string,
  entries: JournalEntry[],
  priorMeta: SnapshotMeta,
  opts: AppendOptions = {},
): Promise<SnapshotMeta> {
  if (entries.length === 0) {
    throw new AppendError(
      "INVALID_ENVELOPE",
      "appendMany called with empty entries array; pass at least one entry",
      { entries_length: 0 },
    );
  }

  const fsyncEnabled = opts.fsync ?? true;
  const { tailSeq, fileSize, tailLine } = await readJournalTail(filePath);

  // Prior-meta validation — BEFORE any write. `priorMeta` must describe the
  // exact journal tail we are about to extend; otherwise the returned
  // post-append meta (its `rolling_checksum` extends `priorMeta`'s) would be
  // authoritative for the wrong prefix.
  if (tailSeq === -1) {
    // Empty/absent journal — `priorMeta` must be the empty sentinel. A
    // fresh-prefix meta carrying a non-empty `rolling_checksum` /
    // `last_entry_offset` would fold into a post-append meta that no longer
    // matches `replayJournal` (codex r171 BLOCK 2). seq alone is not enough.
    if (!isEmptyMeta(priorMeta)) {
      throw new AppendError(
        "PRIOR_META_STALE",
        "journal tail is empty (seq -1) but priorMeta is not the empty sentinel; a non-empty prior meta would corrupt the post-append rolling checksum",
        { meta_seq: priorMeta.last_applied_seq, tail_seq: tailSeq },
      );
    }
  } else {
    // Non-empty journal — `priorMeta` must match the actual tail: seq, the
    // tail line's hash, and the tail line's start offset. (Full rolling-chain
    // re-verification stays a `doctor --verify-checksum` concern.)
    if (priorMeta.last_applied_seq !== tailSeq) {
      throw new AppendError(
        "PRIOR_META_STALE",
        `priorMeta.last_applied_seq=${priorMeta.last_applied_seq} but journal tail seq=${tailSeq}; the prior meta does not describe the current journal tail`,
        { meta_seq: priorMeta.last_applied_seq, tail_seq: tailSeq },
      );
    }
    if (tailLine === null) {
      throw new AppendError(
        "TAIL_CORRUPTION",
        `journal tail seq=${tailSeq} but no readable tail line; rebuild required`,
        { tail_seq: tailSeq },
      );
    }
    if (computeLineHash(tailLine) !== priorMeta.last_entry_line_hash) {
      throw new AppendError(
        "PRIOR_META_STALE",
        "priorMeta.last_entry_line_hash does not match the journal tail line; the prior meta does not describe the current journal tail",
        { meta_seq: priorMeta.last_applied_seq, tail_seq: tailSeq },
      );
    }
    const expectedTailOffset = fileSize - Buffer.byteLength(tailLine + "\n", "utf8");
    if (priorMeta.last_entry_offset !== expectedTailOffset) {
      throw new AppendError(
        "PRIOR_META_STALE",
        `priorMeta.last_entry_offset=${priorMeta.last_entry_offset} but the journal tail line starts at byte ${expectedTailOffset}; the prior meta does not describe the current journal tail`,
        {
          meta_offset: priorMeta.last_entry_offset,
          expected_offset: expectedTailOffset,
          tail_seq: tailSeq,
        },
      );
    }
  }

  let nextExpected = tailSeq + 1;
  const lineBuffers: Buffer[] = [];
  const lineStrings: string[] = [];

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
    // `lineString` is the serialized entry WITHOUT the trailing newline —
    // the exact bytes `computeLineHash` / `extendRollingChecksum` (and
    // `replayJournal`) fold. `lineBuffer` carries the `\n` for the write.
    const lineString = JSON.stringify(parsed.data);
    const lineBuf = Buffer.from(lineString + "\n", "utf8");
    if (lineBuf.length > ENTRY_BYTE_LIMIT) {
      throw new AppendError(
        "ENTRY_OVERSIZE",
        `entry serialized to ${lineBuf.length} bytes; limit ${ENTRY_BYTE_LIMIT}`,
        { kind: parsed.data.kind, bytes: lineBuf.length, limit: ENTRY_BYTE_LIMIT },
      );
    }
    lineBuffers.push(lineBuf);
    lineStrings.push(lineString);
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

  // Write+fsync succeeded — compute the post-append meta incrementally. The
  // result must be byte-identical to `replayJournal` over the same final
  // journal (it folds the same `computeLineHash` / `extendRollingChecksum`
  // over every line, no `\n`, tracking each line's start offset).
  //
  //   - last_entry_offset — the byte offset where the LAST appended line
  //     starts: `fileSize` (the pre-append EOF) plus the byte length of every
  //     earlier appended line. For a 1-entry batch this is exactly `fileSize`.
  //   - rolling_checksum — fold `extendRollingChecksum` over `priorMeta`'s
  //     chain with each appended line (no `\n`) in journal order.
  let lastEntryOffset = fileSize;
  for (let i = 0; i < lineBuffers.length - 1; i++) {
    lastEntryOffset += lineBuffers[i]!.length;
  }
  let rolling = priorMeta.rolling_checksum;
  for (const lineString of lineStrings) {
    rolling = extendRollingChecksum(rolling, lineString);
  }

  return {
    last_applied_seq: entries[entries.length - 1]!.seq,
    last_entry_offset: lastEntryOffset,
    last_entry_line_hash: computeLineHash(lineStrings[lineStrings.length - 1]!),
    rolling_checksum: rolling,
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    written_at: new Date().toISOString(),
  };
}

/**
 * **Internal primitive — do not call from CLI or skill code.**
 *
 * `appendEntry` is the single-entry shorthand for `appendMany([entry])`; it
 * preserves the original surface for callers that have always emitted one
 * entry. Identical semantics: validate the prior meta + the entry, then one
 * write, then return the post-append `SnapshotMeta`.
 *
 * Use `mutate()` from `src/core/journal-mutate.ts` for the sanctioned
 * mutation path — `appendEntry` skips preflight / sidecar / reducer.
 */
export async function appendEntry(
  filePath: string,
  entry: JournalEntry,
  priorMeta: SnapshotMeta,
  opts: AppendOptions = {},
): Promise<SnapshotMeta> {
  return await appendMany(filePath, [entry], priorMeta, opts);
}
