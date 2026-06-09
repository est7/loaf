// prune slice 1 — target resolution (pure core, no ctx / no formatting).
//
// Reads the session registry, applies the scope filter, then the two safety
// gates, and classifies each in-scope session into a target or a skip:
//   - status gate: only terminal (DONE.*) sessions by default; --force
//     (includeActive) widens it to active/in-flight too.
//   - lock gate (ABSOLUTE): a session whose feature-dir `.lock` is held has a
//     live writer → always skipped, even with --force.
// Orphans (registry entry whose feature dir is gone) cannot be locked and, in
// the dedicated `orphans` scope, bypass the status gate (the work is already
// gone). In other scopes an orphan is still status-gated but flagged so the
// executor degrades to registry-only removal.

import { promises as fs } from "node:fs";
import path from "node:path";

import { readRegistryEntry, tryRealpath } from "../../core/registry-read.js";

/** Terminal sub_states — the only sessions prune touches without --force. */
const TERMINAL_SUB_STATES: ReadonlySet<string> = new Set([
  "DONE.delivered",
  "DONE.archived",
  "DONE.abandoned",
]);

export type PruneScope =
  | { kind: "all" }
  | { kind: "session"; id: string }
  | { kind: "cwd"; cwd: string }
  | { kind: "orphans"; cwd?: string };

export interface PruneTarget {
  session_id: string;
  feature: string;
  cwd: string;
  sub_state: string;
  /** `<cwd>/.loaf/<feature>` — the dir the executor moves/removes. */
  feature_dir: string;
  /** feature_dir is gone ⇒ registry-only removal. */
  orphan: boolean;
}

export type PruneSkipReason = "non-terminal" | "locked" | "inaccessible";

export interface PruneSkip {
  session_id: string;
  reason: PruneSkipReason;
  sub_state: string;
}

export interface ResolveResult {
  targets: PruneTarget[];
  skipped: PruneSkip[];
}

export interface ResolveOptions {
  registryDir: string;
  scope: PruneScope;
  /** `--force` — widen the status gate to include active sessions. Never the lock gate. */
  includeActive: boolean;
}

/**
 * Three-way path probe. The boolean `exists ? : ` collapse is unsafe for the
 * lock/orphan gates (codex prune-slice-1 BLOCK): an `fs.stat` failure that is
 * NOT "the path is absent" (EACCES, EIO, …) must never be read as "missing" —
 * that would treat a held-but-unstatable `.lock` as unlocked (pruning live
 * work) or a present-but-unreadable feature dir as an orphan (registry-only
 * deletion). Only ENOENT / ENOTDIR are genuinely "missing"; everything else is
 * "error" and the caller stays conservative.
 */
type PathProbe = "exists" | "missing" | "error";

async function probePath(p: string): Promise<PathProbe> {
  try {
    await fs.stat(p);
    return "exists";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "error";
  }
}

export async function resolvePruneTargets(opts: ResolveOptions): Promise<ResolveResult> {
  const { registryDir, scope, includeActive } = opts;

  let files: string[];
  try {
    files = await fs.readdir(registryDir);
  } catch {
    // No registry dir ⇒ nothing to prune (ENOENT is "empty", not an error here).
    return { targets: [], skipped: [] };
  }
  const ids = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length));

  const targets: PruneTarget[] = [];
  const skipped: PruneSkip[] = [];

  // cwd scopes canonicalize BOTH sides so a symlinked / trailing-slash cwd still
  // matches the stored registry cwd (tracked 6b symmetry) — resolve owns the
  // canonicalization so callers may pass a raw or already-realpath'd cwd. Falls
  // back to the literal value when a path can't be resolved (e.g. dir deleted).
  let scopeCwd: string | undefined;
  if (scope.kind === "cwd") {
    scopeCwd = (await tryRealpath(scope.cwd)) ?? scope.cwd;
  } else if (scope.kind === "orphans" && scope.cwd !== undefined) {
    scopeCwd = (await tryRealpath(scope.cwd)) ?? scope.cwd;
  }

  for (const id of ids) {
    const read = await readRegistryEntry(registryDir, id);
    if (!read.ok) continue; // corrupt / unreadable entry — out of this slice's scope
    const e = read.file;

    // ── scope filter ───────────────────────────────────────────────
    if (scope.kind === "session" && !e.session_id.startsWith(scope.id)) continue;
    if (scopeCwd !== undefined) {
      const canon = (await tryRealpath(e.cwd)) ?? e.cwd;
      if (canon !== scopeCwd) continue;
    }

    const feature_dir = path.join(e.cwd, ".loaf", e.feature);
    const featProbe = await probePath(feature_dir);

    // Cannot determine existence ⇒ cannot verify it is safe to remove (it may
    // exist with a live lock we just can't read). Never target; report it.
    if (featProbe === "error") {
      skipped.push({ session_id: e.session_id, reason: "inaccessible", sub_state: e.sub_state });
      continue;
    }
    const orphan = featProbe === "missing"; // PROVEN missing only

    const target: PruneTarget = {
      session_id: e.session_id,
      feature: e.feature,
      cwd: e.cwd,
      sub_state: e.sub_state,
      feature_dir,
      orphan,
    };

    // ── orphans scope: only dangling entries; live dirs are out of scope ──
    if (scope.kind === "orphans") {
      if (orphan) targets.push(target);
      continue;
    }

    // ── status gate ────────────────────────────────────────────────
    if (!TERMINAL_SUB_STATES.has(e.sub_state) && !includeActive) {
      skipped.push({ session_id: e.session_id, reason: "non-terminal", sub_state: e.sub_state });
      continue;
    }

    // ── lock gate (ABSOLUTE; only meaningful when the dir exists) ────
    // A held `.lock` → "locked"; a lock probe we cannot read → "inaccessible".
    // Both skip — `--force` widens the status gate above, never this one.
    if (!orphan) {
      const lockProbe = await probePath(path.join(feature_dir, ".lock"));
      if (lockProbe === "exists") {
        skipped.push({ session_id: e.session_id, reason: "locked", sub_state: e.sub_state });
        continue;
      }
      if (lockProbe === "error") {
        skipped.push({ session_id: e.session_id, reason: "inaccessible", sub_state: e.sub_state });
        continue;
      }
    }

    targets.push(target);
  }

  return { targets, skipped };
}
