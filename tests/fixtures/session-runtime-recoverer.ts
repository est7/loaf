import { promises as fs } from "node:fs";
import path from "node:path";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

const role = requiredEnv("LOAF_TEST_RECOVERER_ROLE");
const runtimeDir = requiredEnv("LOAF_TEST_RUNTIME_DIR");
const cwd = requiredEnv("LOAF_TEST_CWD");
const sessionId = requiredEnv("LOAF_TEST_SESSION_ID");
const stalePid = Number(requiredEnv("LOAF_TEST_STALE_PID"));
const barrierDir = requiredEnv("LOAF_TEST_BARRIER_DIR");
const scopePath = requiredEnv("LOAF_TEST_SCOPE_PATH");
const lockPath = path.join(runtimeDir, `${sessionId}.lock`);

const mutableFs = fs as unknown as {
  readFile: (...args: unknown[]) => Promise<unknown>;
};
const originalReadFile = mutableFs.readFile.bind(fs);
let interceptedStaleRead = false;

// Capture the same stale generation in both processes. Recoverer B delays
// returning its captured bytes until A has installed a new lock generation.
// That deterministically exercises compare-before-delete rather than relying
// on scheduler luck.
mutableFs.readFile = async (...args: unknown[]): Promise<unknown> => {
  const result = await originalReadFile(...args);
  if (!interceptedStaleRead && String(args[0]) === lockPath) {
    interceptedStaleRead = true;
    await fs.writeFile(path.join(barrierDir, `${role}.read`), "ready");
    if (role === "A") {
      while (true) {
        try {
          await fs.access(path.join(barrierDir, "B.read"));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
    } else {
      while (true) {
        try {
          const current = JSON.parse(String(await originalReadFile(lockPath, "utf8"))) as {
            pid?: number;
          };
          if (current.pid !== stalePid) break;
        } catch {
          // A may be between stale unlink and fresh exclusive create.
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
  }
  return result;
};

const { withRuntimeLock } = await import("../../src/core/session-runtime.js");

await withRuntimeLock(
  { session_id: sessionId, cwd },
  `cross-process-${role}`,
  async (current) => {
    if (current === null) throw new Error("runtime file missing");
    await new Promise((resolve) => setTimeout(resolve, role === "A" ? 150 : 10));
    const paths = new Set(current.pending_scope?.paths ?? []);
    paths.add(scopePath);
    return {
      ...current,
      pending_scope: { iteration: 1, paths: [...paths].sort() },
    };
  },
  {
    runtimeDir,
    lockTimeoutMs: 5_000,
    retryDelayMs: 2,
    now: () => new Date("2026-07-20T10:00:00.000Z"),
  },
);
