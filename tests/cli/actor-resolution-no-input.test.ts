// Phase 16 SC-6a — actor-resolution downgrade under `--no-input`.
//
// The integration test path codex r265 P2 locked in:
//   - MainDeps gains `isInteractiveHuman?: () => boolean` and
//     `readGitConfig?: () => string | null`. main() funnels every
//     `resolveHumanActor` call through `isInteractiveHumanForActor()`
//     (a helper that AND-folds `ctx.noInput`) + `readGitConfigForActor`.
//   - Tests inject synthetic TTY + git-config values so the downgrade
//     contract can be asserted deterministically (Vitest runs with
//     non-interactive stdin by default — see comment at
//     tests/core/cli.test.ts:637-638 — so the production literals would
//     not differentiate with-vs-without `--no-input`).
//
// Matrix (5 cases):
//   T1 — TTY=true,  git=u@e.com, no LOAF_USER, no --no-input   → OK human:u@e.com
//   T2 — TTY=true,  git=u@e.com, no LOAF_USER, --no-input      → exit 2 NO_HUMAN_ACTOR
//   T3 — TTY=true,  git=u@e.com, LOAF_USER=alice, --no-input  → OK human:alice
//   T4 — TTY=false, git=u@e.com, no LOAF_USER, no --no-input   → exit 2 NO_HUMAN_ACTOR
//   T5 — Per-site smoke: T2 across loaf deliver / abandon / archive
//        (samples 3 of the 6 sites to prove the helper is wired
//        consistently; full-6 coverage is the static guard below).
//
// Plus a static guard that scans `src/cli.tsx` for any leftover inline
// literal `isInteractiveHuman: process.stdin.isTTY === true` or
// `readGitConfig: getGitEmail` — a single mechanical proof that all 6
// human-actor sites moved to the helper (codex r265 implementation
// guardrail #2).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { main, type MainDeps } from "../../src/cli.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc6a-test-"));
}

async function runCli(
  argv: string[],
  opts: {
    env?: Record<string, string | undefined>;
    deps?: MainDeps;
  } = {},
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

async function startFeature(dir: string): Promise<void> {
  const started = await runCli([
    "start",
    "auth-refresh",
    "--ceremony",
    "standard",
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  expect(started.exit).toBe(0);
}

// ───────────────────────────────────────────────────────────────────
// T1-T4 — `loaf abandon` actor-resolution under each (TTY, --no-input,
// LOAF_USER) combination
// ───────────────────────────────────────────────────────────────────

describe("SC-6a — actor-resolution downgrade matrix (loaf abandon)", () => {
  test("T1: TTY + git fallback, no LOAF_USER, no --no-input → OK human:<git>", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);

    const result = await runCli(
      [
        "abandon",
        "--reason",
        "matrix T1",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
        "--format",
        "json",
      ],
      {
        env: { LOAF_USER: undefined },
        deps: {
          isInteractiveHuman: () => true,
          readGitConfig: () => "matrix-t1@example.invalid",
        },
      },
    );

    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.actor).toBe("human:matrix-t1@example.invalid");
  });

  test("T2: TTY + git fallback + --no-input → exit 2 NO_HUMAN_ACTOR (downgrade fires)", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);

    const result = await runCli(
      [
        "abandon",
        "--reason",
        "matrix T2",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
        "--format",
        "json",
        "--no-input",
      ],
      {
        env: { LOAF_USER: undefined },
        deps: {
          isInteractiveHuman: () => true,
          readGitConfig: () => "matrix-t2@example.invalid",
        },
      },
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("NO_HUMAN_ACTOR");
  });

  test("T3: --no-input + LOAF_USER explicit → still OK (LOAF_USER bypasses noInput gate)", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);

    const result = await runCli(
      [
        "abandon",
        "--reason",
        "matrix T3",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
        "--format",
        "json",
        "--no-input",
      ],
      {
        env: { LOAF_USER: "alice@matrix.invalid" },
        deps: {
          isInteractiveHuman: () => true,
          readGitConfig: () => "matrix-t3-git@example.invalid",
        },
      },
    );

    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.actor).toBe("human:alice@matrix.invalid");
  });

  test("T4: TTY=false (baseline pre-SC-6a), no LOAF_USER → exit 2 NO_HUMAN_ACTOR", async () => {
    // Anchors the prior non-interactive contract — same outcome as T2
    // without `--no-input`, proving SC-6a does NOT change behavior for
    // a non-TTY stdin (the previous CI-safety path).
    const dir = await tmpFeatureDir();
    await startFeature(dir);

    const result = await runCli(
      [
        "abandon",
        "--reason",
        "matrix T4",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
        "--format",
        "json",
      ],
      {
        env: { LOAF_USER: undefined },
        deps: {
          isInteractiveHuman: () => false,
          readGitConfig: () => "matrix-t4@example.invalid",
        },
      },
    );

    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("NO_HUMAN_ACTOR");
  });
});

// ───────────────────────────────────────────────────────────────────
// T5 — Per-site smoke. Confirms the helper is wired to each of the
// other human-actor sites (3 of the 6 sampled here; full 6-site
// coverage comes from the static guard below).
// ───────────────────────────────────────────────────────────────────

describe("SC-6a — per-site smoke (helper wired across human-actor commands)", () => {
  test("T5a: loaf deliver --no-input + no LOAF_USER → NO_HUMAN_ACTOR", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);

    const result = await runCli(
      [
        "deliver",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
        "--format",
        "json",
        "--no-input",
      ],
      {
        env: { LOAF_USER: undefined },
        deps: {
          isInteractiveHuman: () => true,
          readGitConfig: () => "t5a@example.invalid",
        },
      },
    );

    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("NO_HUMAN_ACTOR");
  });

  test("T5b: loaf archive --no-input + no LOAF_USER → NO_HUMAN_ACTOR", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);

    const result = await runCli(
      [
        "archive",
        "--reason",
        "t5b",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
        "--format",
        "json",
        "--no-input",
      ],
      {
        env: { LOAF_USER: undefined },
        deps: {
          isInteractiveHuman: () => true,
          readGitConfig: () => "t5b@example.invalid",
        },
      },
    );

    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("NO_HUMAN_ACTOR");
  });

  test("T5c: loaf gate decide spec-lock --no-input + no LOAF_USER → NO_HUMAN_ACTOR", async () => {
    // gate decide is the human-actor site at src/cli.tsx:585. We don't
    // need spec-lock-eval to pass — the actor resolver fires before
    // gate-eval (per main()'s ordering), so NO_HUMAN_ACTOR short-
    // circuits regardless of feature shape.
    const dir = await tmpFeatureDir();
    await startFeature(dir);

    const result = await runCli(
      [
        "gate",
        "decide",
        "spec-lock",
        "--approve",
        "--reason",
        "t5c",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
        "--format",
        "json",
        "--no-input",
      ],
      {
        env: { LOAF_USER: undefined },
        deps: {
          isInteractiveHuman: () => true,
          readGitConfig: () => "t5c@example.invalid",
        },
      },
    );

    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("NO_HUMAN_ACTOR");
  });
});

// ───────────────────────────────────────────────────────────────────
// Static guard — `src/cli.tsx` contains zero inline
//   `isInteractiveHuman: process.stdin.isTTY === true`
// or
//   `readGitConfig: getGitEmail`
// literals. Single mechanical proof that all 6 human-actor sites
// migrated to the SC-6a helpers `isInteractiveHumanForActor()` and
// `readGitConfigForActor` (codex r265 implementation guardrail #2).
// ───────────────────────────────────────────────────────────────────

describe("SC-6a — static guard: no inline actor-resolution literals remain", () => {
  test("static: src/cli.tsx contains zero inline isInteractiveHuman literals", async () => {
    const cliPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "src",
      "cli.tsx",
    );
    const source = await fs.readFile(cliPath, "utf8");
    expect(source).not.toMatch(/isInteractiveHuman:\s*process\.stdin\.isTTY\s*===\s*true/);
  });

  test("static: src/cli.tsx contains zero inline readGitConfig: getGitEmail literals", async () => {
    const cliPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "src",
      "cli.tsx",
    );
    const source = await fs.readFile(cliPath, "utf8");
    expect(source).not.toMatch(/readGitConfig:\s*getGitEmail\b/);
  });
});
