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
// kinds whose payload encodes a state-machine edge — `event:phase_advanced`
// and `gate:decided` (Gate #1).
//
// Per-kind extra refines (`tasks_planned.based_on.spec` parity etc.) are NOT
// preflight's job; they sit in the reducer apply path. Preflight is purely
// authority + structural gates.

import { JournalEntry } from "../journal-entry.js";
import type {
  Ceremony,
  EntryKind,
  GateName,
  SubState,
} from "../journal-entry.js";
import { validateTransition, type TransitionResult } from "./transition.js";
import { isActorAllowed, isSubStateAllowed } from "./per-kind.js";

export interface PreflightContext {
  /** Current sub_state (the projection cursor before applying this entry). */
  sub_state: SubState;
  /** Last seq in the journal; -1 if the journal is empty/absent. */
  tail_seq: number;
  /** Active ceremony — drives validateTransition's VERIFY.accept fork. */
  ceremony: Ceremony;
}

export type PreflightFailureCode =
  | "INVALID_ENVELOPE"
  | "SEQ_NOT_MONOTONIC"
  | "SUB_STATE_AUTHORITY_VIOLATION"
  | "ACTOR_AUTHORITY_VIOLATION"
  | "FROM_CURSOR_MISMATCH"
  | "TRANSITION_ILLEGAL"
  | "SETTLE_PHASE_DISABLED"
  | "SETTLE_PHASE_BYPASS"
  | "SPEC_PHASE_FORK_VIOLATION"
  | "VERIFY_PHASE_FORK_VIOLATION";

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
  if (!isSubStateAllowed(entry.kind, ctx.sub_state)) {
    return {
      ok: false,
      code: "SUB_STATE_AUTHORITY_VIOLATION",
      message: `kind=${entry.kind} not allowed in sub_state=${ctx.sub_state}`,
      detail: { kind: entry.kind, sub_state: ctx.sub_state },
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

  // (5a) Audit r1 fix: for event:phase_advanced, payload.from MUST match
  // the current cursor. validateTransition only checks edge legality; cursor
  // coherence is preflight's job. Without this gate a caller can pass any
  // valid LEGAL_TRANSITIONS edge (e.g. EXECUTE.work → EXECUTE.done) even
  // though the cursor sits at TRIAGE, and preflight returns ok.
  if (entry.kind === "event:phase_advanced") {
    const payload = (rawEntry as { payload?: Record<string, unknown> }).payload ?? {};
    const from = payload["from"] as SubState | undefined;
    if (from !== undefined && from !== ctx.sub_state) {
      return {
        ok: false,
        code: "FROM_CURSOR_MISMATCH",
        message: `event:phase_advanced payload.from=${from} but current sub_state=${ctx.sub_state}`,
        detail: { payload_from: from, current_sub_state: ctx.sub_state },
      };
    }
  }

  // (5b) Transition (for kinds carrying a state-machine edge).
  const transitionResult = checkTransition(entry.kind, rawEntry as Record<string, unknown>, ctx);
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

/**
 * For state-machine-edge kinds, extract (from, to) from payload and run
 * validateTransition. Returns null for kinds that don't carry an edge.
 */
function checkTransition(
  kind: EntryKind,
  raw: Record<string, unknown>,
  ctx: PreflightContext,
): TransitionResult | null {
  const payload = (raw["payload"] as Record<string, unknown> | undefined) ?? {};
  const actor = raw["actor"] as string;

  if (kind === "event:phase_advanced") {
    // payload: { from: SubState, to: SubState }
    const from = payload["from"] as SubState | undefined;
    const to = payload["to"] as SubState | undefined;
    if (from === undefined || to === undefined) return null; // schema already rejected upstream
    return validateTransition(from, to, { ceremony: ctx.ceremony, actor });
  }

  if (kind === "gate:decided") {
    // gate:decided's transition source/target is implied by gate_kind per
    // ADR-0005 §3.3: spec-lock → (SPEC.design → EXECUTE.plan);
    // verify-accept → (VERIFY.accept → SETTLE.reconcile or DONE.delivered
    // depending on settle_phase, gated by validateTransition).
    const gateKind = payload["gate_kind"] as GateName | undefined;
    if (gateKind === "spec-lock") {
      return validateTransition("SPEC.design", "EXECUTE.plan", {
        ceremony: ctx.ceremony,
        actor,
        gate_kind: gateKind,
      });
    }
    if (gateKind === "verify-accept") {
      // Fork target follows ceremony.settle_phase; validateTransition
      // selects the legal edge. We probe the active branch and fall back
      // to the other if the active is rejected.
      const target = ctx.ceremony.settle_phase
        ? "SETTLE.reconcile"
        : "DONE.delivered";
      return validateTransition("VERIFY.accept", target, {
        ceremony: ctx.ceremony,
        actor,
        gate_kind: gateKind,
      });
    }
    return null;
  }

  return null;
}
