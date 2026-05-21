// Finding schema — shared zod shapes for finding journal payloads
// and the FINDING_ACTION_GRID 6×6 policy matrix (rev 4.3 / ADR-0004 A7).
//
// Slice 3 SC3 (codex r68 sign-off): mirrors docs/schemas.ts §5 (FindingCategory
// / FindingAction) + §37 (FindingActionRisk + FINDING_ACTION_GRID) to a
// neutral runtime module so:
//
//   - journal-entry.ts imports FindingId / FindingCategory / FindingAction
//     for tightening FindingRaisedPayload + FindingClosedPayload.
//   - reducer/preflight.ts imports FINDING_ACTION_GRID + cellRisk +
//     FINDING_UNUSUAL_REASON_MIN_LENGTH + step-per-action map for the
//     finding:raised refines.
//   - reducer.ts imports FindingActionRisk / FindingTarget types for the
//     extended FindingState projection.
//
// No reverse dependency: this module imports from spec/task only for the
// TaskIdPayload shape used by FindingTarget. Parallels evidence-schema.ts
// placement.

import { z } from "zod";

import { TaskIdPayload } from "./task-schema.js";

// ── FindingId (mirror docs/schemas.ts §16:1836 — `/^FND-\d{3,}$/`) ──────

export const FindingId = z.string().regex(/^FND-\d{3,}$/);
export type FindingId = z.infer<typeof FindingId>;

// ── FindingCategory / FindingAction (mirror docs/schemas.ts §5) ─────────

export const FindingCategory = z.enum([
  "spec-gap",          // spec silent on this aspect
  "spec-defect",       // spec wrong (covers design-gap)
  "impl-defect",       // implementation wrong (covers visual-defect)
  "test-defect",       // test or test-env wrong
  "new-scope",         // out of current scope, needs new task
  "risk-escalation",   // task complexity exceeds current profile
]);
export type FindingCategory = z.infer<typeof FindingCategory>;

export const FindingAction = z.enum([
  "amend-spec",   // → SPEC.spec, spec_version+1
  "amend-tasks",  // → EXECUTE.work, tasks.version+1
  "fix-impl",     // → EXECUTE.work; event:task_step_reset sets execution.implement.status=pending
  "fix-test",     // → EXECUTE.work; event:task_step_reset sets execution.red.status=pending
  "defer",        // close finding, drift recorded in reconcile
  "backlog",      // close finding, candidate for next feature
]);
export type FindingAction = z.infer<typeof FindingAction>;

// ── FindingActionRisk + 6×6 grid (mirror docs/schemas.ts §37) ────────────

export const FindingActionRisk = z.enum(["typical", "unusual", "incoherent"]);
export type FindingActionRisk = z.infer<typeof FindingActionRisk>;

/**
 * FINDING_ACTION_GRID — per-cell risk classification.
 * 4 `incoherent` cells (rev 4.3 ADR-0004 A7): structurally there is no
 * task target a transition can land on, so block early at preflight.
 * Mirrors `docs/protocol.md §4.5 finding matrix` and `docs/schemas.ts §37
 * FINDING_ACTION_GRID`.
 */
export const FINDING_ACTION_GRID: Record<
  FindingCategory,
  Record<FindingAction, FindingActionRisk>
> = {
  "spec-gap": {
    "amend-spec": "typical",
    "amend-tasks": "unusual",
    "fix-impl": "incoherent",
    "fix-test": "incoherent",
    "defer": "typical",
    "backlog": "typical",
  },
  "spec-defect": {
    "amend-spec": "typical",
    "amend-tasks": "unusual",
    "fix-impl": "unusual",
    "fix-test": "unusual",
    "defer": "typical",
    "backlog": "typical",
  },
  "impl-defect": {
    "amend-spec": "unusual",
    "amend-tasks": "typical",
    "fix-impl": "typical",
    "fix-test": "unusual",
    "defer": "typical",
    "backlog": "typical",
  },
  "test-defect": {
    "amend-spec": "unusual",
    "amend-tasks": "typical",
    "fix-impl": "unusual",
    "fix-test": "typical",
    "defer": "typical",
    "backlog": "typical",
  },
  "new-scope": {
    "amend-spec": "typical",
    "amend-tasks": "typical",
    "fix-impl": "incoherent",
    "fix-test": "incoherent",
    "defer": "typical",
    "backlog": "typical",
  },
  "risk-escalation": {
    "amend-spec": "unusual",
    "amend-tasks": "typical",
    "fix-impl": "unusual",
    "fix-test": "unusual",
    "defer": "typical",
    "backlog": "typical",
  },
};

/** Look up the (category, action) cell risk in O(1). */
export function cellRisk(
  category: FindingCategory,
  action: FindingAction,
): FindingActionRisk {
  return FINDING_ACTION_GRID[category][action];
}

/**
 * Minimum --reason length for an `unusual` cell raise (protocol §4.5).
 * `typical` is unconstrained; `incoherent` is blocked outright.
 */
export const FINDING_UNUSUAL_REASON_MIN_LENGTH = 20;

// ── Action-aware target step contract (codex r68 BLOCK fix) ──────────────
//
// Three categories of target requirement:
//   - "task_id_step":    target required; step must equal the action's
//                        canonical step (fix-impl → "implement",
//                        fix-test → "red"). Used by fix-impl / fix-test.
//   - "task_id_optional": target absence allowed; if provided, must be a
//                        valid {task_id, step} pair. Used by amend-tasks.
//   - "none":             target not accepted. Used by amend-spec, defer,
//                        backlog. (Currently we let the schema accept a
//                        passthrough target but preflight does not validate
//                        it; if a stricter "no target allowed" surface is
//                        wanted later, add a SC3b refine.)

export type FindingTargetMode = "task_id_step" | "task_id_optional" | "none";

export const FINDING_ACTION_TARGET_MODE: Record<FindingAction, FindingTargetMode> = {
  "amend-spec": "none",
  "amend-tasks": "task_id_optional",
  "fix-impl": "task_id_step",
  "fix-test": "task_id_step",
  "defer": "none",
  "backlog": "none",
};

/**
 * For `task_id_step` actions only, the canonical step that the action's
 * back-edge mutation targets. fix-impl drives the `implement` step;
 * fix-test drives the `red` step (TDD failure-first lane).
 */
export const FIX_ACTION_STEP: Partial<Record<FindingAction, string>> = {
  "fix-impl": "implement",
  "fix-test": "red",
};

// ── Target payload shape (mirror docs/schemas.ts FindingResolutionPayload) ──

export const FindingTarget = z.object({
  task_id: TaskIdPayload,
  step: z.string().min(1),
}).strict();
export type FindingTarget = z.infer<typeof FindingTarget>;
