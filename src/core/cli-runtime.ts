// cli-runtime — shared helpers for the loaf CLI surface (audit r1 Blocker #7).
//
// Build-time URL stamping (LOAF_DOCS_URL / LOAF_ISSUE_URL) is wired via
// tsdown's `define` option. At runtime these are concrete strings rather
// than process.env lookups, so the binary is self-contained and the CI
// release pipeline can grep for `*.invalid` sentinel values to detect
// unstamped builds.
//
// `loadSession(featureDir)` provides the read-side bootstrap used by every
// mutator command — replays the journal (with sidecar-aware migration
// rehydration when applicable), surfaces typed errors, and returns the
// in-memory snapshot + tail seq so commands can call `mutate()`.

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { replayJournal } from "./journal-bootstrap.js";
import type { JournalEntry } from "./journal-entry.js";
import { initialSnapshot, type Snapshot } from "./reducer.js";

// These are replaced at build time via tsdown's `define`. Dev / test runs
// fall back to `.invalid` sentinels so CI can spot unstamped binaries.
declare const __LOAF_DOCS_URL__: string;
declare const __LOAF_ISSUE_URL__: string;

export const LOAF_DOCS_URL: string =
  typeof __LOAF_DOCS_URL__ !== "undefined" ? __LOAF_DOCS_URL__ : "https://docs.loaf.invalid";
export const LOAF_ISSUE_URL: string =
  typeof __LOAF_ISSUE_URL__ !== "undefined" ? __LOAF_ISSUE_URL__ : "https://issues.loaf.invalid";

export function helpFooter(): string {
  return `\ndocs:       ${LOAF_DOCS_URL}\nreport bug: ${LOAF_ISSUE_URL}\n`;
}

export interface SessionLoad {
  feature_dir: string;
  snapshot: Snapshot;
  tail_seq: number;
  /** The parsed entries of the replayed journal, in order (Slice C SC-C2a).
   *  `loadSession` always requests collection so commands that need the
   *  canonical full task body (`tasks amend`) can call `latestCanonicalTaskBody`
   *  against the same replay prefix that produced `snapshot` — no second
   *  journal read, no TOCTOU gap. Empty for a fresh feature. */
  entries: JournalEntry[];
}

export async function loadSession(featureDir: string): Promise<SessionLoad> {
  await fs.mkdir(featureDir, { recursive: true });
  const journalPath = path.join(featureDir, "journal.jsonl");
  const replay = await replayJournal(journalPath, {
    feature_dir: featureDir,
    collect_entries: true,
  });
  if (!replay.ok) {
    throw new Error(`failed to load session at ${featureDir}: ${replay.code} — ${replay.message}`);
  }
  // collect_entries:true above guarantees `entries` is present on a
  // successful replay. Fail fast rather than `?? []` — a silent empty
  // fallback would hand SC-C2b an empty canonical history and make
  // `tasks amend` falsely report TASK_NOT_FOUND (codex r107 BLOCK).
  if (replay.entries === undefined) {
    throw new Error(
      "internal invariant: replayJournal returned ok with collect_entries=true but no entries",
    );
  }
  return {
    feature_dir: featureDir,
    snapshot: replay.entries_applied === 0 ? initialSnapshot() : replay.snapshot,
    tail_seq: replay.meta.last_applied_seq,
    entries: replay.entries,
  };
}

export function defaultFeatureDir(feature: string): string {
  return path.join(process.cwd(), ".loaf", feature);
}

/**
 * Read git's configured user.email. Tiny boundary helper for
 * actor-resolver; resolver remains the policy owner. Returns null when
 * git is unavailable or no email is configured (the resolver treats
 * either case as "no git fallback available").
 *
 * Uses execFileSync (not execSync) so there is no shell parsing path —
 * no dynamic input here, but the cleaner CLI boundary by default
 * (codex r31 Q2.1).
 */
export function getGitEmail(): string | null {
  try {
    const out = execFileSync("git", ["config", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed.length === 0 ? null : trimmed;
  } catch {
    return null;
  }
}
