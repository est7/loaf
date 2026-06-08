// Phase 16 SC-6a — `--no-input` non-interactive mode flag (parser +
// ctx + help). Actor-resolution downgrade lives in
// `tests/cli/actor-resolution-no-input.test.ts` (separate file
// because it crosses CLI ↔ actor-resolver ↔ MainDeps injection).
//
// RED matrix (codex r264 → r265 GO):
//   - parser: --no-input present/absent → boolean
//   - orthogonality table: 3 rows proving `--no-input` is NOT part of
//     the output_format normalization set (existing mutex still fires
//     when `--plain` + `--format=json` regardless of `--no-input`)
//   - ctx.noInput plumb-through from createCommandContext
//   - --help smoke: `--no-input` description appears

import { describe, expect, test } from "vitest";

import { main } from "../../src/cli.js";
import {
  createCommandContext,
  parsePresentation,
  parseNoInputFromArgv,
  type CommandContext,
} from "../../src/cli/command-context.js";

async function runCli(argv: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
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
  }
}

function makeCtx(argv: string[]): { ctx: CommandContext } {
  const ctx = createCommandContext(argv, {
    writeStdout: () => undefined,
    writeStderr: () => undefined,
  });
  return { ctx };
}

// ───────────────────────────────────────────────────────────────────
// RED #1 — parseNoInputFromArgv shape
// ───────────────────────────────────────────────────────────────────

describe("SC-6a — parseNoInputFromArgv basic shape", () => {
  test("RED #1: absent → false", () => {
    expect(parseNoInputFromArgv(["loaf", "status"])).toBe(false);
  });

  test("RED #2: present → true", () => {
    expect(parseNoInputFromArgv(["loaf", "status", "--no-input"])).toBe(true);
  });

  test("RED #3: order-independent", () => {
    expect(parseNoInputFromArgv(["loaf", "--no-input", "status"])).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #4 — parsePresentation extension: noInput field
// ───────────────────────────────────────────────────────────────────

describe("SC-6a — parsePresentation.noInput field", () => {
  test("RED #4: default false on bare argv", () => {
    const res = parsePresentation(["loaf", "status"]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.noInput).toBe(false);
  });

  test("RED #5: true when --no-input present", () => {
    const res = parsePresentation(["loaf", "status", "--no-input"]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.noInput).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #6-#8 — Orthogonality: --no-input is NOT in the output_format
// normalization set; existing mutex unaffected
// ───────────────────────────────────────────────────────────────────

describe("SC-6a — --no-input orthogonality (codex r265 P1)", () => {
  test("RED #6 (Row A): --no-input --quiet --format json -vv parses cleanly", () => {
    const res = parsePresentation([
      "loaf",
      "status",
      "--no-input",
      "--quiet",
      "--format",
      "json",
      "-vv",
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.noInput).toBe(true);
      expect(res.quiet).toBe(true);
      expect(res.format).toBe("json");
      expect(res.verbose).toBe(2);
    }
  });

  test("RED #7 (Row B): --no-input --plain --format text → same canonical OK", () => {
    const res = parsePresentation(["loaf", "status", "--no-input", "--plain", "--format", "text"]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.noInput).toBe(true);
      expect(res.plain).toBe(true);
      expect(res.format).toBe("text");
    }
  });

  test("RED #8 (Row C): --no-input does NOT mask existing --plain/--format=json mutex", async () => {
    // The existing output_format mutex must still fire — `--no-input`
    // is orthogonal, not a circuit-breaker for other flag conflicts.
    const result = await runCli(["status", "--no-input", "--plain", "--format=json"]);
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    // JSON-shape stderr because `--format=json` is present (renderAsJson).
    const lines = result.stderr.split("\n").filter((l) => l.length > 0);
    const parsed = JSON.parse(lines[0]!) as { code: string };
    expect(parsed.code).toBe("MUTUALLY_EXCLUSIVE_FLAGS");
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #9-#10 — ctx.noInput plumb-through
// ───────────────────────────────────────────────────────────────────

describe("SC-6a — ctx.noInput plumb-through from createCommandContext", () => {
  test("RED #9: bare argv → ctx.noInput === false", () => {
    const { ctx } = makeCtx(["loaf", "status"]);
    expect(ctx.noInput).toBe(false);
  });

  test("RED #10: --no-input argv → ctx.noInput === true", () => {
    const { ctx } = makeCtx(["loaf", "status", "--no-input"]);
    expect(ctx.noInput).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────
// RED #11 — --help advertises --no-input
// ───────────────────────────────────────────────────────────────────

describe("SC-6a — --help advertises --no-input", () => {
  test("RED #11: loaf --help mentions --no-input", async () => {
    const result = await runCli(["--help"]);
    // Commander prints help to stdout and may use exitOverride → exit 0
    expect(result.stdout + result.stderr).toContain("--no-input");
  });
});
