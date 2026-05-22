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

import { mutate, mutateBatch } from "../../src/core/journal-mutate.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import type { Snapshot } from "../../src/core/reducer.js";
import { replayJournal } from "../../src/core/journal-bootstrap.js";
import { emptyMeta, type SnapshotMeta } from "../../src/core/snapshot.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";

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
        entries: [],
        meta: emptyMeta(),
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
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
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
      { feature_dir: dir, snapshot: boot.snapshot, tail_seq: 0, entries: [boot.entry], meta: boot.meta, fsync: false },
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
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
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
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
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
    let entries: JournalEntry[] = [boot.entry];
    let meta = boot.meta;
    for (const [from, to] of transitions) {
      const r = await mutate(
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from, to },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      snapshot = r.snapshot;
      tailSeq++;
      entries = entries.concat(r.entry);
      meta = r.meta;
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
          iteration: 1,
          actor: "cli:loaf",
          result: "passed",
          summary: { mode: "inline", text: big },
        },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
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

  // Audit r3 Blocker — mutate must NOT pollute the journal when the reducer
  // hits a STATE invariant (not just unimplemented kind). codex r3 repro:
  // pending:resolved with id not matching FIFO head — preflight ok,
  // REDUCER_IMPLEMENTED ok, but reducer fails PENDING_NOT_FOUND. Before
  // the dry-run-before-append fix, journal grew 1→2.
  test("mutate refuses to append when reducer state invariant fails (pending:resolved with bad id)", async () => {
    const dir = await tmpFeatureDir();
    // Bootstrap + walk to EXECUTE.work where pending:resolved is sub_state-legal.
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
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
    );
    expect(boot.ok).toBe(true);
    if (!boot.ok) return;

    const snapshot = boot.snapshot;
    const tailSeq = 0;
    const entries: JournalEntry[] = [boot.entry];
    const meta = boot.meta;
    // No need to advance; pending:resolved is ANY_SUB_STATE per PER_KIND_SUB_STATE.

    // Pre-condition: journal has exactly 1 entry (boot only).
    const journalBefore = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journalBefore.trim().split("\n")).toHaveLength(1);

    // pending:resolved with no matching pending head → reducer apply fails.
    const bad = await mutate(
      {
        at: "2026-05-15T10:00:01.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "pending:resolved",
        payload: { id: "PEND-0404" },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("REDUCER_ERROR");
      expect((bad.detail as { code?: string } | undefined)?.code).toBe("PENDING_NOT_FOUND");
    }

    // Journal MUST still be byte-identical — no append on reducer dry-run fail.
    const journalAfter = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journalAfter).toBe(journalBefore);
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
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
    );
    expect(boot.ok).toBe(true);
    if (!boot.ok) return;

    // Use `session:resumed` — still unimplemented in REDUCER_IMPLEMENTED_KINDS,
    // allowed at ANY_SUB_STATE so no phase walking needed.
    const snapshot = boot.snapshot;
    const tailSeq = 0;
    const entries: JournalEntry[] = [boot.entry];
    const meta = boot.meta;

    // Pre-condition: journal has 1 entry (boot session:started).
    const journalBefore = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journalBefore.trim().split("\n")).toHaveLength(1);

    // event:spec_req_added was preflight-legal but unimplemented; Slice 1.B
    // implemented it, so we now use session:resumed which remains unimplemented.
    const bad = await mutate(
      {
        at: "2026-05-15T11:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:resumed",
        payload: { resumed_by: "human:ffoisx@gmail.com" },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("REDUCER_ERROR");

    // Journal MUST still have exactly 1 entry — the unimplemented kind
    // was not appended.
    const journalAfter = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journalAfter.trim().split("\n")).toHaveLength(1);
    expect(journalAfter).toBe(journalBefore);
  });

  test("multi-mutate round-trips through replay", async () => {
    const dir = await tmpFeatureDir();
    let snapshot = initialSnapshot();
    let tailSeq = -1;
    let entries: JournalEntry[] = [];
    let meta = emptyMeta();

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
      const r = await mutate(op, {
        feature_dir: dir,
        snapshot,
        tail_seq: tailSeq,
        entries,
        meta,
        fsync: false,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      snapshot = r.snapshot;
      tailSeq++;
      entries = entries.concat(r.entry);
      meta = r.meta;
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

describe("mutateBatch — Slice 1.0 Cycle 3 (multi-entry transactional)", () => {
  // ── A: single-entry batch == mutate equivalence ──────────────────────────
  test("A. mutateBatch([session:started]) produces same state as mutate(session:started)", async () => {
    const dir = await tmpFeatureDir();
    const result = await mutateBatch(
      [
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
      ],
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.state?.sub_state).toBe("TRIAGE.score");
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.seq).toBe(0);
      expect(result.entries[0]!.entry_id).toBe("JE-000001");
    }
    const journal = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journal.trim().split("\n")).toHaveLength(1);
  });

  // ── B: chained snapshot — entry #2's preflight sees entry #1's projection ──
  // The load-bearing claim: without the incremental snapshot accumulator,
  // event:phase_advanced TRIAGE.score → TRIAGE.confirm would fail preflight
  // because the inputs ctx.snapshot says state is null.
  test("B. 2-entry batch [session:started, phase_advanced] — incremental snapshot threads chain", async () => {
    const dir = await tmpFeatureDir();
    const result = await mutateBatch(
      [
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
      ],
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.state?.sub_state).toBe("TRIAGE.confirm");
      expect(result.entries).toHaveLength(2);
      expect(result.entries.map((e) => e.seq)).toEqual([0, 1]);
    }
    // Journal landed both lines in one atomic batch.
    const journal = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journal.trim().split("\n")).toHaveLength(2);
  });

  // ── C: mid-batch preflight fail → atomicity, journal untouched ───────────
  test("C. entry #2 preflight fails (FROM_CURSOR_MISMATCH) → no journal append, failed_index=1", async () => {
    const dir = await tmpFeatureDir();
    const result = await mutateBatch(
      [
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
          // After session:started, cursor is at TRIAGE.score. payload.from
          // claims SPEC.spec which doesn't match → preflight FROM_CURSOR_MISMATCH.
          at: "2026-05-15T10:00:01.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: "SPEC.spec", to: "SPEC.plan" },
        },
      ],
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FROM_CURSOR_MISMATCH");
      expect(result.failed_index).toBe(1);
    }
    // No journal file at all — entry #1 was dry-run only.
    await expect(fs.readFile(path.join(dir, "journal.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  // ── D: mid-batch reducer dry-run fail → atomicity ────────────────────────
  // Walk to EXECUTE.work, then batch [valid evidence:added, pending:resolved
  // with bogus id] — entry #2 dies in reducer.apply (PENDING_NOT_FOUND).
  test("D. entry #2 reducer dry-run fail (PENDING_NOT_FOUND) → no journal append, failed_index=1", async () => {
    const dir = await tmpFeatureDir();
    // Bootstrap and walk to EXECUTE.work where both kinds are sub_state-legal.
    let snapshot = initialSnapshot();
    let tailSeq = -1;
    let entries: JournalEntry[] = [];
    let meta = emptyMeta();
    const bootOps: Array<Parameters<typeof mutate>[0]> = [
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
    ];
    const subStateEdges: Array<[string, string]> = [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
      ["SPEC.design", "EXECUTE.plan"],
      ["EXECUTE.plan", "EXECUTE.work"],
    ];
    for (const [from, to] of subStateEdges) {
      bootOps.push({
        at: new Date(2026, 4, 15, 10, 0, bootOps.length).toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: from as any, to: to as any },
      });
    }
    for (const op of bootOps) {
      const r = await mutate(op, {
        feature_dir: dir,
        snapshot,
        tail_seq: tailSeq,
        entries,
        meta,
        fsync: false,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      snapshot = r.snapshot;
      tailSeq++;
      entries = entries.concat(r.entry);
      meta = r.meta;
    }

    const journalBefore = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const linesBefore = journalBefore.trim().split("\n").length;

    const batch = await mutateBatch(
      [
        {
          at: "2026-05-15T11:00:00.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "evidence:added",
          payload: {
            id: "EV-000001",
            kind: "local-check",
            iteration: 1,
            actor: "cli:loaf",
            result: "passed",
            summary: "stub local-check evidence",
          },
        },
        {
          at: "2026-05-15T11:00:01.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "pending:resolved",
          payload: { id: "PEND-0404" },
        },
      ],
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(batch.ok).toBe(false);
    if (!batch.ok) {
      expect(batch.code).toBe("REDUCER_ERROR");
      expect(batch.failed_index).toBe(1);
      expect((batch.detail as { code?: string } | undefined)?.code).toBe("PENDING_NOT_FOUND");
    }

    // Journal must be byte-identical — entry #1 was dry-run only, never appended.
    const journalAfter = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journalAfter).toBe(journalBefore);
    expect(journalAfter.trim().split("\n").length).toBe(linesBefore);
  });

  // ── E: empty batch is an input bug, not a quiet no-op ────────────────────
  test("E. empty partials array → INVALID_BATCH, journal untouched", async () => {
    const dir = await tmpFeatureDir();
    const result = await mutateBatch([], {
      feature_dir: dir,
      snapshot: initialSnapshot(),
      tail_seq: -1,
      entries: [],
      meta: emptyMeta(),
      fsync: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_BATCH");
    }
    await expect(fs.readFile(path.join(dir, "journal.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  // ── B2: batch envelope ───────────────────────────────────────────────────
  // Per protocol §11.2 step 3f + §11.2 batch path: N>=2 entries share a
  // batch_id (UUID), batch_index 0..N-1, batch_count = N. N=1 entries omit
  // the envelope.
  test("B2. N=2 batch attaches batch_id/batch_index/batch_count envelope to returned entries AND journal lines", async () => {
    const dir = await tmpFeatureDir();
    const result = await mutateBatch(
      [
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
        {
          at: "2026-05-15T10:00:01.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: "TRIAGE.score", to: "TRIAGE.confirm" },
        },
      ],
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.entries).toHaveLength(2);
    const [e0, e1] = result.entries;
    expect(e0!.batch_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(e0!.batch_id).toBe(e1!.batch_id);
    expect(e0!.batch_index).toBe(0);
    expect(e1!.batch_index).toBe(1);
    expect(e0!.batch_count).toBe(2);
    expect(e1!.batch_count).toBe(2);

    // Journal lines carry the envelope too.
    const journal = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lines = journal.trim().split("\n").map((l) => JSON.parse(l!));
    expect(lines[0].batch_id).toBe(e0!.batch_id);
    expect(lines[1].batch_index).toBe(1);
    expect(lines[0].batch_count).toBe(2);
  });

  test("B2. N=1 batch omits batch envelope (all 3 fields absent)", async () => {
    const dir = await tmpFeatureDir();
    const result = await mutateBatch(
      [
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
      ],
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]!.batch_id).toBeUndefined();
    expect(result.entries[0]!.batch_index).toBeUndefined();
    expect(result.entries[0]!.batch_count).toBeUndefined();
  });

  // ── C2: planned validation failures must NOT write sidecars ──────────────
  // entry #0 has a >8KB LongTextField inline (would promote to attachment);
  // entry #1 fails preflight. Pass 1 catches the failure before Pass 2
  // (sidecar promotion) runs, so the attachments directory must NOT exist.
  test("C2. mid-batch fail BEFORE sidecar pass — no journal + no attachment directory", async () => {
    const dir = await tmpFeatureDir();
    // Bootstrap session + walk to EXECUTE.work so evidence:added is legal.
    let snapshot = initialSnapshot();
    let tailSeq = -1;
    let entries: JournalEntry[] = [];
    let meta = emptyMeta();
    const bootOps: Array<Parameters<typeof mutate>[0]> = [
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
    ];
    for (const [from, to] of [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
      ["SPEC.design", "EXECUTE.plan"],
      ["EXECUTE.plan", "EXECUTE.work"],
    ] as Array<[string, string]>) {
      bootOps.push({
        at: new Date(2026, 4, 15, 10, 0, bootOps.length).toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: from as any, to: to as any },
      });
    }
    for (const op of bootOps) {
      const r = await mutate(op, {
        feature_dir: dir,
        snapshot,
        tail_seq: tailSeq,
        entries,
        meta,
        fsync: false,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      snapshot = r.snapshot;
      tailSeq++;
      entries = entries.concat(r.entry);
      meta = r.meta;
    }

    const journalBefore = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    // Confirm no attachments dir yet — bootstrap had no LongTextField.
    await expect(fs.stat(path.join(dir, "attachments"))).rejects.toMatchObject({ code: "ENOENT" });

    // entry #0: evidence:added with >8KB inline summary (would promote)
    // entry #1: pending:resolved with bogus id — reducer dry-run fails
    const batch = await mutateBatch(
      [
        {
          at: "2026-05-15T11:00:00.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "evidence:added",
          payload: {
            id: "EV-000001",
            kind: "local-check",
            iteration: 1,
            actor: "cli:loaf",
            result: "passed",
            summary: { mode: "inline", text: "x".repeat(10_000) },
          },
        },
        {
          at: "2026-05-15T11:00:01.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "pending:resolved",
          payload: { id: "PEND-0404" },
        },
      ],
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(batch.ok).toBe(false);
    if (!batch.ok) {
      expect(batch.code).toBe("REDUCER_ERROR");
      expect(batch.failed_index).toBe(1);
    }
    // Journal byte-identical.
    expect(await fs.readFile(path.join(dir, "journal.jsonl"), "utf8")).toBe(journalBefore);
    // CRITICAL: no attachment dir was created — Pass 2 never ran.
    await expect(fs.stat(path.join(dir, "attachments"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  // ── G: forbidden caller-supplied fields are runtime-rejected ─────────────
  // The PartialEntry type omits seq/entry_id/batch_id/batch_index/batch_count;
  // mutateBatch additionally runtime-rejects them so an `as any` / external-
  // JSON caller can't sneak past the type system and inject inconsistent IDs.
  test("G. caller-supplied seq field → INVALID_BATCH with failed_index, no journal", async () => {
    const dir = await tmpFeatureDir();
    const result = await mutateBatch(
      [
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          seq: 42 as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_BATCH");
      expect(result.failed_index).toBe(0);
      expect((result.detail as { forbidden_field?: string } | undefined)?.forbidden_field).toBe("seq");
    }
    await expect(fs.readFile(path.join(dir, "journal.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  // ── H: Slice 1.A — gate semantics normalization regression ──────────────
  // gate:decided MUST NOT move the cursor; event:phase_advanced owns cursor
  // movement. A 2-entry batch [gate:decided spec-lock, phase_advanced
  // SPEC.design → EXECUTE.plan] should land both flag and cursor in one
  // atomic transaction. Before the gate-normalize fix (Slice 1.A), gate
  // self-moved the cursor and phase_advanced then failed FROM_CURSOR_MISMATCH.
  test("H. gate:decided + phase_advanced batch lands spec_locked + cursor moves once (with spec-lock wire)", async () => {
    // Slice 1.B sub-cycle 3c (codex r28 watchpoint #1): seed the snapshot
    // through real reducer/mutate entries — write spec.md to disk, emit
    // spec_submitted + companion REQ entries, plan tasks at SPEC.design,
    // then run the gate batch. mutateBatch Pass 1.5 will invoke
    // evaluateSpecLock which reads spec.md and runs all 8 checks against
    // the now-populated snapshot.
    const dir = await tmpFeatureDir();
    let snapshot = initialSnapshot();
    let tailSeq = -1;
    let entries: JournalEntry[] = [];
    let meta = emptyMeta();

    // Boot session.
    {
      const r = await mutate(
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
        { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      snapshot = r.snapshot;
      tailSeq++;
      entries = entries.concat(r.entry);
      meta = r.meta;
    }

    // Walk to SPEC.proposal.
    for (const [from, to] of [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
    ] as Array<[string, string]>) {
      const r = await mutate(
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: from as any, to: to as any },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      snapshot = r.snapshot;
      tailSeq++;
      entries = entries.concat(r.entry);
      meta = r.meta;
    }

    // Write spec.md to disk so evaluateSpecLock can read it at gate time.
    // Frontmatter matches the projection that spec_submitted + companion
    // REQ will populate, so check 3 (tasks_based_on.spec === spec.spec_version)
    // and check 4 (REQ-AUTH-001 driven by some task) pass.
    await fs.writeFile(
      path.join(dir, "spec.md"),
      `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: OAuth token refresh
intent: users should not perceive auth recovery flows in flight
adr_refs: []
requirements:
  - id: REQ-AUTH-001
    type: ubiquitous
    response: the system shall do something measurable here
    acceptance_na: true
    acceptance_na_reason: subjective UX validated via manual testing scope
scenarios: []
needs_clarification: []
---

## Why
prose body here
`,
    );

    // Emit spec_submitted + companion REQ as an atomic batch.
    {
      const batch = await mutateBatch(
        [
          {
            at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
            actor: "human:est9",
            entry_schema_version: 1,
            kind: "event:spec_submitted",
            payload: {
              spec_version: 1,
              feature: { id: "F-001", name: "OAuth token refresh" },
              intent: "users should not perceive auth recovery flows in flight",
              adr_refs: [],
              needs_clarification: [],
            },
          },
          {
            at: new Date(2026, 4, 15, 10, 0, tailSeq + 2).toISOString(),
            actor: "human:est9",
            entry_schema_version: 1,
            kind: "event:spec_req_added",
            payload: {
              spec_version: 1,
              req: {
                id: "REQ-AUTH-001",
                type: "ubiquitous",
                response: "the system shall do something measurable here",
                acceptance_na: true,
                acceptance_na_reason: "subjective UX validated via manual testing scope",
              },
            },
          },
        ],
        { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
      );
      expect(batch.ok).toBe(true);
      if (!batch.ok) return;
      snapshot = batch.snapshot;
      tailSeq += 2;
      entries = entries.concat(batch.entries);
      meta = batch.meta;
    }

    // Walk to SPEC.design.
    for (const [from, to] of [
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
    ] as Array<[string, string]>) {
      const r = await mutate(
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: from as any, to: to as any },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      snapshot = r.snapshot;
      tailSeq++;
      entries = entries.concat(r.entry);
      meta = r.meta;
    }

    // Plan tasks at SPEC.design (per protocol §1800; per-kind extended in
    // sub-cycle 3c to allow tasks_planned at SPEC.design + EXECUTE.plan).
    {
      const r = await mutate(
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "human:est9",
          entry_schema_version: 1,
          kind: "event:tasks_planned",
          payload: {
            based_on: { spec: 1 },
            tasks: [
              {
                id: "T-001",
                kind: "behavioral",
                drives: ["REQ-AUTH-001"],
                tests: ["TokenCoord.refreshOnce"],
                status: "pending",
                depends_on: [],
                labels: [],
                execution: {
                  red: { applicability: "must", status: "pending", evidence_refs: [] },
                  implement: { applicability: "must", status: "pending", evidence_refs: [] },
                  refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
                },
              },
            ],
          },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      snapshot = r.snapshot;
      tailSeq++;
      entries = entries.concat(r.entry);
      meta = r.meta;
    }

    expect(snapshot.state?.sub_state).toBe("SPEC.design");
    expect(snapshot.state?.spec_locked).toBe(false);
    expect(snapshot.tasks_based_on).toEqual({ spec: 1 });

    // The protocol-correct gate batch: gate:decided FIRST (records approval
    // — now also clears spec-lock check 1-8 via Pass 1.5), then
    // event:phase_advanced (moves cursor). After Slice 1.A, gate must NOT
    // self-move the cursor — phase_advanced sees SPEC.design and moves to
    // EXECUTE.plan.
    const batch = await mutateBatch(
      [
        {
          at: new Date(2026, 4, 15, 11, 0, 0).toISOString(),
          actor: "human:est9",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "spec-lock", decision: "approved", reason: "ready" },
        },
        {
          at: new Date(2026, 4, 15, 11, 0, 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: "SPEC.design", to: "EXECUTE.plan" },
        },
      ],
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.snapshot.state?.sub_state).toBe("EXECUTE.plan");
    expect(batch.snapshot.state?.spec_locked).toBe(true);
    // Batch envelope present on both entries (N=2).
    expect(batch.entries[0]!.batch_id).toBe(batch.entries[1]!.batch_id);
    expect(batch.entries[0]!.batch_index).toBe(0);
    expect(batch.entries[1]!.batch_index).toBe(1);
  });

  test("G. caller-supplied batch_id field → INVALID_BATCH", async () => {
    const dir = await tmpFeatureDir();
    const result = await mutateBatch(
      [
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          batch_id: "00000000-0000-0000-0000-000000000000" as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_BATCH");
      expect((result.detail as { forbidden_field?: string } | undefined)?.forbidden_field).toBe("batch_id");
    }
  });

  // ── F: REDUCER_IMPLEMENTED gate also fires in batch path ─────────────────
  test("F. mid-batch unimplemented kind (session:resumed) → REDUCER_ERROR failed_index, no append", async () => {
    const dir = await tmpFeatureDir();
    // session:resumed is ANY_SUB_STATE — boot is enough.
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
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
    );
    expect(boot.ok).toBe(true);
    if (!boot.ok) return;
    const snapshot = boot.snapshot;
    const tailSeq = 0;
    const entries: JournalEntry[] = [boot.entry];
    const meta = boot.meta;
    const journalBefore = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");

    // event:spec_req_added was previously the unimplemented kind exercised
    // here; Slice 1.B implemented it. session:resumed remains unimplemented.
    const batch = await mutateBatch(
      [
        {
          at: "2026-05-15T11:00:00.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "session:resumed",
          payload: { resumed_by: "human:ffoisx@gmail.com" },
        },
      ],
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(batch.ok).toBe(false);
    if (!batch.ok) {
      expect(batch.code).toBe("REDUCER_ERROR");
      expect(batch.failed_index).toBe(0);
    }
    const journalAfter = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journalAfter).toBe(journalBefore);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Slice 1.B sub-cycle 3c — mutateBatch Pass 1.5 spec-lock wire (codex r28)
// ────────────────────────────────────────────────────────────────────────

describe("mutateBatch Pass 1.5 — spec-lock gate wire (Slice 1.B sub-cycle 3c)", () => {
  async function seedAtSpecDesign(): Promise<{
    dir: string;
    snapshot: Snapshot;
    tailSeq: number;
    entries: JournalEntry[];
    meta: SnapshotMeta;
  }> {
    const dir = await tmpFeatureDir();
    let snapshot = initialSnapshot();
    let tailSeq = -1;
    let entries: JournalEntry[] = [];
    let meta = emptyMeta();
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
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );
    if (!boot.ok) throw new Error(`boot failed: ${boot.message}`);
    snapshot = boot.snapshot;
    tailSeq++;
    entries = entries.concat(boot.entry);
    meta = boot.meta;
    for (const [from, to] of [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
    ] as Array<[string, string]>) {
      const r = await mutate(
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: from as any, to: to as any },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
      );
      if (!r.ok) throw new Error(`walk failed: ${r.message}`);
      snapshot = r.snapshot;
      tailSeq++;
      entries = entries.concat(r.entry);
      meta = r.meta;
    }
    return { dir, snapshot, tailSeq, entries, meta };
  }

  test("missing spec.md → GATE_PRECONDITION_VIOLATION with check 1 subcode=SPEC_NOT_FOUND", async () => {
    const { dir, snapshot, tailSeq, entries, meta } = await seedAtSpecDesign();
    const journalBefore = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");

    const result = await mutateBatch(
      [
        {
          at: "2026-05-15T11:00:00.000Z",
          actor: "human:est9",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "spec-lock", decision: "approved", reason: "go" },
        },
      ],
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("GATE_PRECONDITION_VIOLATION");
      const detail = result.detail as
        | { gate?: string; failure_count?: number; checks?: Array<{ check: number; code: string; detail?: Record<string, unknown> }> }
        | undefined;
      expect(detail?.gate).toBe("spec-lock");
      expect(detail?.failure_count).toBe(1);
      expect(detail?.checks?.[0]?.check).toBe(1);
      expect(detail?.checks?.[0]?.code).toBe("SPEC_FRONTMATTER_INVALID");
      expect(detail?.checks?.[0]?.detail?.subcode).toBe("SPEC_NOT_FOUND");
    }
    // Journal must be untouched — gate fails before Pass 2 (sidecar/append).
    const journalAfter = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journalAfter).toBe(journalBefore);
  });

  test("stale tasks_based_on → GATE_PRECONDITION_VIOLATION with check 3 TASKS_BASED_ON_STALE", async () => {
    const { dir, snapshot, tailSeq, entries, meta } = await seedAtSpecDesign();
    // spec.md says spec_version: 2, but we'll plan tasks with based_on.spec: 1
    // by emitting tasks_planned then submitting a higher spec_version via
    // raw fixture (mock state to skip the spec_submitted bump path here).
    await fs.writeFile(
      path.join(dir, "spec.md"),
      `---
schema_version: 2
spec_version: 2
feature:
  id: F-001
  name: feat
intent: twenty char minimum intent body required by zod min
adr_refs: []
requirements:
  - id: REQ-AUTH-001
    type: ubiquitous
    response: the system shall do something measurable here
    acceptance_na: true
    acceptance_na_reason: subjective UX validated via manual testing scope
scenarios: []
needs_clarification: []
---
`,
    );
    // Stale snapshot: tasks_based_on.spec=1 (set by manual reducer write)
    const staleSnapshot: Snapshot = {
      ...snapshot,
      tasks_based_on: { spec: 1 },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          status: "pending",
          steps: {
            red: { applicability: "must", status: "pending" },
            implement: { applicability: "must", status: "pending" },
            refactor: { applicability: "optional", status: "pending" },
          },
          drives: ["REQ-AUTH-001"],
          depends_on: [],
          labels: [],
        },
      ],
    };

    const result = await mutateBatch(
      [
        {
          at: "2026-05-15T11:00:00.000Z",
          actor: "human:est9",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "spec-lock", decision: "approved", reason: "go" },
        },
      ],
      { feature_dir: dir, snapshot: staleSnapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("GATE_PRECONDITION_VIOLATION");
      const checks = (result.detail as { checks?: Array<{ check: number; code: string }> } | undefined)?.checks;
      expect(checks?.some((c) => c.check === 3 && c.code === "TASKS_BASED_ON_STALE")).toBe(true);
    }
  });

  test("multiple approved gate:decided in batch → MULTIPLE_GATE_DECISIONS", async () => {
    const { dir, snapshot, tailSeq, entries, meta } = await seedAtSpecDesign();
    const journalBefore = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");

    const result = await mutateBatch(
      [
        {
          at: "2026-05-15T11:00:00.000Z",
          actor: "human:est9",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "spec-lock", decision: "approved", reason: "a" },
        },
        {
          at: "2026-05-15T11:00:01.000Z",
          actor: "human:est9",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "spec-lock", decision: "approved", reason: "b" },
        },
      ],
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MULTIPLE_GATE_DECISIONS");
      expect((result.detail as { count?: number } | undefined)?.count).toBe(2);
    }
    const journalAfter = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journalAfter).toBe(journalBefore);
  });

  test("rejected spec-lock pass-through — evaluateSpecLock NOT called (no spec.md needed)", async () => {
    const { dir, snapshot, tailSeq, entries, meta } = await seedAtSpecDesign();
    // Deliberately do NOT write spec.md — proves gate evaluator was skipped.

    const result = await mutateBatch(
      [
        {
          at: "2026-05-15T11:00:00.000Z",
          actor: "human:est9",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "spec-lock", decision: "rejected", reason: "needs more work" },
        },
      ],
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // spec_locked stays false (rejected gate doesn't flip the flag);
      // entry is appended to the journal.
      expect(result.snapshot.state?.spec_locked).toBe(false);
      expect(result.entries).toHaveLength(1);
    }
  });

  test("mutate() single-entry wrapper inherits gate rejection", async () => {
    const { dir, snapshot, tailSeq, entries, meta } = await seedAtSpecDesign();
    // mutate() wraps mutateBatch — gate Pass 1.5 fires on the single-entry
    // path too. spec.md missing → GATE_PRECONDITION_VIOLATION.

    const result = await mutate(
      {
        at: "2026-05-15T11:00:00.000Z",
        actor: "human:est9",
        entry_schema_version: 1,
        kind: "gate:decided",
        payload: { gate_kind: "spec-lock", decision: "approved", reason: "go" },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("GATE_PRECONDITION_VIOLATION");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// Slice 1.C sub-cycle 1 — EvidenceFullPayload strict refines via mutate
// (codex r34 HIGH 3): prove PER_KIND_PAYLOAD wire actually triggers the
// schema refines at append time, not just at the EvidenceFullPayload unit
// boundary. These tests exercise the full path: mutate → preflight → Pass 1
// payload schema lookup → reject → no journal write.
// ───────────────────────────────────────────────────────────────────────

describe("mutate evidence:added — strict refines (Slice 1.C sub-cycle 1)", () => {
  async function bootstrapToExecuteWork(): Promise<{
    dir: string;
    snapshot: Snapshot;
    tailSeq: number;
    entries: JournalEntry[];
    meta: SnapshotMeta;
  }> {
    const dir = await tmpFeatureDir();
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
      { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
    );
    if (!boot.ok) throw new Error(`bootstrap failed: ${boot.code}`);
    const transitions = [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
      ["SPEC.design", "EXECUTE.plan"],
      ["EXECUTE.plan", "EXECUTE.work"],
    ] as const;
    let snapshot = boot.snapshot;
    let tailSeq = 0;
    let entries: JournalEntry[] = [boot.entry];
    let meta = boot.meta;
    for (const [from, to] of transitions) {
      const r = await mutate(
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from, to },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
      );
      if (!r.ok) throw new Error(`transition ${from}->${to} failed: ${r.code}`);
      snapshot = r.snapshot;
      tailSeq++;
      entries = entries.concat(r.entry);
      meta = r.meta;
    }
    return { dir, snapshot, tailSeq, entries, meta };
  }

  test("kind=visual-review without attachments → INVALID_PAYLOAD, no append", async () => {
    const { dir, snapshot, tailSeq, entries, meta } = await bootstrapToExecuteWork();
    const before = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");

    const r = await mutate(
      {
        at: "2026-05-15T11:00:00.000Z",
        actor: "human:reviewer@example.com",
        entry_schema_version: 1,
        kind: "evidence:added",
        payload: {
          id: "EV-000001",
          kind: "visual-review",
          iteration: 1,
          actor: "human:reviewer@example.com",
          result: "approved",
          summary: "visual review of UI VIS-AUTH-001",
          covers: ["VIS-AUTH-001"],
          // attachments intentionally omitted — refine should reject.
        },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PAYLOAD");
    // Journal byte-identical — refine fired before append.
    const after = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(after).toBe(before);
  });

  test("kind=manual without human:* actor → INVALID_PAYLOAD, no append", async () => {
    const { dir, snapshot, tailSeq, entries, meta } = await bootstrapToExecuteWork();
    const before = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");

    const r = await mutate(
      {
        at: "2026-05-15T11:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "evidence:added",
        payload: {
          id: "EV-000001",
          kind: "manual",
          iteration: 1,
          actor: "cli:loaf",                       // NOT human:* → refine rejects
          result: "passed",
          summary: "manual verification of REQ-AUTH-001",
          reason: "tested the flow by hand on staging",
          covers: ["REQ-AUTH-001"],
        },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PAYLOAD");
    const after = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(after).toBe(before);
  });

  test("unknown payload key (.strict() catch) → INVALID_PAYLOAD, no append", async () => {
    const { dir, snapshot, tailSeq, entries, meta } = await bootstrapToExecuteWork();
    const before = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");

    const r = await mutate(
      {
        at: "2026-05-15T11:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "evidence:added",
        payload: {
          id: "EV-000001",
          kind: "local-check",
          iteration: 1,
          actor: "cli:loaf",
          result: "passed",
          summary: "stub local-check evidence",
          bogus_undocumented_field: "should not pass strict mode",
        },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PAYLOAD");
    const after = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(after).toBe(before);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Slice 1.C sub-cycle 5 — mutateBatch Pass 1.5 verify-accept gate wire
// ────────────────────────────────────────────────────────────────────────

describe("mutateBatch Pass 1.5 — verify-accept gate wire (Slice 1.C sub-cycle 5)", () => {
  // Minimal valid spec.md for verify-accept evaluation: single ubiquitous
  // REQ with acceptance_na=true so SCEN/VIS coverage is skipped; no done
  // tasks in the seeded snapshot so RUN/REVIEW lane obligations are empty.
  const SPEC_MD_VERIFY_HAPPY = `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: OAuth refresh
intent: keep auth invisible during refresh roundtrips
adr_refs: []
needs_clarification: []
requirements:
  - id: REQ-AUTH-001
    type: ubiquitous
    response: the system shall preserve the original request after refresh
    acceptance_na: true
    acceptance_na_reason: covered by manual UX walk-through scope
scenarios: []
---

# OAuth refresh

(spec body...)
`;

  /**
   * Bootstrap session + walk to VERIFY.accept. PER_KIND_SUB_STATE for
   * gate:decided allows ["SPEC.design", "VERIFY.accept"], so we can land
   * a verify-accept gate decision once the cursor reaches VERIFY.accept.
   *
   * The walk goes TRIAGE.score → ... → SPEC.design → EXECUTE.plan → work
   * → done → VERIFY.plan → run → review → acceptance → visual → accept.
   * No tasks/evidence/findings are populated — Pass 1.5 verify-accept
   * eval only reads spec.md + snapshot.tasks/evidence/findings/state,
   * and the snapshot already has them as defaults from the reducer.
   */
  async function seedAtVerifyAccept(): Promise<{
    dir: string;
    snapshot: Snapshot;
    tailSeq: number;
    entries: JournalEntry[];
    meta: SnapshotMeta;
  }> {
    const dir = await tmpFeatureDir();
    let snapshot = initialSnapshot();
    let tailSeq = -1;
    let entries: JournalEntry[] = [];
    let meta = emptyMeta();
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
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );
    if (!boot.ok) throw new Error(`boot failed: ${boot.message}`);
    snapshot = boot.snapshot;
    tailSeq++;
    entries = entries.concat(boot.entry);
    meta = boot.meta;

    // emit() — a single-entry mutate threading the {snapshot, tailSeq,
    // entries, meta} accumulators. Used to step the seed forward.
    const emit = async (entry: Parameters<typeof mutate>[0]): Promise<void> => {
      const r = await mutate(entry, {
        feature_dir: dir,
        snapshot,
        tail_seq: tailSeq,
        entries,
        meta,
        fsync: false,
      });
      if (!r.ok) throw new Error(`seedAtVerifyAccept emit (${entry.kind}) failed: ${r.message}`);
      snapshot = r.snapshot;
      tailSeq++;
      entries = entries.concat(r.entry);
      meta = r.meta;
    };
    const advance = async (from: string, to: string): Promise<void> => {
      await emit({
        at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: from as any, to: to as any },
      });
    };

    for (const [from, to] of [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
      ["SPEC.design", "EXECUTE.plan"],
    ] as Array<[string, string]>) {
      await advance(from, to);
    }

    // Emit an empty-graph event:tasks_planned. The verify-accept happy
    // fixture needs a VACUOUSLY-passing gate (no task obligations, no
    // VERIFY-lane obligations), but Phase 15 SC2's step-8 composeTasksJson
    // rejects a `tasks_based_on` set with `version` 0 — so the seed must
    // carry a real tasks_planned. An empty `tasks: []` keeps the gate
    // vacuous (`snapshot.tasks` empty) while making `tasks_based_on`
    // journal-derived and `version` = 1.
    await emit({
      at: new Date(2026, 4, 15, 10, 5, 0).toISOString(),
      actor: "human:est9",
      entry_schema_version: 1,
      kind: "event:tasks_planned",
      payload: { based_on: { spec: 1 }, tasks: [] },
    });
    for (const [from, to] of [
      ["EXECUTE.plan", "EXECUTE.work"],
      ["EXECUTE.work", "EXECUTE.done"],
      ["EXECUTE.done", "VERIFY.plan"],
      ["VERIFY.plan", "VERIFY.run"],
      ["VERIFY.run", "VERIFY.review"],
      ["VERIFY.review", "VERIFY.acceptance"],
      ["VERIFY.acceptance", "VERIFY.visual"],
      ["VERIFY.visual", "VERIFY.accept"],
    ] as Array<[string, string]>) {
      await advance(from, to);
    }
    return { dir, snapshot, tailSeq, entries, meta };
  }

  test("approve verify-accept happy → ok=true, flag flipped, journal grows", async () => {
    const { dir, snapshot, tailSeq, entries, meta } = await seedAtVerifyAccept();
    await fs.writeFile(path.join(dir, "spec.md"), SPEC_MD_VERIFY_HAPPY);
    // tasks_based_on is now journal-derived (seedAtVerifyAccept emits a real
    // event:tasks_planned), so the snapshot already satisfies verify-accept
    // check 4 — no synthetic injection needed (Phase 15 SC2: step 8
    // re-serializes tasks.json, which requires a real tasks_planned).
    const happySnap: Snapshot = snapshot;
    const journalBefore = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");

    const result = await mutate(
      {
        at: "2026-05-15T11:00:00.000Z",
        actor: "human:est9",
        entry_schema_version: 1,
        kind: "gate:decided",
        payload: {
          gate_kind: "verify-accept",
          decision: "approved",
          reason: "all checks pass",
        },
      },
      { feature_dir: dir, snapshot: happySnap, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.snapshot.state?.verify_accepted).toBe(true);
    expect(result.snapshot.state?.sub_state).toBe("VERIFY.accept"); // gate does NOT move cursor
    const journalAfter = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journalAfter.length).toBeGreaterThan(journalBefore.length);
  });

  test("missing spec.md → GATE_PRECONDITION_VIOLATION + gate=verify-accept + subcode=SPEC_NOT_FOUND", async () => {
    const { dir, snapshot, tailSeq, entries, meta } = await seedAtVerifyAccept();
    const journalBefore = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    // Deliberately do NOT write spec.md — proves eval ran + spec read failed.

    const result = await mutate(
      {
        at: "2026-05-15T11:00:00.000Z",
        actor: "human:est9",
        entry_schema_version: 1,
        kind: "gate:decided",
        payload: {
          gate_kind: "verify-accept",
          decision: "approved",
          reason: "go",
        },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("GATE_PRECONDITION_VIOLATION");
    expect((result.detail as { gate?: string }).gate).toBe("verify-accept");
    expect((result.detail as { failure_count?: number }).failure_count).toBe(1);
    const checks = (result.detail as { checks?: Array<{ code: string; detail?: { subcode?: string } }> }).checks ?? [];
    expect(checks[0]!.code).toBe("SPEC_FRONTMATTER_INVALID");
    expect(checks[0]!.detail?.subcode).toBe("SPEC_NOT_FOUND");
    // Journal untouched — Pass 1.5 fired before Pass 2/4 append.
    const journalAfter = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journalAfter).toBe(journalBefore);
  });

  test("verify-accept rejected pass-through — evaluateVerifyAccept NOT called (no spec.md needed)", async () => {
    const { dir, snapshot, tailSeq, entries, meta } = await seedAtVerifyAccept();
    // Deliberately do NOT write spec.md — proves eval was skipped for rejection.

    const result = await mutate(
      {
        at: "2026-05-15T11:00:00.000Z",
        actor: "human:est9",
        entry_schema_version: 1,
        kind: "gate:decided",
        payload: {
          gate_kind: "verify-accept",
          decision: "rejected",
          reason: "not ready",
        },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // verify_accepted stays false on rejection.
    expect(result.snapshot.state?.verify_accepted).toBe(false);
  });

  test("MULTIPLE_GATE_DECISIONS rejects two approved verify-accept entries in one batch", async () => {
    const { dir, snapshot, tailSeq, entries, meta } = await seedAtVerifyAccept();

    const result = await mutateBatch(
      [
        {
          at: "2026-05-15T11:00:00.000Z",
          actor: "human:est9",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "verify-accept", decision: "approved", reason: "ok" },
        },
        {
          at: "2026-05-15T11:00:01.000Z",
          actor: "human:est9",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "verify-accept", decision: "approved", reason: "again" },
        },
      ],
      { feature_dir: dir, snapshot, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("MULTIPLE_GATE_DECISIONS");
    expect((result.detail as { count?: number }).count).toBe(2);
  });

  test("verify-accept fail with open finding → GATE_PRECONDITION_VIOLATION + OPEN_FINDINGS_PRESENT", async () => {
    const { dir, snapshot, tailSeq, entries, meta } = await seedAtVerifyAccept();
    await fs.writeFile(path.join(dir, "spec.md"), SPEC_MD_VERIFY_HAPPY);
    // Inject tasks_based_on + an open finding directly into snapshot
    // (bypassing the tasks_planned + finding:raised journal paths because
    // Pass 1.5 reads ctx.snapshot pre-batch). Without tasks_based_on,
    // check 4 precondition fires before check 2 reaches the open-finding
    // assertion; we want the test focused on check 2 visibility.
    const snapWithFinding: Snapshot = {
      ...snapshot,
      tasks_based_on: { spec: 1 },
      findings: [
        ...snapshot.findings,
        { id: "FND-001", category: "impl-defect", action: "fix-impl", status: "open" },
      ],
    };
    const journalBefore = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");

    const result = await mutate(
      {
        at: "2026-05-15T11:00:00.000Z",
        actor: "human:est9",
        entry_schema_version: 1,
        kind: "gate:decided",
        payload: {
          gate_kind: "verify-accept",
          decision: "approved",
          reason: "wishing it through",
        },
      },
      { feature_dir: dir, snapshot: snapWithFinding, tail_seq: tailSeq, entries, meta, fsync: false },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("GATE_PRECONDITION_VIOLATION");
    expect((result.detail as { gate?: string }).gate).toBe("verify-accept");
    const checks = (result.detail as { checks?: Array<{ code: string }> }).checks ?? [];
    expect(checks.some((c) => c.code === "OPEN_FINDINGS_PRESENT")).toBe(true);
    // Journal untouched.
    const journalAfter = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journalAfter).toBe(journalBefore);
  });
});
