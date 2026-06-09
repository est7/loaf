// prune slice 2 — execute resolved targets (pure core; no ctx / no formatting).
//
// trash (default, recoverable): move the feature dir + registry entry into
//   <trashDir>/<timestamp>/<session_id>/ with a manifest so restore (slice 3)
//   can put it back. purge (--purge): hard rm, irreversible.
//
// Ordering (M5): feature dir is trashed/removed BEFORE the registry entry is
// deregistered — a crash mid-op then leaves a recoverable orphan registry entry
// (cleanable by `--orphans`), never a dangling live dir. The manifest is written
// first so the bucket is self-describing even on partial failure.
//
// No `Date` here — the timestamp (trash bucket key) is injected by the caller.

import { promises as fs } from "node:fs";
import path from "node:path";

import type { PruneTarget } from "./resolve.js";

export type PruneMode = "trash" | "purge";

export interface ExecuteOptions {
  registryDir: string;
  trashDir: string;
  targets: readonly PruneTarget[];
  mode: PruneMode;
  /** ISO-ish timestamp (filesystem-safe) used as the trash bucket key. */
  timestamp: string;
}

export interface PruneOutcome {
  session_id: string;
  feature: string;
  cwd: string;
  mode: PruneMode;
  orphan: boolean;
  /** Trash bucket dir (trash mode only). */
  trash_path?: string;
}

export interface PruneFailure {
  session_id: string;
  error: string;
}

export interface ExecuteResult {
  done: PruneOutcome[];
  failed: PruneFailure[];
}

/** Rename a dir; fall back to copy+rm across devices; report ENOENT as "gone". */
async function moveDir(src: string, dest: string): Promise<boolean> {
  try {
    await fs.rename(src, dest);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false; // vanished between resolve and execute (TOCTOU)
    if (code === "EXDEV") {
      await fs.cp(src, dest, { recursive: true });
      await fs.rm(src, { recursive: true, force: true });
      return true;
    }
    throw err;
  }
}

/** Rename a file; fall back to copy+unlink across devices. */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await fs.copyFile(src, dest);
      await fs.rm(src, { force: true });
    } else {
      throw err;
    }
  }
}

export async function executePrune(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { registryDir, trashDir, targets, mode, timestamp } = opts;
  const done: PruneOutcome[] = [];
  const failed: PruneFailure[] = [];

  for (const t of targets) {
    const registryEntryPath = path.join(registryDir, `${t.session_id}.json`);
    try {
      if (mode === "trash") {
        const bucket = path.join(trashDir, timestamp, t.session_id);
        await fs.mkdir(bucket, { recursive: true });

        // manifest first → bucket is self-describing even on a partial failure.
        let featureTrashed = false;
        // M5: feature dir before registry deregister.
        if (!t.orphan) {
          featureTrashed = await moveDir(t.feature_dir, path.join(bucket, "feature"));
        }
        await fs.writeFile(
          path.join(bucket, "manifest.json"),
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
        await moveFile(registryEntryPath, path.join(bucket, "registry.json"));

        done.push({
          session_id: t.session_id,
          feature: t.feature,
          cwd: t.cwd,
          mode: "trash",
          orphan: t.orphan,
          trash_path: bucket,
        });
      } else {
        // purge — hard rm, feature dir before registry entry (M5).
        if (!t.orphan) await fs.rm(t.feature_dir, { recursive: true, force: true });
        await fs.rm(registryEntryPath, { force: true });
        done.push({
          session_id: t.session_id,
          feature: t.feature,
          cwd: t.cwd,
          mode: "purge",
          orphan: t.orphan,
        });
      }
    } catch (err) {
      failed.push({ session_id: t.session_id, error: (err as Error).message });
    }
  }

  return { done, failed };
}
