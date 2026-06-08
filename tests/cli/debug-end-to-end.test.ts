// Phase 16 SC-6b — `--debug` end-to-end integration.
//
// Drives main() through real argv. Asserts:
//   - `loaf start <f> --debug --feature-dir <tmp>` writes
//     `<tmp>/trace.jsonl` with one schema-conformant line
//   - no-flag invocation produces no trace.jsonl
//   - `LOAF_DEBUG=1` (env-only, no flag) triggers trace write
//   - `loaf advance` (--feature flag-form) traces too
//   - Trace-write failure does NOT flip exit code (DI: throw)
//
// MainDeps.appendTraceLine + .now + .monotonicNow seams per codex r270 P2.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main, type MainDeps } from "../../src/cli.js";
import type { TraceEntry } from "../../src/cli/trace-writer.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc6b-e2e-"));
}

async function runCli(
  argv: string[],
  opts: { env?: Record<string, string | undefined>; deps?: MainDeps } = {},
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
    const exit = await main(["node", "loaf", ...argv], opts.deps ?? {});
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

describe("SC-6b — --debug end-to-end", () => {
  test("T21: loaf start <f> --debug --feature-dir <tmp> writes trace.jsonl", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli(
      [
        "start",
        "auth-refresh",
        "--ceremony",
        "standard",
        "--feature-dir",
        dir,
        "--format",
        "json",
        "--debug",
      ],
      { env: { LOAF_USER: "tester@example.invalid", LOAF_DEBUG: undefined, DEBUG: undefined } },
    );
    expect(result.exit).toBe(0);

    const tracePath = path.join(dir, "trace.jsonl");
    const stat = await fs.stat(tracePath);
    expect(stat.isFile()).toBe(true);

    const content = await fs.readFile(tracePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.schema_version).toBe(2);
    expect(entry.kind).toBe("cli");
    expect(entry.feature).toBe("auth-refresh");
    expect(entry.cmd).toBe("loaf start auth-refresh");
    expect(entry.exit).toBe(0);
    expect(typeof entry.wall_ms).toBe("number");
    // --feature-dir value redacted
    const argv = entry.argv as string[];
    const fdIdx = argv.indexOf("--feature-dir");
    expect(fdIdx).toBeGreaterThanOrEqual(0);
    expect(argv[fdIdx + 1]).toBe("<feature-dir>");
    // Codex r272 contract: trace argv is COMMAND argv (post-launcher
    // slice), matching §4.10. Must NOT carry the `node` / `loaf`
    // launcher tokens — `cmd` already carries the loaf chain.
    expect(argv.slice(0, 2)).toEqual(["start", "auth-refresh"]);
    expect(argv).not.toContain("node");
    expect(argv).not.toContain("loaf");
  });

  test("T22: loaf start <f> WITHOUT --debug → no trace.jsonl", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli(
      ["start", "auth-refresh", "--ceremony", "standard", "--feature-dir", dir, "--format", "json"],
      { env: { LOAF_USER: "tester@example.invalid", LOAF_DEBUG: undefined, DEBUG: undefined } },
    );
    expect(result.exit).toBe(0);

    const tracePath = path.join(dir, "trace.jsonl");
    await expect(fs.stat(tracePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("T23: LOAF_DEBUG=1 env (no --debug flag) → trace.jsonl written", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli(
      ["start", "auth-refresh", "--ceremony", "standard", "--feature-dir", dir, "--format", "json"],
      { env: { LOAF_USER: "tester@example.invalid", LOAF_DEBUG: "1", DEBUG: undefined } },
    );
    expect(result.exit).toBe(0);

    const tracePath = path.join(dir, "trace.jsonl");
    const content = await fs.readFile(tracePath, "utf8");
    const entry = JSON.parse(content.trim().split("\n")[0]!);
    expect(entry.feature).toBe("auth-refresh");
  });

  test("T24: loaf advance --feature flag-form + --debug → trace.jsonl with cmd=loaf advance", async () => {
    const dir = await tmpFeatureDir();
    await runCli(
      ["start", "auth-refresh", "--ceremony", "standard", "--feature-dir", dir, "--format", "json"],
      { env: { LOAF_USER: "tester@example.invalid", LOAF_DEBUG: undefined, DEBUG: undefined } },
    );
    // start ran without --debug → no trace yet
    await expect(fs.stat(path.join(dir, "trace.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });

    const result = await runCli(
      [
        "advance",
        "TRIAGE.confirm",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
        "--format",
        "json",
        "--debug",
      ],
      { env: { LOAF_USER: "tester@example.invalid", LOAF_DEBUG: undefined, DEBUG: undefined } },
    );
    expect(result.exit).toBe(0);

    const content = await fs.readFile(path.join(dir, "trace.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.cmd).toBe("loaf advance TRIAGE.confirm");
    expect(entry.feature).toBe("auth-refresh");
    // sub_state is best-effort from ctx.resolveSession's cache (per
    // §4.10); commands that use `loadSession` directly leave it null.
    // Documenting via assertion that it's either null or a string.
    expect(entry.sub_state === null || typeof entry.sub_state === "string").toBe(true);
  });

  test("T25: trace-write failure via DI does NOT flip exit code", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli(
      [
        "start",
        "auth-refresh",
        "--ceremony",
        "standard",
        "--feature-dir",
        dir,
        "--format",
        "json",
        "--debug",
      ],
      {
        env: { LOAF_USER: "tester@example.invalid", LOAF_DEBUG: undefined, DEBUG: undefined },
        deps: {
          appendTraceLine: async (): Promise<void> => {
            throw new Error("disk full (injected)");
          },
        },
      },
    );
    // Exit code preserved even though trace write threw.
    expect(result.exit).toBe(0);
    // Failure swallowed silently — no stderr write from the trace path.
    expect(result.stderr).not.toContain("disk full");
    expect(result.stderr).not.toContain("trace");
    // No trace.jsonl on disk (since the injected appendTraceLine threw
    // before any real write).
    await expect(fs.stat(path.join(dir, "trace.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("T26: deterministic `at` via injected `now`", async () => {
    const dir = await tmpFeatureDir();
    const fixed = new Date("2026-12-31T23:59:59.999Z");
    const captured: TraceEntry[] = [];
    const result = await runCli(
      [
        "start",
        "auth-refresh",
        "--ceremony",
        "standard",
        "--feature-dir",
        dir,
        "--format",
        "json",
        "--debug",
      ],
      {
        env: { LOAF_USER: "tester@example.invalid", LOAF_DEBUG: undefined, DEBUG: undefined },
        deps: {
          now: () => fixed,
          appendTraceLine: async (_fd, entry) => {
            captured.push(entry);
          },
        },
      },
    );
    expect(result.exit).toBe(0);
    expect(captured.length).toBe(1);
    expect(captured[0]!.at).toBe("2026-12-31T23:59:59.999Z");
  });
});
