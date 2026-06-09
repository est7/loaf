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

import { readRegistryEntry } from "../../core/registry-read.js";

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

export type PruneSkipReason = "non-terminal" | "locked";

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

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
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

  for (const id of ids) {
    const read = await readRegistryEntry(registryDir, id);
    if (!read.ok) continue; // corrupt / unreadable entry — out of this slice's scope
    const e = read.file;

    // ── scope filter ───────────────────────────────────────────────
    if (scope.kind === "session" && !e.session_id.startsWith(scope.id)) continue;
    if (scope.kind === "cwd" && e.cwd !== scope.cwd) continue;
    if (scope.kind === "orphans" && scope.cwd !== undefined && e.cwd !== scope.cwd) continue;

    const feature_dir = path.join(e.cwd, ".loaf", e.feature);
    const orphan = !(await pathExists(feature_dir));

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

    // ── lock gate (absolute; only meaningful when the dir exists) ────
    if (!orphan && (await pathExists(path.join(feature_dir, ".lock")))) {
      skipped.push({ session_id: e.session_id, reason: "locked", sub_state: e.sub_state });
      continue;
    }

    targets.push(target);
  }

  return { targets, skipped };
}
