// Stage 2 — preflight validation (§11.2 step 3 + ADR-0005 §3.6).
//
// Covers the four authority gates plus the shared validateTransition probe:
//   1. Envelope schema parse
//   2. Monotonic seq vs tail
//   3. Per-kind sub_state authority
//   4. Per-kind actor authority
//   5. Transition (for state-machine-edge kinds)
//
// These are public-API tests on `preflight(rawEntry, ctx)`. The four codes
// must be greppable from CLI for stderr diagnostics.

import { describe, expect, test } from "vitest";

import { preflight } from "../../src/core/reducer/preflight.js";
import type { Ceremony } from "../../src/core/journal-entry.js";

const STANDARD_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

const DEEP_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: true,
  strict_spec_review: true,
  lessons_required: "must",
  strict_drift_check: true,
};

function baseEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 0,
    entry_id: "JE-000001",
    at: "2026-05-15T10:00:00.000Z",
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind: "pending:added",
    payload: { id: "PEND-001", kind: "ask_user_question", question: "?" },
    ...overrides,
  };
}

describe("preflight — Stage 2 §11.2 step 3", () => {
  // ── 1. Envelope schema ────────────────────────────────────────────────
  test("invalid envelope (missing kind) → INVALID_ENVELOPE", () => {
    const result = preflight(
      { ...baseEntry(), kind: undefined },
      { sub_state: "TRIAGE.score", tail_seq: -1, ceremony: STANDARD_CEREMONY },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_ENVELOPE");
  });

  // ── 2. Monotonic seq ──────────────────────────────────────────────────
  test("seq != tail+1 → SEQ_NOT_MONOTONIC", () => {
    const result = preflight(baseEntry({ seq: 5 }), {
      sub_state: "TRIAGE.score",
      tail_seq: -1,
      ceremony: STANDARD_CEREMONY,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SEQ_NOT_MONOTONIC");
  });

  // ── 3. Per-kind sub_state authority ──────────────────────────────────
  test("event:task_step_done in TRIAGE.score → SUB_STATE_AUTHORITY_VIOLATION", () => {
    const result = preflight(
      baseEntry({
        kind: "event:task_step_done",
        payload: { task_id: "T-001", step: "implement" },
      }),
      { sub_state: "TRIAGE.score", tail_seq: -1, ceremony: STANDARD_CEREMONY },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SUB_STATE_AUTHORITY_VIOLATION");
  });

  test("event:task_step_done in EXECUTE.work → OK", () => {
    const result = preflight(
      baseEntry({
        kind: "event:task_step_done",
        payload: { task_id: "T-001", step: "implement" },
      }),
      { sub_state: "EXECUTE.work", tail_seq: -1, ceremony: STANDARD_CEREMONY },
    );
    expect(result.ok).toBe(true);
  });

  // ── 4. Per-kind actor authority ──────────────────────────────────────
  test("gate:decided with cli: actor → ACTOR_AUTHORITY_VIOLATION", () => {
    const result = preflight(
      baseEntry({
        kind: "gate:decided",
        actor: "cli:loaf",
        payload: { gate_kind: "spec-lock", decision: "approved", reason: "ok" },
      }),
      { sub_state: "SPEC.design", tail_seq: -1, ceremony: STANDARD_CEREMONY },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ACTOR_AUTHORITY_VIOLATION");
  });

  test("gate:decided with human: actor → OK", () => {
    const result = preflight(
      baseEntry({
        kind: "gate:decided",
        actor: "human:est9",
        payload: { gate_kind: "spec-lock", decision: "approved", reason: "ok" },
      }),
      { sub_state: "SPEC.design", tail_seq: -1, ceremony: STANDARD_CEREMONY },
    );
    expect(result.ok).toBe(true);
  });

  test("migration:snapshot_imported requires migration: actor", () => {
    const refStub = { path: "x", sha256: "0".repeat(64), size: 0 };
    const validMigrationPayload = {
      source_schema_version: 1,
      migrated_at: "2026-05-15T10:00:00.000Z",
      artifacts: {
        state: refStub,
        tasks: refStub,
        spec_md: refStub,
        evidence: refStub,
        findings: refStub,
        pending: refStub,
      },
    };

    const human = preflight(
      baseEntry({
        kind: "migration:snapshot_imported",
        actor: "human:est9",
        payload: validMigrationPayload,
      }),
      { sub_state: "TRIAGE.score", tail_seq: -1, ceremony: STANDARD_CEREMONY },
    );
    expect(human.ok).toBe(false);
    if (!human.ok) expect(human.code).toBe("ACTOR_AUTHORITY_VIOLATION");

    const migration = preflight(
      baseEntry({
        kind: "migration:snapshot_imported",
        actor: "migration:v0.0.x→v2",
        payload: validMigrationPayload,
      }),
      { sub_state: "TRIAGE.score", tail_seq: -1, ceremony: STANDARD_CEREMONY },
    );
    expect(migration.ok).toBe(true);
  });

  // ── 5. Transition shared helper (Gate #1) ────────────────────────────
  test("event:phase_advanced uses validateTransition (illegal edge)", () => {
    const result = preflight(
      baseEntry({
        kind: "event:phase_advanced",
        payload: { from: "TRIAGE.score", to: "DONE.delivered" },
      }),
      { sub_state: "TRIAGE.score", tail_seq: -1, ceremony: STANDARD_CEREMONY },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSITION_ILLEGAL");
  });

  // Audit r1 — Blocker #1: event:phase_advanced payload.from MUST match
  // the current cursor; validateTransition only checks edge legality.
  test("event:phase_advanced payload.from mismatches cursor → FROM_CURSOR_MISMATCH", () => {
    const result = preflight(
      baseEntry({
        kind: "event:phase_advanced",
        // payload edge is legal (EXECUTE.work → EXECUTE.done) but cursor
        // sits at TRIAGE.score — preflight must reject.
        payload: { from: "EXECUTE.work", to: "EXECUTE.done" },
      }),
      { sub_state: "TRIAGE.score", tail_seq: -1, ceremony: STANDARD_CEREMONY },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FROM_CURSOR_MISMATCH");
  });

  test("gate:decided uses validateTransition (rev 5.x ceremony fork)", () => {
    // verify-accept gate in deep ceremony → SETTLE.reconcile (OK)
    const deep = preflight(
      baseEntry({
        kind: "gate:decided",
        actor: "human:est9",
        payload: { gate_kind: "verify-accept", decision: "approved", reason: "ok" },
      }),
      { sub_state: "VERIFY.accept", tail_seq: -1, ceremony: DEEP_CEREMONY },
    );
    expect(deep.ok).toBe(true);

    // verify-accept gate in standard ceremony → DONE.delivered (validateTransition
    // picks the legal branch; both should be accepted by the shared helper).
    const standard = preflight(
      baseEntry({
        kind: "gate:decided",
        actor: "human:est9",
        payload: { gate_kind: "verify-accept", decision: "approved", reason: "ok" },
      }),
      { sub_state: "VERIFY.accept", tail_seq: -1, ceremony: STANDARD_CEREMONY },
    );
    expect(standard.ok).toBe(true);
  });
});
