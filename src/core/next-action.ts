import type { Ceremony, SubState } from "./journal-entry.js";
import type { PendingQueueEntry } from "./projection-schema.js";
import {
  buildGateDecideAction,
  gateNameForCursor,
  transitionOwnerFor,
  type NextAction,
} from "./reducer/transition.js";
import type { VerifyCheckKind } from "./evidence-schema.js";

const VERIFY_ORDER = [
  "VERIFY.run",
  "VERIFY.review",
  "VERIFY.acceptance",
  "VERIFY.visual",
] as const satisfies readonly SubState[];

const VERIFY_LANE_BY_STATE = {
  "VERIFY.run": "run",
  "VERIFY.review": "review",
  "VERIFY.acceptance": "acceptance",
  "VERIFY.visual": "visual",
} as const satisfies Partial<Record<SubState, VerifyCheckKind>>;

export type NextOutput = {
  ok: true;
  feature: string;
  feature_dir: string;
  cursor: { phase: string; sub_state: SubState };
  ceremony: Ceremony;
  terminal: boolean;
  blocked: boolean;
  next_action?: NextAction | undefined;
};

export type BuildNextOutputInput = {
  feature: string;
  feature_dir: string;
  phase: string;
  sub_state: SubState;
  ceremony: Ceremony;
  spec_locked: boolean;
  verify_accepted: boolean;
  pending: readonly PendingQueueEntry[];
  verify_applicable_lanes?: ReadonlySet<VerifyCheckKind> | undefined;
};

function pendingResolveAction(head: PendingQueueEntry): NextAction {
  // `loaf pending resolve` is strict FIFO and rejects a positional id
  // ("no --id flag"; commander.excessArguments → exit 2). The head is
  // already determined by FIFO order, so the id is redundant in the
  // command — it is preserved as `target` (head.kind) for the caller.
  return {
    command: `loaf pending resolve --answer "<answer>"`,
    owner_verb: "pending resolve",
    target: head.kind,
    blocking: true,
    reason: "PENDING_HEAD_REQUIRES_RESOLUTION",
  };
}

function profileEscalateAction(): NextAction {
  return {
    command: "loaf profile escalate --confirm --input <ceremony.json>",
    owner_verb: "profile escalate",
    target: "profile_escalation",
    blocking: true,
    reason: "PROFILE_ESCALATION_PENDING",
  };
}

function gateFromCursor(subState: SubState): NextAction | null {
  const gate = gateNameForCursor(subState);
  return gate === null ? null : buildGateDecideAction(gate);
}

function verifyNextTarget(
  subState: SubState,
  applicable: ReadonlySet<VerifyCheckKind> | undefined,
): SubState | undefined {
  if (!subState.startsWith("VERIFY.")) return undefined;
  if (subState === "VERIFY.accept") return undefined;
  const startIndex =
    subState === "VERIFY.plan" ? 0 : VERIFY_ORDER.findIndex((state) => state === subState) + 1;
  const lanes = applicable ?? new Set<VerifyCheckKind>(["run", "review", "acceptance", "visual"]);
  for (const state of VERIFY_ORDER.slice(Math.max(startIndex, 0))) {
    const lane = VERIFY_LANE_BY_STATE[state];
    if (lane !== undefined && lanes.has(lane)) return state;
  }
  return "VERIFY.accept";
}

function chooseNextAction(input: BuildNextOutputInput): NextAction | null {
  const head = input.pending[0];
  if (head !== undefined) {
    if (head.kind === "gate_decision") {
      const gate = gateFromCursor(input.sub_state);
      if (gate !== null) return gate;
      return pendingResolveAction(head);
    }
    if (head.kind === "profile_escalation") return profileEscalateAction();
    return pendingResolveAction(head);
  }

  return transitionOwnerFor({
    sub_state: input.sub_state,
    ceremony: input.ceremony,
    spec_locked: input.spec_locked,
    verify_accepted: input.verify_accepted,
    verify_next_target: verifyNextTarget(input.sub_state, input.verify_applicable_lanes),
  });
}

export function buildNextOutput(input: BuildNextOutputInput): NextOutput {
  const action = chooseNextAction(input);
  return {
    ok: true,
    feature: input.feature,
    feature_dir: input.feature_dir,
    cursor: { phase: input.phase, sub_state: input.sub_state },
    ceremony: input.ceremony,
    terminal: input.sub_state.startsWith("DONE."),
    blocked: action?.blocking ?? false,
    ...(action === null ? {} : { next_action: action }),
  };
}
