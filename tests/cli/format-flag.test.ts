// Phase 16 SC-5a — `--format text|json` global flag tests.
//
// Per r249 GO trace. Covers RED #1-#5 (basic format), #9 (ctx output
// derivation), #10 (pre-parse guard placement), #11 (help/version
// bypass), #13 (bare --format missing value), #14-#17 (equals form).
//
// Integration tests use `runCli` mirroring tests/core/cli.test.ts; unit
// tests use `createCommandContext` directly.

import { describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import {
  createCommandContext,
  type CommandContext,
} from "../../src/cli/command-context.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc5a-format-test-"));
}

async function runCli(
  argv: string[],
  opts: {
    env?: Record<string, string | undefined>;
    deps?: Parameters<typeof main>[1];
  } = {},
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const oldEnv = new Map<string, string | undefined>();
  for (const key of Object.keys(opts.env ?? {})) {
    oldEnv.set(key, process.env[key]);
    const value = opts.env![key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
    for (const [key, value] of oldEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeCtxSpy(argv: string[]): {
  ctx: CommandContext;
  stdout: string[];
  stderr: string[];
  loadSessionSpy: ReturnType<typeof vi.fn>;
  loadProjectionsSpy: ReturnType<typeof vi.fn>;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const loadSessionSpy = vi.fn();
  const loadProjectionsSpy = vi.fn();
  const ctx = createCommandContext(argv, {
    writeStdout: (s) => stdout.push(s),
    writeStderr: (s) => stderr.push(s),
    loadSession: loadSessionSpy as never,
    loadProjections: loadProjectionsSpy as never,
  });
  return { ctx, stdout, stderr, loadSessionSpy, loadProjectionsSpy };
}

// ───────────────────────────────────────────────────────────────────
// RED #9 + #14-#17: CommandContext unit-level format derivation
// (space form + equals form + absent default + invalid).
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5a — RED #9: CommandContext output derives from --format", () => {
  test("--format json → output = 'json'", () => {
    const { ctx } = makeCtxSpy(["loaf", "status", "--format", "json"]);
    expect(ctx.output).toBe("json");
  });

  test("--format text → output = 'text' (explicit)", () => {
    const { ctx } = makeCtxSpy(["loaf", "status", "--format", "text"]);
    expect(ctx.output).toBe("text");
  });

  test("--format absent → output = 'text' (default)", () => {
    const { ctx } = makeCtxSpy(["loaf", "status"]);
    expect(ctx.output).toBe("text");
  });
});

describe("Phase 16 SC-5a — RED #14-#17: equals-form --format=<v>", () => {
  test("--format=json → output = 'json'", () => {
    const { ctx } = makeCtxSpy(["loaf", "status", "--format=json"]);
    expect(ctx.output).toBe("json");
  });

  test("--format=text → output = 'text'", () => {
    const { ctx } = makeCtxSpy(["loaf", "status", "--format=text"]);
    expect(ctx.output).toBe("text");
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #1-#5: CLI integration — happy paths + --json removal.
// Use `loaf status` against an empty workdir → fails on no-session,
// BUT the failure is rendered in the requested format (so we test
// the formatting layer regardless of session state).
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5a — RED #1-#3: --format integration happy paths", () => {
  test("RED #1: --format json → JSON on stdout for `loaf status` success", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli([
      "start", "auth-refresh",
      "--ceremony", "standard",
      "--feature-dir", dir,
      "--format", "json",
    ]);
    expect(result.exit).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  test("RED #2: --format text (explicit) → text on stdout", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli([
      "start", "auth-refresh",
      "--ceremony", "quick",
      "--feature-dir", dir,
      "--format", "text",
    ]);
    expect(result.exit).toBe(0);
    // SC-5b1 pilot: `loaf start` text-mode stdout is `<UUID>\n` (just
    // the session id). stateChange + next emitted to stderr per
    // protocol §10.12. Not JSON, just a bare UUID.
    expect(result.stdout).toMatch(/^[0-9a-f-]{36}\n$/i);
    expect(() => JSON.parse(result.stdout)).toThrow();
  });

  test("RED #3: --format absent → defaults to text", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli([
      "start", "auth-refresh",
      "--ceremony", "quick",
      "--feature-dir", dir,
    ]);
    expect(result.exit).toBe(0);
    expect(() => JSON.parse(result.stdout)).toThrow();
  });
});

describe("Phase 16 SC-5a — RED #4 + #16: invalid --format value rejected with INVALID_FORMAT", () => {
  test("RED #4: --format yaml → exit 2 INVALID_FORMAT (text-mode stderr, no stdout)", async () => {
    const result = await runCli([
      "status",
      "--format", "yaml",
    ]);
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INVALID_FORMAT");
    expect(result.stderr).toContain("yaml");
    expect(result.stderr).toContain("text|json");
  });

  test("RED #16: --format=yaml → same shape as --format yaml", async () => {
    const result = await runCli([
      "status",
      "--format=yaml",
    ]);
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INVALID_FORMAT");
    expect(result.stderr).toContain("yaml");
  });

  test("RED #17: --format= (empty equals form) → INVALID_FORMAT with detail.value=''", async () => {
    const result = await runCli([
      "status",
      "--format=",
    ]);
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INVALID_FORMAT");
  });

  test("LOAF_LANG=zh localizes INVALID_FORMAT text mode", async () => {
    const result = await runCli(["status", "--format", "yaml"], {
      env: { LOAF_LANG: "zh" },
    });
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INVALID_FORMAT");
    expect(result.stderr).toContain("无效的 --format 值 'yaml'");
    expect(result.stderr).toContain("合法值:text|json");
  });
});

describe("Phase 16 SC-5a — RED #5: --json flag removed under A1", () => {
  test("RED #5: --json → exit 2 (Commander unknown-option USAGE; no typed code)", async () => {
    // Use `loaf --version` as the command so Commander can parse argv
    // far enough to detect `--json` as unknown without tripping a
    // per-command mandatory-option requirement first. We pass --version
    // AFTER --json so Commander's unknown-option check fires before
    // version short-circuit. Alternative bench: any top-level argv
    // that doesn't carry per-command required flags.
    const dir = await tmpFeatureDir();
    const result = await runCli([
      "start", "ga-smoke",
      "--ceremony", "quick",
      "--feature-dir", dir,
      "--json",
    ]);
    // SC-2 normalization at src/cli.tsx:3888-3891 maps Commander's parse
    // error exit 1 → exit 2 (Commander parse errors are user-input
    // errors per Q1 verdict).
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    // Commander unknown-option text mentions the offending flag; do
    // NOT assert a typed DiagnosticCode (--json is not registered).
    expect(result.stderr.toLowerCase()).toContain("unknown");
    expect(result.stderr).toContain("--json");
    // Crucially, INVALID_FORMAT must NOT fire — that code is reserved
    // for --format <bad> only.
    expect(result.stderr).not.toContain("INVALID_FORMAT");
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #10: pre-parse guard placement.
// Invalid --format must reject BEFORE actor read / parseAsync / deps.
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5a — RED #10: pre-parse guard rejects before side effects", () => {
  test("--format yaml fails before any process.env['USER'] read", async () => {
    // Spy on env get for USER. If actor init has been moved below the
    // guard, the get should never fire for invalid --format.
    const sentinelKey = "USER";
    const original = process.env[sentinelKey];
    let userReadCount = 0;
    const proxy = new Proxy(process.env, {
      get(target, prop, receiver) {
        if (prop === sentinelKey) {
          userReadCount++;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const origEnv = process.env;
    (process as { env: NodeJS.ProcessEnv }).env = proxy as NodeJS.ProcessEnv;
    try {
      const result = await runCli(["status", "--format", "yaml"]);
      expect(result.exit).toBe(2);
      expect(userReadCount).toBe(0);
    } finally {
      (process as { env: NodeJS.ProcessEnv }).env = origEnv;
      if (original === undefined) delete process.env[sentinelKey];
      else process.env[sentinelKey] = original;
    }
  });

  test("invalid --format wins over invalid LOAF_LANG", async () => {
    const result = await runCli(["status", "--format", "yaml"], {
      env: { LOAF_LANG: "fr" },
    });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("INVALID_FORMAT");
    expect(result.stderr).not.toContain("INVALID_LOCALE");
  });
});

describe("ADR-0006 P0 — INVALID_LOCALE CLI guard", () => {
  test("invalid LOAF_LANG in text mode → exit 2 INVALID_LOCALE", async () => {
    const result = await runCli(["status"], {
      env: { LOAF_LANG: "fr" },
    });

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INVALID_LOCALE");
    expect(result.stderr).toContain("LOAF_LANG");
    expect(result.stderr).toContain("fr");
  });

  test("invalid LOAF_LANG in JSON mode → exit 2 JSON failure with canonical English message", async () => {
    const result = await runCli(["status", "--format", "json"], {
      env: { LOAF_LANG: "fr" },
    });

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const parsed = JSON.parse(result.stderr);
    expect(parsed).toEqual({
      ok: false,
      code: "INVALID_LOCALE",
      message: "invalid locale from LOAF_LANG: fr (expected en or zh)",
      detail: { source: "LOAF_LANG", value: "fr", accepted: ["en", "zh"] },
    });
  });

  test("invalid injected user config in JSON mode → exit 2 INVALID_LOCALE without touching real home", async () => {
    const homeDir = await tmpFeatureDir();
    const configPath = path.join(homeDir, ".loaf", "config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        schema_version: 1,
        locale: { default_lang: "fr" },
      }),
      "utf8",
    );

    const result = await runCli(["status", "--format", "json"], {
      deps: { userConfigHomeDir: homeDir },
    });

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const parsed = JSON.parse(result.stderr);
    expect(parsed.code).toBe("INVALID_LOCALE");
    expect(parsed.message).toContain(configPath);
    expect(parsed.detail).toEqual({
      source: "user-config",
      path: configPath,
      reason: `schema validation failed for ${configPath}`,
    });
  });

  test("valid LOAF_LANG=zh does not localize JSON failure message", async () => {
    const defaultResult = await runCli(["status", "--format", "json"]);
    const result = await runCli(["status", "--format", "json"], {
      env: { LOAF_LANG: "zh" },
    });

    expect(defaultResult.exit).toBe(2);
    expect(result.exit).toBe(2);
    expect(result.stderr).toBe(defaultResult.stderr);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.code).toBe("FEATURE_NOT_FOUND");
    expect(parsed.message).toBe("no feature found in cwd (.loaf/ is empty or missing, or no projection has phase != DONE)");
  });

  test("valid LOAF_LANG=zh localizes dispatch text failure", async () => {
    const result = await runCli(["status"], {
      env: { LOAF_LANG: "zh" },
    });

    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("FEATURE_NOT_FOUND");
    expect(result.stderr).toContain("当前 cwd 找不到 feature");
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #11: help / version bypass.
// `loaf --help --format yaml` must still print help, exit 0.
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5a — RED #11: --help / --version bypass pre-parse guard", () => {
  test("--help with --format yaml → prints help, exit 0, no INVALID_FORMAT", async () => {
    const result = await runCli(["--help", "--format", "yaml"]);
    expect(result.exit).toBe(0);
    // Help text appears on stdout (Commander's default).
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stderr).not.toContain("INVALID_FORMAT");
  });

  test("--version with --format yaml → prints version, exit 0, no INVALID_FORMAT", async () => {
    const result = await runCli(["--version", "--format", "yaml"]);
    expect(result.exit).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stderr).not.toContain("INVALID_FORMAT");
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #13: bare --format (no value) → Commander mandatory-arg USAGE.
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5a — RED #13: bare --format with no value", () => {
  test("--format (no value, space form) → exit 2 Commander usage, no typed code, no silent default", async () => {
    const result = await runCli(["status", "--format"]);
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    // Commander reports missing argument; no typed INVALID_FORMAT.
    expect(result.stderr).not.toContain("INVALID_FORMAT");
  });
});
