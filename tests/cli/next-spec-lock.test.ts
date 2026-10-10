import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { main, type MainDeps } from "../../src/cli.js";
import { loadSession } from "../../src/core/cli-runtime.js";
import { mutate } from "../../src/core/journal-mutate.js";
import { replayJournal } from "../../src/core/journal-bootstrap.js";
import { evaluateSpecLockFromSnapshot } from "../../src/core/gates/spec-lock-eval.js";

async function run(args: string[], deps: MainDeps) {
  let stdout = "",
    stderr = "";
  const out = process.stdout.write,
    err = process.stderr.write;
  process.stdout.write = ((value: string | Uint8Array) => {
    stdout += String(value);
    return true;
  }) as typeof out;
  process.stderr.write = ((value: string | Uint8Array) => {
    stderr += String(value);
    return true;
  }) as typeof err;
  try {
    return {
      exit: await main(["node", "loaf", ...args, "--format=json", "--quiet"], deps),
      stdout,
      stderr,
    };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}
afterEach(() => vi.unstubAllEnvs());
test("next routes an admitted real journal after standalone approved spec-lock without crashing or writing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "loaf-next-spec-lock-"));
  const feature = path.join(root, "feature"),
    registry = path.join(root, "registry"),
    home = path.join(root, "home");
  vi.stubEnv("HOME", home);
  vi.stubEnv("LOAF_LANG", "en");
  vi.stubEnv("LOAF_FEATURE", undefined);
  vi.stubEnv("LOAF_SESSION", undefined);
  const deps: MainDeps = { userConfigHomeDir: home, registryDir: registry };
  const selector = ["--feature", "probe", "--feature-dir", feature];
  const success = async (args: string[]) => {
    const result = await run(args, deps);
    expect(result.exit, result.stderr).toBe(0);
    return result;
  };
  try {
    await success(["start", "probe", "--ceremony", "standard", "--feature-dir", feature]);
    for (const target of ["TRIAGE.confirm", "SPEC.proposal"])
      await success(["advance", target, ...selector]);
    const spec = path.join(root, "spec.json");
    await writeFile(
      spec,
      JSON.stringify({
        feature: { id: "F-001", name: "Next action witness" },
        intent: "verify standalone spec lock routing",
        adr_refs: [],
        requirements: [],
        scenarios: [],
        visual_contracts: [],
        needs_clarification: [],
      }),
    );
    await success(["spec", "submit", "--input", spec, ...selector]);
    for (const target of ["SPEC.spec", "SPEC.plan", "SPEC.design"])
      await success(["advance", target, ...selector]);
    const tasks = path.join(root, "tasks.json");
    await writeFile(
      tasks,
      JSON.stringify({
        tasks: [
          {
            local_key: "witness",
            kind: "docs",
            no_test_rationale: "documentation-only reachability witness",
          },
        ],
      }),
    );
    await success(["tasks", "submit", "--input", tasks, ...selector]);
    const loaded = await loadSession(feature);
    expect(evaluateSpecLockFromSnapshot(loaded.snapshot)).toEqual({ ok: true });
    const mutation = await mutate(
      {
        at: "2026-10-10T12:25:00.000Z",
        actor: "human:witness@example.invalid",
        entry_schema_version: 1,
        kind: "gate:decided",
        payload: {
          gate_kind: "spec-lock",
          decision: "approved",
          reason: "standalone gate witness",
        },
      },
      {
        feature_dir: feature,
        snapshot: loaded.snapshot,
        tail_seq: loaded.tail_seq,
        entries: loaded.entries,
        meta: loaded.meta,
        fsync: false,
        registryWriter: { registryDir: registry },
      },
    );
    expect(mutation).toMatchObject({ ok: true, commit_state: "committed" });
    const journal = path.join(feature, "journal.jsonl"),
      before = await readFile(journal);
    const replay = await replayJournal(journal, { collect_entries: true });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.code);
    expect(replay.entries).toHaveLength(9);
    expect(replay.snapshot.state).toMatchObject({ sub_state: "SPEC.design", spec_locked: true });
    expect(replay.snapshot.pending).toEqual([]);
    const result = await run(["next", ...selector], deps);
    expect(result.exit, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      ok: true,
      cursor: { phase: "SPEC", sub_state: "SPEC.design" },
      terminal: false,
      blocked: false,
      next_action: {
        owner_verb: "advance",
        target: "EXECUTE.plan",
        blocking: false,
        reason: "ADVANCE_TO_NEXT_SUB_STATE",
      },
    });
    expect(output.next_action.command).toContain("advance EXECUTE.plan");
    expect(await readFile(journal)).toEqual(before);
    expect((await loadSession(feature)).snapshot.state).toMatchObject({
      sub_state: "SPEC.design",
      spec_locked: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
