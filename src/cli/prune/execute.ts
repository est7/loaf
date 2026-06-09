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

import { moveDir, moveFile } from "./fs-move.js";
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
          // registry entry was never moved, so rolling the feature back restores
          // the pre-prune state.
          if (featureMoved) {
            try {
              await moveDir(path.join(bucket, "feature"), t.feature_dir);
            } catch (rollbackErr) {
              // DOUBLE FAULT (codex prune-core BLOCK 4): the rollback ALSO failed,
              // so `bucket/feature` is now the ONLY copy of the feature data.
              // PRESERVE the bucket (never rm it here) and surface both errors +
              // the retained path. Invariant: either the feature is back at
              // origin, OR the trash bucket remains recoverable — never neither.
              failed.push({
                session_id: t.session_id,
                error:
                  `registry deregister failed (${(regErr as Error).message}); ` +
                  `feature rollback also failed (${(rollbackErr as Error).message}); ` +
                  // Honest recovery path (codex prune-core BLOCK 5/6): point ONLY
                  // at the manual move that actually works. `loaf prune restore`
                  // returns PRUNE_RESTORE_INCOMPLETE for this state (bucket has no
                  // registry.json; registry entry is still at origin), and bare
                  // `loaf doctor` is DOCTOR_MODE_NOT_IMPLEMENTED this release — so
                  // claim neither. A command-based recovery is a later-slice item.
                  `feature data retained in ${bucket} (registry entry still at origin) — ` +
                  `recover manually: move ${path.join(bucket, "feature")} back to ${t.feature_dir}`,
              });
              continue; // bucket preserved; do NOT remove it
            }
          }
          // Rollback succeeded (or nothing was moved) → the bucket is now empty.
          await fs.rm(bucket, { recursive: true, force: true }).catch(() => undefined);
          throw regErr; // → outer catch → `failed`, session intact
        }

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
