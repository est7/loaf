// Core owner for pending/finding intervention decisions. Schemas own shapes;
// reducer/transition.ts exclusively owns back-edge source and target rules.

import type { FindingAction, FindingCategory, FindingActionRisk } from "./finding-schema.js";
import type { Diagnostic } from "./error-catalog.js";
import { diagnostic } from "./error-catalog.js";
import type { z } from "zod";
import type { FindingRaisedPayload, TaskStepResetPayload } from "./journal-entry.js";
import type { FindingState, Snapshot, PendingState } from "./projection-types.js";
import type { GateName, SubState } from "./journal-entry.js";
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

/** Historical pending rows keep resolved entries; the head is first unresolved. */
export function pendingHeadIndex(rows: readonly { resolved: boolean }[]): number {
  return rows.findIndex((row) => !row.resolved);
}

export function pendingHead<T extends { resolved: boolean }>(rows: readonly T[]): T | undefined {
  const index = pendingHeadIndex(rows);
  return index === -1 ? undefined : rows[index];
}

/** Preserve rich/slim fields and ordering; serialization remains with the writer. */
export function livePending<T extends { resolved: boolean }>(rows: readonly T[]): T[] {
  return rows.filter((row) => !row.resolved);
}

export function checkPendingAdvance(
  rows: readonly PendingState[],
): Diagnostic<"PENDING_BLOCKS_ADVANCE"> | null {
  const head = pendingHead(rows);
  return head && (head.kind === "gate_decision" || head.kind === "profile_escalation")
    ? diagnostic("PENDING_BLOCKS_ADVANCE", { pending_id: head.id, kind: head.kind })
    : null;
}

/** Approved gates soft-bind to a gate head; rejected gates never co-resolve.
 * CLI assembly consumes only an eligible head. A failure is still reported
 * by admission at its existing stage, after other earlier checks. */
export function planGatePending(
  rows: readonly PendingState[],
  gate: GateName,
  decision: "approved" | "rejected",
):
  | { ok: true; resolutionHead: PendingState | undefined }
  | ({ ok: false } & Diagnostic<"GATE_NOT_PENDING">) {
  if (decision === "rejected") return { ok: true, resolutionHead: undefined };
  const head = pendingHead(rows);
  if (head && head.kind !== "gate_decision") {
    return {
      ok: false,
      ...diagnostic("GATE_NOT_PENDING", {
        gate_kind: gate,
        head_id: head.id,
        head_kind: head.kind,
      }),
    };
  }
  return { ok: true, resolutionHead: head };
}

export function checkPendingEscalation(
  rows: readonly PendingState[],
  subState: SubState,
): Diagnostic<"ESCALATION_NOT_PENDING"> | null {
  if (subState === "TRIAGE.score" || subState === "TRIAGE.confirm") return null;
  const head = pendingHead(rows);
  return head?.kind === "profile_escalation"
    ? null
    : diagnostic("ESCALATION_NOT_PENDING", { actual_head: head ? head.kind : "(none)" });
}

/** Called at reducer application, not promoted into admission. */
export function resolvePending(
  rows: readonly PendingState[],
  id: string,
): { ok: true; pending: PendingState[] } | ({ ok: false } & Diagnostic<"PENDING_NOT_FOUND">) {
  const index = pendingHeadIndex(rows);
  if (index === -1)
    return { ok: false, ...diagnostic("PENDING_NOT_FOUND", { reason: "no pending head" }) };
  const head = rows[index]!;
  if (head.id !== id)
    return {
      ok: false,
      ...diagnostic("PENDING_NOT_FOUND", {
        reason: `id=${id} does not match head id=${head.id} (FIFO violation)`,
      }),
    };
  return {
    ok: true,
    pending: rows.map((row, i) => (i === index ? { ...row, resolved: true } : row)),
  };
}

/** Intent routing for an already-live queue; all pending kinds require a next
 * action, whereas only gate/profile heads block phase advance. */
export function pendingResolutionOwner(
  kind: string,
  gateAtCursor: GateName | null,
): { owner: "gate decide"; gate: GateName } | { owner: "profile escalate" | "pending resolve" } {
  if (kind === "gate_decision" && gateAtCursor !== null)
    return { owner: "gate decide", gate: gateAtCursor };
  if (kind === "profile_escalation") return { owner: "profile escalate" };
  return { owner: "pending resolve" };
}

type FindingLookup<Action extends string = string> =
  | { ok: true; finding: FindingState & { action: Action }; index: number }
  | ({ ok: false } & Diagnostic<"FINDING_NOT_FOUND">);

function openFinding(rows: readonly FindingState[], id: string): FindingLookup {
  const index = rows.findIndex((finding) => finding.id === id);
  if (index === -1)
    return { ok: false, code: "FINDING_NOT_FOUND", detail: { id, reason: "not_found" } };
  const finding = rows[index]!;
  if (finding.status === "closed")
    return { ok: false, code: "FINDING_NOT_FOUND", detail: { id, reason: "already_closed" } };
  return { ok: true, finding, index };
}

/** Preserve each operation's single-action/string versus fix-action/array detail. */
export function requireFindingSponsor<const Action extends string>(
  rows: readonly FindingState[],
  id: string,
  expectedAction: Action | readonly Action[],
): FindingLookup<Action> {
  const found = openFinding(rows, id);
  if (!found.ok) return found;
  const matches =
    typeof expectedAction === "string"
      ? found.finding.action === expectedAction
      : (expectedAction as readonly string[]).includes(found.finding.action);
  if (!matches)
    return {
      ok: false,
      code: "FINDING_NOT_FOUND",
      detail: {
        id,
        reason: "action_mismatch",
        expected_action: expectedAction,
        actual_action: found.finding.action,
      },
    };
  // The equality/includes check above refines the loose historical action.
  return { ...found, finding: found.finding as FindingState & { action: Action } };
}

/** Closure retains its historical missing-id reason and reducer-stage check. */
export function findingForClosure(rows: readonly FindingState[], id: string): FindingLookup {
  const found = openFinding(rows, id);
  return !found.ok && found.detail.reason === "not_found"
    ? { ok: false, code: "FINDING_NOT_FOUND", detail: { id, reason: "unknown" } }
    : found;
}

type FindingPolicyFailure = { ok: false } & Diagnostic<
  | "FINDING_ACTION_INCOHERENT"
  | "FINDING_ACTION_UNUSUAL_REASON_REQUIRED"
  | "FINDING_TARGET_REQUIRED"
  | "FINDING_AMEND_SPEC_NOT_LOCKED"
  | "FINDING_NOT_FOUND"
  | "MUTATION_OUT_OF_RIGHTS"
>;

/** Runs after general kind/actor/sub-state admission; preserves the existing
 * risk -> reason -> target -> spec-lock order. */
export function checkFindingRaise(
  payload: z.infer<typeof FindingRaisedPayload>,
  snapshot: Pick<Snapshot, "tasks" | "state">,
  sub_state: SubState,
): FindingPolicyFailure | null {
  const risk = cellRisk(payload.category, payload.action);
  if (risk === "incoherent") {
    return {
      ok: false,
      code: "FINDING_ACTION_INCOHERENT",
      detail: { category: payload.category, action: payload.action },
    };
  }
  if (risk === "unusual") {
    const reasonLength = payload.reason?.length ?? 0;
    if (reasonLength < FINDING_UNUSUAL_REASON_MIN_LENGTH) {
      return {
        ok: false,
        ...diagnostic("FINDING_ACTION_UNUSUAL_REASON_REQUIRED", {
          category: payload.category,
          action: payload.action,
          current_reason_length: reasonLength,
          min_reason_length: FINDING_UNUSUAL_REASON_MIN_LENGTH,
        }),
      };
    }
  }
  const mode = FINDING_ACTION_TARGET_MODE[payload.action];
  if (mode === "task_id_step") {
    if (!payload.target) {
      return {
        ok: false,
        code: "FINDING_TARGET_REQUIRED",
        detail: { action: payload.action, reason: "missing" },
      };
    }
    const expectedStep = FIX_ACTION_STEP[payload.action];
    if (expectedStep && payload.target.step !== expectedStep) {
      return {
        ok: false,
        code: "FINDING_TARGET_REQUIRED",
        detail: {
          action: payload.action,
          task_id: payload.target.task_id,
          step: payload.target.step,
          expected_step: expectedStep,
          reason: "step_mismatch",
        },
      };
    }
  }
  if (mode === "none" && payload.target) {
    // codex r69 BLOCK 1: amend-spec / defer / backlog must not carry a
    // target — `requires_target_payload="none"` is the action-effect
    // contract from FINDING_ACTION_EFFECTS, not advisory prose. Accepting
    // a bogus target would project misleading state into snapshot.findings
    // and break strict-over-Postel for the journal payload.
    return {
      ok: false,
      code: "FINDING_TARGET_REQUIRED",
      detail: {
        action: payload.action,
        task_id: payload.target.task_id,
        step: payload.target.step,
        reason: "target_not_allowed",
      },
    };
  }
  if (mode === "task_id_step" || mode === "task_id_optional") {
    if (payload.target) {
      const task = snapshot.tasks.find((t) => t.id === payload.target!.task_id);
      if (!task) {
        return {
          ok: false,
          code: "FINDING_TARGET_REQUIRED",
          detail: {
            action: payload.action,
            task_id: payload.target.task_id,
            reason: "task_not_found",
          },
        };
      }
      if (!(payload.target.step in task.steps)) {
        return {
          ok: false,
          code: "FINDING_TARGET_REQUIRED",
          detail: {
            action: payload.action,
            task_id: payload.target.task_id,
            step: payload.target.step,
            available_steps: Object.keys(task.steps),
            reason: "step_not_found",
          },
        };
      }
    }
  }

  // Slice B — amend-spec specifically requires state.spec_locked=true
  // (codex r94 Finding 3 placement: AFTER generic sub_state authority
  // L164+ so SUB_STATE_AUTHORITY_VIOLATION wins at SPEC.* / SETTLE.* /
  // TRIAGE.*; this refine only fires at the legal raise lanes
  // EXECUTE.* + VERIFY.* where finding:raised is authorized).
  // Pre-lock callers should edit via `loaf spec submit / add-*`
  // directly — SPEC_LOCKED_NO_DIRECT_EDIT is the inverse gate.
  if (payload.action === "amend-spec" && !snapshot.state?.spec_locked) {
    return {
      ok: false,
      code: "FINDING_AMEND_SPEC_NOT_LOCKED",
      detail: {
        current_spec_locked: false,
        current_sub_state: sub_state,
        hint: "use loaf spec submit / add-* directly to edit spec when not locked",
      },
    };
  }
  return null;
}

/** Sponsor -> canonical step -> exact target -> task/step -> abandoned order. */
export function checkFindingReset(
  payload: TaskStepResetPayload,
  snapshot: Pick<Snapshot, "findings" | "tasks">,
  sub_state: SubState,
): FindingPolicyFailure | null {
  const sponsor = requireFindingSponsor(snapshot.findings, payload.finding_id, [
    "fix-impl",
    "fix-test",
  ]);
  if (!sponsor.ok) return sponsor;
  const finding = sponsor.finding;
  // The payload's {task_id, step} must equal the finding's target — the
  // reset cannot drift off the task/step the finding authorized. The
  // canonical step is the finding action's own (fix-impl → "implement",
  // fix-test → "red") — SC3 keys it off finding.action, not a hardcode.
  const expectedStep = FIX_ACTION_STEP[finding.action]!;
  if (payload.step !== expectedStep) {
    return {
      ok: false,
      code: "MUTATION_OUT_OF_RIGHTS",
      detail: {
        finding_id: payload.finding_id,
        sub_state,
        task_id: payload.task_id,
        step: payload.step,
        expected_step: expectedStep,
        reason: "task_step_reset_step_mismatch",
      },
    };
  }
  const expectedTarget = finding.target;
  if (
    expectedTarget === undefined ||
    expectedTarget.task_id !== payload.task_id ||
    expectedTarget.step !== payload.step
  ) {
    return {
      ok: false,
      code: "MUTATION_OUT_OF_RIGHTS",
      detail: {
        finding_id: payload.finding_id,
        sub_state,
        task_id: payload.task_id,
        expected_target: expectedTarget ?? null,
        actual_target: { task_id: payload.task_id, step: payload.step },
        reason: "task_step_reset_target_mismatch",
      },
    };
  }
  // The target task + step must exist in the projection — a step the task
  // does not carry cannot be reset (treated as a target mismatch: the
  // finding's target points at a step absent from the task graph).
  const task = snapshot.tasks.find((t) => t.id === payload.task_id);
  if (!task || !(payload.step in task.steps)) {
    return {
      ok: false,
      code: "MUTATION_OUT_OF_RIGHTS",
      detail: {
        finding_id: payload.finding_id,
        sub_state,
        task_id: payload.task_id,
        step: payload.step,
        reason: "task_step_reset_target_mismatch",
      },
    };
  }
  // codex r140 P1 — a fix-impl/fix-test step reset may reopen a `done`
  // task (r139 Q5: a done task's step cannot otherwise be re-run), but
  // `abandoned` is a TERMINAL status and must NOT be reactivated
  // (protocol.md — abandoned is a final task status; task-schema.ts —
  // abandoned tasks cannot be reactivated). The reducer rewrites the target
  // task to `in_progress`; without this guard a fix finding targeting an
  // abandoned task would resurrect it. The guard is action-agnostic — it
  // serves both fix-impl and fix-test.
  if (task.status === "abandoned") {
    return {
      ok: false,
      code: "MUTATION_OUT_OF_RIGHTS",
      detail: {
        finding_id: payload.finding_id,
        sub_state,
        task_id: payload.task_id,
        status: task.status,
        reason: "task_step_reset_task_abandoned",
      },
    };
  }
  return null;
}
