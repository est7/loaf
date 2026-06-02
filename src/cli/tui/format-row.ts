// Phase 16 SC-14 — pure column formatters for `loaf tui` MVP.
//
// All status/label/width logic lives here; Ink component
// (`src/cli/tui/app.tsx`) stays thin presentation that just renders
// the strings these helpers produce. Tests live in
// `tests/cli/format-row.test.ts` and carry the behavior contract per
// codex r355 Q3 (option 3 boundary: pure formatter + CLI guard tests,
// no Ink snapshot/full render).
//
// Status column precedence (codex r354 P2 lock):
//   1. sub_state.startsWith("DONE.")       → "✓ done"
//   2. pending_queue_depth >= 2             → "‖ ask [×N]"
//   3. pending_queue_depth == 1             → "‖ ask"
//   4. active_tasks.length >= 2             → "▶ run [×N]"
//   5. active_tasks.length == 1             → "▶ run"
//   6. else                                  → raw sub_state literal

import type { SessionRow } from "../sessions-list.js";
import { statusBucket } from "./list-model.js";

/** Minimum widths per column (header width floors). */
export const COLUMN_MIN_WIDTHS = {
  label: 12,      // "LABEL"
  phase_sub: 12,  // "PHASE.SUB"
  iter: 4,        // "ITER"
  status: 12,     // "STATUS"
} as const;

/** Choose the LABEL column source: session_label if set, else feature. */
export function chooseLabelSource(row: SessionRow): string {
  return row.session_label.trim().length > 0 ? row.session_label : row.feature;
}

/** Truncate with ellipsis when source > maxWidth. */
export function formatLabel(row: SessionRow, maxWidth: number): string {
  const raw = chooseLabelSource(row);
  if (raw.length <= maxWidth) return raw;
  if (maxWidth < 2) return raw.slice(0, maxWidth);
  return raw.slice(0, maxWidth - 1) + "…";
}

/** PHASE.SUB column — just the sub_state literal. */
export function formatPhaseSub(row: SessionRow): string {
  return row.sub_state;
}

/** ITER column — iteration as decimal string. */
export function formatIteration(row: SessionRow): string {
  return String(row.iteration);
}

/** STATUS column — precedence-ordered text badge per r354 P2. */
export function formatStatus(row: SessionRow): string {
  // 1. Terminal phase wins
  if (row.sub_state.startsWith("DONE.")) return "✓ done";
  // 2-3. Pending head (gate-blocking semantic wins over workers)
  if (row.pending_queue_depth >= 2) {
    return `‖ ask [×${row.pending_queue_depth}]`;
  }
  if (row.pending_queue_depth === 1) {
    return "‖ ask";
  }
  // 4-5. Active workers
  if (row.active_tasks.length >= 2) {
    return `▶ run [×${row.active_tasks.length}]`;
  }
  if (row.active_tasks.length === 1) {
    return "▶ run";
  }
  // 6. Idle / no workers / no pending — show sub_state as deterministic fallback
  return row.sub_state;
}

/** STATUS badge for rows that already render sub_state elsewhere. */
export function formatStatusBadge(row: SessionRow): string {
  if (statusBucket(row) === "idle") return "idle";
  return formatStatus(row);
}

/** Compute the max content width per column across all rows. Used to
 *  size the table so columns aren't truncated when content fits. */
export interface ColumnWidths {
  label: number;
  phase_sub: number;
  iter: number;
  status: number;
}

export function computeColumnWidths(
  rows: ReadonlyArray<SessionRow>,
  maxLabelWidth = 40,
): ColumnWidths {
  let label: number = COLUMN_MIN_WIDTHS.label;
  let phase_sub: number = COLUMN_MIN_WIDTHS.phase_sub;
  let iter: number = COLUMN_MIN_WIDTHS.iter;
  let status: number = COLUMN_MIN_WIDTHS.status;
  for (const row of rows) {
    label = Math.max(label, Math.min(maxLabelWidth, chooseLabelSource(row).length));
    phase_sub = Math.max(phase_sub, formatPhaseSub(row).length);
    iter = Math.max(iter, formatIteration(row).length);
    status = Math.max(status, formatStatus(row).length);
  }
  return { label, phase_sub, iter, status };
}
