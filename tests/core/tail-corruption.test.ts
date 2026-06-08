// Stage 3 — tail recovery (Gate #4, ADR-0005 §4.13).
//
// Seven scenarios validating batch-aware journal tail truncation:
//   1. Empty file → noop
//   2. Single complete entry → noop
//   3. Trailing partial line (no \n) → drop the partial line
//   4. Trailing invalid JSON line → drop the invalid line
//   5. Complete entries followed by partial line → drop only partial line
//   6. Complete batch (all batch_count entries written) → noop
//   7. Partial batch (batch_count entries declared, fewer written) → drop all
//      batch entries

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { tailRecovery } from "../../src/core/journal-bootstrap.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";

async function tmpJournal(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-tail-"));
  return path.join(dir, "journal.jsonl");
}

function singleEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    seq: 0,
    entry_id: "JE-000001",
    at: "2026-05-15T10:00:00.000Z",
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind: "pending:added",
    payload: { id: "PEND-001" },
    ...overrides,
  };
}

function serialize(entry: JournalEntry): string {
  return JSON.stringify(entry) + "\n";
}

async function writeRaw(filePath: string, body: string): Promise<void> {
  await fs.writeFile(filePath, body);
}

describe("tailRecovery — Gate #4 (ADR-0005 §4.13)", () => {
  test("Scenario 1: empty file → noop", async () => {
    const fp = await tmpJournal();
    await writeRaw(fp, "");
    const r = await tailRecovery(fp);
    expect(r.action).toBe("noop");
    expect(r.truncated_bytes).toBe(0);
    expect(r.truncated_entries).toBe(0);
  });

  test("Scenario 2: single complete entry → noop", async () => {
    const fp = await tmpJournal();
    await writeRaw(fp, serialize(singleEntry()));
    const r = await tailRecovery(fp);
    expect(r.action).toBe("noop");
    expect(r.truncated_bytes).toBe(0);
  });

  test("Scenario 3: trailing partial line (no \\n) → drop partial line", async () => {
    const fp = await tmpJournal();
    const e = singleEntry();
    await writeRaw(fp, serialize(e) + '{"seq":1,"partial":'); // no newline, mid-write
    const r = await tailRecovery(fp);
    expect(r.action).toBe("drop_partial_line");
    expect(r.truncated_entries).toBe(0);
    expect(r.truncated_bytes).toBeGreaterThan(0);

    // File should still contain the original valid entry.
    const contents = await fs.readFile(fp, "utf8");
    expect(contents).toBe(serialize(e));
  });

  test("Scenario 4: trailing invalid JSON line → drop invalid line", async () => {
    const fp = await tmpJournal();
    const e = singleEntry();
    await writeRaw(fp, serialize(e) + "garbage-not-json\n");
    const r = await tailRecovery(fp);
    expect(r.action).toBe("drop_invalid_tail");
    expect(r.truncated_entries).toBe(1);

    const contents = await fs.readFile(fp, "utf8");
    expect(contents).toBe(serialize(e));
  });

  test("Scenario 5: complete entries + trailing partial line → drop only partial", async () => {
    const fp = await tmpJournal();
    const a = singleEntry({ seq: 0, entry_id: "JE-000001" });
    const b = singleEntry({ seq: 1, entry_id: "JE-000002" });
    await writeRaw(fp, serialize(a) + serialize(b) + '{"seq":2,"partial":');
    const r = await tailRecovery(fp);
    expect(r.action).toBe("drop_partial_line");

    const contents = await fs.readFile(fp, "utf8");
    expect(contents).toBe(serialize(a) + serialize(b));
  });

  test("Scenario 6: complete batch (all batch_count entries) → noop", async () => {
    const fp = await tmpJournal();
    const batchId = "550e8400-e29b-41d4-a716-446655440000";
    const lines = [
      singleEntry({
        seq: 0,
        entry_id: "JE-000001",
        batch_id: batchId,
        batch_index: 0,
        batch_count: 3,
      }),
      singleEntry({
        seq: 1,
        entry_id: "JE-000002",
        batch_id: batchId,
        batch_index: 1,
        batch_count: 3,
      }),
      singleEntry({
        seq: 2,
        entry_id: "JE-000003",
        batch_id: batchId,
        batch_index: 2,
        batch_count: 3,
      }),
    ];
    await writeRaw(fp, lines.map(serialize).join(""));
    const r = await tailRecovery(fp);
    expect(r.action).toBe("noop");

    const contents = await fs.readFile(fp, "utf8");
    expect(contents).toBe(lines.map(serialize).join(""));
  });

  test("Scenario 7: partial batch (batch_count=3, only 2 written) → drop entire batch", async () => {
    const fp = await tmpJournal();
    const prelude = singleEntry({ seq: 0, entry_id: "JE-000001" });
    const batchId = "550e8400-e29b-41d4-a716-446655440000";
    const partial = [
      singleEntry({
        seq: 1,
        entry_id: "JE-000002",
        batch_id: batchId,
        batch_index: 0,
        batch_count: 3,
      }),
      singleEntry({
        seq: 2,
        entry_id: "JE-000003",
        batch_id: batchId,
        batch_index: 1,
        batch_count: 3,
      }),
    ];
    await writeRaw(fp, serialize(prelude) + partial.map(serialize).join(""));
    const r = await tailRecovery(fp);
    expect(r.action).toBe("drop_partial_batch");
    expect(r.truncated_entries).toBe(2);

    const contents = await fs.readFile(fp, "utf8");
    expect(contents).toBe(serialize(prelude));
  });
});
