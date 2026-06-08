// Phase 16 SC-5b1 — presentation flag suite.
//
// Per r257 GO trace:
//   - 4 new global flags (--plain, --no-color, --quiet/-q, --verbose/-v)
//   - parsePresentation unified guard (INVALID_FORMAT precedence over mutex;
//     renderAsJson if any valid --format json present)
//   - ctx.success advisory API (stateChange + next on stderr in both modes)
//   - 1 representative migration: `loaf start` (pilot)
//
// 27 RED cases mirror the r257 locked plan.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import {
  createCommandContext,
  parsePresentation,
  parsePlainFromArgv,
  parseQuietFromArgv,
  parseVerboseFromArgv,
  parseNoColorFromArgv,
  type CommandContext,
} from "../../src/cli/command-context.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc5b1-test-"));
}

async function runCli(
  argv: string[],
  opts: { env?: Record<string, string | undefined> } = {},
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const envBackup: Record<string, string | undefined> = {};
  if (opts.env) {
    for (const k of Object.keys(opts.env)) {
      envBackup[k] = process.env[k];
      const v = opts.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
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
    const exit = await main(["node", "loaf", ...argv]);
    return { exit, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
    for (const k of Object.keys(envBackup)) {
      const prev = envBackup[k];
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

function makeCtx(argv: string[]): { ctx: CommandContext; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createCommandContext(argv, {
    writeStdout: (s) => stdout.push(s),
    writeStderr: (s) => stderr.push(s),
  });
  return { ctx, stdout, stderr };
}

// ───────────────────────────────────────────────────────────────────
// RED #1-#3 — --plain alias works
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5b1 — RED #1-#3: --plain alias for --format text", () => {
  test("RED #1: --plain alone → ctx.output === 'text'", () => {
    const { ctx } = makeCtx(["loaf", "status", "--plain"]);
    expect(ctx.output).toBe("text");
    expect(ctx.plain).toBe(true);
  });

  test("RED #2: --plain --format text → same canonical, no mutex, output=text", () => {
    const { ctx } = makeCtx(["loaf", "status", "--plain", "--format", "text"]);
    expect(ctx.output).toBe("text");
  });

  test("RED #3: --plain --format=text → same canonical OK", () => {
    const { ctx } = makeCtx(["loaf", "status", "--plain", "--format=text"]);
    expect(ctx.output).toBe("text");
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #4-#11 — Multi-flag mutex, JSON vs text shape, INVALID_FORMAT precedence
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5b1 — RED #4-#11: MUTUALLY_EXCLUSIVE_FLAGS rendering", () => {
  test("RED #4: --plain --format=json → exit 2, JSON-shape stderr", async () => {
    const result = await runCli(["status", "--plain", "--format=json"]);
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const lines = result.stderr.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const obj = JSON.parse(lines[0]!) as {
      ok: boolean;
      code: string;
      detail: { conflicting: string[] };
    };
    expect(obj.ok).toBe(false);
    expect(obj.code).toBe("MUTUALLY_EXCLUSIVE_FLAGS");
    expect(obj.detail.conflicting).toContain("--plain");
    expect(obj.detail.conflicting).toContain("--format=json");
  });

  test("RED #5: --plain --format json (space form) → same JSON shape", async () => {
    const result = await runCli(["status", "--plain", "--format", "json"]);
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const obj = JSON.parse(result.stderr.trim()) as {
      code: string;
      detail: { conflicting: string[] };
    };
    expect(obj.code).toBe("MUTUALLY_EXCLUSIVE_FLAGS");
    expect(obj.detail.conflicting).toContain("--plain");
  });

  test("RED #6: --format json --plain (order independent) → JSON shape", async () => {
    const result = await runCli(["status", "--format", "json", "--plain"]);
    expect(result.exit).toBe(2);
    const obj = JSON.parse(result.stderr.trim()) as { code: string };
    expect(obj.code).toBe("MUTUALLY_EXCLUSIVE_FLAGS");
  });

  test("RED #7: --format text --format json → JSON shape (json present)", async () => {
    const result = await runCli(["status", "--format", "text", "--format", "json"]);
    expect(result.exit).toBe(2);
    const obj = JSON.parse(result.stderr.trim()) as { code: string };
    expect(obj.code).toBe("MUTUALLY_EXCLUSIVE_FLAGS");
  });

  test("RED #8: --format=text --format=json → JSON shape", async () => {
    const result = await runCli(["status", "--format=text", "--format=json"]);
    expect(result.exit).toBe(2);
    const obj = JSON.parse(result.stderr.trim()) as { code: string };
    expect(obj.code).toBe("MUTUALLY_EXCLUSIVE_FLAGS");
  });

  test("RED #9: --format json --format text → JSON shape (json present)", async () => {
    const result = await runCli(["status", "--format", "json", "--format", "text"]);
    expect(result.exit).toBe(2);
    const obj = JSON.parse(result.stderr.trim()) as { code: string };
    expect(obj.code).toBe("MUTUALLY_EXCLUSIVE_FLAGS");
  });

  test("LOAF_LANG=zh keeps MUTUALLY_EXCLUSIVE_FLAGS JSON message in English", async () => {
    const defaultResult = await runCli(["status", "--plain", "--format=json"]);
    const zhResult = await runCli(["status", "--plain", "--format=json"], {
      env: { LOAF_LANG: "zh" },
    });
    expect(defaultResult.exit).toBe(2);
    expect(zhResult.exit).toBe(2);
    expect(zhResult.stderr).toBe(defaultResult.stderr);
    const obj = JSON.parse(zhResult.stderr.trim()) as { code: string; message: string };
    expect(obj.code).toBe("MUTUALLY_EXCLUSIVE_FLAGS");
    expect(obj.message).toBe(
      "mutually exclusive flags in the same invocation: --plain, --format=json",
    );
  });

  test("RED #10: --format text --format text → OK (same canonical, no mutex)", () => {
    const result = parsePresentation(["loaf", "status", "--format", "text", "--format", "text"]);
    expect(result.ok).toBe(true);
  });

  test("RED #11: --format=yaml --plain → INVALID_FORMAT text shape (precedence)", async () => {
    const result = await runCli(["status", "--format=yaml", "--plain"]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("INVALID_FORMAT");
    expect(result.stderr).toContain("yaml");
    expect(result.stderr).not.toContain("MUTUALLY_EXCLUSIVE_FLAGS");
  });

  // Codex r258 F1 regression — INVALID_FORMAT must win when an
  // invalid `--format` value APPEARS AFTER an earlier valid one.
  // Pre-fix bug: parseFormatFromArgv returned on first valid hit;
  // later invalid never seen.

  test("RED #11a (r258 F1): --format text --format yaml → INVALID_FORMAT (valid-then-invalid)", async () => {
    const result = await runCli(["status", "--format", "text", "--format", "yaml"]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("INVALID_FORMAT");
    expect(result.stderr).toContain("yaml");
    expect(result.stderr).not.toContain("MUTUALLY_EXCLUSIVE_FLAGS");
  });

  test("RED #11b (r258 F1): --format=json --format=yaml → INVALID_FORMAT (equals form)", async () => {
    const result = await runCli(["status", "--format=json", "--format=yaml"]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("INVALID_FORMAT");
    expect(result.stderr).toContain("yaml");
    expect(result.stderr).not.toContain("MUTUALLY_EXCLUSIVE_FLAGS");
  });

  test("RED #11c (r258 F1): --format text --format=yaml → INVALID_FORMAT (mixed spelling)", async () => {
    const result = await runCli(["status", "--format", "text", "--format=yaml"]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("INVALID_FORMAT");
    expect(result.stderr).toContain("yaml");
  });

  test("RED #11d (r258 F1): unit — findFirstInvalidFormat scans all occurrences", async () => {
    const { findFirstInvalidFormat } = await import("../../src/cli/command-context.js");
    expect(findFirstInvalidFormat(["--format", "text", "--format", "yaml"])).toEqual({
      rawValue: "yaml",
    });
    expect(findFirstInvalidFormat(["--format=json", "--format=yaml"])).toEqual({
      rawValue: "yaml",
    });
    expect(findFirstInvalidFormat(["--format=yaml", "--format=text"])).toEqual({
      rawValue: "yaml",
    });
    expect(findFirstInvalidFormat(["--format", "text", "--format", "json"])).toBeNull();
    expect(findFirstInvalidFormat([])).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #12 — --no-color env handling
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5b1 — RED #12: --no-color flag + env equivalents", () => {
  test("--no-color flag → ctx.noColor=true", () => {
    const { ctx } = makeCtx(["loaf", "status", "--no-color"]);
    expect(ctx.noColor).toBe(true);
  });

  test("NO_COLOR=1 env → noColor=true via parseNoColorFromArgv", () => {
    expect(parseNoColorFromArgv([], { NO_COLOR: "1" })).toBe(true);
  });

  test("LOAF_NO_COLOR=1 env → noColor=true", () => {
    expect(parseNoColorFromArgv([], { LOAF_NO_COLOR: "1" })).toBe(true);
  });

  test("TERM=dumb env → noColor=true (per protocol §10.2)", () => {
    expect(parseNoColorFromArgv([], { TERM: "dumb" })).toBe(true);
  });

  test("no flag + no env → noColor=false", () => {
    expect(parseNoColorFromArgv([], {})).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #13-#15 — --quiet / --verbose flag parsing
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5b1 — RED #13-#15: --quiet / -q / --verbose / -v parsing", () => {
  test("RED #13: -q equivalent to --quiet (both set ctx.quiet=true)", () => {
    const { ctx: ctxQ } = makeCtx(["loaf", "status", "-q"]);
    expect(ctxQ.quiet).toBe(true);
    const { ctx: ctxQuiet } = makeCtx(["loaf", "status", "--quiet"]);
    expect(ctxQuiet.quiet).toBe(true);
  });

  test("RED #14: duplicate -q --quiet OK (no mutex)", () => {
    expect(parseQuietFromArgv(["-q", "--quiet"])).toBe(true);
    // Ensure presentation parse succeeds, no mutex fired.
    const result = parsePresentation(["loaf", "status", "-q", "--quiet"]);
    expect(result.ok).toBe(true);
  });

  test("RED #15: verbose cumulative — -v=1, -vv=2, --verbose=1, -v --verbose=2", () => {
    expect(parseVerboseFromArgv(["-v"])).toBe(1);
    expect(parseVerboseFromArgv(["-vv"])).toBe(2);
    expect(parseVerboseFromArgv(["--verbose"])).toBe(1);
    expect(parseVerboseFromArgv(["-v", "--verbose"])).toBe(2);
    expect(parseVerboseFromArgv(["-vv", "--verbose"])).toBe(3);
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #16-#20 — loaf start pilot: stdout/stderr split + quiet semantics
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5b1 — RED #16-#20: loaf start pilot ctx.success advisory", () => {
  test("RED #16: loaf start --format json --quiet → JSON stdout; stateChange/next stderr SUPPRESSED", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli([
      "start",
      "auth-refresh",
      "--ceremony",
      "quick",
      "--feature-dir",
      dir,
      "--format",
      "json",
      "--quiet",
    ]);
    expect(result.exit).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; session_id: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.session_id.length).toBeGreaterThan(0);
    expect(result.stderr).toBe("");
  });

  test("RED #17: loaf start --quiet (text mode) → stdout <UUID>\\n; stderr SUPPRESSED", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli([
      "start",
      "auth-refresh",
      "--ceremony",
      "quick",
      "--feature-dir",
      dir,
      "--quiet",
    ]);
    expect(result.exit).toBe(0);
    // stdout = UUID (36 chars + newline)
    expect(result.stdout.length).toBe(37);
    expect(result.stdout).toMatch(/^[0-9a-f-]{36}\n$/i);
    expect(result.stderr).toBe("");
  });

  test("RED #18: loaf start (no quiet, text) → stdout=UUID; stderr stateChange + next per protocol §10.12", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli([
      "start",
      "auth-refresh",
      "--ceremony",
      "quick",
      "--feature-dir",
      dir,
    ]);
    expect(result.exit).toBe(0);
    expect(result.stdout).toMatch(/^[0-9a-f-]{36}\n$/i);
    expect(result.stderr).toContain("start: 'auth-refresh' created → TRIAGE.score");
    expect(result.stderr).toContain("next: loaf advance");
  });

  test("RED #19: loaf start --format json (no quiet) → JSON stdout + stateChange/next stderr both emit", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli([
      "start",
      "auth-refresh",
      "--ceremony",
      "quick",
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(result.exit).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    // Advisories emit in JSON mode too — pipe-safe separation.
    expect(result.stderr).toContain("start: 'auth-refresh' created → TRIAGE.score");
    expect(result.stderr).toContain("next: loaf advance");
  });

  test("RED #20: loaf start --quiet failure (e.g. invalid argv) → ctx.failure stderr STILL emits", async () => {
    // Missing required positional `<feature>`:
    const result = await runCli(["start", "--quiet"]);
    expect(result.exit).not.toBe(0);
    // Commander's error message goes through fail-pipeline which uses stderr.
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #22 — read-only --quiet (status) still emits primary stdout
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5b1 — RED #22: read-only --quiet preserves primary stdout", () => {
  test("loaf status --quiet → primary stdout still emits (read-only is channel A)", async () => {
    const dir = await tmpFeatureDir();
    await runCli(["start", "auth-refresh", "--ceremony", "quick", "--feature-dir", dir]);
    const result = await runCli([
      "status",
      "--feature",
      "auth-refresh",
      "--feature-dir",
      dir,
      "--quiet",
      "--format",
      "json",
    ]);
    // Status is read-only; --quiet must not silence its primary
    // output. Per protocol §10.12 quiet suppresses advisory stderr only.
    expect(result.exit).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #23 — ctx.success with empty textRenderer writes 0 stdout
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5b1 — RED #23: empty text renderer + advisories", () => {
  test("text mode + renderer returns '' → 0 stdout bytes; stateChange stderr still emits unless quiet", () => {
    const { ctx, stdout, stderr } = makeCtx(["loaf", "test"]);
    ctx.success({ ok: true }, () => "", { stateChange: "test: done" });
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toBe("test: done\n");
  });

  test("text mode + renderer returns '' + --quiet → 0 stdout, 0 stderr", () => {
    const { ctx, stdout, stderr } = makeCtx(["loaf", "test", "--quiet"]);
    ctx.success({ ok: true }, () => "", { stateChange: "test: done" });
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toBe("");
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #24 — placeholder symmetry (extended via sc5a-surface-gate; smoke here)
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5b1 — RED #24: parsePresentation + parsePlain helpers", () => {
  test("parsePlainFromArgv detects --plain", () => {
    expect(parsePlainFromArgv(["--plain"])).toBe(true);
    expect(parsePlainFromArgv([])).toBe(false);
  });

  test("parseQuietFromArgv detects --quiet or -q", () => {
    expect(parseQuietFromArgv(["--quiet"])).toBe(true);
    expect(parseQuietFromArgv(["-q"])).toBe(true);
    expect(parseQuietFromArgv([])).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #25 — FLAG_EXCLUSIONS contains --plain, not --json (sc5a-surface-gate
// RED #18 enforces — smoke covered here too for SC-5b1 coupling)
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5b1 — RED #25: FLAG_EXCLUSIONS.output_format normalization", () => {
  test("FLAG_EXCLUSIONS.output_format contains --plain key and --format=text/json", async () => {
    const { FLAG_EXCLUSIONS } = await import("../../docs/schemas.js");
    const outputFormat = FLAG_EXCLUSIONS.sets.find((s) => s.name === "output_format");
    expect(outputFormat).toBeDefined();
    const keys = Object.keys(outputFormat!.normalization);
    expect(keys).toContain("--plain");
    expect(keys).toContain("--format=text");
    expect(keys).toContain("--format=json");
    expect(keys).not.toContain("--json");
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #26 (INVERTED for SC-5b2) — protocol §10.7 annotations flipped
// to current. The 4 partial flags are no longer inventory:future after
// SC-5b2 closed the 40-site migration. Regression guard against an
// accidental re-introduction of the future annotation.
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5b2 — RED #26: protocol inventory:future annotations REMOVED from 4 flag rows", () => {
  test("docs/protocol.md no longer has inventory:future on --plain/--no-color/--quiet/--verbose rows", async () => {
    const text = await fs.readFile(
      path.join(import.meta.dirname ?? __dirname, "../../docs/protocol.md"),
      "utf8",
    );
    const flags = ["--plain", "--no-color", "--quiet", "--verbose"];
    for (const flag of flags) {
      // SC-5b2 flipped these to current: the flag row must NOT carry
      // an `inventory:future` HTML comment anymore.
      const re = new RegExp(`\\| \`${flag.replace("-", "\\-")}\` <!-- inventory:future`);
      expect(text).not.toMatch(re);
    }
  });
});

// ───────────────────────────────────────────────────────────────────
// SC-5b2 — quiet suppression for migrated mutators
// ───────────────────────────────────────────────────────────────────

describe("Phase 16 SC-5b2 — quiet suppression on migrated mutators", () => {
  test("loaf advance (no quiet) → stateChange 'advance: <from> → <to>' on stderr", async () => {
    const dir = await tmpFeatureDir();
    await runCli(["start", "auth-refresh", "--ceremony", "quick", "--feature-dir", dir]);
    const result = await runCli([
      "advance",
      "TRIAGE.confirm",
      "--feature",
      "auth-refresh",
      "--feature-dir",
      dir,
    ]);
    expect(result.exit).toBe(0);
    expect(result.stderr).toContain("advance: TRIAGE.score → TRIAGE.confirm");
  });

  test("loaf advance --quiet → stateChange suppressed; exit 0", async () => {
    const dir = await tmpFeatureDir();
    await runCli(["start", "auth-refresh", "--ceremony", "quick", "--feature-dir", dir]);
    const result = await runCli([
      "advance",
      "TRIAGE.confirm",
      "--feature",
      "auth-refresh",
      "--feature-dir",
      dir,
      "--quiet",
    ]);
    expect(result.exit).toBe(0);
    // No stateChange / no next on stderr under --quiet.
    expect(result.stderr).not.toContain("advance:");
    expect(result.stderr).not.toContain("next:");
  });

  // Note: archive/abandon quiet semantics covered indirectly through
  // tests/core/cli.test.ts (which were cascaded from stdout→stderr
  // assertions in SC-5b2). Setting up an archive-able session needs
  // more state than a fresh start; the advance tests above already
  // prove the --quiet/non-quiet stateChange routing mechanic.
});
