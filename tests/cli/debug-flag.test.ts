// Phase 16 SC-6b — `--debug` flag parser + ctx plumb-through.
//
// Integration of --debug + LOAF_DEBUG + DEBUG envs lives in
// `tests/cli/debug-end-to-end.test.ts`; the pure writer module
// lives in `tests/cli/trace-writer.test.ts`. The action-body
// static guard lives in `tests/scripts/sc6b-trace-target-gate.test.ts`.
//
// RED matrix (codex r268 → r271 GO):
//   T1-T7: argv + env precedence (`--debug` > LOAF_DEBUG > DEBUG)
//   T8: orthogonality with --no-input / --quiet / --format=json
//   T9-T10: ctx.debug plumb-through default + flag-set
//   T11: --help advertises --debug

import { describe, expect, test } from "vitest";

import { main } from "../../src/cli.js";
import {
  createCommandContext,
  parseDebugFromArgv,
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

describe("SC-6b — parseDebugFromArgv: flag + env precedence", () => {
  test("T1: absent flag + no env → false", () => {
    expect(parseDebugFromArgv(["loaf", "status"], {})).toBe(false);
  });

  test("T2: --debug flag → true", () => {
    expect(parseDebugFromArgv(["loaf", "status", "--debug"], {})).toBe(true);
  });

  test("T3: LOAF_DEBUG=1 env → true", () => {
    expect(parseDebugFromArgv(["loaf", "status"], { LOAF_DEBUG: "1" })).toBe(true);
  });

  test("T4: LOAF_DEBUG empty string → false (empty value)", () => {
    expect(parseDebugFromArgv(["loaf", "status"], { LOAF_DEBUG: "" })).toBe(false);
  });

  test("T5: DEBUG=1 env (no LOAF_DEBUG) → true", () => {
    expect(parseDebugFromArgv(["loaf", "status"], { DEBUG: "1" })).toBe(true);
  });

  test("T6: LOAF_DEBUG empty + DEBUG=1 → true (DEBUG fills in)", () => {
    expect(parseDebugFromArgv(["loaf", "status"], { LOAF_DEBUG: "", DEBUG: "1" })).toBe(true);
  });

  test("T7: --debug flag wins regardless of envs", () => {
    expect(parseDebugFromArgv(["loaf", "status", "--debug"], { LOAF_DEBUG: "", DEBUG: "" })).toBe(
      true,
    );
  });
});

describe("SC-6b — orthogonality: --debug coexists with all other flags", () => {
  test("T8: --debug --no-input --quiet --format=json -vv parses cleanly", () => {
    const res = parsePresentation(
      ["loaf", "status", "--debug", "--no-input", "--quiet", "--format=json", "-vv"],
      {},
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.debug).toBe(true);
      expect(res.noInput).toBe(true);
      expect(res.quiet).toBe(true);
      expect(res.format).toBe("json");
      expect(res.verbose).toBe(2);
    }
  });
});

describe("SC-6b — ctx.debug plumb-through from createCommandContext", () => {
  test("T9: bare argv → ctx.debug === false", () => {
    const { ctx } = makeCtx(["loaf", "status"]);
    expect(ctx.debug).toBe(false);
  });

  test("T10: --debug argv → ctx.debug === true", () => {
    const { ctx } = makeCtx(["loaf", "status", "--debug"]);
    expect(ctx.debug).toBe(true);
  });
});

describe("SC-6b — --help advertises --debug", () => {
  test("T11: loaf --help mentions --debug", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout + result.stderr).toContain("--debug");
  });
});
