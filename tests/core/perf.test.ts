// Stage 6 — Journal replay perf benchmark (ADR-0005 §4.15, plan.md §5 pin).
//
// Pinned budgets (user direction during Stage 6):
//   - 10K-entry full replay  : < 1_000ms
//   - 100K-entry full replay : < 10_000ms
//
// These are v0.1.0 release blockers. Regression → benchmark fails the suite.
//
// Test strategy:
//   - Setup writes the journal directly via fs.writeFile (one big buffer) so
//     we measure replay perf, not appendEntry per-entry I/O overhead.
//   - Entries are simple pending:added kinds with small payloads — keeps the
//     per-entry shape representative without amplifying allocation cost.
//   - We time only `replayJournal()` itself (not setup).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { replayJournal } from "../../src/core/journal-bootstrap.js";
import type { Ceremony, JournalEntry } from "../../src/core/journal-entry.js";

const STANDARD: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

async function tmpJournal(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-perf-"));
  return path.join(dir, "journal.jsonl");
}

function startLine(): string {
  return JSON.stringify({
    seq: 0,
    entry_id: "JE-000001",
    at: "2026-05-15T10:00:00.000Z",
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind: "session:started",
    payload: {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "perf-feature",
      ceremony: STANDARD,
    },
  } as JournalEntry);
}

function pendingLine(seq: number): string {
  return JSON.stringify({
    seq,
    entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
    at: `2026-05-15T10:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind: "pending:added",
    // Slice 3 SC1: PendingAddedPayload canonical PEND-\d{4,} + question.
    payload: {
      id: `PEND-${String(seq).padStart(4, "0")}`,
      kind: "ask_user_question",
      question: "stub",
    },
  } as JournalEntry);
}

async function writeJournal(filePath: string, n: number): Promise<void> {
  const chunks: string[] = [startLine() + "\n"];
  for (let seq = 1; seq < n; seq++) {
    chunks.push(pendingLine(seq) + "\n");
  }
  // Single bulk write — measures replay, not append.
  await fs.writeFile(filePath, chunks.join(""));
}

describe("replayJournal perf — Stage 6 (ADR-0005 §4.15, user-pinned)", () => {
  test("10K entries replay < 1000ms", async () => {
    const filePath = await tmpJournal();
    await writeJournal(filePath, 10_000);

    const t0 = performance.now();
    const result = await replayJournal(filePath);
    const elapsed = performance.now() - t0;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries_applied).toBe(10_000);
    }
    expect(elapsed).toBeLessThan(1_000);
    // eslint-disable-next-line no-console
    console.log(`  10K replay: ${elapsed.toFixed(1)}ms`);
  }, 15_000);

  test("100K entries replay < 10_000ms", async () => {
    const filePath = await tmpJournal();
    await writeJournal(filePath, 100_000);

    const t0 = performance.now();
    const result = await replayJournal(filePath);
    const elapsed = performance.now() - t0;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries_applied).toBe(100_000);
    }
    expect(elapsed).toBeLessThan(10_000);
    // eslint-disable-next-line no-console
    console.log(`  100K replay: ${elapsed.toFixed(1)}ms`);
  }, 60_000);
});
