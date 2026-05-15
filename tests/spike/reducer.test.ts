// Spike Gate 2: reducer enforces all cross-file invariants as
// single-snapshot post-conditions (codex Q5).

import { describe, expect, test } from "vitest";
import { apply, project, ReducerError } from "../../src/spike/reducer.js";
import { createInitialSnapshot } from "../../src/spike/snapshot.js";
import { Event as EventSchema, EVENT_VERSION, type Ceremony, type Event } from "../../src/spike/events.js";

// rev 5.x: standard 不再走 SETTLE (settle_phase=false). 旧 STANDARD_CEREMONY
// 含 settle_phase=true 的等价物现在叫 DEEP_CEREMONY (因为只有 deep 走 SETTLE).
const STANDARD_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,    // rev 5.x: SETTLE 砍
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

const QUICK_CEREMONY: Ceremony = {
  spec_phase: false,
  verify_phase: false,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

const SESSION_UUID = "550e8400-e29b-41d4-a716-446655440000";

function ts(s: number): string {
  return new Date(2026, 4, 12, 10, 0, s).toISOString();
}

function sessionStart(ceremony = STANDARD_CEREMONY): Event {
  return {
    version: EVENT_VERSION,
    kind: "session_started",
    at: ts(0),
    session_id: SESSION_UUID,
    feature: "auth-refresh",
    ceremony,
    ceremony_label: "standard",
  };
}

describe("Gate 2: reducer invariants", () => {
  test("session_started → state initialized in TRIAGE.score", () => {
    const s = apply(createInitialSnapshot(), sessionStart());
    expect(s.state).not.toBeNull();
    expect(s.state!.phase).toBe("TRIAGE");
    expect(s.state!.sub_state).toBe("TRIAGE.score");
    expect(s.state!.spec_locked).toBe(false);
    expect(s.state!.iteration).toBe(1);
  });

  test("spec_submitted before session_started → NO_SESSION", () => {
    const event: Event = {
      version: EVENT_VERSION,
      kind: "spec_submitted",
      at: ts(0),
      spec_version: 1,
      frontmatter_hash: "abc12345",
    };
    expect(() => apply(createInitialSnapshot(), event)).toThrow(/NO_SESSION/);
  });

  test("spec_submitted after spec_locked → SPEC_LOCKED", () => {
    const events: Event[] = [
      sessionStart(),
      { version: EVENT_VERSION, kind: "spec_submitted", at: ts(1), spec_version: 1, frontmatter_hash: "abc12345" },
      { version: EVENT_VERSION, kind: "spec_locked", at: ts(2), actor: "human:est9" },
    ];
    const s = project(events);
    expect(s.state!.spec_locked).toBe(true);

    const bad: Event = {
      version: EVENT_VERSION,
      kind: "spec_submitted",
      at: ts(3),
      spec_version: 2,
      frontmatter_hash: "def67890",
    };
    expect(() => apply(s, bad)).toThrow(/SPEC_LOCKED/);
  });

  test("spec_submitted when ceremony.spec_phase=false → rejected", () => {
    const events: Event[] = [sessionStart(QUICK_CEREMONY)];
    const s = project(events);
    const bad: Event = {
      version: EVENT_VERSION,
      kind: "spec_submitted",
      at: ts(1),
      spec_version: 1,
      frontmatter_hash: "abc12345",
    };
    expect(() => apply(s, bad)).toThrow(/SPEC_PHASE_DISABLED/);
  });

  test("task_claimed requires depends_on done", () => {
    const events: Event[] = [
      sessionStart(),
      { version: EVENT_VERSION, kind: "spec_submitted", at: ts(1), spec_version: 1, frontmatter_hash: "abc12345" },
      { version: EVENT_VERSION, kind: "spec_locked", at: ts(2), actor: "human:est9" },
      {
        version: EVENT_VERSION,
        kind: "tasks_submitted",
        at: ts(3),
        tasks_version: 1,
        tasks: [
          { id: "T-001", kind: "behavioral", drives: ["REQ-AUTH-001"], depends_on: [], status: "pending", labels: [] },
          { id: "T-002", kind: "behavioral", drives: ["REQ-AUTH-002"], depends_on: ["T-001"], status: "pending", labels: [] },
        ],
      },
    ];
    const s = project(events);
    // T-002 cannot claim because T-001 not done
    const bad: Event = { version: EVENT_VERSION, kind: "task_claimed", at: ts(4), task_id: "T-002", by_actor: "worker:A" };
    expect(() => apply(s, bad)).toThrow(/DEP_NOT_DONE/);

    // T-001 can claim (no deps)
    const okClaim: Event = { version: EVENT_VERSION, kind: "task_claimed", at: ts(5), task_id: "T-001", by_actor: "worker:A" };
    const s2 = apply(s, okClaim);
    expect(s2.tasks.list.find((t) => t.id === "T-001")?.status).toBe("in_progress");
  });

  test("step_done requires evidence to cover the task or its drives", () => {
    const events: Event[] = [
      sessionStart(),
      { version: EVENT_VERSION, kind: "spec_submitted", at: ts(1), spec_version: 1, frontmatter_hash: "abc12345" },
      { version: EVENT_VERSION, kind: "spec_locked", at: ts(2), actor: "human:est9" },
      {
        version: EVENT_VERSION,
        kind: "tasks_submitted",
        at: ts(3),
        tasks_version: 1,
        tasks: [{ id: "T-001", kind: "behavioral", drives: ["REQ-AUTH-001"], depends_on: [], status: "pending", labels: [] }],
      },
      { version: EVENT_VERSION, kind: "task_claimed", at: ts(4), task_id: "T-001", by_actor: "worker:A" },
    ];
    const s = project(events);

    // Wrong covers (REQ-OTHER)
    const bad: Event = {
      version: EVENT_VERSION,
      kind: "step_done",
      at: ts(5),
      task_id: "T-001",
      step: "implement",
      status: "passed",
      task_completed: false,
      evidence: {
        id: "EV-000001",
        kind: "test",
        result: "passed",
        covers: ["REQ-OTHER"],
        actor: "worker:A",
        summary: "ran tests",
      },
    };
    expect(() => apply(s, bad)).toThrow(/EVIDENCE_NOT_COVERING/);

    // Right covers — task drives
    const good: Event = {
      ...bad,
      evidence: { ...bad.evidence, covers: ["REQ-AUTH-001"] },
    };
    const s2 = apply(s, good);
    expect(s2.evidence).toHaveLength(1);
    expect(s2.evidence[0]!.id).toBe("EV-000001");
  });

  test("evidence id must be monotonic", () => {
    const events: Event[] = [
      sessionStart(),
      { version: EVENT_VERSION, kind: "spec_submitted", at: ts(1), spec_version: 1, frontmatter_hash: "abc12345" },
      { version: EVENT_VERSION, kind: "spec_locked", at: ts(2), actor: "human:est9" },
      {
        version: EVENT_VERSION,
        kind: "tasks_submitted",
        at: ts(3),
        tasks_version: 1,
        tasks: [{ id: "T-001", kind: "behavioral", drives: ["REQ-AUTH-001"], depends_on: [], status: "pending", labels: [] }],
      },
      { version: EVENT_VERSION, kind: "task_claimed", at: ts(4), task_id: "T-001", by_actor: "worker:A" },
      {
        version: EVENT_VERSION,
        kind: "step_done",
        at: ts(5),
        task_id: "T-001",
        step: "implement",
        status: "passed",
        task_completed: false,
        evidence: {
          id: "EV-000010",
          kind: "test",
          result: "passed",
          covers: ["REQ-AUTH-001"],
          actor: "worker:A",
          summary: "first",
        },
      },
    ];
    const s = project(events);

    // Lower id → not monotonic
    const bad: Event = {
      version: EVENT_VERSION,
      kind: "evidence_added",
      at: ts(6),
      evidence: {
        id: "EV-000005",
        kind: "manual",
        result: "passed",
        covers: [],
        actor: "human:est9",
        summary: "out of order",
      },
    };
    expect(() => apply(s, bad)).toThrow(/MONOTONIC/);
  });

  test("pending_resolved must match FIFO head id", () => {
    const events: Event[] = [
      sessionStart(),
      {
        version: EVENT_VERSION,
        kind: "pending_raised",
        at: ts(1),
        entry: { id: "PEND-001", kind: "ask_user_question", question: "?", options: [], at: ts(1) },
      },
      {
        version: EVENT_VERSION,
        kind: "pending_raised",
        at: ts(2),
        entry: { id: "PEND-002", kind: "ask_user_question", question: "?", options: [], at: ts(2) },
      },
    ];
    const s = project(events);
    expect(s.pending).toHaveLength(2);

    // Try to resolve tail — fails
    const bad: Event = { version: EVENT_VERSION, kind: "pending_resolved", at: ts(3), pending_id: "PEND-002", answer: "yes" };
    expect(() => apply(s, bad)).toThrow(/NOT_FIFO_HEAD/);

    // Resolve head — succeeds
    const good: Event = { version: EVENT_VERSION, kind: "pending_resolved", at: ts(3), pending_id: "PEND-001", answer: "yes" };
    const s2 = apply(s, good);
    expect(s2.pending).toHaveLength(1);
    expect(s2.pending[0]!.id).toBe("PEND-002");
  });

  test("advance blocked when pending head is gate_decision", () => {
    const events: Event[] = [
      sessionStart(),
      {
        version: EVENT_VERSION,
        kind: "pending_raised",
        at: ts(1),
        entry: {
          id: "PEND-001",
          kind: "gate_decision",
          question: "approve spec-lock?",
          options: ["approve", "reject"],
          at: ts(1),
        },
      },
    ];
    const s = project(events);
    const bad: Event = {
      version: EVENT_VERSION,
      kind: "advanced",
      at: ts(2),
      from: "TRIAGE.score",
      to: "TRIAGE.confirm",
      iteration: 1,
    };
    expect(() => apply(s, bad)).toThrow(/PENDING_BLOCKS_ADVANCE/);
  });

  test("DONE.* terminal rejects non-empty pending", () => {
    const events: Event[] = [
      sessionStart(QUICK_CEREMONY),
      { version: EVENT_VERSION, kind: "advanced", at: ts(1), from: "TRIAGE.score", to: "TRIAGE.confirm", iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(2), from: "TRIAGE.confirm", to: "EXECUTE.plan", iteration: 1 },
      {
        version: EVENT_VERSION,
        kind: "pending_raised",
        at: ts(3),
        entry: { id: "PEND-001", kind: "ask_user_question", question: "?", options: [], at: ts(3) },
      },
    ];
    const s = project(events);
    const bad: Event = {
      version: EVENT_VERSION,
      kind: "advanced",
      at: ts(4),
      from: "EXECUTE.plan",
      to: "DONE.archived",
      iteration: 1,
    };
    expect(() => apply(s, bad)).toThrow(/DONE_WITH_PENDING/);
  });

  test("DONE.* terminal rejects in_progress tasks", () => {
    const events: Event[] = [
      sessionStart(),
      { version: EVENT_VERSION, kind: "spec_submitted", at: ts(1), spec_version: 1, frontmatter_hash: "abc12345" },
      { version: EVENT_VERSION, kind: "spec_locked", at: ts(2), actor: "human:est9" },
      {
        version: EVENT_VERSION,
        kind: "tasks_submitted",
        at: ts(3),
        tasks_version: 1,
        tasks: [{ id: "T-001", kind: "behavioral", drives: ["R-1"], depends_on: [], status: "pending", labels: [] }],
      },
      { version: EVENT_VERSION, kind: "task_claimed", at: ts(4), task_id: "T-001", by_actor: "worker:A" },
      // Move to a terminal-ish state but T-001 still in_progress
      { version: EVENT_VERSION, kind: "advanced", at: ts(5), from: "TRIAGE.score", to: "TRIAGE.confirm", iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(6), from: "TRIAGE.confirm", to: "EXECUTE.plan", iteration: 1 },
    ];
    const s = project(events);
    const bad: Event = {
      version: EVENT_VERSION,
      kind: "advanced",
      at: ts(7),
      from: "EXECUTE.plan",
      to: "DONE.archived",
      iteration: 1,
    };
    expect(() => apply(s, bad)).toThrow(/DONE_WITH_IN_PROGRESS/);
  });

  test("ceremony refines enforced at session_started", () => {
    // settle_phase=true without verify_phase=true
    const badCeremony = {
      spec_phase: true,
      verify_phase: false,
      settle_phase: true,
      strict_spec_review: false,
      lessons_required: "skip" as const,
      strict_drift_check: false,
    };
    // The refine should reject this at event-shape parse time, not at reducer.
    // We exercise it by constructing the event and parsing through Event schema.
    expect(() => sessionStart(badCeremony as never)).not.toThrow(); // construction OK
    // Validation rejects the bad refine at Event schema level (not reducer).
    const result = EventSchema.safeParse(sessionStart(badCeremony as never));
    expect(result.success).toBe(false);
  });

  test("advance rejects illegal sub_state jump (TRIAGE.score → DONE.delivered)", () => {
    // codex review-3 B1: reducer must enforce legal transition graph,
    // not just from/pending/done invariants.
    const events: Event[] = [sessionStart()];
    const s = project(events);
    const bad: Event = {
      version: EVENT_VERSION,
      kind: "advanced",
      at: ts(1),
      from: "TRIAGE.score",
      to: "DONE.delivered",
      iteration: 1,
    };
    expect(() => apply(s, bad)).toThrow(/TRANSITION_ILLEGAL/);
  });

  test("advance rejects mid-phase jump (SPEC.proposal → VERIFY.run)", () => {
    const events: Event[] = [
      sessionStart(),
      { version: EVENT_VERSION, kind: "advanced", at: ts(1), from: "TRIAGE.score", to: "TRIAGE.confirm", iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(2), from: "TRIAGE.confirm", to: "SPEC.proposal", iteration: 1 },
    ];
    const s = project(events);
    const bad: Event = {
      version: EVENT_VERSION,
      kind: "advanced",
      at: ts(3),
      from: "SPEC.proposal",
      to: "VERIFY.run",
      iteration: 1,
    };
    expect(() => apply(s, bad)).toThrow(/TRANSITION_ILLEGAL/);
  });

  test("advance allows user-explicit DONE.archived from any sub_state", () => {
    // DONE.archived / DONE.abandoned are always-legal eject targets per design §8.3.
    // (DONE invariants still apply post-transition — pending/in_progress must be clean.)
    const events: Event[] = [
      sessionStart(QUICK_CEREMONY),
      { version: EVENT_VERSION, kind: "advanced", at: ts(1), from: "TRIAGE.score", to: "TRIAGE.confirm", iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(2), from: "TRIAGE.confirm", to: "EXECUTE.plan", iteration: 1 },
    ];
    const s = project(events);
    const archive: Event = {
      version: EVENT_VERSION,
      kind: "advanced",
      at: ts(3),
      from: "EXECUTE.plan",
      to: "DONE.archived",
      iteration: 1,
    };
    const s2 = apply(s, archive);
    expect(s2.state!.sub_state).toBe("DONE.archived");
  });

  // rev 5.x: VERIFY.accept has two forward targets, picked by ceremony.settle_phase.
  test("VERIFY.accept → DONE.delivered allowed when ceremony.settle_phase=false (standard)", () => {
    const events: Event[] = [
      sessionStart(STANDARD_CEREMONY),
      { version: EVENT_VERSION, kind: "advanced", at: ts(1), from: "TRIAGE.score",      to: "TRIAGE.confirm",   iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(2), from: "TRIAGE.confirm",    to: "SPEC.proposal",    iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(3), from: "SPEC.proposal",     to: "SPEC.spec",        iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(4), from: "SPEC.spec",         to: "SPEC.plan",        iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(5), from: "SPEC.plan",         to: "SPEC.design",      iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(6), from: "SPEC.design",       to: "EXECUTE.plan",     iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(7), from: "EXECUTE.plan",      to: "EXECUTE.work",     iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(8), from: "EXECUTE.work",      to: "EXECUTE.done",     iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(9), from: "EXECUTE.done",      to: "VERIFY.plan",      iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(10), from: "VERIFY.plan",      to: "VERIFY.run",       iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(11), from: "VERIFY.run",       to: "VERIFY.accept",    iteration: 1 },
    ];
    const s = project(events);
    const deliver: Event = {
      version: EVENT_VERSION,
      kind: "advanced",
      at: ts(12),
      from: "VERIFY.accept",
      to: "DONE.delivered",  // standard skips SETTLE under rev 5.x
      iteration: 1,
    };
    const s2 = apply(s, deliver);
    expect(s2.state!.sub_state).toBe("DONE.delivered");
  });

  test("VERIFY.accept → SETTLE.reconcile allowed when ceremony.settle_phase=true (deep)", () => {
    const events: Event[] = [
      sessionStart(DEEP_CEREMONY),
      { version: EVENT_VERSION, kind: "advanced", at: ts(1), from: "TRIAGE.score",      to: "TRIAGE.confirm",   iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(2), from: "TRIAGE.confirm",    to: "SPEC.proposal",    iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(3), from: "SPEC.proposal",     to: "SPEC.spec",        iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(4), from: "SPEC.spec",         to: "SPEC.plan",        iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(5), from: "SPEC.plan",         to: "SPEC.design",      iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(6), from: "SPEC.design",       to: "EXECUTE.plan",     iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(7), from: "EXECUTE.plan",      to: "EXECUTE.work",     iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(8), from: "EXECUTE.work",      to: "EXECUTE.done",     iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(9), from: "EXECUTE.done",      to: "VERIFY.plan",      iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(10), from: "VERIFY.plan",      to: "VERIFY.run",       iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(11), from: "VERIFY.run",       to: "VERIFY.accept",    iteration: 1 },
    ];
    const s = project(events);
    const reconcile: Event = {
      version: EVENT_VERSION,
      kind: "advanced",
      at: ts(12),
      from: "VERIFY.accept",
      to: "SETTLE.reconcile",  // deep still goes through SETTLE
      iteration: 1,
    };
    const s2 = apply(s, reconcile);
    expect(s2.state!.sub_state).toBe("SETTLE.reconcile");
  });

  // rev 5.x: VERIFY.accept fork must respect ceremony.settle_phase.
  test("VERIFY.accept → SETTLE.reconcile rejected when settle_phase=false (standard)", () => {
    const events: Event[] = [
      sessionStart(STANDARD_CEREMONY),
      { version: EVENT_VERSION, kind: "advanced", at: ts(1), from: "TRIAGE.score",   to: "TRIAGE.confirm",  iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(2), from: "TRIAGE.confirm", to: "SPEC.proposal",   iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(3), from: "SPEC.proposal",  to: "SPEC.spec",       iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(4), from: "SPEC.spec",      to: "SPEC.plan",       iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(5), from: "SPEC.plan",      to: "SPEC.design",     iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(6), from: "SPEC.design",    to: "EXECUTE.plan",    iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(7), from: "EXECUTE.plan",   to: "EXECUTE.work",    iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(8), from: "EXECUTE.work",   to: "EXECUTE.done",    iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(9), from: "EXECUTE.done",   to: "VERIFY.plan",     iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(10), from: "VERIFY.plan",   to: "VERIFY.run",      iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(11), from: "VERIFY.run",    to: "VERIFY.accept",   iteration: 1 },
    ];
    const s = project(events);
    const bad: Event = {
      version: EVENT_VERSION,
      kind: "advanced",
      at: ts(12),
      from: "VERIFY.accept",
      to: "SETTLE.reconcile",  // standard must NOT enter SETTLE
      iteration: 1,
    };
    expect(() => apply(s, bad)).toThrow(/SETTLE_PHASE_DISABLED/);
  });

  test("VERIFY.accept → DONE.delivered rejected when settle_phase=true (deep)", () => {
    const events: Event[] = [
      sessionStart(DEEP_CEREMONY),
      { version: EVENT_VERSION, kind: "advanced", at: ts(1), from: "TRIAGE.score",   to: "TRIAGE.confirm",  iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(2), from: "TRIAGE.confirm", to: "SPEC.proposal",   iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(3), from: "SPEC.proposal",  to: "SPEC.spec",       iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(4), from: "SPEC.spec",      to: "SPEC.plan",       iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(5), from: "SPEC.plan",      to: "SPEC.design",     iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(6), from: "SPEC.design",    to: "EXECUTE.plan",    iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(7), from: "EXECUTE.plan",   to: "EXECUTE.work",    iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(8), from: "EXECUTE.work",   to: "EXECUTE.done",    iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(9), from: "EXECUTE.done",   to: "VERIFY.plan",     iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(10), from: "VERIFY.plan",   to: "VERIFY.run",      iteration: 1 },
      { version: EVENT_VERSION, kind: "advanced", at: ts(11), from: "VERIFY.run",    to: "VERIFY.accept",   iteration: 1 },
    ];
    const s = project(events);
    const bad: Event = {
      version: EVENT_VERSION,
      kind: "advanced",
      at: ts(12),
      from: "VERIFY.accept",
      to: "DONE.delivered",  // deep must NOT skip SETTLE
      iteration: 1,
    };
    expect(() => apply(s, bad)).toThrow(/SETTLE_PHASE_BYPASS/);
  });

  test("ReducerError carries diagnostic code + detail", () => {
    try {
      apply(createInitialSnapshot(), {
        version: EVENT_VERSION,
        kind: "spec_submitted",
        at: ts(0),
        spec_version: 1,
        frontmatter_hash: "abc12345",
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ReducerError);
      expect((e as ReducerError).code).toBe("NO_SESSION");
    }
  });
});
