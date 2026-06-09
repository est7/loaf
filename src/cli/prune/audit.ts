// prune slice 4 — append-only audit log (M2).
//
// A kernel that journals every state change must not delete sessions without a
// record. Each executed prune appends one JSONL line to the prune log
// (~/.loaf/prune-log.jsonl in production; injected here); `loaf prune --history`
// reads it back. The trash is passive recovery; this log is the queryable
// record of WHAT was pruned, WHEN, by WHOM, and in which mode.

import { promises as fs } from "node:fs";
import path from "node:path";

export interface PruneAuditEntry {
  /** ISO timestamp (injected by the caller — no Date here). */
  at: string;
  /** Human description of the scope, e.g. "all" / "session:<id>" / "cwd:<path>". */
  scope: string;
  mode: "trash" | "purge";
  /** Operator (from $LOAF_USER / git), for accountability. */
  actor: string;
  pruned: { session_id: string; feature: string; orphan: boolean }[];
  skipped?: { session_id: string; reason: string }[];
  /** Targets that errored mid-execute — the durable record must preserve a
   *  partial failure, not just the successful deletions (codex 6a BLOCK). */
  failed?: { session_id: string; error: string }[];
}

export async function appendPruneLog(logPath: string, entry: PruneAuditEntry): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readPruneLog(logPath: string): Promise<PruneAuditEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch {
    return []; // no log yet
  }
  const out: PruneAuditEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue; // tolerate blank lines
    try {
      out.push(JSON.parse(trimmed) as PruneAuditEntry);
    } catch {
      // A single corrupt line must not break `--history`; skip it.
    }
  }
  return out;
}
