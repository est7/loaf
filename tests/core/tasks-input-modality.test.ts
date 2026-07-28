// Phase 16 SC-4b — `loaf tasks` --input modality migration.
//
// 3 input surfaces migrated this slice (codex r224 PATCH 1 expansion):
//   - `tasks submit --input <src>`     — whole-graph single object
//   - `tasks add --input <src>`        — single OR array (batch-capable)
//   - `tasks amend <T-N> --input <src> --finding <FND-N>` — sponsored single object
//
// Wiring-focused matrix per codex r212 PATCH 4 (no per-command parser
// matrix duplication; the JsonInputIngestor unit tests cover that):
//
//   3 commands × stdin happy   = 3
//   3 commands × inline happy  = 3
//   3 commands × TTY no-hang   = 3
//   stdin malformed JSON       = 1
//   inline malformed JSON      = 1
//   missing file path          = 1
//   MISSING_INPUT stdin-read   = 1 (covered in tests/cli/input-read.test.ts;
//                                    here we smoke the CLI lane integrates)
//
// Sponsored `tasks amend --input + --finding` happy is the third group's
// happy-path test (smoke that the more complex sponsored seed still works
// through the migrated path).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";

type RunCliOpts = {
  stdin?: string;
  isStdinTty?: boolean;
};

async function tmpFeatureDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc4b-"));
}

async function runCli(
  argv: string[],
  opts: RunCliOpts = {},
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const deps: {
      readStdin?: () => Promise<string>;
      isStdinTty?: () => boolean;
    } = {};
    if (opts.stdin !== undefined) deps.readStdin = async () => opts.stdin!;
    if (opts.isStdinTty !== undefined) deps.isStdinTty = () => opts.isStdinTty!;
    const exit = await main(["node", "loaf", ...argv], deps);
    return { exit, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
}

const ENV = { LOAF_USER: "sc4b@test.invalid" };

async function writeJson(dir: string, name: string, payload: unknown): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, JSON.stringify(payload));
  return p;
}

const TASKS_GRAPH_SEED = {
  // seedAtSpecDesign: spec submit (v1) + spec add-req (bump to v2) →
  // task graph must reference v2 to pass spec-lock gate check 3.
  based_on: { spec: 2 },
  tasks: [
    {
      id: "T-001",
      kind: "behavioral",
      drives: ["REQ-CORE-001"],
      tests: ["sc4b.seed"],
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

// TaskInput is id-less, status-less, execution-less per ADR-0004:
// CLI allocates id, stamps status="pending", and seeds the execution
// map. Test fixture must NOT carry any of those fields.
const ADD_TASK_INPUT_ONE = {
  kind: "behavioral",
  drives: ["REQ-CORE-001"],
  tests: ["sc4b.add"],
  depends_on: [],
  labels: [],
};

/** Walk a fresh feature dir to SPEC.design with spec_version=1. */
async function seedAtSpecDesign(): Promise<{ dir: string; feature: string }> {
  const dir = await tmpFeatureDir();
  const feature = "F1";
  const env = ENV;
  // Need LOAF_USER for human-only entries
  process.env["LOAF_USER"] = env.LOAF_USER;
  await runCli([
    "start",
    feature,
    "--ceremony",
    "standard",
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  await runCli([
    "advance",
    "TRIAGE.confirm",
    "--feature",
    feature,
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  await runCli([
    "advance",
    "SPEC.proposal",
    "--feature",
    feature,
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  const submitPath = await writeJson(dir, "submit.json", {
    feature: { id: "F-001", name: "SC-4b seed" },
    intent: "exercise SC-4b tasks input modality wiring",
    adr_refs: [],
    needs_clarification: [],
  });
  await runCli([
    "spec",
    "submit",
    "--input",
    submitPath,
    "--feature",
    feature,
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  const reqPath = await writeJson(dir, "req1.json", {
    id_namespace: "REQ-CORE",
    type: "ubiquitous",
    response: "the system shall complete the SC-4b wiring smoke",
    acceptance_na: true,
    acceptance_na_reason: "exercised by this SC-4b integration test",
  });
  await runCli([
    "spec",
    "add-req",
    "--input",
    reqPath,
    "--feature",
    feature,
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  await runCli([
    "advance",
    "SPEC.spec",
    "--feature",
    feature,
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  await runCli([
    "advance",
    "SPEC.plan",
    "--feature",
    feature,
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  await runCli([
    "advance",
    "SPEC.design",
    "--feature",
    feature,
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  return { dir, feature };
}

/** Walk to EXECUTE.work with seed tasks submitted + amend-tasks finding raised. */
async function seedAtExecuteWorkWithFinding(): Promise<{
  dir: string;
  feature: string;
  findingId: string;
}> {
  const { dir, feature } = await seedAtSpecDesign();
  const tasksPath = await writeJson(dir, "tasks.json", TASKS_GRAPH_SEED);
  const submitR = await runCli([
    "tasks",
    "submit",
    "--input",
    tasksPath,
    "--feature",
    feature,
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  if (submitR.exit !== 0) throw new Error(`seed tasks submit failed: ${submitR.stderr}`);
  const gateR = await runCli([
    "gate",
    "decide",
    "spec-lock",
    "--approve",
    "--reason",
    "seed for SC-4b sponsored amend lane",
    "--feature",
    feature,
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  if (gateR.exit !== 0) throw new Error(`seed gate decide failed: ${gateR.stderr}`);
  const advR = await runCli([
    "advance",
    "EXECUTE.work",
    "--feature",
    feature,
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  if (advR.exit !== 0) throw new Error(`seed advance EXECUTE.work failed: ${advR.stderr}`);
  const r = await runCli([
    "finding",
    "raise",
    "--category",
    "new-scope",
    "--action",
    "amend-tasks",
    "--summary",
    "SC-4b sponsored amend lane smoke",
    "--feature",
    feature,
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  if (r.exit !== 0) throw new Error(`seed finding raise failed: ${r.stderr}`);
  const findingId = JSON.parse(r.stdout).id as string;
  return { dir, feature, findingId };
}

describe("Phase 16 SC-4b — `loaf tasks submit` --input lanes", () => {
  test("stdin happy → exit 0", async () => {
    const { dir, feature } = await seedAtSpecDesign();
    const r = await runCli(
      [
        "tasks",
        "submit",
        "--input",
        "-",
        "--feature",
        feature,
        "--feature-dir",
        dir,
        "--format",
        "json",
      ],
      { stdin: JSON.stringify(TASKS_GRAPH_SEED) },
    );
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true });
  });

  test("inline JSON happy → exit 0", async () => {
    const { dir, feature } = await seedAtSpecDesign();
    const r = await runCli([
      "tasks",
      "submit",
      "--input",
      JSON.stringify(TASKS_GRAPH_SEED),
      "--feature",
      feature,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true });
  });

  test("TTY guard: stdin TTY + --input - → exit 2 USAGE", async () => {
    const { dir, feature } = await seedAtSpecDesign();
    const r = await runCli(
      ["tasks", "submit", "--input", "-", "--feature", feature, "--feature-dir", dir],
      { isStdinTty: true, stdin: JSON.stringify(TASKS_GRAPH_SEED) },
    );
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/USAGE|stdin|TTY|pipe/i);
  });
});

describe("Phase 16 SC-4b — `loaf tasks add` --input lanes", () => {
  test("stdin happy (single object) → exit 0", async () => {
    const { dir, feature } = await seedAtSpecDesign();
    const r = await runCli(
      [
        "tasks",
        "add",
        "--input",
        "-",
        "--feature",
        feature,
        "--feature-dir",
        dir,
        "--format",
        "json",
      ],
      { stdin: JSON.stringify(ADD_TASK_INPUT_ONE) },
    );
    expect(r.exit).toBe(0);
  });

  test("inline JSON array (batch) happy → exit 0", async () => {
    const { dir, feature } = await seedAtSpecDesign();
    const r = await runCli([
      "tasks",
      "add",
      "--input",
      JSON.stringify([ADD_TASK_INPUT_ONE, { ...ADD_TASK_INPUT_ONE, tests: ["sc4b.add.2"] }]),
      "--feature",
      feature,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(r.exit).toBe(0);
  });

  test("TTY guard: tasks add stdin TTY → exit 2 USAGE", async () => {
    const { dir, feature } = await seedAtSpecDesign();
    const r = await runCli(
      ["tasks", "add", "--input", "-", "--feature", feature, "--feature-dir", dir],
      { isStdinTty: true, stdin: JSON.stringify(ADD_TASK_INPUT_ONE) },
    );
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/USAGE|stdin|TTY|pipe/i);
  });
});

describe("Phase 16 SC-4b — `loaf tasks amend --input` sponsored lanes", () => {
  test("stdin happy (sponsored) → exit 0", async () => {
    const { dir, feature, findingId } = await seedAtExecuteWorkWithFinding();
    const r = await runCli(
      [
        "tasks",
        "amend",
        "T-001",
        "--input",
        "-",
        "--finding",
        findingId,
        "--feature",
        feature,
        "--feature-dir",
        dir,
        "--format",
        "json",
      ],
      { stdin: JSON.stringify(ADD_TASK_INPUT_ONE) },
    );
    expect(r.exit).toBe(0);
  });

  test("inline JSON happy (sponsored) → exit 0", async () => {
    const { dir, feature, findingId } = await seedAtExecuteWorkWithFinding();
    const r = await runCli([
      "tasks",
      "amend",
      "T-001",
      "--input",
      JSON.stringify(ADD_TASK_INPUT_ONE),
      "--finding",
      findingId,
      "--feature",
      feature,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(r.exit).toBe(0);
  });

  test("TTY guard: tasks amend stdin TTY → exit 2 USAGE", async () => {
    const { dir, feature, findingId } = await seedAtExecuteWorkWithFinding();
    const r = await runCli(
      [
        "tasks",
        "amend",
        "T-001",
        "--input",
        "-",
        "--finding",
        findingId,
        "--feature",
        feature,
        "--feature-dir",
        dir,
      ],
      { isStdinTty: true, stdin: JSON.stringify(ADD_TASK_INPUT_ONE) },
    );
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/USAGE|stdin|TTY|pipe/i);
  });
});

describe("Phase 16 SC-4b — `loaf tasks` --input error paths (shared across 3 commands)", () => {
  test("stdin lane with malformed JSON → exit 2 SCHEMA_VALIDATION_FAILED", async () => {
    const { dir, feature } = await seedAtSpecDesign();
    const r = await runCli(
      ["tasks", "submit", "--input", "-", "--feature", feature, "--feature-dir", dir],
      { stdin: "{not json}" },
    );
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("SCHEMA_VALIDATION_FAILED");
  });

  test("inline lane with malformed JSON → exit 2 SCHEMA_VALIDATION_FAILED", async () => {
    const { dir, feature } = await seedAtSpecDesign();
    const r = await runCli([
      "tasks",
      "add",
      "--input",
      "{badjson",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("SCHEMA_VALIDATION_FAILED");
  });

  test("file path that does not exist → exit 2 INPUT_FILE_NOT_FOUND", async () => {
    const { dir, feature } = await seedAtSpecDesign();
    const r = await runCli([
      "tasks",
      "submit",
      "--input",
      "/tmp/loaf-sc4b-nonexistent.json",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("INPUT_FILE_NOT_FOUND");
  });
});
