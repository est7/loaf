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

import { main, type MainDeps } from "../../src/cli.js";

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

async function start(featureDir: string): Promise<void> {
  const r = await runCli([
    "start",
    "auth-refresh",
    "--ceremony",
    "standard",
    "--feature-dir",
    featureDir,
    "--format",
    "json",
  ]);
  if (r.exit !== 0) throw new Error(`start failed (${r.exit}): ${r.stderr}`);
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

describe("SC-15c — scope-track stub", () => {
  test("--path given → exit 0, writes nothing", async () => {
    const { featureDir } = await tmpRepo();
    await start(featureDir);
    const r = await runCli([
      "hook",
      "scope-track",
      "--feature",
      "auth-refresh",
      "--feature-dir",
      featureDir,
      "--path",
      path.join(featureDir, "state.json"),
    ]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  test("no longer returns HOOK_EVENT_NOT_IMPLEMENTED", async () => {
    const { featureDir } = await tmpRepo();
    const r = await runCli(
      [
        "hook",
        "scope-track",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      { isStdinTty: () => true },
    );
    expect(r.stderr).not.toContain("HOOK_EVENT_NOT_IMPLEMENTED");
  });
});
