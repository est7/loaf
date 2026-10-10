// Stage 2 — reducer apply (§11.2 step 7 + ADR-0005 §3.6).
//
// Apply path:
//   1. preflight() validates authority + transition
//   2. apply() narrows on kind, mutates projection (sub_state, spec_locked, iteration)
//   3. Returns Result<Snapshot, ApplyError>
//
// Tests verify the observable state change after apply.

import { describe, expect, test } from "vitest";

import { admitEntry } from "../../src/core/entry-admission.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import type { Ceremony, JournalEntry } from "../../src/core/journal-entry.js";

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
    const result = admitEntry(
      before,
      {
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
      },
      { kind: "replay" },
    );

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
      admitEntry(
        snapshot,
        {
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
        },
        { kind: "replay" },
      ),
    );

    snapshot = mustOk(
      admitEntry(
        snapshot,
        {
          seq: 1,
          entry_id: "JE-000002",
          at: "2026-05-15T10:00:01.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: "TRIAGE.score", to: "TRIAGE.confirm" },
        },
        { kind: "replay" },
      ),
    );

    expect(snapshot.state!.sub_state).toBe("TRIAGE.confirm");
  });

  test("event:phase_advanced on illegal edge returns Result<TRANSITION_ILLEGAL>", () => {
    const after = initialSnapshot();
    let snap = mustOk(
      admitEntry(
        after,
        {
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
        },
        { kind: "replay" },
      ),
    );

    const bad = admitEntry(
      snap,
      {
        seq: 1,
        entry_id: "JE-000002",
        at: "2026-05-15T10:00:01.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: "TRIAGE.score", to: "DONE.delivered" },
      },
      { kind: "replay" },
    );

    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("TRANSITION_ILLEGAL");
  });

  test("gate:decided (spec-lock approved) flips spec_locked=true but does NOT move cursor (Slice 1.A normalization)", () => {
    let snap = initialSnapshot();
    snap = mustOk(
      admitEntry(
        snap,
        {
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
        },
        { kind: "replay" },
      ),
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
        admitEntry(
          snap,
          {
            seq,
            entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
            at: new Date(2026, 4, 15, 10, 0, seq).toISOString(),
            actor: "cli:loaf",
            entry_schema_version: 1,
            kind: "event:phase_advanced",
            payload: { from, to },
          },
          { kind: "replay" },
        ),
      );
      seq++;
    }
    expect(snap.state!.sub_state).toBe("SPEC.design");

    snap = mustOk(
      admitEntry(
        snap,
        {
          seq,
          entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
          at: "2026-05-15T11:00:00.000Z",
          actor: "human:est9",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "spec-lock", decision: "approved", reason: "looks good" },
        },
        { kind: "replay" },
      ),
    );

    // Slice 1.A: gate records approval flag, cursor stays where it was.
    // A separate event:phase_advanced is required to leave SPEC.design.
    expect(snap.state!.sub_state).toBe("SPEC.design");
    expect(snap.state!.spec_locked).toBe(true);

    // The cursor moves only via event:phase_advanced (now legal because the
    // batch peer would have run in mutateBatch; here we apply it directly
    // for the unit test).
    snap = mustOk(
      admitEntry(
        snap,
        {
          seq: seq + 1,
          entry_id: `JE-${String(seq + 2).padStart(6, "0")}`,
          at: "2026-05-15T11:00:01.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: "SPEC.design", to: "EXECUTE.plan" },
        },
        { kind: "replay" },
      ),
    );
    expect(snap.state!.sub_state).toBe("EXECUTE.plan");
    expect(snap.state!.spec_locked).toBe(true);
  });

  test("gate:decided (spec-lock rejected) does NOT flip spec_locked", () => {
    let snap = initialSnapshot();
    snap = mustOk(
      admitEntry(
        snap,
        {
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
        },
        { kind: "replay" },
      ),
    );
    // Walk to SPEC.design where spec-lock is sub_state-legal.
    let seq = 1;
    for (const [from, to] of [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
    ] as const) {
      snap = mustOk(
        admitEntry(
          snap,
          {
            seq,
            entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
            at: new Date(2026, 4, 15, 10, 0, seq).toISOString(),
            actor: "cli:loaf",
            entry_schema_version: 1,
            kind: "event:phase_advanced",
            payload: { from, to },
          },
          { kind: "replay" },
        ),
      );
      seq++;
    }
    snap = mustOk(
      admitEntry(
        snap,
        {
          seq,
          entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
          at: "2026-05-15T11:00:00.000Z",
          actor: "human:est9",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "spec-lock", decision: "rejected", reason: "needs more detail" },
        },
        { kind: "replay" },
      ),
    );
    expect(snap.state!.sub_state).toBe("SPEC.design");
    expect(snap.state!.spec_locked).toBe(false);
  });

  test("gate:decided (verify-accept approved) flips verify_accepted=true, no cursor move", () => {
    let snap = initialSnapshot();
    snap = mustOk(
      admitEntry(
        snap,
        {
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
        },
        { kind: "replay" },
      ),
    );
    // Verify the new verify_accepted flag exists and starts false.
    expect(snap.state!.verify_accepted).toBe(false);

    // Walk to VERIFY.accept the long way. Use the direct apply() path; details
    // mirror the spec-lock test.
    let seq = 1;
    for (const [from, to] of [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
      ["SPEC.design", "EXECUTE.plan"],
      ["EXECUTE.plan", "EXECUTE.work"],
      ["EXECUTE.work", "EXECUTE.done"],
      ["EXECUTE.done", "VERIFY.plan"],
      ["VERIFY.plan", "VERIFY.run"],
      ["VERIFY.run", "VERIFY.accept"],
    ] as const) {
      // W1: the spec-lock gate is enforced on the SPEC.design → EXECUTE.plan
      // advance. Lock the spec first (gate:decided spec-lock approved at
      // SPEC.design — human actor, does NOT move the cursor per Slice 1.A).
      if (from === "SPEC.design" && to === "EXECUTE.plan") {
        snap = mustOk(
          admitEntry(
            snap,
            {
              seq,
              entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
              at: new Date(2026, 4, 15, 10, 0, seq).toISOString(),
              actor: "human:est9",
              entry_schema_version: 1,
              kind: "gate:decided",
              payload: { gate_kind: "spec-lock", decision: "approved", reason: "seed" },
            },
            { kind: "replay" },
          ),
        );
        seq++;
      }
      snap = mustOk(
        admitEntry(
          snap,
          {
            seq,
            entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
            at: new Date(2026, 4, 15, 10, 0, seq).toISOString(),
            actor: "cli:loaf",
            entry_schema_version: 1,
            kind: "event:phase_advanced",
            payload: { from, to },
          },
          { kind: "replay" },
        ),
      );
      seq++;
    }
    snap = mustOk(
      admitEntry(
        snap,
        {
          seq,
          entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
          at: "2026-05-15T12:00:00.000Z",
          actor: "human:est9",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "verify-accept", decision: "approved", reason: "ship it" },
        },
        { kind: "replay" },
      ),
    );
    expect(snap.state!.sub_state).toBe("VERIFY.accept");
    expect(snap.state!.verify_accepted).toBe(true);
  });

  // Phase 16 SC-13b — `session:resumed` is now a typed reducer no-op
  // (codex r343 P3 + r345 P2 lock). Replaces the previous "still
  // unimplemented" test that used session:resumed as the placeholder.
  test("session:resumed reducer no-op: snapshot unchanged after apply", () => {
    let snap = initialSnapshot();
    snap = mustOk(
      admitEntry(
        snap,
        {
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
        },
        { kind: "replay" },
      ),
    );

    const before = JSON.stringify(snap);
    const result = admitEntry(
      snap,
      {
        seq: 1,
        entry_id: "JE-000002",
        at: "2026-05-15T10:00:10.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:resumed",
        payload: {
          resumed_from_pack: {
            at: "2026-05-15T09:00:00.000Z",
            reason: "context overflow approaching at SPEC.spec",
            session_id: "550e8400-e29b-41d4-a716-446655440000",
          },
        },
      },
      { kind: "replay" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(JSON.stringify(result.snapshot)).toBe(before);
  });

  // These entries record journal facts without changing the slim snapshot.
  // Use an active session and valid payloads so admission reaches each case.
  const recordOnlyEntries: Array<Pick<JournalEntry, "kind" | "actor" | "payload">> = [
    {
      kind: "session:resumed",
      actor: "cli:loaf",
      payload: {
        resumed_from_pack: {
          at: "2026-05-15T09:00:00.000Z",
          reason: "Continuing from a resume pack",
          session_id: "550e8400-e29b-41d4-a716-446655440000",
        },
      },
    },
    {
      kind: "lesson:recorded",
      actor: "human:est9",
      payload: {
        id: "LSN-001",
        iteration: 1,
        reason: "Record the verified lesson",
        summary: "A useful lesson",
      },
    },
    { kind: "scope:recorded", actor: "cli:loaf", payload: { iteration: 1, paths: ["src/a.ts"] } },
    {
      kind: "spike:converted",
      actor: "human:est9",
      payload: { to_feature: "F-001", reason: "Promote the spike" },
    },
  ];
  for (const mode of ["mutation", "replay"] as const) {
    test.each(recordOnlyEntries)(`$kind preserves the active snapshot in ${mode}`, (partial) => {
      const snap = mustOk(
        admitEntry(
          initialSnapshot(),
          {
            seq: 0,
            entry_id: "JE-000001",
            at: "2026-05-15T10:00:00.000Z",
            actor: "cli:loaf",
            entry_schema_version: 1,
            kind: "session:started",
            payload: {
              session_id: "550e8400-e29b-41d4-a716-446655440000",
              feature: "spike",
              ceremony: STANDARD_CEREMONY,
            },
          },
          { kind: "mutation", tail_seq: -1 },
        ),
      );
      // Representative authority anchor; task state is a valid unstarted spike.
      snap.state = { ...snap.state!, phase: "EXECUTE", sub_state: "EXECUTE.work" };
      snap.tasks = [
        {
          id: "T-001",
          kind: "spike",
          status: "pending",
          drives: [],
          depends_on: [],
          labels: [],
          no_test_rationale: "Exploratory work without a behavior contract",
          steps: {
            explore: { applicability: "must", status: "pending" },
            prototype: { applicability: "optional", status: "pending" },
            record: { applicability: "must", status: "pending" },
          },
        },
      ];
      const before = structuredClone(snap);
      const result = admitEntry(
        snap,
        {
          ...partial,
          seq: 1,
          entry_id: "JE-000002",
          at: "2026-05-15T10:00:10.000Z",
          entry_schema_version: 1,
        },
        mode === "mutation" ? { kind: mode, tail_seq: 0 } : { kind: mode },
      );
      expect(result).toEqual({ ok: true, snapshot: before });
    });
  }

  test("pending FIFO: pending:added then pending:resolved mutates projection", () => {
    let snap = initialSnapshot();
    snap = mustOk(
      admitEntry(
        snap,
        {
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
        },
        { kind: "replay" },
      ),
    );

    snap = mustOk(
      admitEntry(
        snap,
        {
          seq: 1,
          entry_id: "JE-000002",
          at: "2026-05-15T10:00:01.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "pending:added",
          payload: { id: "PEND-0001", kind: "ask_user_question", question: "stub" },
        },
        { kind: "replay" },
      ),
    );
    expect(snap.pending).toHaveLength(1);
    expect(snap.pending[0]!.resolved).toBe(false);

    snap = mustOk(
      admitEntry(
        snap,
        {
          seq: 2,
          entry_id: "JE-000003",
          at: "2026-05-15T10:00:02.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "pending:resolved",
          payload: { id: "PEND-0001" },
        },
        { kind: "replay" },
      ),
    );
    expect(snap.pending[0]!.resolved).toBe(true);
  });

  test("bootstrap and pending failures carry catalog-required detail", () => {
    const startedEntry = {
      seq: 0,
      entry_id: "JE-000001",
      at: "2026-05-15T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started" as const,
      payload: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "auth-refresh",
        ceremony: STANDARD_CEREMONY,
      },
    };
    const started = admitEntry(initialSnapshot(), startedEntry, { kind: "replay" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const duplicate = admitEntry(started.snapshot, startedEntry, { kind: "replay" });
    expect(duplicate).toMatchObject({
      ok: false,
      code: "ALREADY_STARTED",
      detail: { kind: "session:started" },
    });

    const missing = admitEntry(
      started.snapshot,
      {
        ...startedEntry,
        seq: 1,
        entry_id: "JE-000002",
        kind: "pending:resolved",
        payload: { id: "PEND-0404" },
      },
      { kind: "replay" },
    );
    expect(missing).toMatchObject({
      ok: false,
      code: "PENDING_NOT_FOUND",
      detail: { reason: "no pending head" },
    });
  });
});

function mustOk<T extends { ok: boolean }>(
  r: T,
): Extract<T, { ok: true; snapshot: unknown }>["snapshot"] {
  if (!r.ok) throw new Error(`expected ok, got: ${JSON.stringify(r)}`);
  return (r as unknown as { snapshot: unknown }).snapshot as Extract<
    T,
    { ok: true; snapshot: unknown }
  >["snapshot"];
}
