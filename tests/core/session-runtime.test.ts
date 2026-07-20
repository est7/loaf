import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { SessionRuntimeFile } from "../../src/core/projection-schema.js";
import {
  readSessionRuntimeFile,
  sessionRuntimeFilePath,
  sessionRuntimeLockPath,
  withRuntimeLock,
  writeSessionRuntimeFile,
  type RuntimeIdentity,
  type RuntimeStoreOptions,
} from "../../src/core/session-runtime.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const RECOVERER_FIXTURE = path.resolve("tests/fixtures/session-runtime-recoverer.ts");

async function runRecoverer(env: Record<string, string>): Promise<void> {
  const child = spawn("bun", [RECOVERER_FIXTURE], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    throw new Error(`recoverer exited code=${code} signal=${signal}: ${stderr}`);
  }
}

async function fixture(): Promise<{
  runtimeDir: string;
  cwd: string;
  identity: RuntimeIdentity;
  options: RuntimeStoreOptions;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-session-runtime-"));
  const runtimeDir = path.join(root, ".loaf", "runtime");
  const cwd = path.join(root, "repo");
  await fs.mkdir(cwd);
  return {
    runtimeDir,
    cwd,
    identity: { session_id: SESSION_ID, cwd },
    options: {
      runtimeDir,
      lockTimeoutMs: 2_000,
      retryDelayMs: 2,
      now: () => new Date("2026-07-20T10:00:00.000Z"),
    },
  };
}

function runtimeFile(cwd: string): SessionRuntimeFile {
  return {
    schema_version: 2,
    session_id: SESSION_ID,
    cwd,
    debug: false,
    heartbeat_at: "2026-07-20T10:00:00.000Z",
    pending_scope: null,
  };
}

function addPath(current: SessionRuntimeFile, scopePath: string): SessionRuntimeFile {
  const paths = new Set(current.pending_scope?.paths ?? []);
  paths.add(scopePath);
  return {
    ...current,
    pending_scope: { iteration: 1, paths: [...paths].sort() },
  };
}

describe("SessionRuntimeFile v2 schema", () => {
  test("requires strict pending_scope null or canonical iteration/path set", () => {
    const base = runtimeFile("/repo");
    expect(SessionRuntimeFile.safeParse(base).success).toBe(true);
    expect(
      SessionRuntimeFile.safeParse({
        ...base,
        pending_scope: { iteration: 1, paths: ["src/a.ts", "src/b.ts"] },
      }).success,
    ).toBe(true);
    expect(SessionRuntimeFile.safeParse({ ...base, pending_scope: undefined }).success).toBe(
      false,
    );
    expect(
      SessionRuntimeFile.safeParse({
        ...base,
        pending_scope: { iteration: 1, paths: ["src/b.ts", "src/a.ts"] },
      }).success,
    ).toBe(false);
    expect(SessionRuntimeFile.safeParse({ ...base, extra: true }).success).toBe(false);
  });
});

describe("session runtime storage + dedicated lock", () => {
  test("N genuinely concurrent writers retain every distinct path", async () => {
    const { cwd, identity, options } = await fixture();
    await writeSessionRuntimeFile(identity, runtimeFile(cwd), options);

    let releaseStart!: () => void;
    const start = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const paths = Array.from({ length: 24 }, (_, index) =>
      `src/concurrent-${String(index).padStart(2, "0")}.ts`,
    );
    const writers = paths.map(async (scopePath) => {
      await start;
      return await withRuntimeLock(
        identity,
        `add:${scopePath}`,
        async (current) => {
          expect(current).not.toBeNull();
          await new Promise((resolve) => setTimeout(resolve, 3));
          return addPath(current!, scopePath);
        },
        options,
      );
    });
    releaseStart();
    await Promise.all(writers);

    const final = await readSessionRuntimeFile(identity, options);
    expect(final?.pending_scope?.paths).toEqual(paths);
  });

  test("two concurrent writes of the same path dedupe", async () => {
    const { cwd, identity, options } = await fixture();
    await writeSessionRuntimeFile(identity, runtimeFile(cwd), options);
    await Promise.all(
      [1, 2].map(async (index) =>
        await withRuntimeLock(
          identity,
          `dedupe:${index}`,
          async (current) => {
            await new Promise((resolve) => setTimeout(resolve, 3));
            return addPath(current!, "src/shared.ts");
          },
          options,
        ),
      ),
    );
    expect((await readSessionRuntimeFile(identity, options))?.pending_scope?.paths).toEqual([
      "src/shared.ts",
    ]);
  });

  test("malformed and identity-mismatched files fail closed without invoking mutator", async () => {
    const { runtimeDir, cwd, identity, options } = await fixture();
    await fs.mkdir(runtimeDir, { recursive: true });
    const target = sessionRuntimeFilePath(identity.session_id, options);
    await fs.writeFile(target, "{malformed", { mode: 0o600 });
    await expect(readSessionRuntimeFile(identity, options)).rejects.toMatchObject({
      code: "RUNTIME_FILE_INVALID",
    });

    const otherCwd = path.join(path.dirname(cwd), "other-repo");
    await fs.mkdir(otherCwd);
    await fs.writeFile(target, JSON.stringify(runtimeFile(otherCwd)), { mode: 0o600 });
    let called = false;
    await expect(
      withRuntimeLock(
        identity,
        "must-not-merge",
        (current) => {
          called = true;
          return current!;
        },
        options,
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_IDENTITY_MISMATCH" });
    expect(called).toBe(false);
  });

  test("readers observe only complete old/new JSON during atomic replacement", async () => {
    const { runtimeDir, cwd, identity, options } = await fixture();
    await writeSessionRuntimeFile(identity, runtimeFile(cwd), options);
    const target = sessionRuntimeFilePath(identity.session_id, options);
    const largePaths = Array.from({ length: 8_000 }, (_, index) =>
      `src/generated/file-${String(index).padStart(5, "0")}.ts`,
    );

    let entered!: () => void;
    const callbackEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const callbackGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writerDone = false;
    const writer = withRuntimeLock(
      identity,
      "atomic-replace",
      async (current) => {
        entered();
        await callbackGate;
        return { ...current!, pending_scope: { iteration: 1, paths: largePaths } };
      },
      options,
    ).finally(() => {
      writerDone = true;
    });
    await callbackEntered;

    const observedSizes: number[] = [];
    const observe = async (): Promise<void> => {
      while (!writerDone) {
        const parsed = SessionRuntimeFile.parse(JSON.parse(await fs.readFile(target, "utf8")));
        observedSizes.push(parsed.pending_scope?.paths.length ?? 0);
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const reader = observe();
    release();
    await writer;
    await reader;
    const final = SessionRuntimeFile.parse(JSON.parse(await fs.readFile(target, "utf8")));
    observedSizes.push(final.pending_scope?.paths.length ?? 0);
    expect(observedSizes.every((size) => size === 0 || size === largePaths.length)).toBe(true);
    expect(observedSizes).toContain(0);
    expect(observedSizes).toContain(largePaths.length);
    expect(path.dirname(target)).toBe(runtimeDir);
  });

  test("stale lock is recovered only after its PID has exited", async () => {
    const { runtimeDir, cwd, identity, options } = await fixture();
    await writeSessionRuntimeFile(identity, runtimeFile(cwd), options);
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const exitedPid = child.pid!;
    await once(child, "exit");
    const lockPath = sessionRuntimeLockPath(identity.session_id, options);
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: exitedPid,
        acquired_at: "2026-07-20T10:00:00.000Z",
        operation: "crashed-writer",
      }),
      { mode: 0o600 },
    );

    await withRuntimeLock(
      identity,
      "recover-stale",
      (current) => ({ ...current!, heartbeat_at: "2026-07-20T10:01:00.000Z" }),
      options,
    );
    expect((await readSessionRuntimeFile(identity, options))?.heartbeat_at).toBe(
      "2026-07-20T10:01:00.000Z",
    );
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(path.dirname(lockPath)).toBe(runtimeDir);
  });

  test("two processes recovering the same stale generation retain both updates", async () => {
    const { runtimeDir, cwd, identity, options } = await fixture();
    await writeSessionRuntimeFile(identity, runtimeFile(cwd), options);
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const exitedPid = child.pid!;
    await once(child, "exit");
    await fs.writeFile(
      sessionRuntimeLockPath(identity.session_id, options),
      JSON.stringify({
        pid: exitedPid,
        acquired_at: "2026-07-20T10:00:00.000Z",
        operation: "crashed-writer",
      }),
      { mode: 0o600 },
    );
    const barrierDir = await fs.mkdtemp(path.join(path.dirname(runtimeDir), "recover-barrier-"));
    const shared = {
      LOAF_TEST_RUNTIME_DIR: runtimeDir,
      LOAF_TEST_CWD: cwd,
      LOAF_TEST_SESSION_ID: identity.session_id,
      LOAF_TEST_STALE_PID: String(exitedPid),
      LOAF_TEST_BARRIER_DIR: barrierDir,
      HOME: path.dirname(path.dirname(runtimeDir)),
    };

    await Promise.all([
      runRecoverer({
        ...shared,
        LOAF_TEST_RECOVERER_ROLE: "A",
        LOAF_TEST_SCOPE_PATH: "src/from-a.ts",
      }),
      runRecoverer({
        ...shared,
        LOAF_TEST_RECOVERER_ROLE: "B",
        LOAF_TEST_SCOPE_PATH: "src/from-b.ts",
      }),
    ]);

    expect((await readSessionRuntimeFile(identity, options))?.pending_scope?.paths).toEqual([
      "src/from-a.ts",
      "src/from-b.ts",
    ]);
  });

  test("release leaves a foreign owner token in place without throwing", async () => {
    const { cwd, identity, options } = await fixture();
    await writeSessionRuntimeFile(identity, runtimeFile(cwd), options);
    const lockPath = sessionRuntimeLockPath(identity.session_id, options);
    const foreign = {
      pid: process.pid,
      acquired_at: "2026-07-20T10:02:00.000Z",
      operation: "replacement-owner",
      owner: "f".repeat(32),
    };

    await expect(
      withRuntimeLock(
        identity,
        "ownership-replaced",
        async (current) => {
          await fs.writeFile(lockPath, JSON.stringify(foreign), { mode: 0o600 });
          return current!;
        },
        options,
      ),
    ).resolves.toBeDefined();
    expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toEqual(foreign);
    await fs.unlink(lockPath);
  });

  test("live-PID lock is respected until bounded timeout", async () => {
    const { runtimeDir, cwd, identity, options } = await fixture();
    await writeSessionRuntimeFile(identity, runtimeFile(cwd), options);
    const lockPath = sessionRuntimeLockPath(identity.session_id, options);
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        acquired_at: "2026-07-20T10:00:00.000Z",
        operation: "live-writer",
      }),
      { mode: 0o600 },
    );
    await expect(
      withRuntimeLock(identity, "must-timeout", (current) => current!, {
        ...options,
        lockTimeoutMs: 25,
        retryDelayMs: 5,
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_LOCK_TIMEOUT",
      holder: { pid: process.pid, operation: "live-writer" },
    });
    expect((await fs.stat(lockPath)).isFile()).toBe(true);
    await fs.unlink(lockPath);
    expect(path.dirname(lockPath)).toBe(runtimeDir);
  });

  test("runtime directory is 0700 and runtime/lock files are 0600", async () => {
    const { runtimeDir, cwd, identity, options } = await fixture();
    await writeSessionRuntimeFile(identity, runtimeFile(cwd), options);
    expect((await fs.stat(runtimeDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(sessionRuntimeFilePath(identity.session_id, options))).mode & 0o777).toBe(
      0o600,
    );

    const lockPath = sessionRuntimeLockPath(identity.session_id, options);
    const pending = withRuntimeLock(
      identity,
      "inspect-mode",
      async (current) => {
        expect((await fs.stat(lockPath)).mode & 0o777).toBe(0o600);
        return current!;
      },
      options,
    );
    await pending;
  });
});
