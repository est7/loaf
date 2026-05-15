// Stage 3 — journal replay (ADR-0005 §3.6).
//
// replayJournal(filePath) reads journal.jsonl end-to-end, applies every entry
// through reducer.apply, and returns Snapshot + SnapshotMeta. Empty/absent
// journals yield the initial snapshot. Entries that fail the reducer surface
// as typed errors with at_seq.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { appendEntry } from "../../src/core/journal-append.js";
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-replay-"));
  return path.join(dir, "journal.jsonl");
}

function startEntry(seq = 0, entryId = "JE-000001"): JournalEntry {
  return {
    seq,
    entry_id: entryId,
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

describe("replayJournal — Stage 3 §3.6", () => {
  test("absent journal returns empty initial snapshot", async () => {
    const filePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "loaf-replay-")),
      "journal.jsonl",
    );
    const result = await replayJournal(filePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries_applied).toBe(0);
      expect(result.snapshot.state).toBeNull();
    }
  });

  test("single session:started entry yields initialized snapshot + meta", async () => {
    const filePath = await tmpJournal();
    await appendEntry(filePath, startEntry(), { fsync: false });

    const result = await replayJournal(filePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries_applied).toBe(1);
      expect(result.snapshot.state).not.toBeNull();
      expect(result.snapshot.state!.sub_state).toBe("TRIAGE.score");
      expect(result.meta.last_applied_seq).toBe(0);
      expect(result.meta.last_entry_line_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.meta.rolling_checksum).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test("multiple entries advance the cursor through transitions", async () => {
    const filePath = await tmpJournal();
    await appendEntry(filePath, startEntry(), { fsync: false });
    await appendEntry(
      filePath,
      {
        seq: 1,
        entry_id: "JE-000002",
        at: "2026-05-15T10:00:01.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: "TRIAGE.score", to: "TRIAGE.confirm" },
      },
      { fsync: false },
    );

    const result = await replayJournal(filePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries_applied).toBe(2);
      expect(result.snapshot.state!.sub_state).toBe("TRIAGE.confirm");
      expect(result.meta.last_applied_seq).toBe(1);
    }
  });

  test("malformed JSON line returns INVALID_ENTRY with at_seq", async () => {
    const filePath = await tmpJournal();
    await appendEntry(filePath, startEntry(), { fsync: false });
    await fs.appendFile(filePath, "not-json-at-all\n");

    const result = await replayJournal(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_ENTRY");
      expect(result.at_seq).toBe(1);
    }
  });
});
