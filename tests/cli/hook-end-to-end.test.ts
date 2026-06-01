// Phase 16 SC-15a — `loaf hook <event>` CLI surface e2e.
//
// SC-15a is framework-only — known events return
// HOOK_EVENT_NOT_IMPLEMENTED, SC-15b/c wire real handlers. Tests cover
// the 4 surface paths (bare / unknown / --list-events / known event).

import { describe, expect, test } from "vitest";

import { main, type MainDeps } from "../../src/cli.js";

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
    for (const k of Object.keys(envBackup)) {
      const prev = envBackup[k];
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────
// --list-events (codex r364 P1 — handled BEFORE bare-hook detection)
// ───────────────────────────────────────────────────────────────────────
describe("SC-15a — loaf hook --list-events", () => {
  test("text mode: emits 4 lines `<event>\\t<ClaudeCodeName>`", async () => {
    const result = await runCli(["hook", "--list-events"]);
    expect(result.exit).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("session-start\tSessionStart");
    expect(lines[1]).toBe("write-guard\tPreToolUse(Write,Edit)");
    expect(lines[2]).toBe("scope-track\tPostToolUse(Write,Edit)");
    expect(lines[3]).toBe("closure-check\tStop");
  });

  test("--format json: emits structured envelope with count + events array", async () => {
    const result = await runCli(["hook", "--list-events", "--format", "json"]);
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.count).toBe(4);
    expect(out.events).toHaveLength(4);
    expect(out.events[0]).toEqual({ event: "session-start", claude_code: "SessionStart" });
    expect(out.events[3]).toEqual({ event: "closure-check", claude_code: "Stop" });
  });

  test("--format=json (= form) accepted", async () => {
    const result = await runCli(["hook", "--list-events", "--format=json"]);
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
  });

  test("--quiet does not break --list-events", async () => {
    const result = await runCli(["hook", "--quiet", "--list-events"]);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("session-start");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Bare `loaf hook` (no event token)
// ───────────────────────────────────────────────────────────────────────
describe("SC-15a — bare `loaf hook` USAGE", () => {
  test("text mode: stderr 'error: USAGE — ...' with enum list", async () => {
    const result = await runCli(["hook"]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("USAGE");
    expect(result.stderr).toContain("session-start");
    expect(result.stderr).toContain("closure-check");
  });

  test("--format json: structured envelope + detail.events", async () => {
    const result = await runCli(["hook", "--format", "json"]);
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.detail.events).toHaveLength(4);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Unknown event → USAGE + did-you-mean
// ───────────────────────────────────────────────────────────────────────
describe("SC-15a — unknown hook event", () => {
  test("USAGE + suggestion in detail", async () => {
    const result = await runCli(["hook", "bogus", "--format", "json"]);
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.message).toContain("Did you mean");
    expect(err.detail.event).toBe("bogus");
    expect(err.detail.suggestion).toBeDefined();
  });
});

// ───────────────────────────────────────────────────────────────────────
// All 4 events are now implemented (SC-15b read-side, SC-15c write-side).
// HOOK_EVENT_NOT_IMPLEMENTED is runtime-dead; the code stays in the catalog
// as reserved-for-future-events. Behavior detail lives in the read-side /
// write-side e2e suites; here we just assert no event is stubbed.
// ───────────────────────────────────────────────────────────────────────
describe("SC-15c — no hook event returns HOOK_EVENT_NOT_IMPLEMENTED", () => {
  for (const event of ["session-start", "closure-check", "write-guard", "scope-track"] as const) {
    test(`${event} is wired (no HOOK_EVENT_NOT_IMPLEMENTED)`, async () => {
      // TTY + no --path → write-side returns USAGE, read-side silent-skips;
      // never the not-implemented stub.
      const result = await runCli(["hook", event, "--format", "json"], {
        deps: { isStdinTty: () => true },
      });
      expect(result.stderr).not.toContain("HOOK_EVENT_NOT_IMPLEMENTED");
    });
  }
});
