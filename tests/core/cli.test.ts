// Stage 5+ / audit r1 Blocker #7 — CLI smoke tests.
//
// Drives the loaf CLI through the start / advance / status surface to
// verify the full transactional path end-to-end (CLI → mutate → journal).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import { LOAF_DOCS_URL, LOAF_ISSUE_URL } from "../../src/core/cli-runtime.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-cli-test-"));
}

async function runCli(argv: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
  // Capture stdout / stderr writes during main(); restore after.
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

describe("loaf CLI — Blocker #7 MVP surface", () => {
  test("loaf start <feature> emits session:started + JSON output", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli([
      "start", "auth-refresh",
      "--ceremony", "standard",
      "--feature-dir", dir,
      "--json",
    ]);
    expect(result.exit).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; ceremony_label: string; sub_state: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.ceremony_label).toBe("standard");
    expect(parsed.sub_state).toBe("TRIAGE.score");

    // Journal landed on disk.
    const journal = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journal.trim().split("\n")).toHaveLength(1);
  });

  test("loaf advance moves the cursor (TRIAGE.score → TRIAGE.confirm)", async () => {
    const dir = await tmpFeatureDir();
    const startRes = await runCli([
      "start", "auth-refresh",
      "--ceremony", "standard",
      "--feature-dir", dir,
      "--json",
    ]);
    expect(startRes.exit).toBe(0);

    const adv = await runCli([
      "advance", "TRIAGE.confirm",
      "--feature", "auth-refresh",
      "--feature-dir", dir,
      "--json",
    ]);
    expect(adv.exit).toBe(0);
    const parsed = JSON.parse(adv.stdout) as { sub_state: string };
    expect(parsed.sub_state).toBe("TRIAGE.confirm");
  });

  test("loaf advance with illegal edge → exit 2 + TRANSITION_ILLEGAL", async () => {
    const dir = await tmpFeatureDir();
    await runCli([
      "start", "auth-refresh",
      "--ceremony", "standard",
      "--feature-dir", dir,
      "--json",
    ]);

    const adv = await runCli([
      "advance", "DONE.delivered",
      "--feature", "auth-refresh",
      "--feature-dir", dir,
      "--json",
    ]);
    expect(adv.exit).toBe(2);
    expect(adv.stderr).toMatch(/TRANSITION_ILLEGAL/);
  });

  test("loaf status reads the current cursor + projection counts", async () => {
    const dir = await tmpFeatureDir();
    await runCli([
      "start", "auth-refresh",
      "--ceremony", "standard",
      "--feature-dir", dir,
      "--json",
    ]);

    const status = await runCli([
      "status",
      "--feature", "auth-refresh",
      "--feature-dir", dir,
      "--json",
    ]);
    expect(status.exit).toBe(0);
    const parsed = JSON.parse(status.stdout) as { state: { sub_state: string }; tail_seq: number };
    expect(parsed.state.sub_state).toBe("TRIAGE.score");
    expect(parsed.tail_seq).toBe(0);
  });

  test("URL stamps are non-empty (build-time define applied or fallback sentinel)", () => {
    expect(LOAF_DOCS_URL.length).toBeGreaterThan(0);
    expect(LOAF_ISSUE_URL.length).toBeGreaterThan(0);
    // In dev/test runs the sentinel ends in `.invalid`; in production
    // builds tsdown rewrites it. Either way, must not be empty.
  });

  test("invalid ceremony preset → exit 2 + INVALID_PRESET", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli([
      "start", "bogus",
      "--ceremony", "unicorn",
      "--feature-dir", dir,
    ]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toMatch(/INVALID_PRESET/);
  });
});
