import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { replayJournal } from "../../src/core/journal-bootstrap.js";
import { mutate } from "../../src/core/journal-mutate.js";
import { TasksAmendedPayload, type JournalEntry } from "../../src/core/journal-entry.js";
import {
  BehavioralExecutionPayload,
  StructuralExecutionPayload,
  VisualUiExecutionPayload,
  DocsExecutionPayload,
  SpikeExecutionPayload,
  ChoreExecutionPayload,
  TaskExecutionStepPayload,
} from "../../src/core/task-schema.js";

const step = { applicability: "must", status: "pending" };
const task = {
  id: "T-001",
  kind: "chore",
  status: "pending",
  depends_on: [],
  labels: [],
  no_test_rationale: "Current maintenance operation without behavior changes",
  execution: { execute: step },
};
const executionSchemas = [
  ["behavioral", BehavioralExecutionPayload, { red: step, implement: step, refactor: step }],
  ["structural", StructuralExecutionPayload, { implement: step, refactor: step }],
  [
    "visual-ui",
    VisualUiExecutionPayload,
    { mockup: step, implement: step, "screenshot-compare": step },
  ],
  ["docs", DocsExecutionPayload, { draft: step, review: step }],
  ["spike", SpikeExecutionPayload, { explore: step, prototype: step, record: step }],
  ["chore", ChoreExecutionPayload, { execute: step }],
] as const;

describe("current task execution wire shape", () => {
  test.each(
    executionSchemas,
  )("%s rejects undeclared execution step names", (_kind, schema, execution) => {
    expect(schema.safeParse(execution).success).toBe(true);
    expect(schema.safeParse({ ...execution, retired_extra: step }).success).toBe(false);
  });
  test.each(["evidence_refs", "unknown_field"])("step rejects undeclared field %s", (field) => {
    expect(TaskExecutionStepPayload.safeParse({ ...step, [field]: [] }).success).toBe(false);
  });
  test("tasks_amended requires an explicit mode", () => {
    expect(TasksAmendedPayload.safeParse({ task }).success).toBe(false);
  });
});

function entry(
  seq: number,
  kind: JournalEntry["kind"],
  payload: unknown,
  actor = "cli:fixture",
): JournalEntry {
  return {
    seq,
    entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
    at: "2026-10-10T00:00:00.000Z",
    actor,
    entry_schema_version: 1,
    kind,
    payload,
  };
}
function currentPrefix(): JournalEntry[] {
  const entries = [
    entry(0, "session:started", {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "execution-shape",
      ceremony_label: "standard",
      workspace: "default",
      loaf_version_required: "^0.8.0",
      ceremony: {
        spec_phase: true,
        verify_phase: true,
        settle_phase: false,
        strict_spec_review: false,
        lessons_required: "skip",
        strict_drift_check: false,
      },
    }),
  ];
  for (const [from, to] of [
    ["TRIAGE.score", "TRIAGE.confirm"],
    ["TRIAGE.confirm", "SPEC.proposal"],
    ["SPEC.proposal", "SPEC.spec"],
    ["SPEC.spec", "SPEC.plan"],
    ["SPEC.plan", "SPEC.design"],
  ])
    entries.push(entry(entries.length, "event:phase_advanced", { from, to }));
  entries.push(
    entry(
      entries.length,
      "gate:decided",
      { gate_kind: "spec-lock", decision: "approved", reason: "approved current fixture" },
      "human:fixture",
    ),
  );
  entries.push(
    entry(entries.length, "event:phase_advanced", { from: "SPEC.design", to: "EXECUTE.plan" }),
  );
  entries.push(
    entry(entries.length, "event:tasks_planned", { based_on: { spec: 1 }, tasks: [task] }),
  );
  return entries;
}
const invalidEntries = [
  ["missing amend mode", "event:tasks_amended", { task }],
  [
    "undeclared step name",
    "event:tasks_planned",
    {
      based_on: { spec: 1 },
      tasks: [{ ...task, execution: { execute: step, retired_extra: step } }],
    },
  ],
  [
    "retired step evidence_refs",
    "event:tasks_planned",
    {
      based_on: { spec: 1 },
      tasks: [{ ...task, execution: { execute: { ...step, evidence_refs: ["EV-000001"] } } }],
    },
  ],
] as const;

for (const [label, kind, payload] of invalidEntries) {
  test(`mutation rejects ${label} without appending`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-execution-mutation-"));
    const file = path.join(dir, "journal.jsonl");
    const entries = currentPrefix();
    const original = entries.map((e) => JSON.stringify(e) + "\n").join("");
    try {
      await fs.writeFile(file, original);
      const prefix = await replayJournal(file);
      expect(prefix.ok).toBe(true);
      if (!prefix.ok) throw new Error(JSON.stringify(prefix));
      const result = await mutate(
        {
          kind,
          payload,
          actor: "cli:fixture",
          entry_schema_version: 1,
          at: "2026-10-10T00:00:01.000Z",
        },
        {
          feature_dir: dir,
          snapshot: prefix.snapshot,
          tail_seq: prefix.meta.last_applied_seq,
          entries,
          meta: prefix.meta,
          fsync: false,
        },
      );
      expect(result).toMatchObject({
        ok: false,
        code: "INVALID_PAYLOAD",
        commit_state: "not-committed",
      });
      expect(await fs.readFile(file, "utf8")).toBe(original);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  test(`replay rejects ${label} without returning a snapshot`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-execution-replay-"));
    const file = path.join(dir, "journal.jsonl");
    const entries = currentPrefix();
    try {
      await fs.writeFile(file, entries.map((e) => JSON.stringify(e) + "\n").join(""));
      expect((await replayJournal(file)).ok).toBe(true);
      const retired = entry(entries.length, kind, payload);
      const original = entries
        .concat(retired)
        .map((e) => JSON.stringify(e) + "\n")
        .join("");
      await fs.writeFile(file, original);
      const result = await replayJournal(file);
      expect(result).toMatchObject({
        ok: false,
        code: "REDUCER_REJECTED",
        at_seq: retired.seq,
        detail: { inner_code: "INVALID_PAYLOAD" },
      });
      expect(result).not.toHaveProperty("snapshot");
      expect(await fs.readFile(file, "utf8")).toBe(original);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
