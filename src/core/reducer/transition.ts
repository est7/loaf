// validateTransition — Gate #1 (ADR-0005 §10).
//
// Shared sub-state transition validator. `event:phase_advanced` and
// `gate:decided` reducer apply paths BOTH call this helper; no per-kind
// if/else fork. The helper enforces:
//
//   1. Forward edge legality (LEGAL_TRANSITIONS graph)
//   2. Always-legal user-explicit eject targets (DONE.archived / DONE.abandoned
//      per protocol.md §8.3) bypass legality + ceremony guards
//   3. rev 5.x VERIFY.accept ceremony fork:
//        - settle_phase=true  (deep)     => MUST go SETTLE.reconcile
//        - settle_phase=false (standard) => MUST go DONE.delivered
//   4. (Stage 2+) gate:decided requires human:* actor
//
// Spec source: protocol.md §2.1 / §5.2, ADR-0005 §10, src/spike/reducer.ts
// (rev 5.x 4-cell fork matrix already validated; this is the production
// promotion path).

import type { Ceremony, GateName, SubState } from "../journal-entry.js";

// Forward edges of the state-machine graph. Empty = terminal. Back-edges
// (finding amend-spec / amend-tasks / fix-impl / fix-test) are NOT here;
// they travel as separate event kinds with their own apply paths.
const LEGAL_TRANSITIONS: Record<SubState, readonly SubState[]> = {
  "TRIAGE.score": ["TRIAGE.confirm"],
  "TRIAGE.confirm": ["SPEC.proposal", "EXECUTE.plan"], // spec_phase fork
  "SPEC.proposal": ["SPEC.spec"],
  "SPEC.spec": ["SPEC.plan"],
  "SPEC.plan": ["SPEC.design"],
  "SPEC.design": ["EXECUTE.plan"],
  "EXECUTE.plan": ["EXECUTE.work"],
  "EXECUTE.work": ["EXECUTE.done"],
  "EXECUTE.done": ["VERIFY.plan", "DONE.delivered"], // verify_phase fork
  "VERIFY.plan": ["VERIFY.run"],
  "VERIFY.run": ["VERIFY.review", "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept"],
  "VERIFY.review": ["VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept"],
  "VERIFY.acceptance": ["VERIFY.visual", "VERIFY.accept"],
  "VERIFY.visual": ["VERIFY.accept"],
  "VERIFY.accept": ["SETTLE.reconcile", "DONE.delivered"], // settle_phase fork
  "SETTLE.reconcile": ["SETTLE.lessons"],
  "SETTLE.lessons": ["DONE.delivered", "DONE.archived", "DONE.abandoned"],
  "DONE.delivered": [],
  "DONE.archived": [],
  "DONE.abandoned": [],
};

const ALWAYS_LEGAL_TARGETS: ReadonlySet<SubState> = new Set([
  "DONE.archived",
  "DONE.abandoned",
]);

export interface TransitionContext {
  ceremony: Ceremony;
  actor: string;
  gate_kind?: GateName;
}

export type TransitionResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "TRANSITION_ILLEGAL"
        | "SETTLE_PHASE_DISABLED"
        | "SETTLE_PHASE_BYPASS";
      message: string;
      detail?: Record<string, unknown>;
    };

export function validateTransition(
  prev: SubState,
  target: SubState,
  ctx: TransitionContext,
): TransitionResult {
  // User-explicit eject targets bypass legality + ceremony guards.
  if (ALWAYS_LEGAL_TARGETS.has(target)) {
    return { ok: true };
  }

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
        always_legal: [...ALWAYS_LEGAL_TARGETS],
      },
    };
  }

  // rev 5.x — VERIFY.accept fork ceremony guard.
  if (prev === "VERIFY.accept") {
    const settlePhase = ctx.ceremony.settle_phase;
    if (target === "SETTLE.reconcile" && !settlePhase) {
      return {
        ok: false,
        code: "SETTLE_PHASE_DISABLED",
        message:
          "VERIFY.accept → SETTLE.reconcile requires ceremony.settle_phase=true (deep only)",
        detail: { from: prev, to: target, settle_phase: settlePhase },
      };
    }
    if (target === "DONE.delivered" && settlePhase) {
      return {
        ok: false,
        code: "SETTLE_PHASE_BYPASS",
        message:
          "VERIFY.accept → DONE.delivered requires ceremony.settle_phase=false (deep must go through SETTLE)",
        detail: { from: prev, to: target, settle_phase: settlePhase },
      };
    }
  }

  return { ok: true };
}
