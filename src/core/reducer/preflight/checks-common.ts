import { isActorAllowed, isSubStateAllowed } from "../per-kind.js";
import type { PreflightCheckCtx, PreflightFailure } from "../preflight.js";

// (2) Monotonic seq.
export function checkSeqMonotonic(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, ctx } = c;
  if (ctx.tail_seq === undefined) return null;
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
  return null;
}

// (3) Per-kind sub_state authority.
export function checkSubStateAuthority(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, sub_state } = c;
  if (!isSubStateAllowed(entry.kind, sub_state)) {
    return {
      ok: false,
      code: "SUB_STATE_AUTHORITY_VIOLATION",
      message: `kind=${entry.kind} not allowed in sub_state=${sub_state}`,
      detail: { kind: entry.kind, sub_state },
    };
  }
  return null;
}

// (4) Per-kind actor authority.
export function checkActorAuthority(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry } = c;
  if (!isActorAllowed(entry.kind, entry.actor)) {
    return {
      ok: false,
      code: "ACTOR_AUTHORITY_VIOLATION",
      message: `actor=${entry.actor} not allowed for kind=${entry.kind}`,
      detail: { kind: entry.kind, actor: entry.actor },
    };
  }
  return null;
}

// (4b) Per-kind payload schema validation. Reports the failure parsed up-front
// in preflight(); sits AFTER seq / sub_state / actor in the precedence order.
export function checkPerKindPayload(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, payloadParsed } = c;
  if (!payloadParsed.success) {
    return {
      ok: false,
      code: "INVALID_PAYLOAD",
      message: `payload schema validation failed for kind=${entry.kind}`,
      detail: { kind: entry.kind, issues: payloadParsed.error.issues },
    };
  }
  return null;
}

// (5a) Slice 1.A fix: payload-aware sub_state authority for gate:decided.
// PER_KIND_SUB_STATE allows the KIND at both SPEC.design and VERIFY.accept,
// but each gate_kind pins to one source: spec-lock requires SPEC.design,
// verify-accept requires VERIFY.accept. Without this refine, a `gate:decided
// gate_kind=spec-lock` at VERIFY.accept (or vice versa) would silently pass
// preflight even though the protocol requires source-specific filing.
