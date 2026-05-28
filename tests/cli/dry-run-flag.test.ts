// Phase 16 SC-6c — `--dry-run` / `-n` flag parser + ctx plumb-through.
//
// E2E integration (mutating + read-only + leak guards) lives in
// `tests/cli/dry-run-end-to-end.test.ts`. Mutator pipeline tests live
// in `tests/core/mutate-dry-run.test.ts`. Static guards live in
// `tests/scripts/sc6c-dry-run-gate.test.ts`.
//
// RED matrix (codex r274 → r276 GO with constraints):
//   T1-T3: parseDryRunFromArgv (absent / --dry-run / -n)
//   T4-T5: ctx.dryRun plumb-through (default + flag-set)
//   T6: orthogonality — coexists with --debug / --no-input / --quiet / --format
//   T7: --help advertises --dry-run + -n
//   T8: -n short form parses identical to --dry-run

import { describe, expect, test } from "vitest";

import { main } from "../../src/cli.js";
import {
  createCommandContext,
  parseDryRunFromArgv,
  parsePresentation,
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

describe("SC-6c — parseDryRunFromArgv basic shape", () => {
  test("T1: absent → false", () => {
    expect(parseDryRunFromArgv(["loaf", "status"])).toBe(false);
  });

  test("T2: --dry-run present → true", () => {
    expect(parseDryRunFromArgv(["loaf", "status", "--dry-run"])).toBe(true);
  });

  test("T3: -n short form → true", () => {
    expect(parseDryRunFromArgv(["loaf", "status", "-n"])).toBe(true);
  });
});

describe("SC-6c — ctx.dryRun plumb-through", () => {
  test("T4: bare argv → ctx.dryRun === false", () => {
    const { ctx } = makeCtx(["loaf", "status"]);
    expect(ctx.dryRun).toBe(false);
  });

  test("T5: --dry-run argv → ctx.dryRun === true", () => {
    const { ctx } = makeCtx(["loaf", "advance", "--dry-run"]);
    expect(ctx.dryRun).toBe(true);
  });

  test("T8: -n argv → ctx.dryRun === true (same as --dry-run)", () => {
    const { ctx } = makeCtx(["loaf", "advance", "-n"]);
    expect(ctx.dryRun).toBe(true);
  });
});

describe("SC-6c — orthogonality with other flags", () => {
  test("T6: --dry-run --debug --no-input --quiet --format=json -vv parses cleanly", () => {
    const res = parsePresentation(
      ["loaf", "advance", "--dry-run", "--debug", "--no-input", "--quiet", "--format=json", "-vv"],
      {},
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.dryRun).toBe(true);
      expect(res.debug).toBe(true);
      expect(res.noInput).toBe(true);
      expect(res.quiet).toBe(true);
      expect(res.format).toBe("json");
      expect(res.verbose).toBe(2);
    }
  });
});

describe("SC-6c — --help advertises --dry-run + -n", () => {
  test("T7: loaf --help mentions --dry-run and -n", async () => {
    const result = await runCli(["--help"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("--dry-run");
    expect(output).toContain("-n");
  });
});
