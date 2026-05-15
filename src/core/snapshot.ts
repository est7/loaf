// snapshot.ts — projection store + _meta.json (ADR-0005 §3.6 + §4.15).
//
// Stage 3 scope:
//   - SnapshotMeta envelope (last_applied_seq, last_entry_offset,
//     last_entry_line_hash, rolling_checksum)
//   - writeMeta() / readMeta() with atomic temp+rename
//   - computeLineHash() / extendRollingChecksum() — two-tier checksum
//
// Full per-projection writers (state.json, tasks.json, evidence.json, etc.)
// land alongside their per-kind reducer rules in Stages 2-4 incrementally.

import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";

const HEX64 = /^[a-f0-9]{64}$/;

export const SnapshotMeta = z
  .object({
    last_applied_seq: z.number().int().nonnegative(),
    last_entry_offset: z.number().int().nonnegative(),
    last_entry_line_hash: z.string().regex(HEX64),
    rolling_checksum: z.string().regex(HEX64),
  })
  .strict();
export type SnapshotMeta = z.infer<typeof SnapshotMeta>;

const ZERO_HASH = "0".repeat(64);

export function emptyMeta(): SnapshotMeta {
  return {
    last_applied_seq: -1 as unknown as number,
    last_entry_offset: 0,
    last_entry_line_hash: ZERO_HASH,
    rolling_checksum: ZERO_HASH,
  };
}

// Fast-tier hash — last entry line content only.
export function computeLineHash(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

// Full-tier rolling chain — extend the prior chain hash with this line's bytes.
// Verifier walks the journal entry-by-entry, recomputing each step; mismatch
// indicates corruption between an entry and its declared meta snapshot.
export function extendRollingChecksum(prev: string, line: string): string {
  return createHash("sha256")
    .update(prev, "hex")
    .update(line, "utf8")
    .digest("hex");
}

export async function writeMeta(metaPath: string, meta: SnapshotMeta): Promise<void> {
  const tmp = `${metaPath}.tmp-${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), { mode: 0o644 });
  await fsp.rename(tmp, metaPath);
}

export async function readMeta(metaPath: string): Promise<SnapshotMeta | null> {
  try {
    const raw = await fsp.readFile(metaPath, "utf8");
    const parsed = SnapshotMeta.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
