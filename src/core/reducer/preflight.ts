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
import type { Snapshot } from "../reducer.js";
import { validateTransition, type TransitionResult } from "./transition.js";
import { isActorAllowed, isSubStateAllowed } from "./per-kind.js";

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
  | "DUPLICATE_TASK_ID";

export type PreflightResult =
  | { ok: true }
  | {
      ok: false;
      code: PreflightFailureCode;
      message: string;
      detail?: Record<string, unknown>;
    };

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

  // (5d.1) Slice 2 SC4 — DUPLICATE_TASK_ID for event:tasks_planned (codex
  // r59 P2.1 closure). Promoted from reducer-side invalidPayload (which
  // mutate's Pass 1 wraps as REDUCER_ERROR) to top-level preflight so the
  // user-facing CLI surface returns the actionable diagnostic directly.
  // Reducer keeps its defensive duplicate-id sweep as fallback for raw
  // mutate paths that bypass preflight.
  if (entry.kind === "event:tasks_planned") {
    const tasksPayload = (rawEntry as { payload?: Record<string, unknown> }).payload ?? {};
    const incoming = tasksPayload["tasks"] as Array<{ id?: string }> | undefined;
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
      }
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
    // payload: { from: SubState, to: SubState }
    const from = payload["from"] as SubState | undefined;
    const to = payload["to"] as SubState | undefined;
    if (from === undefined || to === undefined) return null; // schema already rejected upstream
    return validateTransition(from, to, {
      ceremony: ctx.ceremony,
      actor: ctx.actor,
      verify_accepted: ctx.verify_accepted,
    });
  }

  // Slice 1.A normalization: gate:decided no longer drives transitions —
  // its gate_kind ↔ source sub_state pairing is enforced at step 5a in the
  // main preflight() before transition check, not here. This branch stays
  // as a null return so `checkTransition` short-circuits cleanly.
  if (kind === "gate:decided") return null;

  return null;
}
