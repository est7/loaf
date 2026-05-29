// Phase 16 SC-9b — `loaf sessions list` read-side surface.
//
// Per protocol §1932 + §1588: terminal-recovery UX for `--session`
// dispatch. Walks `~/.loaf/registry/<id>.json` files (SC-7 output);
// per-row Zod parse via `RegistryFile`; malformed entries skipped but
// SURFACED via warnings (codex r290 P2 — silent skip would make UUID
// recovery look broken). `--in-cwd` filters by canonical cwd match;
// orphan-cwd registry entries (registry's cwd field points at deleted
// dir) are also surfaced via warnings (codex r290 P3).
//
// Returns ISO-only data per codex r290 nit-2; relative-time formatting
// belongs in the presentation layer (cli.tsx with injected `now`).

import { promises as fs } from "node:fs";
import path from "node:path";

import { defaultRegistryDir } from "../core/registry-writer.js";
import { RegistryFile } from "../core/projection-schema.js";

export interface SessionRow {
  /** Full UUID (registry session_id). */
  session_id: string;
  /** First 8 chars of session_id — what users type for short-form
   *  `--session` (≥8 chars per protocol §1586). */
  session_id_short: string;
  /** Phase 16 SC-14 (codex r355 P1): human-friendly session label from
   *  `loaf start --label`; empty string when not set (per registry
   *  schema `z.string()` with empty-string fallback). TUI LABEL column
   *  falls back to `feature` when this is empty. */
  session_label: string;
  feature: string;
  phase: string;
  sub_state: string;
  /** Registry refresh time (≈ last update; codex r290 nit-1). ISO-8601. */
  at: string;
  cwd: string;
  workspace: string;
  iteration: number;
  pending_queue_depth: number;
  /** Phase 16 SC-14 (codex r353 P1): in-progress task ids from
   *  `registry.active_tasks` (default [] when no worker is mid-task).
   *  TUI STATUS column renders `▶ run [×N]` from this. */
  active_tasks: string[];
  ceremony_label: string;
}

export interface ListSessionsWarning {
  /** Registry file basename (e.g. `<uuid>.json`). */
  file: string;
  reason:
    | "corrupt-json"        // JSON.parse failed
    | "schema-invalid"      // Zod parse failed
    | "orphan-cwd"          // registry's cwd field points at deleted dir
    | "io-error";           // file read failed (rare; not ENOENT)
  detail?: string;
}

export interface ListSessionsResult {
  ok: true;
  rows: SessionRow[];
  warnings: ListSessionsWarning[];
}

export interface ListSessionsInput {
  /** Override registry dir. Production omits → defaultRegistryDir()
   *  which honors LOAF_REGISTRY_DIR env (SC-7 test isolation). */
  registryDir?: string;
  /** When set, filter to rows whose canonical `cwd` matches this
   *  canonical path. Caller is responsible for canonicalizing
   *  (typically via `fs.realpath(process.cwd())`). When undefined,
   *  ALL rows are listed (no cwd filter). */
  filterCwd?: string;
}

/** Canonicalize a path via fs.realpath. Returns null on any error
 *  (ENOENT, permissions, etc.) so the caller can treat unresolvable
 *  paths as orphan candidates. */
async function tryRealpath(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

export async function listSessions(
  input: ListSessionsInput,
): Promise<ListSessionsResult> {
  const registryDir = input.registryDir ?? defaultRegistryDir();
  const rows: SessionRow[] = [];
  const warnings: ListSessionsWarning[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(registryDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Empty registry dir is normal (pre-first-loaf-start). Empty list,
      // no warnings.
      return { ok: true, rows: [], warnings: [] };
    }
    return {
      ok: true,
      rows: [],
      warnings: [{ file: registryDir, reason: "io-error", detail: (err as Error).message }],
    };
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(registryDir, entry);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (err) {
      warnings.push({ file: entry, reason: "io-error", detail: (err as Error).message });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      warnings.push({ file: entry, reason: "corrupt-json", detail: (err as Error).message });
      continue;
    }

    const result = RegistryFile.safeParse(parsed);
    if (!result.success) {
      warnings.push({
        file: entry,
        reason: "schema-invalid",
        detail: result.error.issues.map((i) => i.message).join("; "),
      });
      continue;
    }
    const reg = result.data;

    // Orphan-cwd check: canonicalize the registry's recorded cwd.
    // null → cwd no longer exists / unresolvable.
    const canonicalRegCwd = await tryRealpath(reg.cwd);
    if (canonicalRegCwd === null) {
      // Surface as orphan even when not filtering by --in-cwd, so
      // users get a hint that doctor --rebuild-registry (future) can
      // clean stale entries.
      warnings.push({
        file: entry,
        reason: "orphan-cwd",
        detail: `registered cwd '${reg.cwd}' no longer exists`,
      });
      // If filterCwd is set, orphan rows are NOT a match (their cwd
      // can't be compared canonically). They're also skipped from
      // the rows list when filtering — user asked for "current cwd only".
      if (input.filterCwd !== undefined) continue;
    } else if (input.filterCwd !== undefined && canonicalRegCwd !== input.filterCwd) {
      // Filter mismatch — skip silently (not an error).
      continue;
    }

    rows.push({
      session_id: reg.session_id,
      session_id_short: reg.session_id.slice(0, 8),
      session_label: reg.session_label,
      feature: reg.feature,
      phase: reg.phase,
      sub_state: reg.sub_state,
      at: reg.at,
      cwd: reg.cwd,
      workspace: reg.workspace,
      iteration: reg.iteration,
      pending_queue_depth: reg.pending_queue_depth,
      active_tasks: reg.active_tasks,
      ceremony_label: reg.ceremony_label,
    });
  }

  // Sort by `at` descending (most recent first). String ISO compare is
  // chronological for fixed-format ISO-8601.
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return { ok: true, rows, warnings };
}

/** Presentation helper — relative-time rendering for text mode. Returns
 *  "N minutes/hours/days ago" for ≤7 days, ISO otherwise. Future
 *  timestamps fall back to ISO (defensive — clock skew). */
export function formatAtRelative(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const diffMs = now.getTime() - at.getTime();
  if (diffMs < 0) return iso;
  const SEVEN_DAYS_MS = 7 * 86_400_000;
  if (diffMs >= SEVEN_DAYS_MS) return iso;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
