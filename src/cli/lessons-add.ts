// `loaf lessons add (--text "..." | --file <path>) --reason "..."`
// payload builder for the independent `lesson:recorded` journal kind.
//
// Per protocol §10.8:1958:
//   - actor authority lives on the journal envelope, not in this payload
//   - reason MUST be ≥10 chars (separate from lesson body)
//   - lesson body → `summary` field; LongTextField sidecar promotion
//     fires when body bytes > SIDECAR_THRESHOLD_BYTES (Pass 2 sidecar
//     promote in journal-mutate.ts; threshold imported from core for
//     single-source consistency per codex r325 P2)
// The lessons.md projection rebuilds from both this kind and legacy lesson-
// shaped evidence entries.
//
// PURE payload builder (codex r325 P1 Option A): returns payload object;
// caller wraps in journal envelope before mutate().

import {
  SIDECAR_THRESHOLD_BYTES,
  type LessonRecordedPayload,
} from "../core/journal-entry.js";

export interface BuildLessonRecordedArgs {
  /** Pre-allocated LSN-id from canonical journal history. */
  lessonId: string;
  /** Lesson body text (from --text inline or --file content read). */
  lessonText: string;
  /** ≥10-char reason — independent from lesson body per codex r321 Q4a. */
  reason: string;
  /** Current session iteration. */
  iteration: number;
}

/** SummaryField shape — string for short lessons, LongTextField inline
 *  for bodies > SIDECAR_THRESHOLD_BYTES so Pass 2 can match-and-promote
 *  to sidecar. Mirrors sidecar promotion predicate (`>`, not `>=`) per
 *  codex r327 non-blocking nit — boundary stays consistent across the
 *  builder and the promoter. */
type SummaryFieldValue = string | { mode: "inline"; text: string };

function chooseSummary(lessonText: string): SummaryFieldValue {
  return Buffer.byteLength(lessonText, "utf8") > SIDECAR_THRESHOLD_BYTES
    ? { mode: "inline", text: lessonText }
    : lessonText;
}

export function buildLessonRecordedPayload(
  args: BuildLessonRecordedArgs,
): LessonRecordedPayload {
  return {
    id: args.lessonId,
    iteration: args.iteration,
    reason: args.reason,
    summary: chooseSummary(args.lessonText),
  };
}
