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

import type { Ceremony, GateName, SubState } from "../journal-entry.js";

// Forward edges of the state-machine graph. Empty = terminal. Back-edges
// (finding amend-spec / amend-tasks / fix-impl / fix-test) are NOT here;
// they travel as separate event kinds with their own apply paths.
//
// Slice 1.D: removed 3 `→ DONE.delivered` edges (VERIFY.accept, EXECUTE.done,
// SETTLE.lessons). DONE.delivered is reached exclusively via `session:delivered`
// (reducer direct cursor flip) — `loaf deliver`'s territory. `loaf advance
// DONE.delivered` from any sub_state now returns TRANSITION_ILLEGAL.
//
// Item 2: removed the 2 `SETTLE.lessons → DONE.archived/abandoned` edges
// and dropped both terminals from ALWAYS_LEGAL_TARGETS. DONE.archived /
// DONE.abandoned are now reached exclusively via `session:archived` /
// `session:abandoned` (reducer direct cursor flip) — `loaf archive` /
// `loaf abandon`'s territory, which carry the required `reason`. `loaf
// advance DONE.archived` / `loaf advance DONE.abandoned` from any
// sub_state now return TRANSITION_ILLEGAL. SETTLE.lessons is therefore a
// terminal of the `event:phase_advanced` graph.
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
  "SETTLE.lessons": [], // Item 2: DONE.archived/abandoned now via `loaf archive` / `loaf abandon`
  "DONE.delivered": [],
  "DONE.archived": [],
  "DONE.abandoned": [],
};

// Back-edge actions (Phase 11 Item 3). Only `amend-spec` is wired at
// SC0; `amend-tasks` / `fix-impl` / `fix-test` rows land in SC1-SC3.
type BackEdgeAction = "amend-spec";

// Per-action back-edge from-state table (Phase 11 Item 3 SC0). Reshaped
// from the single `BACK_EDGE_AMEND_SPEC_FROM` constant so SC1-SC3 add a
// row each instead of a parallel constant each.
//
// The `amend-spec` row covers every sub_state where state.spec_locked
// can legally be true after `gate decide spec-lock --approve` (which
// fires at SPEC.design and flips the lock). SETTLE.* deliberately
// excluded: finding:raised is not authorized at SETTLE per
// PER_KIND_SUB_STATE, so the lookup never happens at SETTLE; widening
// this set without widening finding authority would be misleading
// (codex r94 Finding 2 ack).
const BACK_EDGE_FROM: Record<BackEdgeAction, ReadonlySet<SubState>> = {
  "amend-spec": new Set([
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
};

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
   * Slice B: back-edge sponsorship extracted from
   * `event:phase_advanced.payload.back_edge`. When set, validateTransition
   * enforces the action's target+from contract and bypasses forward-edge
   * legality. Caller (preflight) is also responsible for verifying the
   * referenced finding exists in `snapshot.findings` with matching
   * action and status="open" — that check needs snapshot which transition
   * doesn't carry.
   */
  back_edge?: { action: "amend-spec"; finding_id: string };
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
  // Slice B back-edge sponsorship — enforces the action→target contract
  // before the forward-edge legality check below. A malformed payload
  // like `{back_edge:{action:"amend-spec"}, to:"SPEC.spec"}` from a
  // disallowed `from` state is still rejected here.
  if (ctx.back_edge !== undefined) {
    if (ctx.back_edge.action === "amend-spec") {
      if (target !== "SPEC.spec") {
        return {
          ok: false,
          code: "TRANSITION_ILLEGAL",
          message: `back_edge action=amend-spec requires target=SPEC.spec, got ${target}`,
          detail: {
            from: prev,
            to: target,
            back_edge_action: ctx.back_edge.action,
            expected_target: "SPEC.spec",
            reason: "back_edge_target_mismatch",
          },
        };
      }
      const allowedFrom = BACK_EDGE_FROM["amend-spec"];
      if (!allowedFrom.has(prev)) {
        return {
          ok: false,
          code: "TRANSITION_ILLEGAL",
          message: `back_edge action=amend-spec is not legal from ${prev}; allowed from EXECUTE.* + VERIFY.*`,
          detail: {
            from: prev,
            to: target,
            back_edge_action: ctx.back_edge.action,
            allowed_from: [...allowedFrom],
            reason: "back_edge_from_not_allowed",
          },
        };
      }
      // Back-edge legal at the transition layer; preflight verifies the
      // referenced finding_id against snapshot.findings (existence +
      // action match + status=open).
      return { ok: true };
    }
    // Future back_edge variants land here additively. The
    // discriminatedUnion in journal-entry.ts catches unknown actions
    // at payload parse time, so this branch is defensive.
    return {
      ok: false,
      code: "TRANSITION_ILLEGAL",
      message: `unknown back_edge.action ${(ctx.back_edge as { action: string }).action}`,
      detail: { back_edge: ctx.back_edge, reason: "back_edge_action_unknown" },
    };
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
