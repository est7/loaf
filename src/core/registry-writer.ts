// Phase 16 SC-7 — registry per-session file writer foundation.
//
// Per protocol §4.12 + §11.2 step 9: each mutator pipeline run (after step
// 8 snapshot rebuild) refreshes the per-session registry file at
// `~/.loaf/registry/<session_id>.json`. Best-effort derived projection
// (§13.1): registry is NEVER gate or liveness authority; readers (TUI /
// sessions list) tolerate a missed refresh.
//
// This module owns two pure-ish surfaces:
//   - buildRegistryFile({snapshot, entries, now, cwd})
//     → RegistryFile | null. Pure: extracts fields from snapshot +
//     session:started payload. Throws on Zod parse failure (schema
//     mismatch is a code defect, not a stale projection — codex r280 P4).
//   - writeRegistryFile(sessionId, file, opts) → Promise<void>
//     Atomic temp+rename write with mode 0o600. Creates registry dir
//     if absent (mkdir -p). Throws on IO failure; caller (mutateBatch
//     step 9) catches + silences per §4.12 best-effort.
//
// Caller pattern (mutateBatch step 9):
//   try {
//     const file = buildRegistryFile(...); // throws on schema fail
//     if (file) {
//       try {
//         await writeRegistryFile(file.session_id, file, ...);
//       } catch { /* silent — §4.12 best-effort IO */ }
//     }
//   } catch (err) {
//     return { ok: false, code: ..., message: <derivation cause> };
//   }
//
// codex r280 P4 invariant: pure derivation failures surface as a mutate
// failure (NOT silent ok, NOT CLI crash); IO write failures are silent ok.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  PROJECTION_SCHEMA_VERSION,
  RegistryFile,
  type PendingQueueEntry,
} from "./projection-schema.js";
import type { Snapshot } from "./reducer.js";
import type { JournalEntry } from "./journal-entry.js";
import { SessionStartedPayload } from "./journal-entry.js";
import { composePendingJson } from "./projection-writer.js";

/** Default registry directory: `~/.loaf/registry/`.
 *
 *  Test isolation (codex r281 P1): when `process.env.LOAF_REGISTRY_DIR`
 *  is set (vitest setup file populates it with a tmp dir), it wins
 *  over the home-dir default. Tests can also override per-call via
 *  `writeRegistryFile`'s `registryDir` option. Production users do
 *  NOT set the env var; they get the canonical `~/.loaf/registry/`. */
export function defaultRegistryDir(): string {
  const envOverride = process.env["LOAF_REGISTRY_DIR"];
  if (envOverride && envOverride.length > 0) return envOverride;
  return path.join(os.homedir(), ".loaf", "registry");
}

export interface BuildRegistryFileInput {
  snapshot: Snapshot;
  entries: readonly JournalEntry[];
  now: Date;
  cwd: string;
}

/** Pure: derive RegistryFile from a journal-applied snapshot + the
 *  entries that produced it. Returns null when the snapshot carries no
 *  session state (pre-session:started edge case).
 *
 *  Throws on Zod parse failure — schema mismatch means a code defect,
 *  not a stale projection (codex r280 P4). Caller in `mutateBatch`
 *  step 9 catches + converts to a mutate failure result. */
export function buildRegistryFile(input: BuildRegistryFileInput): RegistryFile | null {
  const { snapshot, entries, now, cwd } = input;
  const state = snapshot.state;
  if (!state || !state.session_id) return null;

  // Locate the session:started entry; mirror composeStateProjection's
  // strict parse (codex r168 BLOCK 2). A widened envelope with a
  // corrupt bucket-C field fails LOUDLY — the catch in mutateBatch
  // surfaces this as a mutate failure, NOT silent registry stale.
  const startEntry = entries.find((e) => e.kind === "session:started");
  if (!startEntry) {
    // Snapshot carries state but no session:started in entries — corrupt.
    // Treat as derivation failure to surface in mutate result.
    throw new Error(
      "buildRegistryFile: snapshot has state.session_id but entries lacks session:started — projection corruption",
    );
  }
  const startPayload = SessionStartedPayload.parse(startEntry.payload);

  // Bucket-C fallbacks — schema-valid (per codex r280 P2 for
  // session_label specifically, which is z.string() not nullable).
  const sessionLabel = startPayload.session_label ?? "";
  const workspace = startPayload.workspace ?? "default";
  const ceremonyLabel = startPayload.ceremony_label ?? "";

  // pending: rich PendingQueueEntry head (NOT slim Snapshot.pending
  // shape) + unresolved-only queue depth. Codex r280 P3:
  //   - Snapshot.pending is {id, kind, resolved} — too thin for
  //     RegistryFile.pending which requires question/blocks/raised_at/
  //     raised_by/pending_id/at.
  //   - snapshot.pending.length counts RESOLVED entries too (reducer
  //     marks resolved rather than popping), so the depth must come
  //     from filter-by-unresolved.
  const unresolved: PendingQueueEntry[] = composePendingJson(entries)
    .pending.filter((p) => !p.resolved)
    .map(({ resolved: _resolved, ...rest }) => rest);
  const pendingHead: PendingQueueEntry | null = unresolved[0] ?? null;
  const pendingQueueDepth = unresolved.length;

  // active_tasks: TaskState.status === "in_progress" literal per
  // src/core/reducer.ts:62-66 (codex r279 D + r280 D confirmed).
  const activeTasks = snapshot.tasks.filter((t) => t.status === "in_progress").map((t) => t.id);

  // feature: canonical source is the session:started payload. The
  // rev-4.0 C9' invariant (feature == basename(dirname(state.json)))
  // still holds in production because callers compute
  // featureDir = `cwd/.loaf/<feature>`, but the canonical name lives
  // in the journal — use it directly so tmpdir featureDir paths in
  // tests don't poison the projection. `RegistryFile.feature` is
  // `z.string().min(1)` (matches `SessionStartedPayload.feature` —
  // codex r281 P2 / r282 lockstep widen); kebab-case stays a
  // convention for production users, not a schema-enforced regex.
  const feature = startPayload.feature;

  return RegistryFile.parse({
    schema_version: PROJECTION_SCHEMA_VERSION,
    at: now.toISOString(),
    session_id: state.session_id,
    session_label: sessionLabel,
    feature,
    cwd,
    workspace,
    phase: state.phase,
    sub_state: state.sub_state,
    iteration: state.iteration,
    active_tasks: activeTasks,
    pending: pendingHead,
    pending_queue_depth: pendingQueueDepth,
    ceremony_label: ceremonyLabel,
  });
}

export interface WriteRegistryFileOptions {
  /** Override the registry directory. Production = `defaultRegistryDir()`
   *  (i.e. `~/.loaf/registry/`). Tests inject a tmp dir to avoid
   *  touching the real user registry — see
   *  tests/cli/registry-end-to-end.test.ts. */
  registryDir?: string;
}

/** Atomic temp+rename write to `<registryDir>/<sessionId>.json`.
 *
 *  Writes with mode 0o600 (per §4.12) so other users on the same host
 *  cannot read cwd / session_label. Creates `<registryDir>` recursively
 *  on first write (parent-dir mode is intentionally not constrained by
 *  protocol — codex r280 non-blocking).
 *
 *  Atomicity: writes to `<registryDir>/<sessionId>.json.tmp-<random>`,
 *  then renames over the target. POSIX rename(2) is atomic — readers
 *  see either the old file or the new file, never a torn write.
 *
 *  Best-effort: throws on IO failure; the mutateBatch step 9 caller
 *  catches + silences per §4.12 (registry is stale-tolerant; doctor
 *  --rebuild-registry recovers). */
export async function writeRegistryFile(
  sessionId: string,
  file: RegistryFile,
  opts: WriteRegistryFileOptions = {},
): Promise<void> {
  const registryDir = opts.registryDir ?? defaultRegistryDir();
  await fs.mkdir(registryDir, { recursive: true });

  const target = path.join(registryDir, `${sessionId}.json`);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    await fs.writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    // Best-effort cleanup of tmp on rename failure.
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}
