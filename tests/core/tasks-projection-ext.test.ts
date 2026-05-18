// Slice 1.B sub-cycle 3a — TaskState projection extension + F-010 fix.
//
// Coverage:
//   - tasks_planned: full TaskFull payload populates new projection fields,
//     seeds execution steps with applicability, sets Snapshot.tasks_based_on
//   - tasks_planned rejects missing kind-specific fields (behavioral+bug
//     missing red_test_registered, visual-ui missing visual_contract_refs)
//   - tasks_planned rejects duplicate task ids in same payload (codex r24 #5)
//   - tasks_amended: replace by id; unknown id → TASK_NOT_FOUND
//   - tasks_amended preserves payload.task.status as canonical (r24 #4)
//   - task_step_started / task_step_done fail fast on missing task/step
//     (codex r24 #3 — preserves applicability on update)
//   - auto-promote: all must passed/waived/na → done even with optional
//     pending; any must pending/running/failed → no promote
//   - auto-promote: only 1 step recorded but seeded must steps incomplete
//     → no promote (catches "existing steps only" bug — codex r23 BLOCK 2)

import { describe, expect, test } from "vitest";

import { apply, initialSnapshot } from "../../src/core/reducer.js";
import type { Ceremony, JournalEntry } from "../../src/core/journal-entry.js";
import type { Snapshot } from "../../src/core/reducer.js";

const STANDARD_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

function mustOk<T extends { ok: boolean }>(
  r: T,
): Extract<T, { ok: true; snapshot: unknown }>["snapshot"] {
  if (!r.ok) throw new Error(`expected ok, got: ${JSON.stringify(r)}`);
  return (r as Extract<T, { ok: true; snapshot: unknown }>).snapshot;
}

function step(
  applicability: "must" | "optional" | "na",
  status: "pending" | "running" | "passed" | "failed" | "waived" | "na" = "pending",
): Record<string, unknown> {
  return { applicability, status, evidence_refs: [] };
}

function behavioralTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "T-001",
    kind: "behavioral",
    drives: ["REQ-AUTH-001"],
    tests: ["TokenCoord.refreshOnce"],
    status: "pending",
    depends_on: [],
    labels: [],
    execution: {
      red: step("must"),
      implement: step("must"),
      refactor: step("optional"),
    },
    ...overrides,
  };
}

function visualUiTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "T-200",
    kind: "visual-ui",
    visual_contract_refs: ["VIS-AUTH-001"],
    status: "pending",
    depends_on: [],
    labels: [],
    execution: {
      mockup: step("must"),
      implement: step("must"),
      "screenshot-compare": step("must"),
    },
    ...overrides,
  };
}

function structuralTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "T-099",
    kind: "structural",
    no_test_rationale: "rename AuthInterceptor → TokenInterceptor, no behavior change",
    status: "pending",
    depends_on: [],
    labels: [],
    execution: {
      implement: step("must"),
      refactor: step("optional"),
    },
    ...overrides,
  };
}

function entry(
  seq: number,
  kind: JournalEntry["kind"],
  payload: unknown,
): JournalEntry {
  return {
    seq,
    entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
    at: `2026-05-15T10:00:${String(seq).padStart(2, "0")}.000Z`,
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind,
    payload,
  } as JournalEntry;
}

function seedAtExecutePlan(): Snapshot {
  let snap = initialSnapshot();
  snap = mustOk(
    apply(
      snap,
      entry(0, "session:started", {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "auth-refresh",
        ceremony: STANDARD_CEREMONY,
      }),
    ),
  );
  const transitions: Array<[string, string]> = [
    ["TRIAGE.score", "TRIAGE.confirm"],
    ["TRIAGE.confirm", "SPEC.proposal"],
    ["SPEC.proposal", "SPEC.spec"],
    ["SPEC.spec", "SPEC.plan"],
    ["SPEC.plan", "SPEC.design"],
    ["SPEC.design", "EXECUTE.plan"],
  ];
  let seq = 1;
  for (const [from, to] of transitions) {
    snap = mustOk(apply(snap, entry(seq, "event:phase_advanced", { from, to })));
    seq++;
  }
  return snap;
}

function seedAtExecuteWork(tasksPayload: Record<string, unknown>): Snapshot {
  let snap = seedAtExecutePlan();
  snap = mustOk(apply(snap, entry(7, "event:tasks_planned", tasksPayload)));
  snap = mustOk(
    apply(snap, entry(8, "event:phase_advanced", { from: "EXECUTE.plan", to: "EXECUTE.work" })),
  );
  return snap;
}

describe("event:tasks_planned — Slice 1.B sub-cycle 3a", () => {
  test("populates new TaskState fields + sets tasks_based_on + seeds steps with applicability", () => {
    let snap = seedAtExecutePlan();
    expect(snap.tasks_based_on).toBeNull();

    snap = mustOk(
      apply(
        snap,
        entry(7, "event:tasks_planned", {
          based_on: { spec: 2 },
          tasks: [
            behavioralTask({
              id: "T-001",
              drives: ["REQ-AUTH-001", "REQ-AUTH-002"],
              labels: ["bug"],
              red_test_registered: true,
            }),
            structuralTask({ id: "T-099", depends_on: ["T-001"] }),
            visualUiTask({ id: "T-200" }),
          ],
        }),
      ),
    );

    expect(snap.tasks_based_on).toEqual({ spec: 2 });
    expect(snap.tasks).toHaveLength(3);

    const behavioral = snap.tasks.find((t) => t.id === "T-001")!;
    expect(behavioral.kind).toBe("behavioral");
    expect(behavioral.drives).toEqual(["REQ-AUTH-001", "REQ-AUTH-002"]);
    expect(behavioral.labels).toEqual(["bug"]);
    expect(behavioral.red_test_registered).toBe(true);
    expect(behavioral.steps.red?.applicability).toBe("must");
    expect(behavioral.steps.refactor?.applicability).toBe("optional");

    const structural = snap.tasks.find((t) => t.id === "T-099")!;
    expect(structural.kind).toBe("structural");
    expect(structural.depends_on).toEqual(["T-001"]);
    expect(structural.no_test_rationale).toMatch(/rename AuthInterceptor/);

    const visual = snap.tasks.find((t) => t.id === "T-200")!;
    expect(visual.visual_contract_refs).toEqual(["VIS-AUTH-001"]);
  });

  test("rejects behavioral with labels=['bug'] but missing red_test_registered", () => {
    const snap = seedAtExecutePlan();
    const result = apply(
      snap,
      entry(7, "event:tasks_planned", {
        based_on: { spec: 1 },
        tasks: [behavioralTask({ labels: ["bug"] /* red_test_registered missing */ })],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/red_test_registered|payload schema/);
    }
  });

  test("rejects visual-ui missing visual_contract_refs", () => {
    const snap = seedAtExecutePlan();
    const malformed = visualUiTask();
    delete (malformed as Record<string, unknown>).visual_contract_refs;
    const result = apply(
      snap,
      entry(7, "event:tasks_planned", {
        based_on: { spec: 1 },
        tasks: [malformed],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/visual_contract_refs|payload schema/);
    }
  });

  test("rejects duplicate task ids in same payload (codex r24 #5)", () => {
    const snap = seedAtExecutePlan();
    const result = apply(
      snap,
      entry(7, "event:tasks_planned", {
        based_on: { spec: 1 },
        tasks: [behavioralTask({ id: "T-001" }), behavioralTask({ id: "T-001" })],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_PAYLOAD");
      expect(result.message).toMatch(/DUPLICATE_TASK_ID/);
    }
  });

  test("rejects payload missing based_on.spec", () => {
    const snap = seedAtExecutePlan();
    const result = apply(
      snap,
      entry(7, "event:tasks_planned", { tasks: [behavioralTask()] }),
    );
    expect(result.ok).toBe(false);
  });

  test("behavioral task with requires_visual=true survives projection (codex r24 BLOCK fix)", () => {
    let snap = seedAtExecutePlan();
    snap = mustOk(
      apply(
        snap,
        entry(7, "event:tasks_planned", {
          based_on: { spec: 1 },
          tasks: [behavioralTask({ id: "T-001", requires_visual: true })],
        }),
      ),
    );
    const task = snap.tasks.find((t) => t.id === "T-001")!;
    expect(task.requires_visual).toBe(true);
  });
});

describe("event:tasks_amended — Slice 1.B sub-cycle 3a (F-010)", () => {
  test("replaces an existing task by id and preserves payload status", () => {
    let snap = seedAtExecutePlan();
    snap = mustOk(
      apply(
        snap,
        entry(7, "event:tasks_planned", {
          based_on: { spec: 1 },
          tasks: [behavioralTask({ id: "T-001" })],
        }),
      ),
    );

    snap = mustOk(
      apply(
        snap,
        entry(8, "event:tasks_amended", {
          task: behavioralTask({
            id: "T-001",
            drives: ["REQ-AUTH-005"],
            tests: ["NewTest.something"],
            status: "ready",
          }),
          reason: "scope expanded to cover refresh token rotation behavior",
        }),
      ),
    );

    const task = snap.tasks.find((t) => t.id === "T-001")!;
    expect(task.drives).toEqual(["REQ-AUTH-005"]);
    expect(task.status).toBe("ready");
  });

  test("rejects amend on unknown task id with TASK_NOT_FOUND", () => {
    let snap = seedAtExecutePlan();
    snap = mustOk(
      apply(
        snap,
        entry(7, "event:tasks_planned", {
          based_on: { spec: 1 },
          tasks: [behavioralTask({ id: "T-001" })],
        }),
      ),
    );

    const result = apply(
      snap,
      entry(8, "event:tasks_amended", { task: behavioralTask({ id: "T-999" }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TASK_NOT_FOUND");
    }
  });

  test("rejects payload missing task body", () => {
    let snap = seedAtExecutePlan();
    snap = mustOk(
      apply(
        snap,
        entry(7, "event:tasks_planned", {
          based_on: { spec: 1 },
          tasks: [behavioralTask({ id: "T-001" })],
        }),
      ),
    );

    const result = apply(snap, entry(8, "event:tasks_amended", {}));
    expect(result.ok).toBe(false);
  });
});

describe("event:task_step_started / _done — Slice 1.B sub-cycle 3a", () => {
  function seedAtWork(): Snapshot {
    return seedAtExecuteWork({
      based_on: { spec: 1 },
      tasks: [behavioralTask({ id: "T-001" })],
    });
  }

  test("task_step_started fails on missing task (codex r24 #3)", () => {
    const snap = seedAtWork();
    const result = apply(
      snap,
      entry(9, "event:task_step_started", { task_id: "T-999", step: "implement" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TASK_NOT_FOUND");
  });

  test("task_step_started fails on unseeded step (no silent step creation)", () => {
    const snap = seedAtWork();
    const result = apply(
      snap,
      entry(9, "event:task_step_started", { task_id: "T-001", step: "phantom-step" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TASK_STEP_NOT_FOUND");
  });

  test("task_step_done preserves applicability on update", () => {
    let snap = seedAtWork();
    snap = mustOk(
      apply(snap, entry(9, "event:task_step_done", { task_id: "T-001", step: "implement", result: "passed" })),
    );
    const task = snap.tasks.find((t) => t.id === "T-001")!;
    expect(task.steps.implement?.status).toBe("passed");
    expect(task.steps.implement?.applicability).toBe("must");
  });
});

describe("event:task_step_done auto-promote — Slice 1.B sub-cycle 3a (F-010 #3)", () => {
  function seedAtWork(): Snapshot {
    return seedAtExecuteWork({
      based_on: { spec: 1 },
      tasks: [behavioralTask({ id: "T-001" })],
    });
  }

  test("all must passed + optional pending → promotes to done (codex r24 #4)", () => {
    let snap = seedAtWork();
    snap = mustOk(
      apply(snap, entry(9, "event:task_step_done", { task_id: "T-001", step: "red", result: "passed" })),
    );
    snap = mustOk(
      apply(snap, entry(10, "event:task_step_done", { task_id: "T-001", step: "implement", result: "passed" })),
    );
    const task = snap.tasks.find((t) => t.id === "T-001")!;
    expect(task.steps.refactor?.status).toBe("pending");
    expect(task.status).toBe("done");
  });

  test("one must pending → no promote (codex r24 #4)", () => {
    let snap = seedAtWork();
    snap = mustOk(
      apply(snap, entry(9, "event:task_step_done", { task_id: "T-001", step: "implement", result: "passed" })),
    );
    const task = snap.tasks.find((t) => t.id === "T-001")!;
    expect(task.steps.red?.status).toBe("pending");
    expect(task.status).toBe("pending");
  });

  test("must failed → no promote (failed must blocks done)", () => {
    let snap = seedAtWork();
    snap = mustOk(
      apply(snap, entry(9, "event:task_step_done", { task_id: "T-001", step: "red", result: "passed" })),
    );
    snap = mustOk(
      apply(snap, entry(10, "event:task_step_done", { task_id: "T-001", step: "implement", result: "failed" })),
    );
    const task = snap.tasks.find((t) => t.id === "T-001")!;
    expect(task.status).toBe("pending");
  });

  test("waived must counts as terminal-positive → promote", () => {
    let snap = seedAtWork();
    snap = mustOk(
      apply(snap, entry(9, "event:task_step_done", { task_id: "T-001", step: "red", result: "waived" })),
    );
    snap = mustOk(
      apply(snap, entry(10, "event:task_step_done", { task_id: "T-001", step: "implement", result: "passed" })),
    );
    const task = snap.tasks.find((t) => t.id === "T-001")!;
    expect(task.status).toBe("done");
  });

  test("seeded must step untouched by events does not falsely promote (codex r23 BLOCK 2 witness)", () => {
    let snap = seedAtWork();
    snap = mustOk(
      apply(snap, entry(9, "event:task_step_done", { task_id: "T-001", step: "implement", result: "passed" })),
    );
    const task = snap.tasks.find((t) => t.id === "T-001")!;
    expect(task.status).toBe("pending");
  });
});
