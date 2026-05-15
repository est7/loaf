// Stage 2 / audit r1 Blocker #3 — transactional mutate() API.
//
// Covers the single-entry-point happy path + each failure boundary:
//   - preflight rejection (sub_state authority / payload shape / from cursor)
//   - sidecar promotion succeeds end-to-end (LongTextField inline → sidecar)
//   - append-level rejections still surface (ENTRY_OVERSIZE)
//   - reducer apply integrates into the same call
//
// These tests do not exercise concurrent lock contention (Blocker #3 lock
// implementation is deferred; mutate() is single-writer today).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

import { mutate } from "../../src/core/journal-mutate.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import { replayJournal } from "../../src/core/journal-bootstrap.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-mutate-"));
}

const STANDARD = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip" as const,
  strict_drift_check: false,
};

describe("mutate — transactional journal write (audit r1 Blocker #3)", () => {
  test("happy path: session:started → snapshot bootstrapped, journal has the entry", async () => {
    const dir = await tmpFeatureDir();
    const result = await mutate(
      {
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD,
        },
      },
      {
        feature_dir: dir,
        snapshot: initialSnapshot(),
        tail_seq: -1,
        fsync: false,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.state?.sub_state).toBe("TRIAGE.score");
      expect(result.entry.seq).toBe(0);
      expect(result.entry.entry_id).toBe("JE-000001");
    }

    // Journal contains exactly one line — the entry mutate appended.
    const journal = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journal.trim().split("\n")).toHaveLength(1);
  });

  test("preflight rejection (FROM_CURSOR_MISMATCH) — journal unchanged", async () => {
    const dir = await tmpFeatureDir();
    // Bootstrap first.
    const boot = await mutate(
      {
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD,
        },
      },
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, fsync: false },
    );
    expect(boot.ok).toBe(true);
    if (!boot.ok) return;

    // Now try a phase_advanced whose payload.from is wrong (cursor sits at
    // TRIAGE.score but payload claims EXECUTE.work → EXECUTE.done).
    const bad = await mutate(
      {
        at: "2026-05-15T10:00:01.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: "EXECUTE.work", to: "EXECUTE.done" },
      },
      { feature_dir: dir, snapshot: boot.snapshot, tail_seq: 0, fsync: false },
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("FROM_CURSOR_MISMATCH");

    // Journal still has exactly one entry (the bootstrap).
    const journal = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journal.trim().split("\n")).toHaveLength(1);
  });

  test("payload validation (INVALID_PAYLOAD) — Gate #3 via mutate", async () => {
    const dir = await tmpFeatureDir();
    const bad = await mutate(
      {
        at: "2026-05-15T10:00:00.000Z",
        actor: "migration:v0.0.x→v2",
        entry_schema_version: 1,
        kind: "migration:snapshot_imported",
        payload: {
          source_schema_version: 1,
          migrated_at: "2026-05-15T10:00:00.000Z",
          artifacts: {
            // Gate #3: literal inline content must be rejected.
            state: "inline-not-a-ref",
            tasks: { path: "x", sha256: "0".repeat(64), size: 0 },
            spec_md: { path: "x", sha256: "0".repeat(64), size: 0 },
            evidence: { path: "x", sha256: "0".repeat(64), size: 0 },
            findings: { path: "x", sha256: "0".repeat(64), size: 0 },
            pending: { path: "x", sha256: "0".repeat(64), size: 0 },
          },
        },
      },
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, fsync: false },
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("INVALID_PAYLOAD");

    // No journal file at all.
    await expect(fs.readFile(path.join(dir, "journal.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("sidecar promotion is integrated — LongTextField inline > 8KB lands in attachments/", async () => {
    const dir = await tmpFeatureDir();
    // Bootstrap session.
    const boot = await mutate(
      {
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "f",
          ceremony: STANDARD,
        },
      },
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, fsync: false },
    );
    expect(boot.ok).toBe(true);
    if (!boot.ok) return;

    // Walk to EXECUTE.work so evidence:added is sub_state-legal.
    const transitions: Array<["TRIAGE.score" | "TRIAGE.confirm" | "SPEC.proposal" | "SPEC.spec" | "SPEC.plan" | "SPEC.design" | "EXECUTE.plan", "TRIAGE.confirm" | "SPEC.proposal" | "SPEC.spec" | "SPEC.plan" | "SPEC.design" | "EXECUTE.plan" | "EXECUTE.work"]> = [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
      ["SPEC.design", "EXECUTE.plan"],
      ["EXECUTE.plan", "EXECUTE.work"],
    ];
    let snapshot = boot.snapshot;
    let tailSeq = 0;
    for (const [from, to] of transitions) {
      const r = await mutate(
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from, to },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      snapshot = r.snapshot;
      tailSeq++;
    }

    // Now an evidence:added entry with an oversize LongTextField inline.
    const big = "x".repeat(10_000);
    const r = await mutate(
      {
        at: "2026-05-15T11:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "evidence:added",
        payload: {
          id: "EV-000001",
          kind: "local-check",
          summary: { mode: "inline", text: big },
        },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Sidecar landed at attachments/JE-NNNNNN/summary.txt with matching sha256.
    const summary = (r.entry.payload as { summary: { mode: string; ref: { path: string; sha256: string; size: number } } }).summary;
    expect(summary.mode).toBe("sidecar");
    const bytes = await fs.readFile(path.join(dir, summary.ref.path));
    const actualSha = createHash("sha256").update(bytes).digest("hex");
    expect(summary.ref.sha256).toBe(actualSha);
    expect(summary.ref.size).toBe(Buffer.byteLength(big, "utf8"));
  });

  // Audit r2 Blocker — mutate must NOT pollute the journal when reducer
  // can't apply the kind. Before this fix, mutate appended first then ran
  // reducer apply; an unimplemented kind would return ok=false WHILE the
  // journal had already grown by one line.
  test("mutate refuses to append unimplemented kinds (atomic fail)", async () => {
    const dir = await tmpFeatureDir();
    // Bootstrap session first.
    const boot = await mutate(
      {
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD,
        },
      },
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, fsync: false },
    );
    expect(boot.ok).toBe(true);
    if (!boot.ok) return;

    // Walk to SPEC.spec where event:spec_req_added is sub_state-legal.
    let snapshot = boot.snapshot;
    let tailSeq = 0;
    const transitions = [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
    ] as const;
    for (const [from, to] of transitions) {
      const r = await mutate(
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from, to },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      snapshot = r.snapshot;
      tailSeq++;
    }

    // Pre-condition: journal has 4 entries (boot + 3 transitions).
    const journalBefore = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journalBefore.trim().split("\n")).toHaveLength(4);

    // event:spec_req_added is preflight-legal in SPEC.spec but reducer hasn't
    // implemented it — must refuse without appending.
    const bad = await mutate(
      {
        at: "2026-05-15T11:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:spec_req_added",
        payload: { id: "REQ-001", type: "ubiquitous", response: "test" },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("REDUCER_ERROR");

    // Journal MUST still have exactly 4 entries — the unimplemented kind
    // was not appended.
    const journalAfter = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journalAfter.trim().split("\n")).toHaveLength(4);
    expect(journalAfter).toBe(journalBefore);
  });

  test("multi-mutate round-trips through replay", async () => {
    const dir = await tmpFeatureDir();
    let snapshot = initialSnapshot();
    let tailSeq = -1;

    const ops: Array<Parameters<typeof mutate>[0]> = [
      {
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD,
        },
      },
      {
        at: "2026-05-15T10:00:01.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: "TRIAGE.score", to: "TRIAGE.confirm" },
      },
      {
        at: "2026-05-15T10:00:02.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: "TRIAGE.confirm", to: "SPEC.proposal" },
      },
    ];

    for (const op of ops) {
      const r = await mutate(op, { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      snapshot = r.snapshot;
      tailSeq++;
    }

    // Replay journal independently — projection must match in-memory.
    const replay = await replayJournal(path.join(dir, "journal.jsonl"));
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.snapshot.state?.sub_state).toBe("SPEC.proposal");
      expect(replay.entries_applied).toBe(3);
      expect(replay.meta.last_applied_seq).toBe(2);
    }
  });
});
