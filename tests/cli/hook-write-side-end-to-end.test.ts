// Phase 16 SC-15c — `loaf hook` write-side e2e (write-guard + scope-track).
//
// Uses a PROPER <repoRoot>/.loaf/<feature> layout (not a flat tmp dir) so
// repoRoot = dirname(dirname(featureDir)) resolves correctly and the config
// at <repoRoot>/.loaf/.config/loaf.config.json is found. Decision logic is
// unit-tested in tests/core/write-guard.test.ts; this covers the IO wiring:
// dispatch (fail-closed polarity) + config load + projection load + envelope.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { main, type MainDeps } from "../../src/cli.js";
import { loadProjections } from "../../src/core/projection-loader.js";
import { readSessionRuntimeFile } from "../../src/core/session-runtime.js";

const CLI_SOURCE = path.resolve("src/cli.tsx");

async function tmpRepo(): Promise<{ repoRoot: string; featureDir: string }> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-cli-wg-"));
  const featureDir = path.join(repoRoot, ".loaf", "auth-refresh");
  return { repoRoot, featureDir };
}

async function runCli(
  argv: string[],
  deps: MainDeps = {},
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const oo = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    err.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await main(["node", "loaf", ...argv], deps);
    return { exit, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = oo;
    process.stderr.write = oe;
  }
}

async function start(featureDir: string, ceremony = "standard"): Promise<void> {
  const r = await runCli([
    "start",
    "auth-refresh",
    "--ceremony",
    ceremony,
    "--feature-dir",
    featureDir,
    "--format",
    "json",
  ]);
  if (r.exit !== 0) throw new Error(`start failed (${r.exit}): ${r.stderr}`);
}

async function advance(featureDir: string, to: string): Promise<void> {
  const r = await runCli([
    "advance",
    to,
    "--feature",
    "auth-refresh",
    "--feature-dir",
    featureDir,
    "--format",
    "json",
  ]);
  if (r.exit !== 0) throw new Error(`advance ${to} failed (${r.exit}): ${r.stderr}`);
}

async function startAtExecuteWork(featureDir: string): Promise<void> {
  await start(featureDir, "quick");
  await advance(featureDir, "TRIAGE.confirm");
  await advance(featureDir, "EXECUTE.plan");
  await advance(featureDir, "EXECUTE.work");
}

const scope = (featureDir: string, target: string): string[] => [
  "hook",
  "scope-track",
  "--feature",
  "auth-refresh",
  "--feature-dir",
  featureDir,
  "--path",
  target,
];

async function runtimeState(repoRoot: string, featureDir: string, runtimeDir: string) {
  const loaded = await loadProjections({ feature_dir: featureDir, kinds: ["state"] as const });
  return await readSessionRuntimeFile(
    { session_id: loaded.state.session_id, cwd: repoRoot },
    { runtimeDir, now: () => new Date("2026-07-20T11:00:00.000Z") },
  );
}

async function runScopeChild(input: {
  repoRoot: string;
  featureDir: string;
  home: string;
  target: string;
}): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  const child = spawn("bun", [CLI_SOURCE, ...scope(input.featureDir, input.target)], {
    cwd: input.repoRoot,
    env: { ...process.env, HOME: input.home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [exit] = (await once(child, "exit")) as [number | null];
  return { exit, stdout, stderr };
}

async function writeConfig(repoRoot: string, content: string): Promise<void> {
  const p = path.join(repoRoot, ".loaf", ".config", "loaf.config.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

const wg = (featureDir: string, target: string): string[] => [
  "hook",
  "write-guard",
  "--feature",
  "auth-refresh",
  "--feature-dir",
  featureDir,
  "--path",
  target,
];

describe("SC-15c — write-guard allow/deny", () => {
  test("in-scope write (.loaf/<feature>/state.json at TRIAGE.score) → exit 0 allow", async () => {
    const { repoRoot, featureDir } = await tmpRepo();
    await start(featureDir);
    const r = await runCli(wg(featureDir, path.join(featureDir, "state.json")));
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    void repoRoot;
  });

  test("out-of-scope write (src/foo.ts at TRIAGE.score) → exit 2 WRITE_PATH_VIOLATION", async () => {
    const { repoRoot, featureDir } = await tmpRepo();
    await start(featureDir);
    const r = await runCli([
      ...wg(featureDir, path.join(repoRoot, "src", "foo.ts")),
      "--format",
      "json",
    ]);
    expect(r.exit).toBe(2);
    const e = JSON.parse(r.stderr);
    expect(e.code).toBe("WRITE_PATH_VIOLATION");
    expect(e.detail.normalized_path).toBe("src/foo.ts");
    expect(e.detail.sub_state).toBe("TRIAGE.score");
  });

  test("outside-repo write → exit 2 with explicit containment reason", async () => {
    const { repoRoot, featureDir } = await tmpRepo();
    await start(featureDir);
    const r = await runCli([
      ...wg(featureDir, path.join(repoRoot, "..", "outside", "secret.ts")),
      "--format",
      "json",
    ]);
    expect(r.exit).toBe(2);
    const e = JSON.parse(r.stderr);
    expect(e.code).toBe("WRITE_PATH_VIOLATION");
    expect(e.detail.reason).toBe("outside_repo_root");
  });

  test("protected_files write → exit 2 PROTECTED_FILE_WRITE (hard-deny beats allow)", async () => {
    const { repoRoot, featureDir } = await tmpRepo();
    await start(featureDir);
    await writeConfig(
      repoRoot,
      JSON.stringify({
        schema_version: 2,
        protected_files: [".loaf/auth-refresh/state.json"],
        paths: {},
      }),
    );
    const r = await runCli([
      ...wg(featureDir, path.join(featureDir, "state.json")),
      "--format",
      "json",
    ]);
    expect(r.exit).toBe(2);
    const e = JSON.parse(r.stderr);
    expect(e.code).toBe("PROTECTED_FILE_WRITE");
    expect(e.detail.matched_deny).toBe(".loaf/auth-refresh/state.json");
  });
});

describe("SC-15c — write-guard fail-closed / allow polarity", () => {
  test("no loaf session (unresolvable feature) → allow exit 0", async () => {
    const { featureDir } = await tmpRepo();
    const r = await runCli(wg(featureDir, "/anywhere/x.ts")); // never started
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  test("selected session with invalid config → fail closed exit 2", async () => {
    const { repoRoot, featureDir } = await tmpRepo();
    await start(featureDir);
    await writeConfig(repoRoot, "{ malformed json");
    const r = await runCli([
      ...wg(featureDir, path.join(featureDir, "state.json")),
      "--format",
      "json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr).code).toBe("SCHEMA_VALIDATION_FAILED");
  });
});

describe("SC-15c — strict stdin resolution", () => {
  test("non-TTY stdin hook payload (tool_input.file_path) resolves the path → allow", async () => {
    const { featureDir } = await tmpRepo();
    await start(featureDir);
    const deps: MainDeps = {
      isStdinTty: () => false,
      readStdin: async () =>
        JSON.stringify({ tool_input: { file_path: path.join(featureDir, "state.json") } }),
    };
    const r = await runCli(
      ["hook", "write-guard", "--feature", "auth-refresh", "--feature-dir", featureDir],
      deps,
    );
    expect(r.exit).toBe(0);
  });

  test("malformed stdin JSON → SCHEMA_VALIDATION_FAILED exit 2 (fail closed)", async () => {
    const { featureDir } = await tmpRepo();
    await start(featureDir);
    const deps: MainDeps = { isStdinTty: () => false, readStdin: async () => "{ not json" };
    const r = await runCli(
      [
        "hook",
        "write-guard",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      deps,
    );
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr).code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  test("TTY + no --path → USAGE exit 2", async () => {
    const { featureDir } = await tmpRepo();
    await start(featureDir);
    const r = await runCli(
      [
        "hook",
        "write-guard",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      { isStdinTty: () => true },
    );
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr).code).toBe("USAGE");
  });
});

describe("ticket #11 SC3 — scope-track runtime accumulator", () => {
  test("absolute, relative, and symlink-inside paths accumulate resolved canonical paths", async () => {
    const { repoRoot, featureDir } = await tmpRepo();
    const runtimeDir = path.join(repoRoot, "runtime");
    await startAtExecuteWork(featureDir);
    await fs.mkdir(path.join(repoRoot, "src"));
    await fs.writeFile(path.join(repoRoot, "src", "absolute.ts"), "");
    await fs.writeFile(path.join(repoRoot, "src", "relative.ts"), "");
    await fs.writeFile(path.join(repoRoot, "src", "resolved.ts"), "");
    await fs.symlink(path.join(repoRoot, "src", "resolved.ts"), path.join(repoRoot, "alias.ts"));
    const deps = { runtimeDir, now: () => new Date("2026-07-20T11:00:00.000Z") };
    const results = [
      await runCli(scope(featureDir, path.join(repoRoot, "src", "absolute.ts")), deps),
      await runCli(scope(featureDir, "src/relative.ts"), deps),
      await runCli(scope(featureDir, path.join(repoRoot, "alias.ts")), deps),
    ];
    for (const r of results) {
      expect(r).toMatchObject({ exit: 0, stdout: "", stderr: "" });
    }
    expect((await runtimeState(repoRoot, featureDir, runtimeDir))?.pending_scope).toEqual({
      iteration: 1,
      paths: ["src/absolute.ts", "src/relative.ts", "src/resolved.ts"],
    });
  });

  test("outside and symlink-outside reject exit 2 but still refresh heartbeat", async () => {
    const { repoRoot, featureDir } = await tmpRepo();
    const runtimeDir = path.join(repoRoot, "runtime");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-scope-outside-"));
    await startAtExecuteWork(featureDir);
    await fs.writeFile(path.join(outside, "secret.ts"), "");
    await fs.symlink(path.join(outside, "secret.ts"), path.join(repoRoot, "escape.ts"));
    const deps = { runtimeDir, now: () => new Date("2026-07-20T11:01:00.000Z") };
    for (const target of [path.join(outside, "secret.ts"), path.join(repoRoot, "escape.ts")]) {
      const r = await runCli([...scope(featureDir, target), "--format", "json"], deps);
      expect(r.exit).toBe(2);
      expect(r.stdout).toBe("");
    }
    const runtime = await runtimeState(repoRoot, featureDir, runtimeDir);
    expect(runtime?.heartbeat_at).toBe("2026-07-20T11:01:00.000Z");
    expect(runtime?.pending_scope).toBeNull();
  });

  test(".loaf path and non-EXECUTE.work cursor refresh heartbeat without accumulation", async () => {
    const first = await tmpRepo();
    const firstRuntime = path.join(first.repoRoot, "runtime");
    await startAtExecuteWork(first.featureDir);
    await fs.writeFile(path.join(first.repoRoot, "kept.ts"), "");
    const accumulated = await runCli(scope(first.featureDir, "kept.ts"), {
      runtimeDir: firstRuntime,
      now: () => new Date("2026-07-20T11:01:30.000Z"),
    });
    expect(accumulated).toMatchObject({ exit: 0, stdout: "", stderr: "" });
    const internal = await runCli(
      scope(first.featureDir, path.join(first.featureDir, "snapshots", "state.json")),
      { runtimeDir: firstRuntime, now: () => new Date("2026-07-20T11:02:00.000Z") },
    );
    expect(internal).toMatchObject({ exit: 0, stdout: "", stderr: "" });
    expect(await runtimeState(first.repoRoot, first.featureDir, firstRuntime)).toMatchObject({
      heartbeat_at: "2026-07-20T11:02:00.000Z",
      pending_scope: { iteration: 1, paths: ["kept.ts"] },
    });

    const second = await tmpRepo();
    const secondRuntime = path.join(second.repoRoot, "runtime");
    await start(second.featureDir);
    await fs.writeFile(path.join(second.repoRoot, "ordinary.ts"), "");
    const nonExecute = await runCli(scope(second.featureDir, "ordinary.ts"), {
      runtimeDir: secondRuntime,
      now: () => new Date("2026-07-20T11:03:00.000Z"),
    });
    expect(nonExecute).toMatchObject({ exit: 0, stdout: "", stderr: "" });
    expect(await runtimeState(second.repoRoot, second.featureDir, secondRuntime)).toMatchObject({
      heartbeat_at: "2026-07-20T11:03:00.000Z",
      pending_scope: null,
    });
  });

  test("no session is silent; selected stale session fails closed", async () => {
    const absent = await tmpRepo();
    const absentRuntime = path.join(absent.repoRoot, "runtime");
    const noSession = await runCli(scope(absent.featureDir, "/outside.ts"), {
      runtimeDir: absentRuntime,
      now: () => new Date("2026-07-20T11:04:00.000Z"),
    });
    expect(noSession).toMatchObject({ exit: 0, stdout: "", stderr: "" });
    await expect(fs.access(absentRuntime)).rejects.toMatchObject({ code: "ENOENT" });

    const stale = await tmpRepo();
    await start(stale.featureDir);
    await fs.writeFile(path.join(stale.featureDir, "snapshots", "state.json"), "{broken");
    const selectedStale = await runCli(
      [...scope(stale.featureDir, path.join(stale.repoRoot, "x.ts")), "--format", "json"],
      {
        runtimeDir: path.join(stale.repoRoot, "runtime"),
        now: () => new Date("2026-07-20T11:04:00.000Z"),
      },
    );
    expect(selectedStale.exit).toBe(2);
    expect(selectedStale.stdout).toBe("");
  });

  test("hook stdin path follows the same strict resolver and keeps stdout empty", async () => {
    const { repoRoot, featureDir } = await tmpRepo();
    const runtimeDir = path.join(repoRoot, "runtime");
    await startAtExecuteWork(featureDir);
    await fs.writeFile(path.join(repoRoot, "stdin.ts"), "");
    const r = await runCli(
      ["hook", "scope-track", "--feature", "auth-refresh", "--feature-dir", featureDir],
      {
        runtimeDir,
        now: () => new Date("2026-07-20T11:05:00.000Z"),
        isStdinTty: () => false,
        readStdin: async () =>
          JSON.stringify({ tool_input: { file_path: path.join(repoRoot, "stdin.ts") } }),
      },
    );
    expect(r).toMatchObject({ exit: 0, stdout: "", stderr: "" });
    expect((await runtimeState(repoRoot, featureDir, runtimeDir))?.pending_scope?.paths).toEqual([
      "stdin.ts",
    ]);
  });

  test("concurrent cross-process scope-track invocations retain every path", async () => {
    const { repoRoot, featureDir } = await tmpRepo();
    const home = path.join(repoRoot, "home");
    await fs.mkdir(home);
    await startAtExecuteWork(featureDir);
    const targets = Array.from({ length: 12 }, (_, index) =>
      path.join(repoRoot, `parallel-${String(index).padStart(2, "0")}.ts`),
    );
    await Promise.all(targets.map(async (target) => await fs.writeFile(target, "")));
    const results = await Promise.all(
      targets.map(async (target) => await runScopeChild({ repoRoot, featureDir, home, target })),
    );
    for (const r of results) expect(r).toMatchObject({ exit: 0, stdout: "", stderr: "" });
    const runtimeDir = path.join(home, ".loaf", "runtime");
    expect((await runtimeState(repoRoot, featureDir, runtimeDir))?.pending_scope?.paths).toEqual(
      targets.map((target) => path.basename(target)),
    );
  });
});
