// prune slice 3 — restore a trashed session (inverse of execute's trash).
//
// Read a bucket manifest, move the feature dir + registry entry back. Safety:
//   - multiple <ts> buckets for one uuid → AMBIGUOUS unless `at` selects one.
//   - a destination that already exists → PATH_OCCUPIED, nothing moved
//     (checked before any move, so restore is all-or-nothing per session).
//   - orphan (registry-only) bucket → only the registry entry returns.

import { promises as fs } from "node:fs";
import path from "node:path";

import { moveDir, moveFile } from "./fs-move.js";

export interface RestoreOptions {
  registryDir: string;
  trashDir: string;
  /** Full session uuid (the CLI surface resolves any prefix → uuid first). */
  sessionId: string;
  /** Disambiguator when the uuid was trashed more than once. */
  at?: string;
}

export type RestoreResult =
  | { ok: true; session_id: string; feature: string; cwd: string; restored_from: string }
  | {
      ok: false;
      code:
        | "PRUNE_RESTORE_NOT_FOUND"
        | "PRUNE_RESTORE_AMBIGUOUS"
        | "PRUNE_RESTORE_INCOMPLETE"
        | "PRUNE_PATH_OCCUPIED";
      message: string;
      detail?: Record<string, unknown>;
    };

interface BucketManifest {
  feature: string;
  cwd: string;
  feature_dir: string;
  feature_trashed: boolean;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Timestamps whose bucket holds a manifest for this session. */
async function bucketsFor(trashDir: string, sessionId: string): Promise<string[]> {
  let tsDirs: string[];
  try {
    tsDirs = await fs.readdir(trashDir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const ts of tsDirs) {
    if (await pathExists(path.join(trashDir, ts, sessionId, "manifest.json"))) found.push(ts);
  }
  return found;
}

export async function restorePrune(opts: RestoreOptions): Promise<RestoreResult> {
  const { registryDir, trashDir, sessionId, at } = opts;

  const timestamps = await bucketsFor(trashDir, sessionId);
  if (timestamps.length === 0) {
    return {
      ok: false,
      code: "PRUNE_RESTORE_NOT_FOUND",
      message: `no trashed session ${sessionId} found`,
      detail: { session_id: sessionId },
    };
  }

  let chosen: string;
  if (at !== undefined) {
    if (!timestamps.includes(at)) {
      return {
        ok: false,
        code: "PRUNE_RESTORE_NOT_FOUND",
        message: `no trashed session ${sessionId} at ${at}`,
        detail: { session_id: sessionId, at, timestamps },
      };
    }
    chosen = at;
  } else if (timestamps.length > 1) {
    return {
      ok: false,
      code: "PRUNE_RESTORE_AMBIGUOUS",
      message: `session ${sessionId} was trashed ${timestamps.length} times; pass --at <ts>`,
      detail: { session_id: sessionId, timestamps },
    };
  } else {
    chosen = timestamps[0]!;
  }

  const bucket = path.join(trashDir, chosen, sessionId);
  const manifest = JSON.parse(
    await fs.readFile(path.join(bucket, "manifest.json"), "utf8"),
  ) as BucketManifest;

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
      message: `trash bucket for ${sessionId} is missing registry.json; not restoring`,
      detail: { bucket, missing: "registry.json" },
    };
  }
  if (manifest.feature_trashed && !(await pathExists(featureSrc))) {
    return {
      ok: false,
      code: "PRUNE_RESTORE_INCOMPLETE",
      message: `trash bucket for ${sessionId} claims a feature dir but feature/ is missing; not restoring`,
      detail: { bucket, missing: "feature/" },
    };
  }

  // Occupied checks BEFORE any move → all-or-nothing per session.
  if (await pathExists(registryDest)) {
    return {
      ok: false,
      code: "PRUNE_PATH_OCCUPIED",
      message: `registry entry ${sessionId} already exists; refusing to overwrite`,
      detail: { path: registryDest },
    };
  }
  if (manifest.feature_trashed && (await pathExists(manifest.feature_dir))) {
    return {
      ok: false,
      code: "PRUNE_PATH_OCCUPIED",
      message: `feature dir ${manifest.feature_dir} already exists; refusing to overwrite`,
      detail: { path: manifest.feature_dir },
    };
  }

  // Sources preflighted present above → these moves succeed.
  // Restore feature dir first (if any), then the registry entry.
  if (manifest.feature_trashed) {
    await fs.mkdir(path.dirname(manifest.feature_dir), { recursive: true });
    await moveDir(featureSrc, manifest.feature_dir);
  }
  await moveFile(registrySrc, registryDest);

  // Consume the bucket (manifest + now-empty dir).
  await fs.rm(bucket, { recursive: true, force: true });

  return {
    ok: true,
    session_id: sessionId,
    feature: manifest.feature,
    cwd: manifest.cwd,
    restored_from: bucket,
  };
}
