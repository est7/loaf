import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main, type MainDeps } from "../../src/cli.js";
import { PROJECTION_SCHEMA_VERSION, type RegistryFile } from "../../src/core/projection-schema.js";

async function runCli(
  argv: string[],
  opts: { deps?: MainDeps; cwd?: string } = {},
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const origCwd = process.cwd();
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
  }
}

async function tmpRegDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-board-cli-reg-"));
}

async function writeRegistryEntry(
  regDir: string,
  overrides: Partial<RegistryFile> & { session_id: string },
): Promise<void> {
  const { session_id, ...rest } = overrides;
  const file: RegistryFile = {
    schema_version: PROJECTION_SCHEMA_VERSION,
    at: "2026-06-08T10:00:00.000Z",
    session_id,
    session_label: "",
    feature: "auth-refresh",
    cwd: "/tmp",
    workspace: "default",
    phase: "EXECUTE",
    sub_state: "EXECUTE.work",
    iteration: 1,
    active_tasks: ["T-001"],
    pending: null,
    pending_queue_depth: 0,
    ceremony_label: "standard",
    ...rest,
  };
  await fs.writeFile(path.join(regDir, `${file.session_id}.json`), JSON.stringify(file), "utf8");
}

describe("loaf board CLI", () => {
  test("board --once --format json prints one stable snapshot and exits", async () => {
    const registryDir = await tmpRegDir();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-board-cli-cwd-"));
    await writeRegistryEntry(registryDir, {
      session_id: "550e8400-e29b-41d4-a716-000000000020",
      cwd,
    });

    const result = await runCli(["board", "--once", "--in-cwd", "--format", "json"], {
      deps: { registryDir, now: () => new Date("2026-06-08T11:00:00.000Z") },
      cwd,
    });

    expect(result.exit).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({
      ok: true,
      scope: "cwd",
      totals: { sessions: 1, active: 1, running: 1 },
    });
    expect(result.stderr).toBe("");
  });

  test("board --port 0 starts server, prints URL, and closes through injected keepAlive", async () => {
    let keptUrl = "";
    const result = await runCli(["board", "--port", "0"], {
      deps: {
        registryDir: await tmpRegDir(),
        boardKeepAlive: async (url) => {
          keptUrl = url;
        },
      },
    });

    expect(result.exit).toBe(0);
    expect(result.stdout).toMatch(/^loaf board: http:\/\/127\.0\.0\.1:\d+\/\n$/);
    expect(keptUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  test("board rejects invalid port as USAGE, not unexpected error", async () => {
    const result = await runCli(["board", "--port", "abc"], {
      deps: { registryDir: await tmpRegDir() },
    });

    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("USAGE");
    expect(result.stderr).toContain("invalid board port: abc");
  });

  test("board rejects --dry-run as read-only", async () => {
    const result = await runCli(["board", "--dry-run"], {
      deps: { registryDir: await tmpRegDir() },
    });

    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("DRY_RUN_NOT_APPLICABLE");
  });

  test("board rejects session selector instead of ignoring it", async () => {
    const result = await runCli(["board", "--session", "550e8400"], {
      deps: { registryDir: await tmpRegDir() },
    });

    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("USAGE");
    expect(result.stderr).toContain("board does not accept --session");
  });
});
