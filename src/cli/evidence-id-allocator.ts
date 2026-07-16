// Shared EV-id allocator for commands that emit
// `evidence:added` entries (codex r324 P1 lock):
//
//   - `loaf evidence add` (existing; batch-capable)
//   - `loaf waive`        (new wrapper, single-shot, kind=waiver)
//
// Single source of monotonic allocation per session — scans
// snapshot.evidence for the max EV-NNN serial, returns the next N ids.
// Pure; caller is responsible for atomicity (mutateBatch already locks
// the journal and atomically appends entries sharing one batch_id).

import type { Snapshot } from "../core/reducer.js";

/** Allocate the next `count` evidence ids (≥6-digit zero-padded). */
export function allocateNextEvidenceIds(snapshot: Snapshot, count: number): string[] {
  if (count < 1) return [];
  const maxSerial = snapshot.evidence.reduce((max, e) => {
    const m = /^EV-(\d+)$/.exec(e.id);
    if (!m) return max;
    return Math.max(max, Number.parseInt(m[1]!, 10));
  }, 0);
  return Array.from(
    { length: count },
    (_, i) => `EV-${String(maxSerial + 1 + i).padStart(6, "0")}`,
  );
}

/** Single-id convenience for evidence wrappers such as `loaf waive`. */
export function allocateNextEvidenceId(snapshot: Snapshot): string {
  return allocateNextEvidenceIds(snapshot, 1)[0]!;
}
