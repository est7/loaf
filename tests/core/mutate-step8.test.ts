// Phase 15 SC2 — mutate step 8: snapshot projection sync.
//
// After mutateBatch appends to the journal it re-serializes all five
// `snapshots/*.json` projection files plus `_meta.json` (the same
// `writeProjections` `loaf doctor --rebuild` drives), so the projections
// stay fresh on every mutation — not just on `doctor --rebuild`.
//
// Covers (codex r170 test set, items 2-5):
//   2. a normal mutation writes all five snapshots/*.json + _meta.json;
//      _meta.json.last_applied_seq == the appended tail seq.
//   3. _meta.json is written after the data files (rebuild discipline:
//      metadata strictly after data); a planless state removes a stale
//      tasks.json.
//   4. a projection-write failure after a successful journal append
//      surfaces PROJECTION_WRITE_FAILED with journal_appended:true and
//      recovery text mentioning `doctor --rebuild`.
//   5. a corrupt/stale MutateContext fails fast BEFORE the append.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { mutate, mutateBatch } from "../../src/core/journal-mutate.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import { emptyMeta, readMeta, type SnapshotMeta } from "../../src/core/snapshot.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";

async function tmpFeatureDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loaf-step8-"));
}

const STANDARD = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip" as const,
  strict_drift_check: false,
};

function sessionStart(): Parameters<typeof mutate>[0] {
  return {
    at: "2026-05-22T10:00:00.000Z",
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

describe("mutate step 8 — snapshot projection sync (Phase 15 SC2)", () => {
  test("a normal mutation writes all five snapshots/*.json + _meta.json", async () => {
    const dir = await tmpFeatureDir();
    const r = await mutate(sessionStart(), {
      feature_dir: dir,
      snapshot: initialSnapshot(),
      tail_seq: -1,
      entries: [],
      meta: emptyMeta(),
      fsync: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const snapDir = path.join(dir, "snapshots");
    // state.json — written (a session exists).
    expect((await fs.stat(path.join(snapDir, "state.json"))).isFile()).toBe(true);
    // evidence / findings / pending — always written (Q3: all five, no filter).
    for (const f of ["evidence.json", "findings.json", "pending.json"]) {
      expect((await fs.stat(path.join(snapDir, f))).isFile()).toBe(true);
    }
    // _meta.json — written; last_applied_seq == the appended tail seq.
    const meta = await readMeta(path.join(snapDir, "_meta.json"));
    expect(meta).not.toBeNull();
    expect(meta!.last_applied_seq).toBe(0);
    expect(meta!.last_applied_seq).toBe(r.entry.seq);
    // The mutate result's meta is the same post-append meta step 8 wrote.
    expect(r.meta.last_applied_seq).toBe(0);
  });

  test("_meta.json reflects the journal tail; a planless state carries no tasks.json", async () => {
    const dir = await tmpFeatureDir();
    // session:started leaves a planless feature — composeTasksJson returns
    // null, so tasks.json is never written (it would be a stale projection).
    const r = await mutate(sessionStart(), {
      feature_dir: dir,
      snapshot: initialSnapshot(),
      tail_seq: -1,
      entries: [],
      meta: emptyMeta(),
      fsync: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const snapDir = path.join(dir, "snapshots");
    // No task plan → no tasks.json (rebuild discipline — never a stale file).
    await expect(fs.stat(path.join(snapDir, "tasks.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    // _meta.json is internally consistent with the just-appended journal:
    // the reader-staleness check (Gate #5) must see it as fresh.
    const meta = await readMeta(path.join(snapDir, "_meta.json"));
    expect(meta).not.toBeNull();
    const { checkSnapshotFresh } = await import("../../src/core/snapshot-reader.js");
    const fresh = await checkSnapshotFresh(meta!, path.join(dir, "journal.jsonl"));
    expect(fresh.fresh).toBe(true);
  });

  test("a projection-write failure after a journal append → PROJECTION_WRITE_FAILED, journal_appended:true", async () => {
    const dir = await tmpFeatureDir();
    // Pre-create snapshots/state.json AS A DIRECTORY. writeProjections'
    // atomic tmp→state.json rename then fails (EISDIR / ENOTEMPTY) — step 8
    // catches it and surfaces PROJECTION_WRITE_FAILED. The journal append
    // already succeeded, so the journal is authoritative.
    await fs.mkdir(path.join(dir, "snapshots", "state.json"), { recursive: true });

    const r = await mutate(sessionStart(), {
      feature_dir: dir,
      snapshot: initialSnapshot(),
      tail_seq: -1,
      entries: [],
      meta: emptyMeta(),
      fsync: false,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("PROJECTION_WRITE_FAILED");
    expect(r.detail).toBeDefined();
    expect(r.detail!["journal_appended"]).toBe(true);
    expect(typeof r.detail!["last_seq"]).toBe("number");
    // Recovery text points the operator at `loaf doctor --rebuild`.
    expect(r.message).toContain("doctor --rebuild");

    // Critical: the journal already carries the appended entry — journal is
    // truth even though the projection write failed.
    const journal = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lines = journal.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).kind).toBe("session:started");
  });

  test("stale MutateContext (entries tail seq != tail_seq) → fails fast, journal untouched", async () => {
    const dir = await tmpFeatureDir();
    // Bootstrap one real entry so the journal exists at seq=0.
    const boot = await mutate(sessionStart(), {
      feature_dir: dir,
      snapshot: initialSnapshot(),
      tail_seq: -1,
      entries: [],
      meta: emptyMeta(),
      fsync: false,
    });
    expect(boot.ok).toBe(true);
    if (!boot.ok) return;
    const journalBefore = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");

    // Hand-build a context that LIES: tail_seq=0 but entries is empty
    // (entries tail seq = -1) and meta.last_applied_seq = -1.
    const stale = await mutate(
      {
        at: "2026-05-22T10:00:01.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: "TRIAGE.score", to: "TRIAGE.confirm" },
      },
      {
        feature_dir: dir,
        snapshot: boot.snapshot,
        tail_seq: 0,
        entries: [], // <- inconsistent: tail seq -1, not 0
        meta: emptyMeta(), // <- inconsistent: last_applied_seq -1, not 0
        fsync: false,
      },
    );

    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe("INVALID_BATCH");
    // The journal must be byte-identical — the fail-fast invariant fired
    // BEFORE the append.
    expect(await fs.readFile(path.join(dir, "journal.jsonl"), "utf8")).toBe(journalBefore);
  });

  test("stale MutateContext (meta.last_applied_seq != tail_seq) → fails fast", async () => {
    const dir = await tmpFeatureDir();
    const boot = await mutate(sessionStart(), {
      feature_dir: dir,
      snapshot: initialSnapshot(),
      tail_seq: -1,
      entries: [],
      meta: emptyMeta(),
      fsync: false,
    });
    expect(boot.ok).toBe(true);
    if (!boot.ok) return;
    const journalBefore = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");

    // entries is consistent (boot.entry, tail seq 0) but meta lies (-1).
    const entriesAcc: JournalEntry[] = [boot.entry];
    const staleMeta: SnapshotMeta = emptyMeta(); // last_applied_seq = -1
    const r = await mutate(
      {
        at: "2026-05-22T10:00:01.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: "TRIAGE.score", to: "TRIAGE.confirm" },
      },
      {
        feature_dir: dir,
        snapshot: boot.snapshot,
        tail_seq: 0,
        entries: entriesAcc,
        meta: staleMeta,
        fsync: false,
      },
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_BATCH");
    expect(await fs.readFile(path.join(dir, "journal.jsonl"), "utf8")).toBe(journalBefore);
  });

  test("batch mutation: step 8 keeps _meta.json consistent across a 2-entry batch", async () => {
    const dir = await tmpFeatureDir();
    const r = await mutateBatch(
      [
        sessionStart(),
        {
          at: "2026-05-22T10:00:01.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: "TRIAGE.score", to: "TRIAGE.confirm" },
        },
      ],
      {
        feature_dir: dir,
        snapshot: initialSnapshot(),
        tail_seq: -1,
        entries: [],
        meta: emptyMeta(),
        fsync: false,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const meta = await readMeta(path.join(dir, "snapshots", "_meta.json"));
    expect(meta).not.toBeNull();
    // The batch appended seq 0 and 1 — _meta tail is the last entry.
    expect(meta!.last_applied_seq).toBe(1);
    expect(r.meta.last_applied_seq).toBe(1);
    const { checkSnapshotFresh } = await import("../../src/core/snapshot-reader.js");
    const fresh = await checkSnapshotFresh(meta!, path.join(dir, "journal.jsonl"));
    expect(fresh.fresh).toBe(true);
  });
});
