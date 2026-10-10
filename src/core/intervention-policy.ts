// Core owner for pending/finding intervention decisions. Schemas own shapes;
// reducer/transition.ts exclusively owns back-edge source and target rules.

import type { FindingAction, FindingCategory, FindingActionRisk } from "./finding-schema.js";
import type { SubState } from "./journal-entry.js";
import { backEdgeTarget } from "./reducer/transition.js";

/** Actions whose selection is itself a non-blocking disposition. */
export const FINDING_DEFERRAL_ACTIONS = [
  "defer",
  "backlog",
] as const satisfies readonly FindingAction[];
export type FindingDeferralAction = (typeof FINDING_DEFERRAL_ACTIONS)[number];

/**
 * Derive disposition from the persisted action without widening the journal
 * or projection schema. Accepts string because historical slim snapshots type
 * FindingState.action loosely, while validated new entries use FindingAction.
 */
export function isFindingDeferralAction(action: string): action is FindingDeferralAction {
  return (FINDING_DEFERRAL_ACTIONS as readonly string[]).includes(action);
}

/**
 * FINDING_ACTION_GRID — per-cell risk classification.
 * 4 `incoherent` cells (rev 4.3 ADR-0004 A7): structurally there is no
 * task target a transition can land on, so block early at preflight.
 * Implements the `docs/protocol.md §4.5` finding matrix.
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
    defer: "typical",
    backlog: "typical",
  },
  "spec-defect": {
    "amend-spec": "typical",
    "amend-tasks": "unusual",
    "fix-impl": "unusual",
    "fix-test": "unusual",
    defer: "typical",
    backlog: "typical",
  },
  "impl-defect": {
    "amend-spec": "unusual",
    "amend-tasks": "typical",
    "fix-impl": "typical",
    "fix-test": "unusual",
    defer: "typical",
    backlog: "typical",
  },
  "test-defect": {
    "amend-spec": "unusual",
    "amend-tasks": "typical",
    "fix-impl": "unusual",
    "fix-test": "typical",
    defer: "typical",
    backlog: "typical",
  },
  "new-scope": {
    "amend-spec": "typical",
    "amend-tasks": "typical",
    "fix-impl": "incoherent",
    "fix-test": "incoherent",
    defer: "typical",
    backlog: "typical",
  },
  "risk-escalation": {
    "amend-spec": "unusual",
    "amend-tasks": "typical",
    "fix-impl": "unusual",
    "fix-test": "unusual",
    defer: "typical",
    backlog: "typical",
  },
};

/** Look up the (category, action) cell risk in O(1). */
export function cellRisk(category: FindingCategory, action: FindingAction): FindingActionRisk {
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
//                        backlog. Schema parsing supplies the shape; preflight
//                        rejects a supplied target for these actions.

export type FindingTargetMode = "task_id_step" | "task_id_optional" | "none";

export const FINDING_ACTION_TARGET_MODE: Record<FindingAction, FindingTargetMode> = {
  "amend-spec": "none",
  "amend-tasks": "task_id_optional",
  "fix-impl": "task_id_step",
  "fix-test": "task_id_step",
  defer: "none",
  backlog: "none",
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

/** Action effect for batch assembly; admission still verifies authorization.
 * Unknown action strings have no mechanical siblings, preserving the loose
 * input surface used by CLI builders before payload admission. */
export function findingActionEffect(
  action: string,
):
  | { kind: "none" }
  | { kind: "fix-reset"; target: SubState; step: string }
  | { kind: "back-edge"; target: SubState } {
  if (action === "fix-impl" || action === "fix-test") {
    return { kind: "fix-reset", target: backEdgeTarget(action), step: FIX_ACTION_STEP[action]! };
  }
  if (action === "amend-spec" || action === "amend-tasks") {
    return { kind: "back-edge", target: backEdgeTarget(action) };
  }
  return { kind: "none" };
}
