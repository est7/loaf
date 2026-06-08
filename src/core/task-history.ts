// task-history — canonical task body retrieval (Slice C SC-C2a).
//
// The slim `Snapshot.tasks` (TaskState) intentionally drops a task's
// canonical body fields — `tests` / `test_layer` / `execution.<step>`'s
// `evidence_refs` / `reason` / `started_at` — because the reducer only
// needs cross-cutting fields for spec-lock checks + auto-promote, and the
// journal payload is the canonical truth (see task-schema.ts header).
//
// `loaf tasks amend` must emit a WHOLE-task `event:tasks_amended`, so it
// needs that full body back. These two pure helpers reconstruct it from
// the replayed journal without a second projection:
//
//   latestCanonicalTaskBody — replays the plan/amend chain to recover a
//     task's most recent full body, honoring `tasks_planned`'s
//     whole-replacement semantics (a plan that omits an id removes it;
//     a naive max-seq scan would resurrect it — codex r106 BLOCK).
//
//   materializeTaskForAmend — overlays the live runtime status + per-step
//     status/applicability from the slim TaskState onto a canonical body,
//     so a policy amend issued after work started cannot regress
//     task.status or a step's status back to the planned values.

import type { JournalEntry } from "./journal-entry.js";
import type { TaskState } from "./reducer.js";
import type { TaskExecutionStepPayload, TaskFullPayload } from "./task-schema.js";

/**
 * Forward-replay the plan/amend chain in `entries` and return a no-alias
 * copy of `taskId`'s latest canonical `TaskFullPayload` body, or `undefined`
 * if no live plan/amend entry defines it.
 *
 * `event:tasks_planned` is whole-replacement (reducer rebuilds the entire
 * task set from its payload), so a later plan that omits `taskId` clears
 * the body. `event:tasks_amended` carries a single replacement/added task;
 * its `mode` is irrelevant to body recovery — both add and replace make the
 * carried task the latest body once the entry is in the journal.
 */
export function latestCanonicalTaskBody(
  entries: readonly JournalEntry[],
  taskId: string,
): TaskFullPayload | undefined {
  let current: TaskFullPayload | undefined;
  for (const entry of entries) {
    if (entry.kind === "event:tasks_planned") {
      const payload = entry.payload as { tasks?: TaskFullPayload[] };
      // Whole-replacement: undefined when this plan does not list the id.
      current = payload.tasks?.find((t) => t.id === taskId);
    } else if (entry.kind === "event:tasks_amended") {
      const payload = entry.payload as { task?: TaskFullPayload };
      if (payload.task?.id === taskId) current = payload.task;
    }
  }
  return current === undefined ? undefined : structuredClone(current);
}

/**
 * Overlay the live runtime state from the slim `current` projection onto a
 * canonical `base` body, producing the full task to carry in a `tasks amend`
 * `event:tasks_amended` payload.
 *
 * Overlaid from `current`: `task.status`, and each base step's `status` +
 * `applicability` (where the slim projection has that step). Preserved from
 * `base`: every body-only field the slim projection drops — `tests`,
 * `test_layer`, kind-specific contract fields, and per-step `evidence_refs`
 * / `reason` / `started_at`. The base body defines the canonical step set;
 * a step absent from `current.steps` keeps its base values.
 */
export function materializeTaskForAmend(
  base: TaskFullPayload,
  current: TaskState,
): TaskFullPayload {
  const out = structuredClone(base);
  out.status = current.status;
  // Slice C SC-C4 (R2): red_test_registered is runtime state set by
  // `register-red` after task creation — overlay the live value so a
  // `tasks amend` rebuilt from the canonical body does not drop it (which
  // §8.6's frozen-field diff would then read as a true→undefined change).
  if (current.red_test_registered !== undefined) {
    (out as { red_test_registered?: boolean }).red_test_registered = current.red_test_registered;
  }
  // Each TaskFull variant's `execution` is a fixed-key object whose values
  // are all TaskExecutionStepPayload — structurally a Record over the step
  // set. The overlay only rewrites status/applicability of EXISTING steps,
  // so the variant's step set is preserved and the result stays a valid
  // TaskFullPayload of the same kind.
  const exec = out.execution as Record<string, TaskExecutionStepPayload>;
  for (const stepName of Object.keys(exec)) {
    const live = current.steps[stepName];
    const step = exec[stepName];
    if (live && step) {
      step.status = live.status;
      step.applicability = live.applicability;
    }
  }
  return out;
}

/**
 * Carry per-step execution PROGRESS forward from a task's current canonical
 * body onto a fresh replacement graph — for a sponsored `tasks amend --input`
 * (Phase 11 Item 3 SC1b, codex r136 Q4).
 *
 * The `--input` file is an id-less `TaskInput`; `materializeTaskInput` gives
 * the replacement a fresh `execution` block (every step `pending`,
 * `evidence_refs: []`, no `started_at` / `reason`). A sponsored graph amend
 * must NOT erase execution history, so for every step RETAINED across the
 * replacement (present in both bodies) this copies the body-only progress
 * fields — `evidence_refs`, `started_at`, `reason` — from the canonical body.
 * A step introduced by the replacement keeps its fresh (unstarted,
 * no-evidence) values.
 *
 * `status` / `applicability` are NOT carried here — `materializeTaskForAmend`
 * overlays those from the slim projection downstream. This helper is the
 * CLI-side guard for the body-only half of the Q4 frozen-field rule:
 * stable-core preflight runs against the slim `Snapshot.tasks` projection,
 * which drops `evidence_refs` / `started_at` / step `reason`, so it cannot
 * verify their preservation (see the §8.6 sponsored-branch comment in
 * preflight.ts).
 */
export function carryForwardStepProgress(
  replacement: TaskFullPayload,
  canonical: TaskFullPayload,
): TaskFullPayload {
  const out = structuredClone(replacement);
  const outExec = out.execution as Record<string, TaskExecutionStepPayload>;
  const priorExec = canonical.execution as Record<string, TaskExecutionStepPayload>;
  for (const stepName of Object.keys(outExec)) {
    const prior = priorExec[stepName];
    const step = outExec[stepName];
    if (!prior || !step) continue;
    step.evidence_refs = structuredClone(prior.evidence_refs);
    if (prior.started_at !== undefined) step.started_at = prior.started_at;
    if (prior.reason !== undefined) step.reason = prior.reason;
  }
  return out;
}
