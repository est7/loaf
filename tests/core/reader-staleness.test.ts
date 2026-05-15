// Stage 6 — Reader staleness contract (Gate #5, ADR-0005 §3.6 + §4.19).
//
// Any read-side caller that consumes snapshots/<projection>.json MUST first
// pass _meta.json through checkSnapshotFresh against the journal. On
// mismatch the reader exits 2 SNAPSHOT_STALE_REBUILD_REQUIRED — no silent
// fallback. This test file exercises the contract through the public
// checkSnapshotFresh() API.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { appendEntry } from "../../src/core/journal-append.js";
import { checkSnapshotFresh } from "../../src/core/snapshot-reader.js";
import { computeLineHash, emptyMeta } from "../../src/core/snapshot.js";
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-stale-"));
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

describe("checkSnapshotFresh — Gate #5", () => {
  test("journal absent + meta empty → fresh (initial state)", async () => {
    const filePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "loaf-stale-")),
      "journal.jsonl",
    );
    const result = await checkSnapshotFresh(emptyMeta(), filePath);
    expect(result.fresh).toBe(false);
    if (!result.fresh) expect(result.reason).toBe("journal_missing");
  });

  test("journal has one entry + meta agrees → fresh", async () => {
    const filePath = await tmpJournal();
    const entry = startEntry();
    await appendEntry(filePath, entry, { fsync: false });

    const line = JSON.stringify(entry);
    const meta = {
      last_applied_seq: 0,
      last_entry_offset: 0,
      last_entry_line_hash: computeLineHash(line),
      rolling_checksum: "0".repeat(64),
    };
    const result = await checkSnapshotFresh(meta, filePath);
    expect(result.fresh).toBe(true);
    if (result.fresh) expect(result.last_applied_seq).toBe(0);
  });

  test("journal has more entries than meta last_applied_seq → tail_offset_mismatch", async () => {
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

    // Stale meta pinned at seq=0 (the first entry's offset/hash).
    const firstLine = JSON.stringify(startEntry());
    const meta = {
      last_applied_seq: 0,
      last_entry_offset: 0,
      last_entry_line_hash: computeLineHash(firstLine),
      rolling_checksum: "0".repeat(64),
    };
    const result = await checkSnapshotFresh(meta, filePath);
    expect(result.fresh).toBe(false);
    if (!result.fresh) {
      expect(result.code).toBe("SNAPSHOT_STALE_REBUILD_REQUIRED");
      expect(result.reason).toBe("tail_offset_mismatch");
    }
  });

  test("journal tail hash differs from meta → tail_hash_mismatch", async () => {
    const filePath = await tmpJournal();
    await appendEntry(filePath, startEntry(), { fsync: false });

    const line = JSON.stringify(startEntry());
    const meta = {
      last_applied_seq: 0,
      last_entry_offset: 0,
      last_entry_line_hash: "deadbeef".repeat(8), // garbage 64-hex
      rolling_checksum: "0".repeat(64),
    };
    expect(meta.last_entry_line_hash.length).toBe(64);

    const result = await checkSnapshotFresh(meta, filePath);
    expect(result.fresh).toBe(false);
    if (!result.fresh) {
      expect(result.code).toBe("SNAPSHOT_STALE_REBUILD_REQUIRED");
      expect(result.reason).toBe("tail_hash_mismatch");
      expect((result.detail as { actual: string }).actual).toBe(computeLineHash(line));
    }
  });

  test("journal tail missing trailing newline → trailing_partial_line", async () => {
    const filePath = await tmpJournal();
    await appendEntry(filePath, startEntry(), { fsync: false });
    // Truncate one byte to drop the final \n — simulates writer-mid-append.
    const stat = await fs.stat(filePath);
    await fs.truncate(filePath, stat.size - 1);

    const meta = {
      last_applied_seq: 0,
      last_entry_offset: 0,
      last_entry_line_hash: computeLineHash(JSON.stringify(startEntry())),
      rolling_checksum: "0".repeat(64),
    };
    const result = await checkSnapshotFresh(meta, filePath);
    expect(result.fresh).toBe(false);
    if (!result.fresh) expect(result.reason).toBe("trailing_partial_line");
  });

  test("empty journal + non-empty meta → journal_empty (stale)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-stale-"));
    const filePath = path.join(dir, "journal.jsonl");
    await fs.writeFile(filePath, "");

    const meta = {
      last_applied_seq: 5,
      last_entry_offset: 100,
      last_entry_line_hash: "deadbeef".repeat(8),
      rolling_checksum: "0".repeat(64),
    };
    const result = await checkSnapshotFresh(meta, filePath);
    expect(result.fresh).toBe(false);
    if (!result.fresh) expect(result.reason).toBe("journal_empty");
  });
});
