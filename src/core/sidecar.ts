// sidecar.ts — §11.2 step 4 (sidecar finalize) + orphan GC.
//
// LongTextField promotion pipeline:
//   1. Caller builds an entry whose payload may contain LongTextField inline
//      (`{ mode: "inline", text }`) fields that may exceed 8KB.
//   2. `promoteSidecars(entry, attachmentRoot)` walks the payload, writes any
//      oversize text to `attachments/<entry_id>/<field>.<ext>.tmp-<rand>`,
//      fsyncs, atomic-renames to final path, computes sha256 + size, and
//      replaces the inline form with sidecar form
//      (`{ mode: "sidecar", ref: AttachmentRef }`).
//   3. Caller hands the promoted entry to `appendEntry` (step 5 final validate
//      then step 6 append).
//
// Orphan GC (§4.13 doctor startup + step 9 post-rebuild):
//   - `listOrphanSidecars(root, liveEntryIds)` — returns directories under
//     `attachments/` whose `<entry_id>` is not in liveEntryIds, plus any
//     `.tmp-*` artifacts. Caller (doctor) may then delete them.
//
// Stage 4 scope: pipeline + orphan scan as data; the actual integration with
// journal-append's 10-step transaction is exercised by tests through
// `promoteSidecars` → `appendEntry` chain.

import { promises as fsp } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import {
  AttachmentRef,
  LongTextField,
  SIDECAR_THRESHOLD_BYTES,
  type JournalEntry,
} from "./journal-entry.js";

const ATTACHMENTS_SUBDIR = "attachments";

export interface PromoteOptions {
  /** Override threshold for tests; defaults to SIDECAR_THRESHOLD_BYTES (8KB). */
  threshold_bytes?: number;
  fsync?: boolean;
}

/**
 * Walk entry.payload (one level deep) looking for LongTextField inline values.
 * Any inline field whose text length > threshold is promoted to sidecar form
 * with an atomic write+rename. Returns a new entry with promoted refs.
 *
 * `attachmentRoot` is the parent of the per-entry attachments directory — e.g.
 * `.loaf/<feature>/`. The actual files land at
 * `<attachmentRoot>/attachments/<entry_id>/<field>.txt`.
 */
export async function promoteSidecars(
  entry: JournalEntry,
  attachmentRoot: string,
  opts: PromoteOptions = {},
): Promise<JournalEntry> {
  const threshold = opts.threshold_bytes ?? SIDECAR_THRESHOLD_BYTES;
  const fsync = opts.fsync ?? true;

  const payload = entry.payload as Record<string, unknown>;
  if (typeof payload !== "object" || payload === null) return entry;

  const promotedPayload: Record<string, unknown> = { ...payload };
  let mutated = false;

  for (const [fieldName, value] of Object.entries(payload)) {
    // Stage 4 minimal: only inspect declared LongTextField shapes.
    if (!isLongTextFieldShape(value)) continue;
    const parsed = LongTextField.safeParse(value);
    if (!parsed.success) continue;

    const field = parsed.data;
    if (field.mode === "sidecar") continue; // already promoted

    const inlineBytes = Buffer.byteLength(field.text, "utf8");
    if (inlineBytes <= threshold) continue; // small enough — stay inline

    const entryDir = path.join(attachmentRoot, ATTACHMENTS_SUBDIR, entry.entry_id);
    await fsp.mkdir(entryDir, { recursive: true });

    const finalRel = `${ATTACHMENTS_SUBDIR}/${entry.entry_id}/${fieldName}.txt`;
    const finalAbs = path.join(attachmentRoot, finalRel);
    const tmpAbs = `${finalAbs}.tmp-${randomBytes(6).toString("hex")}`;

    await fsp.writeFile(tmpAbs, field.text, { mode: 0o644 });
    if (fsync) {
      const fh = await fsp.open(tmpAbs, "r+");
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    }
    await fsp.rename(tmpAbs, finalAbs);

    const sha256 = createHash("sha256").update(field.text, "utf8").digest("hex");
    const ref: AttachmentRef = {
      path: finalRel,
      sha256,
      size: inlineBytes,
    };
    promotedPayload[fieldName] = { mode: "sidecar", ref };
    mutated = true;
  }

  if (!mutated) return entry;
  return { ...entry, payload: promotedPayload };
}

function isLongTextFieldShape(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return obj["mode"] === "inline" || obj["mode"] === "sidecar";
}

// ─────────────────────────────────────────────────────────────────────
// Orphan GC
// ─────────────────────────────────────────────────────────────────────

export interface OrphanScanResult {
  orphan_entry_dirs: string[]; // absolute paths
  orphan_tmp_files: string[]; // absolute paths
}

export async function listOrphanSidecars(
  attachmentRoot: string,
  liveEntryIds: ReadonlySet<string>,
): Promise<OrphanScanResult> {
  const attachmentsDir = path.join(attachmentRoot, ATTACHMENTS_SUBDIR);
  const out: OrphanScanResult = { orphan_entry_dirs: [], orphan_tmp_files: [] };

  let entries: { name: string; isDir: boolean }[];
  try {
    const dirents = await fsp.readdir(attachmentsDir, { withFileTypes: true });
    entries = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }

  for (const entry of entries) {
    const fullPath = path.join(attachmentsDir, entry.name);
    if (!entry.isDir) continue;

    if (!liveEntryIds.has(entry.name)) {
      out.orphan_entry_dirs.push(fullPath);
      continue;
    }

    // Live entry dir — scan for stray .tmp-* files.
    const sub = await fsp.readdir(fullPath, { withFileTypes: true });
    for (const f of sub) {
      if (f.isFile() && f.name.includes(".tmp-")) {
        out.orphan_tmp_files.push(path.join(fullPath, f.name));
      }
    }
  }

  return out;
}

export async function cleanupOrphanSidecars(
  attachmentRoot: string,
  liveEntryIds: ReadonlySet<string>,
): Promise<OrphanScanResult> {
  const scan = await listOrphanSidecars(attachmentRoot, liveEntryIds);
  for (const tmp of scan.orphan_tmp_files) {
    await fsp.unlink(tmp).catch(() => {});
  }
  for (const dir of scan.orphan_entry_dirs) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return scan;
}
