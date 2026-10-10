import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, unlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { loadSession } from "../../src/core/cli-runtime.js";

const cli = path.resolve("src/cli.tsx");
async function fixture(coverageRequired = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "loaf-verify-next-snapshot-"));
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
    for (const target of ["EXECUTE.done", "VERIFY.plan", "VERIFY.run"])
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
  "erase",
  "invent",
])("VERIFY next retains canonical route when derived spec.md is %s", async (mode) => {
  const required = mode !== "invent";
  const f = await fixture(required);
  try {
    const baseline = f.success(["next"]);
    const target = required ? "VERIFY.review" : "VERIFY.accept";
    expect(baseline.next_action).toMatchObject({ owner_verb: "advance", target, blocking: false });
    const file = path.join(f.feature, "spec.md");
    if (mode === "missing") await unlink(file);
    else if (mode === "malformed") await writeFile(file, "---\n[: bogus yaml :]\n---\n");
    else if (mode === "erase")
      await writeFile(
        file,
        (await readFile(file, "utf8")).replace(
          /requirements:\n[\s\S]*?(?=scenarios:)/,
          "requirements: []\n",
        ),
      );
    else
      await writeFile(
        file,
        (await readFile(file, "utf8")).replace(
          "requirements: []",
          "requirements:\n  - id: REQ-FILE-999\n    type: ubiquitous\n    response: the system shall demand an unaccepted coverage obligation\n    measurable: {metric: documents, threshold: all, unit: documents}",
        ),
      );
    const journal = path.join(f.feature, "journal.jsonl"),
      before = await readFile(journal);
    expect(f.success(["next"])).toEqual(baseline);
    const diagnostic = f.success(["verify", "status"]);
    expect(
      diagnostic.lanes.find((lane: { lane: string }) => lane.lane === "review").applicability,
    ).toBe(required ? "must" : "na");
    expect(await readFile(journal)).toEqual(before);
    const routed = spawnSync(
      "/bin/sh",
      [
        "-c",
        `loaf() { bun "$LOAF_TEST_CLI" "$@" --format=json --quiet; }; ${baseline.next_action.command}`,
      ],
      {
        cwd: f.root,
        env: {
          ...process.env,
          HOME: f.root,
          LOAF_REGISTRY_DIR: path.join(f.root, "registry"),
          LOAF_LANG: "en",
          LOAF_TEST_CLI: cli,
          LOAF_FEATURE: undefined,
          LOAF_SESSION: undefined,
        },
        encoding: "utf8",
      },
    );
    expect(routed.status, routed.stderr).toBe(0);
    expect((await loadSession(f.feature)).snapshot.state?.sub_state).toBe(target);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("VERIFY next rejects stale tasks projection before replaying canonical spec", async () => {
  const f = await fixture(true);
  try {
    const projection = path.join(f.feature, "snapshots", "tasks.json");
    await writeFile(projection, "{}\n");
    const journal = path.join(f.feature, "journal.jsonl"),
      before = await readFile(journal);
    const result = f.run(["next"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).code).toBe("SNAPSHOT_STALE_REBUILD_REQUIRED");
    expect(await readFile(journal)).toEqual(before);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
