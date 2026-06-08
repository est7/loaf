// Phase 16 SC-11 — `loaf lessons add (--text "..." | --file <path>)
// --reason "..."` sugar over `evidence:added` payload.kind=`manual`.
//
// Per protocol §10.8:1958:
//   - actor MUST be human:* (existing EvidenceFullPayload refine)
//   - reason MUST be ≥10 chars (existing refine; separate from lesson body)
//   - result defaults to "passed" (manual evidence semantic)
//   - lesson body → `summary` field; LongTextField sidecar promotion
//     fires when body bytes > SIDECAR_THRESHOLD_BYTES (Pass 2 sidecar
//     promote in journal-mutate.ts; threshold imported from core for
//     single-source consistency per codex r325 P2)
//   - covers = [] (lessons aren't tied to specific obligations)
//
// v0.1.1 (F-024): the `lessons.md` projection writer landed — this builder
// still only produces the evidence payload, but writeProjections rebuilds
// `.loaf/<feature>/lessons.md` from the lesson entries on every mutate, so
// the CLI advisory now claims `lessons.md updated`. See F-024 (CLOSED).
//
// PURE payload builder (codex r325 P1 Option A): returns payload object;
// caller wraps in journal envelope before mutate().

import { SIDECAR_THRESHOLD_BYTES } from "../core/journal-entry.js";

export interface BuildLessonsEvidenceArgs {
  /** Pre-allocated EV-id (via allocateNextEvidenceId). */
  evidenceId: string;
  /** Lesson body text (from --text inline or --file content read). */
  lessonText: string;
  /** ≥10-char reason — independent from lesson body per codex r321 Q4a. */
  reason: string;
  /** Resolved human:* actor (via resolveHumanActor). */
  actor: string;
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

export function buildLessonsEvidencePayload(args: BuildLessonsEvidenceArgs): {
  id: string;
  kind: "manual";
  iteration: number;
  actor: string;
  result: "passed";
  reason: string;
  summary: SummaryFieldValue;
  covers: never[];
} {
  return {
    id: args.evidenceId,
    kind: "manual",
    iteration: args.iteration,
    actor: args.actor,
    result: "passed",
    reason: args.reason,
    summary: chooseSummary(args.lessonText),
    covers: [],
  };
}
