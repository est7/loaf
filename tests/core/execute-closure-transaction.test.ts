import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { main, type MainDeps } from "../../src/cli.js";
import { loadSession } from "../../src/core/cli-runtime.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";
import { deriveActualScope } from "../../src/core/scope-projection.js";
import { readSessionRuntimeFile, writeSessionRuntimeFile } from "../../src/core/session-runtime.js";

type Seed = {
  workspace: string;
  featureDir: string;
  runtimeDir: string;
  registryDir: string;
  feature: string;
  sessionId: string;
};

async function runCli(
  seed: Pick<Seed, "workspace" | "featureDir" | "runtimeDir" | "registryDir" | "feature">,
  argv: string[],
  deps: MainDeps = {},
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const originalHome = process.env["HOME"];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  process.env["HOME"] = seed.workspace;
  try {
    const exit = await main(
      [
        "node",
        "loaf",
        ...argv,
        ...(argv[0] === "start" ? [] : ["--feature", seed.feature]),
        "--feature-dir",
        seed.featureDir,
        "--format",
        "json",
      ],
      {
        runtimeDir: seed.runtimeDir,
        registryDir: seed.registryDir,
        ...deps,
      },
    );
    return { exit, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
  }
}

async function seedQuickAtExecuteWork(): Promise<Seed> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-execute-closure-"));
  const feature = "closure-test";
  const featureDir = path.join(workspace, ".loaf", feature);
  const runtimeDir = path.join(workspace, "runtime");
  const registryDir = path.join(workspace, "registry");
  const partial = { workspace, featureDir, runtimeDir, registryDir, feature };
  const started = await runCli(partial, ["start", feature, "--ceremony", "quick"]);
  expect(started.exit).toBe(0);
  const sessionId = (JSON.parse(started.stdout) as { session_id: string }).session_id;
  for (const target of ["TRIAGE.confirm", "EXECUTE.plan", "EXECUTE.work"]) {
    const result = await runCli(partial, ["advance", target]);
    expect(result.exit).toBe(0);
  }
  return { ...partial, sessionId };
}

async function writePending(seed: Seed, paths: string[]): Promise<void> {
  await writeSessionRuntimeFile(
    { session_id: seed.sessionId, cwd: seed.workspace },
    {
      schema_version: 2,
      session_id: seed.sessionId,
      cwd: seed.workspace,
      debug: false,
      heartbeat_at: "2026-07-20T12:00:00.000Z",
      pending_scope: { iteration: 1, paths },
    },
    { runtimeDir: seed.runtimeDir, now: () => new Date("2026-07-20T12:00:00.000Z") },
  );
}

async function journal(seed: Seed): Promise<JournalEntry[]> {
  return (await fs.readFile(path.join(seed.featureDir, "journal.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as JournalEntry);
}

describe("EXECUTE closure transaction", () => {
  test("emits the empty marker immediately before the transition and retry appends nothing", async () => {
    const seed = await seedQuickAtExecuteWork();
    const closed = await runCli(seed, ["advance", "EXECUTE.done"]);
    expect(closed.exit).toBe(0);
    const first = await journal(seed);
    const pair = first.slice(-2);
    expect(pair.map((entry) => entry.kind)).toEqual(["scope:recorded", "event:phase_advanced"]);
    expect(pair[0]!.payload).toEqual({ iteration: 1, paths: [] });
    expect(pair[0]!.batch_id).toBe(pair[1]!.batch_id);

    const retry = await runCli(seed, ["advance", "EXECUTE.done"]);
    expect(retry.exit).toBe(0);
    expect(await journal(seed)).toHaveLength(first.length);
    expect(first.filter((entry) => entry.kind === "scope:recorded")).toHaveLength(1);
  });

  test("a failure before append preserves pending scope for the retry", async () => {
    const seed = await seedQuickAtExecuteWork();
    await writePending(seed, ["src/before.ts"]);
    const crashed = await runCli(seed, ["advance", "EXECUTE.done"], {
      executeClosureHooks: {
        beforeAppend: () => {
          throw new Error("injected before append");
        },
      },
    });
    expect(crashed.exit).toBe(1);
    expect((await journal(seed)).some((entry) => entry.kind === "scope:recorded")).toBe(false);
    expect(
      (
        await readSessionRuntimeFile(
          { session_id: seed.sessionId, cwd: seed.workspace },
          { runtimeDir: seed.runtimeDir, now: () => new Date() },
        )
      )?.pending_scope?.paths,
    ).toEqual(["src/before.ts"]);

    expect((await runCli(seed, ["advance", "EXECUTE.done"])).exit).toBe(0);
    expect((await journal(seed)).at(-2)?.payload).toEqual({
      iteration: 1,
      paths: ["src/before.ts"],
    });
  });

  test("a real journal append failure does not clear pending scope", async () => {
    const seed = await seedQuickAtExecuteWork();
    await writePending(seed, ["src/append-failure.ts"]);
    const journalPath = path.join(seed.featureDir, "journal.jsonl");
    const savedJournalPath = path.join(seed.featureDir, "journal.saved.jsonl");
    const failed = await runCli(seed, ["advance", "EXECUTE.done"], {
      executeClosureHooks: {
        beforeAppend: async () => {
          await fs.rename(journalPath, savedJournalPath);
          await fs.mkdir(journalPath);
        },
      },
    });
    expect(failed.exit).toBe(2);
    await fs.rm(journalPath, { recursive: true });
    await fs.rename(savedJournalPath, journalPath);
    expect(
      (
        await readSessionRuntimeFile(
          { session_id: seed.sessionId, cwd: seed.workspace },
          { runtimeDir: seed.runtimeDir, now: () => new Date() },
        )
      )?.pending_scope?.paths,
    ).toEqual(["src/append-failure.ts"]);
    expect((await journal(seed)).some((entry) => entry.kind === "scope:recorded")).toBe(false);
  });

  test("an unclassified closure exception escapes to the unexpected-error crash boundary", async () => {
    const seed = await seedQuickAtExecuteWork();
    await writePending(seed, ["src/unexpected.ts"]);
    const failed = await runCli(seed, ["advance", "EXECUTE.done"], {
      executeClosureHooks: {
        beforeAppend: () => {
          throw new Error("injected unclassified storage failure");
        },
      },
    });
    expect(failed.exit).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).not.toContain("IO_ERROR");
    const diagnostic = JSON.parse(failed.stderr.trim()) as {
      code: string;
      crash_log?: string;
    };
    expect(diagnostic.code).toBe("UNEXPECTED_ERROR");
    expect(diagnostic.crash_log).toBeDefined();
    const crash = JSON.parse(await fs.readFile(diagnostic.crash_log!, "utf8")) as {
      exitCode: number;
      error: { message: string };
    };
    expect(crash.exitCode).toBe(1);
    expect(crash.error.message).toBe("injected unclassified storage failure");
    expect(
      (
        await readSessionRuntimeFile(
          { session_id: seed.sessionId, cwd: seed.workspace },
          { runtimeDir: seed.runtimeDir, now: () => new Date() },
        )
      )?.pending_scope?.paths,
    ).toEqual(["src/unexpected.ts"]);
  });

  test("a failure after commit leaves pending scope, then done-cursor retry clears without append", async () => {
    const seed = await seedQuickAtExecuteWork();
    await writePending(seed, ["src/after.ts"]);
    const crashed = await runCli(seed, ["advance", "EXECUTE.done"], {
      executeClosureHooks: {
        afterCommitBeforeClear: () => {
          throw new Error("injected after commit before clear");
        },
      },
    });
    expect(crashed.exit).toBe(1);
    const committed = await journal(seed);
    expect(committed.at(-2)?.kind).toBe("scope:recorded");
    expect(
      (
        await readSessionRuntimeFile(
          { session_id: seed.sessionId, cwd: seed.workspace },
          { runtimeDir: seed.runtimeDir, now: () => new Date() },
        )
      )?.pending_scope?.paths,
    ).toEqual(["src/after.ts"]);

    expect((await runCli(seed, ["advance", "EXECUTE.done"])).exit).toBe(0);
    expect(await journal(seed)).toHaveLength(committed.length);
    expect(
      (
        await readSessionRuntimeFile(
          { session_id: seed.sessionId, cwd: seed.workspace },
          { runtimeDir: seed.runtimeDir, now: () => new Date() },
        )
      )?.pending_scope,
    ).toBeNull();
  });

  test("post-append projection failure uses the committed outcome without a discovery reload", async () => {
    const seed = await seedQuickAtExecuteWork();
    await writePending(seed, ["src/projection.ts"]);
    let reloads = 0;
    const failed = await runCli(seed, ["advance", "EXECUTE.done"], {
      executeClosureHooks: {
        reloadSession: async (featureDir) => {
          reloads += 1;
          return await loadSession(featureDir, { ensureDir: false });
        },
        beforeAppend: async () => {
          const snapshots = path.join(seed.featureDir, "snapshots");
          await fs.rm(snapshots, { recursive: true, force: true });
          await fs.writeFile(snapshots, "blocks projection directory");
        },
      },
    });
    expect(failed.exit).toBe(2);
    expect(reloads).toBe(1);
    expect((await journal(seed)).at(-2)?.kind).toBe("scope:recorded");
    expect(
      (
        await readSessionRuntimeFile(
          { session_id: seed.sessionId, cwd: seed.workspace },
          { runtimeDir: seed.runtimeDir, now: () => new Date() },
        )
      )?.pending_scope,
    ).toBeNull();
  });

  test("a second finding-driven iteration records once and actual scope unions both closures", async () => {
    const seed = await seedQuickAtExecuteWork();
    await writePending(seed, ["src/first.ts"]);
    expect((await runCli(seed, ["advance", "EXECUTE.done"])).exit).toBe(0);

    const backEdge = await runCli(seed, [
      "finding",
      "raise",
      "--category",
      "impl-defect",
      "--action",
      "amend-tasks",
      "--summary",
      "add one more implementation task",
    ]);
    expect(backEdge.exit).toBe(0);
    await writeSessionRuntimeFile(
      { session_id: seed.sessionId, cwd: seed.workspace },
      {
        schema_version: 2,
        session_id: seed.sessionId,
        cwd: seed.workspace,
        debug: false,
        heartbeat_at: "2026-07-20T12:01:00.000Z",
        // The old iteration's recorded path is dropped while its uncovered
        // late path is carried into the current iteration's closure.
        pending_scope: { iteration: 1, paths: ["src/first.ts", "src/second.ts"] },
      },
      { runtimeDir: seed.runtimeDir, now: () => new Date("2026-07-20T12:01:00.000Z") },
    );
    expect((await runCli(seed, ["advance", "EXECUTE.done"])).exit).toBe(0);

    const entries = await journal(seed);
    const scopes = entries.filter((entry) => entry.kind === "scope:recorded");
    expect(scopes).toHaveLength(2);
    expect(scopes[1]!.payload).toEqual({ iteration: 2, paths: ["src/second.ts"] });
    expect(await deriveActualScope(entries, seed.featureDir)).toEqual([
      "src/first.ts",
      "src/second.ts",
    ]);
  });

  test("a scope-track invocation waiting on closure carries its late path into the next iteration", async () => {
    const seed = await seedQuickAtExecuteWork();
    await writePending(seed, ["src/early.ts"]);
    let scopeTrack: Promise<number> | undefined;
    const closed = await runCli(seed, ["advance", "EXECUTE.done"], {
      executeClosureHooks: {
        beforeAppend: async () => {
          scopeTrack = main(
            [
              "node",
              "loaf",
              "hook",
              "scope-track",
              "--path",
              path.join(seed.workspace, "src", "late.ts"),
              "--feature",
              seed.feature,
              "--feature-dir",
              seed.featureDir,
              "--format",
              "json",
            ],
            { runtimeDir: seed.runtimeDir, registryDir: seed.registryDir },
          );
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      },
    });
    expect(closed.exit).toBe(0);
    expect(await scopeTrack).toBe(0);

    const entries = await journal(seed);
    expect(entries.at(-2)?.payload).toEqual({ iteration: 1, paths: ["src/early.ts"] });
    expect(
      (
        await readSessionRuntimeFile(
          { session_id: seed.sessionId, cwd: seed.workspace },
          { runtimeDir: seed.runtimeDir, now: () => new Date() },
        )
      )?.pending_scope,
    ).toEqual({ iteration: 1, paths: ["src/late.ts"] });

    const backEdge = await runCli(seed, [
      "finding",
      "raise",
      "--category",
      "impl-defect",
      "--action",
      "amend-tasks",
      "--summary",
      "carry a late scope path into the next implementation iteration",
    ]);
    expect(backEdge.exit).toBe(0);
    const secondClosure = await runCli(seed, ["advance", "EXECUTE.done"]);
    expect(secondClosure.exit).toBe(0);

    const afterSecondClosure = await journal(seed);
    const secondScope = afterSecondClosure.filter(
      (entry) =>
        entry.kind === "scope:recorded" &&
        (entry.payload as { iteration?: number }).iteration === 2,
    );
    expect(secondScope).toHaveLength(1);
    expect(secondScope[0]!.payload).toEqual({ iteration: 2, paths: ["src/late.ts"] });
    const actualScope = await deriveActualScope(afterSecondClosure, seed.featureDir);
    expect(actualScope).toEqual(["src/early.ts", "src/late.ts"]);
    expect(actualScope.filter((scopePath) => scopePath === "src/late.ts")).toHaveLength(1);
  });
});
