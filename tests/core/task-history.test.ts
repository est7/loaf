// Slice C SC-C2a — canonical task body retrieval (task-history.ts).
//
// `tasks amend` emits a whole-task event:tasks_amended, but the slim
// Snapshot.tasks (TaskState) intentionally drops canonical body fields
// (tests / test_layer / execution.evidence_refs / reason / started_at).
// Two stable-core helpers bridge the gap:
//
//   latestCanonicalTaskBody(entries, taskId)
//     — forward-replays the journal to recover a task's latest full
//       TaskFullPayload body. Whole-replacement aware: a later
//       event:tasks_planned that omits the id clears it (a naive
//       max-seq scan would resurrect a removed task — codex r106 BLOCK).
//
//   materializeTaskForAmend(base, current)
//     — overlays the live runtime status + per-step status/applicability
//       from the slim TaskState onto the canonical body, so a policy
//       amend after work started cannot silently regress task/step state.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  carryForwardStepProgress,
  latestCanonicalTaskBody,
  materializeTaskForAmend,
} from "../../src/core/task-history.js";
import { appendEntry } from "../../src/core/journal-append.js";
import { loadSession } from "../../src/core/cli-runtime.js";
import type { Ceremony, JournalEntry } from "../../src/core/journal-entry.js";
import type { TaskState } from "../../src/core/reducer.js";

const STANDARD: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

function step(
  applicability: "must" | "optional" | "na",
  status: "pending" | "running" | "passed" | "failed" | "waived" | "na" = "pending",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { applicability, status, evidence_refs: [], ...extra };
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

function entry(seq: number, kind: JournalEntry["kind"], payload: unknown): JournalEntry {
  return {
    seq,
    entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
    at: `2026-05-15T10:00:${String(seq).padStart(2, "0")}.000Z`,
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind,
    payload,
  };
}

describe("latestCanonicalTaskBody — Slice C SC-C2a", () => {
  test("recovers a task body from a single tasks_planned", () => {
    const entries = [
      entry(0, "event:tasks_planned", {
        based_on: { spec: 1 },
        tasks: [behavioralTask({ id: "T-001" }), behavioralTask({ id: "T-002" })],
      }),
    ];
    const body = latestCanonicalTaskBody(entries, "T-001");
    expect(body).toBeDefined();
    expect(body!.id).toBe("T-001");
    expect((body as { tests: string[] }).tests).toEqual(["TokenCoord.refreshOnce"]);
  });

  test("returns undefined for an id not in any plan/amend entry", () => {
    const entries = [
      entry(0, "event:tasks_planned", {
        based_on: { spec: 1 },
        tasks: [behavioralTask({ id: "T-001" })],
      }),
    ];
    expect(latestCanonicalTaskBody(entries, "T-999")).toBeUndefined();
  });

  test("a later tasks_planned whole-replacement that omits the id clears it", () => {
    // codex r106 BLOCK: a naive max-seq scan would resurrect T-002 from the
    // first plan; whole-replacement semantics mean the second plan is the
    // entire task set.
    const entries = [
      entry(0, "event:tasks_planned", {
        based_on: { spec: 1 },
        tasks: [behavioralTask({ id: "T-001" }), behavioralTask({ id: "T-002" })],
      }),
      entry(1, "event:tasks_planned", {
        based_on: { spec: 2 },
        tasks: [behavioralTask({ id: "T-001" })],
      }),
    ];
    expect(latestCanonicalTaskBody(entries, "T-002")).toBeUndefined();
    expect(latestCanonicalTaskBody(entries, "T-001")).toBeDefined();
  });

  test("a later tasks_planned re-defines the body of a still-present id", () => {
    const entries = [
      entry(0, "event:tasks_planned", {
        based_on: { spec: 1 },
        tasks: [behavioralTask({ id: "T-001", tests: ["old.test"] })],
      }),
      entry(1, "event:tasks_planned", {
        based_on: { spec: 2 },
        tasks: [behavioralTask({ id: "T-001", tests: ["new.test"] })],
      }),
    ];
    const body = latestCanonicalTaskBody(entries, "T-001");
    expect((body as { tests: string[] }).tests).toEqual(["new.test"]);
  });

  test("a tasks_amended entry overrides the body (mode-agnostic)", () => {
    const entries = [
      entry(0, "event:tasks_planned", {
        based_on: { spec: 1 },
        tasks: [behavioralTask({ id: "T-001", tests: ["planned.test"] })],
      }),
      entry(1, "event:tasks_amended", {
        task: behavioralTask({ id: "T-001", tests: ["amended.test"] }),
      }),
    ];
    const body = latestCanonicalTaskBody(entries, "T-001");
    expect((body as { tests: string[] }).tests).toEqual(["amended.test"]);
  });

  test("returns a no-alias copy — mutating the result does not corrupt entries", () => {
    const planned = entry(0, "event:tasks_planned", {
      based_on: { spec: 1 },
      tasks: [behavioralTask({ id: "T-001" })],
    });
    const body = latestCanonicalTaskBody([planned], "T-001");
    (body as { id: string }).id = "T-MUTATED";
    const again = latestCanonicalTaskBody([planned], "T-001");
    expect(again!.id).toBe("T-001");
  });

  test("ignores non-plan/amend kinds (task_claimed does not change the body)", () => {
    const entries = [
      entry(0, "event:tasks_planned", {
        based_on: { spec: 1 },
        tasks: [behavioralTask({ id: "T-001" })],
      }),
      entry(1, "event:task_claimed", { task_id: "T-001" }),
    ];
    const body = latestCanonicalTaskBody(entries, "T-001");
    expect(body!.id).toBe("T-001");
    expect((body as { status: string }).status).toBe("pending"); // plan body, not runtime
  });

  test("a later tasks_planned omitting the id clears a body set by tasks_amended", () => {
    // codex r107 nice-to-have: pins the amend-then-replan sequence — the
    // whole-replacement clear must override an amend, not just an earlier plan.
    const entries = [
      entry(0, "event:tasks_planned", {
        based_on: { spec: 1 },
        tasks: [behavioralTask({ id: "T-001" })],
      }),
      entry(1, "event:tasks_amended", {
        task: behavioralTask({ id: "T-001", tests: ["amended.test"] }),
      }),
      entry(2, "event:tasks_planned", {
        based_on: { spec: 2 },
        tasks: [behavioralTask({ id: "T-002" })],
      }),
    ];
    expect(latestCanonicalTaskBody(entries, "T-001")).toBeUndefined();
  });
});

describe("materializeTaskForAmend — Slice C SC-C2a", () => {
  function baseBody(): ReturnType<typeof behavioralTask> {
    return behavioralTask({
      id: "T-001",
      status: "pending",
      execution: {
        red: step("must", "pending", { started_at: "2026-05-15T11:00:00.000Z" }),
        implement: step("must", "pending", { evidence_refs: ["EV-000001"] }),
        refactor: step("optional", "pending"),
      },
    });
  }

  function liveState(): TaskState {
    // Runtime state after claim + red passed + implement running.
    return {
      id: "T-001",
      kind: "behavioral",
      status: "in_progress",
      steps: {
        red: { status: "passed", applicability: "must" },
        implement: { status: "running", applicability: "must" },
        refactor: { status: "pending", applicability: "optional" },
      },
      drives: ["REQ-AUTH-001"],
      depends_on: [],
      labels: [],
    };
  }

  test("overlays runtime status + per-step status from the slim projection", () => {
    const out = materializeTaskForAmend(baseBody() as never, liveState());
    expect((out as { status: string }).status).toBe("in_progress");
    const exec = (out as { execution: Record<string, { status: string }> }).execution;
    expect(exec.red!.status).toBe("passed");
    expect(exec.implement!.status).toBe("running");
  });

  test("preserves canonical body-only fields absent from the slim projection", () => {
    const out = materializeTaskForAmend(baseBody() as never, liveState());
    expect((out as { tests: string[] }).tests).toEqual(["TokenCoord.refreshOnce"]);
    const exec = (out as {
      execution: Record<string, { evidence_refs: string[]; started_at?: string }>;
    }).execution;
    expect(exec.red!.started_at).toBe("2026-05-15T11:00:00.000Z");
    expect(exec.implement!.evidence_refs).toEqual(["EV-000001"]);
  });

  test("a base step missing from the slim projection keeps its base values", () => {
    const live = liveState();
    delete (live.steps as Record<string, unknown>)["refactor"];
    const out = materializeTaskForAmend(baseBody() as never, live);
    const exec = (out as { execution: Record<string, { status: string }> }).execution;
    expect(exec.refactor!.status).toBe("pending");
  });

  test("carries through status=abandoned — helper never un-abandons a task", () => {
    // codex r107 nice-to-have: materializeTaskForAmend is a pure overlay; an
    // abandoned task stays abandoned. Authorizing/rejecting amend on an
    // abandoned task is preflight's job (SC-C2b), not this helper's.
    const live = liveState();
    live.status = "abandoned";
    const out = materializeTaskForAmend(baseBody() as never, live);
    expect((out as { status: string }).status).toBe("abandoned");
  });
});

describe("SessionLoad.entries — Slice C SC-C2a", () => {
  test("loadSession exposes the replayed journal entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-c2a-"));
    const journalPath = path.join(dir, "journal.jsonl");
    await appendEntry(journalPath, {
      seq: 0,
      entry_id: "JE-000001",
      at: "2026-05-15T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "auth-refresh",
        ceremony: STANDARD,
      },
    });
    const session = await loadSession(dir);
    expect(session.entries).toHaveLength(1);
    expect(session.entries[0]!.kind).toBe("session:started");
  });
});

describe("materializeTaskForAmend — red_test_registered overlay (Slice C SC-C4)", () => {
  test("overlays a runtime red_test_registered=true that the canonical body lacks", () => {
    // codex r115 BLOCK 2: red_test_registered is runtime state (set by
    // register-red). A `tasks amend` after registration rebuilds from the
    // canonical body — the helper must carry the live flag, else §8.6 sees
    // a frozen-field change true→undefined.
    const base = behavioralTask({ id: "T-001", labels: ["bug"] }); // no red flag
    const current: TaskState = {
      id: "T-001",
      kind: "behavioral",
      status: "in_progress",
      steps: {
        red: { applicability: "must", status: "passed" },
        implement: { applicability: "must", status: "pending" },
        refactor: { applicability: "optional", status: "pending" },
      },
      drives: ["REQ-AUTH-001"],
      depends_on: [],
      labels: ["bug"],
      red_test_registered: true,
    };
    const out = materializeTaskForAmend(base as never, current);
    expect((out as { red_test_registered?: boolean }).red_test_registered).toBe(true);
  });
});

describe("carryForwardStepProgress — Phase 11 Item 3 SC1b", () => {
  // A sponsored `tasks amend --input` builds the replacement from an id-less
  // TaskInput — `materializeTaskInput` gives it a FRESH execution block (every
  // step pending, evidence_refs []), so the new graph carries no execution
  // progress. carryForwardStepProgress copies the body-only progress fields
  // (evidence_refs / started_at / reason) forward from the canonical body for
  // every RETAINED step, so a graph amend cannot erase execution history
  // (codex r136 Q4).
  function freshReplacement(): ReturnType<typeof behavioralTask> {
    return behavioralTask({
      id: "T-001",
      execution: {
        red: step("must", "pending"),
        implement: step("must", "pending"),
        refactor: step("optional", "pending"),
      },
    });
  }

  test("carries evidence_refs / started_at / reason forward for a retained step", () => {
    const canonical = behavioralTask({
      id: "T-001",
      execution: {
        red: step("must", "passed", {
          evidence_refs: ["EV-000001"],
          started_at: "2026-05-15T11:00:00.000Z",
          reason: "RED registered",
        }),
        implement: step("must", "running", { started_at: "2026-05-15T12:00:00.000Z" }),
        refactor: step("optional", "pending"),
      },
    });
    const out = carryForwardStepProgress(freshReplacement() as never, canonical as never);
    const exec = (out as {
      execution: Record<string, { evidence_refs: string[]; started_at?: string; reason?: string }>;
    }).execution;
    expect(exec.red!.evidence_refs).toEqual(["EV-000001"]);
    expect(exec.red!.started_at).toBe("2026-05-15T11:00:00.000Z");
    expect(exec.red!.reason).toBe("RED registered");
    expect(exec.implement!.started_at).toBe("2026-05-15T12:00:00.000Z");
  });

  test("does not carry status / applicability — those are materializeTaskForAmend's job", () => {
    const canonical = behavioralTask({
      id: "T-001",
      execution: {
        red: step("must", "passed", { evidence_refs: ["EV-000001"] }),
        implement: step("na", "na"),
        refactor: step("optional", "pending"),
      },
    });
    const out = carryForwardStepProgress(freshReplacement() as never, canonical as never);
    const exec = (out as {
      execution: Record<string, { status: string; applicability: string }>;
    }).execution;
    // status / applicability stay at the fresh replacement's values.
    expect(exec.red!.status).toBe("pending");
    expect(exec.implement!.status).toBe("pending");
    expect(exec.implement!.applicability).toBe("must");
  });

  test("a step absent from the canonical body keeps its fresh (unstarted) values", () => {
    // The canonical body has no `refactor` step — the graph amend introduces
    // it; a new step is born with no evidence and no started_at.
    const canonical = behavioralTask({
      id: "T-001",
      execution: {
        red: step("must", "passed", { evidence_refs: ["EV-000001"] }),
        implement: step("must", "running", { started_at: "2026-05-15T12:00:00.000Z" }),
      },
    });
    const out = carryForwardStepProgress(freshReplacement() as never, canonical as never);
    const exec = (out as {
      execution: Record<string, { evidence_refs: string[]; started_at?: string }>;
    }).execution;
    expect(exec.refactor!.evidence_refs).toEqual([]);
    expect(exec.refactor!.started_at).toBeUndefined();
  });

  test("returns a no-alias copy — mutating the result does not corrupt the replacement", () => {
    const replacement = freshReplacement();
    const out = carryForwardStepProgress(
      replacement as never,
      behavioralTask({ id: "T-001" }) as never,
    );
    (out as { execution: Record<string, { evidence_refs: string[] }> }).execution
      .red!.evidence_refs.push("EV-999");
    expect(
      (replacement as { execution: Record<string, { evidence_refs: string[] }> }).execution
        .red!.evidence_refs,
    ).toEqual([]);
  });
});
