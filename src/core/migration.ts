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
import { z } from "zod";

import { appendEntry } from "./journal-append.js";
import { EvidenceKind, EvidenceResult } from "./evidence-schema.js";
import type { AttachmentRef, Ceremony, JournalEntry, SubState } from "./journal-entry.js";
import type {
  EvidenceState,
  FindingState,
  PendingState,
  SessionState,
  Snapshot,
  TaskState,
  TaskStepStatus,
} from "./reducer.js";

// ── Legacy v0.0.x runtime validators (audit r4 fix) ─────────────────────
// Legacy artifacts are free-form JSON / JSONL — TypeScript type assertions
// in rehydrate were not actually validating runtime shape. codex r4 caught:
// `iteration: "one"` (string) / task `status: "nonsense"` / pending
// `resolved: "yes"` all entered the typed Snapshot. Zod schemas below run
// at the rehydrate boundary; any present field that violates the schema
// throws MIGRATION_INCOMPLETE.

const LegacyCeremonySchema = z
  .object({
    spec_phase: z.boolean(),
    verify_phase: z.boolean(),
    settle_phase: z.boolean(),
    strict_spec_review: z.boolean(),
    lessons_required: z.enum(["must", "may", "skip"]),
    strict_drift_check: z.boolean(),
  })
  .strict();

const LegacyTaskSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1).optional(),
    status: z.enum(["pending", "in_progress", "done", "abandoned"]).optional(),
    steps: z
      .record(
        z.string(),
        z.object({
          status: z.enum(["pending", "running", "passed", "failed", "waived", "na"]).optional(),
        }).passthrough(),
      )
      .optional(),
  })
  .passthrough();

const LegacyStateSchema = z
  .object({
    phase: z.string().optional(),
    sub_state: z.string(),
    iteration: z.number().int().positive().optional(),
    spec_locked: z.boolean().optional(),
    profile: z.string().optional(),
    ceremony: LegacyCeremonySchema.optional(),
    session_id: z.string().optional(),
    feature: z.string().optional(),
  })
  .passthrough();

const LegacyTasksSchema = z
  .object({
    tasks: z.array(LegacyTaskSchema).optional(),
  })
  .passthrough();

const LegacyPendingItemSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    resolved: z.boolean().optional(),
  })
  .passthrough();

const LegacyPendingSchema = z
  .object({
    pending: z.array(LegacyPendingItemSchema).optional(),
  })
  .passthrough();

// Audit r5 High fix — evidence/findings runtime schemas. Phase J added
// state/tasks/pending Zod but missed these two JSONL artifacts. Without
// runtime checks, `covers:"not-array"` / `status:"nonsense"` enter the
// typed Snapshot. JSONL is parsed per-line so the schema applies per-record.
// Slice 1.C sub-cycle 1 (codex r34 BLOCK 1 + r35 fix): kind stays loose
// at parse time because docs/schemas.ts:741-749 + ADR-0005:716-720
// document v0.0.x evidence.jsonl.kind values (`test/review/visual/manual/
// waiver/gate-decision`) that DO NOT all match the new EvidenceKind enum.
// Normalized via LEGACY_EVIDENCE_KIND_MAP at migration time; truly unknown
// values surface as MIGRATION_INCOMPLETE (codex r34 fail-loud goal
// preserved for non-documented garbage). Result tightens to EvidenceResult
// — `skipped` was removed in rev 3.1 so any legacy `skipped` correctly
// fails loud here.
const LegacyEvidenceSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    result: EvidenceResult.optional(),
    covers: z.array(z.string()).optional(),
    actor: z.string().optional(),
  })
  .passthrough();

// v0.0.x → v2 evidence kind normalization (docs/schemas.ts:741-749 +
// ADR-0005:720). The 3 renamed kinds map to their new spelling; the 3
// already-valid kinds pass through; anything else throws below.
const LEGACY_EVIDENCE_KIND_MAP: Record<string, EvidenceKind | undefined> = {
  // Renamed (rev 3.1):
  test: "local-check",
  review: "verify-review",
  visual: "visual-review",
  // Pass-through (already valid new EvidenceKind values):
  manual: "manual",
  waiver: "waiver",
  "gate-decision": "gate-decision",
};

const LegacyFindingSchema = z
  .object({
    id: z.string().min(1),
    category: z.string().min(1),
    action: z.string().min(1),
    status: z.enum(["open", "closed"]).optional(),
  })
  .passthrough();

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
  // Audit r5 Low fix — wider rollback. Any failure during sidecar copy
  // phase tears down attachments/JE-000000/ (the staging root) so the
  // featureDir is bit-for-bit recoverable for a clean re-run.
  const sidecarDir = path.join(featureDir, MIGRATION_DIR_REL);
  const stagingRoot = path.join(featureDir, "attachments", MIGRATION_ENTRY_ID);
  await fsp.mkdir(sidecarDir, { recursive: true });

  const attachments: Partial<Record<ArtifactKey, AttachmentRef>> = {};
  try {
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
  } catch (err) {
    // Roll back the entire staging root including the empty attachments/
    // parent if we created it.
    await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    // If attachments/ is empty after JE-000000 removed, drop it too.
    const attachmentsParent = path.join(featureDir, "attachments");
    try {
      const remaining = await fsp.readdir(attachmentsParent);
      if (remaining.length === 0) {
        await fsp.rm(attachmentsParent, { recursive: true, force: true }).catch(() => {});
      }
    } catch { /* ENOENT ok */ }
    throw err;
  }

  // Step 4: build candidate migration entry (NOT yet appended).
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

  // Step 4b — Audit r4 fix: preflight-validate the staged sidecars BEFORE
  // appending the migration entry + before moving originals. codex r4
  // caught: migrateV2 committed the journal entry, then later replay would
  // fail REDUCER_REJECTED — successful migration that cannot load. Now we
  // dry-run rehydrateMigration against the staged sidecars; any field-level
  // validation failure aborts migration without committing journal or
  // moving the originals. Sidecar tmp/finalized files are torn down so
  // the next migrateV2 invocation starts clean.
  try {
    await rehydrateMigration(featureDir, entry);
  } catch (err) {
    // Roll back staged sidecars so the feature dir is recoverable.
    await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    const attachmentsParent = path.join(featureDir, "attachments");
    try {
      const remaining = await fsp.readdir(attachmentsParent);
      if (remaining.length === 0) {
        await fsp.rm(attachmentsParent, { recursive: true, force: true }).catch(() => {});
      }
    } catch { /* ENOENT ok */ }
    throw err;
  }

  // Step 5: validation passed — commit the migration entry to the journal.
  await appendEntry(journalPath, entry, { fsync });

  // Step 6 + 7: move the original v0.0.x files to backup.
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
  // Audit r2/r3/r4 fix: strict parse + Zod runtime field validation. TS
  // type assertions don't validate at runtime; codex r4 caught
  // `iteration:"one"` and similar invalid types passing through into the
  // typed Snapshot. Zod runs at the boundary.
  let legacyStateRaw: unknown;
  try {
    legacyStateRaw = JSON.parse(stateBody);
  } catch (err) {
    throw new MigrationError(
      "MIGRATION_INCOMPLETE",
      `legacy state.json failed JSON parse: ${String(err)}`,
      { sidecar: "state.json", err: String(err) },
    );
  }
  const stateParse = LegacyStateSchema.safeParse(legacyStateRaw);
  if (!stateParse.success) {
    throw new MigrationError(
      "MIGRATION_INCOMPLETE",
      `legacy state.json failed Zod validation: ${stateParse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      { sidecar: "state.json", issues: stateParse.error.issues },
    );
  }
  const legacyState: LegacyStateJson = stateParse.data as LegacyStateJson;
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
    verify_accepted: false,
    spec_version: 0,
    ceremony,
  };

  // ── tasks.json → TaskState[] (strict parse + Zod validation,
  // audit r3/r4 fix) ──
  let legacyTasksRaw: unknown;
  try {
    legacyTasksRaw = JSON.parse(tasksBody);
  } catch (err) {
    throw new MigrationError(
      "MIGRATION_INCOMPLETE",
      `legacy tasks.json failed JSON parse: ${String(err)}`,
      { sidecar: "tasks.json", err: String(err) },
    );
  }
  const tasksParse = LegacyTasksSchema.safeParse(legacyTasksRaw);
  if (!tasksParse.success) {
    throw new MigrationError(
      "MIGRATION_INCOMPLETE",
      `legacy tasks.json failed Zod validation: ${tasksParse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      { sidecar: "tasks.json", issues: tasksParse.error.issues },
    );
  }
  const legacyTasks: LegacyTasksJson = tasksParse.data as LegacyTasksJson;
  const tasks: TaskState[] = (legacyTasks.tasks ?? []).map((t, idx) => {
    if (!t.id) {
      throw new MigrationError(
        "MIGRATION_INCOMPLETE",
        `legacy tasks.json[${idx}] missing required id`,
        { sidecar: "tasks.json", index: idx },
      );
    }
    // sub-cycle 3a: TaskState gained kind/drives/depends_on/labels +
    // step applicability. Legacy v0.0.x doesn't carry these; default
    // kind=behavioral (most common) and seed step applicability=must.
    const base: TaskState = {
      id: t.id,
      kind: (t.kind as TaskState["kind"]) ?? "behavioral",
      status: t.status ?? "pending",
      steps: {},
      drives: [],
      depends_on: [],
      labels: [],
    };
    if (t.steps) {
      for (const [k, v] of Object.entries(t.steps)) {
        const stepStatus = (v?.status as TaskStepStatus) ?? "pending";
        base.steps[k] = { status: stepStatus, applicability: "must" };
      }
    }
    return base;
  });

  // ── evidence.jsonl → EvidenceState[] (Zod per-line, audit r5 fix) ──
  const evidence: EvidenceState[] = [];
  for (const [idx, line] of evidenceBody.split("\n").entries()) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new MigrationError(
        "MIGRATION_INCOMPLETE",
        `legacy evidence.jsonl line ${idx + 1} failed JSON parse: ${String(err)}`,
        { sidecar: "evidence.jsonl", line: idx + 1 },
      );
    }
    const parsed = LegacyEvidenceSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MigrationError(
        "MIGRATION_INCOMPLETE",
        `legacy evidence.jsonl line ${idx + 1} failed Zod validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        { sidecar: "evidence.jsonl", line: idx + 1, issues: parsed.error.issues },
      );
    }
    const e = parsed.data;
    // Slice 1.C sub-cycle 1 (codex r34 BLOCK 1 + r35 fix): normalize
    // documented legacy kinds (`test/review/visual`) to their new spelling.
    // Pass-through-valid kinds (`manual/waiver/gate-decision`) survive
    // unchanged. Truly unknown kinds throw MIGRATION_INCOMPLETE so an
    // operator can clean the legacy sidecar before retrying — preserves
    // the r34 fail-loud goal for non-documented values.
    const normalizedKind = LEGACY_EVIDENCE_KIND_MAP[e.kind];
    if (normalizedKind === undefined) {
      throw new MigrationError(
        "MIGRATION_INCOMPLETE",
        `legacy evidence.jsonl line ${idx + 1} has unknown kind=${JSON.stringify(e.kind)}; expected one of ${Object.keys(LEGACY_EVIDENCE_KIND_MAP).join("/")} (docs/schemas.ts:741-749 + ADR-0005:716-720)`,
        { sidecar: "evidence.jsonl", line: idx + 1, legacy_kind: e.kind },
      );
    }
    const ev: EvidenceState = {
      id: e.id,
      kind: normalizedKind,
      covers: e.covers ?? [],
      actor: e.actor ?? "migration:v0.0.x→v2",
    };
    if (e.result !== undefined) ev.result = e.result;
    evidence.push(ev);
  }

  // ── findings.jsonl → FindingState[] (Zod per-line, audit r5 fix) ──
  const findings: FindingState[] = [];
  for (const [idx, line] of findingsBody.split("\n").entries()) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new MigrationError(
        "MIGRATION_INCOMPLETE",
        `legacy findings.jsonl line ${idx + 1} failed JSON parse: ${String(err)}`,
        { sidecar: "findings.jsonl", line: idx + 1 },
      );
    }
    const parsed = LegacyFindingSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MigrationError(
        "MIGRATION_INCOMPLETE",
        `legacy findings.jsonl line ${idx + 1} failed Zod validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        { sidecar: "findings.jsonl", line: idx + 1, issues: parsed.error.issues },
      );
    }
    const f = parsed.data;
    findings.push({
      id: f.id,
      category: f.category,
      action: f.action,
      status: f.status ?? "open",
    });
  }

  // ── pending.json → PendingState[] (strict + Zod, audit r2/r4 fix) ──
  let legacyPendingRaw: unknown;
  try {
    legacyPendingRaw = JSON.parse(pendingBody);
  } catch (err) {
    throw new MigrationError(
      "MIGRATION_INCOMPLETE",
      `legacy pending.json failed JSON parse: ${String(err)}`,
      { sidecar: "pending.json", err: String(err) },
    );
  }
  const pendingParse = LegacyPendingSchema.safeParse(legacyPendingRaw);
  if (!pendingParse.success) {
    throw new MigrationError(
      "MIGRATION_INCOMPLETE",
      `legacy pending.json failed Zod validation: ${pendingParse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      { sidecar: "pending.json", issues: pendingParse.error.issues },
    );
  }
  const legacyPending: LegacyPendingJson = pendingParse.data as LegacyPendingJson;
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

  return {
    state,
    tasks,
    evidence,
    findings,
    pending,
    requirements: [],
    scenarios: [],
    visual_contracts: [],
    tasks_based_on: null,
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
