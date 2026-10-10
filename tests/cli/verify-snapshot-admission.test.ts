import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, unlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { loadSession } from "../../src/core/cli-runtime.js";
import { mutate, mutateBatch } from "../../src/core/journal-mutate.js";

const cli = path.resolve("src/cli.tsx");
async function fixture(coverageRequired = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "loaf-verify-snapshot-"));
  const feature = path.join(root, "feature");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    LOAF_REGISTRY_DIR: path.join(root, "registry"),
    LOAF_LANG: "en",
    LOAF_USER: "verify-witness@example.invalid",
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
    success([
      "spec",
      "submit",
      "--input",
      JSON.stringify({
        feature: { id: "F-001", name: "Verify snapshot witness" },
        intent: "verify snapshot-owned acceptance obligations",
        adr_refs: [],
        requirements: coverageRequired
          ? [
              {
                id: "REQ-VERIFY-001",
                type: "ubiquitous",
                response: "the system shall return the verified document",
                measurable: { metric: "completed documents", threshold: "all", unit: "documents" },
              },
            ]
          : [],
        scenarios: [],
        visual_contracts: [],
        needs_clarification: [],
      }),
    ]);
    for (const target of ["SPEC.spec", "SPEC.plan", "SPEC.design"]) success(["advance", target]);
    success([
      "tasks",
      "submit",
      "--input",
      JSON.stringify({
        tasks: [
          {
            local_key: "witness",
            kind: "docs",
            no_test_rationale: "documentation-only acceptance witness",
            drives: coverageRequired ? ["REQ-VERIFY-001"] : [],
          },
        ],
      }),
    ]);
    success(["gate", "decide", "spec-lock", "--approve", "--reason", "spec snapshot witness"]);
    success(["advance", "EXECUTE.work"]);
    success([
      "tasks",
      "abandon",
      "T-001",
      "--reason",
      "isolate spec obligations in acceptance witness",
    ]);
    for (const target of [
      "EXECUTE.done",
      "VERIFY.plan",
      "VERIFY.run",
      "VERIFY.review",
      "VERIFY.acceptance",
      "VERIFY.visual",
      "VERIFY.accept",
    ])
      success(["advance", target]);
    return { root, feature, run, success };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test.each([
  "missing",
  "malformed",
  "divergent",
])("verify approval and five-row status ignore %s derived spec.md", async (mode) => {
  const f = await fixture();
  try {
    const baseline = f.success(["verify", "status"]);
    expect(baseline).toMatchObject({ ok: true, all_pass: true });
    expect(baseline.checks.map((row: { check: string }) => row.check)).toEqual([
      "lane_status",
      "open_findings",
      "coverage",
      "task_evidence",
      "spec_review",
    ]);
    const file = path.join(f.feature, "spec.md");
    if (mode === "missing") await unlink(file);
    else if (mode === "malformed") await writeFile(file, "---\n[: bogus yaml :]\n---\n");
    else
      await writeFile(
        file,
        (await readFile(file, "utf8"))
          .replace("spec_version: 1", "spec_version: 2")
          .replace(
            "requirements: []",
            "requirements:\n  - id: REQ-FILE-999\n    type: ubiquitous\n    response: the system shall demand an unaccepted coverage obligation\n    measurable: {metric: documents, threshold: all, unit: documents}",
          ),
      );
    const journal = path.join(f.feature, "journal.jsonl"),
      before = await readFile(journal);
    expect(f.success(["verify", "status"])).toEqual(baseline);
    expect(await readFile(journal)).toEqual(before);
    f.success([
      "gate",
      "decide",
      "verify-accept",
      "--approve",
      "--reason",
      "snapshot acceptance witness",
    ]);
    const loaded = await loadSession(f.feature);
    expect(loaded.snapshot.state).toMatchObject({
      verify_accepted: true,
      sub_state: "VERIFY.accept",
      spec_version: 1,
    });
    expect(loaded.entries).toHaveLength(before.toString().trim().split("\n").length + 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("derived-file edits cannot erase canonical coverage obligations", async () => {
  const f = await fixture(true);
  try {
    const baseline = f.success(["verify", "status"]);
    expect(baseline).toMatchObject({ all_pass: false });
    expect(
      baseline.checks.find((row: { check: string }) => row.check === "coverage").failures,
    ).toEqual([expect.objectContaining({ code: "COVERAGE_NOT_SATISFIED" })]);
    const file = path.join(f.feature, "spec.md");
    const text = await readFile(file, "utf8");
    await writeFile(
      file,
      text.replace(/requirements:\n[\s\S]*?(?=scenarios:)/, "requirements: []\n"),
    );
    const journal = path.join(f.feature, "journal.jsonl"),
      before = await readFile(journal);
    expect(f.success(["verify", "status"])).toEqual(baseline);
    const result = f.run([
      "gate",
      "decide",
      "verify-accept",
      "--approve",
      "--reason",
      "canonical coverage witness",
    ]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "GATE_PRECONDITION_VIOLATION",
      detail: {
        gate: "verify-accept",
        failure_count: 2,
        checks: [
          expect.objectContaining({
            check: 1,
            code: "VERIFY_LANE_NOT_PASSED",
            detail: { lane: "review" },
          }),
          expect.objectContaining({
            check: 3,
            code: "COVERAGE_NOT_SATISFIED",
            detail: { covered_id: "REQ-VERIFY-001", covered_kind: "REQ" },
          }),
        ],
      },
    });
    expect(await readFile(journal)).toEqual(before);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("closing a finding earlier in the batch cannot satisfy verify approval", async () => {
  const f = await fixture();
  try {
    const initial = await loadSession(f.feature);
    const raised = await mutate(
      {
        at: "2026-10-10T13:00:00.000Z",
        actor: "human:verify-witness@example.invalid",
        entry_schema_version: 1,
        kind: "finding:raised",
        payload: {
          id: "FND-001",
          category: "new-scope",
          action: "amend-tasks",
          summary: "pre-batch acceptance witness",
        },
      },
      {
        feature_dir: f.feature,
        snapshot: initial.snapshot,
        tail_seq: initial.tail_seq,
        entries: initial.entries,
        meta: initial.meta,
        fsync: false,
        registryWriter: { registryDir: path.join(f.root, "registry") },
      },
    );
    expect(raised.ok).toBe(true);
    const loaded = await loadSession(f.feature);
    const journal = path.join(f.feature, "journal.jsonl"),
      before = await readFile(journal);
    const result = await mutateBatch(
      [
        {
          at: "2026-10-10T13:00:01.000Z",
          actor: "human:verify-witness@example.invalid",
          entry_schema_version: 1,
          kind: "finding:closed",
          payload: { id: "FND-001" },
        },
        {
          at: "2026-10-10T13:00:02.000Z",
          actor: "human:verify-witness@example.invalid",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: {
            gate_kind: "verify-accept",
            decision: "approved",
            reason: "pre-batch finding witness",
          },
        },
      ],
      {
        feature_dir: f.feature,
        snapshot: loaded.snapshot,
        tail_seq: loaded.tail_seq,
        entries: loaded.entries,
        meta: loaded.meta,
        fsync: false,
        registryWriter: { registryDir: path.join(f.root, "registry") },
      },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "GATE_PRECONDITION_VIOLATION",
      detail: {
        gate: "verify-accept",
        checks: [
          { check: 2, code: "OPEN_FINDINGS_PRESENT", detail: { count: 1, open_ids: ["FND-001"] } },
        ],
      },
    });
    expect(await readFile(journal)).toEqual(before);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
