// Stage 4 — final-validation harness (Gate #2 verified, ADR-0005 §11.2 step 5).
//
// End-to-end: caller builds raw entry → promoteSidecars promotes oversize
// LongTextField payloads → appendEntry re-Zod-validates the embedded
// AttachmentRef + byte limit → write to journal. Step 5 final validate is
// the second gate (the first being step 3 preflight). This file verifies the
// happy path and a few crash-like boundary conditions through the public
// API.
//
// Full crash-injection harness (fault inject at each step 2a-4c boundary)
// remains future work — the MVP test surface here proves the contract.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

import { appendEntry, AppendError } from "../../src/core/journal-append.js";
import { promoteSidecars } from "../../src/core/sidecar.js";
import { replayJournal } from "../../src/core/journal-bootstrap.js";
import { emptyMeta, type SnapshotMeta } from "../../src/core/snapshot.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";

async function tmpRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-final-"));
}

const STANDARD = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip" as const,
  strict_drift_check: false,
};

const sessionStart = (): JournalEntry => ({
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
});

const oversizeEvidence = (): JournalEntry => ({
  seq: 1,
  entry_id: "JE-000002",
  at: "2026-05-15T10:00:01.000Z",
  actor: "cli:loaf",
  entry_schema_version: 1,
  kind: "evidence:added",
  payload: {
    id: "EV-000001",
    kind: "local-check",
    iteration: 1,
    actor: "cli:loaf",
    result: "passed",
    summary: { mode: "inline", text: "x".repeat(20_000) },
  },
});

// Drive the cursor to EXECUTE.work so evidence:added is sub_state-legal.
// Threads the prior `SnapshotMeta` through each append (Phase 15 SC2 —
// appendEntry validates the prior meta against the journal tail and returns
// the post-append meta). Returns the next free seq + the latest meta so the
// caller can append the evidence entry on top.
async function advanceToExecuteWork(
  journalPath: string,
  priorMeta: SnapshotMeta,
): Promise<{ seq: number; meta: SnapshotMeta }> {
  const path = [
    ["TRIAGE.score", "TRIAGE.confirm"],
    ["TRIAGE.confirm", "SPEC.proposal"],
    ["SPEC.proposal", "SPEC.spec"],
    ["SPEC.spec", "SPEC.plan"],
    ["SPEC.plan", "SPEC.design"],
    ["SPEC.design", "EXECUTE.plan"],
    ["EXECUTE.plan", "EXECUTE.work"],
  ] as const;
  let seq = 1;
  let meta = priorMeta;
  for (const [from, to] of path) {
    meta = await appendEntry(
      journalPath,
      {
        seq,
        entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
        at: new Date(2026, 4, 15, 10, 0, seq).toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from, to },
      },
      meta,
      { fsync: false },
    );
    seq++;
  }
  return { seq, meta };
}

describe("final-validation — Stage 4 end-to-end §11.2 step 4-6", () => {
  test("promote → append round-trips through replay with embedded ref", async () => {
    const root = await tmpRoot();
    const journalPath = path.join(root, "journal.jsonl");

    const startMeta = await appendEntry(journalPath, sessionStart(), emptyMeta(), {
      fsync: false,
    });
    const { seq, meta } = await advanceToExecuteWork(journalPath, startMeta);

    const evidence = {
      ...oversizeEvidence(),
      seq,
      entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
    };
    const promoted = await promoteSidecars(evidence, root, { fsync: false });
    await appendEntry(journalPath, promoted, meta, { fsync: false });

    const result = await replayJournal(journalPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries_applied).toBeGreaterThanOrEqual(seq + 1);
    }

    // Verify the sidecar file on disk content matches the embedded sha256.
    const summary = (
      promoted.payload as { summary: { mode: string; ref: { path: string; sha256: string } } }
    ).summary;
    expect(summary.mode).toBe("sidecar");
    const onDisk = await fs.readFile(path.join(root, summary.ref.path));
    expect(createHash("sha256").update(onDisk).digest("hex")).toBe(summary.ref.sha256);
  });

  test("oversize entry (post-promotion) still rejected by ENTRY_OVERSIZE", async () => {
    // Even with sidecar promotion, an entry whose envelope + remaining inline
    // payload exceeds 64KB must be rejected by step 5. Force this by giving
    // a kind whose payload has many inline (non-LongTextField) fields.
    const root = await tmpRoot();
    const journalPath = path.join(root, "journal.jsonl");

    const huge = "y".repeat(70_000);
    const raw: JournalEntry = {
      seq: 0,
      entry_id: "JE-000001",
      at: "2026-05-15T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "pending:added",
      payload: {
        id: "PEND-0001",
        kind: "ask_user_question",
        question: "stub",
        non_long_text_field: huge,
      },
    };
    // Promote does nothing here (payload has no LongTextField shape).
    const promoted = await promoteSidecars(raw, root, { fsync: false });

    let caught: AppendError | null = null;
    try {
      await appendEntry(journalPath, promoted, emptyMeta(), { fsync: false });
    } catch (e) {
      caught = e as AppendError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("ENTRY_OVERSIZE");

    // Journal must not exist (or be empty) — step 5 abort never wrote.
    await expect(fs.readFile(journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("post-append sidecar files are reachable via the path the entry declared", async () => {
    const root = await tmpRoot();
    const journalPath = path.join(root, "journal.jsonl");

    // appendEntry only enforces seq monotonic + 64KB; for this filesystem-
    // smoke-test we hand it a single session:started entry with an oversize
    // LongTextField squeezed into a custom payload field. The reducer is not
    // exercised here — we only verify the sidecar file lands on disk where
    // the AttachmentRef declared it.
    const raw: JournalEntry = {
      seq: 0,
      entry_id: "JE-000001",
      at: "2026-05-15T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "x",
        ceremony: STANDARD,
        // Stage 4 promote walks payload one level; we just need any field
        // whose shape matches LongTextField.inline.
        note: { mode: "inline", text: "x".repeat(15_000) },
      },
    };
    const promoted = await promoteSidecars(raw, root, { fsync: false });
    await appendEntry(journalPath, promoted, emptyMeta(), { fsync: false });

    const note = (promoted.payload as { note: { ref: { path: string; sha256: string } } }).note;
    const fileExists = await fs
      .stat(path.join(root, note.ref.path))
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(true);
  });
});
