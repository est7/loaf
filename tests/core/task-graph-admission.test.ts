import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { JournalEntry } from "../../src/core/journal-entry.js";
import { replayJournal } from "../../src/core/journal-bootstrap.js";
import { mutateBatch } from "../../src/core/journal-mutate.js";
import { initialSnapshot, type Snapshot } from "../../src/core/reducer.js";
import { emptyMeta } from "../../src/core/snapshot.js";

const SPONSOR_ID = "FND-001";

function snapshotAtExecuteWork(): Snapshot {
  return {
    ...initialSnapshot(),
    state: {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "task-graph-admission",
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
    },
    findings: [
      {
        id: SPONSOR_ID,
        category: "spec-gap",
        action: "amend-tasks",
        status: "open",
      },
    ],
  };
}

function choreTask(id: string, dependsOn: string[] = []) {
  return {
    id,
    kind: "chore" as const,
    status: "pending" as const,
    depends_on: dependsOn,
    labels: [],
    no_test_rationale: "graph admission fixture",
    execution: {
      execute: { applicability: "must" as const, status: "pending" as const, evidence_refs: [] },
    },
  };
}

function addTaskEntry(id: string, dependsOn: string[] = []) {
  return {
    at: "2026-07-16T07:55:00.000Z",
    actor: "human:est9",
    entry_schema_version: 1 as const,
    kind: "event:tasks_amended" as const,
    payload: {
      mode: "add" as const,
      task: choreTask(id, dependsOn),
      reason: "admit a batch-final dependency graph",
      sponsored_by_finding_id: SPONSOR_ID,
    },
  };
}

function dryRunContext(snapshot = snapshotAtExecuteWork()) {
  return {
    feature_dir: "/unused/task-graph-admission",
    snapshot,
    tail_seq: -1,
    entries: [],
    meta: emptyMeta(),
    fsync: false,
    dryRun: true,
  };
}

describe("mutateBatch task-graph admission", () => {
  test.each([
    {
      name: "dependent appears before its dependency",
      entries: [addTaskEntry("T-009", ["T-010"]), addTaskEntry("T-010")],
    },
    {
      name: "dependency appears before its dependent",
      entries: [addTaskEntry("T-010"), addTaskEntry("T-009", ["T-010"])],
    },
  ])("accepts a batch-local reference when $name", async ({ entries }) => {
    const result = await mutateBatch(entries, dryRunContext());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.tasks.map((task) => task.id).sort()).toEqual(["T-009", "T-010"]);
    }
  });

  test("rejects a cycle formed across batch entries without writing", async () => {
    const result = await mutateBatch(
      [addTaskEntry("T-009", ["T-010"]), addTaskEntry("T-010", ["T-009"])],
      dryRunContext(),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "TASK_DEP_CYCLE",
      detail: { cycle: ["T-009", "T-010", "T-009"] },
    });
  });
});

describe("task-graph replay compatibility", () => {
  test("replays a historical journal containing a graph that current admission rejects", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-task-graph-replay-"));
    const journalPath = path.join(dir, "journal.jsonl");
    const phaseEntries = [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
    ].map(
      ([from, to], index): JournalEntry => ({
        seq: index + 1,
        entry_id: `JE-${String(index + 2).padStart(6, "0")}`,
        at: `2026-07-16T07:55:0${index + 1}.000Z`,
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from, to },
      }),
    );
    const entries: JournalEntry[] = [
      {
        seq: 0,
        entry_id: "JE-000001",
        at: "2026-07-16T07:55:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "historical-task-graph",
          ceremony: {
            spec_phase: true,
            verify_phase: true,
            settle_phase: false,
            strict_spec_review: false,
            lessons_required: "skip",
            strict_drift_check: false,
          },
        },
      },
      ...phaseEntries,
      {
        seq: 6,
        entry_id: "JE-000007",
        at: "2026-07-16T07:55:06.000Z",
        actor: "human:est9",
        entry_schema_version: 1,
        kind: "event:tasks_planned",
        payload: { based_on: { spec: 1 }, tasks: [choreTask("T-001", ["T-001"])] },
      },
    ];
    await fs.writeFile(journalPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const result = await replayJournal(journalPath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.tasks[0]).toMatchObject({ id: "T-001", depends_on: ["T-001"] });
    }
  });
});
