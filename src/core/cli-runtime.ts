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

import { promises as fs } from "node:fs";
import path from "node:path";

import { replayJournal } from "./journal-bootstrap.js";
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
}

export async function loadSession(featureDir: string): Promise<SessionLoad> {
  await fs.mkdir(featureDir, { recursive: true });
  const journalPath = path.join(featureDir, "journal.jsonl");
  const replay = await replayJournal(journalPath, { feature_dir: featureDir });
  if (!replay.ok) {
    throw new Error(`failed to load session at ${featureDir}: ${replay.code} — ${replay.message}`);
  }
  return {
    feature_dir: featureDir,
    snapshot: replay.entries_applied === 0 ? initialSnapshot() : replay.snapshot,
    tail_seq: replay.meta.last_applied_seq,
  };
}

export function defaultFeatureDir(feature: string): string {
  return path.join(process.cwd(), ".loaf", feature);
}
