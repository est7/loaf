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

import { JournalEntry } from "../journal-entry.js";
import { PER_KIND_PAYLOAD } from "../kind-registry.js";
import type { Ceremony, EntryKind, SubState } from "../journal-entry.js";
import type { Snapshot } from "../projection-types.js";
import {
  checkActorAuthority,
  checkPerKindPayload,
  checkSeqMonotonic,
  checkSubStateAuthority,
} from "./preflight/checks-common.js";
import {
  checkSpecContentPhase,
  checkSpecDuplicateIds,
  checkSpecVersion,
} from "./preflight/checks-spec.js";
import {
  checkTaskAbandoned,
  checkTaskLifecycle,
  checkTaskStepReset,
  checkTasksAmended,
  checkTasksPlanned,
} from "./preflight/checks-task.js";
import {
  checkCeremonySet,
  checkFindingRaised,
  checkGateDecided,
  checkPhaseAdvanced,
  checkSessionDelivered,
  checkSessionTerminalReason,
  checkSpikeConverted,
  checkTransitionEdge,
} from "./preflight/checks-workflow.js";

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
  /** Last seq in the journal; absent when the caller does not own continuity validation. */
  tail_seq?: number;
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
  | "SPEC_LOCK_NOT_SATISFIED"
  | "SPEC_PHASE_FORK_VIOLATION"
  | "VERIFY_PHASE_FORK_VIOLATION"
  // Slice 1.D — `loaf deliver` preflight refines (step 5c).
  | "DELIVER_NOT_ACCEPTED"
  | "DELIVER_SETTLE_PHASE_BYPASS"
  | "DELIVER_VERIFY_MIN_UNAVAILABLE"
  // v0.1.1 — verify-min check landed; quick/light deliver from EXECUTE.done
  // now runs the §3.2 per-task evidence gate instead of fail-closing.
  | "DELIVER_VERIFY_MIN_INCOMPLETE"
  // v0.1.1 — verify-min mirrors verify-accept check 4's bug-RED defense
  // (reuses the existing code; already in docs DiagnosticCode enum).
  | "BUG_TASK_RED_NOT_REGISTERED"
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
  // (protocol §4.5 / src/core/finding-schema.ts / codex r68 sign-off).
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
  // from the protocol-named code to a preflight
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
  | "SESSION_REASON_REQUIRED"
  // Phase 12 — `loaf spike convert` (spike:converted) precondition.
  // SPIKE_CONVERT_NO_SPIKE_TASK fires when the session holds no
  // non-abandoned kind=spike task. `spike convert` is a spike-task exit
  // (protocol §8.3); without this guard a non-spike session could emit a
  // spike:converted audit entry and archive itself, making the journal
  // misrepresent the session. Done spikes count; abandoned spikes do not
  // (mirrors the DELIVER_SPIKE_TASKS predicate).
  | "SPIKE_CONVERT_NO_SPIKE_TASK"
  // Phase 13 — `loaf profile escalate` authorization. ESCALATION_NOT_PENDING
  // fires when a non-TRIAGE `event:ceremony_set` is attempted but the
  // unresolved pending head is not kind=profile_escalation (absent or wrong
  // kind). The DiagnosticCode + ERROR_CATALOG entry already existed (Slice 3
  // SC4 deferred the runtime wiring); this promotes it into the preflight
  // union so `loaf profile escalate` surfaces the actionable code.
  | "ESCALATION_NOT_PENDING";

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

// The coordinator owns the shared check context and the only ordered pipeline.
export type PreflightFailure = Extract<PreflightResult, { ok: false }>;

export type ParsedEntry = Extract<
  ReturnType<typeof JournalEntry.safeParse>,
  { success: true }
>["data"];

export type PayloadParse = ReturnType<(typeof PER_KIND_PAYLOAD)[EntryKind]["safeParse"]>;

export interface PreflightCheckCtx {
  rawEntry: unknown;
  entry: ParsedEntry;
  payloadParsed: PayloadParse;
  payloadData: unknown;
  ctx: PreflightContext;
  sub_state: SubState;
  ceremony: Ceremony;
  verify_accepted: boolean;
  spec_locked: boolean;
}

export type PreflightCheck = (ctx: PreflightCheckCtx) => PreflightFailure | null;

export function preflight(rawEntry: unknown, ctx: PreflightContext): PreflightResult {
  // Derive validation scalars from the snapshot single-source (codex r51).
  // Bootstrap kinds (session:started / migration:snapshot_imported) arrive
  // before state has been initialized; defaults preserve historical behavior.
  const sub_state: SubState = ctx.snapshot.state?.sub_state ?? DEFAULT_SUB_STATE;
  const ceremony: Ceremony = ctx.snapshot.state?.ceremony ?? DEFAULT_CEREMONY;
  const verify_accepted: boolean = ctx.snapshot.state?.verify_accepted ?? false;
  const spec_locked: boolean = ctx.snapshot.state?.spec_locked ?? false;

  // (1) Envelope schema parse — the only check that PRODUCES `entry`, so it
  // stays inline ahead of the ordered pipeline (the pipeline is typed over a
  // fully-built check context).
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

  // (4b) Per-kind payload schema (audit r1 fix #4 — Gate #2 / Gate #3 wiring).
  // PER_KIND_PAYLOAD lookup is total — every EntryKind has at least
  // RecordPayload (object-shape) as fallback. A literal string / array /
  // scalar fails here, preventing 'inline artifact body in migration' and
  // similar bypasses of the envelope. Parsed up-front so downstream checks can
  // read the validated `payloadData`, but the FAILURE is reported at its
  // precedence slot inside ORDERED_CHECKS (checkPerKindPayload, after seq /
  // sub_state / actor authority) — NOT here — so a malformed-payload entry that
  // also violates seq still reports SEQ_NOT_MONOTONIC first.
  const payloadParsed = PER_KIND_PAYLOAD[entry.kind].safeParse(entry.payload);
  const payloadData: unknown = payloadParsed.success ? payloadParsed.data : undefined;

  const checkCtx: PreflightCheckCtx = {
    rawEntry,
    entry,
    payloadParsed,
    payloadData,
    ctx,
    sub_state,
    ceremony,
    verify_accepted,
    spec_locked,
  };

  // The ORDERED pipeline IS the error-precedence contract. First failure wins;
  // reordering ORDERED_CHECKS changes which diagnostic a caller sees and is
  // caught by tests/core/preflight-precedence.test.ts.
  for (const check of ORDERED_CHECKS) {
    const failure = check(checkCtx);
    if (failure) return failure;
  }
  return { ok: true };
}

// The ORDERED error-precedence contract. Exported so the precedence test can
// pin the sequence (a reorder fails loudly). First failure wins. The envelope
// parse (1) and per-kind payload parse (producing `payloadData`) run inline in
// preflight() before this pipeline because they build the check context.
export const ORDERED_CHECKS: ReadonlyArray<(c: PreflightCheckCtx) => PreflightFailure | null> = [
  checkSeqMonotonic, // (2)
  checkSubStateAuthority, // (3)
  checkActorAuthority, // (4)
  checkPerKindPayload, // (4b)
  checkGateDecided, // (5a)
  checkPhaseAdvanced, // (5b)
  checkSessionDelivered, // (5c)
  checkSpikeConverted, // (5c.3)
  checkCeremonySet, // (5c.4)
  checkSessionTerminalReason, // (5c.2)
  checkTasksPlanned, // (5d.1)
  checkTasksAmended, // (5d.2)
  checkTaskLifecycle, // (5e)
  checkTaskAbandoned, // (5e.3)
  checkTaskStepReset, // (5e.4)
  checkFindingRaised, // (5g)
  checkSpecContentPhase, // (5i)
  checkSpecDuplicateIds, // (5h)
  checkSpecVersion, // (5j)
  checkTransitionEdge, // (5f)
];
