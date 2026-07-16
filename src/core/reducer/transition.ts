// validateTransition — Gate #1 (ADR-0005 §10).
//
// Sub-state transition validator for `event:phase_advanced` only. After
// Slice 1.A, `gate:decided` no longer drives transitions — it records an
// approval flag and a peer `event:phase_advanced` in the same batch
// advances the cursor. After Slice 1.D, `session:delivered` is the only
// kind that can reach DONE.delivered (its reducer applies the cursor flip
// directly; see reducer.ts:706-712); the DONE.delivered edges have been
// removed from the `event:phase_advanced` graph so `loaf advance
// DONE.delivered` returns TRANSITION_ILLEGAL and `loaf deliver` owns the
// delivery transition + its ceremony/flag preconditions (preflight step
// 5c). Symmetrically (Item 2), `session:archived` / `session:abandoned`
// are the only kinds that can reach DONE.archived / DONE.abandoned (same
// reducer direct cursor flip; see reducer.ts:837-854); their edges are
// likewise absent from the `event:phase_advanced` graph so `loaf advance
// DONE.archived` / `loaf advance DONE.abandoned` return TRANSITION_ILLEGAL
// and `loaf archive --reason` / `loaf abandon --reason` own the terminal
// transition + the required `reason` (preflight SESSION_REASON_REQUIRED
// refine). The settle_phase / verify_phase fork that previously gated
// DONE.delivered now lives on `loaf deliver` preflight; this helper still
// gates `loaf settle` (VERIFY.accept → SETTLE.reconcile) and the spec_phase
// / verify_phase forks for the SPEC.* and VERIFY.* entry points.
//
// The helper enforces:
//
//   1. Forward edge legality (LEGAL_TRANSITIONS graph)
//   2. TRIAGE.confirm fork: spec_phase=true → SPEC.proposal, false → EXECUTE.plan
//   3. EXECUTE.done fork: verify_phase=true → VERIFY.plan only
//      (verify_phase=false → DONE.delivered is now a `loaf deliver` concern
//      gated by verify-min, not an `event:phase_advanced` edge)
//   4. VERIFY.accept → SETTLE.reconcile fork (Slice 1.D):
//        - settle_phase=false (standard / quick / light) => SETTLE_PHASE_DISABLED
//        - verify_accepted=false                          => SETTLE_NOT_ACCEPTED
//
// The DONE.* terminals carry no `event:phase_advanced` edges at all:
// DONE.delivered / DONE.archived / DONE.abandoned are each reached only via
// their dedicated `session:*` kind. `loaf advance` into any of them is
// TRANSITION_ILLEGAL.
//
// Spec source: protocol.md §2.1 / §5.2, ADR-0005 §10.

import { z } from "zod";

import { GateName, PendingPromptKind, SubState, type Ceremony } from "../journal-entry.js";
import { gateNameForCursor, MACHINE, type MachineGuardName, type MachineNode } from "../machine.js";

export { gateNameForCursor };

// `event:phase_advanced` owns only its machine edges. Dedicated session
// owners keep DONE.* targets out of this projection.
function deriveLegalTransitions(): Record<SubState, readonly SubState[]> {
  const transitions = {} as Record<SubState, readonly SubState[]>;
  for (const subState of Object.keys(MACHINE) as SubState[]) {
    transitions[subState] = MACHINE[subState].edges
      .filter((edge) => edge.owner_kind === "event:phase_advanced")
      .map((edge) => edge.target);
  }
  return transitions;
}

export const LEGAL_TRANSITIONS = deriveLegalTransitions();

export const NextOwnerVerb = z.enum([
  "advance",
  "deliver",
  "settle",
  "gate decide",
  "profile escalate",
  "pending resolve",
  "tasks next",
]);
export type NextOwnerVerb =
  | "advance"
  | "deliver"
  | "settle"
  | "gate decide"
  | "profile escalate"
  | "pending resolve"
  | "tasks next";

type PendingPromptKindValue =
  | "ask_user_question"
  | "gate_decision"
  | "spec_clarification"
  | "finding_decision"
  | "profile_escalation";

export const NextAction = z
  .object({
    command: z.string().min(1),
    owner_verb: NextOwnerVerb,
    target: z.union([SubState, GateName, PendingPromptKind, z.literal("task-level")]).optional(),
    blocking: z.boolean(),
    reason: z.string().min(1),
  })
  .strict();
export type NextAction = {
  command: string;
  owner_verb: NextOwnerVerb;
  target?: SubState | GateName | PendingPromptKindValue | "task-level";
  blocking: boolean;
  reason: string;
};

export function buildGateDecideAction(gate: GateName): NextAction {
  return {
    command: `loaf gate decide ${gate} --approve|--reject --reason "<reason>"`,
    owner_verb: "gate decide",
    target: gate,
    blocking: true,
    reason:
      gate === "spec-lock"
        ? "SPEC_LOCK_GATE_DECISION_REQUIRED"
        : "VERIFY_ACCEPT_GATE_DECISION_REQUIRED",
  };
}

export function nextLegalTargets(
  prev: SubState,
  ceremony: Ceremony,
  verifyAccepted = false,
): SubState[] {
  const allowed = LEGAL_TRANSITIONS[prev] ?? [];
  return allowed.filter(
    (target) =>
      validateTransition(prev, target, {
        ceremony,
        actor: "cli:loaf",
        verify_accepted: verifyAccepted,
      }).ok,
  );
}

export type TransitionOwnerInput = {
  sub_state: SubState;
  ceremony: Ceremony;
  spec_locked: boolean;
  verify_accepted: boolean;
  verify_next_target?: SubState | undefined;
};

export function transitionOwnerFor(input: TransitionOwnerInput): NextAction | null {
  const { sub_state, ceremony, spec_locked, verify_accepted, verify_next_target } = input;
  const gate = gateNameForCursor(sub_state);

  if (gate === "spec-lock" && !spec_locked) {
    return buildGateDecideAction(gate);
  }

  if (sub_state === "VERIFY.accept") {
    if (gate !== null && !verify_accepted) return buildGateDecideAction(gate);
    if (ceremony.settle_phase) {
      return {
        command: "loaf settle",
        owner_verb: "settle",
        target: "SETTLE.reconcile",
        blocking: false,
        reason: "VERIFY_ACCEPTED_NEEDS_SETTLE",
      };
    }
    return {
      command: "loaf deliver",
      owner_verb: "deliver",
      target: "DONE.delivered",
      blocking: false,
      reason: "VERIFY_ACCEPTED_READY_TO_DELIVER",
    };
  }

  if (sub_state === "EXECUTE.work") {
    return {
      command: "loaf tasks next",
      owner_verb: "tasks next",
      target: "task-level",
      blocking: false,
      reason: "EXECUTE_WORK_TASK_ROUTING",
    };
  }

  if (sub_state === "EXECUTE.done" && !ceremony.verify_phase) {
    return {
      command: "loaf deliver",
      owner_verb: "deliver",
      target: "DONE.delivered",
      blocking: false,
      reason: "VERIFY_PHASE_DISABLED_READY_TO_DELIVER",
    };
  }

  if (sub_state === "SETTLE.lessons") {
    return {
      command: "loaf deliver",
      owner_verb: "deliver",
      target: "DONE.delivered",
      blocking: false,
      reason: "SETTLE_COMPLETE_READY_TO_DELIVER",
    };
  }

  if (sub_state.startsWith("DONE.")) return null;

  const targets = nextLegalTargets(sub_state, ceremony, verify_accepted);
  const target =
    verify_next_target !== undefined && targets.includes(verify_next_target)
      ? verify_next_target
      : targets[0];

  if (target === undefined) {
    throw new Error(`No legal next action for non-terminal sub_state=${sub_state}`);
  }
  return {
    command: `loaf advance ${target}`,
    owner_verb: "advance",
    target,
    blocking: false,
    reason: "ADVANCE_TO_NEXT_SUB_STATE",
  };
}

// Back-edge actions (Phase 11 Item 3). `amend-spec` wired at SC0,
// `amend-tasks` at SC1, `fix-impl` at SC2, `fix-test` at SC3.
type BackEdgeAction = "amend-spec" | "amend-tasks" | "fix-impl" | "fix-test";

type BackEdgeRule = {
  expected_target: SubState;
  allowed_from: ReadonlySet<SubState>;
  allowed_from_label: string;
};

// Ordered sets are observable in TRANSITION_ILLEGAL detail.allowed_from.
// Keep each action's source order and diagnostic label stable.
const BACK_EDGE_FROM = {
  "amend-spec": {
    expected_target: "SPEC.spec",
    allowed_from: new Set<SubState>([
      "EXECUTE.plan",
      "EXECUTE.work",
      "EXECUTE.done",
      "VERIFY.plan",
      "VERIFY.run",
      "VERIFY.review",
      "VERIFY.acceptance",
      "VERIFY.visual",
      "VERIFY.accept",
    ]),
    allowed_from_label: "EXECUTE.* + VERIFY.*",
  },
  "amend-tasks": {
    expected_target: "EXECUTE.work",
    allowed_from: new Set<SubState>([
      "EXECUTE.work",
      "EXECUTE.done",
      "VERIFY.plan",
      "VERIFY.run",
      "VERIFY.review",
      "VERIFY.acceptance",
      "VERIFY.visual",
      "VERIFY.accept",
    ]),
    allowed_from_label: "EXECUTE.work / EXECUTE.done + VERIFY.*",
  },
  "fix-impl": {
    expected_target: "EXECUTE.work",
    allowed_from: new Set<SubState>([
      "EXECUTE.work",
      "EXECUTE.done",
      "VERIFY.plan",
      "VERIFY.run",
      "VERIFY.review",
      "VERIFY.acceptance",
      "VERIFY.visual",
      "VERIFY.accept",
    ]),
    allowed_from_label: "EXECUTE.work / EXECUTE.done + VERIFY.*",
  },
  "fix-test": {
    expected_target: "EXECUTE.work",
    allowed_from: new Set<SubState>([
      "EXECUTE.work",
      "EXECUTE.done",
      "VERIFY.plan",
      "VERIFY.run",
      "VERIFY.review",
      "VERIFY.acceptance",
      "VERIFY.visual",
      "VERIFY.accept",
    ]),
    allowed_from_label: "EXECUTE.work / EXECUTE.done + VERIFY.*",
  },
} satisfies Record<BackEdgeAction, BackEdgeRule>;

export interface TransitionContext {
  ceremony: Ceremony;
  actor: string;
  gate_kind?: GateName;
  /**
   * Slice 1.D: snapshot.state.verify_accepted, threaded through preflight.
   * Required by the VERIFY.accept → SETTLE.reconcile refine (settle is
   * gated by both ceremony.settle_phase=true AND verify_accepted=true).
   * Optional for callers outside the VERIFY.accept fork — defaults to
   * false (which only matters for that edge).
   */
  verify_accepted?: boolean;
  /**
   * W1: snapshot.state.spec_locked, threaded through preflight. Required by
   * the SPEC.design → EXECUTE.plan refine (the spec-lock gate must hold on
   * the write-path cursor advance, symmetric to the verify_accepted refine
   * for VERIFY.accept → SETTLE.reconcile). Optional for callers outside the
   * SPEC.design fork — defaults to false (which only matters for that edge).
   */
  spec_locked?: boolean;
  /**
   * Slice B: back-edge sponsorship extracted from
   * `event:phase_advanced.payload.back_edge`. When set, validateTransition
   * enforces the action's target+from contract and bypasses forward-edge
   * legality. Caller (preflight) is also responsible for verifying the
   * referenced finding exists in `snapshot.findings` with matching
   * action and status="open" — that check needs snapshot which transition
   * doesn't carry.
   */
  back_edge?:
    | { action: "amend-spec"; finding_id: string }
    | { action: "amend-tasks"; finding_id: string }
    | { action: "fix-impl"; finding_id: string }
    | { action: "fix-test"; finding_id: string };
}

export type TransitionResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "TRANSITION_ILLEGAL"
        | "SETTLE_PHASE_DISABLED"
        | "SETTLE_NOT_ACCEPTED"
        | "SPEC_LOCK_NOT_SATISFIED"
        | "SPEC_PHASE_FORK_VIOLATION"
        | "VERIFY_PHASE_FORK_VIOLATION";
      message: string;
      detail?: Record<string, unknown>;
    };

type TransitionFailure = Extract<TransitionResult, { ok: false }>;

type TransitionGuard = {
  passes: (ctx: TransitionContext) => boolean;
  failure: (prev: SubState, target: SubState, ctx: TransitionContext) => TransitionFailure;
};

const TRANSITION_GUARDS = {
  spec_phase_required: {
    passes: (ctx) => ctx.ceremony.spec_phase,
    failure: (prev, target, ctx) => ({
      ok: false,
      code: "SPEC_PHASE_FORK_VIOLATION",
      message: `${prev} → ${target} requires ceremony.spec_phase=true`,
      detail: { from: prev, to: target, spec_phase: ctx.ceremony.spec_phase },
    }),
  },
  spec_phase_forbidden: {
    passes: (ctx) => !ctx.ceremony.spec_phase,
    failure: (prev, target, ctx) => ({
      ok: false,
      code: "SPEC_PHASE_FORK_VIOLATION",
      message:
        `${prev} → ${target} requires ceremony.spec_phase=false (quick); ` +
        "profiles with spec_phase=true must traverse SPEC.*",
      detail: { from: prev, to: target, spec_phase: ctx.ceremony.spec_phase },
    }),
  },
  verify_phase_required: {
    passes: (ctx) => ctx.ceremony.verify_phase,
    failure: (prev, target, ctx) => ({
      ok: false,
      code: "VERIFY_PHASE_FORK_VIOLATION",
      message: `${prev} → ${target} requires ceremony.verify_phase=true (standard / deep)`,
      detail: { from: prev, to: target, verify_phase: ctx.ceremony.verify_phase },
    }),
  },
  spec_locked_required: {
    passes: (ctx) => !!ctx.spec_locked,
    failure: (prev, target, ctx) => ({
      ok: false,
      code: "SPEC_LOCK_NOT_SATISFIED",
      message: `${prev} → ${target} requires spec_locked=true (run \`loaf gate decide spec-lock --approve\` first)`,
      detail: { from: prev, to: target, spec_locked: !!ctx.spec_locked },
    }),
  },
  settle_phase_required: {
    passes: (ctx) => ctx.ceremony.settle_phase,
    failure: (prev, target, ctx) => ({
      ok: false,
      code: "SETTLE_PHASE_DISABLED",
      message: `${prev} → ${target} requires ceremony.settle_phase=true (deep only)`,
      detail: { from: prev, to: target, settle_phase: ctx.ceremony.settle_phase },
    }),
  },
  verify_accepted_required: {
    passes: (ctx) => !!ctx.verify_accepted,
    failure: (prev, target, ctx) => ({
      ok: false,
      code: "SETTLE_NOT_ACCEPTED",
      message: `${prev} → ${target} requires verify_accepted=true (run \`loaf gate decide verify-accept --approve\` first)`,
      detail: { from: prev, to: target, verify_accepted: !!ctx.verify_accepted },
    }),
  },
} satisfies Record<MachineGuardName, TransitionGuard>;

function validateBackEdge(
  prev: SubState,
  target: SubState,
  backEdge: NonNullable<TransitionContext["back_edge"]>,
): TransitionResult {
  const action = (backEdge as { action: string }).action;
  const rule = Object.hasOwn(BACK_EDGE_FROM, action)
    ? BACK_EDGE_FROM[action as BackEdgeAction]
    : undefined;

  if (rule === undefined) {
    return {
      ok: false,
      code: "TRANSITION_ILLEGAL",
      message: `unknown back_edge.action ${action}`,
      detail: { back_edge: backEdge, reason: "back_edge_action_unknown" },
    };
  }

  if (target !== rule.expected_target) {
    return {
      ok: false,
      code: "TRANSITION_ILLEGAL",
      message: `back_edge action=${action} requires target=${rule.expected_target}, got ${target}`,
      detail: {
        from: prev,
        to: target,
        back_edge_action: action,
        expected_target: rule.expected_target,
        reason: "back_edge_target_mismatch",
      },
    };
  }

  if (!rule.allowed_from.has(prev)) {
    return {
      ok: false,
      code: "TRANSITION_ILLEGAL",
      message: `back_edge action=${action} is not legal from ${prev}; allowed from ${rule.allowed_from_label}`,
      detail: {
        from: prev,
        to: target,
        back_edge_action: action,
        allowed_from: [...rule.allowed_from],
        reason: "back_edge_from_not_allowed",
      },
    };
  }

  return { ok: true };
}

export function validateTransition(
  prev: SubState,
  target: SubState,
  ctx: TransitionContext,
): TransitionResult {
  if (ctx.back_edge !== undefined) return validateBackEdge(prev, target, ctx.back_edge);

  const allowed = LEGAL_TRANSITIONS[prev] ?? [];
  if (!allowed.includes(target)) {
    return {
      ok: false,
      code: "TRANSITION_ILLEGAL",
      message: `cannot transition ${prev} → ${target}`,
      detail: {
        from: prev,
        to: target,
        allowed_forward: [...allowed],
      },
    };
  }

  const node: MachineNode = MACHINE[prev];
  const edge = node.edges.find(
    (candidate) => candidate.owner_kind === "event:phase_advanced" && candidate.target === target,
  );
  if (edge === undefined) {
    throw new Error(
      `MACHINE forward edge missing after LEGAL_TRANSITIONS accepted ${prev} → ${target}`,
    );
  }

  for (const guardName of edge.guards ?? []) {
    const guard = TRANSITION_GUARDS[guardName];
    if (!guard.passes(ctx)) return guard.failure(prev, target, ctx);
  }

  return { ok: true };
}
