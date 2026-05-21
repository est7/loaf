// Preflight validation (§11.2 step 3 + ADR-0005 §3.6).
//
// Four-stage gate before journal append:
//   1. Envelope schema parse (Zod) — already enforced by journal-append.ts;
//      preflight repeats for batch entries that haven't hit append yet.
//   2. Monotonic seq vs tail.
//   3. Per-kind sub_state authority (PER_KIND_SUB_STATE table).
//   4. Per-kind actor authority   (PER_KIND_ACTOR table).
//
// Step 3 (the transition itself) is delegated to validateTransition for
// `event:phase_advanced` (the only kind whose payload encodes a state-
// machine edge after Slice 1.A normalization). `gate:decided` no longer
// drives transitions — it only records an approval flag; cursor movement
// rides on a separate `event:phase_advanced` in the same batch. Its
// gate_kind ↔ source sub_state pairing (spec-lock @ SPEC.design only,
// verify-accept @ VERIFY.accept only) is enforced as preflight step 5a
// before transition check, after payload schema parse.
//
// Slice 1.D — step 5c: `session:delivered` carries cursor authority of its
// own (its reducer directly flips to DONE.delivered without going through
// `event:phase_advanced`). So preflight gates the ceremony + verify_accepted
// + spike-tasks preconditions of `loaf deliver` HERE — `loaf deliver` does
// not get a transition validator pass.
//
// Per-kind extra refines (`tasks_planned.based_on.spec` parity etc.) are NOT
// preflight's job; they sit in the reducer apply path. Preflight is purely
// authority + structural gates.
//
// Slice 1.D — context refactor: PreflightContext now carries the full
// snapshot (single source per codex r50/r51). sub_state, ceremony, and
// verify_accepted derive from `snapshot.state` with TRIAGE.score / default
// ceremony / verify_accepted=false fallbacks when state is null (pre-
// session entries). `tasks` flows for the spike-block check at step 5c.

import { JournalEntry, PER_KIND_PAYLOAD } from "../journal-entry.js";
import type { Ceremony, EntryKind, SubState } from "../journal-entry.js";
import type { Snapshot, TaskState } from "../reducer.js";
import { extractTaskSlim, type TaskFullProjection } from "../task-schema.js";
import {
  validateTransition,
  type TransitionContext,
  type TransitionResult,
} from "./transition.js";
import { isActorAllowed, isSubStateAllowed } from "./per-kind.js";
import {
  FINDING_ACTION_TARGET_MODE,
  FINDING_UNUSUAL_REASON_MIN_LENGTH,
  FIX_ACTION_STEP,
  cellRisk,
  type FindingAction,
  type FindingCategory,
} from "../finding-schema.js";

// Defaults applied when snapshot.state is null (no session:started yet).
// Mirrors the bootstrap behavior that journal-mutate.ts previously injected
// into PreflightContext explicitly.
const DEFAULT_SUB_STATE: SubState = "TRIAGE.score";
const DEFAULT_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

export interface PreflightContext {
  /**
   * Snapshot at the point this entry is being validated — for batches this
   * is the accumulator after preceding entries have applied (single source
   * per codex r50 non-blocking #1 + r51). state may be null for bootstrap
   * kinds (`session:started`, `migration:snapshot_imported`); in that case
   * sub_state defaults to TRIAGE.score and ceremony to the standard preset.
   */
  snapshot: Snapshot;
  /** Last seq in the journal; -1 if the journal is empty/absent. */
  tail_seq: number;
}

export type PreflightFailureCode =
  | "INVALID_ENVELOPE"
  | "INVALID_PAYLOAD"
  | "SEQ_NOT_MONOTONIC"
  | "SUB_STATE_AUTHORITY_VIOLATION"
  | "ACTOR_AUTHORITY_VIOLATION"
  | "FROM_CURSOR_MISMATCH"
  | "TRANSITION_ILLEGAL"
  | "SETTLE_PHASE_DISABLED"
  | "SETTLE_NOT_ACCEPTED"
  | "SPEC_PHASE_FORK_VIOLATION"
  | "VERIFY_PHASE_FORK_VIOLATION"
  // Slice 1.D — `loaf deliver` preflight refines (step 5c).
  | "DELIVER_NOT_ACCEPTED"
  | "DELIVER_SETTLE_PHASE_BYPASS"
  | "DELIVER_VERIFY_MIN_UNAVAILABLE"
  | "DELIVER_SPIKE_TASKS"
  // Slice 2 SC1 — task lifecycle preflight refines (step 5e). TASK_NOT_FOUND
  // is reused (already in DiagnosticCode for the reducer-side path) so no
  // new union member here for that code.
  | "TASK_NOT_FOUND"
  | "TASK_NOT_CLAIMABLE"
  | "TASK_ALREADY_CLAIMED"
  | "TASK_DEPS_NOT_SATISFIED"
  | "TASK_NOT_CLAIMED"
  // Slice 2 SC4 (codex r59 P2.1) — DUPLICATE_TASK_ID promoted from reducer
  // to preflight so the user-facing CLI surface returns the actionable
  // diagnostic directly instead of REDUCER_ERROR wrapping. Reducer keeps
  // its defensive check as fallback.
  | "DUPLICATE_TASK_ID"
  // Slice 3 SC1 — pending head invariant (protocol §10.7 rev 4.1 Q3
  // minimal). Pending kinds {gate_decision, profile_escalation} block
  // event:phase_advanced; other kinds in the queue do not. GATE_NOT_PENDING
  // / ESCALATION_NOT_PENDING and the gate-decide pending:resolved
  // co-emission are deferred to SC4 (codex r62/r63 sign-off).
  | "PENDING_BLOCKS_ADVANCE"
  // Session 7 / F-016 — the EXECUTE.work → EXECUTE.done edge requires
  // every task to be in a final status (done | abandoned). protocol.md
  // defines EXECUTE.done as "all tasks reached final status"; without
  // this refine a pending / in_progress task slipped past the phase
  // boundary unenforced (verify-accept check 4 only scans done tasks).
  | "EXECUTE_DONE_TASKS_NOT_FINAL"
  // Slice 3 SC3 — FINDING_ACTION_GRID + target_payload preflight
  // (protocol §4.5 / docs/schemas.ts §37 / codex r68 sign-off).
  // INCOHERENT: 4 grid cells where structure offers no transition
  // target (spec-gap × {fix-impl,fix-test}, new-scope × same).
  // UNUSUAL_REASON_REQUIRED: unusual cells require --reason ≥20 chars.
  // TARGET_REQUIRED: fix-impl/fix-test must specify {task_id, step}
  // with step=action's canonical step + task in projection + step in
  // task.steps; amend-tasks accepts absence but validates if present.
  | "FINDING_ACTION_INCOHERENT"
  | "FINDING_ACTION_UNUSUAL_REASON_REQUIRED"
  | "FINDING_TARGET_REQUIRED"
  // Slice 3 SC4 — pending-head guard for gate:decided.
  // GATE_NOT_PENDING fires when the unresolved pending head is a
  // non-gate kind (ask_user_question / spec_clarification /
  // finding_decision / profile_escalation): the user must resolve
  // the active prompt before deciding a gate. Heads with
  // kind=gate_decision OR no head at all are soft-allowed (co-emission
  // adds pending:resolved when present; nothing when absent).
  // Strict gate_decision(<G>) matching needs PendingAddedPayload
  // gate_name field — deferred (no schema yet to discriminate
  // spec-lock vs verify-accept heads).
  | "GATE_NOT_PENDING"
  // Slice 4 SC1 — DUPLICATE_REQ_ID / DUPLICATE_SCEN_ID / DUPLICATE_VIS_ID
  // preflight promotion (mirror Slice 2 SC4 DUPLICATE_TASK_ID pattern).
  // Reducer keeps its defense-in-depth message-string check; preflight
  // catches the public surface case so CLI emits the actionable code
  // rather than REDUCER_ERROR wrap. Two cases fire: (a) within same
  // submit batch (second entry sees first's id already in projection
  // via mutateBatch dry-run), (b) cross-invocation collision against
  // existing projection.
  | "DUPLICATE_REQ_ID"
  | "DUPLICATE_SCEN_ID"
  | "DUPLICATE_VIS_ID"
  // Slice 4 SC3 — SPEC content phase gating (rev 4.3 ADR-0004 A4,
  // protocol §10.8). SPEC_NOT_INITIALIZED fires when caller attempts
  // an incremental `spec add-*` before any `spec submit` has bumped
  // state.spec_version (codex r74: mutator truth is journal/snapshot,
  // not spec.md file existence). SPEC_LOCKED_NO_DIRECT_EDIT fires
  // when state.spec_locked === true blocks ALL spec content kinds;
  // post-lock callers must walk through `loaf finding raise --action
  // amend-spec` to back-edge into SPEC.spec.
  | "SPEC_NOT_INITIALIZED"
  | "SPEC_LOCKED_NO_DIRECT_EDIT"
  // Slice B — finding amend-spec back-edge batch (codex r94/r96).
  // FINDING_AMEND_SPEC_NOT_LOCKED: `finding:raised` with
  // action=amend-spec when state.spec_locked=false. The amend-spec
  // surface is reserved for post-lock recovery; pre-lock callers
  // should use `loaf spec submit / add-*` directly (gated by
  // SPEC_LOCKED_NO_DIRECT_EDIT as the inverse). Only ever fires at
  // EXECUTE.* / VERIFY.* (the lanes where finding:raised is allowed
  // and spec_locked CAN be true); SUB_STATE_AUTHORITY_VIOLATION
  // wins at SPEC.* / SETTLE.* / TRIAGE.* (codex r94 Finding 3 ack).
  //
  // FINDING_NOT_FOUND: `event:phase_advanced` with payload.back_edge
  // referencing a finding_id that doesn't exist in projection, has
  // wrong action, or is already_closed (status=closed). Reused from
  // the reducer's `finding:closed` already_closed convention; the
  // detail.reason field disambiguates. Promotion to a preflight
  // code so mutateBatch surfaces the actionable diagnostic instead
  // of REDUCER_ERROR wrap (codex r96 §2).
  | "FINDING_AMEND_SPEC_NOT_LOCKED"
  | "FINDING_NOT_FOUND"
  // Slice E — SPEC_VERSION_NOT_MONOTONIC / SPEC_VERSION_BATCH_MISMATCH
  // preflight promotion (mirror Slice 2 SC4 DUPLICATE_TASK_ID + Slice 4
  // SC1 DUPLICATE_REQ_ID/SCEN/VIS pattern). Reducer keeps
  // checkSpecVersionHead/checkSpecVersion as defense-in-depth for raw
  // apply paths bypassing preflight; preflight catches the public
  // CLI surface case so users see the actionable code instead of
  // INVALID_PAYLOAD wrap. Fires on the 4 SPEC content kinds:
  //   spec_submitted    — must be batch head (batch_index undef|0);
  //                       payload.spec_version === current+1
  //   spec_*_added      — head:        payload.spec_version === current+1
  //                       continuation: payload.spec_version === current
  | "SPEC_VERSION_NOT_MONOTONIC"
  | "SPEC_VERSION_BATCH_MISMATCH"
  // Slice C SC-C2b — event:tasks_amended §8.6 mutation rights. Promoted
  // from the protocol-named code (docs/schemas.ts §8.6) to a preflight
  // failure so `tasks amend` surfaces the actionable diagnostic. Fires
  // when: a mode=replace amend at EXECUTE.plan changes a frozen field
  // (graph / kind-flag / step set / step status / illegal status move);
  // a mode=add amend is unsponsored (no legit SC-C2b emitter); or a
  // mode=replace amend is attempted outside EXECUTE.plan (unsponsored
  // until a future finding amend-tasks back-edge carries sponsorship).
  | "MUTATION_OUT_OF_RIGHTS"
  // Slice C SC-C4 — bug-task RED registration (R2 invariant relocation).
  // BUG_TASK_REQUIRES_RED: a behavioral task labelled `bug` cannot start
  // OR complete its `implement` step (event:task_step_started /
  // task_step_done, step="implement", any result) until register-red has
  // set red_test_registered. BUG_TASK_FLAG_MISUSE: the red_test_registered
  // flag may only ride a red-step task_step_done on a behavioral bug task
  // with a passed/waived result, and may not be smuggled into a newly
  // planned task (event:tasks_planned creation-time rejection).
  | "BUG_TASK_REQUIRES_RED"
  | "BUG_TASK_FLAG_MISUSE"
  // Item 1 — `loaf tasks abandon <T-N>` (event:task_abandoned) refines.
  // TASK_NOT_ABANDONABLE: the task is already in a final status (done |
  // abandoned) — abandoning a terminal task is a no-op contract error.
  // TASK_ABANDON_BLOCKED_DEPENDENTS: another non-terminal task lists this
  // task in its depends_on; abandoning the parent would strand the child
  // (task_claimed preflight requires deps status=done, not abandoned).
  | "TASK_NOT_ABANDONABLE"
  | "TASK_ABANDON_BLOCKED_DEPENDENTS"
  // Item 2 — `loaf archive` / `loaf abandon` (session:archived /
  // session:abandoned) refine. SESSION_REASON_REQUIRED fires when either
  // session-terminal kind carries no `reason` key. The shared
  // SessionReasonPayload makes reason OPTIONAL (session:delivered
  // legitimately allows no reason); archive / abandon tighten it to
  // required. An empty-string reason is already rejected upstream by the
  // PER_KIND_PAYLOAD parse (`z.string().min(1)`) as INVALID_PAYLOAD — this
  // refine handles only the absent case.
  | "SESSION_REASON_REQUIRED";

export type PreflightResult =
  | { ok: true }
  | {
      ok: false;
      code: PreflightFailureCode;
      message: string;
      detail?: Record<string, unknown>;
    };

// Slice C SC-C2b — §8.6 frozen-field diff for `tasks amend`. Both inputs
// are slim TaskState projections (the incoming task is run through
// extractTaskSlim first). Returns the first field the amend changes that
// EXECUTE.plan mutation rights forbid, or null when the change is in-rights
// (execution[].applicability only, plus an optional status pending→ready).
interface FrozenViolation {
  field: string;
  from: unknown;
  to: unknown;
}

function arraysEqual(
  a: readonly unknown[] | undefined,
  b: readonly unknown[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function firstFrozenViolation(
  current: TaskState,
  incoming: TaskState,
): FrozenViolation | null {
  // status: unchanged, or the single legal advance pending → ready.
  if (incoming.status !== current.status) {
    const legalAdvance =
      current.status === "pending" && incoming.status === "ready";
    if (!legalAdvance) {
      return { field: "status", from: current.status, to: incoming.status };
    }
  }
  if (incoming.kind !== current.kind) {
    return { field: "kind", from: current.kind, to: incoming.kind };
  }
  // Array graph fields — exact deep equality (codex r108: no set-normalize).
  if (!arraysEqual(current.drives, incoming.drives)) {
    return { field: "drives", from: current.drives, to: incoming.drives };
  }
  if (!arraysEqual(current.depends_on, incoming.depends_on)) {
    return { field: "depends_on", from: current.depends_on, to: incoming.depends_on };
  }
  if (!arraysEqual(current.labels, incoming.labels)) {
    return { field: "labels", from: current.labels, to: incoming.labels };
  }
  if (!arraysEqual(current.visual_contract_refs, incoming.visual_contract_refs)) {
    return {
      field: "visual_contract_refs",
      from: current.visual_contract_refs,
      to: incoming.visual_contract_refs,
    };
  }
  // Scalar kind-flag fields (undefined-safe via ===).
  for (const f of [
    "red_test_registered",
    "no_test_rationale",
    "requires_acceptance",
    "requires_visual",
  ] as const) {
    if (current[f] !== incoming[f]) {
      return { field: f, from: current[f], to: incoming[f] };
    }
  }
  // Execution step set frozen; per-step status frozen; applicability free.
  const curSteps = Object.keys(current.steps).sort();
  const incSteps = Object.keys(incoming.steps).sort();
  if (!arraysEqual(curSteps, incSteps)) {
    return { field: "execution.steps", from: curSteps, to: incSteps };
  }
  for (const stepName of curSteps) {
    const c = current.steps[stepName];
    const i = incoming.steps[stepName];
    if (c && i && c.status !== i.status) {
      return {
        field: `execution.${stepName}.status`,
        from: c.status,
        to: i.status,
      };
    }
  }
  return null;
}

// Phase 11 Item 3 SC1b — frozen-field check for a SPONSORED `mode=replace`
// `event:tasks_amended` at EXECUTE.work (codex r136 Q4, HARD GATE). Both
// arguments are slim TaskState projections. Sponsorship widens the EXECUTE.plan
// rule: graph / definition fields (kind / drives / depends_on / labels /
// visual_contract_refs / scalar kind-flags) and the execution step SET become
// mutable — the worker is restructuring the task graph in response to a
// finding. What stays FROZEN is identity + execution PROGRESS:
//   - task `status` — replacing a graph definition must not rewind or fast-
//     forward where the task is in its lifecycle.
//   - per-RETAINED-step `status` — a step kept across the replace keeps its
//     current status; the new graph definition cannot erase its progress.
//   - new steps must be born `pending` (unstarted) — a replace cannot fabricate
//     completed work.
//   - a step whose current status is non-`pending` (progress-bearing) must NOT
//     be removed — dropping it from the graph erases execution history.
// codex's red-line: no sponsored path may erase / rewrite execution progress
// under the name of a graph amend. (`id` is verified by the caller's
// TASK_NOT_FOUND lookup, not here.) Body-only progress fields — `evidence_refs`
// / `started_at` / step `reason` — are NOT in the slim projection; stable-core
// preflight does not independently re-verify them (see the §8.6 enforcement
// note at the sponsored branch below).
function firstSponsoredFrozenViolation(
  current: TaskState,
  incoming: TaskState,
): FrozenViolation | null {
  // Task-level status is frozen — unconditionally (no pending→ready latitude:
  // a sponsored replace at EXECUTE.work is not the planning surface).
  if (incoming.status !== current.status) {
    return { field: "status", from: current.status, to: incoming.status };
  }
  // Step-set MAY change. For each RETAINED step (present in both), status is
  // frozen. For each step REMOVED by the replace, reject if it carries
  // progress (status !== "pending"). For each NEW step, reject if it is born
  // with a non-`pending` status.
  for (const [stepName, cur] of Object.entries(current.steps)) {
    const inc = incoming.steps[stepName];
    if (inc === undefined) {
      // Removed step — only legal when it has no execution progress.
      if (cur.status !== "pending") {
        return {
          field: `execution.${stepName}.status`,
          from: cur.status,
          to: undefined,
        };
      }
      continue;
    }
    if (cur.status !== inc.status) {
      return {
        field: `execution.${stepName}.status`,
        from: cur.status,
        to: inc.status,
      };
    }
  }
  for (const [stepName, inc] of Object.entries(incoming.steps)) {
    if (current.steps[stepName] === undefined && inc.status !== "pending") {
      return {
        field: `execution.${stepName}.status`,
        from: undefined,
        to: inc.status,
      };
    }
  }
  return null;
}

// Phase 11 Item 3 SC1b — freshness check for a SPONSORED `mode=add`
// event:tasks_amended (codex r137 BLOCK 1). A sponsored add introduces a
// task MISSING from the graph; it must be born fresh / unstarted. The
// reducer dry-run rejects a duplicate id, but nothing else stops a raw
// journal caller from supplying a full TaskFullPayload that smuggles
// completed work — task.status=`done`, a step `passed` with `evidence_refs`,
// a runtime `red_test_registered` flag. codex r136 Q4: a sponsored amend
// may not fabricate execution progress. The CLI `tasks add --finding` path
// builds the task via `materializeTaskInput` (always fresh), so this guards
// the stable-core journal path against raw callers. Operates on the full
// incoming payload (not the slim projection) — `evidence_refs` /
// `started_at` / `reason` ride the payload even though the projection
// drops them.
function firstAddFreshnessViolation(
  task: TaskFullProjection,
): { field: string; value: unknown } | null {
  if (task.status !== "pending") {
    return { field: "status", value: task.status };
  }
  if (task.red_test_registered === true) {
    return { field: "red_test_registered", value: true };
  }
  for (const [stepName, step] of Object.entries(task.execution)) {
    if (step.status !== "pending") {
      return { field: `execution.${stepName}.status`, value: step.status };
    }
    if (step.evidence_refs.length > 0) {
      return { field: `execution.${stepName}.evidence_refs`, value: step.evidence_refs };
    }
    if (step.started_at !== undefined) {
      return { field: `execution.${stepName}.started_at`, value: step.started_at };
    }
    if (step.reason !== undefined) {
      return { field: `execution.${stepName}.reason`, value: step.reason };
    }
  }
  return null;
}

export function preflight(
  rawEntry: unknown,
  ctx: PreflightContext,
): PreflightResult {
  // Derive validation scalars from the snapshot single-source (codex r51).
  // Bootstrap kinds (session:started / migration:snapshot_imported) arrive
  // before state has been initialized; defaults preserve historical behavior.
  const sub_state: SubState = ctx.snapshot.state?.sub_state ?? DEFAULT_SUB_STATE;
  const ceremony: Ceremony = ctx.snapshot.state?.ceremony ?? DEFAULT_CEREMONY;
  const verify_accepted: boolean = ctx.snapshot.state?.verify_accepted ?? false;

  // (1) Envelope schema parse.
  const parsed = JournalEntry.safeParse(rawEntry);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_ENVELOPE",
      message: "JournalEntry failed envelope schema validation",
      detail: { issues: parsed.error.issues },
    };
  }
  const entry = parsed.data;

  // (2) Monotonic seq.
  const expectedSeq = ctx.tail_seq + 1;
  if (entry.seq !== expectedSeq) {
    return {
      ok: false,
      code: "SEQ_NOT_MONOTONIC",
      message: `entry.seq=${entry.seq} but expected ${expectedSeq} (tail seq=${ctx.tail_seq})`,
      detail: {
        got: entry.seq,
        expected: expectedSeq,
        tail_seq: ctx.tail_seq,
      },
    };
  }

  // (3) Per-kind sub_state authority.
  if (!isSubStateAllowed(entry.kind, sub_state)) {
    return {
      ok: false,
      code: "SUB_STATE_AUTHORITY_VIOLATION",
      message: `kind=${entry.kind} not allowed in sub_state=${sub_state}`,
      detail: { kind: entry.kind, sub_state },
    };
  }

  // (4) Per-kind actor authority.
  if (!isActorAllowed(entry.kind, entry.actor)) {
    return {
      ok: false,
      code: "ACTOR_AUTHORITY_VIOLATION",
      message: `actor=${entry.actor} not allowed for kind=${entry.kind}`,
      detail: { kind: entry.kind, actor: entry.actor },
    };
  }

  // (4b) Per-kind payload schema (audit r1 fix #4 — Gate #2 / Gate #3 wiring).
  // PER_KIND_PAYLOAD lookup is total — every EntryKind has at least
  // RecordPayload (object-shape) as fallback. A literal string / array /
  // scalar fails here, preventing 'inline artifact body in migration' and
  // similar bypasses of the envelope.
  const payloadSchema = PER_KIND_PAYLOAD[entry.kind];
  const payloadParsed = payloadSchema.safeParse(entry.payload);
  if (!payloadParsed.success) {
    return {
      ok: false,
      code: "INVALID_PAYLOAD",
      message: `payload schema validation failed for kind=${entry.kind}`,
      detail: { kind: entry.kind, issues: payloadParsed.error.issues },
    };
  }

  // (5a) Slice 1.A fix: payload-aware sub_state authority for gate:decided.
  // PER_KIND_SUB_STATE allows the KIND at both SPEC.design and VERIFY.accept,
  // but each gate_kind pins to one source: spec-lock requires SPEC.design,
  // verify-accept requires VERIFY.accept. Without this refine, a `gate:decided
  // gate_kind=spec-lock` at VERIFY.accept (or vice versa) would silently pass
  // preflight even though the protocol requires source-specific filing.
  if (entry.kind === "gate:decided") {
    const gateKind = (payloadParsed.data as { gate_kind?: string }).gate_kind;
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
    const decision = (payloadParsed.data as { decision?: string }).decision;
    if (decision === "approved") {
      const pendingHead = ctx.snapshot.pending.find((p) => !p.resolved);
      if (pendingHead && pendingHead.kind !== "gate_decision") {
        return {
          ok: false,
          code: "GATE_NOT_PENDING",
          message:
            `gate:decided ${gateKind} approve blocked: pending head ${pendingHead.id} ` +
            `(kind=${pendingHead.kind}) is not a gate_decision prompt; resolve it first`,
          detail: {
            gate_kind: gateKind,
            head_id: pendingHead.id,
            head_kind: pendingHead.kind,
          },
        };
      }
    }
  }

  // (5b) Audit r1 fix: for event:phase_advanced, payload.from MUST match
  // the current cursor. validateTransition only checks edge legality; cursor
  // coherence is preflight's job. Without this gate a caller can pass any
  // valid LEGAL_TRANSITIONS edge (e.g. EXECUTE.work → EXECUTE.done) even
  // though the cursor sits at TRIAGE, and preflight returns ok.
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
    const rawPayload =
      ((rawEntry as { payload?: Record<string, unknown> }).payload ?? {}) as Record<string, unknown>;
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
          message:
            `event:phase_advanced.back_edge.action=${backEdge.action} but finding ${findingId} has action=${finding.action}`,
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
    if (
      backEdge === undefined &&
      sub_state === "EXECUTE.work" &&
      phaseTo === "EXECUTE.done"
    ) {
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
      // Quick / light deliver path requires verify-min (protocol §3) —
      // evidence checks not yet implemented in v0.1.0. Fail-closed per
      // codex r49 BLOCK 2 (do not ship cursor movement without evidence
      // proof). Code is "UNAVAILABLE" not "NOT_IMPLEMENTED" per codex r50
      // residual A — describes the current surface without baking
      // implementation status into the protocol.
      return {
        ok: false,
        code: "DELIVER_VERIFY_MIN_UNAVAILABLE",
        message:
          "quick / light deliver from EXECUTE.done requires verify-min, which is not yet implemented in this build",
        detail: { sub_state, ceremony_label: deriveCeremonyLabel(ceremony) },
      };
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
  if (
    entry.kind === "session:archived" ||
    entry.kind === "session:abandoned"
  ) {
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

  // (5d.1) Slice 2 SC4 — DUPLICATE_TASK_ID for event:tasks_planned (codex
  // r59 P2.1 closure). Promoted from reducer-side invalidPayload (which
  // mutate's Pass 1 wraps as REDUCER_ERROR) to top-level preflight so the
  // user-facing CLI surface returns the actionable diagnostic directly.
  // Reducer keeps its defensive duplicate-id sweep as fallback for raw
  // mutate paths that bypass preflight.
  if (entry.kind === "event:tasks_planned") {
    const tasksPayload = (rawEntry as { payload?: Record<string, unknown> }).payload ?? {};
    const incoming = tasksPayload["tasks"] as
      | Array<{ id?: string; red_test_registered?: unknown }>
      | undefined;
    if (Array.isArray(incoming)) {
      const seenIds = new Set<string>();
      for (const t of incoming) {
        if (typeof t?.id === "string") {
          if (seenIds.has(t.id)) {
            return {
              ok: false,
              code: "DUPLICATE_TASK_ID",
              message: `tasks_planned: task id ${t.id} appears more than once in payload`,
              detail: { task_id: t.id },
            };
          }
          seenIds.add(t.id);
        }
        // Slice C SC-C4 (R2) — creation-time red-flag rejection. A planned
        // task must be born unregistered; red_test_registered is set only
        // by `loaf tasks register-red` after the task exists, so the
        // journal records RED registration strictly after task creation.
        // (Preflight only — replay of pre-guard journals stays apply-only.)
        if (t?.red_test_registered === true) {
          return {
            ok: false,
            code: "BUG_TASK_FLAG_MISUSE",
            message: `tasks_planned: task ${t.id ?? "?"} carries red_test_registered=true — a planned task is born unregistered; use \`loaf tasks register-red\` after creation`,
            detail: { task_id: t.id, kind: "event:tasks_planned" },
          };
        }
      }
    }
  }

  // (5d.2) Slice C SC-C2b + Phase 11 Item 3 SC1b — event:tasks_amended §8.6
  // mutation rights.
  //
  // UNSPONSORED `tasks amend` (mode=replace at EXECUTE.plan) may change only
  // execution[].applicability and advance status pending→ready; every
  // graph / kind-flag / step-set / step-status field is frozen. An
  // unsponsored mode=add or a mode=replace outside EXECUTE.plan is rejected.
  //
  // SPONSORED `tasks_amended` (SC1b) carries `sponsored_by_finding_id` — the
  // journal-derivable marker that authorizes a post-back-edge graph amend at
  // EXECUTE.work. The sponsored branch runs FIRST (before the unsponsored
  // mode=add / replace-outside-EXECUTE.plan rejections): it verifies the
  // marker against snapshot.findings exactly like the back-edge sponsorship
  // precedent (step 5b: missing / closed / action-mismatch → FINDING_NOT_FOUND),
  // pins the surface to EXECUTE.work (Q3), and under valid sponsorship enforces
  // the Q4 frozen-field split — identity + execution PROGRESS frozen, graph /
  // definition fields + step set mutable.
  //
  // Enforcement is option B (codex r108, reaffirmed for SC1b at r136):
  // the frozen diff runs against the slim Snapshot.tasks projection. Body-only
  // fields — `tests` / `test_layer` / per-step `evidence_refs` / `reason` /
  // `started_at` — are NOT in the slim projection, so stable-core preflight
  // does NOT independently re-verify their preservation. The CLI sponsored
  // `tasks amend --input` path carries those body-only progress fields
  // forward from the current canonical body via `carryForwardStepProgress`
  // (task-history.ts) for every retained step; that carry-forward is the
  // body-only-field guard. This is a deliberate locus split, not a preflight
  // capability gap.
  if (entry.kind === "event:tasks_amended") {
    const amended = payloadParsed.data as {
      mode?: "add" | "replace";
      task: TaskFullProjection;
      sponsored_by_finding_id?: string;
    };
    const mode = amended.mode ?? "replace";
    const taskId = amended.task.id;
    const sponsorId = amended.sponsored_by_finding_id;

    if (sponsorId !== undefined) {
      // (a) Verify the sponsorship marker against snapshot.findings — mirror
      // the back-edge sponsorship checks (step 5b): the finding must exist,
      // be open, and carry action=amend-tasks. These are FINDING_NOT_FOUND
      // (the finding is the thing being checked); only AFTER the finding is
      // known valid do authorization / surface violations use
      // MUTATION_OUT_OF_RIGHTS.
      const finding = ctx.snapshot.findings.find((f) => f.id === sponsorId);
      if (!finding) {
        return {
          ok: false,
          code: "FINDING_NOT_FOUND",
          message: `event:tasks_amended.sponsored_by_finding_id=${sponsorId} not found in projection`,
          detail: { id: sponsorId, reason: "not_found" },
        };
      }
      if (finding.status === "closed") {
        return {
          ok: false,
          code: "FINDING_NOT_FOUND",
          message: `event:tasks_amended.sponsored_by_finding_id=${sponsorId} is already_closed; only open findings can sponsor a tasks amend`,
          detail: { id: sponsorId, reason: "already_closed" },
        };
      }
      if (finding.action !== "amend-tasks") {
        return {
          ok: false,
          code: "FINDING_NOT_FOUND",
          message: `event:tasks_amended.sponsored_by_finding_id=${sponsorId} has action=${finding.action} but only amend-tasks findings can sponsor a tasks amend`,
          detail: {
            id: sponsorId,
            reason: "action_mismatch",
            expected_action: "amend-tasks",
            actual_action: finding.action,
          },
        };
      }

      // (b) Q3 — sponsored tasks_amended is legal ONLY at EXECUTE.work (the
      // amend-tasks back-edge target). The per-kind sub_state table allows
      // the whole VERIFY-or-post-lock-EXECUTE band; the sponsored path
      // narrows it.
      if (sub_state !== "EXECUTE.work") {
        return {
          ok: false,
          code: "MUTATION_OUT_OF_RIGHTS",
          message: `sponsored event:tasks_amended is permitted only at EXECUTE.work (current sub_state=${sub_state})`,
          detail: {
            task_id: taskId,
            mode,
            sub_state,
            reason: "sponsored_tasks_amended_wrong_sub_state",
          },
        };
      }

      // (c) mode=add — the reducer dry-run catches a duplicate id
      // (DUPLICATE_TASK_ID); firstAddFreshnessViolation rejects a forged
      // task that smuggles execution progress (codex r137 BLOCK 1: a
      // sponsored add must introduce a fresh / unstarted task).
      // mode=replace — verify the Q4 frozen-field split.
      if (mode === "add") {
        const violation = firstAddFreshnessViolation(amended.task);
        if (violation) {
          return {
            ok: false,
            code: "MUTATION_OUT_OF_RIGHTS",
            message:
              `sponsored event:tasks_amended mode=add must introduce a fresh task — ` +
              `'${violation.field}' carries execution progress (§8.6: a sponsored ` +
              `amend may not fabricate completed work)`,
            detail: {
              task_id: taskId,
              mode,
              sub_state,
              field: violation.field,
              reason: "sponsored_add_not_fresh",
            },
          };
        }
      }
      if (mode === "replace") {
        const currentTask = ctx.snapshot.tasks.find((t) => t.id === taskId);
        if (!currentTask) {
          return {
            ok: false,
            code: "TASK_NOT_FOUND",
            message: `tasks_amended: task ${taskId} is not in the current tasks projection`,
            detail: { task_id: taskId },
          };
        }
        const incomingSlim = extractTaskSlim(amended.task);
        const violation = firstSponsoredFrozenViolation(currentTask, incomingSlim);
        if (violation) {
          return {
            ok: false,
            code: "MUTATION_OUT_OF_RIGHTS",
            message: `sponsored event:tasks_amended on task ${taskId} changes frozen field '${violation.field}' — a graph amend may not erase or rewrite execution progress (§8.6)`,
            detail: {
              task_id: taskId,
              mode,
              sub_state,
              field: violation.field,
              from: violation.from,
              to: violation.to,
            },
          };
        }
      }
      // Sponsored path validated — fall through (no unsponsored rejection).
      return { ok: true };
    }

    if (mode === "add") {
      return {
        ok: false,
        code: "MUTATION_OUT_OF_RIGHTS",
        message: `event:tasks_amended mode=add on task ${taskId} is not authorized — an add must be sponsored by an amend-tasks finding (sponsored_by_finding_id)`,
        detail: { task_id: taskId, mode, sub_state, reason: "unsponsored_add" },
      };
    }

    if (sub_state !== "EXECUTE.plan") {
      return {
        ok: false,
        code: "MUTATION_OUT_OF_RIGHTS",
        message: `event:tasks_amended mode=replace is permitted only at EXECUTE.plan (current sub_state=${sub_state})`,
        detail: {
          task_id: taskId,
          mode,
          sub_state,
          reason: "replace_outside_execute_plan",
        },
      };
    }

    const currentTask = ctx.snapshot.tasks.find((t) => t.id === taskId);
    if (!currentTask) {
      return {
        ok: false,
        code: "TASK_NOT_FOUND",
        message: `tasks_amended: task ${taskId} is not in the current tasks projection`,
        detail: { task_id: taskId },
      };
    }

    const incomingSlim = extractTaskSlim(amended.task);
    const violation = firstFrozenViolation(currentTask, incomingSlim);
    if (violation) {
      return {
        ok: false,
        code: "MUTATION_OUT_OF_RIGHTS",
        message: `event:tasks_amended on task ${taskId} changes frozen field '${violation.field}' — §8.6 forbids it at EXECUTE.plan`,
        detail: {
          task_id: taskId,
          mode,
          sub_state,
          field: violation.field,
          from: violation.from,
          to: violation.to,
        },
      };
    }
  }

  // (5e) Slice 2 SC1 — task lifecycle preflight refines.
  //
  // `event:task_claimed` / `event:task_step_started` / `event:task_step_done`
  // payloads carry a task_id (+ step). Reducer-side checks today report
  // TASK_NOT_FOUND / TASK_STEP_NOT_FOUND after dry-run, and `task_claimed`
  // historically silently no-opped on unknown ids (codex r56 BLOCK 3a).
  // This step lifts those checks into preflight where they belong, and
  // adds the claim/status/deps refines the reducer never enforced:
  //   * task_claimed:
  //       - task exists in snapshot.tasks → else TASK_NOT_FOUND
  //       - task.status ∈ {pending, ready} → else
  //         * status=in_progress → TASK_ALREADY_CLAIMED
  //         * status=done/abandoned → TASK_NOT_CLAIMABLE
  //       - all deps_on tasks have status=done → else TASK_DEPS_NOT_SATISFIED
  //   * task_step_started / task_step_done:
  //       - task exists → TASK_NOT_FOUND
  //       - task.status === "in_progress" → else TASK_NOT_CLAIMED
  // Reducer keeps its TASK_NOT_FOUND / TASK_STEP_NOT_FOUND fallbacks as
  // defense-in-depth (preflight is authoritative, reducer must not silently
  // no-op).
  if (
    entry.kind === "event:task_claimed" ||
    entry.kind === "event:task_step_started" ||
    entry.kind === "event:task_step_done"
  ) {
    const payload = (rawEntry as { payload?: Record<string, unknown> }).payload ?? {};
    const task_id = payload["task_id"] as string | undefined;
    if (!task_id) {
      // Schema validation should have caught this; defensive.
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: `${entry.kind}: missing task_id`,
        detail: { kind: entry.kind },
      };
    }
    const task = ctx.snapshot.tasks.find((t) => t.id === task_id);
    if (!task) {
      return {
        ok: false,
        code: "TASK_NOT_FOUND",
        message: `${entry.kind}: task ${task_id} is not in the current tasks projection`,
        detail: { task_id, kind: entry.kind },
      };
    }
    if (entry.kind === "event:task_claimed") {
      if (task.status === "in_progress") {
        return {
          ok: false,
          code: "TASK_ALREADY_CLAIMED",
          message: `task ${task_id} is already claimed (status=in_progress)`,
          detail: { task_id, status: task.status },
        };
      }
      if (task.status === "done" || task.status === "abandoned") {
        return {
          ok: false,
          code: "TASK_NOT_CLAIMABLE",
          message: `task ${task_id} cannot be claimed (status=${task.status} — terminal state)`,
          detail: { task_id, status: task.status },
        };
      }
      // status ∈ {pending, ready} — check deps_on.
      for (const depId of task.depends_on) {
        const dep = ctx.snapshot.tasks.find((t) => t.id === depId);
        if (!dep) {
          // Unknown dep — treat as unsatisfied (CLI/reducer caller's
          // problem; tasks_planned should have enforced graph closure
          // earlier).
          return {
            ok: false,
            code: "TASK_DEPS_NOT_SATISFIED",
            message: `task ${task_id} cannot be claimed: dependency ${depId} is not in the tasks projection`,
            detail: { task_id, blocking_dep: depId, blocking_status: "missing" },
          };
        }
        if (dep.status !== "done") {
          return {
            ok: false,
            code: "TASK_DEPS_NOT_SATISFIED",
            message: `task ${task_id} cannot be claimed: dependency ${depId} is not done (status=${dep.status})`,
            detail: { task_id, blocking_dep: depId, blocking_status: dep.status },
          };
        }
      }
    } else {
      // task_step_started or task_step_done
      const step = payload["step"] as string | undefined;
      if (task.status !== "in_progress") {
        return {
          ok: false,
          code: "TASK_NOT_CLAIMED",
          message: `task ${task_id} step ${step ?? "?"} mutation requires task.status=in_progress (got status=${task.status}); claim the task first`,
          detail: { task_id, step, status: task.status, kind: entry.kind },
        };
      }
      // (5e.1) Slice C SC-C4 (R2) — bug-task implement gate. A behavioral
      // task labelled `bug` cannot start OR complete its `implement` step
      // until `loaf tasks register-red` has set red_test_registered. Both
      // edges are gated regardless of result, so a direct task_step_done
      // cannot bypass task_step_started (codex r115 Q4).
      if (
        step === "implement" &&
        task.kind === "behavioral" &&
        task.labels.includes("bug") &&
        task.red_test_registered !== true
      ) {
        return {
          ok: false,
          code: "BUG_TASK_REQUIRES_RED",
          message: `behavioral bug task ${task_id} must register its RED test before the implement step — run \`loaf tasks register-red ${task_id}\` first`,
          detail: { task_id, step, kind: entry.kind },
        };
      }
      // (5e.2) Slice C SC-C4 (R2) — red-flag misuse gate. The
      // red_test_registered flag may ride a task_step_done only when it is
      // a red-step registration on a behavioral bug task with a
      // passed/waived result (undefined result reduces to "passed").
      if (entry.kind === "event:task_step_done" && payload["red_test_registered"] === true) {
        const result = payload["result"] as string | undefined;
        const okResult = result === undefined || result === "passed" || result === "waived";
        const okShape =
          step === "red" &&
          task.kind === "behavioral" &&
          task.labels.includes("bug") &&
          okResult;
        if (!okShape) {
          return {
            ok: false,
            code: "BUG_TASK_FLAG_MISUSE",
            message: `red_test_registered=true is valid only on a red-step task_step_done for a behavioral bug task with a passed/waived result (task ${task_id}, step=${step ?? "?"}, result=${result ?? "passed"}, kind=${task.kind})`,
            detail: { task_id, step, result: result ?? "passed", kind: task.kind, labels: task.labels },
          };
        }
      }
    }
  }

  // (5e.3) Item 1 — event:task_abandoned refines.
  //
  // `loaf tasks abandon <T-N> --reason "..."` emits event:task_abandoned.
  // Per-kind already gates actor (ALL_NON_MIGRATION) + sub_state
  // (EXECUTE.work) — this step adds the task-graph refines the reducer
  // never enforced (the reducer flips status→abandoned unconditionally):
  //   - task exists in snapshot.tasks → else TASK_NOT_FOUND
  //   - task.status ∉ {done, abandoned} → else TASK_NOT_ABANDONABLE
  //     (abandoning a terminal task is a no-op contract error)
  //   - no non-terminal task lists this task in depends_on → else
  //     TASK_ABANDON_BLOCKED_DEPENDENTS (abandoning the parent strands
  //     the child: task_claimed preflight requires deps status=done).
  // INVALID_PAYLOAD for missing / empty reason rides the PER_KIND_PAYLOAD
  // parse above (TaskAbandonedPayload requires reason: z.string().min(1)).
  if (entry.kind === "event:task_abandoned") {
    const payload = (rawEntry as { payload?: Record<string, unknown> }).payload ?? {};
    const task_id = payload["task_id"] as string | undefined;
    if (!task_id) {
      // Schema validation should have caught this; defensive.
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: `${entry.kind}: missing task_id`,
        detail: { kind: entry.kind },
      };
    }
    const task = ctx.snapshot.tasks.find((t) => t.id === task_id);
    if (!task) {
      return {
        ok: false,
        code: "TASK_NOT_FOUND",
        message: `${entry.kind}: task ${task_id} is not in the current tasks projection`,
        detail: { task_id, kind: entry.kind },
      };
    }
    if (task.status === "done" || task.status === "abandoned") {
      return {
        ok: false,
        code: "TASK_NOT_ABANDONABLE",
        message: `task ${task_id} cannot be abandoned (status=${task.status} — already in a final status)`,
        detail: { task_id, status: task.status },
      };
    }
    const blockingDependents = ctx.snapshot.tasks
      .filter(
        (t) =>
          t.depends_on.includes(task_id) &&
          t.status !== "done" &&
          t.status !== "abandoned",
      )
      .map((t) => t.id);
    if (blockingDependents.length > 0) {
      return {
        ok: false,
        code: "TASK_ABANDON_BLOCKED_DEPENDENTS",
        message:
          `task ${task_id} cannot be abandoned: ${blockingDependents.length} non-terminal ` +
          `task(s) depend on it (${blockingDependents.join(", ")}); abandon or complete ` +
          `the dependents first`,
        detail: { task_id, blocking_dependents: blockingDependents },
      };
    }
  }

  // (5e.4) Phase 11 Item 3 SC2/SC3 — event:task_step_reset refines (codex
  // r139 Q3, r142). `loaf finding raise --action fix-impl|fix-test` co-emits
  // this inside its 3-entry back-edge batch. Per-kind already gates actor
  // (cli-only) + sub_state (the shared fix back-edge from-set). This step
  // adds the sponsorship + target-authority refines:
  //   - finding_id exists / open / action ∈ {fix-impl, fix-test} → else
  //     FINDING_NOT_FOUND (detail.reason ∈ {not_found, already_closed,
  //     action_mismatch}), mirroring the back-edge sponsorship precedent
  //     (step 5b).
  //   - the finding's `target` must equal the reset payload's {task_id,
  //     step}, and `step` must equal the finding action's canonical step
  //     FIX_ACTION_STEP[finding.action] (fix-impl → "implement", fix-test →
  //     "red"). A structurally-valid-but-unauthorized payload is
  //     MUTATION_OUT_OF_RIGHTS (reason task_step_reset_target_mismatch /
  //     task_step_reset_step_mismatch) — the payload parsed, but it is not
  //     authorized by its sponsoring finding.
  //   - the task + step must exist in the projection (a step absent from
  //     the task is a target mismatch — the finding cannot legitimately
  //     target a step the task does not carry).
  //   - the target task must not be `abandoned` (r141 guard — see below).
  // No new DiagnosticCode — FINDING_NOT_FOUND + MUTATION_OUT_OF_RIGHTS
  // are reused (codex r139 Q3).
  if (entry.kind === "event:task_step_reset") {
    const payload = payloadParsed.data as {
      task_id: string;
      step: string;
      finding_id: string;
    };
    const finding = ctx.snapshot.findings.find((f) => f.id === payload.finding_id);
    if (!finding) {
      return {
        ok: false,
        code: "FINDING_NOT_FOUND",
        message: `event:task_step_reset.finding_id=${payload.finding_id} not found in projection`,
        detail: { id: payload.finding_id, reason: "not_found" },
      };
    }
    if (finding.status === "closed") {
      return {
        ok: false,
        code: "FINDING_NOT_FOUND",
        message: `event:task_step_reset.finding_id=${payload.finding_id} is already_closed; only open findings can sponsor a step reset`,
        detail: { id: payload.finding_id, reason: "already_closed" },
      };
    }
    // SC3 (codex r142): the kind serves both fix-impl and fix-test — a step
    // reset may be sponsored by either action. Any other action (amend-* /
    // defer / backlog) carries no canonical step and cannot author a reset.
    if (finding.action !== "fix-impl" && finding.action !== "fix-test") {
      return {
        ok: false,
        code: "FINDING_NOT_FOUND",
        message: `event:task_step_reset.finding_id=${payload.finding_id} has action=${finding.action} but only fix-impl / fix-test findings can sponsor a step reset`,
        detail: {
          id: payload.finding_id,
          reason: "action_mismatch",
          expected_action: ["fix-impl", "fix-test"],
          actual_action: finding.action,
        },
      };
    }
    // The payload's {task_id, step} must equal the finding's target — the
    // reset cannot drift off the task/step the finding authorized. The
    // canonical step is the finding action's own (fix-impl → "implement",
    // fix-test → "red") — SC3 keys it off finding.action, not a hardcode.
    const expectedStep = FIX_ACTION_STEP[finding.action]!;
    if (payload.step !== expectedStep) {
      return {
        ok: false,
        code: "MUTATION_OUT_OF_RIGHTS",
        message: `event:task_step_reset step="${payload.step}" but ${finding.action} resets step="${expectedStep}"`,
        detail: {
          finding_id: payload.finding_id,
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
        message: `event:task_step_reset target {task_id=${payload.task_id}, step=${payload.step}} does not match finding ${payload.finding_id}'s target`,
        detail: {
          finding_id: payload.finding_id,
          expected_target: expectedTarget ?? null,
          actual_target: { task_id: payload.task_id, step: payload.step },
          reason: "task_step_reset_target_mismatch",
        },
      };
    }
    // The target task + step must exist in the projection — a step the task
    // does not carry cannot be reset (treated as a target mismatch: the
    // finding's target points at a step absent from the task graph).
    const task = ctx.snapshot.tasks.find((t) => t.id === payload.task_id);
    if (!task || !(payload.step in task.steps)) {
      return {
        ok: false,
        code: "MUTATION_OUT_OF_RIGHTS",
        message: `event:task_step_reset target {task_id=${payload.task_id}, step=${payload.step}} is not present in the tasks projection`,
        detail: {
          finding_id: payload.finding_id,
          task_id: payload.task_id,
          step: payload.step,
          reason: "task_step_reset_target_mismatch",
        },
      };
    }
    // codex r140 P1 — a fix-impl/fix-test step reset may reopen a `done`
    // task (r139 Q5: a done task's step cannot otherwise be re-run), but
    // `abandoned` is a TERMINAL status and must NOT be reactivated
    // (protocol.md — abandoned is a final task status; docs/schemas.ts —
    // abandoned tasks cannot be reactivated). The reducer rewrites the target
    // task to `in_progress`; without this guard a fix finding targeting an
    // abandoned task would resurrect it. The guard is action-agnostic — it
    // serves both fix-impl and fix-test.
    if (task.status === "abandoned") {
      return {
        ok: false,
        code: "MUTATION_OUT_OF_RIGHTS",
        message: `event:task_step_reset cannot reset task ${payload.task_id}: status=abandoned is terminal and cannot be reactivated (a fix step reset may reopen a done task, never an abandoned one)`,
        detail: {
          finding_id: payload.finding_id,
          task_id: payload.task_id,
          status: task.status,
          reason: "task_step_reset_task_abandoned",
        },
      };
    }
  }

  // (5g) Slice 3 SC3 — finding:raised refines (FINDING_ACTION_GRID +
  // target_payload). Runs after PER_KIND_PAYLOAD parse so `parsed.data`
  // is the typed FindingRaisedPayload. Order:
  //   1. INCOHERENT grid cells block first (no transition target).
  //   2. UNUSUAL cells require --reason ≥20 chars.
  //   3. Target shape (fix-impl/fix-test require {task_id, step}; step
  //      must equal action's canonical step; task must exist; step must
  //      exist in task.steps; amend-tasks accepts absence but validates
  //      if present).
  if (entry.kind === "finding:raised") {
    const payload = payloadParsed.data as {
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
          code: "FINDING_ACTION_UNUSUAL_REASON_REQUIRED",
          message:
            `finding raise category=${payload.category} × action=${payload.action} is an unusual cell; ` +
            `--reason ≥${FINDING_UNUSUAL_REASON_MIN_LENGTH} chars required (got ${reasonLength})`,
          detail: {
            category: payload.category,
            action: payload.action,
            current_reason_length: reasonLength,
            min_reason_length: FINDING_UNUSUAL_REASON_MIN_LENGTH,
          },
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
            message:
              `finding raise target.task_id=${payload.target.task_id} not found in projection`,
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
        message:
          `finding raise action=amend-spec requires state.spec_locked=true; spec is not locked at sub_state=${sub_state}, edit directly via 'loaf spec submit / add-*'`,
        detail: {
          current_spec_locked: false,
          current_sub_state: sub_state,
          hint: "use loaf spec submit / add-* directly to edit spec when not locked",
        },
      };
    }
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
  const SPEC_CONTENT_KINDS = new Set<EntryKind>([
    "event:spec_submitted",
    "event:spec_req_added",
    "event:spec_scenario_added",
    "event:spec_visual_added",
  ]);
  if (SPEC_CONTENT_KINDS.has(entry.kind)) {
    if (ctx.snapshot.state?.spec_locked === true) {
      return {
        ok: false,
        code: "SPEC_LOCKED_NO_DIRECT_EDIT",
        message:
          `${entry.kind} blocked: spec_locked=true; ` +
          `walk back via \`loaf finding raise --category spec-gap --action amend-spec\` to re-enter SPEC.spec`,
        detail: { kind: entry.kind, spec_locked: true },
      };
    }
    if (
      entry.kind !== "event:spec_submitted" &&
      (ctx.snapshot.state?.spec_version ?? 0) === 0
    ) {
      return {
        ok: false,
        code: "SPEC_NOT_INITIALIZED",
        message:
          `${entry.kind} blocked: spec is not initialized (spec_version=0); ` +
          `run \`loaf spec submit --input <file>\` first to bump spec_version to 1`,
        detail: { kind: entry.kind, spec_version: ctx.snapshot.state?.spec_version ?? 0 },
      };
    }
  }

  // (5h) Slice 4 SC1 — DUPLICATE_REQ_ID / DUPLICATE_SCEN_ID /
  // DUPLICATE_VIS_ID preflight promotion. Mirrors the DUPLICATE_TASK_ID
  // pattern from Slice 2 SC4: reducer keeps its defensive message-string
  // check as fallback for raw mutate paths, but the public surface code
  // surfaces here so CLI can emit it directly (not wrapped as REDUCER_ERROR).
  // Within a submit batch the second occurrence sees the first already in
  // ctx.snapshot via mutateBatch dry-run accumulation; cross-invocation
  // collisions hit the same path. Note: only entries with batch_index >= 1
  // OR standalone add-* invocations should hit projection collision; the
  // batch head (spec_submitted, batch_index=0) does not carry req/scen/vis
  // payload, so this check only fires on the three add-* kinds.
  if (entry.kind === "event:spec_req_added") {
    const payload = payloadParsed.data as { req: { id: string } };
    if (ctx.snapshot.requirements.some((r) => r.id === payload.req.id)) {
      return {
        ok: false,
        code: "DUPLICATE_REQ_ID",
        message: `spec_req_added: REQ ${payload.req.id} already in projection`,
        detail: { id: payload.req.id },
      };
    }
  }
  if (entry.kind === "event:spec_scenario_added") {
    const payload = payloadParsed.data as { scenario: { id: string } };
    if (ctx.snapshot.scenarios.some((s) => s.id === payload.scenario.id)) {
      return {
        ok: false,
        code: "DUPLICATE_SCEN_ID",
        message: `spec_scenario_added: SCEN ${payload.scenario.id} already in projection`,
        detail: { id: payload.scenario.id },
      };
    }
  }
  if (entry.kind === "event:spec_visual_added") {
    const payload = payloadParsed.data as { visual: { id: string } };
    if (ctx.snapshot.visual_contracts.some((v) => v.id === payload.visual.id)) {
      return {
        ok: false,
        code: "DUPLICATE_VIS_ID",
        message: `spec_visual_added: VIS ${payload.visual.id} already in projection`,
        detail: { id: payload.visual.id },
      };
    }
  }

  // (5j) Slice E — SPEC_VERSION_NOT_MONOTONIC / SPEC_VERSION_BATCH_MISMATCH
  // preflight promotion. Mirrors Slice 2 SC4 DUPLICATE_TASK_ID + Slice 4
  // SC1 DUPLICATE_REQ_ID/SCEN/VIS pattern: reducer keeps its message-
  // string checkSpecVersionHead/checkSpecVersion as defense-in-depth for
  // raw apply paths; preflight surfaces the public code so CLI users
  // see the actionable diagnostic instead of INVALID_PAYLOAD wrap.
  //
  // Ordering inside spec_submitted: batch_index gate (head must be 0)
  // runs BEFORE the version check so a misplaced spec_submitted in the
  // middle of a batch returns the structurally meaningful code.
  const SPEC_VERSION_KINDS = new Set<EntryKind>([
    "event:spec_submitted",
    "event:spec_req_added",
    "event:spec_scenario_added",
    "event:spec_visual_added",
  ]);
  if (SPEC_VERSION_KINDS.has(entry.kind)) {
    const payload = payloadParsed.data as { spec_version: number };
    const payloadVersion = payload.spec_version;
    const currentVersion = ctx.snapshot.state?.spec_version ?? 0;

    if (entry.kind === "event:spec_submitted") {
      // spec_submitted is the whole-replacement entrypoint and ALWAYS
      // the batch head (batch_index undefined or 0). batch_index > 0
      // is structurally illegal.
      if (entry.batch_index !== undefined && entry.batch_index !== 0) {
        return {
          ok: false,
          code: "SPEC_VERSION_BATCH_MISMATCH",
          message: `spec_submitted must appear at batch_index=0 (got ${entry.batch_index}); it is the whole-replacement entrypoint`,
          detail: {
            kind: entry.kind,
            batch_index: entry.batch_index,
            expected_batch_index: 0,
          },
        };
      }
      if (payloadVersion !== currentVersion + 1) {
        return {
          ok: false,
          code: "SPEC_VERSION_NOT_MONOTONIC",
          message: `spec_submitted: spec_version must be ${currentVersion + 1} (current+1), got ${payloadVersion}`,
          detail: {
            kind: entry.kind,
            payload_spec_version: payloadVersion,
            current_spec_version: currentVersion,
            expected_spec_version: currentVersion + 1,
          },
        };
      }
    } else {
      // spec_*_added: HEAD path bumps (must equal current+1);
      // CONTINUATION path tracks (must equal current — the head
      // already bumped state in mutateBatch's accumulator).
      const isHead = entry.batch_index === undefined || entry.batch_index === 0;
      if (isHead) {
        if (payloadVersion !== currentVersion + 1) {
          return {
            ok: false,
            code: "SPEC_VERSION_NOT_MONOTONIC",
            message: `${entry.kind}: spec_version must be ${currentVersion + 1} (current+1) at batch head, got ${payloadVersion}`,
            detail: {
              kind: entry.kind,
              payload_spec_version: payloadVersion,
              current_spec_version: currentVersion,
              expected_spec_version: currentVersion + 1,
              batch_position: "head",
            },
          };
        }
      } else {
        if (payloadVersion !== currentVersion) {
          return {
            ok: false,
            code: "SPEC_VERSION_BATCH_MISMATCH",
            message: `${entry.kind}: spec_version must be ${currentVersion} at batch_index=${entry.batch_index} (batch continuation), got ${payloadVersion}`,
            detail: {
              kind: entry.kind,
              payload_spec_version: payloadVersion,
              current_spec_version: currentVersion,
              batch_index: entry.batch_index,
              batch_position: "continuation",
            },
          };
        }
      }
    }
  }

  // (5f) Transition (for kinds carrying a state-machine edge).
  const transitionResult = checkTransition(
    entry.kind,
    rawEntry as Record<string, unknown>,
    { sub_state, ceremony, verify_accepted, actor: entry.actor },
  );
  if (transitionResult && !transitionResult.ok) {
    return {
      ok: false,
      code: transitionResult.code,
      message: transitionResult.message,
      detail: transitionResult.detail ?? {},
    };
  }

  return { ok: true };
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
