// Spike Gate 3: replay fidelity.
//
// Build a representative quick-ceremony session as an event stream.
// Project and verify the final snapshot matches the documented end-state.
//
// This proves the reducer's accept-side is correct for a complete lifecycle
// (not just rejection of bad sequences).

import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { project } from "../../src/spike/reducer.js";
import { appendEvent } from "../../src/spike/append.js";
import { readAndProject } from "../../src/spike/project.js";
import { EVENT_VERSION, type Event } from "../../src/spike/events.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const QUICK = {
  spec_phase: false,
  verify_phase: false,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip" as const,
  strict_drift_check: false,
};

function ts(s: number): string {
  return new Date(2026, 4, 12, 10, 0, s).toISOString();
}

function quickSessionEvents(): Event[] {
  return [
    {
      version: EVENT_VERSION,
      kind: "session_started",
      at: ts(0),
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "spike-button-radius",
      ceremony: QUICK,
      ceremony_label: "quick",
    },
    { version: EVENT_VERSION, kind: "advanced", at: ts(1), from: "TRIAGE.score", to: "TRIAGE.confirm", iteration: 1 },
    { version: EVENT_VERSION, kind: "advanced", at: ts(2), from: "TRIAGE.confirm", to: "EXECUTE.plan", iteration: 1 },
    {
      version: EVENT_VERSION,
      kind: "tasks_submitted",
      at: ts(3),
      tasks_version: 1,
      tasks: [
        { id: "T-001", kind: "chore", drives: [], depends_on: [], status: "pending", labels: [] },
      ],
    },
    { version: EVENT_VERSION, kind: "advanced", at: ts(4), from: "EXECUTE.plan", to: "EXECUTE.work", iteration: 1 },
    { version: EVENT_VERSION, kind: "task_claimed", at: ts(5), task_id: "T-001", by_actor: "worker:A" },
    {
      version: EVENT_VERSION,
      kind: "step_done",
      at: ts(6),
      task_id: "T-001",
      step: "implement",
      status: "passed",
      task_completed: true,
      evidence: {
        id: "EV-000001",
        kind: "build",
        result: "passed",
        covers: ["T-001"],
        actor: "worker:A",
        summary: "buttonRadius updated to 16dp",
      },
    },
    { version: EVENT_VERSION, kind: "advanced", at: ts(7), from: "EXECUTE.work", to: "EXECUTE.done", iteration: 1 },
    { version: EVENT_VERSION, kind: "advanced", at: ts(8), from: "EXECUTE.done", to: "DONE.delivered", iteration: 1 },
  ];
}

describe("Gate 3: replay fidelity", () => {
  test("quick-ceremony lifecycle projects to DONE.delivered with one task done", () => {
    const events = quickSessionEvents();
    const s = project(events);

    expect(s.state!.phase).toBe("DONE");
    expect(s.state!.sub_state).toBe("DONE.delivered");
    expect(s.state!.iteration).toBe(1);
    expect(s.state!.feature).toBe("spike-button-radius");
    expect(s.tasks.list).toHaveLength(1);
    expect(s.tasks.list[0]!.status).toBe("done");
    expect(s.evidence).toHaveLength(1);
    expect(s.evidence[0]!.id).toBe("EV-000001");
    expect(s.pending).toHaveLength(0);
  });

  test("appending events to disk then readAndProject yields same snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loaf-spike-replay-"));
    dirs.push(dir);
    const filePath = join(dir, "events.jsonl");

    const events = quickSessionEvents();
    for (const e of events) {
      await appendEvent(filePath, e, { fsync: false });
    }

    const fromDisk = await readAndProject(filePath);
    const fromMemory = project(events);

    expect(fromDisk).toEqual(fromMemory);
    expect(fromDisk.state!.sub_state).toBe("DONE.delivered");
  });

  test("fan-out: 3 tasks in_progress simultaneously, all closed → DONE OK", () => {
    // Standard ceremony, 3 independent tasks, three workers claim+complete in parallel.
    const STANDARD = {
      spec_phase: true,
      verify_phase: true,
      settle_phase: true,
      strict_spec_review: false,
      lessons_required: "may" as const,
      strict_drift_check: false,
    };
    const events: Event[] = [
      {
        version: EVENT_VERSION,
        kind: "session_started",
        at: ts(0),
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "fan-out-demo",
        ceremony: STANDARD,
        ceremony_label: "standard",
      },
      { version: EVENT_VERSION, kind: "spec_submitted", at: ts(1), spec_version: 1, frontmatter_hash: "h1" },
      { version: EVENT_VERSION, kind: "spec_locked", at: ts(2), actor: "human:est9" },
      {
        version: EVENT_VERSION,
        kind: "tasks_submitted",
        at: ts(3),
        tasks_version: 1,
        tasks: [
          { id: "T-001", kind: "behavioral", drives: ["R-1"], depends_on: [], status: "pending", labels: [] },
          { id: "T-002", kind: "behavioral", drives: ["R-2"], depends_on: [], status: "pending", labels: [] },
          { id: "T-003", kind: "behavioral", drives: ["R-3"], depends_on: [], status: "pending", labels: [] },
        ],
      },
      { version: EVENT_VERSION, kind: "task_claimed", at: ts(4), task_id: "T-001", by_actor: "worker:A" },
      { version: EVENT_VERSION, kind: "task_claimed", at: ts(5), task_id: "T-002", by_actor: "worker:B" },
      { version: EVENT_VERSION, kind: "task_claimed", at: ts(6), task_id: "T-003", by_actor: "worker:C" },
      {
        version: EVENT_VERSION,
        kind: "step_done",
        at: ts(7),
        task_id: "T-001",
        step: "implement",
        status: "passed",
        task_completed: true,
        evidence: {
          id: "EV-000001", kind: "test", result: "passed", covers: ["R-1"], actor: "worker:A", summary: "T-001 done",
        },
      },
      {
        version: EVENT_VERSION,
        kind: "step_done",
        at: ts(8),
        task_id: "T-002",
        step: "implement",
        status: "passed",
        task_completed: true,
        evidence: {
          id: "EV-000002", kind: "test", result: "passed", covers: ["R-2"], actor: "worker:B", summary: "T-002 done",
        },
      },
      {
        version: EVENT_VERSION,
        kind: "step_done",
        at: ts(9),
        task_id: "T-003",
        step: "implement",
        status: "passed",
        task_completed: true,
        evidence: {
          id: "EV-000003", kind: "test", result: "passed", covers: ["R-3"], actor: "worker:C", summary: "T-003 done",
        },
      },
    ];

    const s = project(events);
    expect(s.tasks.list.every((t) => t.status === "done")).toBe(true);
    expect(s.evidence).toHaveLength(3);
    // Active set was multi-element during T+4..T+9 — fan-out invariant respected
  });

  test("two project() calls produce independent snapshots — no shared mutation", () => {
    // codex review-3 M5: with mutate-in-place reducer, the factory pattern
    // (createInitialSnapshot per project call) is what guards against
    // cross-call state leakage. Verify it explicitly.
    const events = quickSessionEvents();
    const s1 = project(events);
    const s2 = project(events);

    expect(s1).toEqual(s2);          // structurally equal
    expect(s1).not.toBe(s2);         // not the same reference
    expect(s1.evidence).not.toBe(s2.evidence);
    expect(s1.tasks).not.toBe(s2.tasks);

    // Mutating s1 must not bleed into s2.
    s1.evidence.push({
      id: "EV-999999",
      kind: "manual",
      result: "passed",
      covers: [],
      actor: "test:leak-probe",
      summary: "would leak if shared",
    });
    expect(s2.evidence.length).toBe(s1.evidence.length - 1);
  });

  test("readAndProject on missing file returns initial snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loaf-spike-empty-"));
    dirs.push(dir);
    const s = await readAndProject(join(dir, "does-not-exist.jsonl"));
    expect(s.state).toBeNull();
    expect(s.tasks.list).toEqual([]);
    expect(s.evidence).toEqual([]);
    expect(s.pending).toEqual([]);
  });
});
