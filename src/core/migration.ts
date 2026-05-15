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
import type { AttachmentRef, Ceremony, JournalEntry, SubState } from "./journal-entry.js";
import type {
  EvidenceState,
  FindingState,
  PendingState,
  SessionState,
  Snapshot,
  TaskState,
} from "./reducer.js";

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

// ─────────────────────────────────────────────────────────────────────
// rehydrateMigration — audit r1 Blocker #6
//
// Reads sidecar artifacts and projects v0.0.x N-file state into a Snapshot.
// The reducer apply path remains synchronous; rehydration must therefore
// happen ahead of replayJournal's per-entry apply loop. replayJournal
// (and any other replayer) invokes this when it sees a
// migration:snapshot_imported entry, then resumes normal apply for
// subsequent entries with the rehydrated snapshot as the cursor.
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_REHYDRATED_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

interface LegacyStateJson {
  phase?: string;
  sub_state?: string;
  iteration?: number;
  spec_locked?: boolean;
  profile?: string;
  ceremony?: Ceremony;
  session_id?: string;
  feature?: string;
}

interface LegacyTasksJson {
  tasks?: Array<{
    id?: string;
    kind?: string;
    status?: "pending" | "in_progress" | "done" | "abandoned";
    steps?: Record<string, { status?: string }>;
  }>;
}

interface LegacyPendingJson {
  pending?: Array<{ id?: string; kind?: string; resolved?: boolean }>;
}

function isLegalSubState(value: string): value is SubState {
  return [
    "TRIAGE.score", "TRIAGE.confirm",
    "SPEC.proposal", "SPEC.spec", "SPEC.plan", "SPEC.design",
    "EXECUTE.plan", "EXECUTE.work", "EXECUTE.done",
    "VERIFY.plan", "VERIFY.run", "VERIFY.review", "VERIFY.acceptance",
    "VERIFY.visual", "VERIFY.accept",
    "SETTLE.reconcile", "SETTLE.lessons",
    "DONE.delivered", "DONE.archived", "DONE.abandoned",
  ].includes(value);
}

function isLegalPhase(value: string): value is SessionState["phase"] {
  return ["TRIAGE", "SPEC", "EXECUTE", "VERIFY", "SETTLE", "DONE"].includes(value);
}

export async function rehydrateMigration(
  featureDir: string,
  entry: JournalEntry,
): Promise<Snapshot> {
  if (entry.kind !== "migration:snapshot_imported") {
    throw new MigrationError(
      "MIGRATION_INCOMPLETE",
      "rehydrateMigration called with non-migration entry",
      { kind: entry.kind },
    );
  }
  await verifyMigrationSidecars(featureDir, entry);

  const payload = entry.payload as { artifacts: Record<string, AttachmentRef> };
  const read = async (key: string): Promise<string> =>
    fsp.readFile(path.join(featureDir, payload.artifacts[key]!.path), "utf8");

  const [stateBody, tasksBody, evidenceBody, findingsBody, pendingBody] = await Promise.all([
    read("state"),
    read("tasks"),
    read("evidence"),
    read("findings"),
    read("pending"),
  ]);

  // ── state.json → SessionState ──
  // Audit r2/r3 fix: strict parse + strict field validation. Invalid enum
  // values must NOT silently fall back to TRIAGE.score — that produces a
  // "successful migration" with the wrong cursor.
  let legacyState: LegacyStateJson;
  try {
    legacyState = JSON.parse(stateBody) as LegacyStateJson;
  } catch (err) {
    throw new MigrationError(
      "MIGRATION_INCOMPLETE",
      `legacy state.json failed JSON parse: ${String(err)}`,
      { sidecar: "state.json", err: String(err) },
    );
  }
  if (!legacyState.sub_state || !isLegalSubState(legacyState.sub_state)) {
    throw new MigrationError(
      "MIGRATION_INCOMPLETE",
      `legacy state.json sub_state is missing or not a legal SubState: ${String(legacyState.sub_state)}`,
      { sidecar: "state.json", got: legacyState.sub_state },
    );
  }
  const subState: SubState = legacyState.sub_state;
  const phase: SessionState["phase"] =
    legacyState.phase && isLegalPhase(legacyState.phase)
      ? legacyState.phase
      : (subState.split(".")[0] as SessionState["phase"]);
  // phase MUST match subState's prefix; if explicit and inconsistent, fail.
  if (legacyState.phase && legacyState.phase !== subState.split(".")[0]) {
    throw new MigrationError(
      "MIGRATION_INCOMPLETE",
      `legacy state.json phase=${legacyState.phase} inconsistent with sub_state=${subState}`,
      { sidecar: "state.json", phase: legacyState.phase, sub_state: subState },
    );
  }
  const ceremony: Ceremony = legacyState.ceremony ?? DEFAULT_REHYDRATED_CEREMONY;
  const state: SessionState = {
    session_id: legacyState.session_id ?? "00000000-0000-0000-0000-000000000000",
    feature: legacyState.feature ?? "migrated",
    phase,
    sub_state: subState,
    iteration: legacyState.iteration ?? 1,
    spec_locked: legacyState.spec_locked ?? false,
    ceremony,
  };

  // ── tasks.json → TaskState[] (strict parse + strict per-task validation,
  // audit r3 fix) ──
  let legacyTasks: LegacyTasksJson;
  try {
    legacyTasks = JSON.parse(tasksBody) as LegacyTasksJson;
  } catch (err) {
    throw new MigrationError(
      "MIGRATION_INCOMPLETE",
      `legacy tasks.json failed JSON parse: ${String(err)}`,
      { sidecar: "tasks.json", err: String(err) },
    );
  }
  const tasks: TaskState[] = (legacyTasks.tasks ?? []).map((t, idx) => {
    if (!t.id) {
      throw new MigrationError(
        "MIGRATION_INCOMPLETE",
        `legacy tasks.json[${idx}] missing required id`,
        { sidecar: "tasks.json", index: idx },
      );
    }
    const base: TaskState = {
      id: t.id,
      status: t.status ?? "pending",
      steps: {},
    };
    if (t.kind !== undefined) base.kind = t.kind;
    if (t.steps) {
      for (const [k, v] of Object.entries(t.steps)) {
        const stepStatus = (v?.status as TaskState["steps"][string]["status"]) ?? "pending";
        base.steps[k] = { status: stepStatus };
      }
    }
    return base;
  });

  // ── evidence.jsonl → EvidenceState[] (strict per-line parse, audit r2 fix) ──
  const evidence: EvidenceState[] = [];
  for (const [idx, line] of evidenceBody.split("\n").entries()) {
    if (!line.trim()) continue;
    let e: Partial<EvidenceState>;
    try {
      e = JSON.parse(line) as Partial<EvidenceState>;
    } catch (err) {
      throw new MigrationError(
        "MIGRATION_INCOMPLETE",
        `legacy evidence.jsonl line ${idx + 1} failed JSON parse: ${String(err)}`,
        { sidecar: "evidence.jsonl", line: idx + 1 },
      );
    }
    if (!e.id || !e.kind) {
      throw new MigrationError(
        "MIGRATION_INCOMPLETE",
        `legacy evidence.jsonl line ${idx + 1} missing id or kind`,
        { sidecar: "evidence.jsonl", line: idx + 1 },
      );
    }
    const ev: EvidenceState = {
      id: e.id,
      kind: e.kind,
      covers: e.covers ?? [],
      actor: e.actor ?? "migration:v0.0.x→v2",
    };
    if (e.result !== undefined) ev.result = e.result;
    evidence.push(ev);
  }

  // ── findings.jsonl → FindingState[] (strict, audit r2 fix) ──
  const findings: FindingState[] = [];
  for (const [idx, line] of findingsBody.split("\n").entries()) {
    if (!line.trim()) continue;
    let f: Partial<FindingState>;
    try {
      f = JSON.parse(line) as Partial<FindingState>;
    } catch (err) {
      throw new MigrationError(
        "MIGRATION_INCOMPLETE",
        `legacy findings.jsonl line ${idx + 1} failed JSON parse: ${String(err)}`,
        { sidecar: "findings.jsonl", line: idx + 1 },
      );
    }
    if (!f.id || !f.category || !f.action) {
      throw new MigrationError(
        "MIGRATION_INCOMPLETE",
        `legacy findings.jsonl line ${idx + 1} missing required fields`,
        { sidecar: "findings.jsonl", line: idx + 1 },
      );
    }
    findings.push({
      id: f.id,
      category: f.category,
      action: f.action,
      status: f.status ?? "open",
    });
  }

  // ── pending.json → PendingState[] (strict, audit r2 fix) ──
  let legacyPending: LegacyPendingJson;
  try {
    legacyPending = JSON.parse(pendingBody) as LegacyPendingJson;
  } catch (err) {
    throw new MigrationError(
      "MIGRATION_INCOMPLETE",
      `legacy pending.json failed JSON parse: ${String(err)}`,
      { sidecar: "pending.json", err: String(err) },
    );
  }
  const pending: PendingState[] = (legacyPending.pending ?? []).map((p, idx) => {
    if (!p.id || !p.kind) {
      throw new MigrationError(
        "MIGRATION_INCOMPLETE",
        `legacy pending.json[${idx}] missing required id or kind`,
        { sidecar: "pending.json", index: idx, got: p },
      );
    }
    return { id: p.id, kind: p.kind, resolved: p.resolved ?? false };
  });

  return { state, tasks, evidence, findings, pending };
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
