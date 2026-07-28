// Phase 16 SC-13a — `loaf handoff` CLI e2e.
//
// Covers (codex r346 lock):
//   - happy: writes snapshots/resume-pack.json + content validates
//   - missing --reason → USAGE (Commander requiredOption)
//   - --reason <5 chars → USAGE
//   - --dry-run → DRY_RUN_NOT_APPLICABLE + command_type=projection-writer
//   - NO_HUMAN_ACTOR via --no-input
//   - pack content validates against runtime ResumePack schema

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main, type MainDeps } from "../../src/cli.js";
import { ResumePack } from "../../src/core/resume-pack-schema.js";

async function tmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc13a-e2e-"));
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

async function seedFeature(): Promise<{ featureDir: string }> {
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
  return { featureDir };
}

describe("SC-13a — loaf handoff happy paths", () => {
  test("writes snapshots/resume-pack.json; content validates against runtime ResumePack", async () => {
    const { featureDir } = await seedFeature();
    const result = await runCli(
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
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.pack_path).toBe(path.join(featureDir, "snapshots", "resume-pack.json"));
    // File exists + content validates
    const packRaw = await fs.readFile(out.pack_path, "utf8");
    const parsed = JSON.parse(packRaw);
    const validation = ResumePack.safeParse(parsed);
    expect(validation.success).toBe(true);
    if (!validation.success) return;
    expect(validation.data.reason).toBe("context overflow approaching mid-session");
    expect(validation.data.session_id).toBe(out.session_id);
  });

  test("--notes optional passthrough", async () => {
    const { featureDir } = await seedFeature();
    const result = await runCli(
      [
        "handoff",
        "--reason",
        "deep retro of refresh storm",
        "--notes",
        "remember to revalidate REQ-AUTH-001 on resume",
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
    const packRaw = await fs.readFile(out.pack_path, "utf8");
    const parsed = JSON.parse(packRaw);
    expect(parsed.notes).toBe("remember to revalidate REQ-AUTH-001 on resume");
  });
});

describe("SC-13a — loaf handoff error paths", () => {
  test("missing --reason → Commander USAGE (non-zero exit)", async () => {
    const { featureDir } = await seedFeature();
    const result = await runCli(
      ["handoff", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).not.toBe(0);
  });

  test("--reason <5 chars → USAGE", async () => {
    const { featureDir } = await seedFeature();
    const result = await runCli(
      [
        "handoff",
        "--reason",
        "x",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.message).toContain("≥5");
  });

  test("--dry-run → DRY_RUN_NOT_APPLICABLE + command_type=projection-writer", async () => {
    const { featureDir } = await seedFeature();
    const result = await runCli(
      [
        "handoff",
        "--dry-run",
        "--reason",
        "context overflow approaching",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("DRY_RUN_NOT_APPLICABLE");
    expect(err.detail.command_type).toBe("projection-writer");
    // No pack file written
    const packPath = path.join(featureDir, "snapshots", "resume-pack.json");
    await expect(fs.access(packPath)).rejects.toThrow();
  });

  test("NO_HUMAN_ACTOR via --no-input + no LOAF_USER", async () => {
    const { featureDir } = await seedFeature();
    const result = await runCli(
      [
        "handoff",
        "--no-input",
        "--reason",
        "context overflow approaching",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      { env: { LOAF_USER: undefined } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("NO_HUMAN_ACTOR");
  });

  test("malformed feature lease fails closed before resume-pack write", async () => {
    const { featureDir } = await seedFeature();
    await fs.writeFile(path.join(featureDir, ".lock"), "{malformed");
    const result = await runCli(
      [
        "handoff",
        "--reason",
        "context overflow approaching",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(2);
    expect(JSON.parse(result.stderr).code).toBe("LOCK_TIMEOUT");
    await expect(
      fs.access(path.join(featureDir, "snapshots", "resume-pack.json")),
    ).rejects.toThrow();
  });
});
