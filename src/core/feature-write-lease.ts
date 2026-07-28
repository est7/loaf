// Owner-fenced, bounded-wait lease for canonical per-feature writes.
//
// This is intentionally separate from the high-frequency session runtime
// lock. A feature lease spans journal validation through derived projection
// publication; the runtime lock protects machine-local hook accumulation.

import { randomBytes } from "node:crypto";
import { promises as fs, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

const FeatureLeaseFile = z
  .object({
    pid: z.number().int().positive(),
    acquired_at: z.string().datetime(),
    operation: z.string().min(1).max(200),
    owner: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();
export type FeatureLeaseFile = z.infer<typeof FeatureLeaseFile>;

export interface FeatureWriteLeaseOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  legacyLockStaleMs?: number;
  now?: () => Date;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  sleep?: (delayMs: number) => Promise<void>;
  fsync?: boolean;
}

export interface FeatureWriteLease {
  readonly path: string;
  readonly owner: string;
  readonly metadata: FeatureLeaseFile;
  release(): Promise<void>;
}

export const FEATURE_WRITE_LEASE_ERROR_CODES = ["LOCK_TIMEOUT", "LOCK_INVALID"] as const;
export type FeatureWriteLeaseErrorCode = (typeof FEATURE_WRITE_LEASE_ERROR_CODES)[number];
export const FEATURE_WRITE_LEASE_MECHANISM =
  "O_EXCL sentinel with strict owner token and generation-checked recovery";

export class FeatureWriteLeaseError extends Error {
  constructor(
    readonly code: FeatureWriteLeaseErrorCode,
    message: string,
    readonly lockPath: string,
    readonly holder?: FeatureLeaseFile,
  ) {
    super(message);
    this.name = "FeatureWriteLeaseError";
  }
}

type LeaseObservation =
  | { kind: "missing" }
  | { kind: "valid"; raw: string; metadata: FeatureLeaseFile; identity: FileIdentity }
  | { kind: "legacy-empty"; raw: string; identity: FileIdentity }
  | { kind: "invalid"; raw: string; identity: FileIdentity };

interface FileIdentity {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}

export const DEFAULT_FEATURE_WRITE_LEASE_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 20;
const DEFAULT_LEGACY_STALE_MS = 30_000;
const activeOwners = new Map<string, string>();

function defaultIsPidAlive(pid: number): boolean {
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

async function observe(lockPath: string): Promise<LeaseObservation> {
  let before: Awaited<ReturnType<typeof fs.stat>>;
  let raw: string;
  let after: Awaited<ReturnType<typeof fs.stat>>;
  try {
    before = await fs.stat(lockPath);
    raw = await fs.readFile(lockPath, "utf8");
    after = await fs.stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.size !== after.size
  ) {
    return await observe(lockPath);
  }
  const identity: FileIdentity = {
    dev: after.dev,
    ino: after.ino,
    mtimeMs: after.mtimeMs,
    size: after.size,
  };
  if (raw.length === 0) {
    return { kind: "legacy-empty", raw, identity };
  }
  try {
    const parsed = FeatureLeaseFile.safeParse(JSON.parse(raw));
    return parsed.success
      ? { kind: "valid", raw, metadata: parsed.data, identity }
      : { kind: "invalid", raw, identity };
  } catch {
    return { kind: "invalid", raw, identity };
  }
}

async function createLease(
  lockPath: string,
  metadata: FeatureLeaseFile,
  fsync: boolean,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let created = false;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
    created = true;
    await handle.writeFile(JSON.stringify(metadata));
    if (fsync) await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.chmod(lockPath, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await fs.unlink(lockPath).catch(() => {});
    throw error;
  }
}

async function unlinkIfUnchanged(
  lockPath: string,
  observed: Exclude<LeaseObservation, { kind: "missing" }>,
): Promise<boolean> {
  const current = await observe(lockPath);
  if (
    (current.kind === "valid" || current.kind === "legacy-empty" || current.kind === "invalid") &&
    current.raw === observed.raw &&
    current.identity.dev === observed.identity.dev &&
    current.identity.ino === observed.identity.ino &&
    current.identity.mtimeMs === observed.identity.mtimeMs &&
    current.identity.size === observed.identity.size
  ) {
    await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return true;
  }
  return false;
}

export async function acquireFeatureWriteLease(
  featureDir: string,
  operation: string,
  options: FeatureWriteLeaseOptions = {},
): Promise<FeatureWriteLease> {
  const lockPath = path.join(featureDir, ".lock");
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const sleep =
    options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const retryDelayMs = Math.max(1, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_FEATURE_WRITE_LEASE_TIMEOUT_MS);
  const legacyLockStaleMs = Math.max(0, options.legacyLockStaleMs ?? DEFAULT_LEGACY_STALE_MS);
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / retryDelayMs) + 1);
  const metadata = FeatureLeaseFile.parse({
    pid,
    acquired_at: now().toISOString(),
    operation,
    owner: randomBytes(16).toString("hex"),
  });
  let attempts = 0;
  let lastHolder: FeatureLeaseFile | undefined;

  while (attempts < maxAttempts) {
    try {
      await createLease(lockPath, metadata, options.fsync ?? true);
      const confirmed = await observe(lockPath);
      if (confirmed.kind === "valid" && confirmed.metadata.owner === metadata.owner) {
        activeOwners.set(lockPath, metadata.owner);
        let released = false;
        return {
          path: lockPath,
          owner: metadata.owner,
          metadata,
          release: async () => {
            if (released) return;
            released = true;
            activeOwners.delete(lockPath);
            const current = await observe(lockPath);
            if (current.kind !== "valid" || current.metadata.owner !== metadata.owner) return;
            await unlinkIfUnchanged(lockPath, current);
          },
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const observed = await observe(lockPath);
    attempts += 1;
    if (observed.kind === "invalid") {
      throw new FeatureWriteLeaseError(
        "LOCK_INVALID",
        `feature write lease ${lockPath} is malformed or incomplete; refusing recovery`,
        lockPath,
      );
    }
    if (observed.kind === "valid") {
      lastHolder = observed.metadata;
      if (!isPidAlive(observed.metadata.pid)) {
        const current = await observe(lockPath);
        if (
          current.kind === "valid" &&
          current.raw === observed.raw &&
          !isPidAlive(current.metadata.pid)
        ) {
          await unlinkIfUnchanged(lockPath, observed);
          continue;
        }
      }
    } else if (
      observed.kind === "legacy-empty" &&
      now().getTime() - observed.identity.mtimeMs >= legacyLockStaleMs
    ) {
      await unlinkIfUnchanged(lockPath, observed);
      continue;
    }

    if (attempts < maxAttempts) await sleep(retryDelayMs);
  }

  throw new FeatureWriteLeaseError(
    "LOCK_TIMEOUT",
    lastHolder
      ? `feature write lease held by live PID ${lastHolder.pid} during ${lastHolder.operation}`
      : `could not acquire feature write lease ${lockPath} within ${timeoutMs}ms`,
    lockPath,
    lastHolder,
  );
}

export async function withFeatureWriteLease<T>(
  featureDir: string,
  operation: string,
  fn: (lease: FeatureWriteLease) => Promise<T>,
  options: FeatureWriteLeaseOptions = {},
): Promise<T> {
  const lease = await acquireFeatureWriteLease(featureDir, operation, options);
  try {
    return await fn(lease);
  } finally {
    await lease.release();
  }
}

/**
 * The CLI's first SIGINT exits synchronously, so async `finally` blocks cannot
 * run. This hook performs a best-effort owner-token check before unlinking
 * leases held by this process. Foreign successor generations are preserved.
 */
export function releaseFeatureWriteLeasesForSignalSync(): void {
  for (const [lockPath, owner] of activeOwners) {
    try {
      const parsed = FeatureLeaseFile.safeParse(JSON.parse(readFileSync(lockPath, "utf8")));
      if (parsed.success && parsed.data.owner === owner) unlinkSync(lockPath);
    } catch {
      // Signal cleanup is best effort. Malformed, missing, or foreign locks
      // remain for the next bounded stale-recovery pass.
    } finally {
      activeOwners.delete(lockPath);
    }
  }
}
