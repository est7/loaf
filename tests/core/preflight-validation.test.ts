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
import { initialSnapshot, type Snapshot, type TaskState } from "../../src/core/reducer.js";
import type { Ceremony, SubState } from "../../src/core/journal-entry.js";

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

// Slice 1.D: PreflightContext refactored to snapshot single-source. Helper
// constructs a minimal snapshot exposing sub_state / ceremony / verify_accepted
// / tasks without forcing every test to spell out a full SessionState.
function mkSnapshot(
  sub_state: SubState,
  ceremony: Ceremony,
  overrides: { verify_accepted?: boolean; tasks?: TaskState[] } = {},
): Snapshot {
  const phase = sub_state.split(".")[0] as
    | "TRIAGE" | "SPEC" | "EXECUTE" | "VERIFY" | "SETTLE" | "DONE";
  return {
    ...initialSnapshot(),
    state: {
      session_id: "test-session",
      feature: "test",
      phase,
      sub_state,
      iteration: 0,
      spec_locked: false,
      verify_accepted: overrides.verify_accepted ?? false,
      spec_version: 0,
      ceremony,
    },
    tasks: overrides.tasks ?? [],
  };
}

function baseEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 0,
    entry_id: "JE-000001",
    at: "2026-05-15T10:00:00.000Z",
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind: "pending:added",
    payload: { id: "PEND-0001", kind: "ask_user_question", question: "stub" },
    ...overrides,
  };
}

describe("preflight — Stage 2 §11.2 step 3", () => {
  // ── 1. Envelope schema ────────────────────────────────────────────────
  test("invalid envelope (missing kind) → INVALID_ENVELOPE", () => {
    const result = preflight(
      { ...baseEntry(), kind: undefined },
      { snapshot: mkSnapshot("TRIAGE.score", STANDARD_CEREMONY), tail_seq: -1 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_ENVELOPE");
  });

  // ── 2. Monotonic seq ──────────────────────────────────────────────────
  test("seq != tail+1 → SEQ_NOT_MONOTONIC", () => {
    const result = preflight(baseEntry({ seq: 5 }), {
      snapshot: mkSnapshot("TRIAGE.score", STANDARD_CEREMONY),
      tail_seq: -1,
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
      { snapshot: mkSnapshot("TRIAGE.score", STANDARD_CEREMONY), tail_seq: -1 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SUB_STATE_AUTHORITY_VIOLATION");
  });

  test("event:task_step_done in EXECUTE.work → OK (with claimed task seeded)", () => {
    // Slice 2 SC1: preflight step 5e requires task exists + status=in_progress
    // before step_done. Seed a claimed task into the snapshot so this test
    // continues to assert authority-gate behavior (not the new TASK_* refines,
    // which have dedicated coverage below).
    const claimedTask = {
      id: "T-001",
      kind: "behavioral" as const,
      status: "in_progress" as const,
      steps: { implement: { applicability: "must" as const, status: "pending" as const } },
      drives: [],
      depends_on: [],
      labels: [],
    };
    const result = preflight(
      baseEntry({
        kind: "event:task_step_done",
        payload: { task_id: "T-001", step: "implement" },
      }),
      {
        snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [claimedTask] }),
        tail_seq: -1,
      },
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
      { snapshot: mkSnapshot("SPEC.design", STANDARD_CEREMONY), tail_seq: -1 },
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
      { snapshot: mkSnapshot("SPEC.design", STANDARD_CEREMONY), tail_seq: -1 },
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
      { snapshot: mkSnapshot("TRIAGE.score", STANDARD_CEREMONY), tail_seq: -1 },
    );
    expect(human.ok).toBe(false);
    if (!human.ok) expect(human.code).toBe("ACTOR_AUTHORITY_VIOLATION");

    const migration = preflight(
      baseEntry({
        kind: "migration:snapshot_imported",
        actor: "migration:v0.0.x→v2",
        payload: validMigrationPayload,
      }),
      { snapshot: mkSnapshot("TRIAGE.score", STANDARD_CEREMONY), tail_seq: -1 },
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
      { snapshot: mkSnapshot("TRIAGE.score", STANDARD_CEREMONY), tail_seq: -1 },
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
      { snapshot: mkSnapshot("TRIAGE.score", STANDARD_CEREMONY), tail_seq: -1 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FROM_CURSOR_MISMATCH");
  });

  // Slice 1.A: gate:decided no longer drives transitions; it is pinned to
  // gate_kind-specific source sub_state (spec-lock → SPEC.design only;
  // verify-accept → VERIFY.accept only). The per-kind sub_state authority
  // table allows the KIND at both states; this preflight refine enforces
  // the gate_kind ↔ source pairing.
  test("gate:decided spec-lock @ SPEC.design → OK", () => {
    const r = preflight(
      baseEntry({
        kind: "gate:decided",
        actor: "human:est9",
        payload: { gate_kind: "spec-lock", decision: "approved", reason: "ok" },
      }),
      { snapshot: mkSnapshot("SPEC.design", STANDARD_CEREMONY), tail_seq: -1 },
    );
    expect(r.ok).toBe(true);
  });

  test("gate:decided spec-lock @ VERIFY.accept (wrong source) → SUB_STATE_AUTHORITY_VIOLATION", () => {
    const r = preflight(
      baseEntry({
        kind: "gate:decided",
        actor: "human:est9",
        payload: { gate_kind: "spec-lock", decision: "approved", reason: "ok" },
      }),
      { snapshot: mkSnapshot("VERIFY.accept", STANDARD_CEREMONY), tail_seq: -1 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SUB_STATE_AUTHORITY_VIOLATION");
  });

  test("gate:decided verify-accept @ VERIFY.accept → OK (both deep and standard ceremony)", () => {
    // Slice 1.A removed the validateTransition step that used to fork by
    // ceremony.settle_phase; the actual cursor move comes from a separate
    // event:phase_advanced (or `loaf deliver`) in Slice 1.C. So at preflight,
    // both ceremonies are simply OK at VERIFY.accept.
    const deep = preflight(
      baseEntry({
        kind: "gate:decided",
        actor: "human:est9",
        payload: { gate_kind: "verify-accept", decision: "approved", reason: "ok" },
      }),
      { snapshot: mkSnapshot("VERIFY.accept", DEEP_CEREMONY), tail_seq: -1 },
    );
    expect(deep.ok).toBe(true);

    const standard = preflight(
      baseEntry({
        kind: "gate:decided",
        actor: "human:est9",
        payload: { gate_kind: "verify-accept", decision: "approved", reason: "ok" },
      }),
      { snapshot: mkSnapshot("VERIFY.accept", STANDARD_CEREMONY), tail_seq: -1 },
    );
    expect(standard.ok).toBe(true);
  });

  test("gate:decided verify-accept @ SPEC.design (wrong source) → SUB_STATE_AUTHORITY_VIOLATION", () => {
    const r = preflight(
      baseEntry({
        kind: "gate:decided",
        actor: "human:est9",
        payload: { gate_kind: "verify-accept", decision: "approved", reason: "ok" },
      }),
      { snapshot: mkSnapshot("SPEC.design", STANDARD_CEREMONY), tail_seq: -1 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SUB_STATE_AUTHORITY_VIOLATION");
  });

  // ── Slice 1.D — step 5c: `session:delivered` preflight refines ──────
  //
  // `session:delivered` is the only kind that flips the cursor to DONE.delivered
  // (reducer direct cursor flip; no event:phase_advanced). Preflight gates the
  // ceremony / verify_accepted / spike-tasks preconditions of `loaf deliver`.

  const deliverEntry = (overrides: Record<string, unknown> = {}) =>
    baseEntry({
      kind: "session:delivered",
      actor: "human:est9",
      payload: {},
      ...overrides,
    });

  test("session:delivered @ VERIFY.accept + verify_accepted=true + settle_phase=false (standard) → OK", () => {
    const r = preflight(deliverEntry(), {
      snapshot: mkSnapshot("VERIFY.accept", STANDARD_CEREMONY, { verify_accepted: true }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("session:delivered @ VERIFY.accept + verify_accepted=false → DELIVER_NOT_ACCEPTED", () => {
    const r = preflight(deliverEntry(), {
      snapshot: mkSnapshot("VERIFY.accept", STANDARD_CEREMONY, { verify_accepted: false }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DELIVER_NOT_ACCEPTED");
  });

  test("session:delivered @ VERIFY.accept + settle_phase=true (deep) → DELIVER_SETTLE_PHASE_BYPASS", () => {
    // deep ceremony must `loaf settle` first; direct deliver from VERIFY.accept rejected.
    const r = preflight(deliverEntry(), {
      snapshot: mkSnapshot("VERIFY.accept", DEEP_CEREMONY, { verify_accepted: true }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DELIVER_SETTLE_PHASE_BYPASS");
  });

  test("session:delivered @ VERIFY.accept settle_phase check fires BEFORE verify_accepted check", () => {
    // both fail; ceremony bypass surfaces first to match codex r50 ordering
    // (ceremony is a per-profile invariant; the flag is a session-level state).
    const r = preflight(deliverEntry(), {
      snapshot: mkSnapshot("VERIFY.accept", DEEP_CEREMONY, { verify_accepted: false }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DELIVER_SETTLE_PHASE_BYPASS");
  });

  test("session:delivered @ SETTLE.lessons + verify_accepted=true (deep) → OK", () => {
    const r = preflight(deliverEntry(), {
      snapshot: mkSnapshot("SETTLE.lessons", DEEP_CEREMONY, { verify_accepted: true }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("session:delivered @ SETTLE.lessons + verify_accepted=false → DELIVER_NOT_ACCEPTED", () => {
    // Defensive: legal transitions should not reach SETTLE.lessons without
    // verify-accept approval, but preflight catches a journal-inconsistent state.
    const r = preflight(deliverEntry(), {
      snapshot: mkSnapshot("SETTLE.lessons", DEEP_CEREMONY, { verify_accepted: false }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DELIVER_NOT_ACCEPTED");
  });

  test("session:delivered @ EXECUTE.done (quick) → DELIVER_VERIFY_MIN_UNAVAILABLE", () => {
    const QUICK_CEREMONY: Ceremony = {
      spec_phase: false,
      verify_phase: false,
      settle_phase: false,
      strict_spec_review: false,
      lessons_required: "skip",
      strict_drift_check: false,
    };
    const r = preflight(deliverEntry(), {
      snapshot: mkSnapshot("EXECUTE.done", QUICK_CEREMONY),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DELIVER_VERIFY_MIN_UNAVAILABLE");
  });

  test("session:delivered @ VERIFY.accept with non-abandoned spike task → DELIVER_SPIKE_TASKS", () => {
    const spikeTask = {
      id: "T-002",
      kind: "spike" as const,
      status: "in_progress" as const,
      steps: {},
      drives: [],
      depends_on: [],
      labels: [],
    };
    const r = preflight(deliverEntry(), {
      snapshot: mkSnapshot("VERIFY.accept", STANDARD_CEREMONY, {
        verify_accepted: true,
        tasks: [spikeTask],
      }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("DELIVER_SPIKE_TASKS");
      expect(r.detail).toMatchObject({ task_id: "T-002", status: "in_progress" });
    }
  });

  test("session:delivered with abandoned spike task → OK (abandoned bypasses block)", () => {
    const abandonedSpike = {
      id: "T-003",
      kind: "spike" as const,
      status: "abandoned" as const,
      steps: {},
      drives: [],
      depends_on: [],
      labels: [],
    };
    const r = preflight(deliverEntry(), {
      snapshot: mkSnapshot("VERIFY.accept", STANDARD_CEREMONY, {
        verify_accepted: true,
        tasks: [abandonedSpike],
      }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("session:delivered with done spike task → DELIVER_SPIKE_TASKS (codex r49 Q1: status=done still blocks)", () => {
    const doneSpike = {
      id: "T-004",
      kind: "spike" as const,
      status: "done" as const,
      steps: {},
      drives: [],
      depends_on: [],
      labels: [],
    };
    const r = preflight(deliverEntry(), {
      snapshot: mkSnapshot("VERIFY.accept", STANDARD_CEREMONY, {
        verify_accepted: true,
        tasks: [doneSpike],
      }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DELIVER_SPIKE_TASKS");
  });

  test("session:delivered spike-block check fires BEFORE EXECUTE.done verify-min check", () => {
    // EXECUTE.done quick has spike too → spike wins (more actionable diagnostic).
    const QUICK_CEREMONY: Ceremony = {
      spec_phase: false,
      verify_phase: false,
      settle_phase: false,
      strict_spec_review: false,
      lessons_required: "skip",
      strict_drift_check: false,
    };
    const spike = {
      id: "T-005",
      kind: "spike" as const,
      status: "in_progress" as const,
      steps: {},
      drives: [],
      depends_on: [],
      labels: [],
    };
    const r = preflight(deliverEntry(), {
      snapshot: mkSnapshot("EXECUTE.done", QUICK_CEREMONY, { tasks: [spike] }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DELIVER_SPIKE_TASKS");
  });

  // ── Slice 2 SC1 — step 5e: task lifecycle preflight refines ──────────
  //
  // `event:task_claimed` / `event:task_step_started` / `event:task_step_done`
  // payloads carry task_id (+ step). Preflight enforces task existence +
  // claimability + status/deps preconditions. TASK_NOT_FOUND reused from
  // existing reducer-side coverage; 4 new codes added in SC1.

  const makeTask = (
    overrides: Partial<TaskState> & Pick<TaskState, "id" | "kind" | "status">,
  ): TaskState => ({
    steps: {},
    drives: [],
    depends_on: [],
    labels: [],
    ...overrides,
  });

  test("event:task_claimed @ EXECUTE.work + task missing → TASK_NOT_FOUND", () => {
    const r = preflight(
      baseEntry({ kind: "event:task_claimed", payload: { task_id: "T-999" } }),
      { snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [] }), tail_seq: -1 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TASK_NOT_FOUND");
  });

  test("event:task_claimed + task.status=in_progress → TASK_ALREADY_CLAIMED", () => {
    const task = makeTask({ id: "T-001", kind: "behavioral", status: "in_progress" });
    const r = preflight(
      baseEntry({ kind: "event:task_claimed", payload: { task_id: "T-001" } }),
      { snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task] }), tail_seq: -1 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TASK_ALREADY_CLAIMED");
      expect(r.detail).toMatchObject({ task_id: "T-001", status: "in_progress" });
    }
  });

  test("event:task_claimed + task.status=done → TASK_NOT_CLAIMABLE", () => {
    const task = makeTask({ id: "T-001", kind: "behavioral", status: "done" });
    const r = preflight(
      baseEntry({ kind: "event:task_claimed", payload: { task_id: "T-001" } }),
      { snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task] }), tail_seq: -1 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TASK_NOT_CLAIMABLE");
      expect(r.detail).toMatchObject({ task_id: "T-001", status: "done" });
    }
  });

  test("event:task_claimed + task.status=abandoned → TASK_NOT_CLAIMABLE", () => {
    const task = makeTask({ id: "T-001", kind: "behavioral", status: "abandoned" });
    const r = preflight(
      baseEntry({ kind: "event:task_claimed", payload: { task_id: "T-001" } }),
      { snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task] }), tail_seq: -1 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TASK_NOT_CLAIMABLE");
  });

  test("event:task_claimed + deps_on dep not done → TASK_DEPS_NOT_SATISFIED", () => {
    const dep = makeTask({ id: "T-002", kind: "behavioral", status: "in_progress" });
    const task = makeTask({
      id: "T-001",
      kind: "behavioral",
      status: "pending",
      depends_on: ["T-002"],
    });
    const r = preflight(
      baseEntry({ kind: "event:task_claimed", payload: { task_id: "T-001" } }),
      {
        snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task, dep] }),
        tail_seq: -1,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TASK_DEPS_NOT_SATISFIED");
      expect(r.detail).toMatchObject({
        task_id: "T-001",
        blocking_dep: "T-002",
        blocking_status: "in_progress",
      });
    }
  });

  test("event:task_claimed + deps_on dep done → OK", () => {
    const dep = makeTask({ id: "T-002", kind: "behavioral", status: "done" });
    const task = makeTask({
      id: "T-001",
      kind: "behavioral",
      status: "pending",
      depends_on: ["T-002"],
    });
    const r = preflight(
      baseEntry({ kind: "event:task_claimed", payload: { task_id: "T-001" } }),
      {
        snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task, dep] }),
        tail_seq: -1,
      },
    );
    expect(r.ok).toBe(true);
  });

  test("event:task_claimed + deps_on dep missing from projection → TASK_DEPS_NOT_SATISFIED (blocking_status=missing)", () => {
    const task = makeTask({
      id: "T-001",
      kind: "behavioral",
      status: "pending",
      depends_on: ["T-ghost"],
    });
    const r = preflight(
      baseEntry({ kind: "event:task_claimed", payload: { task_id: "T-001" } }),
      {
        snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task] }),
        tail_seq: -1,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TASK_DEPS_NOT_SATISFIED");
      expect(r.detail).toMatchObject({ blocking_dep: "T-ghost", blocking_status: "missing" });
    }
  });

  test("event:task_step_started + task.status=pending → TASK_NOT_CLAIMED", () => {
    const task = makeTask({
      id: "T-001",
      kind: "behavioral",
      status: "pending",
      steps: { implement: { applicability: "must", status: "pending" } },
    });
    const r = preflight(
      baseEntry({
        kind: "event:task_step_started",
        payload: { task_id: "T-001", step: "implement" },
      }),
      { snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task] }), tail_seq: -1 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TASK_NOT_CLAIMED");
      expect(r.detail).toMatchObject({ task_id: "T-001", step: "implement", status: "pending" });
    }
  });

  test("event:task_step_done + task.status=done (auto-promoted) → TASK_NOT_CLAIMED (no re-mutation after promote)", () => {
    const task = makeTask({
      id: "T-001",
      kind: "behavioral",
      status: "done",
      steps: { implement: { applicability: "must", status: "passed" } },
    });
    const r = preflight(
      baseEntry({
        kind: "event:task_step_done",
        payload: { task_id: "T-001", step: "implement", result: "passed" },
      }),
      { snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task] }), tail_seq: -1 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TASK_NOT_CLAIMED");
  });

  test("event:task_step_started + task.status=in_progress + step seeded → OK", () => {
    const task = makeTask({
      id: "T-001",
      kind: "behavioral",
      status: "in_progress",
      steps: { implement: { applicability: "must", status: "pending" } },
    });
    const r = preflight(
      baseEntry({
        kind: "event:task_step_started",
        payload: { task_id: "T-001", step: "implement" },
      }),
      { snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task] }), tail_seq: -1 },
    );
    expect(r.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// event:tasks_amended §8.6 mutation-rights preflight — Slice C SC-C2b.
//
// `tasks amend` at EXECUTE.plan may only change execution[].applicability
// and advance status pending→ready (protocol §8.6). All graph-contract and
// kind-flag fields are frozen. Enforcement is option B (codex r108): the
// diff runs against the slim Snapshot.tasks projection — body-only fields
// (tests/test_layer/evidence_refs/...) are out of preflight reach and
// guarded CLI-side by materializeTaskForAmend (residual risk).
// ─────────────────────────────────────────────────────────────────────────

function behavioralFull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const execStep = (
    applicability: string,
    status = "pending",
  ): Record<string, unknown> => ({ applicability, status, evidence_refs: [] });
  return {
    id: "T-001",
    kind: "behavioral",
    drives: ["REQ-AUTH-001"],
    tests: ["TokenCoord.refreshOnce"],
    status: "pending",
    depends_on: [],
    labels: [],
    execution: {
      red: execStep("must"),
      implement: execStep("must"),
      refactor: execStep("optional"),
    },
    ...overrides,
  };
}

// The slim TaskState that extractTaskSlim(behavioralFull()) projects to —
// the baseline "current" task seeded into the snapshot.
function slimT001(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "T-001",
    kind: "behavioral",
    status: "pending",
    steps: {
      red: { applicability: "must", status: "pending" },
      implement: { applicability: "must", status: "pending" },
      refactor: { applicability: "optional", status: "pending" },
    },
    drives: ["REQ-AUTH-001"],
    depends_on: [],
    labels: [],
    ...overrides,
  };
}

function amendEntry(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return baseEntry({ kind: "event:tasks_amended", payload });
}

describe("preflight — event:tasks_amended §8.6 mutation rights (Slice C SC-C2b)", () => {
  function planCtx(current: TaskState) {
    return {
      snapshot: mkSnapshot("EXECUTE.plan", STANDARD_CEREMONY, { tasks: [current] }),
      tail_seq: -1,
    };
  }

  test("applicability-only change at EXECUTE.plan → OK", () => {
    const incoming = behavioralFull({
      execution: {
        red: { applicability: "must", status: "pending", evidence_refs: [] },
        implement: { applicability: "must", status: "pending", evidence_refs: [] },
        // refactor optional → na: a legal §8.6 applicability mutation.
        refactor: { applicability: "na", status: "pending", evidence_refs: [] },
      },
    });
    const result = preflight(
      amendEntry({ mode: "replace", task: incoming }),
      planCtx(slimT001()),
    );
    expect(result.ok).toBe(true);
  });

  test("status pending→ready at EXECUTE.plan → OK", () => {
    const incoming = behavioralFull({ status: "ready" });
    const result = preflight(
      amendEntry({ mode: "replace", task: incoming }),
      planCtx(slimT001({ status: "pending" })),
    );
    expect(result.ok).toBe(true);
  });

  test("status ready→pending → MUTATION_OUT_OF_RIGHTS", () => {
    const incoming = behavioralFull({ status: "pending" });
    const result = preflight(
      amendEntry({ mode: "replace", task: incoming }),
      planCtx(slimT001({ status: "ready" })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
  });

  test("status in_progress→ready → MUTATION_OUT_OF_RIGHTS", () => {
    const incoming = behavioralFull({ status: "ready" });
    const result = preflight(
      amendEntry({ mode: "replace", task: incoming }),
      planCtx(slimT001({ status: "in_progress" })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
  });

  test("status ready→done → MUTATION_OUT_OF_RIGHTS (codex r108 named example)", () => {
    const incoming = behavioralFull({ status: "done" });
    const result = preflight(
      amendEntry({ mode: "replace", task: incoming }),
      planCtx(slimT001({ status: "ready" })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(result.detail?.["field"]).toBe("status");
    }
  });

  test("kind change behavioral→structural → MUTATION_OUT_OF_RIGHTS", () => {
    // A structural task replacing a behavioral one — kind is the discriminator
    // and is frozen; the diff catches `kind` before the (also-changed) step set.
    const structural = {
      id: "T-001",
      kind: "structural",
      no_test_rationale: "pure rename, no behavior change to test",
      status: "pending",
      depends_on: [],
      labels: [],
      execution: {
        implement: { applicability: "must", status: "pending", evidence_refs: [] },
        refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
      },
    };
    const result = preflight(
      amendEntry({ mode: "replace", task: structural }),
      planCtx(slimT001()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(result.detail?.["field"]).toBe("kind");
    }
  });

  test("drives change → MUTATION_OUT_OF_RIGHTS", () => {
    const incoming = behavioralFull({ drives: ["REQ-AUTH-999"] });
    const result = preflight(
      amendEntry({ mode: "replace", task: incoming }),
      planCtx(slimT001()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(result.detail?.["field"]).toBe("drives");
    }
  });

  test("depends_on change → MUTATION_OUT_OF_RIGHTS", () => {
    const incoming = behavioralFull({ depends_on: ["T-002"] });
    const result = preflight(
      amendEntry({ mode: "replace", task: incoming }),
      planCtx(slimT001()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
  });

  test("labels change → MUTATION_OUT_OF_RIGHTS", () => {
    const incoming = behavioralFull({ labels: ["perf"] });
    const result = preflight(
      amendEntry({ mode: "replace", task: incoming }),
      planCtx(slimT001()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
  });

  test("kind-flag change (red_test_registered) → MUTATION_OUT_OF_RIGHTS", () => {
    const incoming = behavioralFull({ red_test_registered: true });
    const result = preflight(
      amendEntry({ mode: "replace", task: incoming }),
      planCtx(slimT001()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
  });

  test("kind-flag change (requires_visual) → MUTATION_OUT_OF_RIGHTS", () => {
    const incoming = behavioralFull({ requires_visual: true });
    const result = preflight(
      amendEntry({ mode: "replace", task: incoming }),
      planCtx(slimT001()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(result.detail?.["field"]).toBe("requires_visual");
    }
  });

  test("step.status change → MUTATION_OUT_OF_RIGHTS", () => {
    const incoming = behavioralFull({
      execution: {
        red: { applicability: "must", status: "passed", evidence_refs: [] },
        implement: { applicability: "must", status: "pending", evidence_refs: [] },
        refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
      },
    });
    const result = preflight(
      amendEntry({ mode: "replace", task: incoming }),
      planCtx(slimT001()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
  });

  test("step set change vs current projection → MUTATION_OUT_OF_RIGHTS", () => {
    // Current projection (hand-built) is missing `refactor`; the incoming
    // behavioral payload has all 3 — a step-set mismatch preflight rejects.
    const current = slimT001({
      steps: {
        red: { applicability: "must", status: "pending" },
        implement: { applicability: "must", status: "pending" },
      },
    });
    const result = preflight(
      amendEntry({ mode: "replace", task: behavioralFull() }),
      planCtx(current),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
  });

  test("mode='add' is unsponsored in SC-C2b → MUTATION_OUT_OF_RIGHTS", () => {
    const result = preflight(
      amendEntry({ mode: "add", task: behavioralFull({ id: "T-050" }) }),
      planCtx(slimT001()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
  });

  test("mode='replace' outside EXECUTE.plan → MUTATION_OUT_OF_RIGHTS", () => {
    const result = preflight(
      amendEntry({ mode: "replace", task: behavioralFull() }),
      {
        snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [slimT001()] }),
        tail_seq: -1,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
  });

  test("replace on an unknown task id at EXECUTE.plan → TASK_NOT_FOUND", () => {
    const result = preflight(
      amendEntry({ mode: "replace", task: behavioralFull({ id: "T-404" }) }),
      planCtx(slimT001()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TASK_NOT_FOUND");
  });

  test("no-op replace (nothing changed) at EXECUTE.plan → OK", () => {
    const result = preflight(
      amendEntry({ mode: "replace", task: behavioralFull() }),
      planCtx(slimT001()),
    );
    expect(result.ok).toBe(true);
  });
});
