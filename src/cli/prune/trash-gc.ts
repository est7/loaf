// prune slice 5 — trash retention sweep (M1).
//
// Recoverable trash without a retention sweep just relocates the unbounded
// growth prune was built to fix. `gcTrash` removes trash buckets whose
// timestamp is strictly older than `olderThanDays`. `now` is injected (no Date
// here). Unparseable bucket names are KEPT — never GC something we can't date.

import { promises as fs } from "node:fs";
import path from "node:path";

import { fromTrashTs } from "./trash-ts.js";

const DAY_MS = 86_400_000;

export interface TrashGcOptions {
  trashDir: string;
  olderThanDays: number;
  now: Date;
  /** When true, classify but do NOT remove (preview). `removed` lists what WOULD go. */
  dryRun?: boolean;
}

export interface TrashGcResult {
  removed: { ts: string; path: string }[];
  kept: { ts: string }[];
}

export async function gcTrash(opts: TrashGcOptions): Promise<TrashGcResult> {
  const { trashDir, olderThanDays, now, dryRun } = opts;
  const cutoff = now.getTime() - olderThanDays * DAY_MS;

  let entries: string[];
  try {
    entries = await fs.readdir(trashDir);
  } catch {
    return { removed: [], kept: [] }; // no trash dir ⇒ nothing to sweep
  }

  const removed: { ts: string; path: string }[] = [];
  const kept: { ts: string }[] = [];

  for (const ts of entries) {
    const when = fromTrashTs(ts);
    if (when === null) {
      kept.push({ ts }); // undatable → keep (never blind-delete)
      continue;
    }
    if (when.getTime() < cutoff) {
      const p = path.join(trashDir, ts);
      if (!dryRun) await fs.rm(p, { recursive: true, force: true });
      removed.push({ ts, path: p });
    } else {
      kept.push({ ts });
    }
  }

  return { removed, kept };
}
