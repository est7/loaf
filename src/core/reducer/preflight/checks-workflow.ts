import {
  requireFindingSponsor,
  checkFindingRaise,
  planGatePending,
  checkPendingAdvance,
  checkPendingEscalation,
} from "../../intervention-policy.js";
import { evaluateTaskProof, verifyMinPolicy } from "../../gates/task-proof.js";
import type { Ceremony } from "../../journal-entry.js";
import type { PreflightCheckCtx, PreflightFailure } from "../preflight.js";
import { validateTransition } from "../transition.js";

export function checkGateDecided(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, sub_state, ctx } = c;
  if (entry.kind === "gate:decided") {
    const gateKind = entry.payload.gate_kind;
    if (gateKind === "spec-lock" && sub_state !== "SPEC.design") {
      return {
        ok: false,
        code: "SUB_STATE_AUTHORITY_VIOLATION",
        detail: { kind: entry.kind, gate_kind: gateKind, sub_state, expected: "SPEC.design" },
      };
    }
    if (gateKind === "verify-accept" && sub_state !== "VERIFY.accept") {
      return {
        ok: false,
        code: "SUB_STATE_AUTHORITY_VIOLATION",
        detail: { kind: entry.kind, gate_kind: gateKind, sub_state, expected: "VERIFY.accept" },
      };
    }
    // Slice 3 SC4: GATE_NOT_PENDING guard on approved gate decisions.
    // If a pending head exists with a non-gate kind, the user must
    // resolve that blocker before deciding the gate (the active prompt
    // could be asking a question that affects the decision itself).
    // gate_decision heads are soft-allowed (CLI co-emits pending:resolved
    // in the same batch); absent head also passes (no co-emission).
    // Rejected decisions bypass this guard — rejecting a gate is itself
    // an answer that does not require resolving a parallel pending.
    const pendingPlan = planGatePending(ctx.snapshot.pending, gateKind, entry.payload.decision);
    if (!pendingPlan.ok) return pendingPlan;
  }
  return null;
}

// (5b) Audit r1 fix: for event:phase_advanced, payload.from MUST match
// the current cursor. validateTransition only checks edge legality; cursor
// coherence is preflight's job. Without this gate a caller can pass any
// valid LEGAL_TRANSITIONS edge (e.g. EXECUTE.work → EXECUTE.done) even
// though the cursor sits at TRIAGE, and preflight returns ok.
export function checkPhaseAdvanced(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, sub_state, ctx } = c;
  if (entry.kind === "event:phase_advanced") {
    const payload = entry.payload;
    const from = payload.from;
    if (from !== sub_state) {
      return {
        ok: false,
        code: "FROM_CURSOR_MISMATCH",
        detail: { payload_from: from, current_sub_state: sub_state },
      };
    }
    // Slice 3 SC1: pending-head invariant. The first UNRESOLVED entry in the
    // FIFO queue is the head; entries with resolved=true remain in projection
    // (reducer history) but never count as the head. Two blocker kinds per
    // protocol §10.7 rev 4.1 Q3 minimal. This check sits between
    // FROM_CURSOR_MISMATCH and validateTransition so malformed cursors still
    // report FROM_CURSOR_MISMATCH first, but a blocking pending head stops
    // any advance before edge legality is evaluated.
    const pendingFailure = checkPendingAdvance(ctx.snapshot.pending);
    if (pendingFailure) return { ok: false, ...pendingFailure };

    // Slice B — back_edge sponsorship verifies against snapshot.findings
    // (codex r96 §3: open-only requirement, closed → FINDING_NOT_FOUND
    // with detail.reason="already_closed" mirroring finding:closed).
    // Runs before checkTransitionEdge because validateTransition's contract
    // is target+from legality; the finding-existence lookup needs the
    // snapshot which transition doesn't carry.
    const backEdge = payload.back_edge;
    if (backEdge !== undefined) {
      const sponsor = requireFindingSponsor(
        ctx.snapshot.findings,
        backEdge.finding_id,
        backEdge.action,
      );
      if (!sponsor.ok) return sponsor;
    }

    // (5b.2) Session 7 / F-016 — EXECUTE.done = all tasks final.
    // protocol.md §10.5 / §2 define EXECUTE.done as "all tasks reached a
    // final status". Without this refine a pending / ready / in_progress
    // task slips past the EXECUTE.work → EXECUTE.done boundary unenforced
    // (verify-accept check 4 only scans done tasks). Applies to the plain
    // forward edge only: a back_edge entry keeps its own sponsorship /
    // transition diagnostics (codex r123 constraint #1) — back_edge
    // targets SPEC.spec, never EXECUTE.done, but the gate is explicit.
    const phaseTo = payload.to;
    if (backEdge === undefined && sub_state === "EXECUTE.work" && phaseTo === "EXECUTE.done") {
      const nonFinal = ctx.snapshot.tasks
        .filter((t) => t.status !== "done" && t.status !== "abandoned")
        .map((t) => ({ task_id: t.id, status: t.status }));
      if (nonFinal.length > 0) {
        return {
          ok: false,
          code: "EXECUTE_DONE_TASKS_NOT_FINAL",
          detail: { non_final: nonFinal, count: nonFinal.length },
        };
      }
    }
  }
  return null;
}

// (5c) Slice 1.D — `loaf deliver` preflight refines.
//
// `session:delivered` is the only kind that flips the cursor to
// DONE.delivered (reducer.ts:706-712 applies it directly, not via
// `event:phase_advanced`). So validateTransition does NOT gate this kind
// — instead, preflight enforces the ceremony / verify_accepted / spike-
// tasks preconditions of `loaf deliver` here.
//
// Spike-tasks block (protocol §703 / §1298): any non-abandoned spike task
// blocks delivery for the entire session, regardless of source sub_state.
// Done spikes still block per literal protocol wording ("spike 永远不允许
// loaf deliver"); abandoned spikes are ignored only because abandoned
// tasks have no remaining lifecycle obligation.
export function checkSessionDelivered(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, sub_state, ceremony, verify_accepted, ctx } = c;
  if (entry.kind === "session:delivered") {
    const activeSpike = ctx.snapshot.tasks.find(
      (t) => t.kind === "spike" && t.status !== "abandoned",
    );
    if (activeSpike) {
      return {
        ok: false,
        code: "DELIVER_SPIKE_TASKS",
        detail: { task_id: activeSpike.id, status: activeSpike.status },
      };
    }
    if (sub_state === "EXECUTE.done") {
      // EXECUTE.done deliver is DEFINITIONALLY the quick/light path
      // (§10.8 deliver row: verify_phase=false delivers from EXECUTE.done;
      // standard delivers from VERIFY.accept, deep from SETTLE.lessons).
      // A verify_phase=true (standard/deep) session attempting deliver here
      // has not completed VERIFY → not verify-accepted. (impl-surfaced
      // edge: the v0.1.0 stub lump-rejected ALL EXECUTE.done delivers; with
      // verify-min now quick/light-specific, standard/deep needs its own
      // rejection — DELIVER_NOT_ACCEPTED fits the "haven't been accepted
      // yet" semantics.)
      if (ceremony.verify_phase) {
        return {
          ok: false,
          code: "DELIVER_NOT_ACCEPTED",
          detail: { sub_state, ceremony_label: deriveCeremonyLabel(ceremony), verify_phase: true },
        };
      }
      // verify-min (protocol §3.2) — quick / light deliver gate (v0.1.1;
      // replaces the v0.1.0 DELIVER_VERIFY_MIN_UNAVAILABLE fail-closed stub).
      // Per `status=done` task, require the per-kind evidence covering it
      // (codex v0.1.1 Q2 lock): code-touching tasks need `local-check`
      // build/test proof — `task-summary` alone does NOT satisfy (that would
      // weaken to verify-accept check 4). The evidence result must be positive,
      // matching verify-accept (`passed` / `approved` / `waived`); `waiver`
      // satisfies only as a positive human escape. Evidence must cover the task
      // (`covers` includes task.id); session-wide evidence never satisfies an
      // unrelated task. spike tasks are hard-blocked above (DELIVER_SPIKE_TASKS)
      // so never reach here.
      // Shared proof kernel (L6) under the kind-PER-task verify-min policy.
      // bug-RED short-circuits before evidence with its own dedicated code,
      // mirroring the pre-extraction loop's early return on the FIRST bug-RED
      // done task in snapshot order; missing-evidence is assembled only when no
      // bug-RED gap exists. required_kinds is the waiver-free policy list (waiver
      // is an evaluator-owned universal escape, never reported as "needs").
      const proofGaps = evaluateTaskProof(ctx.snapshot, verifyMinPolicy);
      const redGap = proofGaps.find((f) => f.gaps.includes("bug-red-unregistered"));
      if (redGap) {
        return {
          ok: false,
          code: "BUG_TASK_RED_NOT_REGISTERED",
          detail: { task_id: redGap.task.id },
        };
      }
      const missing = proofGaps
        .filter((f) => f.gaps.includes("no-passing-evidence"))
        .map((f) => ({
          task_id: f.task.id,
          kind: f.task.kind,
          required_kinds: verifyMinPolicy.acceptedKinds(f.task),
        }));
      if (missing.length > 0) {
        return {
          ok: false,
          code: "DELIVER_VERIFY_MIN_INCOMPLETE",
          detail: {
            sub_state,
            ceremony_label: deriveCeremonyLabel(ceremony),
            count: missing.length,
            tasks: missing,
          },
        };
      }
      // verify-min passed — fall through; session:delivered proceeds.
    }
    if (sub_state === "VERIFY.accept") {
      if (ceremony.settle_phase) {
        return {
          ok: false,
          code: "DELIVER_SETTLE_PHASE_BYPASS",
          detail: { sub_state, settle_phase: ceremony.settle_phase },
        };
      }
      if (!verify_accepted) {
        return {
          ok: false,
          code: "DELIVER_NOT_ACCEPTED",
          detail: { sub_state, verify_accepted },
        };
      }
    }
    if (sub_state === "SETTLE.lessons") {
      if (!verify_accepted) {
        // Should be unreachable via legal transitions (gate must have
        // approved to traverse VERIFY.accept → SETTLE.*) but defensive
        // here in case a journal was rebuilt or `loaf advance` was misused.
        return {
          ok: false,
          code: "DELIVER_NOT_ACCEPTED",
          detail: { sub_state, verify_accepted },
        };
      }
    }
  }
  return null;
}

// (5c.3) Phase 12 — `loaf spike convert` precondition.
//
// `spike:converted` is a record-only audit entry; the sponsored
// `session:archived` in the same batch owns the terminal cursor flip.
// `loaf spike convert` is specifically a spike-task exit (protocol §8.3),
// so the session must hold at least one non-abandoned kind=spike task.
// Otherwise a non-spike session could emit a spike:converted entry and
// archive itself, making the journal misrepresent the session. Done
// spikes count; abandoned spikes do not (mirrors DELIVER_SPIKE_TASKS).
export function checkSpikeConverted(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, ctx } = c;
  if (entry.kind === "spike:converted") {
    const hasActiveSpike = ctx.snapshot.tasks.some(
      (t) => t.kind === "spike" && t.status !== "abandoned",
    );
    if (!hasActiveSpike) {
      return {
        ok: false,
        code: "SPIKE_CONVERT_NO_SPIKE_TASK",
        detail: {},
      };
    }
  }
  return null;
}

// (5c.4) Phase 13 — `loaf profile escalate` authorization for a non-TRIAGE
// `event:ceremony_set`.
//
// `event:ceremony_set` is freely legal at TRIAGE (the initial ceremony
// pick). Outside TRIAGE it is legal ONLY as the resolution of a
// profile_escalation pending — `loaf profile escalate` emits it as the
// FIRST entry of a [event:ceremony_set, pending:resolved] batch, so this
// guard still sees the unresolved head before pending:resolved pops it.
// detail.actual_head feeds the ERROR_CATALOG {actual_head} placeholder.
export function checkCeremonySet(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, sub_state, ctx } = c;
  if (entry.kind === "event:ceremony_set") {
    const pendingFailure = checkPendingEscalation(ctx.snapshot.pending, sub_state);
    if (pendingFailure) return { ok: false, ...pendingFailure };
  }
  return null;
}

// (5c.2) Item 2 — `loaf archive` / `loaf abandon` reason-required refine.
//
// `session:archived` / `session:abandoned` carry their own cursor
// authority (reducer flips directly to DONE.archived / DONE.abandoned,
// not via `event:phase_advanced`). Both share `SessionReasonPayload`
// with `session:delivered`, where `reason` is OPTIONAL — deliver
// legitimately allows no rationale. archive / abandon tighten it to
// required (protocol §10.8: "reason required"). An empty-string reason
// is rejected upstream by the PER_KIND_PAYLOAD parse (`z.string().min(1)`)
// as INVALID_PAYLOAD; this refine handles only the absent case (no
// whitespace-trimming — that would be stricter than the repo's
// `z.string().min(1)` convention).
export function checkSessionTerminalReason(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry } = c;
  if (entry.kind === "session:archived" || entry.kind === "session:abandoned") {
    const payload = entry.payload;
    if (payload.reason === undefined) {
      return {
        ok: false,
        code: "SESSION_REASON_REQUIRED",
        detail: { kind: entry.kind },
      };
    }
  }
  return null;
}

// (5d.1) Slice 2 SC4 — DUPLICATE_TASK_ID for event:tasks_planned (codex
// r59 P2.1 closure). Promoted from reducer-side invalidPayload (which
// mutate's Pass 1 wraps as REDUCER_ERROR) to top-level preflight so the
// user-facing CLI surface returns the actionable diagnostic directly.
// Reducer keeps its defensive duplicate-id sweep as fallback for raw
// mutate paths that bypass preflight.

export function checkFindingRaised(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, sub_state, ctx } = c;
  if (entry.kind === "finding:raised") {
    return checkFindingRaise(entry.payload, ctx.snapshot, sub_state);
  }
  return null;
}

// (5i) Slice 4 SC3 — SPEC content phase gating (rev 4.3 ADR-0004 A4 /
// protocol §10.8). Two guards on the 4 SPEC content kinds:
//   - SPEC_LOCKED_NO_DIRECT_EDIT (fires first): state.spec_locked
//     === true blocks ALL spec content kinds including spec_submitted
//     (whole-replacement). Defensive — production cannot reach
//     spec_locked=true with sub_state ∈ ALL_SPEC under the normal
//     gate-decide spec-lock approve path (the cursor advance moves
//     out of ALL_SPEC). amend-spec back-edge resets spec_locked to
//     false before re-entering SPEC.spec, so this check protects
//     against raw mutate / hand-edited journal scenarios.
//   - SPEC_NOT_INITIALIZED: state.spec_version === 0 blocks the 3
//     add-* kinds (spec_req_added / spec_scenario_added /
//     spec_visual_added). event:spec_submitted is the init step and
//     is exempt. Catches the natural "user typed `spec add-req` at
//     SPEC.proposal before running spec submit" mistake.

export function checkTransitionEdge(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, ceremony, verify_accepted, spec_locked } = c;
  if (entry.kind !== "event:phase_advanced") return null;
  const { from, to, back_edge } = entry.payload;
  const transitionResult = validateTransition(from, to, {
    ceremony,
    verify_accepted,
    spec_locked,
    actor: entry.actor,
    ...(back_edge !== undefined ? { back_edge } : {}),
  });
  if (!transitionResult.ok) {
    return transitionResult;
  }
  return null;
}

// Cosmetic ceremony label for error detail. Not authoritative — full label
// derivation lives in cli.tsx PRESETS map. Used only for diagnostic hint
// rendering when the relevant fields disagree with the expected profile.
function deriveCeremonyLabel(c: Ceremony): string {
  if (!c.spec_phase && !c.verify_phase) return "quick";
  if (c.spec_phase && !c.verify_phase) return "light";
  if (c.spec_phase && c.verify_phase && !c.settle_phase) return "standard";
  if (c.spec_phase && c.verify_phase && c.settle_phase) return "deep";
  return "custom";
}
