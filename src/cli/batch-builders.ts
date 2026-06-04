import type { SubState } from "../core/journal-entry.js";
import type { MutatorEntry } from "./mutator-entry.js";

// L9 — named atomic batch builders for the two command intents whose batch
// construction encodes a protocol DECISION (conditional co-emission + per-entry
// actor split + ordering), not just "emit N literals". The fixed two-entry
// batches (spike convert, profile escalate) stay inline — a single-caller
// builder for `[A, B]` would be a shallow pass-through (deletion test fails).
//
// These are PURE: no IO, no ctx, no snapshot, no runMutator. They encode only
// the CLI co-emission SHAPE; reducer/preflight stays the authority on whether a
// batch is legal. runMutator stamps `at` + entry_schema_version downstream.

export type GateApprovalArgs =
  | {
      gate: "spec-lock";
      reason: string;
      humanActor: string;
      cliActor: string;
      pendingHeadId?: string;
      from: SubState;
    }
  | {
      gate: "verify-accept";
      reason: string;
      humanActor: string;
      cliActor: string;
      pendingHeadId?: string;
    };

/**
 * Approval ordering invariant (historically a codex BLOCK source):
 * 1. `gate:decided` (human) FIRST.
 * 2. `pending:resolved` (cli) only when the unresolved head is a gate_decision
 *    prompt — caller passes `pendingHeadId` exactly when that holds. It MUST sit
 *    between the decision and any cursor advance so the reducer dry-run still
 *    sees the head unresolved.
 * 3. `event:phase_advanced` (cli) only for spec-lock (SPEC.design → EXECUTE.plan);
 *    verify-accept moves NO cursor (deliver/settle advance later).
 */
export function buildGateApprovalBatch(args: GateApprovalArgs): MutatorEntry[] {
  const entries: MutatorEntry[] = [
    {
      kind: "gate:decided",
      payload: { gate_kind: args.gate, decision: "approved", reason: args.reason },
      actor: args.humanActor,
    },
  ];
  if (args.pendingHeadId !== undefined) {
    entries.push({
      kind: "pending:resolved",
      payload: { id: args.pendingHeadId, answer: `gate-decide:${args.gate}:approved` },
      actor: args.cliActor,
    });
  }
  if (args.gate === "spec-lock") {
    entries.push({
      kind: "event:phase_advanced",
      payload: { from: args.from, to: "EXECUTE.plan" },
      actor: args.cliActor,
    });
  }
  return entries;
}

export type FindingRaiseBatch =
  | { kind: "none" }
  | { kind: "fix-reset"; entries: MutatorEntry[]; backEdgeTo: SubState }
  | { kind: "back-edge"; entries: MutatorEntry[]; backEdgeTo: SubState };

const FIX_RESET_STEP: Record<string, string> = {
  "fix-impl": "implement",
  "fix-test": "red",
};
const BACK_EDGE_TARGET: Record<string, SubState> = {
  "amend-spec": "SPEC.spec",
  "amend-tasks": "EXECUTE.work",
};

/**
 * finding raise co-emission shape, by `action`:
 * - fix-impl/fix-test WITH a target → 3-entry reset batch (→ EXECUTE.work).
 * - amend-spec/amend-tasks → 2-entry back-edge batch.
 * - everything else, incl. fix-* WITHOUT a target → "none": the caller falls
 *   through to its lone `finding:raised` so preflight's FINDING_TARGET_REQUIRED
 *   stays the authoritative target gate (we do NOT synthesize a partial batch).
 *
 * Actor split: `finding:raised` carries the caller's `findingActor`
 * (`cli:loaf@<user>`); the mechanical `event:task_step_reset` / phase_advanced
 * siblings carry the literal machine actor `"cli:loaf"` — human attribution
 * lives on the sibling finding:raised entry one journal line away.
 */
export function buildFindingRaiseBatch(args: {
  action: string;
  findingPayload: Record<string, unknown>;
  findingId: string;
  currentSubState: SubState;
  findingActor: string;
  target?: { taskId: string; step: string };
}): FindingRaiseBatch {
  const findingRaised: MutatorEntry = {
    kind: "finding:raised",
    payload: args.findingPayload,
    actor: args.findingActor,
  };

  const fixResetStep = FIX_RESET_STEP[args.action];
  if (fixResetStep !== undefined && args.target !== undefined) {
    return {
      kind: "fix-reset",
      backEdgeTo: "EXECUTE.work",
      entries: [
        findingRaised,
        {
          kind: "event:task_step_reset",
          payload: {
            task_id: args.target.taskId,
            step: fixResetStep,
            finding_id: args.findingId,
          },
          actor: "cli:loaf",
        },
        {
          kind: "event:phase_advanced",
          payload: {
            from: args.currentSubState,
            to: "EXECUTE.work",
            back_edge: { action: args.action, finding_id: args.findingId },
          },
          actor: "cli:loaf",
        },
      ],
    };
  }

  const backEdgeTarget = BACK_EDGE_TARGET[args.action];
  if (backEdgeTarget !== undefined) {
    return {
      kind: "back-edge",
      backEdgeTo: backEdgeTarget,
      entries: [
        findingRaised,
        {
          kind: "event:phase_advanced",
          payload: {
            from: args.currentSubState,
            to: backEdgeTarget,
            back_edge: { action: args.action, finding_id: args.findingId },
          },
          actor: "cli:loaf",
        },
      ],
    };
  }

  return { kind: "none" };
}
