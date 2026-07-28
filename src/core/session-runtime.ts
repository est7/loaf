// SessionRuntimeFile storage — machine-local, rebuild-exempt state under
// `~/.loaf/runtime/<session_id>.json`.
//
// Updates use a dedicated PID-bearing runtime lock. Do not reuse the
// per-feature `.loaf/<feature>/.lock`: that owner-fenced lease spans journal
// validation through projections and uses a much longer wait budget. Making
// every PostToolUse share it would turn scope accumulation into delayed or
// dropped hook events. This runtime lock therefore keeps its own bounded wait,
// PID liveness, and stale-removal semantics.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { SessionRuntimeFile, type SessionRuntimeFile as RuntimeFile } from "./projection-schema.js";

const RuntimeLockFile = z
  .object({
    pid: z.number().int().positive(),
    acquired_at: z.string().datetime(),
    operation: z.string().min(1).max(200),
    // Optional only for locks left by the pre-owner-token implementation.
    // Every new acquisition writes an owner token.
    owner: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
  })
  .strict();
type RuntimeLockFile = z.infer<typeof RuntimeLockFile>;

export interface RuntimeIdentity {
  /** Journal-selected session identity; never infer this from a runtime file. */
  session_id: string;
  /** Selected workspace cwd; canonicalized with realpath before comparison. */
  cwd: string;
}

export interface RuntimeStoreOptions {
  /** Explicit trust boundary; production passes `defaultRuntimeDir(homeDir)`. */
  runtimeDir: string;
  /** Bounded lock wait. */
  lockTimeoutMs?: number;
  /** Delay between lock observations. */
  retryDelayMs?: number;
  /** Wall-clock injection for deterministic metadata and no ambient core reads. */
  now: () => Date;
}

export type RuntimeStoreErrorCode =
  | "RUNTIME_FILE_INVALID"
  | "RUNTIME_IDENTITY_MISMATCH"
  | "RUNTIME_LOCK_TIMEOUT"
  | "RUNTIME_LOCK_INVALID";

export class RuntimeStoreError extends Error {
  readonly code: RuntimeStoreErrorCode;
  readonly holder?: RuntimeLockFile;

  constructor(code: RuntimeStoreErrorCode, message: string, holder?: RuntimeLockFile) {
    super(message);
    this.name = "RuntimeStoreError";
    this.code = code;
    if (holder !== undefined) this.holder = holder;
  }
}

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 20;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function defaultRuntimeDir(homeDir: string): string {
  return path.join(homeDir, ".loaf", "runtime");
}

function checkedSessionId(sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new RuntimeStoreError(
      "RUNTIME_IDENTITY_MISMATCH",
      `unsafe runtime session_id ${JSON.stringify(sessionId)}`,
    );
  }
  return sessionId;
}

export function sessionRuntimeFilePath(sessionId: string, options: RuntimeStoreOptions): string {
  return path.join(options.runtimeDir, `${checkedSessionId(sessionId)}.json`);
}

export function sessionRuntimeLockPath(sessionId: string, options: RuntimeStoreOptions): string {
  return path.join(options.runtimeDir, `${checkedSessionId(sessionId)}.lock`);
}

async function canonicalIdentity(identity: RuntimeIdentity): Promise<RuntimeIdentity> {
  checkedSessionId(identity.session_id);
  let cwd: string;
  try {
    cwd = await fs.realpath(identity.cwd);
  } catch (error) {
    throw new RuntimeStoreError(
      "RUNTIME_IDENTITY_MISMATCH",
      `selected runtime cwd cannot be canonicalized: ${(error as Error).message}`,
    );
  }
  return { session_id: identity.session_id, cwd };
}

async function ensureRuntimeDir(runtimeDir: string): Promise<void> {
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await fs.chmod(runtimeDir, 0o700);
}

async function validateFileIdentity(
  file: RuntimeFile,
  identity: RuntimeIdentity,
): Promise<RuntimeFile> {
  let fileCwd: string;
  try {
    fileCwd = await fs.realpath(file.cwd);
  } catch (error) {
    throw new RuntimeStoreError(
      "RUNTIME_IDENTITY_MISMATCH",
      `runtime file cwd cannot be canonicalized: ${(error as Error).message}`,
    );
  }
  if (file.session_id !== identity.session_id || fileCwd !== identity.cwd) {
    throw new RuntimeStoreError(
      "RUNTIME_IDENTITY_MISMATCH",
      `runtime identity mismatch: selected session=${identity.session_id} cwd=${identity.cwd}, ` +
        `file session=${file.session_id} cwd=${fileCwd}; refusing to merge`,
    );
  }
  return file;
}

async function readSessionRuntimeFileUnlocked(
  identity: RuntimeIdentity,
  options: RuntimeStoreOptions,
): Promise<RuntimeFile | null> {
  const target = sessionRuntimeFilePath(identity.session_id, options);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new RuntimeStoreError(
      "RUNTIME_FILE_INVALID",
      `runtime file is not valid JSON: ${(error as Error).message}`,
    );
  }
  const parsed = SessionRuntimeFile.safeParse(decoded);
  if (!parsed.success) {
    throw new RuntimeStoreError(
      "RUNTIME_FILE_INVALID",
      `runtime file failed SessionRuntimeFile validation: ${parsed.error.message}`,
    );
  }
  return await validateFileIdentity(parsed.data, identity);
}

/** Lock-free read is safe because writers publish only through atomic rename. */
export async function readSessionRuntimeFile(
  identity: RuntimeIdentity,
  options: RuntimeStoreOptions,
): Promise<RuntimeFile | null> {
  return await readSessionRuntimeFileUnlocked(await canonicalIdentity(identity), options);
}

async function writeSessionRuntimeFileUnlocked(
  file: RuntimeFile,
  identity: RuntimeIdentity,
  options: RuntimeStoreOptions,
): Promise<void> {
  const runtimeDir = options.runtimeDir;
  await ensureRuntimeDir(runtimeDir);
  const target = sessionRuntimeFilePath(identity.session_id, options);
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(tmp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(file));
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, target);
    try {
      const directory = await fs.open(runtimeDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Directory fsync is not supported on every filesystem. The file itself
      // is synced and rename remains the atomic visibility boundary.
    }
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function readLock(lockPath: string): Promise<RuntimeLockFile | null> {
  try {
    const parsed = RuntimeLockFile.safeParse(JSON.parse(await fs.readFile(lockPath, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isSameLockGeneration(observed: RuntimeLockFile, current: RuntimeLockFile): boolean {
  return (
    observed.pid === current.pid &&
    observed.acquired_at === current.acquired_at &&
    observed.operation === current.operation &&
    observed.owner === current.owner
  );
}

async function createLock(lockPath: string, lock: RuntimeLockFile): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(lock));
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.chmod(lockPath, 0o600);
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await fs.unlink(lockPath).catch(() => undefined);
    }
    throw error;
  }
}

async function acquireRuntimeLock(
  identity: RuntimeIdentity,
  operation: string,
  options: RuntimeStoreOptions,
): Promise<() => Promise<void>> {
  const runtimeDir = options.runtimeDir;
  await ensureRuntimeDir(runtimeDir);
  const lockPath = sessionRuntimeLockPath(identity.session_id, options);
  const lock = RuntimeLockFile.parse({
    pid: process.pid,
    acquired_at: options.now().toISOString(),
    operation,
    owner: randomBytes(16).toString("hex"),
  });
  const timeoutMs = Math.max(0, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const retryDelayMs = Math.max(1, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / retryDelayMs) + 1);
  let attempts = 0;

  while (true) {
    try {
      await createLock(lockPath, lock);
      const confirmed = await readLock(lockPath);
      if (confirmed?.owner !== lock.owner) {
        // A stale recoverer may have replaced our just-created generation.
        // Never enter the critical section without re-proving ownership.
        attempts += 1;
        if (attempts >= maxAttempts) {
          throw new RuntimeStoreError(
            confirmed === null ? "RUNTIME_LOCK_INVALID" : "RUNTIME_LOCK_TIMEOUT",
            `runtime lock ownership changed before acquisition completed`,
            confirmed ?? undefined,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      return async () => {
        const current = await readLock(lockPath);
        if (current?.owner !== lock.owner) return;
        await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const holder = await readLock(lockPath);
    attempts += 1;
    if (holder !== null && !isPidAlive(holder.pid)) {
      // Compare the generation again immediately before deletion. This keeps
      // a delayed recoverer from unlinking a successor's fresh lock. The
      // post-create owner-token confirmation above is the final ownership
      // fence before any recoverer may enter the critical section.
      const current = await readLock(lockPath);
      if (current !== null && isSameLockGeneration(holder, current) && !isPidAlive(current.pid)) {
        await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      if (attempts >= maxAttempts) {
        throw new RuntimeStoreError(
          "RUNTIME_LOCK_TIMEOUT",
          `runtime lock stale recovery exceeded its bounded retry budget`,
          current ?? holder,
        );
      }
      continue;
    }
    if (attempts >= maxAttempts) {
      throw new RuntimeStoreError(
        holder === null ? "RUNTIME_LOCK_INVALID" : "RUNTIME_LOCK_TIMEOUT",
        holder === null
          ? `runtime lock ${lockPath} is malformed or incomplete; refusing stale removal`
          : `runtime lock held by live PID ${holder.pid} during ${holder.operation}`,
        holder ?? undefined,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}

export type RuntimeMutation = (current: RuntimeFile | null) => RuntimeFile | Promise<RuntimeFile>;

/**
 * The only read-modify-write API: acquire → validated read → mutate → atomic
 * write → unlock. Identity comes from the already journal-selected session;
 * malformed/mismatched files fail closed and are never silently merged or
 * replaced. An explicit future quarantine flow must present that identity.
 */
export async function withRuntimeLock(
  identityInput: RuntimeIdentity,
  operation: string,
  mutate: RuntimeMutation,
  options: RuntimeStoreOptions,
): Promise<RuntimeFile> {
  const identity = await canonicalIdentity(identityInput);
  const release = await acquireRuntimeLock(identity, operation, options);
  try {
    const current = await readSessionRuntimeFileUnlocked(identity, options);
    const candidate = SessionRuntimeFile.parse(await mutate(current));
    const valid = await validateFileIdentity(candidate, identity);
    const canonical: RuntimeFile = { ...valid, cwd: identity.cwd };
    await writeSessionRuntimeFileUnlocked(canonical, identity, options);
    return canonical;
  } finally {
    await release();
  }
}

/** Whole-file replacement still takes the runtime lock; no lock-free writer exists. */
export async function writeSessionRuntimeFile(
  identity: RuntimeIdentity,
  file: RuntimeFile,
  options: RuntimeStoreOptions,
): Promise<void> {
  await withRuntimeLock(identity, "write", () => file, options);
}
