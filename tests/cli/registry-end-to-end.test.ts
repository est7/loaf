// Phase 16 SC-7 — CLI end-to-end registry write integration.
//
// Verifies that `loaf start` / `loaf advance` produce + update
// `~/.loaf/registry/<id>.json` via the MainDeps.registryDir injection
// point. Every test injects a tmp registry dir — NEVER touches the real
// user registry (codex r280 P5 safety invariant).
//
// Covers:
//   T15: loaf start → registry file produced under tmp dir
//   T16: loaf advance updates the same registry file
//   T17: loaf --dry-run start → no registry file (P1 suppression)

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main, type MainDeps } from "../../src/cli.js";

async function tmpRegistryDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc7-cli-reg-"));
}

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc7-cli-feat-"));
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

describe("SC-7 — CLI registry writer integration (DI safe)", () => {
  test("T15: loaf start → registry file produced under injected tmp dir", async () => {
    const featureDir = await tmpFeatureDir();
    const registryDir = await tmpRegistryDir();
    const result = await runCli(
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
      { deps: { registryDir } },
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);

    // Registry file produced under the injected tmp dir
    const files = await fs.readdir(registryDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^[0-9a-f-]+\.json$/);

    const reg = JSON.parse(await fs.readFile(path.join(registryDir, files[0]!), "utf8"));
    expect(reg.feature).toBe("auth-refresh");
    expect(reg.sub_state).toBe("TRIAGE.score");
  });

  test("T16: loaf advance updates the same registry file (atomic rewrite)", async () => {
    const featureDir = await tmpFeatureDir();
    const registryDir = await tmpRegistryDir();
    await runCli(
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
      { deps: { registryDir } },
    );

    const files = await fs.readdir(registryDir);
    const regPath = path.join(registryDir, files[0]!);
    const regBefore = JSON.parse(await fs.readFile(regPath, "utf8"));
    expect(regBefore.sub_state).toBe("TRIAGE.score");

    // Advance to TRIAGE.confirm
    const result = await runCli(
      [
        "advance",
        "TRIAGE.confirm",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      { deps: { registryDir } },
    );
    expect(result.exit).toBe(0);

    const regAfter = JSON.parse(await fs.readFile(regPath, "utf8"));
    expect(regAfter.sub_state).toBe("TRIAGE.confirm");
    expect(regAfter.session_id).toBe(regBefore.session_id);
  });

  test("T17: loaf --dry-run start does NOT produce registry file", async () => {
    const featureDir = await tmpFeatureDir();
    const registryDir = await tmpRegistryDir();
    const result = await runCli(
      [
        "--dry-run",
        "start",
        "auth-refresh",
        "--ceremony",
        "standard",
        "--feature-dir",
        featureDir,
        "--format",
        "json",
      ],
      { deps: { registryDir } },
    );
    expect(result.exit).toBe(0);
    // Tmp registry dir exists (we created it) but stays empty
    const files = await fs.readdir(registryDir);
    expect(files).toEqual([]);
  });
});
