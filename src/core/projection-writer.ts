// Projection writer — the `loaf doctor --rebuild` serializer (Phase 14 SC1,
// ADR-0005 §3.6 / findings.md F-018, codex r155+r156).
//
// `loaf doctor --rebuild` does a full journal replay (replayJournal seq=0,
// collect_entries:true) → in-memory `Snapshot` + `JournalEntry[]` + `meta`,
// then re-serializes the four fully-journal-derived projection files plus
// `_meta.json` under `.loaf/<feature>/snapshots/`.
//
// Layering mirrors spec-projection.ts: pure `compose*` functions (no IO,
// each validates its result against the runtime container schema as a
// defense-in-depth gate) + an IO `writeProjections` that does per-file
// atomic tmp+fsync+rename.
//
// Inputs are the journal-replay outputs — the slim reducer `Snapshot`
// alone is insufficient (it drops canonical task bodies, evidence payload
// detail, and `pending:added` provenance). `task-history.ts`'s
// `latestCanonicalTaskBody` reconstructs full task bodies from the entry
// stream; evidence / pending bodies come straight off the entry payloads.
//
// `state.json` is intentionally NOT written: its `StateJson` contract
// carries fields with no journal source (session_label / cwd /
// complexity_score / heartbeat_at …) — a faithful rebuild needs a
// schema-split, deferred to its own slice (F-018).
//
// Migration scope: a v0.0.x-migrated journal carries its projection state
// via `migration:snapshot_imported` sidecar rehydration, not via ordinary
// `event:tasks_planned` / `evidence:added` / `pending:added` payloads.
// This serializer derives tasks/evidence/pending from those event payloads,
// so `--rebuild` of a migrated feature is a follow-up (it intersects
// `doctor --migrate-v2`) — out of SC1 scope (F-018, codex r158).

import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { JournalEntry } from "./journal-entry.js";
import type { Snapshot } from "./reducer.js";
import type { SnapshotMeta } from "./snapshot.js";
import { writeMeta } from "./snapshot.js";
import { latestCanonicalTaskBody, materializeTaskForAmend } from "./task-history.js";
import {
  EvidenceJson,
  FindingsJson,
  PendingJson,
  PROJECTION_SCHEMA_VERSION,
  TasksJson,
  type PendingProjectionEntry,
} from "./projection-schema.js";
import { EvidenceFullPayload } from "./evidence-schema.js";

// ── Pure compose functions ──────────────────────────────────────────────

/**
 * Compose `snapshots/tasks.json` from a replayed snapshot + journal entries.
 *
 * Returns `null` when no task plan has landed (`snapshot.tasks_based_on`
 * null): `TasksJson.based_on.spec` is `.positive()` and unsatisfiable
 * without a plan, so the file is SKIPPED, never written empty.
 *
 * `version` counts the whole-replacement task-plan contract's entries —
 * every `event:tasks_planned` + `event:tasks_amended` on the journal.
 *
 * Each task body is recovered via `latestCanonicalTaskBody` (the slim
 * `Snapshot.tasks` drops canonical fields) and then has the live runtime
 * status/applicability overlaid via `materializeTaskForAmend`. A snapshot
 * task with NO canonical journal body is projection corruption — this
 * THROWS rather than inventing a body.
 *
 * The composed object is validated against `TasksJson` before return
 * (defense-in-depth against a future reducer drift — mirrors
 * spec-projection.ts's `SpecFrontmatter.parse`).
 */
export function composeTasksJson(
  snapshot: Snapshot,
  entries: readonly JournalEntry[],
): TasksJson | null {
  if (snapshot.tasks_based_on === null) return null;

  const version = entries.filter(
    (e) => e.kind === "event:tasks_planned" || e.kind === "event:tasks_amended",
  ).length;

  const tasks = snapshot.tasks.map((t) => {
    const body = latestCanonicalTaskBody(entries, t.id);
    if (body === undefined) {
      throw new Error(
        `composeTasksJson: task ${t.id} is in the snapshot projection but has no canonical journal body — projection corruption (a rebuild must not invent a body)`,
      );
    }
    return materializeTaskForAmend(body, t);
  });

  return TasksJson.parse({
    schema_version: PROJECTION_SCHEMA_VERSION,
    version,
    based_on: { spec: snapshot.tasks_based_on.spec },
    tasks,
  });
}

/**
 * Compose `snapshots/evidence.json` from journal entries.
 *
 * Each `evidence:added` payload is re-parsed through the refined
 * `EvidenceFullPayload`, re-asserting the manual/waiver actor+reason and
 * visual-review attachment cross-field invariants: `replayJournal`
 * validates only the journal envelope, not `PER_KIND_PAYLOAD`, so a
 * `--rebuild` must not launder a refine-violating payload into a fresh
 * projection (codex r158). The two envelope-owned fields the payload
 * schema omits — `schema_version` + `at` — are re-attached, journal order
 * preserved. Validated against `EvidenceJson` before return.
 */
export function composeEvidenceJson(entries: readonly JournalEntry[]): EvidenceJson {
  const evidence = entries
    .filter((e) => e.kind === "evidence:added")
    .map((e) => ({
      ...EvidenceFullPayload.parse(e.payload),
      schema_version: PROJECTION_SCHEMA_VERSION,
      at: e.at,
    }));

  return EvidenceJson.parse({
    schema_version: PROJECTION_SCHEMA_VERSION,
    evidence,
  });
}

/**
 * Compose `snapshots/findings.json` from a replayed snapshot.
 *
 * The slim `FindingState[]` IS the projection shape — the reducer already
 * projects every reader-relevant field (id / category / action / status +
 * payload-derived summary / reason / target). NOT the legacy §17
 * `FindingsEvent` jsonl event schema. Validated against `FindingsJson`.
 */
export function composeFindingsJson(snapshot: Snapshot): FindingsJson {
  return FindingsJson.parse({
    schema_version: PROJECTION_SCHEMA_VERSION,
    findings: snapshot.findings,
  });
}

/**
 * Compose `snapshots/pending.json` from journal entries.
 *
 * First collects the resolved-id set (every `pending:resolved` payload's
 * `id`), then projects each `pending:added` entry in journal order into a
 * `PendingProjectionEntry`. The rich `PendingPromptEntry` fields the
 * journal payload never carried are collapsed onto journal truth:
 *   - `raised_at` + `at` ← the single envelope timestamp
 *   - `raised_by`        ← the envelope actor
 *   - `blocks`           ← the constant "advance"
 *   - `resolved`         ← whether a matching `pending:resolved` exists
 *
 * Validated against `PendingJson` before return.
 */
export function composePendingJson(entries: readonly JournalEntry[]): PendingJson {
  const resolvedIds = new Set<string>();
  for (const e of entries) {
    if (e.kind === "pending:resolved") {
      resolvedIds.add((e.payload as { id: string }).id);
    }
  }

  const pending: PendingProjectionEntry[] = [];
  for (const e of entries) {
    if (e.kind !== "pending:added") continue;
    const p = e.payload as {
      id: string;
      kind: PendingProjectionEntry["kind"];
      question: string;
      options?: string[];
      task_id?: string;
    };
    const item: PendingProjectionEntry = {
      pending_id: p.id,
      kind: p.kind,
      question: p.question,
      blocks: "advance",
      raised_at: e.at,
      raised_by: e.actor,
      at: e.at,
      resolved: resolvedIds.has(p.id),
    };
    if (p.options !== undefined) item.options = p.options;
    if (p.task_id !== undefined) item.raised_by_task_id = p.task_id;
    pending.push(item);
  }

  return PendingJson.parse({
    schema_version: PROJECTION_SCHEMA_VERSION,
    pending,
  });
}

// ── IO write ─────────────────────────────────────────────────────────────

/**
 * Write a single JSON projection file atomically. Pattern mirrors
 * spec-projection.ts `writeDerivedSpecMd` / snapshot.ts `writeMeta`:
 *   1. random tmp suffix (avoids collision / TOCTOU surprises)
 *   2. write tmp + fsync the tmp file
 *   3. rename tmp → final (atomic on same FS)
 *   4. best-effort fsync parent dir (durability across power loss)
 */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const body = JSON.stringify(value, null, 2);
  const tmp = `${filePath}.tmp-${randomBytes(6).toString("hex")}`;
  await fsp.writeFile(tmp, body, { mode: 0o644 });

  let fh = await fsp.open(tmp, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }

  await fsp.rename(tmp, filePath);

  // Best-effort parent fsync. Some filesystems (tmpfs) reject dir fsync;
  // mirror snapshot.writeMeta's tolerance.
  try {
    fh = await fsp.open(path.dirname(filePath), "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    /* best-effort dir fsync */
  }
}

export interface WriteProjectionsInput {
  /** Replayed projection — source for findings.json + the task overlay. */
  snapshot: Snapshot;
  /** The full journal entry stream (replayJournal collect_entries:true). */
  entries: readonly JournalEntry[];
  /** The replay's accumulated meta — written verbatim to _meta.json. */
  meta: SnapshotMeta;
}

/**
 * Re-serialize the four journal-derived projection files plus `_meta.json`
 * under `<featureDir>/snapshots/`.
 *
 * Each data file is written atomically; `_meta.json` is written LAST (via
 * `writeMeta`) so a reader can never observe a fresh `_meta` pointing at
 * stale projections — metadata strictly after data.
 *
 * `tasks.json` is written only when a task plan exists (`composeTasksJson`
 * non-null); with no plan it is removed if present, so a `--rebuild` never
 * leaves a stale tasks.json behind.
 *
 * Does NOT acquire the per-feature lock — the caller (`loaf doctor
 * --rebuild`, SC2) drives this from within its own critical section.
 */
export async function writeProjections(
  featureDir: string,
  input: WriteProjectionsInput,
): Promise<void> {
  const { snapshot, entries, meta } = input;
  const snapshotsDir = path.join(featureDir, "snapshots");
  await fsp.mkdir(snapshotsDir, { recursive: true });

  // tasks.json — written when a task plan exists, else REMOVED. A stale
  // tasks.json left from a prior state would survive the `_meta.json`
  // fast-check yet no longer match the rebuilt journal (codex r158 BLOCK).
  const tasksPath = path.join(snapshotsDir, "tasks.json");
  const tasksJson = composeTasksJson(snapshot, entries);
  if (tasksJson !== null) {
    await writeJsonAtomic(tasksPath, tasksJson);
  } else {
    await fsp.rm(tasksPath, { force: true });
  }

  await writeJsonAtomic(
    path.join(snapshotsDir, "evidence.json"),
    composeEvidenceJson(entries),
  );
  await writeJsonAtomic(
    path.join(snapshotsDir, "findings.json"),
    composeFindingsJson(snapshot),
  );
  await writeJsonAtomic(
    path.join(snapshotsDir, "pending.json"),
    composePendingJson(entries),
  );

  // Metadata strictly after data — a reader must never see a fresh _meta
  // pointing at stale projection files.
  await writeMeta(path.join(snapshotsDir, "_meta.json"), meta);
}
