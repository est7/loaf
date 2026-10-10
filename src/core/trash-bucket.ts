// Trash bucket owner: persistent layout, manifest representation and transfers.
// The caller owns target selection, purge, batch outcomes, audit and retention.
// Manifest validation precedes effects; failed paired transfers compensate.
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Diagnostic } from "./error-catalog.js";

export interface TrashSession {
  session_id: string;
  feature: string;
  cwd: string;
  feature_dir: string;
  orphan: boolean;
}

export function trashDirectory(registryDir: string): string {
  return path.join(path.dirname(registryDir), "trash");
}

export function trashTimestampPath(trashDir: string, timestamp: string): string {
  return path.join(trashDir, timestamp);
}

function trashBucketPath(trashDir: string, timestamp: string, sessionId: string): string {
  return path.join(trashTimestampPath(trashDir, timestamp), sessionId);
}

/** Trash one selected session; manifest first, feature before registry. */
export async function trashSession(opts: {
  registryDir: string;
  trashDir: string;
  timestamp: string;
  session: TrashSession;
}): Promise<string> {
  const { registryDir, trashDir, timestamp, session: t } = opts;
  const registryEntryPath = path.join(registryDir, `${t.session_id}.json`);
  const bucket = trashBucketPath(trashDir, timestamp, t.session_id);
  await fs.mkdir(bucket, { recursive: true });
  const manifestPath = path.join(bucket, "manifest.json");
  const writeManifest = (featureTrashed: boolean): Promise<void> =>
    fs.writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          session_id: t.session_id,
          feature: t.feature,
          cwd: t.cwd,
          feature_dir: t.feature_dir,
          orphan: t.orphan,
          feature_trashed: featureTrashed,
          at: timestamp,
        },
        null,
        2,
      )}\n`,
    );

  // Manifest FIRST — BEFORE any move (codex prune-core BLOCK 1). If the
  // manifest write fails, nothing has moved yet, so no data is stranded in
  // an unrecoverable (manifest-less) bucket. Provisional feature_trashed
  // reflects intent; corrected below if the feature dir vanished.
  await writeManifest(!t.orphan);

  // M5: feature dir before registry deregister.
  let featureMoved = false;
  if (!t.orphan) {
    featureMoved = await moveDir(t.feature_dir, path.join(bucket, "feature"));
    if (!featureMoved) await writeManifest(false); // TOCTOU: dir gone since resolve
  }
  try {
    await moveFile(registryEntryPath, path.join(bucket, "registry.json"));
  } catch (regErr) {
    // Deregister failed AFTER the feature moved → ROLL THE FEATURE BACK so
    // the session stays whole; never strand feature data in a bucket the
    // registry entry no longer points into (codex prune-core BLOCK 3). The
    // A cross-device registry failure may leave two copies; retain both.
    // Otherwise successful compensation restores pre-prune artifact placement.
    if (featureMoved) {
      try {
        if (!(await moveDir(path.join(bucket, "feature"), t.feature_dir)))
          throw missingMoveSource(path.join(bucket, "feature"));
      } catch (rollbackErr) {
        // DOUBLE FAULT (codex prune-core BLOCK 4): the rollback ALSO failed,
        // so the remaining feature copies must stay available for recovery.
        // PRESERVE the bucket (never rm it here) and surface both errors +
        // the retained path. Invariant: either the feature is back at
        // origin, OR the trash bucket remains recoverable — never neither.
        throw new AggregateError(
          [regErr, rollbackErr],
          `registry deregister failed (${(regErr as Error).message}); ` +
            `feature rollback also failed (${(rollbackErr as Error).message}); ` +
            `feature data retained in ${bucket} (registry entry still at origin) — ` +
            `recover manually: move ${path.join(bucket, "feature")} back to ${t.feature_dir}; ` +
            `registry locations: ${registryEntryPath}, ${path.join(bucket, "registry.json")}`,
          { cause: regErr },
        );
      }
    }
    // A copied/partially copied registry is recovery data; never remove it.
    if (!(regErr instanceof CopyMoveError))
      await fs.rm(bucket, { recursive: true, force: true }).catch(() => undefined);
    throw regErr; // → outer catch → `failed`, session intact
  }
  return bucket;
}

export interface RestoreTrashOptions {
  registryDir: string;
  trashDir: string;
  /** Full session uuid (the CLI surface resolves any prefix → uuid first). */
  sessionId: string;
  /** Disambiguator when the uuid was trashed more than once. */
  at?: string;
  /** Preview: run all validation (NOT_FOUND / AMBIGUOUS / INCOMPLETE /
   *  PATH_OCCUPIED) but DO NOT move anything (honors the global --dry-run;
   *  restore is destructive/stateful, so dry-run must not persist state). */
  dryRun?: boolean;
}

export type RestoreTrashResult =
  | { ok: true; session_id: string; feature: string; cwd: string; restored_from: string }
  | ({ ok: false } & Diagnostic<
      | "PRUNE_RESTORE_NOT_FOUND"
      | "PRUNE_RESTORE_AMBIGUOUS"
      | "PRUNE_RESTORE_INCOMPLETE"
      | "PRUNE_PATH_OCCUPIED"
    >);

const BucketManifestSchema = z.looseObject({
  feature: z.string().min(1),
  cwd: z.string().min(1),
  feature_dir: z.string().min(1),
  feature_trashed: z.boolean(),
});
type BucketManifest = z.infer<typeof BucketManifestSchema>;
type RestoreFailure = Extract<RestoreTrashResult, { ok: false }>;

async function readBucketManifest(
  bucket: string,
): Promise<{ ok: true; manifest: BucketManifest } | RestoreFailure> {
  const manifestPath = path.join(bucket, "manifest.json");
  const raw = await fs.readFile(manifestPath, "utf8"); // IO causes propagate unchanged.
  const invalid = (cause: string): RestoreFailure => ({
    ok: false,
    code: "PRUNE_RESTORE_INCOMPLETE",
    detail: { bucket, missing: "manifest.json", path: manifestPath, cause },
  });
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return invalid(error.message);
    throw error;
  }
  const parsed = BucketManifestSchema.safeParse(value);
  if (!parsed.success) return invalid(parsed.error.message);
  return { ok: true, manifest: parsed.data };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Timestamps whose bucket holds a manifest for this session. */
async function bucketsFor(trashDir: string, sessionId: string): Promise<string[]> {
  let tsDirs: string[];
  try {
    tsDirs = await fs.readdir(trashDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found: string[] = [];
  for (const ts of tsDirs) {
    if (await pathExists(path.join(trashBucketPath(trashDir, ts, sessionId), "manifest.json")))
      found.push(ts);
  }
  return found;
}

export async function restoreTrashBucket(opts: RestoreTrashOptions): Promise<RestoreTrashResult> {
  const { registryDir, trashDir, sessionId, at } = opts;

  const timestamps = await bucketsFor(trashDir, sessionId);
  if (timestamps.length === 0) {
    return {
      ok: false,
      code: "PRUNE_RESTORE_NOT_FOUND",

      detail: { session_id: sessionId },
    };
  }

  let chosen: string;
  if (at !== undefined) {
    if (!timestamps.includes(at)) {
      return {
        ok: false,
        code: "PRUNE_RESTORE_NOT_FOUND",

        detail: { session_id: sessionId, at, timestamps },
      };
    }
    chosen = at;
  } else if (timestamps.length > 1) {
    return {
      ok: false,
      code: "PRUNE_RESTORE_AMBIGUOUS",

      detail: { session_id: sessionId, timestamps },
    };
  } else {
    chosen = timestamps[0]!;
  }

  const bucket = trashBucketPath(trashDir, chosen, sessionId);
  const read = await readBucketManifest(bucket);
  if (!read.ok) return read;
  const manifest = read.manifest;

  const registryDest = path.join(registryDir, `${sessionId}.json`);
  const registrySrc = path.join(bucket, "registry.json");
  const featureSrc = path.join(bucket, "feature");

  // SOURCE preflight (codex prune-core BLOCK 2) — never START a restore that
  // cannot complete. A bucket missing a required artifact is INCOMPLETE; we move
  // nothing and keep the bucket, rather than half-applying or (worse) reporting
  // success with the feature data silently absent.
  if (!(await pathExists(registrySrc))) {
    return {
      ok: false,
      code: "PRUNE_RESTORE_INCOMPLETE",

      detail: { bucket, missing: "registry.json" },
    };
  }
  if (manifest.feature_trashed && !(await pathExists(featureSrc))) {
    return {
      ok: false,
      code: "PRUNE_RESTORE_INCOMPLETE",

      detail: { bucket, missing: "feature/" },
    };
  }

  // Occupied checks BEFORE any move → all-or-nothing per session.
  if (await pathExists(registryDest)) {
    return {
      ok: false,
      code: "PRUNE_PATH_OCCUPIED",

      detail: { path: registryDest },
    };
  }
  if (manifest.feature_trashed && (await pathExists(manifest.feature_dir))) {
    return {
      ok: false,
      code: "PRUNE_PATH_OCCUPIED",

      detail: { path: manifest.feature_dir },
    };
  }

  // Preview (--dry-run): all validation above has passed; report what WOULD be
  // restored WITHOUT moving anything (codex 6b BLOCK — restore is stateful, so
  // dry-run must not persist state).
  if (!opts.dryRun) {
    let featureMoved = false;
    if (manifest.feature_trashed) {
      await fs.mkdir(path.dirname(manifest.feature_dir), { recursive: true });
      featureMoved = await moveDir(featureSrc, manifest.feature_dir);
      if (!featureMoved)
        return {
          ok: false,
          code: "PRUNE_RESTORE_INCOMPLETE",
          detail: { bucket, missing: "feature/" },
        };
    }
    try {
      await moveFile(registrySrc, registryDest);
    } catch (registryError) {
      if (featureMoved) {
        try {
          if (!(await moveDir(manifest.feature_dir, featureSrc)))
            throw missingMoveSource(manifest.feature_dir);
        } catch (rollbackError) {
          throw new AggregateError(
            [registryError, rollbackError],
            `registry restore failed (${errorMessage(registryError)}); ` +
              `feature rollback also failed (${errorMessage(rollbackError)}); ` +
              `feature locations: ${manifest.feature_dir}, ${featureSrc}; ` +
              `registry locations: ${registrySrc}, ${registryDest}; ` +
              `manifest retained at ${path.join(bucket, "manifest.json")}`,
            { cause: registryError },
          );
        }
      }
      throw registryError;
    }
    // The pair is restored. Cleanup failure cannot safely undo partial deletion.
    try {
      await fs.rm(bucket, { recursive: true, force: true });
    } catch (error) {
      throw new Error(
        `bucket cleanup failed (${errorMessage(error)}); artifacts restored; remaining bucket: ${bucket}`,
        { cause: error },
      );
    }
  }

  return {
    ok: true,
    session_id: sessionId,
    feature: manifest.feature,
    cwd: manifest.cwd,
    restored_from: bucket,
  };
}

class CopyMoveError extends Error {
  constructor(kind: string, source: string, destination: string, cause: unknown) {
    super(
      `${kind} transfer failed (${errorMessage(cause)}); inspect retained copies at ${source} and ${destination}`,
      { cause },
    );
    this.name = "CopyMoveError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missingMoveSource(source: string): Error {
  return Object.assign(new Error(`transfer source disappeared: ${source}`), { code: "ENOENT" });
}

/**
 * Rename a directory; copy+rm across devices. Returns false (not an error) when
 * the source is already gone (ENOENT) so callers can degrade gracefully.
 */
async function moveDir(src: string, dest: string): Promise<boolean> {
  try {
    await fs.rename(src, dest);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (await pathExists(src)) throw err; // Missing destination is not a missing source.
      return false;
    }
    if (code === "EXDEV") {
      try {
        await fs.cp(src, dest, { recursive: true });
        await fs.rm(src, { recursive: true, force: true });
      } catch (error) {
        throw new CopyMoveError("directory", src, dest, error);
      }
      return true;
    }
    throw err;
  }
}

/** Rename a file; copy+unlink across devices. */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      try {
        await fs.copyFile(src, dest);
        await fs.rm(src, { force: true });
      } catch (error) {
        throw new CopyMoveError("registry", src, dest, error);
      }
    } else {
      throw err;
    }
  }
}

/** ISO 8601 with `:` → `-` (e.g. 2026-06-09T12-34-56.789Z). Path-segment safe. */
export function toTrashTs(d: Date): string {
  return d.toISOString().replace(/:/g, "-");
}

/**
 * Reverse `toTrashTs`. Only the HH-MM-SS dashes in the time part are turned back
 * into colons (the date part keeps its dashes; the `.sssZ` millis has no dash).
 * Returns null for anything that does not parse — callers must not GC a bucket
 * they cannot date.
 */
export function fromTrashTs(name: string): Date | null {
  const tIdx = name.indexOf("T");
  if (tIdx < 0) return null;
  const datePart = name.slice(0, tIdx);
  const timePart = name.slice(tIdx + 1).replace(/-/g, ":");
  const ms = Date.parse(`${datePart}T${timePart}`);
  return Number.isNaN(ms) ? null : new Date(ms);
}
