// Phase 16 SC-9a-1 — `loaf verify status` CLI end-to-end.
//
// Covers:
//   - JSON envelope shape (ok / all_pass / 5 rows / failures plural)
//   - Text rendering
//   - SPEC_FRONTMATTER_INVALID at IO boundary (exit 2 — codex r302 lock,
//     NO synthetic check-1 row)
//   - NO_SESSION (no journal — exit 2)
//   - DRY_RUN_NOT_APPLICABLE
//   - --quiet (no stderr advisory; doesn't suppress payload)
//   - Dispatch resolution via --feature-dir
//   - Empty planned graph still renders 5 rows (no synthetic crash)

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main, type MainDeps } from "../../src/cli.js";

async function tmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc9a1-e2e-"));
}

async function runCli(
  argv: string[],
  opts: { env?: Record<string, string | undefined>; deps?: MainDeps; cwd?: string } = {},
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const origCwd = process.cwd();
  const envBackup: Record<string, string | undefined> = {};
  if (opts.env) {
    for (const k of Object.keys(opts.env)) {
      envBackup[k] = process.env[k];
      const v = opts.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  if (opts.cwd) process.chdir(opts.cwd);
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
    if (opts.cwd) process.chdir(origCwd);
    for (const k of Object.keys(envBackup)) {
      const prev = envBackup[k];
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

/** Seed a feature session with valid spec.md frontmatter. */
async function seedSessionWithSpec(
  opts: { allNa?: boolean } = {},
): Promise<{ featureDir: string; tmp: string }> {
  const tmp = await tmpDir();
  const featureDir = path.join(tmp, ".loaf", "auth-refresh");
  await fs.mkdir(featureDir, { recursive: true });

  // Bootstrap session via CLI start
  const startResult = await runCli(
    [
      "start",
      "auth-refresh",
      "--ceremony",
      "standard",
      "--feature-dir",
      featureDir,
      "--format",
      "json",
    ],
    {},
  );
  if (startResult.exit !== 0) {
    throw new Error(`seed start failed exit=${startResult.exit}: ${startResult.stderr}`);
  }

  // Write spec.md frontmatter so evaluateVerifyAcceptDiagnostic can read it
  const reqLine = opts.allNa
    ? `  - id: REQ-AUTH-099
    type: ubiquitous
    response: the system shall do something here measurably
    acceptance_na: true
    acceptance_na_reason: subjective UX validated by manual scope`
    : `  - id: REQ-AUTH-001
    type: ubiquitous
    response: the system shall do something here measurably`;
  await fs.writeFile(
    path.join(featureDir, "spec.md"),
    `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: OAuth token refresh
intent: users should not perceive auth recovery flows in flight
adr_refs: []
requirements:
${reqLine}
scenarios: []
needs_clarification: []
---

## Why
prose body
`,
  );

  return { featureDir, tmp };
}

describe("SC-9a-1 — verify status JSON envelope", () => {
  test("happy: seeded session + valid spec.md → exit 0, 5 rows, ok:true, all_pass boolean", async () => {
    const { featureDir } = await seedSessionWithSpec({ allNa: true });
    const result = await runCli(
      [
        "verify",
        "status",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      {},
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(typeof out.all_pass).toBe("boolean");
    expect(out.deferred_findings).toEqual([]);
    expect(out.lanes).toEqual([
      { lane: "run", applicability: "na", reason: "no_done_tasks" },
      { lane: "review", applicability: "na", reason: "no_review_obligations" },
      { lane: "acceptance", applicability: "na", reason: "no_applicable_e2e_scenarios" },
      { lane: "visual", applicability: "na", reason: "no_applicable_visual_contracts" },
    ]);
    expect(out.checks).toHaveLength(5);
    expect(out.checks.map((r: { check: string }) => r.check)).toEqual([
      "lane_status",
      "open_findings",
      "coverage",
      "task_evidence",
      "spec_review",
    ]);
    for (const row of out.checks) {
      expect(["pass", "fail", "na"]).toContain(row.status);
      expect(Array.isArray(row.failures)).toBe(true);
    }
  });

  test("task_evidence row reports TASKS_NOT_PLANNED when no tasks_planned yet", async () => {
    const { featureDir } = await seedSessionWithSpec({ allNa: true });
    const result = await runCli(
      [
        "verify",
        "status",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      {},
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    const te = out.checks.find((r: { check: string }) => r.check === "task_evidence");
    expect(te.status).toBe("fail");
    expect(te.failures[0].code).toBe("TASKS_NOT_PLANNED");
  });
});

describe("SC-9a-1 — verify status text rendering", () => {
  test("text mode renders 5 rows with status labels", async () => {
    const { featureDir } = await seedSessionWithSpec({ allNa: true });
    const result = await runCli(
      ["verify", "status", "--feature", "auth-refresh", "--feature-dir", featureDir],
      {},
    );
    expect(result.exit).toBe(0);
    // Each VerifyCheckId label should appear in stdout
    expect(result.stdout).toContain("lane_status");
    expect(result.stdout).toContain("open_findings");
    expect(result.stdout).toContain("coverage");
    expect(result.stdout).toContain("task_evidence");
    expect(result.stdout).toContain("spec_review");
    expect(result.stdout).toContain("lane.Run");
    expect(result.stdout).toContain("lane.Acceptance");
    expect(result.stdout).toContain("no applicable e2e scenarios require acceptance verification");
  });

  test("new lane rows differ between en and zh text locales", async () => {
    const { featureDir } = await seedSessionWithSpec({ allNa: true });
    const en = await runCli(
      ["verify", "status", "--feature", "auth-refresh", "--feature-dir", featureDir],
      { env: { LOAF_LANG: "en" } },
    );
    const zh = await runCli(
      ["verify", "status", "--feature", "auth-refresh", "--feature-dir", featureDir],
      { env: { LOAF_LANG: "zh" } },
    );

    expect(en.exit).toBe(0);
    expect(zh.exit).toBe(0);
    expect(en.stdout).toContain("lane.Run");
    expect(zh.stdout).toContain("泳道.运行");
    expect(zh.stdout).not.toBe(en.stdout);
  });
});

describe("SC-9a-1 — verify status IO boundary errors", () => {
  test("SPEC_FRONTMATTER_INVALID: session started but no spec.md → exit 2, code on stderr, NO synthetic check-1 row in stdout", async () => {
    const tmp = await tmpDir();
    const featureDir = path.join(tmp, ".loaf", "auth-refresh");
    await fs.mkdir(featureDir, { recursive: true });
    const start = await runCli(
      [
        "start",
        "auth-refresh",
        "--ceremony",
        "standard",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      {},
    );
    expect(start.exit).toBe(0);
    // Intentionally do NOT write spec.md
    const result = await runCli(
      [
        "verify",
        "status",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      {},
    );
    expect(result.exit).toBe(2);
    // Envelope on stderr (failure path)
    const err = JSON.parse(result.stderr);
    expect(err.ok).toBe(false);
    expect(err.code).toBe("SPEC_FRONTMATTER_INVALID");
    expect(err.detail.subcode).toBeDefined();
    // Crucially: stdout MUST NOT carry a check-1 row — codex r302 lock
    // (no synthetic injection)
    expect(result.stdout).toBe("");
  });

  test("missing feature dir → exit 2 FEATURE_NOT_FOUND (SC-8 dispatch resolver catches before NO_SESSION)", async () => {
    const tmp = await tmpDir();
    const featureDir = path.join(tmp, ".loaf", "missing");
    const result = await runCli(
      [
        "verify",
        "status",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      { cwd: tmp },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.ok).toBe(false);
    // SC-8: dispatch resolver fires FEATURE_NOT_FOUND before reaching
    // loadSession's NO_SESSION; either is acceptable as the "no session" signal
    expect(["FEATURE_NOT_FOUND", "NO_SESSION"]).toContain(err.code);
  });
});

describe("SC-9a-1 — verify status flags", () => {
  test("--dry-run rejected: exit 2 DRY_RUN_NOT_APPLICABLE (read-only)", async () => {
    const { featureDir } = await seedSessionWithSpec({ allNa: true });
    const result = await runCli(
      [
        "verify",
        "status",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
        "--dry-run",
        "--format",
        "json",
      ],
      {},
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("DRY_RUN_NOT_APPLICABLE");
  });

  test("--quiet suppresses any advisory but envelope still emits", async () => {
    const { featureDir } = await seedSessionWithSpec({ allNa: true });
    const result = await runCli(
      [
        "verify",
        "status",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
        "--quiet",
        "--format",
        "json",
      ],
      {},
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.checks).toHaveLength(5);
  });
});
