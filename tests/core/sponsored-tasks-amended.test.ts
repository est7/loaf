// Phase 11 Item 3 SC1b — sponsored event:tasks_amended CLI tests.
//
// SC1b makes a post-back-edge `tasks add` / `tasks amend` legal at
// EXECUTE.work by carrying an explicit `sponsored_by_finding_id` marker on
// the event:tasks_amended payload. The §8.6 preflight sponsored branch
// verifies the marker against snapshot.findings (open + action=amend-tasks),
// pins the surface to EXECUTE.work, and enforces the Q4 frozen-field split.
//
// These are real `runCli` end-to-end tests: a standard feature is driven to
// a locked EXECUTE.work with an open amend-tasks finding (the SCEN-E2E-020
// back-edge), then the sponsored add / amend surfaces are exercised — happy
// paths plus each rejection.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import { loadSession } from "../../src/core/cli-runtime.js";
import { mutate } from "../../src/core/journal-mutate.js";
import { taskAuthoringFixture } from "../helpers/task-authoring-fixture.js";

async function tmpFeatureDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc1b-"));
}

async function runCli(
  argv: string[],
  opts: { env?: Record<string, string | undefined> } = {},
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const envBackup: Record<string, string | undefined> = {};
  if (opts.env) {
    for (const k of Object.keys(opts.env)) {
      envBackup[k] = process.env[k];
      const v = opts.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await main(["node", "loaf", ...argv]);
    return { exit, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
    for (const k of Object.keys(envBackup)) {
      const prev = envBackup[k];
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

// Per-feature CLI driver — see e2e-lifecycle.test.ts:makeCli.
function makeCli(dir: string, env: Record<string, string | undefined>) {
  const step = async (label: string, argv: string[]): Promise<any> => {
    const r = await runCli([...argv, "--feature-dir", dir, "--format", "json"], { env });
    if (r.exit !== 0) {
      throw new Error(
        `STEP FAILED [${label}]: exit ${r.exit}\n` +
          `  argv: ${argv.join(" ")}\n` +
          `  stderr: ${r.stderr.trim()}\n  stdout: ${r.stdout.trim()}`,
      );
    }
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  // `expectFail` runs a command expected to exit 2 and returns the parsed
  // failure JSON.
  const expectFail = async (argv: string[]): Promise<any> => {
    const r = await runCli([...argv, "--feature-dir", dir, "--format", "json"], { env });
    expect(r.exit).not.toBe(0);
    return JSON.parse(r.stdout || r.stderr);
  };
  const writeInput = async (name: string, payload: unknown): Promise<string> => {
    const p = path.join(dir, name);
    const normalized =
      payload !== null &&
      typeof payload === "object" &&
      "based_on" in payload &&
      Array.isArray((payload as { tasks?: unknown }).tasks)
        ? taskAuthoringFixture(
            payload as unknown as Parameters<typeof taskAuthoringFixture>[0],
          )
        : payload;
    await fs.writeFile(p, JSON.stringify(normalized, null, 2));
    return p;
  };
  return { step, expectFail, writeInput, featureDir: dir };
}

const ENV = { LOAF_USER: "sc1b@test.invalid" };

// The seed task graph: one behavioral T-001 with red/implement/refactor.
const SEED_TASKS = {
  based_on: { spec: 2 },
  tasks: [
    {
      id: "T-001",
      kind: "behavioral",
      drives: ["REQ-CORE-001"],
      tests: ["sc1b.seed"],
      status: "pending",
      depends_on: [],
      labels: [],
      execution: {
        red: { applicability: "must", status: "pending", evidence_refs: [] },
        implement: { applicability: "must", status: "pending", evidence_refs: [] },
        refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
      },
    },
  ],
};

// Drive a standard feature to a locked EXECUTE.work, then raise an
// amend-tasks finding (the SCEN-E2E-020 back-edge) so the cursor is at
// EXECUTE.work with an open amend-tasks finding. Returns the FND id.
async function seedToAmendTasksAtWork(
  cli: ReturnType<typeof makeCli>,
  F: string,
  tasksGraph: unknown = SEED_TASKS,
): Promise<string> {
  const { step, writeInput } = cli;
  await step("start", ["start", F, "--ceremony", "standard"]);
  await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
  await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
  await step("spec init", ["spec", "init", "--feature", F]);
  const submitInput = await writeInput("submit.json", {
    feature: { id: "F-001", name: "SC1b sponsored amend" },
    intent: "exercise the sponsored tasks_amended surface end-to-end",
    adr_refs: [],
    needs_clarification: [],
  });
  await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
  await step("spec add-req", [
    "spec",
    "add-req",
    "--input",
    await writeInput("req1.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the sponsored amend smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    }),
    "--feature",
    F,
  ]);
  await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
  await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
  await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
  await step("tasks submit", [
    "tasks",
    "submit",
    "--input",
    await writeInput("tasks.json", tasksGraph),
    "--feature",
    F,
  ]);
  if (tasksGraph !== SEED_TASKS) {
    // Historical journals may contain body-only step progress authored before
    // the strict semantic CLI boundary. Re-emit that wire-compatible full
    // payload through the core mutation seam so the compatibility tests below
    // still exercise sponsored amend behavior over a replayed legacy body.
    const session = await loadSession(cli.featureDir);
    const seeded = await mutate(
      {
        at: new Date().toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:tasks_planned",
        payload: tasksGraph as Record<string, unknown>,
      },
      {
        feature_dir: cli.featureDir,
        snapshot: session.snapshot,
        tail_seq: session.tail_seq,
        entries: session.entries,
        meta: session.meta,
        fsync: false,
      },
    );
    if (!seeded.ok) {
      throw new Error(`historical task-body seed failed: ${seeded.code} ${seeded.message}`);
    }
  }
  await step("gate spec-lock", [
    "gate",
    "decide",
    "spec-lock",
    "--approve",
    "--reason",
    "spec and task graph complete for the lock",
    "--feature",
    F,
  ]);
  await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);
  const raised = await step("finding raise amend-tasks", [
    "finding",
    "raise",
    "--category",
    "new-scope",
    "--action",
    "amend-tasks",
    "--summary",
    "execution surfaced a missing task",
    "--feature",
    F,
  ]);
  expect(raised.back_edge.to).toBe("EXECUTE.work");
  return raised.id as string;
}

async function readJournal(dir: string): Promise<Array<Record<string, any>>> {
  const raw = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
  return raw
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

async function readJournalIfExists(dir: string): Promise<Array<Record<string, any>>> {
  try {
    return await readJournal(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

describe("SC1b — sponsored `tasks add --finding` at EXECUTE.work", () => {
  test("happy path: a new task is appended via sponsored event:tasks_amended mode=add", async () => {
    const dir = await tmpFeatureDir();
    const F = "sc1b-add-happy";
    const cli = makeCli(dir, ENV);
    const fnd = await seedToAmendTasksAtWork(cli, F);

    const newTask = await cli.writeInput("new-task.json", {
      local_key: "new-structural-task",
      kind: "structural",
      no_test_rationale: "extract a helper the missing task needs; no behavior change",
    });
    const added = await cli.step("tasks add --finding", [
      "tasks",
      "add",
      "--input",
      newTask,
      "--finding",
      fnd,
      "--feature",
      F,
    ]);
    expect(added.ok).toBe(true);
    expect(added.task_ids).toEqual(["T-002"]);
    expect(added.sponsored_by_finding_id).toBe(fnd);

    // The journal carries one event:tasks_amended mode=add with the marker.
    const entries = await readJournal(dir);
    const amended = entries.filter((e) => e.kind === "event:tasks_amended");
    expect(amended.length).toBe(1);
    expect(amended[0]!.payload.mode).toBe("add");
    expect(amended[0]!.payload.sponsored_by_finding_id).toBe(fnd);
    expect(amended[0]!.payload.task.id).toBe("T-002");

    // The finding stays open (SC1b does not close it — Q7).
    const findings = await cli.step("finding list", ["finding", "list", "--feature", F]);
    expect(findings.findings.find((f: any) => f.id === fnd).status).toBe("open");

    // T-002 is in the projection.
    const tasks = await cli.step("tasks list", ["tasks", "list", "--feature", F]);
    expect(tasks.tasks.map((t: any) => t.id).sort()).toEqual(["T-001", "T-002"]);
  });

  test("batch: a multi-task input emits one mutateBatch of sponsored adds", async () => {
    const dir = await tmpFeatureDir();
    const F = "sc1b-add-batch";
    const cli = makeCli(dir, ENV);
    const fnd = await seedToAmendTasksAtWork(cli, F);

    const newTasks = await cli.writeInput("new-tasks.json", [
      {
        local_key: "first-structural-task",
        kind: "structural",
        no_test_rationale: "first missing structural task; no behavior change",
      },
      {
        local_key: "second-chore-task",
        kind: "chore",
        no_test_rationale: "second missing chore task; pure housekeeping",
      },
    ]);
    const added = await cli.step("tasks add batch", [
      "tasks",
      "add",
      "--input",
      newTasks,
      "--finding",
      fnd,
      "--feature",
      F,
    ]);
    expect(added.task_ids).toEqual(["T-002", "T-003"]);

    const entries = await readJournal(dir);
    const amended = entries.filter((e) => e.kind === "event:tasks_amended");
    expect(amended.length).toBe(2);
    // One mutateBatch — both entries share a batch_id.
    expect(amended[0]!.batch_id).toBe(amended[1]!.batch_id);
    expect(amended.every((e) => e.payload.sponsored_by_finding_id === fnd)).toBe(true);
  });

  test("--finding at SPEC.design → USAGE reject", async () => {
    const dir = await tmpFeatureDir();
    const F = "sc1b-add-specdesign";
    const cli = makeCli(dir, ENV);
    const { step, expectFail, writeInput } = cli;
    // Drive only to SPEC.design (stop before the lock).
    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    await step("spec submit", [
      "spec",
      "submit",
      "--input",
      await writeInput("submit.json", {
        feature: { id: "F-001", name: "SC1b spec-design reject" },
        intent: "drive to SPEC.design to reject --finding there",
        adr_refs: [],
        needs_clarification: [],
      }),
      "--feature",
      F,
    ]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);

    const newTask = await writeInput("t.json", {
      local_key: "usage-rejection-task",
      kind: "structural",
      no_test_rationale: "a structural task that should never be added with --finding",
    });
    const fail = await expectFail([
      "tasks",
      "add",
      "--input",
      newTask,
      "--finding",
      "FND-001",
      "--feature",
      F,
    ]);
    expect(fail.code).toBe("USAGE");
  });

  test("no --finding outside SPEC.design → SUB_STATE_AUTHORITY_VIOLATION", async () => {
    const dir = await tmpFeatureDir();
    const F = "sc1b-add-nosurface";
    const cli = makeCli(dir, ENV);
    await seedToAmendTasksAtWork(cli, F);
    const newTask = await cli.writeInput("t.json", {
      local_key: "outside-design-task",
      kind: "structural",
      no_test_rationale: "a structural task added without the sponsoring finding",
    });
    const fail = await cli.expectFail(["tasks", "add", "--input", newTask, "--feature", F]);
    expect(fail.code).toBe("SUB_STATE_AUTHORITY_VIOLATION");
  });

  test("sponsored add citing a closed finding → FINDING_NOT_FOUND", async () => {
    const dir = await tmpFeatureDir();
    const F = "sc1b-add-closed";
    const cli = makeCli(dir, ENV);
    const fnd = await seedToAmendTasksAtWork(cli, F);
    await cli.step("finding close", ["finding", "close", fnd, "--feature", F]);
    const newTask = await cli.writeInput("t.json", {
      local_key: "closed-finding-task",
      kind: "structural",
      no_test_rationale: "a structural task sponsored by a now-closed finding",
    });
    const fail = await cli.expectFail([
      "tasks",
      "add",
      "--input",
      newTask,
      "--finding",
      fnd,
      "--feature",
      F,
    ]);
    expect(fail.code).toBe("FINDING_NOT_FOUND");
    expect(fail.detail.reason).toBe("already_closed");
  });

  test("sponsored add citing a missing finding → FINDING_NOT_FOUND not_found", async () => {
    const dir = await tmpFeatureDir();
    const F = "sc1b-add-missing";
    const cli = makeCli(dir, ENV);
    await seedToAmendTasksAtWork(cli, F);
    const newTask = await cli.writeInput("t.json", {
      local_key: "missing-finding-task",
      kind: "structural",
      no_test_rationale: "a structural task sponsored by a non-existent finding",
    });
    const fail = await cli.expectFail([
      "tasks",
      "add",
      "--input",
      newTask,
      "--finding",
      "FND-404",
      "--feature",
      F,
    ]);
    expect(fail.code).toBe("FINDING_NOT_FOUND");
    expect(fail.detail.reason).toBe("not_found");
  });
});

describe("SC1b — sponsored `tasks amend --input --finding` at EXECUTE.work", () => {
  test("happy path: a graph replacement preserving progress via the sponsored marker", async () => {
    const dir = await tmpFeatureDir();
    const F = "sc1b-amend-happy";
    const cli = makeCli(dir, ENV);
    const fnd = await seedToAmendTasksAtWork(cli, F);

    // Replace T-001's graph: keep it behavioral but change drives + labels.
    const newGraph = await cli.writeInput("amend.json", {
      kind: "behavioral",
      drives: ["REQ-CORE-001"],
      tests: ["sc1b.amended"],
      labels: ["perf"],
    });
    const amended = await cli.step("tasks amend --input --finding", [
      "tasks",
      "amend",
      "T-001",
      "--input",
      newGraph,
      "--finding",
      fnd,
      "--feature",
      F,
    ]);
    expect(amended.ok).toBe(true);
    expect(amended.task_id).toBe("T-001");
    expect(amended.sponsored_by_finding_id).toBe(fnd);

    const entries = await readJournal(dir);
    const last = entries[entries.length - 1]!;
    expect(last.kind).toBe("event:tasks_amended");
    expect(last.payload.mode).toBe("replace");
    expect(last.payload.sponsored_by_finding_id).toBe(fnd);
    expect(last.payload.task.id).toBe("T-001");
    expect(last.payload.task.labels).toEqual(["perf"]);

    // The finding stays open.
    const findings = await cli.step("finding list", ["finding", "list", "--feature", F]);
    expect(findings.findings.find((f: any) => f.id === fnd).status).toBe("open");
  });

  test("feature-dir dispatch writes sponsored amend to the dispatched feature dir", async () => {
    const dispatchedDir = await tmpFeatureDir();
    const F = "sc1b-amend-feature-dir-dispatch";
    const wrongDefaultDir = path.join(process.cwd(), ".loaf", F);
    expect(dispatchedDir).not.toBe(wrongDefaultDir);

    const cli = makeCli(dispatchedDir, ENV);
    const fnd = await seedToAmendTasksAtWork(cli, F);

    const newGraph = await cli.writeInput("amend-feature-dir.json", {
      kind: "behavioral",
      drives: ["REQ-CORE-001"],
      tests: ["sc1b.feature-dir-dispatch"],
      labels: ["feature-dir-dispatch"],
    });
    const result = await runCli(
      [
        "tasks",
        "amend",
        "T-001",
        "--input",
        newGraph,
        "--finding",
        fnd,
        "--feature",
        F,
        "--feature-dir",
        dispatchedDir,
        "--format",
        "json",
      ],
      { env: ENV },
    );

    expect(result.exit).toBe(0);
    const amended = JSON.parse(result.stdout);
    expect(amended.ok).toBe(true);
    expect(amended.task_id).toBe("T-001");
    expect(amended.sponsored_by_finding_id).toBe(fnd);

    const dispatchedEntries = await readJournal(dispatchedDir);
    const dispatchedAmends = dispatchedEntries.filter(
      (entry) =>
        entry.kind === "event:tasks_amended" &&
        entry.payload.mode === "replace" &&
        entry.payload.sponsored_by_finding_id === fnd,
    );
    expect(dispatchedAmends.length).toBe(1);
    expect(dispatchedAmends[0]!.payload.task.labels).toEqual(["feature-dir-dispatch"]);

    const wrongDefaultEntries = await readJournalIfExists(wrongDefaultDir);
    const wrongDefaultAmends = wrongDefaultEntries.filter(
      (entry) =>
        entry.kind === "event:tasks_amended" &&
        entry.payload.mode === "replace" &&
        entry.payload.sponsored_by_finding_id === fnd,
    );
    expect(wrongDefaultAmends).toEqual([]);
  });

  test("--policy and --input together → USAGE reject", async () => {
    const dir = await tmpFeatureDir();
    const F = "sc1b-amend-conflict";
    const cli = makeCli(dir, ENV);
    const fnd = await seedToAmendTasksAtWork(cli, F);
    const newGraph = await cli.writeInput("amend.json", {
      kind: "behavioral",
      drives: ["REQ-CORE-001"],
      tests: ["sc1b.x"],
    });
    const fail = await cli.expectFail([
      "tasks",
      "amend",
      "T-001",
      "--policy",
      "refactor=na",
      "--input",
      newGraph,
      "--finding",
      fnd,
      "--feature",
      F,
    ]);
    expect(fail.code).toBe("USAGE");
  });

  test("--input without --finding → USAGE reject", async () => {
    const dir = await tmpFeatureDir();
    const F = "sc1b-amend-noinput";
    const cli = makeCli(dir, ENV);
    await seedToAmendTasksAtWork(cli, F);
    const newGraph = await cli.writeInput("amend.json", {
      kind: "behavioral",
      drives: ["REQ-CORE-001"],
      tests: ["sc1b.x"],
    });
    const fail = await cli.expectFail([
      "tasks",
      "amend",
      "T-001",
      "--input",
      newGraph,
      "--feature",
      F,
    ]);
    expect(fail.code).toBe("USAGE");
  });

  test("sponsored amend citing an action-mismatch finding → FINDING_NOT_FOUND", async () => {
    const dir = await tmpFeatureDir();
    const F = "sc1b-amend-mismatch";
    const cli = makeCli(dir, ENV);
    await seedToAmendTasksAtWork(cli, F);
    // Raise a second finding with a different action — defer is not a
    // back-edge action, so it stays open without moving the cursor.
    const defer = await cli.step("finding raise defer", [
      "finding",
      "raise",
      "--category",
      "risk-escalation",
      "--action",
      "defer",
      "--summary",
      "a non-amend-tasks finding to mis-cite",
      "--feature",
      F,
    ]);
    const newGraph = await cli.writeInput("amend.json", {
      kind: "behavioral",
      drives: ["REQ-CORE-001"],
      tests: ["sc1b.x"],
    });
    const fail = await cli.expectFail([
      "tasks",
      "amend",
      "T-001",
      "--input",
      newGraph,
      "--finding",
      defer.id,
      "--feature",
      F,
    ]);
    expect(fail.code).toBe("FINDING_NOT_FOUND");
    expect(fail.detail.reason).toBe("action_mismatch");
  });

  test("sponsored amend that erases a progress-bearing step → MUTATION_OUT_OF_RIGHTS", async () => {
    const dir = await tmpFeatureDir();
    const F = "sc1b-amend-frozen";
    const cli = makeCli(dir, ENV);
    const fnd = await seedToAmendTasksAtWork(cli, F);

    // Make progress on T-001: claim it + run the red step. `red` is now a
    // progress-bearing step in the projection.
    await cli.step("tasks claim", ["tasks", "claim", "T-001", "--feature", F]);
    await cli.step("tasks step start red", [
      "tasks",
      "step",
      "start",
      "--task",
      "T-001",
      "--step",
      "red",
      "--feature",
      F,
    ]);
    await cli.step("tasks step done red", [
      "tasks",
      "step",
      "done",
      "--task",
      "T-001",
      "--step",
      "red",
      "--feature",
      F,
    ]);

    // A sponsored amend that re-classifies T-001 behavioral→structural drops
    // the `red` step — which now carries progress. Preflight §8.6 rejects.
    const newGraph = await cli.writeInput("amend.json", {
      kind: "structural",
      drives: ["REQ-CORE-001"],
      no_test_rationale: "reclassify the task, dropping the red step that has progress",
    });
    const fail = await cli.expectFail([
      "tasks",
      "amend",
      "T-001",
      "--input",
      newGraph,
      "--finding",
      fnd,
      "--feature",
      F,
    ]);
    expect(fail.code).toBe("MUTATION_OUT_OF_RIGHTS");
    expect(fail.detail.field).toBe("execution.red.status");
  });

  test("sponsored --input carries a retained step's body-only progress forward (Q4)", async () => {
    const dir = await tmpFeatureDir();
    const F = "sc1b-amend-carry";
    const cli = makeCli(dir, ENV);
    // Seed T-001 with execution evidence already on its `red` step.
    // `evidence_refs` is a body-only canonical field the slim projection
    // drops; preflight §8.6 cannot see it, so the CLI must preserve it.
    const seeded = {
      based_on: { spec: 2 },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          drives: ["REQ-CORE-001"],
          tests: ["sc1b.seed"],
          status: "pending",
          depends_on: [],
          labels: [],
          execution: {
            red: { applicability: "must", status: "pending", evidence_refs: ["EV-000001"] },
            implement: { applicability: "must", status: "pending", evidence_refs: [] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        },
      ],
    };
    const fnd = await seedToAmendTasksAtWork(cli, F, seeded);

    // A sponsored graph amend retaining all 3 steps (behavioral→behavioral,
    // only `tests` changes). The --input TaskInput cannot carry `execution`,
    // so the retained `red` step's evidence_refs must be carried forward from
    // the canonical body — NOT reset to [] (codex r136 Q4: a sponsored graph
    // amend must not erase execution history).
    const newGraph = await cli.writeInput("amend.json", {
      kind: "behavioral",
      drives: ["REQ-CORE-001"],
      tests: ["sc1b.amended"],
    });
    await cli.step("tasks amend --input --finding", [
      "tasks",
      "amend",
      "T-001",
      "--input",
      newGraph,
      "--finding",
      fnd,
      "--feature",
      F,
    ]);

    const entries = await readJournal(dir);
    const last = entries[entries.length - 1]!;
    expect(last.kind).toBe("event:tasks_amended");
    expect(last.payload.task.execution.red.evidence_refs).toEqual(["EV-000001"]);
    // The graph-definition change still lands.
    expect(last.payload.task.tests).toEqual(["sc1b.amended"]);
  });

  test("sponsored --input dropping a pending step that holds evidence → MUTATION_OUT_OF_RIGHTS (codex r137 BLOCK 2)", async () => {
    const dir = await tmpFeatureDir();
    const F = "sc1b-amend-dropprog";
    const cli = makeCli(dir, ENV);
    // T-001's `red` step is pending but already carries evidence — body-only
    // progress the slim projection drops, so preflight's slim-projection
    // check (firstSponsoredFrozenViolation) would wave a pending-step removal
    // through. The CLI removed-step body-only check is the guard.
    const seeded = {
      based_on: { spec: 2 },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          drives: ["REQ-CORE-001"],
          tests: ["sc1b.seed"],
          status: "pending",
          depends_on: [],
          labels: [],
          execution: {
            red: { applicability: "must", status: "pending", evidence_refs: ["EV-000001"] },
            implement: { applicability: "must", status: "pending", evidence_refs: [] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        },
      ],
    };
    const fnd = await seedToAmendTasksAtWork(cli, F, seeded);

    // Reclassify behavioral→structural — structural has no `red` step, so the
    // amend DROPS red. `red` is slim-pending (the slim check would pass it)
    // but holds evidence_refs — dropping it erases execution history.
    const newGraph = await cli.writeInput("amend.json", {
      kind: "structural",
      drives: ["REQ-CORE-001"],
      no_test_rationale: "reclassify the task; the dropped red step still holds evidence",
    });
    const fail = await cli.expectFail([
      "tasks",
      "amend",
      "T-001",
      "--input",
      newGraph,
      "--finding",
      fnd,
      "--feature",
      F,
    ]);
    expect(fail.code).toBe("MUTATION_OUT_OF_RIGHTS");
    expect(fail.detail.reason).toBe("sponsored_amend_drops_progress_step");
    expect(fail.detail.step).toBe("red");
  });
});
