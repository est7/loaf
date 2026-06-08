// Phase 16 SC-13b — `loaf resume` CLI e2e.
//
// Covers (codex r346 lock + r347 P2 USER env):
//   - happy: handoff first → resume → exit 0, journal +1 entry kind=session:resumed
//   - sub_state unchanged after resume (transparent marker)
//   - INPUT_FILE_NOT_FOUND when no resume pack exists
//   - SCHEMA_VALIDATION_FAILED when pack is corrupt
//   - --dry-run validates without write
//   - Default cli:loaf@<USER> actor recorded from USER env

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main, type MainDeps } from "../../src/cli.js";

async function tmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc13b-e2e-"));
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

const SEED_ENV = { LOAF_USER: "Dev <dev@example.com>" };

async function seedFeatureAndHandoff(): Promise<{ featureDir: string }> {
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
    { env: SEED_ENV },
  );
  if (start.exit !== 0) throw new Error(`seed start failed: ${start.stderr}`);
  const handoff = await runCli(
    [
      "handoff",
      "--reason",
      "context overflow approaching mid-session",
      "--feature",
      "auth-refresh",
      "--feature-dir",
      featureDir,
      "--format",
      "json",
    ],
    { env: SEED_ENV },
  );
  if (handoff.exit !== 0) throw new Error(`seed handoff failed: ${handoff.stderr}`);
  return { featureDir };
}

async function readJournalEntries(featureDir: string): Promise<unknown[]> {
  const raw = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("SC-13b — loaf resume happy paths", () => {
  test("resume after handoff: journal +1 entry kind=session:resumed", async () => {
    const { featureDir } = await seedFeatureAndHandoff();
    const before = await readJournalEntries(featureDir);
    const result = await runCli(
      ["resume", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: { ...SEED_ENV, USER: "dev" } },
    );
    expect(result.exit).toBe(0);
    const after = await readJournalEntries(featureDir);
    expect(after.length).toBe(before.length + 1);
    const lastEntry = after[after.length - 1] as Record<string, unknown>;
    expect(lastEntry["kind"]).toBe("session:resumed");
    const payload = lastEntry["payload"] as Record<string, Record<string, unknown>>;
    expect(payload["resumed_from_pack"]).toBeDefined();
    expect(payload["resumed_from_pack"]!["reason"]).toBe(
      "context overflow approaching mid-session",
    );
  });

  test("sub_state unchanged after resume (transparent marker)", async () => {
    const { featureDir } = await seedFeatureAndHandoff();
    // Get sub_state via loaf status before
    const statusBefore = await runCli(
      ["status", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(statusBefore.exit).toBe(0);
    const beforeOut = JSON.parse(statusBefore.stdout);
    const before = beforeOut.state.sub_state;

    // Resume
    const result = await runCli(
      ["resume", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: { ...SEED_ENV, USER: "dev" } },
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.sub_state).toBe(before);
  });

  test("default cli:loaf@<USER> actor recorded from USER env (codex r347 P2)", async () => {
    const { featureDir } = await seedFeatureAndHandoff();
    const result = await runCli(
      ["resume", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: { ...SEED_ENV, USER: "alice" } },
    );
    expect(result.exit).toBe(0);
    const entries = await readJournalEntries(featureDir);
    const resumed = entries.find((e) => (e as { kind: string }).kind === "session:resumed") as {
      actor: string;
    };
    expect(resumed.actor).toBe("cli:loaf@alice");
  });
});

describe("SC-13b — loaf resume error paths", () => {
  test("INPUT_FILE_NOT_FOUND when no resume pack exists", async () => {
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
      { env: SEED_ENV },
    );
    expect(start.exit).toBe(0);
    const result = await runCli(
      ["resume", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("INPUT_FILE_NOT_FOUND");
  });

  test("SCHEMA_VALIDATION_FAILED on corrupt resume pack", async () => {
    const { featureDir } = await seedFeatureAndHandoff();
    const packPath = path.join(featureDir, "snapshots", "resume-pack.json");
    await fs.writeFile(packPath, "not valid json {");
    const result = await runCli(
      ["resume", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(err.detail.subcode).toBe("invalid-json");
  });

  test("SCHEMA_VALIDATION_FAILED on schema-mismatched pack", async () => {
    const { featureDir } = await seedFeatureAndHandoff();
    const packPath = path.join(featureDir, "snapshots", "resume-pack.json");
    await fs.writeFile(packPath, JSON.stringify({ wrong: "shape" }));
    const result = await runCli(
      ["resume", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(err.detail.subcode).toBe("zod");
  });

  test("--dry-run validates without writing journal entry", async () => {
    const { featureDir } = await seedFeatureAndHandoff();
    const before = await readJournalEntries(featureDir);
    const result = await runCli(
      [
        "resume",
        "--dry-run",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.dry_run).toBe(true);
    const after = await readJournalEntries(featureDir);
    expect(after.length).toBe(before.length);
  });
});
