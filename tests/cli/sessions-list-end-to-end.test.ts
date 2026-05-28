// Phase 16 SC-9b — `loaf sessions list` CLI end-to-end.
//
// Covers:
//   - List across all sessions (no --in-cwd) and filtered (--in-cwd)
//   - --format json vs text rendering
//   - --dry-run rejection (DRY_RUN_NOT_APPLICABLE)
//   - Dispatch selector rejections (8 cases, codex r292 P1 v3):
//     --session / $LOAF_SESSION / --feature / --feature-dir at various
//     positions, plus negative messaging asserting NOT SC-8's
//     "requires --feature"
//   - Corrupt registry entry surfaces warning (NOT silent)
//   - --quiet suppresses warning

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main, type MainDeps } from "../../src/cli.js";

async function tmpRegDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc9b-cli-reg-"));
}

async function tmpCwdAndSeed(featureName: string, registryDir: string): Promise<{ cwd: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc9b-cli-cwd-"));
  await runCli(
    ["start", featureName, "--ceremony", "standard",
     "--feature-dir", path.join(cwd, ".loaf", featureName), "--format", "json"],
    { deps: { registryDir, registryCwd: () => cwd }, cwd },
  );
  return { cwd };
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

describe("SC-9b — sessions list happy paths", () => {
  test("T9: loaf sessions list with 2 sessions → both listed (no --in-cwd)", async () => {
    const registryDir = await tmpRegDir();
    await tmpCwdAndSeed("feature-a", registryDir);
    await tmpCwdAndSeed("feature-b", registryDir);
    const result = await runCli(["sessions", "list", "--format", "json"], { deps: { registryDir } });
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.count).toBe(2);
    expect(out.sessions.map((s: { feature: string }) => s.feature).sort()).toEqual([
      "feature-a", "feature-b",
    ]);
  });

  test("T10: loaf sessions list --in-cwd → filtered to current cwd only", async () => {
    const registryDir = await tmpRegDir();
    const { cwd: cwdA } = await tmpCwdAndSeed("feature-a", registryDir);
    await tmpCwdAndSeed("feature-b", registryDir);
    const result = await runCli(["sessions", "list", "--in-cwd", "--format", "json"],
      { deps: { registryDir }, cwd: cwdA });
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.count).toBe(1);
    expect(out.sessions[0].feature).toBe("feature-a");
  });

  test("T11: text mode → 4-column aligned output", async () => {
    const registryDir = await tmpRegDir();
    await tmpCwdAndSeed("auth-refresh", registryDir);
    const result = await runCli(["sessions", "list"], { deps: { registryDir } });
    expect(result.exit).toBe(0);
    // Format: <short8>  <feature>  <sub_state>  <at>
    expect(result.stdout).toMatch(/^[0-9a-f]{8}\s+auth-refresh\s+TRIAGE\.score\s+/);
  });

  test("T12: empty registry → '(no sessions found)\\n'", async () => {
    const registryDir = await tmpRegDir();
    const result = await runCli(["sessions", "list"], { deps: { registryDir } });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe("(no sessions found)\n");
  });

  test("T13: --dry-run sessions list → DRY_RUN_NOT_APPLICABLE", async () => {
    const registryDir = await tmpRegDir();
    const result = await runCli(["--dry-run", "sessions", "list", "--format", "json"],
      { deps: { registryDir } });
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("DRY_RUN_NOT_APPLICABLE");
    expect(err.detail.command).toBe("sessions list");
  });
});

describe("SC-9b — dispatch selector rejection (codex r292 P1 v3)", () => {
  test("T-reject-1: loaf --session UUID sessions list → USAGE", async () => {
    const result = await runCli(
      ["--session", "550e8400-e29b-41d4-a716-aaaaaaaaaaaa", "sessions", "list", "--format", "json"],
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("USAGE");
    expect(err.detail.conflicting).toEqual(["--session"]);
    expect(err.message).toContain("sessions list does not accept");
  });

  test("T-reject-2: LOAF_SESSION=UUID loaf sessions list → USAGE", async () => {
    const result = await runCli(
      ["sessions", "list", "--format", "json"],
      { env: { LOAF_SESSION: "550e8400-e29b-41d4-a716-aaaaaaaaaaaa" } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.detail.conflicting).toEqual(["$LOAF_SESSION"]);
  });

  test("T-reject-3: loaf sessions list --feature X → USAGE (not commander.unknownOption)", async () => {
    const result = await runCli(["sessions", "list", "--feature", "X", "--format", "json"]);
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("USAGE");
    expect(err.detail.conflicting).toEqual(["--feature"]);
    expect(err.message).toContain("sessions list does not accept");
  });

  test("T-reject-4: loaf --feature X sessions list → USAGE (global position)", async () => {
    const result = await runCli(["--feature", "X", "sessions", "list", "--format", "json"]);
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("USAGE");
    expect(err.detail.conflicting).toEqual(["--feature"]);
  });

  test("T-reject-5: loaf sessions list --feature X --feature-dir /tmp/x → USAGE listing both", async () => {
    const result = await runCli(
      ["sessions", "list", "--feature", "X", "--feature-dir", "/tmp/x", "--format", "json"],
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.detail.conflicting).toEqual(["--feature", "--feature-dir"]);
  });

  test("T-reject-7: loaf sessions list --feature-dir /tmp/x → SC-9b USAGE (NOT SC-8 'requires --feature')", async () => {
    const result = await runCli(
      ["sessions", "list", "--feature-dir", "/tmp/x", "--format", "json"],
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.code).toBe("USAGE");
    expect(err.detail.conflicting).toEqual(["--feature-dir"]);
    expect(err.message).toContain("sessions list does not accept");
    expect(err.message).not.toContain("requires --feature");
  });

  test("T-reject-8: loaf --feature-dir /tmp/x sessions list → SC-9b USAGE (global position; SC-9b owns)", async () => {
    const result = await runCli(
      ["--feature-dir", "/tmp/x", "sessions", "list", "--format", "json"],
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.message).toContain("sessions list does not accept");
  });

  test("T-reject-9: text mode rejection renders 'error: USAGE — ...'", async () => {
    const result = await runCli(
      ["--session", "550e8400-e29b-41d4-a716-aaaaaaaaaaaa", "sessions", "list"],
    );
    expect(result.exit).toBe(2);
    expect(result.stderr).toMatch(/^error: USAGE —/);
  });

  test("T-reject-sanity: plain `loaf sessions list` (no selectors) → runs normally", async () => {
    const registryDir = await tmpRegDir();
    const result = await runCli(["sessions", "list", "--format", "json"], { deps: { registryDir } });
    expect(result.exit).toBe(0);
  });
});

describe("SC-9b — corrupt registry observable skip (codex r290 P2)", () => {
  test("T-corrupt-text: 1 valid + 1 corrupt → stdout has valid row; stderr warning", async () => {
    const registryDir = await tmpRegDir();
    await tmpCwdAndSeed("auth-refresh", registryDir);
    await fs.writeFile(path.join(registryDir, "corrupt-id.json"), "{not valid", "utf8");

    const result = await runCli(["sessions", "list"], { deps: { registryDir } });
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("auth-refresh");
    // Warning via ctx.advisory → stderr with "loaf: " prefix
    expect(result.stderr).toContain("corrupt-id.json");
    expect(result.stderr).toContain("corrupt-json");
  });

  test("T-corrupt-json: warnings carried in JSON envelope", async () => {
    const registryDir = await tmpRegDir();
    await tmpCwdAndSeed("auth-refresh", registryDir);
    await fs.writeFile(path.join(registryDir, "corrupt-id.json"), "garbage", "utf8");

    const result = await runCli(["sessions", "list", "--format", "json"],
      { deps: { registryDir } });
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.count).toBe(1);
    expect(out.warnings.length).toBe(1);
    expect(out.warnings[0].file).toBe("corrupt-id.json");
  });

  test("T-orphan-cwd-no-filter (codex r293): orphan-cwd row LISTED + 'has orphan cwd' warning (NOT 'skipped')", async () => {
    const registryDir = await tmpRegDir();
    // Seed a valid session, then manually craft an orphan-cwd registry
    // entry pointing at a non-existent directory.
    await tmpCwdAndSeed("valid-feat", registryDir);
    const orphanFile = path.join(registryDir, "550e8400-e29b-41d4-a716-deadbeefcafe.json");
    await fs.writeFile(orphanFile, JSON.stringify({
      schema_version: 2,
      at: "2026-05-28T14:00:00.000Z",
      session_id: "550e8400-e29b-41d4-a716-deadbeefcafe",
      session_label: "",
      feature: "orphan-feat",
      cwd: "/tmp/loaf-sc9b-ORPHAN-DELETED-DIR-DOES-NOT-EXIST",
      workspace: "default",
      phase: "TRIAGE",
      sub_state: "TRIAGE.score",
      iteration: 1,
      active_tasks: [],
      pending: null,
      pending_queue_depth: 0,
      ceremony_label: "standard",
    }), "utf8");

    const result = await runCli(["sessions", "list", "--format", "json"], { deps: { registryDir } });
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    // Orphan row IS listed in no-filter mode
    expect(out.count).toBe(2);
    expect(out.sessions.some((s: { feature: string }) => s.feature === "orphan-feat")).toBe(true);
    // Warning carries orphan-cwd reason
    expect(out.warnings.some((w: { reason: string }) => w.reason === "orphan-cwd")).toBe(true);

    // Text mode: warning says "has orphan cwd", NOT "skipped" (contradiction)
    const textResult = await runCli(["sessions", "list"], { deps: { registryDir } });
    expect(textResult.stderr).toContain("has orphan cwd");
    expect(textResult.stderr).not.toContain("skipped (orphan-cwd");
  });

  test("T-orphan-cwd-filtered: with --in-cwd, orphan rows EXCLUDED + 'filtered out' wording", async () => {
    const registryDir = await tmpRegDir();
    const { cwd } = await tmpCwdAndSeed("valid-feat", registryDir);
    const orphanFile = path.join(registryDir, "550e8400-e29b-41d4-a716-cafe0badbeef.json");
    await fs.writeFile(orphanFile, JSON.stringify({
      schema_version: 2,
      at: "2026-05-28T14:00:00.000Z",
      session_id: "550e8400-e29b-41d4-a716-cafe0badbeef",
      session_label: "",
      feature: "orphan-filtered",
      cwd: "/tmp/loaf-sc9b-ANOTHER-ORPHAN-DELETED",
      workspace: "default",
      phase: "TRIAGE",
      sub_state: "TRIAGE.score",
      iteration: 1,
      active_tasks: [],
      pending: null,
      pending_queue_depth: 0,
      ceremony_label: "standard",
    }), "utf8");

    const result = await runCli(["sessions", "list", "--in-cwd"], { deps: { registryDir }, cwd });
    expect(result.exit).toBe(0);
    // Orphan filtered out + warning says "filtered out"
    expect(result.stdout).toContain("valid-feat");
    expect(result.stdout).not.toContain("orphan-filtered");
    expect(result.stderr).toContain("filtered out");
  });

  test("T-quiet-suppress: --quiet suppresses the corruption warning (rows still emit)", async () => {
    const registryDir = await tmpRegDir();
    await tmpCwdAndSeed("auth-refresh", registryDir);
    await fs.writeFile(path.join(registryDir, "corrupt-id.json"), "{not valid", "utf8");

    const result = await runCli(["sessions", "list", "--quiet"], { deps: { registryDir } });
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("auth-refresh");
    expect(result.stderr).not.toContain("corrupt-id.json");
  });
});
