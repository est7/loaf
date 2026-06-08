// Phase 16 SC-8 — dispatch end-to-end CLI integration.
//
// Covers:
//   T18: --session <UUID> CLI invocation
//   T19: $LOAF_SESSION env invocation
//   T20: auto-pick (1 active) + stderr advisory via ctx.advisory
//   T21: --quiet suppresses auto-pick advisory
//   T-order: --session before AND after subcommand
//   T-usage-1: --session + --feature-dir → USAGE
//   T-usage-2: $LOAF_SESSION + --feature-dir → USAGE
//   T-usage-3: bare --feature-dir → USAGE

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main, type MainDeps } from "../../src/cli.js";

async function tmpRegDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc8-cli-reg-"));
}

async function tmpCwdAndFeature(
  featureName: string,
  registryDir: string,
): Promise<{
  cwd: string;
  featureDir: string;
  sessionId: string;
}> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc8-cli-cwd-"));
  const featureDir = path.join(cwd, ".loaf", featureName);
  // Use real `loaf start` to seed + populate registry.
  await runCli(
    [
      "start",
      featureName,
      "--ceremony",
      "standard",
      "--feature-dir",
      featureDir,
      "--format",
      "json",
    ],
    { deps: { registryDir, registryCwd: () => cwd }, cwd },
  );
  const files = await fs.readdir(registryDir);
  expect(files.length).toBeGreaterThanOrEqual(1);
  const reg = JSON.parse(
    await fs.readFile(path.join(registryDir, files[files.length - 1]!), "utf8"),
  );
  return { cwd, featureDir, sessionId: reg.session_id };
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
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
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

describe("SC-8 — CLI dispatch integration", () => {
  test("T18: --session <UUID> resolves dispatch + runs the command", async () => {
    const registryDir = await tmpRegDir();
    const { cwd, sessionId } = await tmpCwdAndFeature("auth-refresh", registryDir);

    const result = await runCli(["--session", sessionId, "status", "--format", "json"], {
      deps: { registryDir },
      cwd,
    });
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.feature).toBe("auth-refresh");
  });

  test("T19: $LOAF_SESSION env resolves dispatch", async () => {
    const registryDir = await tmpRegDir();
    const { cwd, sessionId } = await tmpCwdAndFeature("auth-refresh", registryDir);

    const result = await runCli(["status", "--format", "json"], {
      deps: { registryDir },
      cwd,
      env: { LOAF_SESSION: sessionId },
    });
    expect(result.exit).toBe(0);
  });

  test("T20: auto-pick (1 active feature) + stderr advisory", async () => {
    const registryDir = await tmpRegDir();
    const { cwd } = await tmpCwdAndFeature("auth-refresh", registryDir);

    const result = await runCli(["status", "--format", "json"], { deps: { registryDir }, cwd });
    expect(result.exit).toBe(0);
    expect(result.stderr).toContain("auto-picked 'auth-refresh'");
  });

  test("T21: --quiet suppresses auto-pick advisory", async () => {
    const registryDir = await tmpRegDir();
    const { cwd } = await tmpCwdAndFeature("auth-refresh", registryDir);

    const result = await runCli(["status", "--quiet", "--format", "json"], {
      deps: { registryDir },
      cwd,
    });
    expect(result.exit).toBe(0);
    expect(result.stderr).not.toContain("auto-picked");
  });

  test("T-order: --session works before AND after subcommand (Commander global option)", async () => {
    const registryDir = await tmpRegDir();
    const { cwd, sessionId } = await tmpCwdAndFeature("auth-refresh", registryDir);

    const r1 = await runCli(["--session", sessionId, "status", "--format", "json"], {
      deps: { registryDir },
      cwd,
    });
    const r2 = await runCli(["status", "--session", sessionId, "--format", "json"], {
      deps: { registryDir },
      cwd,
    });
    expect(r1.exit).toBe(0);
    expect(r2.exit).toBe(0);
    expect(JSON.parse(r1.stdout).feature).toBe(JSON.parse(r2.stdout).feature);
  });

  test("T-usage-1: --session + --feature-dir → USAGE", async () => {
    const registryDir = await tmpRegDir();
    const result = await runCli(
      [
        "--session",
        "550e8400-e29b-41d4-a716-aaaaaaaaaaaa",
        "--feature-dir",
        "/tmp/x",
        "status",
        "--format",
        "json",
      ],
      { deps: { registryDir } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("USAGE");
  });

  test("T-usage-2: $LOAF_SESSION + --feature-dir → USAGE", async () => {
    const registryDir = await tmpRegDir();
    const result = await runCli(["--feature-dir", "/tmp/x", "status", "--format", "json"], {
      deps: { registryDir },
      env: { LOAF_SESSION: "550e8400-e29b-41d4-a716-aaaaaaaaaaaa" },
    });
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("USAGE");
  });

  test("T-usage-3: bare --feature-dir (per-command position) → USAGE via dispatch", async () => {
    const registryDir = await tmpRegDir();
    // Per-command position; Commander accepts (status has --feature-dir
    // option). Then ctx.resolveDispatch catches bare-feature-dir +
    // no-feature → USAGE.
    const result = await runCli(["status", "--feature-dir", "/tmp/x", "--format", "json"], {
      deps: { registryDir },
    });
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("USAGE");
  });

  test("T-usage-4: bare --feature-dir (global position) → USAGE via pre-parse (codex r287 P2)", async () => {
    const registryDir = await tmpRegDir();
    const result = await runCli(["--feature-dir", "/tmp/x", "status", "--format", "json"], {
      deps: { registryDir },
    });
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("USAGE");
    expect(err.detail.conflicting).toEqual(["--feature-dir"]);
  });

  test("T-usage-5 (text mode): --session + --feature-dir → text-rendered USAGE (codex r287 P1)", async () => {
    const registryDir = await tmpRegDir();
    const result = await runCli(
      ["--session", "550e8400-e29b-41d4-a716-aaaaaaaaaaaa", "--feature-dir", "/tmp/x", "status"],
      { deps: { registryDir } },
    );
    expect(result.exit).toBe(2);
    // Text mode: `error: USAGE — <message>\n` (no JSON envelope)
    expect(result.stderr).toMatch(/^error: USAGE —/);
    expect(result.stderr).not.toMatch(/^\{/);
  });

  test("T-usage-6 (text mode): bare --feature-dir global → text-rendered USAGE", async () => {
    const registryDir = await tmpRegDir();
    const result = await runCli(["--feature-dir", "/tmp/x", "status"], { deps: { registryDir } });
    expect(result.exit).toBe(2);
    expect(result.stderr).toMatch(/^error: USAGE —/);
  });

  test("LOAF_LANG=zh localizes dispatch session/feature-dir text failure", async () => {
    const registryDir = await tmpRegDir();
    const result = await runCli(
      ["--session", "550e8400-e29b-41d4-a716-aaaaaaaaaaaa", "--feature-dir", "/tmp/x", "status"],
      { deps: { registryDir }, env: { LOAF_LANG: "zh" } },
    );
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("不能与 --feature-dir 一起使用");
  });

  test("LOAF_LANG=zh leaves dispatch broad USAGE JSON message byte-stable", async () => {
    const registryDir = await tmpRegDir();
    const argv = [
      "--session",
      "550e8400-e29b-41d4-a716-aaaaaaaaaaaa",
      "--feature-dir",
      "/tmp/x",
      "status",
      "--format",
      "json",
    ];
    const enResult = await runCli(argv, { deps: { registryDir } });
    const zhResult = await runCli(argv, { deps: { registryDir }, env: { LOAF_LANG: "zh" } });
    expect(enResult.exit).toBe(2);
    expect(zhResult.exit).toBe(2);
    expect(zhResult.stderr).toBe(enResult.stderr);
  });

  test("LOAF_LANG=zh localizes bare feature-dir text failure", async () => {
    const registryDir = await tmpRegDir();
    const result = await runCli(["--feature-dir", "/tmp/x", "status"], {
      deps: { registryDir },
      env: { LOAF_LANG: "zh" },
    });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("--feature-dir 需要 --feature <name> 或 $LOAF_FEATURE");
  });

  test("T-start-exempt: loaf start <feature> --feature-dir <path> NOT rejected (start has positional feature)", async () => {
    const registryDir = await tmpRegDir();
    const featureDir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc8-start-"));
    const result = await runCli(
      [
        "start",
        "auth-refresh",
        "--ceremony",
        "standard",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      { deps: { registryDir } },
    );
    expect(result.exit).toBe(0);
  });

  test("T-isolation: LOAF_REGISTRY_DIR is honored by dispatch (regression)", async () => {
    // The vitest setup file already sets LOAF_REGISTRY_DIR to a tmp dir.
    // Inject NO registryDir via deps → defaultRegistryDir() reads env override.
    const realRegistry = path.join(os.homedir(), ".loaf", "registry");
    const sessionId = "550e8400-e29b-41d4-a716-deadbeefcafe";

    // Pre-check: real registry should NOT have this session
    try {
      await fs.stat(path.join(realRegistry, `${sessionId}.json`));
      throw new Error("test setup: real registry has fixture session — investigate");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }

    // Run with no deps.registryDir; dispatch uses default which honors env.
    const result = await runCli(["--session", sessionId, "status", "--format", "json"]);
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("SESSION_NOT_FOUND");

    // Post-check: real registry STILL doesn't have it (we didn't touch real)
    try {
      await fs.stat(path.join(realRegistry, `${sessionId}.json`));
      throw new Error("test wrote to real registry — isolation failed");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });

  test("LOAF_LANG=zh localizes SESSION_NOT_FOUND text mode", async () => {
    const registryDir = await tmpRegDir();
    const sessionId = "550e8400-e29b-41d4-a716-deadbeefcafe";
    const result = await runCli(["--session", sessionId, "status"], {
      env: { LOAF_LANG: "zh" },
      deps: { registryDir },
    });

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("SESSION_NOT_FOUND");
    expect(result.stderr).toContain(`--session ${sessionId} 在 registry 找不到任何匹配`);
  });

  test("LOAF_LANG=zh leaves SESSION_NOT_FOUND JSON message byte-stable", async () => {
    const registryDir = await tmpRegDir();
    const sessionId = "550e8400-e29b-41d4-a716-deadbeefcafe";
    const defaultResult = await runCli(["--session", sessionId, "status", "--format", "json"], {
      deps: { registryDir },
    });
    const zhResult = await runCli(["--session", sessionId, "status", "--format", "json"], {
      env: { LOAF_LANG: "zh" },
      deps: { registryDir },
    });

    expect(defaultResult.exit).toBe(2);
    expect(zhResult.exit).toBe(2);
    expect(zhResult.stderr).toBe(defaultResult.stderr);
  });
});
