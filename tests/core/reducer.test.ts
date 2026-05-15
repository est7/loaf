// Stage 2 — reducer apply (§11.2 step 7 + ADR-0005 §3.6).
//
// Apply path:
//   1. preflight() validates authority + transition
//   2. apply() narrows on kind, mutates projection (sub_state, spec_locked, iteration)
//   3. Returns Result<Snapshot, ApplyError>
//
// Tests verify the observable state change after apply.

import { describe, expect, test } from "vitest";

import { apply, initialSnapshot } from "../../src/core/reducer.js";
import type { Ceremony } from "../../src/core/journal-entry.js";

const STANDARD_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

describe("reducer.apply — Stage 2 §11.2 step 7", () => {
  test("session:started initializes the snapshot cursor at TRIAGE.score", () => {
    const before = initialSnapshot();
    const result = apply(before, {
      seq: 0,
      entry_id: "JE-000001",
      at: "2026-05-15T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "auth-refresh",
        ceremony: STANDARD_CEREMONY,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.state).not.toBeNull();
      expect(result.snapshot.state!.phase).toBe("TRIAGE");
      expect(result.snapshot.state!.sub_state).toBe("TRIAGE.score");
      expect(result.snapshot.state!.spec_locked).toBe(false);
      expect(result.snapshot.state!.iteration).toBe(1);
      expect(result.snapshot.state!.ceremony.settle_phase).toBe(false);
    }
  });

  test("event:phase_advanced moves the cursor when transition is legal", () => {
    let snapshot = initialSnapshot();

    snapshot = mustOk(
      apply(snapshot, {
        seq: 0,
        entry_id: "JE-000001",
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      }),
    );

    snapshot = mustOk(
      apply(snapshot, {
        seq: 1,
        entry_id: "JE-000002",
        at: "2026-05-15T10:00:01.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: "TRIAGE.score", to: "TRIAGE.confirm" },
      }),
    );

    expect(snapshot.state!.sub_state).toBe("TRIAGE.confirm");
  });

  test("event:phase_advanced on illegal edge returns Result<TRANSITION_ILLEGAL>", () => {
    const after = initialSnapshot();
    let snap = mustOk(
      apply(after, {
        seq: 0,
        entry_id: "JE-000001",
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      }),
    );

    const bad = apply(snap, {
      seq: 1,
      entry_id: "JE-000002",
      at: "2026-05-15T10:00:01.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "event:phase_advanced",
      payload: { from: "TRIAGE.score", to: "DONE.delivered" },
    });

    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("TRANSITION_ILLEGAL");
  });

  test("gate:decided (spec-lock) flips spec_locked=true", () => {
    let snap = initialSnapshot();
    snap = mustOk(
      apply(snap, {
        seq: 0,
        entry_id: "JE-000001",
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      }),
    );

    // Advance: TRIAGE.score → TRIAGE.confirm → SPEC.proposal → SPEC.spec → SPEC.plan → SPEC.design
    const path = [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
    ] as const;
    let seq = 1;
    for (const [from, to] of path) {
      snap = mustOk(
        apply(snap, {
          seq,
          entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
          at: new Date(2026, 4, 15, 10, 0, seq).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from, to },
        }),
      );
      seq++;
    }
    expect(snap.state!.sub_state).toBe("SPEC.design");

    snap = mustOk(
      apply(snap, {
        seq,
        entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
        at: "2026-05-15T11:00:00.000Z",
        actor: "human:est9",
        entry_schema_version: 1,
        kind: "gate:decided",
        payload: { gate_kind: "spec-lock", decision: "approved", reason: "looks good" },
      }),
    );

    expect(snap.state!.sub_state).toBe("EXECUTE.plan");
    expect(snap.state!.spec_locked).toBe(true);
  });

  // Audit r1 Blocker #5: kinds without an apply handler must fail-fast,
  // not no-op silently. event:spec_req_added is one of the still-unimplemented
  // kinds in Phase D MVP — exercise the new contract.
  test("unimplemented EntryKind returns REDUCER_NOT_IMPLEMENTED (fail-fast default)", () => {
    let snap = initialSnapshot();
    snap = mustOk(
      apply(snap, {
        seq: 0,
        entry_id: "JE-000001",
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      }),
    );

    // Advance into SPEC.spec so spec_req_added is sub_state-legal.
    const path = [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
    ] as const;
    let seq = 1;
    for (const [from, to] of path) {
      snap = mustOk(
        apply(snap, {
          seq,
          entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
          at: new Date(2026, 4, 15, 10, 0, seq).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from, to },
        }),
      );
      seq++;
    }

    const result = apply(snap, {
      seq,
      entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
      at: "2026-05-15T10:00:10.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "event:spec_req_added",
      payload: { id: "REQ-001", type: "ubiquitous", response: "test" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REDUCER_NOT_IMPLEMENTED");
  });

  // Audit r3 Medium — REDUCER_IMPLEMENTED_KINDS in journal-entry.ts is
  // manually synced with reducer.ts switch cases. Lock the invariant with
  // a test: every kind in REDUCER_IMPLEMENTED_KINDS must NOT return
  // REDUCER_NOT_IMPLEMENTED when fed a minimal envelope-valid entry.
  test("REDUCER_IMPLEMENTED_KINDS is consistent with reducer.ts switch coverage", async () => {
    const { REDUCER_IMPLEMENTED_KINDS } = await import("../../src/core/journal-entry.js");
    const refStub = { path: "x", sha256: "0".repeat(64), size: 0 };
    const payloadFor: Record<string, unknown> = {
      "session:started": {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "stub",
        ceremony: STANDARD_CEREMONY,
      },
      "migration:snapshot_imported": {
        source_schema_version: 1,
        migrated_at: "2026-05-15T10:00:00.000Z",
        artifacts: {
          state: refStub, tasks: refStub, spec_md: refStub,
          evidence: refStub, findings: refStub, pending: refStub,
        },
      },
      "event:phase_advanced": { from: "TRIAGE.score", to: "TRIAGE.confirm" },
      "event:ceremony_set": STANDARD_CEREMONY,
      "event:tasks_planned": { tasks: [{ id: "T-001" }] },
      "event:task_claimed": { task_id: "T-001" },
      "event:task_step_started": { task_id: "T-001", step: "implement" },
      "event:task_step_done": { task_id: "T-001", step: "implement", result: "passed" },
      "event:task_abandoned": { task_id: "T-001" },
      "evidence:added": { id: "EV-1", kind: "local-check" },
      "finding:raised": { id: "FND-1", category: "spec-gap", action: "amend-spec" },
      "finding:closed": { id: "FND-1" },
      "pending:added": { id: "PEND-1", kind: "ask_user_question" },
      "pending:resolved": { id: "PEND-1" },
      "gate:decided": { gate_kind: "spec-lock", decision: "approved", reason: "ok" },
      "session:delivered": { reason: "test" },
      "session:archived": { reason: "test" },
      "session:abandoned": { reason: "test" },
    };

    for (const kind of REDUCER_IMPLEMENTED_KINDS) {
      const result = apply(initialSnapshot(), {
        seq: 0,
        entry_id: "JE-000001",
        at: "2026-05-15T10:00:00.000Z",
        actor: kind === "migration:snapshot_imported" ? "migration:test" : "cli:loaf",
        entry_schema_version: 1,
        kind,
        payload: payloadFor[kind] ?? { stub: true },
      });
      // The kind may legitimately fail for other reasons (NO_SESSION when
      // state is null, sub_state authority, etc.), but it MUST NOT come
      // back as REDUCER_NOT_IMPLEMENTED — that would mean
      // REDUCER_IMPLEMENTED_KINDS claims coverage the switch lacks.
      if (!result.ok) {
        expect(
          result.code,
          `${kind} declared in REDUCER_IMPLEMENTED_KINDS but reducer.ts switch lacks handler`,
        ).not.toBe("REDUCER_NOT_IMPLEMENTED");
      }
    }
  });

  test("pending FIFO: pending:added then pending:resolved mutates projection", () => {
    let snap = initialSnapshot();
    snap = mustOk(
      apply(snap, {
        seq: 0,
        entry_id: "JE-000001",
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      }),
    );

    snap = mustOk(
      apply(snap, {
        seq: 1,
        entry_id: "JE-000002",
        at: "2026-05-15T10:00:01.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "pending:added",
        payload: { id: "PEND-1", kind: "ask_user_question" },
      }),
    );
    expect(snap.pending).toHaveLength(1);
    expect(snap.pending[0]!.resolved).toBe(false);

    snap = mustOk(
      apply(snap, {
        seq: 2,
        entry_id: "JE-000003",
        at: "2026-05-15T10:00:02.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "pending:resolved",
        payload: { id: "PEND-1" },
      }),
    );
    expect(snap.pending[0]!.resolved).toBe(true);
  });
});

function mustOk<T extends { ok: boolean }>(r: T): Extract<T, { ok: true; snapshot: unknown }>["snapshot"] {
  if (!r.ok) throw new Error(`expected ok, got: ${JSON.stringify(r)}`);
  return (r as unknown as { snapshot: unknown }).snapshot as Extract<T, { ok: true; snapshot: unknown }>["snapshot"];
}
