// Projection writer — the `loaf doctor --rebuild` serializer (Phase 14 SC1,
// ADR-0005 §3.6 / findings.md F-018, codex r155+r156).
//
// `loaf doctor --rebuild` does a full journal replay (replayJournal seq=0,
// collect_entries:true) → in-memory `Snapshot` + `JournalEntry[]` + `meta`,
// then re-serializes the five fully-journal-derived projection files plus
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
// `state.json` IS written (Phase 15 SC1): the old monolithic `StateJson`
// was split into the journal-derived `StateProjection` (re-serialized
// here) and `SessionRuntimeFile` — machine-local `cwd` / `debug` /
// `heartbeat_at`, which `--rebuild` never reads or writes (F-019).
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

import { SessionStartedPayload, type JournalEntry } from "./journal-entry.js";
import type { Snapshot } from "./reducer.js";
import type { SnapshotMeta } from "./snapshot.js";
import { writeMeta } from "./snapshot.js";
import { latestCanonicalTaskBody, materializeTaskForAmend } from "./task-history.js";
import {
  EvidenceJson,
  FindingsJson,
  PendingJson,
  PROJECTION_SCHEMA_VERSION,
  StateProjection,
  TasksJson,
  type PendingProjectionEntry,
  type PendingQueueEntry,
} from "./projection-schema.js";
import { EvidenceFullPayload } from "./evidence-schema.js";
import {
  selectLessonEntries,
  resolveLessonBodies,
  composeLessonsProjection,
  deriveLessonsHeader,
} from "./lessons-projection.js";

// ── Pure compose functions ──────────────────────────────────────────────

/**
 * Compose `snapshots/state.json` from a replayed snapshot + journal entries.
 *
 * Returns `null` when the journal carries no `session:started`
 * (`snapshot.state` null — empty journal): there is no session to project,
 * so the file is SKIPPED, never written empty (mirrors `composeTasksJson`).
 *
 * The bucket-C identity fields (`session_label` / `workspace` /
 * `ceremony_label` / `loaf_version_required`) come off the `session:started`
 * payload, re-parsed through `SessionStartedPayload`: a pre-SC1 (legacy)
 * entry lacks them (field `undefined` → documented fallback —
 * `workspace`→"default", `ceremony_label`→"", `session_label` &
 * `loaf_version_required`→null), but a field PRESENT-but-malformed fails
 * fast — `--rebuild` must not launder payload corruption into a fallback
 * (codex r168 BLOCK 2). `complexity_score` has no journal source — always
 * `null` (F-019). `created_at` is the `session:started` envelope timestamp;
 * `updated_at` is the last replayed entry's. `based_on.tasks` counts
 * `event:tasks_planned` + `event:tasks_amended` (= `TasksJson.version`).
 *
 * `pending` is the LIVE queue — `composePendingJson` minus every entry with
 * a matching `pending:resolved`, mapped down to `PendingQueueEntry` (the
 * `resolved` tag belongs to `pending.json`, not the public `state.json`
 * contract — codex r168 BLOCK 1). The composed object is validated against
 * `StateProjection` before return (defense-in-depth, mirrors the others).
 */
export function composeStateProjection(
  snapshot: Snapshot,
  entries: readonly JournalEntry[],
): StateProjection | null {
  const state = snapshot.state;
  if (state === null) return null;

  const startEntry = entries.find((e) => e.kind === "session:started");
  if (startEntry === undefined) {
    // `snapshot.state` is non-null only via `session:started` or a
    // `migration:snapshot_imported` bootstrap; `doctor --rebuild` rejects
    // migrated journals upstream, so a missing start entry here is
    // projection corruption — throw rather than invent identity.
    throw new Error(
      "composeStateProjection: snapshot carries session state but the journal has no session:started entry — projection corruption",
    );
  }
  const lastEntry = entries[entries.length - 1];
  if (lastEntry === undefined) {
    throw new Error(
      "composeStateProjection: snapshot carries session state but the entry stream is empty — projection corruption",
    );
  }

  // Re-parse the `session:started` payload through `SessionStartedPayload`
  // (codex r168 BLOCK 2): `replayJournal` validates only the envelope, not
  // `PER_KIND_PAYLOAD`, so `--rebuild` must distinguish a LEGACY entry
  // (bucket-C field absent → documented fallback) from a CORRUPT one
  // (bucket-C field present but malformed → fail fast). `.parse` throws on
  // the corrupt case; an absent optional field is `undefined` → fallback.
  const startPayload = SessionStartedPayload.parse(startEntry.payload);
  const sessionLabel = startPayload.session_label ?? null;
  const ceremonyLabel = startPayload.ceremony_label ?? "";
  const workspace = startPayload.workspace ?? "default";
  const loafVersionRequired = startPayload.loaf_version_required ?? null;

  const tasksVersion = entries.filter(
    (e) => e.kind === "event:tasks_planned" || e.kind === "event:tasks_amended",
  ).length;

  return StateProjection.parse({
    schema_version: PROJECTION_SCHEMA_VERSION,
    session_id: state.session_id,
    session_label: sessionLabel,
    workspace,
    loaf_version_required: loafVersionRequired,
    phase: state.phase,
    sub_state: state.sub_state,
    iteration: state.iteration,
    spec_locked: state.spec_locked,
    verify_accepted: state.verify_accepted,
    pending: composePendingJson(entries)
      .pending.filter((p) => !p.resolved)
      .map(({ resolved: _resolved, ...queue }): PendingQueueEntry => queue),
    ceremony: state.ceremony,
    ceremony_label: ceremonyLabel,
    complexity_score: null,
    based_on: {
      spec: snapshot.tasks_based_on?.spec ?? 0,
      tasks: tasksVersion,
    },
    spec_version: state.spec_version,
    created_at: startEntry.at,
    updated_at: lastEntry.at,
  });
}

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
async function writeJsonAtomic(filePath: string, value: unknown, fsync: boolean): Promise<void> {
  await writeTextAtomic(filePath, JSON.stringify(value, null, 2), fsync);
}

/** Atomic raw-text write — the markdown projection (lessons.md, F-024)
 *  shares the exact tmp+fsync+rename boundary as the JSON leaves. */
async function writeTextAtomic(filePath: string, body: string, fsync: boolean): Promise<void> {
  const tmp = `${filePath}.tmp-${randomBytes(6).toString("hex")}`;
  await fsp.writeFile(tmp, body, { mode: 0o644 });

  // tmp+rename is the atomicity boundary regardless of fsync; fsync only
  // adds power-loss durability. `fsync:false` (the test path — `mutateBatch`
  // step 8 threads `ctx.fsync`) keeps the atomic rename, skips the syncs.
  if (fsync) {
    const fh = await fsp.open(tmp, "r+");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  await fsp.rename(tmp, filePath);

  // Best-effort parent fsync. Some filesystems (tmpfs) reject dir fsync;
  // mirror snapshot.writeMeta's tolerance.
  if (fsync) {
    try {
      const dh = await fsp.open(path.dirname(filePath), "r");
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      /* best-effort dir fsync */
    }
  }
}

export interface WriteProjectionsInput {
  /** Replayed projection — source for findings.json + the task overlay. */
  snapshot: Snapshot;
  /** The full journal entry stream (replayJournal collect_entries:true). */
  entries: readonly JournalEntry[];
  /** The replay's accumulated meta — written verbatim to _meta.json. */
  meta: SnapshotMeta;
  /** fsync each projection file + `_meta.json` (power-loss durability).
   *  Default true — `loaf doctor --rebuild` always fsyncs. `mutateBatch`
   *  step 8 threads `ctx.fsync`, so the `fsync:false` test path skips the
   *  syncs while keeping the atomic tmp+rename. */
  fsync?: boolean;
}

/**
 * Re-serialize the five journal-derived projection files plus `_meta.json`
 * under `<featureDir>/snapshots/`.
 *
 * Each data file is written atomically; `_meta.json` is written LAST (via
 * `writeMeta`) so a reader can never observe a fresh `_meta` pointing at
 * stale projections — metadata strictly after data.
 *
 * `state.json` / `tasks.json` are written only when their content exists
 * (`composeStateProjection` / `composeTasksJson` non-null) — an empty
 * journal has no session, a planless journal has no task graph; with
 * neither present the file is removed, so a `--rebuild` never leaves a
 * stale projection behind.
 *
 * Does NOT acquire the per-feature lock — the caller (`loaf doctor
 * --rebuild`, SC2) drives this from within its own critical section.
 *
 * Returns the basenames of the files present after the rebuild, in write
 * order — `state.json` first (skipped only for an empty journal), then
 * `tasks.json` when a plan existed, then evidence / findings / pending /
 * `_meta.json`. The `loaf doctor --rebuild` CLI surfaces this as its
 * `rebuilt` list, so it never claims a file it did not write.
 */
export async function writeProjections(
  featureDir: string,
  input: WriteProjectionsInput,
): Promise<string[]> {
  const { snapshot, entries, meta } = input;
  const fsync = input.fsync ?? true;
  const snapshotsDir = path.join(featureDir, "snapshots");
  await fsp.mkdir(snapshotsDir, { recursive: true });

  const written: string[] = [];

  // state.json — the session-root projection (Phase 15 SC1). Written
  // whenever a session exists; for an empty journal composeStateProjection
  // returns null and a stale state.json is removed (mirrors tasks.json).
  const statePath = path.join(snapshotsDir, "state.json");
  const stateJson = composeStateProjection(snapshot, entries);
  if (stateJson !== null) {
    await writeJsonAtomic(statePath, stateJson, fsync);
    written.push("state.json");
  } else {
    await fsp.rm(statePath, { force: true });
  }

  // tasks.json — written when a task plan exists, else REMOVED. A stale
  // tasks.json left from a prior state would survive the `_meta.json`
  // fast-check yet no longer match the rebuilt journal (codex r158 BLOCK).
  const tasksPath = path.join(snapshotsDir, "tasks.json");
  const tasksJson = composeTasksJson(snapshot, entries);
  if (tasksJson !== null) {
    await writeJsonAtomic(tasksPath, tasksJson, fsync);
    written.push("tasks.json");
  } else {
    await fsp.rm(tasksPath, { force: true });
  }

  await writeJsonAtomic(
    path.join(snapshotsDir, "evidence.json"),
    composeEvidenceJson(entries),
    fsync,
  );
  written.push("evidence.json");
  await writeJsonAtomic(
    path.join(snapshotsDir, "findings.json"),
    composeFindingsJson(snapshot),
    fsync,
  );
  written.push("findings.json");
  await writeJsonAtomic(
    path.join(snapshotsDir, "pending.json"),
    composePendingJson(entries),
    fsync,
  );
  written.push("pending.json");

  // lessons.md — top-level user-facing markdown projection (F-024), NOT a
  // snapshots/*.json leaf. Written when ≥1 lesson entry exists, else a stale
  // top-level lessons.md is removed (mirrors state.json/tasks.json absence).
  // Sidecar body resolution failures THROW → surfaced as
  // PROJECTION_WRITE_FAILED at the mutate boundary (mirrors spec.md).
  const lessonsPath = path.join(featureDir, "lessons.md");
  const lessonEntries = selectLessonEntries(entries);
  if (lessonEntries.length > 0) {
    const resolved = await resolveLessonBodies(featureDir, lessonEntries);
    const md = composeLessonsProjection(resolved, deriveLessonsHeader(snapshot, entries));
    await writeTextAtomic(lessonsPath, md, fsync);
    written.push("lessons.md");
  } else {
    await fsp.rm(lessonsPath, { force: true });
  }

  // Metadata strictly after data — a reader must never see a fresh _meta
  // pointing at stale projection files.
  await writeMeta(path.join(snapshotsDir, "_meta.json"), meta, fsync);
  written.push("_meta.json");

  return written;
}
