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
import {
  initialSnapshot,
  type FindingState,
  type Snapshot,
  type TaskState,
} from "../../src/core/reducer.js";
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
  overrides: {
    verify_accepted?: boolean;
    tasks?: TaskState[];
    findings?: FindingState[];
  } = {},
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
    findings: overrides.findings ?? [],
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

  test("session:delivered @ EXECUTE.done (quick) done task lacking evidence → DELIVER_VERIFY_MIN_INCOMPLETE", () => {
    const QUICK_CEREMONY: Ceremony = {
      spec_phase: false,
      verify_phase: false,
      settle_phase: false,
      strict_spec_review: false,
      lessons_required: "skip",
      strict_drift_check: false,
    };
    // v0.1.1: verify-min landed. A quick deliver with a done code task that
    // lacks build/test evidence now fails DELIVER_VERIFY_MIN_INCOMPLETE
    // (was the DELIVER_VERIFY_MIN_UNAVAILABLE fail-closed stub).
    const r = preflight(deliverEntry(), {
      snapshot: mkSnapshot("EXECUTE.done", QUICK_CEREMONY, {
        tasks: [
          { id: "T-001", kind: "behavioral", status: "done", steps: {}, drives: [], depends_on: [], labels: [] },
        ],
      }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DELIVER_VERIFY_MIN_INCOMPLETE");
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

  // ── Phase 12 — `spike:converted` precondition (SPIKE_CONVERT_NO_SPIKE_TASK) ──
  //
  // `loaf spike convert` is a spike-task exit (protocol §8.3). Preflight
  // requires the session to hold at least one non-abandoned kind=spike task,
  // so a non-spike session cannot emit a spike:converted audit entry and
  // archive itself — that would make the journal misrepresent the session.

  const spikeConvertEntry = (overrides: Record<string, unknown> = {}) =>
    baseEntry({
      kind: "spike:converted",
      actor: "human:est9",
      payload: { to_feature: "F-002", reason: "carry forward to F-002" },
      ...overrides,
    });

  test("spike:converted with a non-abandoned spike task → OK", () => {
    const spikeTask = {
      id: "T-001", kind: "spike" as const, status: "in_progress" as const,
      steps: {}, drives: [], depends_on: [], labels: [],
    };
    const r = preflight(spikeConvertEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [spikeTask] }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("spike:converted with a done spike task → OK (done is non-abandoned)", () => {
    const spikeTask = {
      id: "T-001", kind: "spike" as const, status: "done" as const,
      steps: {}, drives: [], depends_on: [], labels: [],
    };
    const r = preflight(spikeConvertEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [spikeTask] }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("spike:converted with no tasks → SPIKE_CONVERT_NO_SPIKE_TASK", () => {
    const r = preflight(spikeConvertEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [] }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SPIKE_CONVERT_NO_SPIKE_TASK");
  });

  test("spike:converted with only an abandoned spike task → SPIKE_CONVERT_NO_SPIKE_TASK", () => {
    const abandonedSpike = {
      id: "T-002", kind: "spike" as const, status: "abandoned" as const,
      steps: {}, drives: [], depends_on: [], labels: [],
    };
    const r = preflight(spikeConvertEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [abandonedSpike] }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SPIKE_CONVERT_NO_SPIKE_TASK");
  });

  test("spike:converted with only a non-spike task → SPIKE_CONVERT_NO_SPIKE_TASK", () => {
    const behavioralTask = {
      id: "T-003", kind: "behavioral" as const, status: "in_progress" as const,
      steps: {}, drives: [], depends_on: [], labels: [],
    };
    const r = preflight(spikeConvertEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [behavioralTask] }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SPIKE_CONVERT_NO_SPIKE_TASK");
  });

  // ── Phase 13 — `event:ceremony_set` profile-escalation authorization ──
  //
  // `event:ceremony_set` is freely legal at TRIAGE (the initial ceremony
  // pick). Outside TRIAGE it is legal ONLY as the resolution of a
  // profile_escalation pending — `loaf profile escalate` emits it. Preflight
  // requires the unresolved head to be kind=profile_escalation, else
  // ESCALATION_NOT_PENDING. detail.actual_head feeds the ERROR_CATALOG
  // {actual_head} placeholder.

  const ceremonySetEntry = (overrides: Record<string, unknown> = {}) =>
    baseEntry({
      kind: "event:ceremony_set",
      actor: "human:est9",
      payload: DEEP_CEREMONY,
      ...overrides,
    });
  const pendingHead = (kind: string, resolved = false) => ({
    id: "PEND-0001",
    kind,
    resolved,
  });

  test("event:ceremony_set at TRIAGE.score → OK (initial ceremony pick, unguarded)", () => {
    const r = preflight(ceremonySetEntry(), {
      snapshot: mkSnapshot("TRIAGE.score", STANDARD_CEREMONY),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("event:ceremony_set at SPEC.design with a profile_escalation head → OK", () => {
    const r = preflight(ceremonySetEntry(), {
      snapshot: {
        ...mkSnapshot("SPEC.design", STANDARD_CEREMONY),
        pending: [pendingHead("profile_escalation")],
      },
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("event:ceremony_set at SPEC.design with no pending head → ESCALATION_NOT_PENDING", () => {
    const r = preflight(ceremonySetEntry(), {
      snapshot: mkSnapshot("SPEC.design", STANDARD_CEREMONY),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("ESCALATION_NOT_PENDING");
      expect(r.detail).toMatchObject({ actual_head: "(none)" });
    }
  });

  test("event:ceremony_set at EXECUTE.work with a wrong-kind head → ESCALATION_NOT_PENDING", () => {
    const r = preflight(ceremonySetEntry(), {
      snapshot: {
        ...mkSnapshot("EXECUTE.work", STANDARD_CEREMONY),
        pending: [pendingHead("gate_decision")],
      },
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("ESCALATION_NOT_PENDING");
      expect(r.detail).toMatchObject({ actual_head: "gate_decision" });
    }
  });

  test("event:ceremony_set at SPEC.design with only a resolved profile_escalation → ESCALATION_NOT_PENDING", () => {
    const r = preflight(ceremonySetEntry(), {
      snapshot: {
        ...mkSnapshot("SPEC.design", STANDARD_CEREMONY),
        pending: [pendingHead("profile_escalation", true)],
      },
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ESCALATION_NOT_PENDING");
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

// ─────────────────────────────────────────────────────────────────────────
// Phase 11 Item 3 SC1b — sponsored event:tasks_amended preflight (codex r136).
//
// After a `finding raise --action amend-tasks` back-edge lands the cursor at
// EXECUTE.work, a post-back-edge `tasks amend` / `tasks add` is authorized by
// an explicit `sponsored_by_finding_id` marker on the tasks_amended payload.
// Preflight verifies the marker against snapshot.findings (mirroring the
// back-edge sponsorship precedent: missing/closed/action-mismatch →
// FINDING_NOT_FOUND), pins the surface to EXECUTE.work (Q3), and under valid
// sponsorship enforces the Q4 frozen-field split: identity + execution
// progress (task id / status, per-retained-step status) is FROZEN; graph /
// definition fields + the step set are ALLOWED to change; new steps are born
// unstarted; a progress-bearing step may not be removed.
// ─────────────────────────────────────────────────────────────────────────

describe("preflight — sponsored event:tasks_amended (Phase 11 Item 3 SC1b)", () => {
  const OPEN_AMEND_TASKS: FindingState = {
    id: "FND-001",
    category: "new-scope",
    action: "amend-tasks",
    status: "open",
  };

  function workCtx(
    current: TaskState,
    findings: FindingState[] = [OPEN_AMEND_TASKS],
  ) {
    return {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, {
        tasks: [current],
        findings,
      }),
      tail_seq: -1,
    };
  }

  // ── finding-existence checks (mirror the back-edge sponsorship precedent) ──

  test("sponsored replace, finding missing → FINDING_NOT_FOUND not_found", () => {
    const result = preflight(
      amendEntry({
        mode: "replace",
        task: behavioralFull(),
        sponsored_by_finding_id: "FND-404",
      }),
      workCtx(slimT001()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FINDING_NOT_FOUND");
      expect(result.detail?.["reason"]).toBe("not_found");
    }
  });

  test("sponsored replace, finding closed → FINDING_NOT_FOUND already_closed", () => {
    const result = preflight(
      amendEntry({
        mode: "replace",
        task: behavioralFull(),
        sponsored_by_finding_id: "FND-001",
      }),
      workCtx(slimT001(), [{ ...OPEN_AMEND_TASKS, status: "closed" }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FINDING_NOT_FOUND");
      expect(result.detail?.["reason"]).toBe("already_closed");
    }
  });

  test("sponsored replace, finding action != amend-tasks → FINDING_NOT_FOUND action_mismatch", () => {
    const result = preflight(
      amendEntry({
        mode: "replace",
        task: behavioralFull(),
        sponsored_by_finding_id: "FND-001",
      }),
      workCtx(slimT001(), [{ ...OPEN_AMEND_TASKS, action: "amend-spec" }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FINDING_NOT_FOUND");
      expect(result.detail?.["reason"]).toBe("action_mismatch");
      expect(result.detail?.["expected_action"]).toBe("amend-tasks");
      expect(result.detail?.["actual_action"]).toBe("amend-spec");
    }
  });

  // ── Q3 sub_state surface ──────────────────────────────────────────────────

  test("sponsored replace at EXECUTE.plan → MUTATION_OUT_OF_RIGHTS wrong_sub_state", () => {
    const result = preflight(
      amendEntry({
        mode: "replace",
        task: behavioralFull(),
        sponsored_by_finding_id: "FND-001",
      }),
      {
        snapshot: mkSnapshot("EXECUTE.plan", STANDARD_CEREMONY, {
          tasks: [slimT001()],
          findings: [OPEN_AMEND_TASKS],
        }),
        tail_seq: -1,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(result.detail?.["reason"]).toBe(
        "sponsored_tasks_amended_wrong_sub_state",
      );
    }
  });

  test("sponsored replace at VERIFY.review → MUTATION_OUT_OF_RIGHTS wrong_sub_state", () => {
    const result = preflight(
      amendEntry({
        mode: "replace",
        task: behavioralFull(),
        sponsored_by_finding_id: "FND-001",
      }),
      {
        snapshot: mkSnapshot("VERIFY.review", STANDARD_CEREMONY, {
          tasks: [slimT001()],
          findings: [OPEN_AMEND_TASKS],
        }),
        tail_seq: -1,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(result.detail?.["reason"]).toBe(
        "sponsored_tasks_amended_wrong_sub_state",
      );
    }
  });

  // ── Q4 allowed graph/definition changes under sponsorship ─────────────────

  test("sponsored replace changing graph fields (drives/depends_on/kind-flags) → OK", () => {
    const incoming = behavioralFull({
      drives: ["REQ-AUTH-999"],
      depends_on: ["T-002"],
      labels: ["perf"],
      requires_acceptance: true,
    });
    const result = preflight(
      amendEntry({
        mode: "replace",
        task: incoming,
        sponsored_by_finding_id: "FND-001",
      }),
      workCtx(slimT001()),
    );
    expect(result.ok).toBe(true);
  });

  test("sponsored replace changing the step SET (kind behavioral→visual-ui) → OK", () => {
    // A sponsored replace may re-classify the task: behavioral
    // (red/implement/refactor) → visual-ui (mockup/implement/screenshot-
    // compare). The step set changes; only `implement` is retained (still
    // `pending`); new steps are born `pending`. All slim-projectable.
    const incoming = {
      id: "T-001",
      kind: "visual-ui",
      drives: ["REQ-AUTH-001"],
      status: "pending",
      depends_on: [],
      labels: [],
      visual_contract_refs: ["VIS-UI-001"],
      execution: {
        mockup: { applicability: "must", status: "pending", evidence_refs: [] },
        implement: { applicability: "must", status: "pending", evidence_refs: [] },
        "screenshot-compare": { applicability: "must", status: "pending", evidence_refs: [] },
      },
    };
    const result = preflight(
      amendEntry({
        mode: "replace",
        task: incoming,
        sponsored_by_finding_id: "FND-001",
      }),
      workCtx(slimT001()),
    );
    expect(result.ok).toBe(true);
  });

  test("sponsored replace, applicability change on a retained step → OK", () => {
    const incoming = behavioralFull({
      execution: {
        red: { applicability: "must", status: "pending", evidence_refs: [] },
        implement: { applicability: "must", status: "pending", evidence_refs: [] },
        refactor: { applicability: "na", status: "pending", evidence_refs: [] },
      },
    });
    const result = preflight(
      amendEntry({
        mode: "replace",
        task: incoming,
        sponsored_by_finding_id: "FND-001",
      }),
      workCtx(slimT001()),
    );
    expect(result.ok).toBe(true);
  });

  // ── Q4 FROZEN: identity + execution progress ──────────────────────────────

  test("sponsored replace changing task id → MUTATION_OUT_OF_RIGHTS field=id", () => {
    const incoming = behavioralFull({ id: "T-999" });
    const result = preflight(
      amendEntry({
        mode: "replace",
        task: incoming,
        sponsored_by_finding_id: "FND-001",
      }),
      // current is T-001; the incoming carries a different id — there is no
      // current task to match it. With a sponsored marker the replace targets
      // T-999 which is absent → TASK_NOT_FOUND wins before the frozen check.
      workCtx(slimT001()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TASK_NOT_FOUND");
  });

  test("sponsored replace changing task status (in_progress→pending) → MUTATION_OUT_OF_RIGHTS", () => {
    const incoming = behavioralFull({ status: "pending" });
    const result = preflight(
      amendEntry({
        mode: "replace",
        task: incoming,
        sponsored_by_finding_id: "FND-001",
      }),
      workCtx(slimT001({ status: "in_progress" })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(result.detail?.["field"]).toBe("status");
    }
  });

  test("sponsored replace changing a RETAINED step's status → MUTATION_OUT_OF_RIGHTS", () => {
    // `implement` is `running` in current; the incoming rewinds it to
    // `pending` — erasing execution progress on a retained step.
    const current = slimT001({
      steps: {
        red: { applicability: "must", status: "passed" },
        implement: { applicability: "must", status: "running" },
        refactor: { applicability: "optional", status: "pending" },
      },
    });
    const incoming = behavioralFull({
      execution: {
        red: { applicability: "must", status: "passed", evidence_refs: [] },
        implement: { applicability: "must", status: "pending", evidence_refs: [] },
        refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
      },
    });
    const result = preflight(
      amendEntry({
        mode: "replace",
        task: incoming,
        sponsored_by_finding_id: "FND-001",
      }),
      workCtx(current),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(result.detail?.["field"]).toBe("execution.implement.status");
    }
  });

  test("sponsored replace introducing a new step with a non-pending status → MUTATION_OUT_OF_RIGHTS", () => {
    // A brand-new step (introduced by the kind change behavioral→visual-ui)
    // must be born `pending`; one born `passed` fabricates completed work.
    // `materializeTaskInput` always seeds `pending` — this is the raw-API
    // defense-in-depth case.
    const incoming = {
      id: "T-001",
      kind: "visual-ui",
      drives: ["REQ-AUTH-001"],
      status: "pending",
      depends_on: [],
      labels: [],
      visual_contract_refs: ["VIS-UI-001"],
      execution: {
        mockup: { applicability: "must", status: "passed", evidence_refs: [] },
        implement: { applicability: "must", status: "pending", evidence_refs: [] },
        "screenshot-compare": { applicability: "must", status: "pending", evidence_refs: [] },
      },
    };
    const result = preflight(
      amendEntry({
        mode: "replace",
        task: incoming,
        sponsored_by_finding_id: "FND-001",
      }),
      workCtx(slimT001()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(result.detail?.["field"]).toBe("execution.mockup.status");
    }
  });

  test("sponsored replace removing a PROGRESS-BEARING step → MUTATION_OUT_OF_RIGHTS", () => {
    // The kind change behavioral→structural drops the `red` step. `red` is
    // `passed` in current — removing a step that carries execution history
    // erases progress.
    const current = slimT001({
      steps: {
        red: { applicability: "must", status: "passed" },
        implement: { applicability: "must", status: "passed" },
        refactor: { applicability: "optional", status: "passed" },
      },
    });
    const incoming = {
      id: "T-001",
      kind: "structural",
      drives: ["REQ-AUTH-001"],
      no_test_rationale: "pure rename, no behavior change to test",
      status: "pending",
      depends_on: [],
      labels: [],
      execution: {
        // red removed — but it has a non-pending status in current.
        implement: { applicability: "must", status: "passed", evidence_refs: [] },
        refactor: { applicability: "optional", status: "passed", evidence_refs: [] },
      },
    };
    const result = preflight(
      amendEntry({
        mode: "replace",
        task: incoming,
        sponsored_by_finding_id: "FND-001",
      }),
      workCtx(current),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(result.detail?.["field"]).toBe("execution.red.status");
    }
  });

  test("sponsored replace removing a PENDING step → OK", () => {
    // The kind change behavioral→structural drops the `red` step. `red` is
    // `pending` in current — no progress to erase, removable.
    const incoming = {
      id: "T-001",
      kind: "structural",
      drives: ["REQ-AUTH-001"],
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
      amendEntry({
        mode: "replace",
        task: incoming,
        sponsored_by_finding_id: "FND-001",
      }),
      workCtx(slimT001()),
    );
    expect(result.ok).toBe(true);
  });

  // ── Q5 sponsored mode=add ─────────────────────────────────────────────────

  test("sponsored add of a missing task at EXECUTE.work → OK", () => {
    const result = preflight(
      amendEntry({
        mode: "add",
        task: behavioralFull({ id: "T-050" }),
        sponsored_by_finding_id: "FND-001",
      }),
      workCtx(slimT001()),
    );
    expect(result.ok).toBe(true);
  });

  test("sponsored add of an already-present task id → preflight OK (reducer dry-run rejects)", () => {
    // Duplicate-id detection for mode=add is the reducer's defense-in-depth
    // (reducer.ts tasks_amended branch → DUPLICATE_TASK_ID), not preflight's:
    // preflight authorizes the sponsored add, the mutateBatch reducer dry-run
    // catches the collision. A direct preflight() call therefore returns ok.
    const result = preflight(
      amendEntry({
        mode: "add",
        task: behavioralFull({ id: "T-001" }),
        sponsored_by_finding_id: "FND-001",
      }),
      workCtx(slimT001()),
    );
    expect(result.ok).toBe(true);
  });

  test("sponsored add of a task forged with completed work → MUTATION_OUT_OF_RIGHTS (codex r137 BLOCK 1)", () => {
    // A sponsored add introduces a MISSING task — it must be born fresh.
    // The CLI `tasks add --finding` path builds the task via
    // materializeTaskInput (always fresh), but a raw journal caller could
    // supply a full TaskFullPayload with task.status=done + passed steps +
    // evidence. Stable-core preflight must reject the forgery (Q4: a
    // sponsored amend may not fabricate execution progress).
    const result = preflight(
      amendEntry({
        mode: "add",
        task: behavioralFull({
          id: "T-050",
          status: "done",
          execution: {
            red: { applicability: "must", status: "passed", evidence_refs: ["EV-000001"] },
            implement: { applicability: "must", status: "passed", evidence_refs: ["EV-000002"] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        }),
        sponsored_by_finding_id: "FND-001",
      }),
      workCtx(slimT001()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(result.detail?.["reason"]).toBe("sponsored_add_not_fresh");
      expect(result.detail?.["field"]).toBe("status");
    }
  });

  test("sponsored add of a task whose step carries evidence_refs → MUTATION_OUT_OF_RIGHTS (codex r137 BLOCK 1)", () => {
    // The task is `pending` but a step already holds evidence — fabricated
    // execution history. The per-step scan in firstAddFreshnessViolation
    // catches it even when the task-level status looks fresh.
    const result = preflight(
      amendEntry({
        mode: "add",
        task: behavioralFull({
          id: "T-051",
          execution: {
            red: { applicability: "must", status: "pending", evidence_refs: ["EV-000009"] },
            implement: { applicability: "must", status: "pending", evidence_refs: [] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        }),
        sponsored_by_finding_id: "FND-001",
      }),
      workCtx(slimT001()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(result.detail?.["reason"]).toBe("sponsored_add_not_fresh");
      expect(result.detail?.["field"]).toBe("execution.red.evidence_refs");
    }
  });

  // ── unsponsored paths untouched ───────────────────────────────────────────

  test("unsponsored replace at EXECUTE.work (no marker) → MUTATION_OUT_OF_RIGHTS replace_outside_execute_plan", () => {
    const result = preflight(
      amendEntry({ mode: "replace", task: behavioralFull() }),
      workCtx(slimT001()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(result.detail?.["reason"]).toBe("replace_outside_execute_plan");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice C SC-C4 — bug-task RED registration (R2 invariant relocation).
//
// The bug-RED rule moves from a creation-time schema refine to runtime
// preflight: a behavioral task labelled `bug` may be born without
// red_test_registered, but cannot START or COMPLETE its `implement` step
// until register-red has set the flag (BUG_TASK_REQUIRES_RED, both edges,
// any result — codex r115 Q4). The red flag itself may only be set via a
// red-step task_step_done on a behavioral+bug task (BUG_TASK_FLAG_MISUSE),
// and may not be smuggled in at creation time through event:tasks_planned.
// ─────────────────────────────────────────────────────────────────────────

describe("preflight — bug-task RED registration (Slice C SC-C4)", () => {
  function bugTaskState(overrides: Partial<TaskState> = {}): TaskState {
    return {
      id: "T-001",
      kind: "behavioral",
      status: "in_progress", // claimed — step_started/done require in_progress
      steps: {
        red: { applicability: "must", status: "pending" },
        implement: { applicability: "must", status: "pending" },
        refactor: { applicability: "optional", status: "pending" },
      },
      drives: ["REQ-AUTH-001"],
      depends_on: [],
      labels: ["bug"],
      ...overrides,
    };
  }

  function workCtx(task: TaskState) {
    return {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task] }),
      tail_seq: -1,
    };
  }

  test("task_step_started implement on an unregistered bug task → BUG_TASK_REQUIRES_RED", () => {
    const result = preflight(
      baseEntry({ kind: "event:task_step_started", payload: { task_id: "T-001", step: "implement" } }),
      workCtx(bugTaskState()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BUG_TASK_REQUIRES_RED");
  });

  test("task_step_done implement on an unregistered bug task → BUG_TASK_REQUIRES_RED (direct-done bypass)", () => {
    const result = preflight(
      baseEntry({ kind: "event:task_step_done", payload: { task_id: "T-001", step: "implement" } }),
      workCtx(bugTaskState()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BUG_TASK_REQUIRES_RED");
  });

  test("task_step_done implement result=failed on unregistered bug task → still BUG_TASK_REQUIRES_RED", () => {
    const result = preflight(
      baseEntry({
        kind: "event:task_step_done",
        payload: { task_id: "T-001", step: "implement", result: "failed" },
      }),
      workCtx(bugTaskState()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BUG_TASK_REQUIRES_RED");
  });

  test("task_step_started implement on a registered bug task → OK", () => {
    const result = preflight(
      baseEntry({ kind: "event:task_step_started", payload: { task_id: "T-001", step: "implement" } }),
      workCtx(bugTaskState({ red_test_registered: true })),
    );
    expect(result.ok).toBe(true);
  });

  test("task_step_started implement on a non-bug behavioral task → OK (no RED requirement)", () => {
    const result = preflight(
      baseEntry({ kind: "event:task_step_started", payload: { task_id: "T-001", step: "implement" } }),
      workCtx(bugTaskState({ labels: [] })),
    );
    expect(result.ok).toBe(true);
  });

  test("task_step_started red on an unregistered bug task → OK (red precedes implement)", () => {
    const result = preflight(
      baseEntry({ kind: "event:task_step_started", payload: { task_id: "T-001", step: "red" } }),
      workCtx(bugTaskState()),
    );
    expect(result.ok).toBe(true);
  });

  test("register-red shape: task_step_done step=red result=passed red_test_registered=true → OK", () => {
    const result = preflight(
      baseEntry({
        kind: "event:task_step_done",
        payload: { task_id: "T-001", step: "red", result: "passed", red_test_registered: true },
      }),
      workCtx(bugTaskState()),
    );
    expect(result.ok).toBe(true);
  });

  test("BUG_TASK_FLAG_MISUSE: red_test_registered=true on a non-red step", () => {
    const result = preflight(
      baseEntry({
        kind: "event:task_step_done",
        payload: { task_id: "T-001", step: "implement", result: "passed", red_test_registered: true },
      }),
      workCtx(bugTaskState({ red_test_registered: true })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BUG_TASK_FLAG_MISUSE");
  });

  test("BUG_TASK_FLAG_MISUSE: red_test_registered=true with result=failed", () => {
    const result = preflight(
      baseEntry({
        kind: "event:task_step_done",
        payload: { task_id: "T-001", step: "red", result: "failed", red_test_registered: true },
      }),
      workCtx(bugTaskState()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BUG_TASK_FLAG_MISUSE");
  });

  test("BUG_TASK_FLAG_MISUSE: red_test_registered=true on a non-bug behavioral task", () => {
    const result = preflight(
      baseEntry({
        kind: "event:task_step_done",
        payload: { task_id: "T-001", step: "red", result: "passed", red_test_registered: true },
      }),
      workCtx(bugTaskState({ labels: [] })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BUG_TASK_FLAG_MISUSE");
  });

  test("BUG_TASK_FLAG_MISUSE: event:tasks_planned carrying a task with red_test_registered=true", () => {
    // Creation-time flag smuggling — codex r115 BLOCK 1. The bug task must
    // be born unregistered; register-red is the only path to the flag.
    const plannedBug = {
      id: "T-001",
      kind: "behavioral",
      drives: ["REQ-AUTH-001"],
      tests: ["Bug.repro"],
      status: "pending",
      depends_on: [],
      labels: ["bug"],
      red_test_registered: true,
      execution: {
        red: { applicability: "must", status: "pending", evidence_refs: [] },
        implement: { applicability: "must", status: "pending", evidence_refs: [] },
        refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
      },
    };
    const result = preflight(
      baseEntry({
        kind: "event:tasks_planned",
        payload: { based_on: { spec: 1 }, tasks: [plannedBug] },
      }),
      { snapshot: mkSnapshot("SPEC.design", STANDARD_CEREMONY), tail_seq: -1 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BUG_TASK_FLAG_MISUSE");
  });

  // ── F-016 — EXECUTE.work → EXECUTE.done all-tasks-final guard ─────────
  //
  // protocol defines EXECUTE.done as "all tasks reached a final status".
  // The preflight refine rejects the plain forward edge when any task is
  // non-final (pending / ready / in_progress); done + abandoned are
  // final; zero tasks passes vacuously (quick ceremony reaches
  // EXECUTE.done with no task graph). The guard only reads task.status,
  // so this builder leaves steps empty.
  const f016Task = (id: string, status: TaskState["status"]): TaskState => ({
    id,
    kind: "behavioral",
    status,
    steps: {},
    drives: [],
    depends_on: [],
    labels: [],
  });

  const executeDoneEntry = () =>
    baseEntry({
      kind: "event:phase_advanced",
      payload: { from: "EXECUTE.work", to: "EXECUTE.done" },
    });

  for (const status of ["pending", "ready", "in_progress"] as const) {
    test(`event:phase_advanced EXECUTE.work→EXECUTE.done + a ${status} task → EXECUTE_DONE_TASKS_NOT_FINAL`, () => {
      const r = preflight(executeDoneEntry(), {
        snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, {
          tasks: [f016Task("T-001", status)],
        }),
        tail_seq: -1,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("EXECUTE_DONE_TASKS_NOT_FINAL");
        expect(r.detail).toMatchObject({
          count: 1,
          non_final: [{ task_id: "T-001", status }],
        });
      }
    });
  }

  test("event:phase_advanced EXECUTE.work→EXECUTE.done + all tasks done → ok", () => {
    const r = preflight(executeDoneEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, {
        tasks: [f016Task("T-001", "done"), f016Task("T-002", "done")],
      }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("event:phase_advanced EXECUTE.work→EXECUTE.done + done + abandoned → ok", () => {
    const r = preflight(executeDoneEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, {
        tasks: [f016Task("T-001", "done"), f016Task("T-002", "abandoned")],
      }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("event:phase_advanced EXECUTE.work→EXECUTE.done + zero tasks → ok (vacuous)", () => {
    const r = preflight(executeDoneEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [] }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("EXECUTE_DONE_TASKS_NOT_FINAL detail lists every non-final task in order", () => {
    const r = preflight(executeDoneEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, {
        tasks: [
          f016Task("T-001", "done"),
          f016Task("T-002", "in_progress"),
          f016Task("T-003", "pending"),
        ],
      }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("EXECUTE_DONE_TASKS_NOT_FINAL");
      expect(r.detail).toMatchObject({
        count: 2,
        non_final: [
          { task_id: "T-002", status: "in_progress" },
          { task_id: "T-003", status: "pending" },
        ],
      });
    }
  });

  test("the guard is scoped to EXECUTE.work→EXECUTE.done — an unrelated edge is unaffected", () => {
    // a pending task does not block, e.g., SPEC.plan → SPEC.design.
    const r = preflight(
      baseEntry({
        kind: "event:phase_advanced",
        payload: { from: "SPEC.plan", to: "SPEC.design" },
      }),
      {
        snapshot: mkSnapshot("SPEC.plan", STANDARD_CEREMONY, {
          tasks: [f016Task("T-001", "pending")],
        }),
        tail_seq: -1,
      },
    );
    expect(r.ok).toBe(true);
  });
});

describe("preflight — event:task_abandoned refines (Item 1)", () => {
  // `loaf tasks abandon <T-N> --reason "..."` emits `event:task_abandoned`.
  // Per-kind already gates actor (ALL_NON_MIGRATION) + sub_state
  // (EXECUTE.work). These tests cover the new (5e.3) refine:
  //   - task must exist in snapshot.tasks → else TASK_NOT_FOUND
  //   - task.status ∉ {done, abandoned} → else TASK_NOT_ABANDONABLE
  //   - no non-terminal direct dependent → else TASK_ABANDON_BLOCKED_DEPENDENTS
  // INVALID_PAYLOAD for empty / missing reason rides the PER_KIND_PAYLOAD
  // parse (TaskAbandonedPayload requires reason: z.string().min(1)).

  const mkTask = (
    overrides: Partial<TaskState> & Pick<TaskState, "id" | "kind" | "status">,
  ): TaskState => ({
    steps: {},
    drives: [],
    depends_on: [],
    labels: [],
    ...overrides,
  });

  const abandonEntry = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> =>
    baseEntry({
      kind: "event:task_abandoned",
      payload: { task_id: "T-001", reason: "out of scope", ...overrides },
    });

  test("pending task @ EXECUTE.work → ok", () => {
    const task = mkTask({ id: "T-001", kind: "behavioral", status: "pending" });
    const r = preflight(abandonEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task] }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("ready task @ EXECUTE.work → ok", () => {
    const task = mkTask({ id: "T-001", kind: "behavioral", status: "ready" });
    const r = preflight(abandonEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task] }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("in_progress task @ EXECUTE.work → ok", () => {
    const task = mkTask({ id: "T-001", kind: "behavioral", status: "in_progress" });
    const r = preflight(abandonEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task] }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("task missing from projection → TASK_NOT_FOUND", () => {
    const r = preflight(abandonEntry({ task_id: "T-999" }), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [] }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TASK_NOT_FOUND");
      expect(r.detail).toMatchObject({ task_id: "T-999", kind: "event:task_abandoned" });
    }
  });

  test("task.status=done → TASK_NOT_ABANDONABLE", () => {
    const task = mkTask({ id: "T-001", kind: "behavioral", status: "done" });
    const r = preflight(abandonEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task] }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TASK_NOT_ABANDONABLE");
      expect(r.detail).toMatchObject({ task_id: "T-001", status: "done" });
    }
  });

  test("task.status=abandoned → TASK_NOT_ABANDONABLE", () => {
    const task = mkTask({ id: "T-001", kind: "behavioral", status: "abandoned" });
    const r = preflight(abandonEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task] }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TASK_NOT_ABANDONABLE");
      expect(r.detail).toMatchObject({ task_id: "T-001", status: "abandoned" });
    }
  });

  test("empty reason → INVALID_PAYLOAD", () => {
    const task = mkTask({ id: "T-001", kind: "behavioral", status: "pending" });
    const r = preflight(abandonEntry({ reason: "" }), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task] }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PAYLOAD");
  });

  test("missing reason → INVALID_PAYLOAD", () => {
    const task = mkTask({ id: "T-001", kind: "behavioral", status: "pending" });
    const r = preflight(
      baseEntry({ kind: "event:task_abandoned", payload: { task_id: "T-001" } }),
      {
        snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { tasks: [task] }),
        tail_seq: -1,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PAYLOAD");
  });

  test("task with a non-terminal direct dependent → TASK_ABANDON_BLOCKED_DEPENDENTS", () => {
    const parent = mkTask({ id: "T-001", kind: "behavioral", status: "pending" });
    const child = mkTask({
      id: "T-002",
      kind: "behavioral",
      status: "pending",
      depends_on: ["T-001"],
    });
    const r = preflight(abandonEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, {
        tasks: [parent, child],
      }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TASK_ABANDON_BLOCKED_DEPENDENTS");
      expect(r.detail).toMatchObject({
        task_id: "T-001",
        blocking_dependents: ["T-002"],
      });
    }
  });

  test("task whose only dependent is done → ok", () => {
    const parent = mkTask({ id: "T-001", kind: "behavioral", status: "pending" });
    const child = mkTask({
      id: "T-002",
      kind: "behavioral",
      status: "done",
      depends_on: ["T-001"],
    });
    const r = preflight(abandonEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, {
        tasks: [parent, child],
      }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("task whose only dependent is abandoned → ok", () => {
    const parent = mkTask({ id: "T-001", kind: "behavioral", status: "pending" });
    const child = mkTask({
      id: "T-002",
      kind: "behavioral",
      status: "abandoned",
      depends_on: ["T-001"],
    });
    const r = preflight(abandonEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, {
        tasks: [parent, child],
      }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("wrong sub_state (EXECUTE.plan) → SUB_STATE_AUTHORITY_VIOLATION", () => {
    const task = mkTask({ id: "T-001", kind: "behavioral", status: "pending" });
    const r = preflight(abandonEntry(), {
      snapshot: mkSnapshot("EXECUTE.plan", STANDARD_CEREMONY, { tasks: [task] }),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SUB_STATE_AUTHORITY_VIOLATION");
  });
});

describe("preflight — session:archived / session:abandoned reason-required (Item 2)", () => {
  // `loaf archive --reason "..."` / `loaf abandon --reason "..."` emit
  // `session:archived` / `session:abandoned`. Both kinds share
  // SessionReasonPayload with `session:delivered`, where `reason` is
  // OPTIONAL. The (5c.2) refine tightens archive / abandon to required:
  //   - reason key absent → SESSION_REASON_REQUIRED (exit 2)
  //   - empty-string reason → INVALID_PAYLOAD (rides the PER_KIND_PAYLOAD
  //     parse, z.string().min(1)) — not this refine's job
  //   - session:delivered with no reason stays OK (deliver is optional)
  // Per-kind already gates actor (HUMAN_ONLY) + sub_state (ANY_NON_DONE).

  const archiveEntry = (overrides: Record<string, unknown> = {}) =>
    baseEntry({
      kind: "session:archived",
      actor: "human:est9",
      payload: { reason: "spike kept for reference" },
      ...overrides,
    });

  const abandonEntry = (overrides: Record<string, unknown> = {}) =>
    baseEntry({
      kind: "session:abandoned",
      actor: "human:est9",
      payload: { reason: "no value, dropping" },
      ...overrides,
    });

  test("session:archived missing reason → SESSION_REASON_REQUIRED", () => {
    const r = preflight(archiveEntry({ payload: {} }), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("SESSION_REASON_REQUIRED");
      expect(r.detail).toMatchObject({ kind: "session:archived" });
    }
  });

  test("session:abandoned missing reason → SESSION_REASON_REQUIRED", () => {
    const r = preflight(abandonEntry({ payload: {} }), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("SESSION_REASON_REQUIRED");
      expect(r.detail).toMatchObject({ kind: "session:abandoned" });
    }
  });

  test("session:archived with a reason @ TRIAGE.score → ok", () => {
    const r = preflight(archiveEntry(), {
      snapshot: mkSnapshot("TRIAGE.score", STANDARD_CEREMONY),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("session:abandoned with a reason @ EXECUTE.work → ok", () => {
    const r = preflight(abandonEntry(), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY),
      tail_seq: -1,
    });
    expect(r.ok).toBe(true);
  });

  test("session:archived empty-string reason → INVALID_PAYLOAD (payload parse, not this refine)", () => {
    const r = preflight(archiveEntry({ payload: { reason: "" } }), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PAYLOAD");
  });

  test("session:archived from a DONE sub_state → SUB_STATE_AUTHORITY_VIOLATION", () => {
    const r = preflight(archiveEntry(), {
      snapshot: mkSnapshot("DONE.delivered", STANDARD_CEREMONY),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SUB_STATE_AUTHORITY_VIOLATION");
  });

  test("session:abandoned from a DONE sub_state → SUB_STATE_AUTHORITY_VIOLATION", () => {
    const r = preflight(abandonEntry(), {
      snapshot: mkSnapshot("DONE.archived", STANDARD_CEREMONY),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SUB_STATE_AUTHORITY_VIOLATION");
  });

  test("session:archived with a non-human actor → ACTOR_AUTHORITY_VIOLATION", () => {
    const r = preflight(archiveEntry({ actor: "cli:loaf" }), {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY),
      tail_seq: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ACTOR_AUTHORITY_VIOLATION");
  });

  test("regression: session:delivered with NO reason stays OK (deliver is reason-optional)", () => {
    const r = preflight(
      baseEntry({
        kind: "session:delivered",
        actor: "human:est9",
        payload: {},
      }),
      {
        snapshot: mkSnapshot("VERIFY.accept", STANDARD_CEREMONY, { verify_accepted: true }),
        tail_seq: -1,
      },
    );
    expect(r.ok).toBe(true);
  });
});
