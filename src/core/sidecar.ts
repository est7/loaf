// sidecar.ts — §11.2 step 4 (sidecar finalize).
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
import { LongTextField, SIDECAR_THRESHOLD_BYTES, type JournalEntry } from "./journal-entry.js";
import {
  assertAttachmentOwnership,
  attachmentFieldsFor,
  writeAttachment,
} from "./attachment-authority.js";

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

  for (const fieldName of attachmentFieldsFor(entry.kind)) {
    const value = payload[fieldName];
    const parsed = LongTextField.safeParse(value);
    if (!parsed.success) continue;

    const field = parsed.data;
    if (field.mode === "sidecar") {
      assertAttachmentOwnership(entry, fieldName, field.ref);
      continue;
    }

    const inlineBytes = Buffer.byteLength(field.text, "utf8");
    if (inlineBytes <= threshold) continue; // small enough — stay inline

    const ref = await writeAttachment(attachmentRoot, entry, fieldName, field.text, { fsync });
    promotedPayload[fieldName] = { mode: "sidecar", ref };
    mutated = true;
  }

  if (!mutated) return entry;
  return { ...entry, payload: promotedPayload };
}
