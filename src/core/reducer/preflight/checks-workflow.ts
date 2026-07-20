import { diagnostic } from "../../error-catalog.js";
import {
  FINDING_ACTION_TARGET_MODE,
  FINDING_UNUSUAL_REASON_MIN_LENGTH,
  FIX_ACTION_STEP,
  cellRisk,
  type FindingAction,
  type FindingCategory,
} from "../../finding-schema.js";
import { evaluateTaskProof, verifyMinPolicy } from "../../gates/task-proof.js";
import type { Ceremony, EntryKind, SubState } from "../../journal-entry.js";
import type { PreflightCheckCtx, PreflightFailure } from "../preflight.js";
import {
  validateTransition,
  type TransitionContext,
  type TransitionResult,
} from "../transition.js";

export function checkGateDecided(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, payloadData, sub_state, ctx } = c;
  if (entry.kind === "gate:decided") {
    const gateKind = (payloadData as { gate_kind?: string }).gate_kind;
    if (gateKind === "spec-lock" && sub_state !== "SPEC.design") {
      return {
        ok: false,
        code: "SUB_STATE_AUTHORITY_VIOLATION",
        message: `gate:decided gate_kind=spec-lock requires sub_state=SPEC.design (got ${sub_state})`,
        detail: { gate_kind: gateKind, sub_state, expected: "SPEC.design" },
      };
    }
    if (gateKind === "verify-accept" && sub_state !== "VERIFY.accept") {
      return {
        ok: false,
        code: "SUB_STATE_AUTHORITY_VIOLATION",
        message: `gate:decided gate_kind=verify-accept requires sub_state=VERIFY.accept (got ${sub_state})`,
        detail: { gate_kind: gateKind, sub_state, expected: "VERIFY.accept" },
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
    const decision = (payloadData as { decision?: string }).decision;
    if (decision === "approved") {
      const pendingHead = ctx.snapshot.pending.find((p) => !p.resolved);
      if (pendingHead && pendingHead.kind !== "gate_decision") {
        return {
          ok: false,
          ...diagnostic("GATE_NOT_PENDING", {
            gate_kind: gateKind,
            head_id: pendingHead.id,
            head_kind: pendingHead.kind,
          }),
          message:
            `gate:decided ${gateKind} approve blocked: pending head ${pendingHead.id} ` +
            `(kind=${pendingHead.kind}) is not a gate_decision prompt; resolve it first`,
        };
      }
    }
  }
  return null;
}

// (5b) Audit r1 fix: for event:phase_advanced, payload.from MUST match
// the current cursor. validateTransition only checks edge legality; cursor
// coherence is preflight's job. Without this gate a caller can pass any
// valid LEGAL_TRANSITIONS edge (e.g. EXECUTE.work → EXECUTE.done) even
// though the cursor sits at TRIAGE, and preflight returns ok.
export function checkPhaseAdvanced(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, rawEntry, sub_state, ctx } = c;
  if (entry.kind === "event:phase_advanced") {
    const payload = (rawEntry as { payload?: Record<string, unknown> }).payload ?? {};
    const from = payload["from"] as SubState | undefined;
    if (from !== undefined && from !== sub_state) {
      return {
        ok: false,
        code: "FROM_CURSOR_MISMATCH",
        message: `event:phase_advanced payload.from=${from} but current sub_state=${sub_state}`,
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
    const head = ctx.snapshot.pending.find((p) => !p.resolved);
    if (head && (head.kind === "gate_decision" || head.kind === "profile_escalation")) {
      return {
        ok: false,
        code: "PENDING_BLOCKS_ADVANCE",
        message: `pending head ${head.id} (kind=${head.kind}) blocks \`loaf advance\` until resolved`,
        detail: { pending_id: head.id, kind: head.kind },
      };
    }

    // Slice B — back_edge sponsorship verifies against snapshot.findings
    // (codex r96 §3: open-only requirement, closed → FINDING_NOT_FOUND
    // with detail.reason="already_closed" mirroring finding:closed).
    // Runs before checkTransition because validateTransition's contract
    // is target+from legality; the finding-existence lookup needs the
    // snapshot which transition doesn't carry.
    const rawPayload = ((rawEntry as { payload?: Record<string, unknown> }).payload ??
      {}) as Record<string, unknown>;
    const backEdge = rawPayload["back_edge"] as
      | { action?: string; finding_id?: string }
      | undefined;
    if (backEdge !== undefined && typeof backEdge.finding_id === "string") {
      const findingId = backEdge.finding_id;
      const finding = ctx.snapshot.findings.find((f) => f.id === findingId);
      if (!finding) {
        return {
          ok: false,
          code: "FINDING_NOT_FOUND",
          message: `event:phase_advanced.back_edge.finding_id=${findingId} not found in projection`,
          detail: { id: findingId, reason: "not_found" },
        };
      }
      if (finding.status === "closed") {
        return {
          ok: false,
          code: "FINDING_NOT_FOUND",
          message: `event:phase_advanced.back_edge.finding_id=${findingId} is already_closed; only open findings can sponsor back-edges`,
          detail: { id: findingId, reason: "already_closed" },
        };
      }
      if (finding.action !== backEdge.action) {
        return {
          ok: false,
          code: "FINDING_NOT_FOUND",
          message: `event:phase_advanced.back_edge.action=${backEdge.action} but finding ${findingId} has action=${finding.action}`,
          detail: {
            id: findingId,
            reason: "action_mismatch",
            expected_action: backEdge.action,
            actual_action: finding.action,
          },
        };
      }
    }

    // (5b.2) Session 7 / F-016 — EXECUTE.done = all tasks final.
    // protocol.md §10.5 / §2 define EXECUTE.done as "all tasks reached a
    // final status". Without this refine a pending / ready / in_progress
    // task slips past the EXECUTE.work → EXECUTE.done boundary unenforced
    // (verify-accept check 4 only scans done tasks). Applies to the plain
    // forward edge only: a back_edge entry keeps its own sponsorship /
    // transition diagnostics (codex r123 constraint #1) — back_edge
    // targets SPEC.spec, never EXECUTE.done, but the gate is explicit.
    const phaseTo = payload["to"] as SubState | undefined;
    if (backEdge === undefined && sub_state === "EXECUTE.work" && phaseTo === "EXECUTE.done") {
      const nonFinal = ctx.snapshot.tasks
        .filter((t) => t.status !== "done" && t.status !== "abandoned")
        .map((t) => ({ task_id: t.id, status: t.status }));
      if (nonFinal.length > 0) {
        return {
          ok: false,
          code: "EXECUTE_DONE_TASKS_NOT_FINAL",
          message:
            `cannot advance EXECUTE.work → EXECUTE.done: ${nonFinal.length} task(s) ` +
            `are not in a final status (` +
            nonFinal.map((t) => `${t.task_id}=${t.status}`).join(", ") +
            `); every task must be done or abandoned`,
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
        message: `cannot deliver: task ${activeSpike.id} is kind=spike (status=${activeSpike.status}); spike tasks must be abandoned or converted before delivery (protocol §703 / §1298)`,
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
          message:
            "cannot deliver from EXECUTE.done: verify_phase=true (standard/deep) must complete VERIFY and deliver from VERIFY.accept; EXECUTE.done deliver is the quick/light verify-min path",
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
          message: `behavioral bug task ${redGap.task.id} is status=done but never registered its RED test (red_test_registered≠true); cannot verify-min deliver`,
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
          message:
            `verify-min: ${missing.length} done task(s) lack the required evidence to deliver ` +
            `(${missing.map((m) => `${m.task_id} needs ${m.required_kinds.join("/")}`).join("; ")}). ` +
            `Add evidence (e.g. \`loaf evidence add\`) or waive, then re-deliver`,
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
          message:
            "deliver from VERIFY.accept requires ceremony.settle_phase=false (standard); deep ceremony must run `loaf settle` first",
          detail: { sub_state, settle_phase: ceremony.settle_phase },
        };
      }
      if (!verify_accepted) {
        return {
          ok: false,
          code: "DELIVER_NOT_ACCEPTED",
          message:
            "deliver requires verify_accepted=true; run `loaf gate decide verify-accept --approve` first",
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
          message:
            "deliver from SETTLE.lessons requires verify_accepted=true (gate approval missing — journal may be inconsistent)",
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
        message:
          "cannot convert: the session has no non-abandoned spike task; `loaf spike convert` is a spike-task exit (protocol §8.3)",
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
    const isTriage = sub_state === "TRIAGE.score" || sub_state === "TRIAGE.confirm";
    if (!isTriage) {
      const head = ctx.snapshot.pending.find((p) => !p.resolved);
      if (!head || head.kind !== "profile_escalation") {
        const actualHead = head ? head.kind : "(none)";
        return {
          ok: false,
          code: "ESCALATION_NOT_PENDING",
          message:
            "`loaf profile escalate --confirm --input <ceremony.json>` requires pending head " +
            `kind=profile_escalation; current head: ${actualHead}`,
          detail: { actual_head: actualHead },
        };
      }
    }
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
  const { entry, rawEntry } = c;
  if (entry.kind === "session:archived" || entry.kind === "session:abandoned") {
    const payload = (rawEntry as { payload?: Record<string, unknown> }).payload ?? {};
    if (payload["reason"] === undefined) {
      return {
        ok: false,
        code: "SESSION_REASON_REQUIRED",
        message: `${entry.kind}: --reason is required (the session-terminal entry must record why)`,
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
  const { entry, payloadData, sub_state, ctx } = c;
  if (entry.kind === "finding:raised") {
    const payload = payloadData as {
      category: FindingCategory;
      action: FindingAction;
      reason?: string;
      target?: { task_id: string; step: string };
    };
    const risk = cellRisk(payload.category, payload.action);
    if (risk === "incoherent") {
      return {
        ok: false,
        code: "FINDING_ACTION_INCOHERENT",
        message:
          `finding raise category=${payload.category} × action=${payload.action} is structurally incoherent ` +
          `(no task target a transition can land on); amend-spec first to add target before fix-impl/fix-test`,
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
          message:
            `finding raise category=${payload.category} × action=${payload.action} is an unusual cell; ` +
            `--reason ≥${FINDING_UNUSUAL_REASON_MIN_LENGTH} chars required (got ${reasonLength})`,
        };
      }
    }
    const mode = FINDING_ACTION_TARGET_MODE[payload.action];
    if (mode === "task_id_step") {
      if (!payload.target) {
        return {
          ok: false,
          code: "FINDING_TARGET_REQUIRED",
          message: `finding raise action=${payload.action} requires --target-task + --target-step`,
          detail: { action: payload.action, reason: "missing" },
        };
      }
      const expectedStep = FIX_ACTION_STEP[payload.action];
      if (expectedStep && payload.target.step !== expectedStep) {
        return {
          ok: false,
          code: "FINDING_TARGET_REQUIRED",
          message:
            `finding raise action=${payload.action} requires step="${expectedStep}" ` +
            `(got step="${payload.target.step}")`,
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
        message:
          `finding raise action=${payload.action} does not accept a target ` +
          `(target_payload="none"); drop --target-task / --target-step`,
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
        const task = ctx.snapshot.tasks.find((t) => t.id === payload.target!.task_id);
        if (!task) {
          return {
            ok: false,
            code: "FINDING_TARGET_REQUIRED",
            message: `finding raise target.task_id=${payload.target.task_id} not found in projection`,
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
            message:
              `finding raise target.step=${payload.target.step} not in task ${payload.target.task_id} ` +
              `(kind=${task.kind}) steps`,
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
    if (payload.action === "amend-spec" && !ctx.snapshot.state?.spec_locked) {
      return {
        ok: false,
        code: "FINDING_AMEND_SPEC_NOT_LOCKED",
        message: `finding raise action=amend-spec requires state.spec_locked=true; spec is not locked at sub_state=${sub_state}, edit directly via 'loaf spec submit / add-*'`,
        detail: {
          current_spec_locked: false,
          current_sub_state: sub_state,
          hint: "use loaf spec submit / add-* directly to edit spec when not locked",
        },
      };
    }
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
  const { entry, rawEntry, sub_state, ceremony, verify_accepted, spec_locked } = c;
  const transitionResult = checkTransition(entry.kind, rawEntry as Record<string, unknown>, {
    sub_state,
    ceremony,
    verify_accepted,
    spec_locked,
    actor: entry.actor,
  });
  if (transitionResult && !transitionResult.ok) {
    return {
      ok: false,
      code: transitionResult.code,
      message: transitionResult.message,
      detail: transitionResult.detail ?? {},
    };
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

/** Derived scalars passed into the transition probe — not a public type. */
interface TransitionProbeContext {
  sub_state: SubState;
  ceremony: Ceremony;
  verify_accepted: boolean;
  spec_locked: boolean;
  actor: string;
}

/**
 * For state-machine-edge kinds, extract (from, to) from payload and run
 * validateTransition. Returns null for kinds that don't carry an edge.
 */
function checkTransition(
  kind: EntryKind,
  raw: Record<string, unknown>,
  ctx: TransitionProbeContext,
): TransitionResult | null {
  const payload = (raw["payload"] as Record<string, unknown> | undefined) ?? {};

  if (kind === "event:phase_advanced") {
    // payload: { from: SubState, to: SubState, back_edge?: BackEdge }
    const from = payload["from"] as SubState | undefined;
    const to = payload["to"] as SubState | undefined;
    if (from === undefined || to === undefined) return null; // schema already rejected upstream
    // Slice B / Phase 11 Item 3 SC1-SC3: extract back_edge sponsorship from
    // payload so validateTransition can enforce action→target/from contract.
    // The finding_id existence check happens at the outer preflight path
    // (needs snapshot.findings, not visible here). The cast is the full
    // 4-arm BackEdge union (amend-spec | amend-tasks | fix-impl | fix-test) —
    // SC1 added the amend-tasks arm, SC2 the fix-impl arm, SC3 the fix-test
    // arm; the runtime object already passes through to validateTransition's
    // union, this only realigns the annotation.
    const backEdge = payload["back_edge"] as TransitionContext["back_edge"];
    return validateTransition(from, to, {
      ceremony: ctx.ceremony,
      actor: ctx.actor,
      verify_accepted: ctx.verify_accepted,
      spec_locked: ctx.spec_locked,
      ...(backEdge !== undefined ? { back_edge: backEdge } : {}),
    });
  }

  // Slice 1.A normalization: gate:decided no longer drives transitions —
  // its gate_kind ↔ source sub_state pairing is enforced at step 5a in the
  // main preflight() before transition check, not here. This branch stays
  // as a null return so `checkTransition` short-circuits cleanly.
  if (kind === "gate:decided") return null;

  return null;
}
