// Phase 16 SC-13a — pure tests for buildResumePack.

import { describe, expect, test } from "vitest";

import { buildResumePack } from "../../src/cli/build-resume-pack.js";
import { ResumePack, RESUME_PACK_RECENT_CAP } from "../../src/core/resume-pack-schema.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import type {
  EvidenceState,
  FindingState,
  Snapshot,
  TaskState,
  SessionState,
} from "../../src/core/reducer.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";

const NOW = "2026-05-29T07:00:00.000Z";
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

function makeState(): SessionState {
  return {
    session_id: SESSION_ID,
    feature: "auth-refresh",
    phase: "EXECUTE",
    sub_state: "EXECUTE.work",
    iteration: 1,
    spec_locked: true,
    verify_accepted: false,
    spec_version: 1,
    ceremony: {
      spec_phase: true,
      verify_phase: true,
      settle_phase: false,
      strict_spec_review: false,
      lessons_required: "skip",
      strict_drift_check: false,
    },
  };
}

function makeSessionStartedEntry(): JournalEntry {
  return {
    seq: 0,
    entry_id: "JE-000001",
    actor: "cli:loaf",
    at: "2026-05-29T06:00:00.000Z",
    entry_schema_version: 1,
    kind: "session:started",
    payload: {
      session_id: SESSION_ID,
      feature: "auth-refresh",
      ceremony: {
        spec_phase: true,
        verify_phase: true,
        settle_phase: false,
        strict_spec_review: false,
        lessons_required: "skip",
        strict_drift_check: false,
      },
      ceremony_label: "standard",
      workspace: "default",
      loaf_version_required: "^0.1.0",
    },
  } as unknown as JournalEntry;
}

function baseSnapshot(): Snapshot {
  const snap = initialSnapshot();
  snap.state = makeState();
  snap.tasks_based_on = { spec: 1 };
  return snap;
}

const BASE_ENTRIES: JournalEntry[] = [makeSessionStartedEntry()];

describe("buildResumePack — shape and field passthrough", () => {
  test("happy: emits ResumePack with all 8 required fields", () => {
    const pack = buildResumePack({
      snapshot: baseSnapshot(),
      entries: BASE_ENTRIES,
      at: NOW,
      reason: "context overflow approaching at EXECUTE.work",
    });
    expect(pack.schema_version).toBe(2);
    expect(pack.at).toBe(NOW);
    expect(pack.session_id).toBe(SESSION_ID);
    expect(pack.reason).toBe("context overflow approaching at EXECUTE.work");
    expect(pack.state_snapshot).toBeDefined();
    expect(pack.tasks_active_summary).toEqual([]);
    expect(pack.recent_evidence).toEqual([]);
    expect(pack.recent_findings).toEqual([]);
    expect(pack.open_pending).toBeNull();
    expect(pack.notes).toBeUndefined();
  });

  test("notes optional passthrough", () => {
    const pack = buildResumePack({
      snapshot: baseSnapshot(),
      entries: BASE_ENTRIES,
      at: NOW,
      reason: "long enough reason here",
      notes: "remember to re-validate REQ-AUTH-001 on resume",
    });
    expect(pack.notes).toBe("remember to re-validate REQ-AUTH-001 on resume");
  });

  test("output validates against runtime ResumePack schema", () => {
    const pack = buildResumePack({
      snapshot: baseSnapshot(),
      entries: BASE_ENTRIES,
      at: NOW,
      reason: "context overflow approaching at EXECUTE.work",
    });
    const parse = ResumePack.safeParse(pack);
    expect(parse.success).toBe(true);
  });
});

describe("buildResumePack — recent ID cap (codex r346 P1/P2)", () => {
  test("25 evidence entries → only last 10 IDs emitted", () => {
    const snap = baseSnapshot();
    snap.evidence = Array.from(
      { length: 25 },
      (_, i) =>
        ({
          id: `EV-${String(i + 1).padStart(6, "0")}`,
          kind: "task-summary",
          actor: "human:dev@example.com",
          result: "passed",
          covers: [],
        }) as EvidenceState,
    );
    const pack = buildResumePack({
      snapshot: snap,
      entries: BASE_ENTRIES,
      at: NOW,
      reason: "evidence cap regression check",
    });
    expect(pack.recent_evidence).toHaveLength(RESUME_PACK_RECENT_CAP);
    expect(pack.recent_evidence[0]).toBe("EV-000016"); // 25-10+1 = 16
    expect(pack.recent_evidence[9]).toBe("EV-000025");
  });

  test("25 findings → only last 10 IDs emitted", () => {
    const snap = baseSnapshot();
    snap.findings = Array.from(
      { length: 25 },
      (_, i) =>
        ({
          id: `FND-${String(i + 1).padStart(3, "0")}`,
          category: "spec_quality",
          action: "amend-spec",
          status: "open",
        }) as FindingState,
    );
    const pack = buildResumePack({
      snapshot: snap,
      entries: BASE_ENTRIES,
      at: NOW,
      reason: "findings cap regression check",
    });
    expect(pack.recent_findings).toHaveLength(RESUME_PACK_RECENT_CAP);
    expect(pack.recent_findings[0]).toBe("FND-016");
  });
});

describe("buildResumePack — tasks_active_summary derivation", () => {
  test("in_progress task with running step → entry with current_step name", () => {
    const snap = baseSnapshot();
    const task: TaskState = {
      id: "T-001",
      kind: "behavioral",
      status: "in_progress",
      steps: {
        red: { applicability: "must", status: "passed" },
        implement: { applicability: "must", status: "running" },
        refactor: { applicability: "optional", status: "pending" },
      },
      drives: [],
      depends_on: [],
      labels: [],
      requires_acceptance: false,
      red_test_registered: true,
    };
    snap.tasks = [task];
    const pack = buildResumePack({
      snapshot: snap,
      entries: BASE_ENTRIES,
      at: NOW,
      reason: "tasks active summary derivation",
    });
    expect(pack.tasks_active_summary).toHaveLength(1);
    expect(pack.tasks_active_summary[0]).toEqual({
      task_id: "T-001",
      status: "in_progress",
      current_step: "implement",
    });
  });

  test("in_progress task with no running step → current_step is null", () => {
    const snap = baseSnapshot();
    snap.tasks = [
      {
        id: "T-002",
        kind: "behavioral",
        status: "in_progress",
        steps: {
          red: { applicability: "must", status: "passed" },
          implement: { applicability: "must", status: "pending" },
        },
        drives: [],
        depends_on: [],
        labels: [],
        requires_acceptance: false,
        red_test_registered: true,
      },
    ];
    const pack = buildResumePack({
      snapshot: snap,
      entries: BASE_ENTRIES,
      at: NOW,
      reason: "no running step paused state",
    });
    expect(pack.tasks_active_summary[0]!.current_step).toBeNull();
  });

  test("done/abandoned tasks excluded from active summary", () => {
    const snap = baseSnapshot();
    snap.tasks = [
      {
        id: "T-001",
        kind: "behavioral",
        status: "done",
        steps: {},
        drives: [],
        depends_on: [],
        labels: [],
        requires_acceptance: false,
        red_test_registered: true,
      },
      {
        id: "T-002",
        kind: "behavioral",
        status: "ready",
        steps: {},
        drives: [],
        depends_on: [],
        labels: [],
        requires_acceptance: false,
        red_test_registered: true,
      },
    ];
    const pack = buildResumePack({
      snapshot: snap,
      entries: BASE_ENTRIES,
      at: NOW,
      reason: "active set excludes terminal tasks",
    });
    expect(pack.tasks_active_summary).toHaveLength(1);
    expect(pack.tasks_active_summary[0]!.task_id).toBe("T-002");
  });
});

describe("buildResumePack — error guards", () => {
  test("snapshot.state === null → throws (no session)", () => {
    const snap = initialSnapshot();
    expect(() =>
      buildResumePack({
        snapshot: snap,
        entries: [],
        at: NOW,
        reason: "no session error guard",
      }),
    ).toThrow();
  });
});
