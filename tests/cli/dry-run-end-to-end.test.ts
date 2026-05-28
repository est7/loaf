// Phase 16 SC-6c — `--dry-run` end-to-end integration.
//
// Covers:
//   - Mutating commands under --dry-run: exit 0, no journal.jsonl written
//   - dry-run + --debug: trace.jsonl ALSO not written (codex r275 P1)
//   - dry-run does NOT create feature dir (codex r275 P6 — mkdir leak)
//   - Read-only commands reject with DRY_RUN_NOT_APPLICABLE (typed)
//   - doctor --rebuild rejects under --dry-run
//   - -n short form works for both mutating + read-only paths
//   - dry-run failure paths still surface preflight / transition errors

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc6c-e2e-"));
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

describe("SC-6c — --dry-run mutating: short-circuit before disk write", () => {
  test("T15: loaf --dry-run start <f> → exit 0, JSON would-shape, no journal.jsonl", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli(
      ["--dry-run", "start", "auth-refresh", "--ceremony", "standard",
       "--feature-dir", dir, "--format", "json"],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.dry_run).toBe(true);
    expect(out.would.kind).toBe("session:started");
    // No journal written
    await expect(fs.stat(path.join(dir, "journal.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("T16: -n short form parses identically", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli(
      ["-n", "start", "auth-refresh", "--ceremony", "standard",
       "--feature-dir", dir, "--format", "json"],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.dry_run).toBe(true);
  });

  test("T17: text-mode dry-run line on stdout", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli(
      ["--dry-run", "start", "auth-refresh", "--ceremony", "standard",
       "--feature-dir", dir],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe("dry-run: would session:started\n");
  });

  test("T18: dry-run preserves failure paths — preflight errors surface", async () => {
    // Start a feature first (real), then attempt --dry-run advance to
    // an illegal sub_state. The dry-run path should surface
    // TRANSITION_ILLEGAL (preflight win, not silent success).
    const dir = await tmpFeatureDir();
    await runCli(
      ["start", "auth-refresh", "--ceremony", "standard",
       "--feature-dir", dir, "--format", "json"],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    const result = await runCli(
      ["--dry-run", "advance", "DONE.delivered",
       "--feature", "auth-refresh", "--feature-dir", dir, "--format", "json"],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("TRANSITION_ILLEGAL");
  });
});

describe("SC-6c — --dry-run + --debug: trace.jsonl also suppressed (P1)", () => {
  test("T19: dry-run + --debug → no trace.jsonl on disk", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli(
      ["--dry-run", "start", "auth-refresh", "--ceremony", "standard",
       "--feature-dir", dir, "--debug", "--format", "json"],
      { env: { LOAF_USER: "tester@example.invalid", LOAF_DEBUG: undefined, DEBUG: undefined } },
    );
    expect(result.exit).toBe(0);
    // Neither journal nor trace
    await expect(fs.stat(path.join(dir, "journal.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(dir, "trace.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("SC-6c — --dry-run does NOT create feature dir (mkdir leak, P6)", () => {
  test("T20: dry-run + nonexistent feature dir → exit 0, dir NOT created", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc6c-leak-"));
    const featureDir = path.join(parent, "should-not-exist");
    // Precondition: nonexistent
    await expect(fs.stat(featureDir)).rejects.toMatchObject({ code: "ENOENT" });

    const result = await runCli(
      ["--dry-run", "start", "auth-refresh", "--ceremony", "standard",
       "--feature-dir", featureDir, "--format", "json"],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );
    expect(result.exit).toBe(0);
    // Critical: dir still does NOT exist after dry-run
    await expect(fs.stat(featureDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("SC-6c — read-only commands reject --dry-run (DRY_RUN_NOT_APPLICABLE)", () => {
  test("T21: loaf --dry-run status → exit 2 DRY_RUN_NOT_APPLICABLE", async () => {
    const result = await runCli(
      ["--dry-run", "status", "--feature", "auth-refresh",
       "--feature-dir", "/tmp/nonexistent", "--format", "json"],
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("DRY_RUN_NOT_APPLICABLE");
    expect(err.detail.command).toBe("status");
    expect(err.detail.command_type).toBe("read-only");
  });

  test("T22: loaf -n tasks list → DRY_RUN_NOT_APPLICABLE", async () => {
    const result = await runCli(
      ["-n", "tasks", "list", "--feature", "f", "--feature-dir", "/tmp/x", "--format", "json"],
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("DRY_RUN_NOT_APPLICABLE");
  });

  test("T23: loaf --dry-run finding list → DRY_RUN_NOT_APPLICABLE", async () => {
    const result = await runCli(
      ["--dry-run", "finding", "list", "--feature", "f", "--feature-dir", "/tmp/x", "--format", "json"],
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("DRY_RUN_NOT_APPLICABLE");
  });

  test("T24: loaf --dry-run pending list → DRY_RUN_NOT_APPLICABLE", async () => {
    const result = await runCli(
      ["--dry-run", "pending", "list", "--feature", "f", "--feature-dir", "/tmp/x", "--format", "json"],
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("DRY_RUN_NOT_APPLICABLE");
  });

  test("T25: text-mode read-only reject — proper renderer shape", async () => {
    const result = await runCli(
      ["--dry-run", "status", "--feature", "f", "--feature-dir", "/tmp/x"],
    );
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("error: DRY_RUN_NOT_APPLICABLE");
    expect(result.stderr).toContain("`status`");
  });
});

describe("SC-6c — doctor --rebuild rejects --dry-run (P2)", () => {
  test("T26: loaf --dry-run doctor --rebuild → DRY_RUN_NOT_APPLICABLE", async () => {
    const result = await runCli(
      ["--dry-run", "doctor", "--rebuild", "--feature", "auth-refresh",
       "--feature-dir", "/tmp/x", "--format", "json"],
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("DRY_RUN_NOT_APPLICABLE");
    expect(err.detail.command).toBe("doctor --rebuild");
  });

  test("T27: loaf --dry-run doctor (bare) → DRY_RUN_NOT_APPLICABLE", async () => {
    const result = await runCli(
      ["--dry-run", "doctor", "--format", "json"],
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("DRY_RUN_NOT_APPLICABLE");
    expect(err.detail.command).toBe("doctor");
  });
});
