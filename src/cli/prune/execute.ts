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

import { trashSession } from "../../core/trash-bucket.js";
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
        const bucket = await trashSession({ registryDir, trashDir, timestamp, session: t });

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
