// snapshot-reader.ts — Gate #5 (ADR-0005 §3.6 reader contract).
//
// Any CLI command that consumes snapshots/<projection>.json MUST first call
// checkSnapshotFresh() to verify the snapshot meta agrees with the journal
// tail. A mismatch exits 2 SNAPSHOT_STALE_REBUILD_REQUIRED — there is NO
// silent fallback to the cached snapshot.
//
// Fast check: compare _meta.last_entry_offset + last_entry_line_hash against
// what we'd read from the journal's current tail. O(1) — read last KB of
// journal, hash the last line. If a writer is mid-append the tail might lack
// a trailing newline; the contract says the reader must NOT proceed in that
// state.

import { promises as fsp, type Stats } from "node:fs";

import { ENTRY_BYTE_LIMIT } from "./journal-entry.js";
import { computeLineHash, type SnapshotMeta } from "./snapshot.js";

export type SnapshotReaderResult =
  | { fresh: true; last_applied_seq: number }
  | {
      fresh: false;
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED";
      reason:
        | "journal_missing"
        | "journal_empty"
        | "tail_offset_mismatch"
        | "tail_hash_mismatch"
        | "trailing_partial_line";
      detail: Record<string, unknown>;
    };

/**
 * Verify that the given SnapshotMeta agrees with the on-disk journal tail.
 * Caller (CLI command consuming snapshots) treats `fresh: false` as exit 2
 * SNAPSHOT_STALE_REBUILD_REQUIRED; no silent fallback to cached snapshot.
 */
export async function checkSnapshotFresh(
  meta: SnapshotMeta,
  journalPath: string,
): Promise<SnapshotReaderResult> {
  let stat: Stats;
  try {
    stat = await fsp.stat(journalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        fresh: false,
        code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
        reason: "journal_missing",
        detail: { journal_path: journalPath },
      };
    }
    throw err;
  }

  if (stat.size === 0) {
    if (meta.last_applied_seq === -1) {
      return { fresh: true, last_applied_seq: -1 };
    }
    return {
      fresh: false,
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      reason: "journal_empty",
      detail: { meta_last_applied_seq: meta.last_applied_seq },
    };
  }

  // Read the last ENTRY_BYTE_LIMIT bytes (audit r1 fix #8). Entries can be
  // up to 64KB; the prior 8KB window would falsely reject any meta whose
  // tail line lands beyond 8KB from EOF.
  const tailRead = Math.min(stat.size, ENTRY_BYTE_LIMIT);
  const fh = await fsp.open(journalPath, "r");
  try {
    const buf = Buffer.alloc(tailRead);
    await fh.read(buf, 0, tailRead, stat.size - tailRead);
    const trailingText = buf.toString("utf8");

    // Require a trailing newline — a missing \n means a writer is mid-append.
    if (!trailingText.endsWith("\n")) {
      return {
        fresh: false,
        code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
        reason: "trailing_partial_line",
        detail: { tail_bytes: trailingText.length },
      };
    }

    // Locate the last complete line.
    const withoutTrailingNl = trailingText.slice(0, -1);
    const lastNl = withoutTrailingNl.lastIndexOf("\n");
    const tailLine = lastNl === -1 ? withoutTrailingNl : withoutTrailingNl.slice(lastNl + 1);
    const tailLineBytes = Buffer.byteLength(tailLine + "\n", "utf8");
    const tailLineOffset = stat.size - tailLineBytes;

    if (tailLineOffset !== meta.last_entry_offset) {
      return {
        fresh: false,
        code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
        reason: "tail_offset_mismatch",
        detail: {
          journal_tail_offset: tailLineOffset,
          meta_last_entry_offset: meta.last_entry_offset,
        },
      };
    }

    const actualHash = computeLineHash(tailLine);
    if (actualHash !== meta.last_entry_line_hash) {
      return {
        fresh: false,
        code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
        reason: "tail_hash_mismatch",
        detail: {
          actual: actualHash,
          expected: meta.last_entry_line_hash,
        },
      };
    }

    return { fresh: true, last_applied_seq: meta.last_applied_seq };
  } finally {
    await fh.close();
  }
}
