// Stage 1 — journal-append acceptance tests (TDD vertical slices).
//
// Spec source: docs/protocol.md §11.2 + docs/schemas.ts §0a + ADR-0005 §3.2 / §3.5.
// Tests verify behavior through the public `appendEntry` API, not implementation
// details. Each test is a vertical slice (one behavior → one impl cycle).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { AppendError, appendEntry, appendMany } from "../../src/core/journal-append.js";
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
      // pending:added with strict PendingAddedPayload — requires id + kind
      // + question (≥3 chars; Slice 3 SC1 schema-tighten, codex r64).
      kind: "pending:added",
      payload: { id: "PEND-0001", kind: "ask_user_question", question: "stub" },
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
    // Overshoot the 64KB ceiling. Use a valid pending:added payload
    // (PendingAddedPayload .passthrough() allows extras) so we hit byte
    // ceiling, not payload schema.
    const bigPayload = { id: "PEND-0001", kind: "ask_user_question", question: "stub", note: "x".repeat(70_000) };
    const oversize = validEntry({ payload: bigPayload });

    await expect(appendEntry(filePath, oversize, { fsync: false })).rejects.toMatchObject({
      code: "ENTRY_OVERSIZE",
    });
    await expect(fs.readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("F. entry serialized just below 64KB → accepted", async () => {
    const filePath = await tmpJournal();
    const payload = { id: "PEND-0001", kind: "ask_user_question", question: "stub", note: "y".repeat(60_000) };
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

describe("appendMany — Slice 1.0 Cycle 2", () => {
  function pendingAdded(seq: number, id: string): JournalEntry {
    return {
      seq,
      entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
      at: `2026-05-15T10:00:0${seq}.000Z`,
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "pending:added",
      // Slice 3 SC1: PendingAddedPayload requires question ≥3 chars.
      payload: { id, kind: "ask_user_question", question: "stub" },
    };
  }

  // ── A: tracer bullet — happy path multi-entry write ───────────────────────
  test("A. appends 2 valid entries to an empty journal in one single newline-joined write", async () => {
    const filePath = await tmpJournal();
    const entries = [pendingAdded(0, "PEND-0001"), pendingAdded(1, "PEND-0002")];

    await appendMany(filePath, entries, { fsync: false });

    const contents = await fs.readFile(filePath, "utf8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).seq).toBe(0);
    expect(JSON.parse(lines[1]!).seq).toBe(1);
    expect(contents).toBe(
      JSON.stringify(entries[0]) + "\n" + JSON.stringify(entries[1]) + "\n",
    );
  });

  // ── B: atomicity — entry #2 invalid → journal untouched ──────────────────
  // Spec: prevalidate ALL entries before opening the file. A late-batch fail
  // must leave the journal in its prior state (no partial write).
  test("B. entry #2 has wrong seq → SEQ_NOT_MONOTONIC, file never created (ENOENT)", async () => {
    const filePath = await tmpJournal();
    const good = pendingAdded(0, "PEND-0001");
    const badSeq = { ...pendingAdded(1, "PEND-0002"), seq: 5 } as JournalEntry;

    await expect(appendMany(filePath, [good, badSeq], { fsync: false })).rejects.toBeInstanceOf(
      AppendError,
    );
    await expect(appendMany(filePath, [good, badSeq], { fsync: false })).rejects.toMatchObject({
      code: "SEQ_NOT_MONOTONIC",
    });
    await expect(fs.readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("B. entry #2 has invalid envelope → INVALID_ENVELOPE, no partial write", async () => {
    const filePath = await tmpJournal();
    const good = pendingAdded(0, "PEND-0001");
    const badEnvelope = { ...pendingAdded(1, "PEND-0002"), actor: "alice" } as JournalEntry;

    await expect(
      appendMany(filePath, [good, badEnvelope], { fsync: false }),
    ).rejects.toMatchObject({ code: "INVALID_ENVELOPE" });
    await expect(fs.readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Atomicity over an EXISTING journal: late-batch fail must leave the tail
  // exactly where it was, not append the prevalidated leading entries.
  test("B. mid-batch fail over non-empty journal → tail unchanged", async () => {
    const filePath = await tmpJournal();
    // Seed with one entry so journal exists at seq=0.
    await appendMany(filePath, [pendingAdded(0, "PEND-0003")], { fsync: false });
    const before = await fs.readFile(filePath, "utf8");

    const good = pendingAdded(1, "PEND-0001");
    const bad = { ...pendingAdded(2, "PEND-0002"), entry_id: "EV-000003" } as JournalEntry;

    await expect(
      appendMany(filePath, [good, bad], { fsync: false }),
    ).rejects.toMatchObject({ code: "INVALID_ENVELOPE" });

    const after = await fs.readFile(filePath, "utf8");
    expect(after).toBe(before);
  });

  // ── C: empty array rejected explicitly ───────────────────────────────────
  test("C. empty entries array → INVALID_ENVELOPE", async () => {
    const filePath = await tmpJournal();
    await expect(appendMany(filePath, [], { fsync: false })).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
    });
    await expect(fs.readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  // ── D: seq contiguity within the batch ───────────────────────────────────
  // entry[0].seq must match tail+1; entry[i].seq must match entry[i-1].seq+1.
  test("D. seq jumps inside batch (0 then 2) → SEQ_NOT_MONOTONIC", async () => {
    const filePath = await tmpJournal();
    const entries = [pendingAdded(0, "PEND-0001"), pendingAdded(2, "PEND-0002")];
    await expect(appendMany(filePath, entries, { fsync: false })).rejects.toMatchObject({
      code: "SEQ_NOT_MONOTONIC",
    });
    await expect(fs.readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("D. batch starts at wrong seq (tail=0, batch starts at 5) → SEQ_NOT_MONOTONIC", async () => {
    const filePath = await tmpJournal();
    await appendMany(filePath, [pendingAdded(0, "PEND-0003")], { fsync: false });

    const entries = [pendingAdded(5, "PEND-0001"), pendingAdded(6, "PEND-0002")];
    await expect(appendMany(filePath, entries, { fsync: false })).rejects.toMatchObject({
      code: "SEQ_NOT_MONOTONIC",
    });
  });

  // ── E: batch extends existing journal contiguously ───────────────────────
  test("E. batch appended to non-empty journal extends seq contiguously", async () => {
    const filePath = await tmpJournal();
    await appendMany(filePath, [pendingAdded(0, "PEND-0003")], { fsync: false });

    const entries = [pendingAdded(1, "PEND-0001"), pendingAdded(2, "PEND-0002")];
    await appendMany(filePath, entries, { fsync: false });

    const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l!).seq)).toEqual([0, 1, 2]);
  });

  // ── F: per-write byte ceiling — batch total ≤ ENTRY_BYTE_LIMIT ───────────
  // Protocol §11.2 step 5b: one write() ≤ 64KB whether one entry or N.
  // Each individual entry can be under-limit but the concatenated batch must
  // also be under-limit.
  test("F. each entry under cap but batch total > 64KB → ENTRY_OVERSIZE (scope=batch)", async () => {
    const filePath = await tmpJournal();
    const big = (seq: number, id: string): JournalEntry => ({
      ...pendingAdded(seq, id),
      payload: { id, kind: "ask_user_question", question: "stub", note: "x".repeat(35_000) },
    });
    const entries = [big(0, "PEND-0001"), big(1, "PEND-0002")];

    await expect(appendMany(filePath, entries, { fsync: false })).rejects.toMatchObject({
      code: "ENTRY_OVERSIZE",
      detail: { scope: "batch" },
    });
    await expect(fs.readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  // ── G: mid-batch payload schema failure — same atomicity guarantee ───────
  // Covers the PER_KIND_PAYLOAD branch in appendMany. Inherited appendEntry
  // payload tests prove single-entry behavior; this proves it in batch path.
  test("G. entry #2 payload missing required field → INVALID_PAYLOAD, no partial write", async () => {
    const filePath = await tmpJournal();
    const good = pendingAdded(0, "PEND-0001");
    // PendingAddedPayload requires `id` and `kind`; strip `kind` to trip schema.
    const bad = {
      ...pendingAdded(1, "PEND-0002"),
      payload: { id: "PEND-0002" },
    } as JournalEntry;

    await expect(appendMany(filePath, [good, bad], { fsync: false })).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
    await expect(fs.readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
