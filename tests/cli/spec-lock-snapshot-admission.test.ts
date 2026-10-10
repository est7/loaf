import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, unlink, rm, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { loadSession } from "../../src/core/cli-runtime.js";
import { mutateBatch } from "../../src/core/journal-mutate.js";

const cli = path.resolve("src/cli.tsx");
const specInput = {
  feature: { id: "F-001", name: "Snapshot gate witness" },
  intent: "verify journal-owned spec-lock admission",
  adr_refs: [],
  requirements: [],
  scenarios: [],
  visual_contracts: [],
  needs_clarification: [],
};
const taskInput = {
  tasks: [
    {
      local_key: "witness",
      kind: "docs",
      no_test_rationale: "documentation-only gate admission witness",
    },
  ],
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "loaf-spec-lock-snapshot-"));
  const feature = path.join(root, "feature");
  const registry = path.join(root, "registry");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    LOAF_REGISTRY_DIR: registry,
    LOAF_LANG: "en",
    LOAF_USER: "gate-witness@example.invalid",
  };
  delete env.LOAF_FEATURE;
  delete env.LOAF_SESSION;
  const run = (args: string[]) =>
    spawnSync(
      "bun",
      [
        cli,
        ...args,
        ...(args[0] === "start" ? [] : ["--feature", "probe"]),
        "--feature-dir",
        feature,
        "--format=json",
        "--quiet",
      ],
      { cwd: root, env, encoding: "utf8" },
    );
  const success = (args: string[]) => {
    const result = run(args);
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  try {
    success(["start", "probe", "--ceremony", "standard"]);
    for (const target of ["TRIAGE.confirm", "SPEC.proposal"]) success(["advance", target]);
    success(["spec", "submit", "--input", JSON.stringify(specInput)]);
    for (const target of ["SPEC.spec", "SPEC.plan", "SPEC.design"]) success(["advance", target]);
    return { root, feature, registry, run, success };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test.each([
  "missing",
  "malformed",
  "divergent",
])("spec-lock uses admitted snapshot when derived spec.md is %s", async (mode) => {
  const f = await fixture();
  try {
    f.success(["tasks", "submit", "--input", JSON.stringify(taskInput)]);
    const file = path.join(f.feature, "spec.md");
    if (mode === "missing") await unlink(file);
    else if (mode === "malformed") await writeFile(file, "---\n[: bogus yaml :]\n---\n");
    else
      await writeFile(
        file,
        (await readFile(file, "utf8")).replace("spec_version: 1", "spec_version: 2"),
      );
    const journal = path.join(f.feature, "journal.jsonl");
    const before = await readFile(journal);
    expect(f.success(["spec", "status"])).toMatchObject({
      all_pass: true,
      failures: [],
      suppressed_checks: [],
    });
    expect(await readFile(journal)).toEqual(before);
    f.success([
      "gate",
      "decide",
      "spec-lock",
      "--approve",
      "--reason",
      "snapshot-authority witness",
    ]);
    const loaded = await loadSession(f.feature);
    expect(loaded.snapshot.state).toMatchObject({
      spec_locked: true,
      sub_state: "EXECUTE.plan",
      spec_version: 1,
    });
    expect(loaded.entries).toHaveLength(before.toString().trim().split("\n").length + 2);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("canonical spec bump rejects stale task graph without writing", async () => {
  const f = await fixture();
  try {
    f.success(["tasks", "submit", "--input", JSON.stringify(taskInput)]);
    f.success(["spec", "submit", "--input", JSON.stringify(specInput)]);
    const journal = path.join(f.feature, "journal.jsonl"),
      before = await readFile(journal);
    const loaded = await loadSession(f.feature);
    expect(loaded.snapshot.state?.spec_version).toBe(2);
    expect(loaded.snapshot.tasks_based_on).toEqual({ spec: 1 });
    expect(f.success(["spec", "status"])).toMatchObject({
      all_pass: false,
      failures: [expect.objectContaining({ check: 3, code: "TASKS_BASED_ON_STALE" })],
    });
    const result = f.run(["gate", "decide", "spec-lock", "--approve", "--reason", "stale witness"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "GATE_PRECONDITION_VIOLATION",
      detail: {
        checks: [
          expect.objectContaining({
            check: 3,
            code: "TASKS_BASED_ON_STALE",
            detail: { tasks_based_on_spec: 1, current_spec_version: 2 },
          }),
        ],
      },
    });
    expect(await readFile(journal)).toEqual(before);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("gate approval cannot satisfy its own preconditions with an earlier task-plan entry", async () => {
  const f = await fixture();
  try {
    const preBatchDir = path.join(f.root, "pre-batch");
    await cp(f.feature, preBatchDir, { recursive: true });
    const beforePlan = await loadSession(preBatchDir);
    f.success(["tasks", "submit", "--input", JSON.stringify(taskInput)]);
    const planned = await loadSession(f.feature);
    const plan = planned.entries.find((entry) => entry.kind === "event:tasks_planned")!;
    const journal = path.join(preBatchDir, "journal.jsonl"),
      before = await readFile(journal);
    const result = await mutateBatch(
      [
        {
          at: plan.at,
          actor: plan.actor,
          entry_schema_version: plan.entry_schema_version,
          kind: plan.kind,
          payload: plan.payload,
        },
        {
          at: plan.at,
          actor: "human:gate-witness@example.invalid",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "spec-lock", decision: "approved", reason: "pre-batch witness" },
        },
      ],
      {
        feature_dir: preBatchDir,
        snapshot: beforePlan.snapshot,
        tail_seq: beforePlan.tail_seq,
        entries: beforePlan.entries,
        meta: beforePlan.meta,
        fsync: false,
        registryWriter: { registryDir: f.registry },
      },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "GATE_PRECONDITION_VIOLATION",
      detail: { checks: [expect.objectContaining({ check: 3, code: "TASKS_NOT_PLANNED" })] },
    });
    expect(await readFile(journal)).toEqual(before);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test.each([
  "missing",
  "malformed",
])("valid derived file cannot repair %s snapshot spec at admission", async (mode) => {
  const f = await fixture();
  try {
    f.success(["tasks", "submit", "--input", JSON.stringify(taskInput)]);
    const loaded = await loadSession(f.feature);
    const journal = path.join(f.feature, "journal.jsonl"),
      before = await readFile(journal);
    const snapshot = structuredClone(loaded.snapshot);
    if (mode === "missing") snapshot.spec_header = null;
    else snapshot.spec_header!.intent = "short";
    const result = await mutateBatch(
      [
        {
          at: "2026-10-10T12:00:00.000Z",
          actor: "human:gate-witness@example.invalid",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "spec-lock", decision: "approved", reason: "fail-closed witness" },
        },
      ],
      {
        feature_dir: f.feature,
        snapshot,
        tail_seq: loaded.tail_seq,
        entries: loaded.entries,
        meta: loaded.meta,
        fsync: false,
        registryWriter: { registryDir: f.registry },
      },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "GATE_PRECONDITION_VIOLATION",
      detail: {
        checks: [
          expect.objectContaining({
            check: 1,
            code: "SPEC_FRONTMATTER_INVALID",
            detail: expect.objectContaining({
              source: "snapshot",
              subcode: mode === "missing" ? "SPEC_NOT_FOUND" : "SPEC_FRONTMATTER_INVALID",
            }),
          }),
        ],
      },
    });
    expect(await readFile(journal)).toEqual(before);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
