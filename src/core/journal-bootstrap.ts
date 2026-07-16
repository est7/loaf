// journal-bootstrap — replay + tail recovery (ADR-0005 §3.6 + §4.13, Gate #4).
//
// Two responsibilities:
//
//   1. replayJournal(filePath) — read the journal end-to-end, apply each entry
//      through reducer.apply, return the projected Snapshot + accumulated meta.
//
//   2. tailRecovery(filePath) — Gate #4: detect partial/incomplete tail and
//      truncate. Batch-aware: a partial batch (where any constituent entry is
//      missing) truncates back to the batch's first entry's pre-offset, so
//      the journal never observes a half-committed batch.
//
// Tail recovery is destructive (truncates the journal file). It is intended
// to run from `loaf doctor --check-tail` startup repair. Callers must hold
// the per-feature lock.

import { promises as fsp } from "node:fs";

import { JournalEntry, type JournalEntry as JE } from "./journal-entry.js";
import {
  apply,
  initialSnapshot,
  type ApplyFailureCode,
  type ApplyResult,
  type Snapshot,
} from "./reducer.js";
import { rehydrateMigration } from "./migration.js";
import {
  computeLineHash,
  extendRollingChecksum,
  emptyMeta,
  FEATURE_SCHEMA_VERSION,
  type SnapshotMeta,
} from "./snapshot.js";

export interface ReplayResult {
  ok: true;
  snapshot: Snapshot;
  meta: SnapshotMeta;
  entries_applied: number;
  /** The parsed entries of the successful replay prefix, in journal order.
   *  Populated only when `ReplayOptions.collect_entries` is set — generic /
   *  perf-sensitive callers keep the default streaming behavior (Slice C
   *  SC-C2a). Consumed by `latestCanonicalTaskBody` to recover canonical
   *  task bodies the slim projection drops. */
  entries?: JE[];
}

export interface ReplayError {
  ok: false;
  code: "JOURNAL_READ_FAILED" | "INVALID_ENTRY" | "REDUCER_REJECTED";
  message: string;
  at_seq?: number;
  detail?: Record<string, unknown> & { inner_code?: ApplyFailureCode };
}

export interface ReplayOptions {
  /** Feature directory; required for migration:snapshot_imported rehydration
   *  (reading sidecar artifacts from attachments/JE-000000/migration/).
   *  If omitted, migration entries fall through to reducer.apply's default
   *  bootstrap (cursor at TRIAGE.score, no projection rehydrated). */
  feature_dir?: string;
  /** Opt-in: accumulate the parsed entries of the successful replay prefix
   *  into `ReplayResult.entries`. Off by default so generic replay keeps its
   *  streaming memory profile (Slice C SC-C2a). */
  collect_entries?: boolean;
}

export async function replayJournal(
  filePath: string,
  opts: ReplayOptions = {},
): Promise<ReplayResult | ReplayError> {
  let contents: string;
  try {
    contents = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: true,
        snapshot: initialSnapshot(),
        meta: emptyMeta(),
        entries_applied: 0,
        ...(opts.collect_entries ? { entries: [] } : {}),
      };
    }
    return { ok: false, code: "JOURNAL_READ_FAILED", message: String(err) };
  }

  if (contents.length === 0) {
    return {
      ok: true,
      snapshot: initialSnapshot(),
      meta: emptyMeta(),
      entries_applied: 0,
      ...(opts.collect_entries ? { entries: [] } : {}),
    };
  }

  const lines = contents.split("\n");
  // Trailing newline produces an empty final segment — drop it. Real partial
  // tail (no \n) leaves a non-empty final segment which we treat as corruption.
  const completeLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === lines.length - 1 && lines[i] === "") continue;
    completeLines.push(lines[i]!);
  }

  let snapshot = initialSnapshot();
  let lastSeq = -1;
  let lastEntryOffset = 0;
  let lastLineHash = emptyMeta().last_entry_line_hash;
  let rolling = emptyMeta().rolling_checksum;
  let offset = 0;
  let applied = 0;
  // Slice C SC-C2a: opt-in accumulation of the replay prefix. Stays
  // undefined when collect_entries is off so the property is absent.
  const collected: JE[] | undefined = opts.collect_entries ? [] : undefined;

  for (const line of completeLines) {
    const lineBytes = Buffer.byteLength(line + "\n", "utf8");
    let entry: JE;
    try {
      const parsed = JournalEntry.safeParse(JSON.parse(line));
      if (!parsed.success) {
        return {
          ok: false,
          code: "INVALID_ENTRY",
          message: "journal contains entry that fails envelope schema",
          at_seq: lastSeq + 1,
          detail: { line: line.slice(0, 200), issues: parsed.error.issues },
        };
      }
      entry = parsed.data;
    } catch (err) {
      return {
        ok: false,
        code: "INVALID_ENTRY",
        message: `journal line is not valid JSON: ${String(err)}`,
        at_seq: lastSeq + 1,
        detail: { line: line.slice(0, 200) },
      };
    }

    // W2 — seq monotonicity. appendMany enforces `seq === tail + 1` on the
    // write path; replay owns the corresponding read-path continuity check.
    // apply() deliberately omits tail_seq because independent callers do not
    // own journal continuity. Assert strict contiguity here, BEFORE apply, so
    // even a reducer-legal entry at the wrong seq is rejected.
    const expectedSeq = lastSeq + 1;
    if (entry.seq !== expectedSeq) {
      return {
        ok: false,
        code: "INVALID_ENTRY",
        message: `journal seq not monotonic: entry.seq=${entry.seq} but expected ${expectedSeq} (prior applied seq=${lastSeq})`,
        at_seq: entry.seq,
        detail: { expected_seq: expectedSeq, got_seq: entry.seq, prior_seq: lastSeq },
      };
    }

    // Migration entries bypass apply()'s default bootstrap and rehydrate
    // the full projection from sidecar artifacts (audit r1 Blocker #6).
    // Audit r2 Medium fix: replayJournal MUST fail-fast if a migration
    // entry is present but feature_dir was not supplied — silent downgrade
    // to apply()'s bootstrap loses the entire legacy projection.
    if (entry.kind === "migration:snapshot_imported") {
      if (!opts.feature_dir) {
        return {
          ok: false,
          code: "REDUCER_REJECTED",
          message:
            "migration:snapshot_imported requires opts.feature_dir for sidecar rehydration; refusing to silently bootstrap default state",
          at_seq: entry.seq,
        };
      }
      try {
        snapshot = await rehydrateMigration(opts.feature_dir, entry);
      } catch (err) {
        return {
          ok: false,
          code: "REDUCER_REJECTED",
          message: `migration rehydration failed: ${String(err)}`,
          at_seq: entry.seq,
        };
      }
    } else {
      const result: ApplyResult = apply(snapshot, entry);
      if (!result.ok) {
        return {
          ok: false,
          code: "REDUCER_REJECTED",
          message: result.message,
          at_seq: entry.seq,
          detail: { ...(result.detail ?? {}), inner_code: result.code },
        };
      }
      snapshot = result.snapshot;
    }
    lastSeq = entry.seq;
    lastEntryOffset = offset;
    lastLineHash = computeLineHash(line);
    rolling = extendRollingChecksum(rolling, line);
    offset += lineBytes;
    applied++;
    collected?.push(entry);
  }

  return {
    ok: true,
    snapshot,
    meta: {
      last_applied_seq: applied === 0 ? emptyMeta().last_applied_seq : lastSeq,
      last_entry_offset: lastEntryOffset,
      last_entry_line_hash: lastLineHash,
      rolling_checksum: rolling,
      feature_schema_version: FEATURE_SCHEMA_VERSION,
      written_at: new Date().toISOString(),
    },
    entries_applied: applied,
    ...(collected ? { entries: collected } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tail recovery (Gate #4) — batch-aware
// ─────────────────────────────────────────────────────────────────────

export interface TailRecoveryResult {
  /** Bytes truncated from the file. 0 = no corruption. */
  truncated_bytes: number;
  /** Number of entries discarded (partial line or partial batch). */
  truncated_entries: number;
  /** Recovery action taken. */
  action: "noop" | "drop_partial_line" | "drop_partial_batch" | "drop_invalid_tail";
}

/**
 * Walk the journal from the end; if the tail is malformed (no trailing \n,
 * JSON parse fails, batch incomplete), truncate back to the last fully
 * committed boundary. Returns the action + bytes/entries dropped.
 *
 * Boundary rules (ADR-0005 §4.13):
 *   - A final segment without trailing \n is a partial line → drop.
 *   - A JSON-invalid line is a write-mid-line artifact → drop.
 *   - If the last fully-committed line is a batch member with
 *     batch_index < batch_count-1, that batch's prefix entries are also
 *     truncated back to the batch's first entry's pre-offset.
 */
export async function tailRecovery(filePath: string): Promise<TailRecoveryResult> {
  let contents: string;
  try {
    contents = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { truncated_bytes: 0, truncated_entries: 0, action: "noop" };
    }
    throw err;
  }

  if (contents.length === 0) {
    return { truncated_bytes: 0, truncated_entries: 0, action: "noop" };
  }

  // Split keeping all segments. A trailing "\n" produces an empty final
  // segment (which represents proper line termination); a non-empty final
  // segment means partial line (no trailing newline).
  const segments = contents.split("\n");
  const trailingTerminated = segments[segments.length - 1] === "";
  const partialLine = trailingTerminated ? null : segments[segments.length - 1]!;
  const completeLines = trailingTerminated ? segments.slice(0, -1) : segments.slice(0, -1);

  // Phase 1: drop trailing partial line if present.
  let truncated_bytes = 0;
  let truncated_entries = 0;
  let action: TailRecoveryResult["action"] = "noop";

  if (partialLine !== null) {
    truncated_bytes += Buffer.byteLength(partialLine, "utf8");
    action = "drop_partial_line";
  }

  // Phase 2: validate every complete line; drop trailing invalid lines.
  // We walk backwards stripping bad tail lines.
  const goodEntries: JE[] = [];
  for (const line of completeLines) {
    try {
      const parsed = JournalEntry.safeParse(JSON.parse(line));
      if (!parsed.success) {
        // From this point forward, every line is treated as corrupt tail.
        continue;
      }
      // Reset trailing invalidation buffer if a good line follows? No —
      // §4.13 contract: corruption is strictly tail-monotonic. If a JSON
      // failure occurs mid-file, that's a corruption mode we don't
      // self-repair (would need replay; doctor --rebuild surfaces).
      // For minimum viable, count only the trailing run.
      goodEntries.push(parsed.data);
    } catch {}
  }

  // Restrict invalid handling to a trailing run — i.e. counter resets when a
  // valid line follows. Recompute the trailing-only count.
  // (Above we already aggregated assuming monotonic; redo cleanly.)
  let trailingInvalidCount = 0;
  let trailingInvalidBytes = 0;
  for (let i = completeLines.length - 1; i >= 0; i--) {
    const line = completeLines[i]!;
    try {
      const parsed = JournalEntry.safeParse(JSON.parse(line));
      if (parsed.success) break;
      trailingInvalidCount++;
      trailingInvalidBytes += Buffer.byteLength(line + "\n", "utf8");
    } catch {
      trailingInvalidCount++;
      trailingInvalidBytes += Buffer.byteLength(line + "\n", "utf8");
    }
  }

  if (trailingInvalidCount > 0 && partialLine === null) {
    action = "drop_invalid_tail";
  } else if (trailingInvalidCount > 0 && partialLine !== null) {
    action = "drop_invalid_tail"; // dominant; partial line absorbed
  }
  truncated_bytes += trailingInvalidBytes;
  truncated_entries += trailingInvalidCount;

  // Phase 3: batch-aware truncation. Re-parse the surviving complete lines
  // (strip the trailing invalid count) and check if the last lines form an
  // incomplete batch — i.e. batch_id with fewer entries than batch_count.
  const survivors = goodEntries.slice(0, goodEntries.length - trailingInvalidCount);
  if (survivors.length > 0) {
    const last = survivors[survivors.length - 1]!;
    if (last.batch_id !== undefined) {
      // Collect contiguous trailing run with the same batch_id.
      let batchStartIdx = survivors.length - 1;
      while (batchStartIdx > 0 && survivors[batchStartIdx - 1]!.batch_id === last.batch_id) {
        batchStartIdx--;
      }
      const batchEntries = survivors.slice(batchStartIdx);
      const declaredCount = last.batch_count ?? batchEntries.length;
      if (batchEntries.length < declaredCount) {
        // Truncate the entire batch.
        for (const e of batchEntries) {
          const line = JSON.stringify(e);
          truncated_bytes += Buffer.byteLength(line + "\n", "utf8");
          truncated_entries += 1;
        }
        action = "drop_partial_batch";
      }
    }
  }

  if (truncated_bytes === 0) {
    return { truncated_bytes: 0, truncated_entries: 0, action: "noop" };
  }

  const newSize = Buffer.byteLength(contents, "utf8") - truncated_bytes;
  const fh = await fsp.open(filePath, "r+");
  try {
    await fh.truncate(newSize);
    await fh.sync();
  } finally {
    await fh.close();
  }

  return { truncated_bytes, truncated_entries, action };
}
