// migration.ts — v0.0.x → v0.1.0 lossy snapshot import (ADR-0005 §5.2).
//
// migrateV2(featureDir) implements steps 1-7:
//   1. Read v0.0.x N-file artifacts (state.json / tasks.json / spec.md /
//      evidence.jsonl / findings.jsonl / pending.json) from featureDir.
//   2. Copy each artifact to
//      featureDir/attachments/JE-000000/migration/<name> via tmp+rename.
//   3. Compute sha256 + size per sidecar.
//   4. Write migration:snapshot_imported entry at seq=0 to featureDir/journal.jsonl.
//   5. Reducer apply records the migration (projection rehydration is staged
//      incrementally; Stage 5 MVP just records the entry + sidecar refs).
//   6. Snapshot generation (Stage 3 replay rebuilds on read).
//   7. Move the original v0.0.x files to <featureDir>.backup-v1/.
//
// Stage 5 MVP scope:
//   - Happy roundtrip + Gate #3 schema rejection
//   - MIGRATION_REPLAY_ATTEMPT (journal not empty)
//   - MIGRATION_BACKUP_MISSING (cannot run unless we can put backup at sibling path)
//   - Sidecar sha256 verification on apply (reducer integration)
//
// Crash-injection coverage (mid-step kill+resume) remains future work.

import { promises as fsp } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import { appendEntry } from "./journal-append.js";
import type { AttachmentRef, JournalEntry } from "./journal-entry.js";

const MIGRATION_ENTRY_ID = "JE-000000";
const MIGRATION_DIR_REL = `attachments/${MIGRATION_ENTRY_ID}/migration`;

const ARTIFACT_FILES = [
  ["state", "state.json"],
  ["tasks", "tasks.json"],
  ["spec_md", "spec.md"],
  ["evidence", "evidence.jsonl"],
  ["findings", "findings.jsonl"],
  ["pending", "pending.json"],
] as const;

export type ArtifactKey = (typeof ARTIFACT_FILES)[number][0];

export class MigrationError extends Error {
  constructor(
    public code:
      | "MIGRATION_REPLAY_ATTEMPT"
      | "MIGRATION_BACKUP_MISSING"
      | "MIGRATION_SIDECAR_MISSING"
      | "MIGRATION_INCOMPLETE"
      | "SCHEMA_VERSION_MISMATCH",
    message: string,
    public detail?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = "MigrationError";
  }
}

export interface MigrateOptions {
  /** Where the v0.0.x → backup directory should land. Defaults to `<featureDir>.backup-v1`. */
  backup_dir?: string;
  /** Wall-clock injection for deterministic tests. Defaults to `new Date().toISOString()`. */
  migrated_at?: string;
  /** Disable fsync for tests. */
  fsync?: boolean;
}

export interface MigrateResult {
  entry: JournalEntry;
  attachments: Record<ArtifactKey, AttachmentRef>;
  backup_dir: string;
}

/**
 * Run steps 1-7 of the §5.2 migration flow on `featureDir`. Throws
 * MigrationError on any precondition violation or sidecar inconsistency.
 */
export async function migrateV2(
  featureDir: string,
  opts: MigrateOptions = {},
): Promise<MigrateResult> {
  const journalPath = path.join(featureDir, "journal.jsonl");
  const backupDir = opts.backup_dir ?? `${featureDir}.backup-v1`;
  const fsync = opts.fsync ?? true;

  // (4-step preconditions before any I/O write)
  // Refuse if the journal already contains entries — migration is one-shot.
  try {
    const existing = await fsp.readFile(journalPath, "utf8");
    if (existing.trim().length > 0) {
      throw new MigrationError(
        "MIGRATION_REPLAY_ATTEMPT",
        "journal.jsonl already has entries; migration must run on a fresh journal",
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      if (err instanceof MigrationError) throw err;
      throw err;
    }
  }

  // Refuse if backup target already exists (would clobber an earlier run).
  try {
    await fsp.access(backupDir);
    throw new MigrationError(
      "MIGRATION_BACKUP_MISSING",
      `backup target ${backupDir} already exists; refusing to overwrite (move/remove it first)`,
      { backup_dir: backupDir },
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      if (err instanceof MigrationError) throw err;
      throw err;
    }
  }

  // Step 1+2: copy artifacts to sidecars.
  const sidecarDir = path.join(featureDir, MIGRATION_DIR_REL);
  await fsp.mkdir(sidecarDir, { recursive: true });

  const attachments: Partial<Record<ArtifactKey, AttachmentRef>> = {};
  for (const [key, filename] of ARTIFACT_FILES) {
    const src = path.join(featureDir, filename);
    let body: Buffer;
    try {
      body = await fsp.readFile(src);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new MigrationError(
          "MIGRATION_SIDECAR_MISSING",
          `v0.0.x artifact missing: ${filename}`,
          { artifact: filename, src },
        );
      }
      throw err;
    }
    const dstAbs = path.join(sidecarDir, filename);
    const tmpAbs = `${dstAbs}.tmp-${randomBytes(6).toString("hex")}`;
    await fsp.writeFile(tmpAbs, body);
    if (fsync) {
      const fh = await fsp.open(tmpAbs, "r+");
      try { await fh.sync(); } finally { await fh.close(); }
    }
    await fsp.rename(tmpAbs, dstAbs);

    attachments[key] = {
      path: `${MIGRATION_DIR_REL}/${filename}`,
      sha256: createHash("sha256").update(body).digest("hex"),
      size: body.length,
    };
  }

  // Step 4: write migration entry to journal at seq=0.
  const entry: JournalEntry = {
    seq: 0,
    entry_id: MIGRATION_ENTRY_ID,
    at: opts.migrated_at ?? new Date().toISOString(),
    actor: "migration:v0.0.x→v2",
    entry_schema_version: 1,
    kind: "migration:snapshot_imported",
    payload: {
      source_schema_version: 1,
      migrated_at: opts.migrated_at ?? new Date().toISOString(),
      artifacts: {
        state: attachments.state!,
        tasks: attachments.tasks!,
        spec_md: attachments.spec_md!,
        evidence: attachments.evidence!,
        findings: attachments.findings!,
        pending: attachments.pending!,
      },
    },
  };
  await appendEntry(journalPath, entry, { fsync });

  // Step 7: move the original v0.0.x files to backup. Steps 5-6 (reducer
  // apply + snapshot rebuild) happen on the next replayJournal() pass.
  await fsp.mkdir(backupDir, { recursive: true });
  for (const [, filename] of ARTIFACT_FILES) {
    const src = path.join(featureDir, filename);
    const dst = path.join(backupDir, filename);
    await fsp.rename(src, dst);
  }

  return {
    entry,
    attachments: attachments as Record<ArtifactKey, AttachmentRef>,
    backup_dir: backupDir,
  };
}

/**
 * Verify that all sidecars referenced by a migration entry exist and match
 * the recorded sha256. Used by the reducer apply path (step 5) and by
 * `doctor --check-tail`.
 */
export async function verifyMigrationSidecars(
  featureDir: string,
  entry: JournalEntry,
): Promise<void> {
  if (entry.kind !== "migration:snapshot_imported") return;
  const payload = entry.payload as { artifacts?: Record<string, AttachmentRef> };
  if (!payload.artifacts) {
    throw new MigrationError("MIGRATION_INCOMPLETE", "migration payload missing artifacts");
  }
  for (const [key, ref] of Object.entries(payload.artifacts)) {
    const abs = path.join(featureDir, ref.path);
    let body: Buffer;
    try {
      body = await fsp.readFile(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new MigrationError(
          "MIGRATION_SIDECAR_MISSING",
          `migration sidecar absent: ${key}`,
          { key, path: ref.path },
        );
      }
      throw err;
    }
    const actualSha = createHash("sha256").update(body).digest("hex");
    if (actualSha !== ref.sha256) {
      throw new MigrationError(
        "MIGRATION_INCOMPLETE",
        `migration sidecar sha256 mismatch for ${key}`,
        { key, expected: ref.sha256, actual: actualSha },
      );
    }
  }
}
