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
// 5c). The settle_phase / verify_phase fork that previously gated
// DONE.delivered now lives on `loaf deliver` preflight; this helper still
// gates `loaf settle` (VERIFY.accept → SETTLE.reconcile) and the spec_phase
// / verify_phase forks for the SPEC.* and VERIFY.* entry points.
//
// The helper enforces:
//
//   1. Forward edge legality (LEGAL_TRANSITIONS graph)
//   2. Always-legal user-explicit eject targets (DONE.archived / DONE.abandoned
//      per protocol.md §8.3) bypass legality + ceremony guards
//   3. TRIAGE.confirm fork: spec_phase=true → SPEC.proposal, false → EXECUTE.plan
//   4. EXECUTE.done fork: verify_phase=true → VERIFY.plan only
//      (verify_phase=false → DONE.delivered is now a `loaf deliver` concern
//      gated by verify-min, not an `event:phase_advanced` edge)
//   5. VERIFY.accept → SETTLE.reconcile fork (Slice 1.D):
//        - settle_phase=false (standard / quick / light) => SETTLE_PHASE_DISABLED
//        - verify_accepted=false                          => SETTLE_NOT_ACCEPTED
//
// Spec source: protocol.md §2.1 / §5.2, ADR-0005 §10.

import type { Ceremony, GateName, SubState } from "../journal-entry.js";

// Forward edges of the state-machine graph. Empty = terminal. Back-edges
// (finding amend-spec / amend-tasks / fix-impl / fix-test) are NOT here;
// they travel as separate event kinds with their own apply paths.
//
// Slice 1.D: removed 3 `→ DONE.delivered` edges (VERIFY.accept, EXECUTE.done,
// SETTLE.lessons). DONE.delivered is reached exclusively via `session:delivered`
// (reducer direct cursor flip) — `loaf deliver`'s territory. `loaf advance
// DONE.delivered` from any sub_state now returns TRANSITION_ILLEGAL.
const LEGAL_TRANSITIONS: Record<SubState, readonly SubState[]> = {
  "TRIAGE.score": ["TRIAGE.confirm"],
  "TRIAGE.confirm": ["SPEC.proposal", "EXECUTE.plan"], // spec_phase fork
  "SPEC.proposal": ["SPEC.spec"],
  "SPEC.spec": ["SPEC.plan"],
  "SPEC.plan": ["SPEC.design"],
  "SPEC.design": ["EXECUTE.plan"],
  "EXECUTE.plan": ["EXECUTE.work"],
  "EXECUTE.work": ["EXECUTE.done"],
  "EXECUTE.done": ["VERIFY.plan"], // Slice 1.D: DONE.delivered now via `loaf deliver`
  "VERIFY.plan": ["VERIFY.run"],
  "VERIFY.run": ["VERIFY.review", "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept"],
  "VERIFY.review": ["VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept"],
  "VERIFY.acceptance": ["VERIFY.visual", "VERIFY.accept"],
  "VERIFY.visual": ["VERIFY.accept"],
  "VERIFY.accept": ["SETTLE.reconcile"], // Slice 1.D: DONE.delivered now via `loaf deliver`
  "SETTLE.reconcile": ["SETTLE.lessons"],
  "SETTLE.lessons": ["DONE.archived", "DONE.abandoned"], // Slice 1.D: DONE.delivered now via `loaf deliver`
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
  /**
   * Slice 1.D: snapshot.state.verify_accepted, threaded through preflight.
   * Required by the VERIFY.accept → SETTLE.reconcile refine (settle is
   * gated by both ceremony.settle_phase=true AND verify_accepted=true).
   * Optional for callers outside the VERIFY.accept fork — defaults to
   * false (which only matters for that edge).
   */
  verify_accepted?: boolean;
}

export type TransitionResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "TRANSITION_ILLEGAL"
        | "SETTLE_PHASE_DISABLED"
        | "SETTLE_NOT_ACCEPTED"
        | "SPEC_PHASE_FORK_VIOLATION"
        | "VERIFY_PHASE_FORK_VIOLATION";
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

  // rev 5.x — TRIAGE.confirm fork ceremony guard (audit r1 follow-up).
  //   spec_phase=true  (light / standard / deep) → SPEC.proposal
  //   spec_phase=false (quick)                   → EXECUTE.plan
  if (prev === "TRIAGE.confirm") {
    const specPhase = ctx.ceremony.spec_phase;
    if (target === "SPEC.proposal" && !specPhase) {
      return {
        ok: false,
        code: "SPEC_PHASE_FORK_VIOLATION",
        message:
          "TRIAGE.confirm → SPEC.proposal requires ceremony.spec_phase=true",
        detail: { from: prev, to: target, spec_phase: specPhase },
      };
    }
    if (target === "EXECUTE.plan" && specPhase) {
      return {
        ok: false,
        code: "SPEC_PHASE_FORK_VIOLATION",
        message:
          "TRIAGE.confirm → EXECUTE.plan requires ceremony.spec_phase=false (quick); profiles with spec_phase=true must traverse SPEC.*",
        detail: { from: prev, to: target, spec_phase: specPhase },
      };
    }
  }

  // rev 5.x — EXECUTE.done fork ceremony guard (audit r1 follow-up).
  //   verify_phase=true  (standard / deep) → VERIFY.plan (required entry into VERIFY)
  //   verify_phase=false (quick / light)   → no `event:phase_advanced` target;
  //                                          `loaf deliver` owns the EXECUTE.done →
  //                                          DONE.delivered transition through verify-min,
  //                                          gated at preflight step 5c (Slice 1.D).
  if (prev === "EXECUTE.done") {
    const verifyPhase = ctx.ceremony.verify_phase;
    if (target === "VERIFY.plan" && !verifyPhase) {
      return {
        ok: false,
        code: "VERIFY_PHASE_FORK_VIOLATION",
        message:
          "EXECUTE.done → VERIFY.plan requires ceremony.verify_phase=true (standard / deep)",
        detail: { from: prev, to: target, verify_phase: verifyPhase },
      };
    }
  }

  // Slice 1.D — VERIFY.accept → SETTLE.reconcile fork (loaf settle command).
  //   ceremony.settle_phase=false → SETTLE_PHASE_DISABLED
  //   verify_accepted=false       → SETTLE_NOT_ACCEPTED (gate must approve first)
  //   DONE.delivered from VERIFY.accept is no longer an `event:phase_advanced`
  //   edge — `loaf deliver` owns that path with its own preflight ceremony /
  //   verify_accepted refines (preflight step 5c).
  if (prev === "VERIFY.accept" && target === "SETTLE.reconcile") {
    if (!ctx.ceremony.settle_phase) {
      return {
        ok: false,
        code: "SETTLE_PHASE_DISABLED",
        message:
          "VERIFY.accept → SETTLE.reconcile requires ceremony.settle_phase=true (deep only)",
        detail: { from: prev, to: target, settle_phase: ctx.ceremony.settle_phase },
      };
    }
    if (!ctx.verify_accepted) {
      return {
        ok: false,
        code: "SETTLE_NOT_ACCEPTED",
        message:
          "VERIFY.accept → SETTLE.reconcile requires verify_accepted=true (run `loaf gate decide verify-accept --approve` first)",
        detail: { from: prev, to: target, verify_accepted: !!ctx.verify_accepted },
      };
    }
  }

  return { ok: true };
}
