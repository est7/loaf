// Stage 3 — batch atomicity (ADR-0005 §4.16).
//
// Four scenarios validating batch markers and atomic group semantics. A batch
// is a set of entries sharing batch_id with batch_index 0..N-1 of batch_count.
// The reducer must treat the group atomically: replay either applies all N
// entries (a complete batch) or zero (a partial batch is truncated by tail
// recovery; replay never sees one).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { replayJournal, tailRecovery } from "../../src/core/journal-bootstrap.js";
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-batch-"));
  return path.join(dir, "journal.jsonl");
}

function startEntry(): JournalEntry {
  return {
    seq: 0,
    entry_id: "JE-000001",
    at: "2026-05-15T10:00:00.000Z",
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind: "session:started",
    payload: {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "auth-refresh",
      ceremony: STANDARD,
    },
  };
}

function pendingEntry(seq: number, batchId: string, batchIndex: number, batchCount: number): JournalEntry {
  return {
    seq,
    entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
    at: `2026-05-15T10:00:0${seq}.000Z`,
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind: "pending:added",
    payload: { id: `PEND-${seq}` },
    batch_id: batchId,
    batch_index: batchIndex,
    batch_count: batchCount,
  };
}

function serialize(e: JournalEntry): string {
  return JSON.stringify(e) + "\n";
}

describe("batch atomicity — ADR-0005 §4.16", () => {
  test("Scenario 1: complete batch (3-of-3) replays cleanly", async () => {
    const fp = await tmpJournal();
    const batchId = "a1b2c3d4-e5f6-4a78-9b0c-1d2e3f4a5b6c";
    const lines = [
      startEntry(),
      pendingEntry(1, batchId, 0, 3),
      pendingEntry(2, batchId, 1, 3),
      pendingEntry(3, batchId, 2, 3),
    ];
    await fs.writeFile(fp, lines.map(serialize).join(""));

    const r = await replayJournal(fp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries_applied).toBe(4);
      expect(r.meta.last_applied_seq).toBe(3);
    }
  });

  test("Scenario 2: partial batch (3-declared, 2-written) is truncated by tail recovery", async () => {
    const fp = await tmpJournal();
    const batchId = "a1b2c3d4-e5f6-4a78-9b0c-1d2e3f4a5b6c";
    const lines = [
      startEntry(),
      pendingEntry(1, batchId, 0, 3),
      pendingEntry(2, batchId, 1, 3),
      // batch_index=2 never written (crash)
    ];
    await fs.writeFile(fp, lines.map(serialize).join(""));

    const recovery = await tailRecovery(fp);
    expect(recovery.action).toBe("drop_partial_batch");
    expect(recovery.truncated_entries).toBe(2);

    const r = await replayJournal(fp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Only the prelude session:started survives.
      expect(r.entries_applied).toBe(1);
      expect(r.meta.last_applied_seq).toBe(0);
    }
  });

  test("Scenario 3: batch_count=1 (singleton batch) is complete", async () => {
    const fp = await tmpJournal();
    const batchId = "a1b2c3d4-e5f6-4a78-9b0c-1d2e3f4a5b6c";
    const lines = [
      startEntry(),
      pendingEntry(1, batchId, 0, 1),
    ];
    await fs.writeFile(fp, lines.map(serialize).join(""));

    const recovery = await tailRecovery(fp);
    expect(recovery.action).toBe("noop");

    const r = await replayJournal(fp);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries_applied).toBe(2);
  });

  test("Scenario 4: batch followed by non-batch entry (cleanup) replays cleanly", async () => {
    const fp = await tmpJournal();
    const batchId = "a1b2c3d4-e5f6-4a78-9b0c-1d2e3f4a5b6c";
    const lines = [
      startEntry(),
      pendingEntry(1, batchId, 0, 2),
      pendingEntry(2, batchId, 1, 2),
      // Solo (non-batch) entry after the batch
      {
        seq: 3,
        entry_id: "JE-000004",
        at: "2026-05-15T10:00:03.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "pending:resolved" as const,
        payload: { id: "PEND-1" },
      } as JournalEntry,
    ];
    await fs.writeFile(fp, lines.map(serialize).join(""));

    const recovery = await tailRecovery(fp);
    expect(recovery.action).toBe("noop");

    const r = await replayJournal(fp);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries_applied).toBe(4);
  });
});
