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
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";

const HEX64 = /^[a-f0-9]{64}$/;

// FEATURE_SCHEMA_VERSION — feature-level schema version per
// docs/adr/0005-truth-model-single-typed-journal.md §3.2 / §4.17.
// Bumps require an ADR; v0.1.0 GA pins this at 2 (post-rev-5.0 SCHEMA_VERSION bump).
export const FEATURE_SCHEMA_VERSION = 2;

// Sentinel value for `last_applied_seq` when the journal is empty / absent.
// Real entries start at seq=0; the sentinel must be < 0 so the contract
// "next seq = last_applied_seq + 1" yields 0 for the first append.
export const EMPTY_LAST_APPLIED_SEQ = -1;

export const SnapshotMeta = z
  .object({
    // -1 sentinel allowed (empty journal). All real entries are nonneg.
    last_applied_seq: z.number().int().gte(EMPTY_LAST_APPLIED_SEQ),
    last_entry_offset: z.number().int().nonnegative(),
    last_entry_line_hash: z.string().regex(HEX64),
    rolling_checksum: z.string().regex(HEX64),
    feature_schema_version: z.number().int().positive(),
    written_at: z.string().datetime(),
  })
  .strict();
export type SnapshotMeta = z.infer<typeof SnapshotMeta>;

const ZERO_HASH = "0".repeat(64);

export function emptyMeta(): SnapshotMeta {
  return {
    last_applied_seq: EMPTY_LAST_APPLIED_SEQ,
    last_entry_offset: 0,
    last_entry_line_hash: ZERO_HASH,
    rolling_checksum: ZERO_HASH,
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    written_at: new Date(0).toISOString(),
  };
}

/**
 * True iff `meta` is the empty-journal sentinel — every structural field
 * equals `emptyMeta()` (`written_at`, a free timestamp, is ignored).
 *
 * `appendMany` / `mutateBatch` require this when the journal tail is empty
 * (seq -1): a fresh-prefix prior meta carrying a non-empty `rolling_checksum`
 * or `last_entry_offset` would be folded into a post-append meta that no
 * longer matches `replayJournal` (codex r171 BLOCK 2).
 */
export function isEmptyMeta(meta: SnapshotMeta): boolean {
  const e = emptyMeta();
  return (
    meta.last_applied_seq === e.last_applied_seq &&
    meta.last_entry_offset === e.last_entry_offset &&
    meta.last_entry_line_hash === e.last_entry_line_hash &&
    meta.rolling_checksum === e.rolling_checksum &&
    meta.feature_schema_version === e.feature_schema_version
  );
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

export async function writeMeta(
  metaPath: string,
  meta: SnapshotMeta,
  fsync = true,
): Promise<void> {
  // Audit r1 fix #12: crypto.randomBytes for tmp suffix, fsync file + parent
  // dir per §11.2 atomic-rename semantics. (Math.random was predictable +
  // parent-dir fsync was missing, violating durability on power loss.)
  // `fsync` defaults true (doctor --rebuild); `mutateBatch` step 8 threads
  // `ctx.fsync`, so the `fsync:false` test path keeps the atomic tmp+rename
  // but skips the syncs.
  const tmp = `${metaPath}.tmp-${randomBytes(6).toString("hex")}`;
  const body = JSON.stringify(meta, null, 2);
  await fsp.writeFile(tmp, body, { mode: 0o644 });
  // fsync the file
  if (fsync) {
    const fh = await fsp.open(tmp, "r+");
    try { await fh.sync(); } finally { await fh.close(); }
  }
  await fsp.rename(tmp, metaPath);
  // fsync the parent directory so the rename is durable.
  if (fsync) {
    const dir = path.dirname(metaPath);
    try {
      const dh = await fsp.open(dir, "r");
      try { await dh.sync(); } finally { await dh.close(); }
    } catch {
      // Some filesystems (e.g. tmpfs) don't permit dir fsync; best-effort only.
    }
  }
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
