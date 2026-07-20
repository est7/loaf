// projection-loader — Phase 15 SC3 read-side bootstrap for snapshot-
// consuming CLI commands (status / tasks list / pending list / finding list /
// evidence list). Parallel to `loadSession` (full replay) but reads the
// persisted `snapshots/*.json` after a Gate #5 fast-check (ADR-0005 §3.6
// + §10.15).
//
// Single freshness transaction per call (M0-anchored TOCTOU per codex r175):
//   M0 = read+parse _meta.json
//   fast-check(M0) vs disk-tail → if !fresh: SnapshotStaleError
//   read N requested projection leaves
//   fast-check(M0) vs disk-tail AGAIN → linearization guard
//   return leaves
//
// The second fast-check uses cached M0 (NOT a fresh meta read) — accepting
// a newer M1 in the same call would bless mixed leaves. Fail-stale and let
// the caller rerun.
//
// 9-reason stale taxonomy centralized here (no per-command duplication):
//   journal_missing / journal_empty / tail_offset_mismatch /
//   tail_hash_mismatch / trailing_partial_line  ← from checkSnapshotFresh
//   meta_missing / meta_invalid (cause: json_parse | schema)
//   projection_missing / projection_invalid (cause: json_parse | schema)
//
// NO_SESSION is a separate code (NOT a stale reason) — fires when the
// loader detects journal+meta both absent OR the meta is the structural
// empty sentinel (isEmptyMeta) with an empty/missing journal. Translation
// runs BEFORE leaf reads so a legitimate pre-`loaf start` directory never
// surfaces projection_missing.
//
// Conditional tasks.json (writer:399-409 — `composeTasksJson` returns null
// when `snapshot.tasks_based_on === null`, file is removed): when `tasks`
// is requested and `tasks.json` is absent, the loader reads `state.json`
// to consult `state.based_on.tasks`. If 0 → return null (valid empty).
// If > 0 → projection_missing. Other unconditional writers (evidence /
// findings / pending) never null — absence is always projection_missing.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  EvidenceJson,
  FindingsJson,
  PendingJson,
  StateProjection,
  TasksJson,
} from "./projection-schema.js";
import { ReconcileJson } from "./reconcile-schema.js";
import { checkSnapshotFresh } from "./snapshot-reader.js";
import { SnapshotMeta, isEmptyMeta, type SnapshotMeta as SnapshotMetaType } from "./snapshot.js";

export type ProjectionKind =
  | "state"
  | "tasks"
  | "evidence"
  | "findings"
  | "pending"
  | "reconcile";

export interface ProjectionFile {
  state: StateProjection;
  tasks: TasksJson;
  evidence: EvidenceJson;
  findings: FindingsJson;
  pending: PendingJson;
  reconcile: ReconcileJson;
}

// `tasks` is the only kind whose file is legitimately absent (writer skip
// when no plan); the loader surfaces that as null. Other kinds throw
// projection_missing on absence.
export type Loaded<K extends ProjectionKind> = K extends "tasks"
  ? ProjectionFile[K] | null
  : ProjectionFile[K];

export type SnapshotStaleReason =
  | "journal_missing"
  | "journal_empty"
  | "tail_offset_mismatch"
  | "tail_hash_mismatch"
  | "trailing_partial_line"
  | "meta_missing"
  | "meta_invalid"
  | "projection_missing"
  | "projection_invalid";

export class SnapshotStaleError extends Error {
  readonly code = "SNAPSHOT_STALE_REBUILD_REQUIRED" as const;
  readonly reason: SnapshotStaleReason;
  readonly detail: Record<string, unknown>;
  constructor(reason: SnapshotStaleReason, detail: Record<string, unknown>) {
    super(`${reason}: ${JSON.stringify(detail)}`);
    this.name = "SnapshotStaleError";
    this.reason = reason;
    this.detail = { reason, ...detail };
  }
}

export class NoSessionError extends Error {
  readonly code = "NO_SESSION" as const;
  readonly detail: Record<string, unknown>;
  constructor(detail: Record<string, unknown>) {
    super(`NO_SESSION: ${JSON.stringify(detail)}`);
    this.name = "NoSessionError";
    this.detail = detail;
  }
}

const LEAF_SCHEMA: { [K in ProjectionKind]: z.ZodTypeAny } = {
  state: StateProjection,
  tasks: TasksJson,
  evidence: EvidenceJson,
  findings: FindingsJson,
  pending: PendingJson,
  reconcile: ReconcileJson,
};

function fixForFeatureDir(featureDir: string): string {
  // featureDir is `.loaf/<feature>` per CLI convention; derive the
  // user-facing rebuild command. If callers pass a non-conforming path we
  // fall back to a generic hint.
  const base = path.basename(featureDir);
  return `run \`loaf doctor --rebuild --feature ${base}\``;
}

/**
 * Read + parse `snapshots/_meta.json`. Classifies meta-level failures
 * upstream of `checkSnapshotFresh` so a malformed-empty-sentinel meta
 * (`seq=-1` with non-empty offset/hash/checksum — runtime SnapshotMeta
 * refine, codex r175) becomes `meta_invalid cause=schema`, never
 * silent NO_SESSION.
 */
async function readMetaOrThrow(
  metaPath: string,
  featureDir: string,
): Promise<SnapshotMetaType | { missing: true }> {
  let raw: string;
  try {
    raw = await fsp.readFile(metaPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { missing: true };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SnapshotStaleError("meta_invalid", {
      feature_dir: featureDir,
      fix: fixForFeatureDir(featureDir),
      meta_path: metaPath,
      cause: "json_parse",
    });
  }
  const result = SnapshotMeta.safeParse(parsed);
  if (!result.success) {
    throw new SnapshotStaleError("meta_invalid", {
      feature_dir: featureDir,
      fix: fixForFeatureDir(featureDir),
      meta_path: metaPath,
      cause: "schema",
    });
  }
  return result.data;
}

/**
 * Translate `checkSnapshotFresh` result to a SnapshotStaleError carrying
 * the loader's full detail envelope (feature_dir + fix + reader detail).
 */
function staleFromReader(
  result: Awaited<ReturnType<typeof checkSnapshotFresh>>,
  featureDir: string,
): SnapshotStaleError | null {
  if (result.fresh) return null;
  return new SnapshotStaleError(result.reason, {
    feature_dir: featureDir,
    fix: fixForFeatureDir(featureDir),
    ...result.detail,
  });
}

/**
 * Read + parse one projection leaf. ENOENT → projection_missing. JSON
 * parse fail → projection_invalid cause=json_parse. Schema fail →
 * projection_invalid cause=schema.
 */
async function readLeafOrThrow<K extends ProjectionKind>(
  kind: K,
  snapshotsDir: string,
  featureDir: string,
): Promise<ProjectionFile[K]> {
  const leafPath = path.join(snapshotsDir, `${kind}.json`);
  let raw: string;
  try {
    raw = await fsp.readFile(leafPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SnapshotStaleError("projection_missing", {
        feature_dir: featureDir,
        fix: fixForFeatureDir(featureDir),
        projection_kind: kind,
        projection_path: leafPath,
      });
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SnapshotStaleError("projection_invalid", {
      feature_dir: featureDir,
      fix: fixForFeatureDir(featureDir),
      projection_kind: kind,
      projection_path: leafPath,
      cause: "json_parse",
    });
  }
  const schema = LEAF_SCHEMA[kind];
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new SnapshotStaleError("projection_invalid", {
      feature_dir: featureDir,
      fix: fixForFeatureDir(featureDir),
      projection_kind: kind,
      projection_path: leafPath,
      cause: "schema",
    });
  }
  return result.data as ProjectionFile[K];
}

async function journalIsEmptyOrMissing(journalPath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(journalPath);
    return stat.size === 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
}

/**
 * Plural: load N projection leaves under a single M0-anchored freshness
 * transaction. Throws NoSessionError for pre-`loaf start` dirs;
 * SnapshotStaleError for any of the 9 stale/corruption reasons.
 *
 * Implicit state read: when `tasks` is requested and `tasks.json` is
 * absent, the loader reads `state.json` to consult `state.based_on.tasks`
 * (writer:399-409 conditional skip). A `state.based_on.tasks === 0`
 * returns null for tasks (valid empty); > 0 throws projection_missing.
 */
/**
 * Loader return type: requested projections by kind, plus the M0
 * SnapshotMeta the freshness transaction was anchored to. Callers that
 * need `tail_seq` (e.g. `loaf status`) read it from `meta.last_applied_seq`
 * without paying a second `_meta.json` read.
 */
export type LoadResult<K extends ProjectionKind> = {
  [P in K]: Loaded<P>;
} & { meta: SnapshotMetaType };

/**
 * Test-only hooks for deterministic TOCTOU seam (Phase 15 SC4, codex r178 Q1).
 *
 * Not exposed via the canonical `loadProjections` input to keep the
 * production API surface clean. Production callers go through
 * `loadProjections` (no hooks); tests that need to exercise the
 * M0-anchored linearization guard use `loadProjectionsWithHooks`.
 *
 * @internal Test-only. Do not use in CLI / library code paths.
 */
export interface LoadProjectionsHooks {
  /**
   * Fires after Stage 2 (first fast-check vs M0) succeeds, BEFORE
   * Stage 3 (leaf reads). Tests use this to deterministically race a
   * mid-call mutator: append a journal entry inside the hook, and the
   * second fast-check (Stage 4) will see the moved tail vs cached M0
   * and fire `SNAPSHOT_STALE_REBUILD_REQUIRED`. Awaited.
   */
  afterFirstFastCheck?: () => Promise<void> | void;
}

/**
 * Public canonical loader — no hooks, used by production callers.
 * See `loadProjectionsWithHooks` for the test-only seam.
 */
export async function loadProjections<K extends ProjectionKind>(input: {
  feature_dir: string;
  kinds: readonly K[];
}): Promise<LoadResult<K>> {
  return _loadProjectionsImpl(input);
}

/**
 * Test-only loader — same contract as `loadProjections` plus a narrow
 * hook surface for deterministic TOCTOU regression coverage (Phase 15
 * SC4, codex r178). NOT exposed to CLI or documented as user-facing
 * surface; the hook only fires inside the test seam.
 *
 * @internal Test-only.
 */
export async function loadProjectionsWithHooks<K extends ProjectionKind>(
  input: { feature_dir: string; kinds: readonly K[] },
  hooks: LoadProjectionsHooks,
): Promise<LoadResult<K>> {
  return _loadProjectionsImpl(input, hooks);
}

async function _loadProjectionsImpl<K extends ProjectionKind>(
  input: { feature_dir: string; kinds: readonly K[] },
  hooks?: LoadProjectionsHooks,
): Promise<LoadResult<K>> {
  const { feature_dir: featureDir, kinds } = input;
  const snapshotsDir = path.join(featureDir, "snapshots");
  const metaPath = path.join(snapshotsDir, "_meta.json");
  const journalPath = path.join(featureDir, "journal.jsonl");

  // ── Stage 0: meta ──────────────────────────────────────────────────
  const metaResult = await readMetaOrThrow(metaPath, featureDir);

  // ── Stage 1: NO_SESSION sentinel ───────────────────────────────────
  // Both-absent → NO_SESSION (loader-only translation, NOT stale).
  if ("missing" in metaResult) {
    const journalAbsent = await journalIsEmptyOrMissing(journalPath);
    if (journalAbsent) {
      throw new NoSessionError({
        feature_dir: featureDir,
        fix: `run \`loaf start <feature>\` first`,
      });
    }
    // Journal present + meta absent → real corruption.
    throw new SnapshotStaleError("meta_missing", {
      feature_dir: featureDir,
      fix: fixForFeatureDir(featureDir),
      meta_path: metaPath,
    });
  }
  const M0 = metaResult;

  // Empty sentinel + empty/absent journal → NO_SESSION.
  // (The SnapshotMeta refine guarantees seq=-1 implies all empty-fields,
  // so reaching here with isEmptyMeta=true means the meta is a clean
  // pre-session sentinel.)
  if (isEmptyMeta(M0)) {
    const journalAbsent = await journalIsEmptyOrMissing(journalPath);
    if (journalAbsent) {
      throw new NoSessionError({
        feature_dir: featureDir,
        fix: `run \`loaf start <feature>\` first`,
      });
    }
    // Empty sentinel meta but non-empty journal → real corruption;
    // checkSnapshotFresh below will surface it (tail_offset_mismatch).
  }

  // ── Stage 2: first fast-check (M0 vs disk-tail) ────────────────────
  const r1 = await checkSnapshotFresh(M0, journalPath);
  const stale1 = staleFromReader(r1, featureDir);
  if (stale1) throw stale1;

  // ── Stage 2.5: test-only TOCTOU seam (Phase 15 SC4, codex r178) ────
  // The hook fires AFTER Stage 2 success and BEFORE Stage 3 leaf reads.
  // Tests use it to simulate a mid-call mutator extending the journal
  // tail; the Stage 4 re-check against cached M0 will then fire stale.
  // Production callers go through `loadProjections` (no hooks).
  if (hooks?.afterFirstFastCheck) {
    await hooks.afterFirstFastCheck();
  }

  // ── Stage 3: leaf reads ────────────────────────────────────────────
  // Implicit state read when `tasks` is requested + tasks.json may be absent.
  // We always pre-read state if needed for tasks fallback, then dedupe.
  const kindsList = kinds as readonly ProjectionKind[];
  const needsTasks = kindsList.includes("tasks");
  const needsState = kindsList.includes("state");

  let stateImplicit: StateProjection | undefined;
  if (needsTasks && !needsState) {
    // Pre-load state for the based_on.tasks consultation; not added to
    // result. If state.json is absent / invalid, surface the same error
    // the caller would see for an explicit state request.
    stateImplicit = await readLeafOrThrow("state", snapshotsDir, featureDir);
  }

  const result: Partial<Record<ProjectionKind, unknown>> = {};
  for (const kind of kindsList) {
    if (kind === "tasks") {
      try {
        result.tasks = await readLeafOrThrow("tasks", snapshotsDir, featureDir);
      } catch (err) {
        if (err instanceof SnapshotStaleError && err.reason === "projection_missing") {
          // Consult state.based_on.tasks to differentiate valid empty
          // (no plan, writer skipped) from real corruption.
          const state =
            (result.state as StateProjection | undefined) ??
            stateImplicit ??
            (await readLeafOrThrow("state", snapshotsDir, featureDir));
          if (state.based_on.tasks === 0) {
            result.tasks = null;
            continue;
          }
        }
        throw err;
      }
    } else {
      result[kind] = await readLeafOrThrow(kind, snapshotsDir, featureDir);
    }
  }

  // ── Stage 4: second fast-check (linearization guard) ───────────────
  // Uses cached M0, NOT a fresh meta read — accepting a newer M1 would
  // bless mixed leaves. Fail-stale; let the caller rerun.
  const r2 = await checkSnapshotFresh(M0, journalPath);
  const stale2 = staleFromReader(r2, featureDir);
  if (stale2) throw stale2;

  (result as { meta?: SnapshotMetaType }).meta = M0;
  return result as LoadResult<K>;
}

/**
 * Singular convenience wrapper — delegates to `loadProjections`.
 */
export async function loadProjection<K extends ProjectionKind>(
  featureDir: string,
  kind: K,
): Promise<Loaded<K>> {
  const result = await loadProjections({ feature_dir: featureDir, kinds: [kind] });
  return result[kind] as unknown as Loaded<K>;
}
