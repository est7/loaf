// Stage 1 — journal-append acceptance tests (TDD vertical slices).
//
// Spec source: docs/protocol.md §11.2 + docs/schemas.ts §0a + ADR-0005 §3.2 / §3.5.
// Tests verify behavior through the public `appendEntry` API, not implementation
// details. Each test is a vertical slice (one behavior → one impl cycle).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { AppendError, appendEntry } from "../../src/core/journal-append.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";

async function tmpJournal(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-journal-"));
  return path.join(dir, "journal.jsonl");
}

describe("appendEntry — Stage 1", () => {
  function validEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
    return {
      seq: 0,
      entry_id: "JE-000001",
      at: "2026-05-15T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      // pending:added uses RecordPayload (any object), keeps the test
      // focused on the envelope path rather than session bootstrap shape.
      kind: "pending:added",
      payload: { id: "PEND-001", note: "auth-refresh" },
      ...overrides,
    };
  }

  // ── A: tracer bullet ────────────────────────────────────────────────────
  test("A. appends a valid minimal entry to an empty journal file", async () => {
    const filePath = await tmpJournal();

    const entry: JournalEntry = {
      seq: 0,
      entry_id: "JE-000001",
      at: "2026-05-15T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "auth-refresh",
        ceremony: {
          spec_phase: true,
          verify_phase: true,
          settle_phase: false,
          strict_spec_review: false,
          lessons_required: "skip",
          strict_drift_check: false,
        },
      },
    };

    await appendEntry(filePath, entry, { fsync: false });

    const contents = await fs.readFile(filePath, "utf8");
    expect(contents).toBe(JSON.stringify(entry) + "\n");

    // round-trip: file content can be parsed back into a structurally equal entry
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(entry);
  });

  // ── B: envelope rejects missing required fields ─────────────────────────
  test("B. entry missing required envelope field → INVALID_ENVELOPE, file untouched", async () => {
    const filePath = await tmpJournal();

    // Cast through unknown — TS would reject this, but we are guarding the
    // runtime boundary against malformed input that bypassed the type system
    // (e.g. parsed from external JSON).
    const missingSeq = { ...validEntry(), seq: undefined } as unknown as JournalEntry;

    await expect(appendEntry(filePath, missingSeq, { fsync: false })).rejects.toBeInstanceOf(
      AppendError,
    );
    await expect(appendEntry(filePath, missingSeq, { fsync: false })).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
    });

    // File must not be created or written by a rejected append.
    await expect(fs.readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  // ── C: actor format ─────────────────────────────────────────────────────
  test("C. actor missing namespace prefix → INVALID_ENVELOPE", async () => {
    const filePath = await tmpJournal();
    const bad = validEntry({ actor: "alice" as JournalEntry["actor"] });
    await expect(appendEntry(filePath, bad, { fsync: false })).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
    });
    await expect(fs.readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("C. actor with unknown namespace prefix → INVALID_ENVELOPE", async () => {
    const filePath = await tmpJournal();
    const bad = validEntry({ actor: "robot:bob" as JournalEntry["actor"] });
    await expect(appendEntry(filePath, bad, { fsync: false })).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
    });
  });

  // ── D: entry_id format ──────────────────────────────────────────────────
  test("D. entry_id with wrong prefix → INVALID_ENVELOPE", async () => {
    const filePath = await tmpJournal();
    const bad = validEntry({ entry_id: "EV-000001" as JournalEntry["entry_id"] });
    await expect(appendEntry(filePath, bad, { fsync: false })).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
    });
  });

  test("D. entry_id with fewer than 6 digits → INVALID_ENVELOPE", async () => {
    const filePath = await tmpJournal();
    const bad = validEntry({ entry_id: "JE-1" as JournalEntry["entry_id"] });
    await expect(appendEntry(filePath, bad, { fsync: false })).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
    });
  });

  // ── E: entry_schema_version ─────────────────────────────────────────────
  test("E. entry_schema_version missing → INVALID_ENVELOPE", async () => {
    const filePath = await tmpJournal();
    const bad = { ...validEntry(), entry_schema_version: undefined } as unknown as JournalEntry;
    await expect(appendEntry(filePath, bad, { fsync: false })).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
    });
  });

  test("E. entry_schema_version ≤ 0 → INVALID_ENVELOPE", async () => {
    const filePath = await tmpJournal();
    const bad = validEntry({ entry_schema_version: 0 });
    await expect(appendEntry(filePath, bad, { fsync: false })).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
    });
  });

  // Audit r1 Blocker #4: Gate #3 — append must reject migration:snapshot_imported
  // with inline artifact content at step 5 final validate (the prior path had
  // payload: z.unknown() and would accept any shape; only the standalone
  // MigrationSnapshotImportedPayload.safeParse rejected it).
  test("Gate #3: migration:snapshot_imported with inline artifact body → INVALID_PAYLOAD", async () => {
    const filePath = await tmpJournal();
    const malformedMigration: JournalEntry = {
      seq: 0,
      entry_id: "JE-000001",
      at: "2026-05-15T10:00:00.000Z",
      actor: "migration:v0.0.x→v2",
      entry_schema_version: 1,
      kind: "migration:snapshot_imported",
      payload: {
        source_schema_version: 1,
        migrated_at: "2026-05-15T10:00:00.000Z",
        artifacts: {
          // Inline string — not an AttachmentRef. Gate #3 must reject at append.
          state: "literal-inline-content-not-a-ref",
          tasks: { path: "x", sha256: "0".repeat(64), size: 0 },
          spec_md: { path: "x", sha256: "0".repeat(64), size: 0 },
          evidence: { path: "x", sha256: "0".repeat(64), size: 0 },
          findings: { path: "x", sha256: "0".repeat(64), size: 0 },
          pending: { path: "x", sha256: "0".repeat(64), size: 0 },
        },
      },
    };
    await expect(appendEntry(filePath, malformedMigration, { fsync: false })).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
    // No journal file is created.
    await expect(fs.readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  // ── F: 64KB hard byte limit (rev 5.0, protocol.md §11.2 step 5b) ────────
  test("F. entry serialized > 64KB → ENTRY_OVERSIZE, file untouched", async () => {
    const filePath = await tmpJournal();
    // Overshoot the 64KB ceiling — LongTextField sidecar promotion (Stage 4)
    // is the proper escape; Stage 1 simply rejects oversize outright.
    const bigPayload = { feature: "auth-refresh", note: "x".repeat(70_000) };
    const oversize = validEntry({ payload: bigPayload });

    await expect(appendEntry(filePath, oversize, { fsync: false })).rejects.toMatchObject({
      code: "ENTRY_OVERSIZE",
    });
    await expect(fs.readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("F. entry serialized just below 64KB → accepted", async () => {
    const filePath = await tmpJournal();
    // Sizing: validEntry envelope serializes to ~150 bytes; pad payload to land
    // a comfortable margin under 64_000.
    const payload = { feature: "auth-refresh", note: "y".repeat(60_000) };
    const ok = validEntry({ payload });
    await appendEntry(filePath, ok, { fsync: false });
    const contents = await fs.readFile(filePath, "utf8");
    expect(contents.endsWith("\n")).toBe(true);
    expect(JSON.parse(contents.trim())).toEqual(ok);
  });

  // ── G: seq monotonic (per-append, += 1 from current tail) ───────────────
  test("G. first entry into an empty file must have seq=0", async () => {
    const filePath = await tmpJournal();
    const bad = validEntry({ seq: 5 });
    await expect(appendEntry(filePath, bad, { fsync: false })).rejects.toMatchObject({
      code: "SEQ_NOT_MONOTONIC",
    });
    await expect(fs.readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("G. second entry must have seq = tail.seq + 1", async () => {
    const filePath = await tmpJournal();
    await appendEntry(filePath, validEntry({ seq: 0 }), { fsync: false });

    // Wrong: seq=2 skips a slot.
    const skip = validEntry({ seq: 2, entry_id: "JE-000002" });
    await expect(appendEntry(filePath, skip, { fsync: false })).rejects.toMatchObject({
      code: "SEQ_NOT_MONOTONIC",
    });

    // Wrong: seq=0 reuses tail.
    const reuse = validEntry({ seq: 0, entry_id: "JE-000002" });
    await expect(appendEntry(filePath, reuse, { fsync: false })).rejects.toMatchObject({
      code: "SEQ_NOT_MONOTONIC",
    });

    // Correct: seq=1 — strictly tail+1.
    const ok = validEntry({ seq: 1, entry_id: "JE-000002" });
    await appendEntry(filePath, ok, { fsync: false });

    const contents = await fs.readFile(filePath, "utf8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).seq).toBe(1);
  });
});
