// Phase 16 SC-15b — `loaf hook` read-side handlers e2e.
//
// session-start + closure-check wired against real on-disk snapshots
// (start a feature via runCli, then invoke the hook). Composition logic is
// unit-tested in tests/core/hook-read.test.ts; this file covers the IO
// wiring: dispatch → loadProjections → envelope / warnings / silent skip.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-cli-hook-readside-"));
}

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

async function startFeature(dir: string): Promise<void> {
  const r = await runCli([
    "start",
    "auth-refresh",
    "--ceremony",
    "standard",
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  if (r.exit !== 0) throw new Error(`start failed (exit=${r.exit}): ${r.stderr}`);
}

// ── session-start ───────────────────────────────────────────────────────
describe("SC-15b — loaf hook session-start", () => {
  test("started feature → exit 0 + Claude Code SessionStart envelope with sub_state context", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);
    const r = await runCli([
      "hook",
      "session-start",
      "--feature",
      "auth-refresh",
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    // Exact Claude Code hook wire shape — NOT the loaf {ok} envelope.
    expect(Object.keys(out)).toEqual(["hookSpecificOutput"]);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("TRIAGE.score");
    expect(ctx).toContain("iteration 1");
    // prompt_inject for TRIAGE.score
    expect(ctx).toContain("Score 0-100");
    expect(r.stderr).toBe("");
  });

  test("no .loaf in cwd / unresolvable feature → silent exit 0 (empty stdout + stderr)", async () => {
    const empty = await tmpFeatureDir();
    const r = await runCli(["hook", "session-start", "--feature", "ghost", "--feature-dir", empty]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  test("no longer returns HOOK_EVENT_NOT_IMPLEMENTED", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);
    const r = await runCli([
      "hook",
      "session-start",
      "--feature",
      "auth-refresh",
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(r.stderr).not.toContain("HOOK_EVENT_NOT_IMPLEMENTED");
    expect(r.exit).toBe(0);
  });
});

// ── closure-check ─────────────────────────────────────────────────────────
describe("SC-15b — loaf hook closure-check", () => {
  test("clean started feature → exit 0, no warnings", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);
    const r = await runCli([
      "hook",
      "closure-check",
      "--feature",
      "auth-refresh",
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  test("no active session → silent exit 0", async () => {
    const empty = await tmpFeatureDir();
    const r = await runCli(["hook", "closure-check", "--feature", "ghost", "--feature-dir", empty]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  test("no longer returns HOOK_EVENT_NOT_IMPLEMENTED", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);
    const r = await runCli([
      "hook",
      "closure-check",
      "--feature",
      "auth-refresh",
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(r.stderr).not.toContain("HOOK_EVENT_NOT_IMPLEMENTED");
    expect(r.exit).toBe(0);
  });

  test("unexpected projection read error (EACCES) → warning + exit 0, never blocks Stop", async () => {
    // codex SC-15b PATCH: an IO failure outside the stale/no-session
    // taxonomy must NOT escape to the UNEXPECTED_ERROR (exit 1) boundary —
    // closure-check ALWAYS exits 0. Dispatch reads only state.json (stays
    // readable); the handler's leaf read of findings.json hits EACCES.
    const dir = await tmpFeatureDir();
    await startFeature(dir);
    const findingsLeaf = path.join(dir, "snapshots", "findings.json");
    await fs.chmod(findingsLeaf, 0o000);
    try {
      const r = await runCli([
        "hook",
        "closure-check",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
      ]);
      expect(r.exit).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("closure-check skipped");
    } finally {
      await fs.chmod(findingsLeaf, 0o644);
    }
  });
});
