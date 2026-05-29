// Phase 16 SC-14 — `loaf tui` CLI e2e (guard-focused).
//
// Per codex r355 Q3 / r356 ack 2 layering: pure formatter tests
// (`tests/cli/format-row.test.ts`) carry the behavior contract; this
// file asserts CLI guards (TTY / selectors / --format / --dry-run) and
// the render-injection path is reached after guards.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main, type MainDeps } from "../../src/cli.js";

async function tmpRegDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc14-tui-"));
}

async function runCli(
  argv: string[],
  opts: { env?: Record<string, string | undefined>; deps?: MainDeps; cwd?: string } = {},
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const origCwd = process.cwd();
  const envBackup: Record<string, string | undefined> = {};
  if (opts.env) {
    for (const k of Object.keys(opts.env)) {
      envBackup[k] = process.env[k];
      const v = opts.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  if (opts.cwd) process.chdir(opts.cwd);
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    stderrChunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await main(["node", "loaf", ...argv], opts.deps ?? {});
    return { exit, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
    if (opts.cwd) process.chdir(origCwd);
    for (const k of Object.keys(envBackup)) {
      const prev = envBackup[k];
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

/** Seed a session in a tmp registry dir so tui has something to read. */
async function seedSession(registryDir: string): Promise<{ featureDir: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc14-cwd-"));
  const featureDir = path.join(cwd, ".loaf", "auth-refresh");
  await fs.mkdir(featureDir, { recursive: true });
  const result = await runCli(
    ["start", "auth-refresh", "--ceremony", "standard",
     "--feature-dir", featureDir, "--format", "json"],
    { deps: { registryDir, registryCwd: () => cwd }, cwd },
  );
  if (result.exit !== 0) throw new Error(`seed start failed: ${result.stderr}`);
  return { featureDir };
}

/** Stub TUI render that resolves immediately + captures the App's
 *  props for assertion. */
function makeRenderStub() {
  const captured: {
    initialRows?: ReadonlyArray<unknown>;
    loadRowsCalled?: boolean;
  } = {};
  const renderTui: MainDeps["renderTui"] = async (app) => {
    const props = (app as { props: { initialRows?: unknown; loadRows?: () => Promise<unknown> } }).props;
    captured.initialRows = (props.initialRows as ReadonlyArray<unknown>) ?? undefined;
    if (typeof props.loadRows === "function") {
      captured.loadRowsCalled = true;
    }
    // Resolve immediately to simulate user pressing q.
  };
  return { renderTui, captured };
}

const BOTH_TTY: Pick<MainDeps, "isStdinTty" | "isStdoutTty"> = {
  isStdinTty: () => true,
  isStdoutTty: () => true,
};

describe("SC-14 — loaf tui TTY guard", () => {
  test("non-TTY stdin → exit 2 USAGE", async () => {
    const result = await runCli(["tui"], {
      deps: { isStdinTty: () => false, isStdoutTty: () => true },
    });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("USAGE");
    expect(result.stderr).toContain("TUI requires an interactive terminal");
  });

  test("non-TTY stdout → exit 2 USAGE", async () => {
    const result = await runCli(["tui"], {
      deps: { isStdinTty: () => true, isStdoutTty: () => false },
    });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("USAGE");
  });

  test("both non-TTY → exit 2 USAGE", async () => {
    const result = await runCli(["tui"], {
      deps: { isStdinTty: () => false, isStdoutTty: () => false },
    });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("USAGE");
  });

  test("both TTY → render path reached (stub asserts initialRows + loadRows passed)", async () => {
    const registryDir = await tmpRegDir();
    await seedSession(registryDir);
    const { renderTui, captured } = makeRenderStub();
    const result = await runCli(["tui"], {
      deps: { ...BOTH_TTY, renderTui, registryDir },
    });
    expect(result.exit).toBe(0);
    expect(captured.initialRows).toBeDefined();
    expect(captured.initialRows!.length).toBe(1);
    expect(captured.loadRowsCalled).toBe(true);
  });
});

describe("SC-14 — loaf tui pre-parse guards", () => {
  test("--session → USAGE conflicting", async () => {
    const result = await runCli(
      ["tui", "--session", "abcdefgh"],
      { deps: BOTH_TTY },
    );
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("USAGE");
    expect(result.stderr).toContain("--session");
  });

  test("--feature → USAGE conflicting", async () => {
    const result = await runCli(
      ["tui", "--feature", "foo"],
      { deps: BOTH_TTY },
    );
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("USAGE");
    expect(result.stderr).toContain("--feature");
  });

  test("--feature-dir → USAGE conflicting", async () => {
    const result = await runCli(
      ["tui", "--feature-dir", "/tmp/x"],
      { deps: BOTH_TTY },
    );
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("USAGE");
    expect(result.stderr).toContain("--feature-dir");
  });

  test("$LOAF_FEATURE env → USAGE conflicting", async () => {
    const result = await runCli(["tui"], {
      env: { LOAF_FEATURE: "foo" },
      deps: BOTH_TTY,
    });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("USAGE");
    expect(result.stderr).toContain("$LOAF_FEATURE");
  });

  test("--format → USAGE tui-interactive-only", async () => {
    const result = await runCli(
      ["tui", "--format", "json"],
      { deps: BOTH_TTY },
    );
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("USAGE");
    expect(result.stderr).toContain("interactive-only");
  });

  test("--dry-run → DRY_RUN_NOT_APPLICABLE (read-only)", async () => {
    const result = await runCli(
      ["tui", "--dry-run", "--format=json"],
      { deps: BOTH_TTY },
    );
    expect(result.exit).toBe(2);
    // --format=json is rejected pre-parse BEFORE --dry-run sees this,
    // so we may get the format USAGE instead. Drop the --format-json
    // flag to test --dry-run path cleanly.
    const result2 = await runCli(["tui", "--dry-run"], { deps: BOTH_TTY });
    expect(result2.exit).toBe(2);
    expect(result2.stderr).toContain("DRY_RUN_NOT_APPLICABLE");
  });
});

describe("SC-14 — loaf tui registry override preserved", () => {
  test("LOAF_REGISTRY_DIR NOT treated as a selector (it's SC-7 test override)", async () => {
    const registryDir = await tmpRegDir();
    const { renderTui, captured } = makeRenderStub();
    const result = await runCli(["tui"], {
      env: { LOAF_REGISTRY_DIR: registryDir },
      deps: { ...BOTH_TTY, renderTui },
    });
    expect(result.exit).toBe(0);
    // Empty registry → 0 rows but render reached
    expect(captured.initialRows).toEqual([]);
    expect(captured.loadRowsCalled).toBe(true);
  });
});

describe("SC-14 — sessions list still works (active_tasks + session_label additive)", () => {
  test("sessions list JSON envelope grows session_label + active_tasks fields", async () => {
    const registryDir = await tmpRegDir();
    await seedSession(registryDir);
    const result = await runCli(
      ["sessions", "list", "--format", "json"],
      { deps: { registryDir } },
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.sessions).toHaveLength(1);
    const row = out.sessions[0];
    expect(row.session_label).toBeDefined();
    expect(typeof row.session_label).toBe("string");
    expect(Array.isArray(row.active_tasks)).toBe(true);
  });
});
