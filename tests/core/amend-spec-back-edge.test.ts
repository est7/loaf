// Slice B — finding amend-spec back-edge batch tests.
//
// Covers (codex r94/r96 plan v2 → r96 GO-with-refinements):
//   - validateTransition: back-edge action→target/from contract
//   - reducer.apply phase_advanced: spec_locked reset on SPEC.spec
//   - preflight refines: FINDING_AMEND_SPEC_NOT_LOCKED +
//     FINDING_NOT_FOUND (open-only)
//   - mutateBatch integration: 2-entry happy path + cross-batch
//     stale-sponsorship rejection + graceful standalone raw path
//   - REPLAY ANCHOR (codex r94 Q7 mandatory): journal-derivability
//     proof — replayJournal must reproduce the spec_locked=false
//     snapshot from a 2-entry journal.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { mutateBatch } from "../../src/core/journal-mutate.js";
import { appendEntry } from "../../src/core/journal-append.js";
import { emptyMeta, type SnapshotMeta } from "../../src/core/snapshot.js";
import { apply, initialSnapshot, type Snapshot } from "../../src/core/reducer.js";
import { replayJournal } from "../../src/core/journal-bootstrap.js";
import { validateTransition } from "../../src/core/reducer/transition.js";
import type { Ceremony, JournalEntry, SubState } from "../../src/core/journal-entry.js";

const STANDARD: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

async function tmpFeatureDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loaf-slice-b-"));
}

// Build a snapshot that already passed gate decide spec-lock --approve:
// state.spec_locked=true at the given post-lock sub_state, with one
// finding optionally pre-populated.
function snapshotPostLock(
  subState: SubState,
  opts: {
    spec_locked?: boolean;
    findings?: Array<{ id: string; action: string; status: "open" | "closed" }>;
  } = {},
): Snapshot {
  const snap = initialSnapshot();
  snap.state = {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    feature: "auth-refresh",
    phase: subState.split(".")[0]! as "TRIAGE" | "SPEC" | "EXECUTE" | "VERIFY" | "SETTLE" | "DONE",
    sub_state: subState,
    iteration: 0,
    spec_locked: opts.spec_locked ?? true,
    verify_accepted: false,
    spec_version: 2,
    ceremony: STANDARD,
  };
  snap.spec_header = {
    feature: { id: "F-001", name: "OAuth token refresh" },
    intent: "users should not perceive auth recovery flows in flight",
    adr_refs: [],
    needs_clarification: [],
  };
  snap.tasks_based_on = { spec: 2 };
  for (const f of opts.findings ?? []) {
    snap.findings.push({
      id: f.id,
      category: "spec-gap",
      action: f.action as "amend-spec",
      status: f.status,
    });
  }
  return snap;
}

function makeEntry<K extends JournalEntry["kind"]>(
  seq: number,
  kind: K,
  payload: unknown,
  actor = "human:test@invalid.local",
): JournalEntry {
  // Pack large seq into minutes:seconds to keep `at` a valid ISO
  // datetime (seconds must be 00-59).
  const mins = Math.floor(seq / 60) % 60;
  const secs = seq % 60;
  const at = `2026-05-19T10:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.000Z`;
  return {
    seq,
    entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
    at,
    actor,
    entry_schema_version: 1,
    kind,
    payload,
  } as JournalEntry;
}

// ── validateTransition direct tests ────────────────────────────────────

describe("validateTransition — Slice B back-edge (codex r96 §1)", () => {
  test("amend-spec back_edge EXECUTE.work → SPEC.spec legal with finding_id", () => {
    const r = validateTransition("EXECUTE.work", "SPEC.spec", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "amend-spec", finding_id: "FND-001" },
    });
    expect(r.ok).toBe(true);
  });

  test("amend-spec back_edge with target!=SPEC.spec rejected (target_mismatch)", () => {
    const r = validateTransition("EXECUTE.work", "DONE.archived", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "amend-spec", finding_id: "FND-001" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TRANSITION_ILLEGAL");
      expect(r.detail!["reason"]).toBe("back_edge_target_mismatch");
    }
  });

  test("amend-spec back_edge targeting DONE.archived rejected — must target SPEC.spec (r96 §1)", () => {
    // An amend-spec back_edge is legal only into SPEC.spec; DONE.archived
    // is not a back_edge target. (This test historically also guarded
    // ordering against the ALWAYS_LEGAL_TARGETS eject bypass — that set
    // was removed in Phase 11 Item 2; DONE.* terminals now carry no
    // event:phase_advanced edges at all.)
    const r = validateTransition("EXECUTE.work", "DONE.archived", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "amend-spec", finding_id: "FND-001" },
    });
    expect(r.ok).toBe(false);
  });

  test("amend-spec back_edge from SPEC.proposal rejected (not in BACK_EDGE_AMEND_SPEC_FROM)", () => {
    const r = validateTransition("SPEC.proposal", "SPEC.spec", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "amend-spec", finding_id: "FND-001" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail!["reason"]).toBe("back_edge_from_not_allowed");
    }
  });

  test("forward SPEC.proposal → SPEC.spec WITHOUT back_edge still legal", () => {
    const r = validateTransition("SPEC.proposal", "SPEC.spec", {
      ceremony: STANDARD,
      actor: "cli:loaf",
    });
    expect(r.ok).toBe(true);
  });

  test.each([
    "EXECUTE.plan",
    "EXECUTE.work",
    "EXECUTE.done",
    "VERIFY.plan",
    "VERIFY.run",
    "VERIFY.review",
    "VERIFY.acceptance",
    "VERIFY.visual",
    "VERIFY.accept",
  ] as const)("amend-spec back_edge from %s → SPEC.spec legal", (prev) => {
    const r = validateTransition(prev, "SPEC.spec", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "amend-spec", finding_id: "FND-042" },
    });
    expect(r.ok).toBe(true);
  });
});

// ── reducer.apply — spec_locked reset on phase_advanced → SPEC.spec ─────

describe("reducer.apply phase_advanced — Slice B spec_locked reset", () => {
  test("spec_locked=true → phase_advanced SPEC.spec resets to false", () => {
    const snap = snapshotPostLock("EXECUTE.work", {
      findings: [{ id: "FND-001", action: "amend-spec", status: "open" }],
    });
    const next = apply(
      snap,
      makeEntry(99, "event:phase_advanced", {
        from: "EXECUTE.work",
        to: "SPEC.spec",
        back_edge: { action: "amend-spec", finding_id: "FND-001" },
      }),
    );
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.snapshot.state!.spec_locked).toBe(false);
      expect(next.snapshot.state!.sub_state).toBe("SPEC.spec");
    }
  });

  test("spec_locked=false → phase_advanced SPEC.spec apply leaves alone (no-op for forward edge)", () => {
    const snap = snapshotPostLock("SPEC.proposal", { spec_locked: false });
    const next = apply(
      snap,
      makeEntry(99, "event:phase_advanced", { from: "SPEC.proposal", to: "SPEC.spec" }),
    );
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.snapshot.state!.spec_locked).toBe(false);
    }
  });

  test("phase_advanced to non-SPEC.spec target leaves spec_locked=true alone", () => {
    const snap = snapshotPostLock("EXECUTE.plan");
    const next = apply(
      snap,
      makeEntry(99, "event:phase_advanced", { from: "EXECUTE.plan", to: "EXECUTE.work" }),
    );
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.snapshot.state!.spec_locked).toBe(true);
      expect(next.snapshot.state!.sub_state).toBe("EXECUTE.work");
    }
  });
});

// ── reducer.apply — iteration bump on finding back-edge (Phase 11 Item 3 SC0) ──
//
// protocol.md §1 (~L210-212): EVERY finding back-edge increments
// `state.iteration` by 1. A plain forward `event:phase_advanced`
// (no `back_edge`) leaves iteration unchanged.

describe("reducer.apply phase_advanced — Item 3 SC0 iteration bump", () => {
  test("amend-spec back_edge → iteration += 1 (and spec_locked still reset to false)", () => {
    const snap = snapshotPostLock("EXECUTE.work", {
      findings: [{ id: "FND-001", action: "amend-spec", status: "open" }],
    });
    expect(snap.state!.iteration).toBe(0); // snapshotPostLock baseline
    const next = apply(
      snap,
      makeEntry(99, "event:phase_advanced", {
        from: "EXECUTE.work",
        to: "SPEC.spec",
        back_edge: { action: "amend-spec", finding_id: "FND-001" },
      }),
    );
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.snapshot.state!.iteration).toBe(1);
      // regression — spec_locked reset must still hold
      expect(next.snapshot.state!.spec_locked).toBe(false);
      expect(next.snapshot.state!.sub_state).toBe("SPEC.spec");
    }
  });

  test("plain forward phase_advanced (no back_edge) leaves iteration unchanged", () => {
    const snap = snapshotPostLock("EXECUTE.plan");
    expect(snap.state!.iteration).toBe(0);
    const next = apply(
      snap,
      makeEntry(99, "event:phase_advanced", { from: "EXECUTE.plan", to: "EXECUTE.work" }),
    );
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.snapshot.state!.iteration).toBe(0);
    }
  });

  test("forward SPEC.proposal → SPEC.spec (no back_edge) leaves iteration unchanged", () => {
    const snap = snapshotPostLock("SPEC.proposal", { spec_locked: false });
    expect(snap.state!.iteration).toBe(0);
    const next = apply(
      snap,
      makeEntry(99, "event:phase_advanced", { from: "SPEC.proposal", to: "SPEC.spec" }),
    );
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.snapshot.state!.iteration).toBe(0);
    }
  });
});

// Seed a REAL journal to EXECUTE.work, spec_locked=true (Phase 15 SC2:
// mutateBatch step 8 re-serializes all five projection files, so the entry
// stream must be consistent with the snapshot — a synthetic `snapshotPostLock`
// over an empty journal is no longer admissible). amend-spec needs no task
// graph, so the bootstrap skips tasks_planned. Raw `appendEntry` builds the
// journal (bypassing mutateBatch's Pass 1.5 gate eval — fine for a fixture);
// `replayJournal` then derives the authentic {snapshot, entries, meta} triple.
async function seedRealJournalAtExecuteWork(dir: string): Promise<{
  snapshot: Snapshot;
  tailSeq: number;
  entries: JournalEntry[];
  meta: SnapshotMeta;
}> {
  const journalPath = path.join(dir, "journal.jsonl");
  let seq = 0;
  const bootstrap: JournalEntry[] = [
    makeEntry(seq++, "session:started", {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "auth-refresh",
      ceremony: STANDARD,
    }, "cli:loaf"),
  ];
  for (const [from, to] of [
    ["TRIAGE.score", "TRIAGE.confirm"],
    ["TRIAGE.confirm", "SPEC.proposal"],
    ["SPEC.proposal", "SPEC.spec"],
    ["SPEC.spec", "SPEC.plan"],
    ["SPEC.plan", "SPEC.design"],
  ] as Array<[SubState, SubState]>) {
    bootstrap.push(makeEntry(seq++, "event:phase_advanced", { from, to }, "cli:loaf"));
  }
  bootstrap.push(
    makeEntry(seq++, "gate:decided", {
      gate_kind: "spec-lock",
      decision: "approved",
      reason: "fixture bootstrap",
    }, "human:engineer@test.local"),
  );
  bootstrap.push(
    makeEntry(seq++, "event:phase_advanced", { from: "SPEC.design", to: "EXECUTE.plan" }, "cli:loaf"),
  );
  bootstrap.push(
    makeEntry(seq++, "event:phase_advanced", { from: "EXECUTE.plan", to: "EXECUTE.work" }, "cli:loaf"),
  );

  let meta = emptyMeta();
  for (const e of bootstrap) meta = await appendEntry(journalPath, e, meta, { fsync: false });

  const replay = await replayJournal(journalPath, { collect_entries: true });
  if (!replay.ok) {
    throw new Error(`seedRealJournalAtExecuteWork replay failed: ${replay.code} ${replay.message}`);
  }
  return {
    snapshot: replay.snapshot,
    tailSeq: replay.meta.last_applied_seq,
    entries: replay.entries ?? [],
    meta: replay.meta,
  };
}

// ── mutateBatch integration ─────────────────────────────────────────────

describe("mutateBatch — Slice B amend-spec batch integration", () => {
  test("[finding:raised amend-spec, phase_advanced back_edge] from EXECUTE.work → spec_locked=false, sub_state=SPEC.spec", async () => {
    const dir = await tmpFeatureDir();
    const seed = await seedRealJournalAtExecuteWork(dir);
    const r = await mutateBatch(
      [
        {
          at: "2026-05-19T11:00:00.000Z",
          actor: "human:engineer@test.local",
          entry_schema_version: 1,
          kind: "finding:raised",
          payload: {
            id: "FND-001",
            category: "spec-gap",
            action: "amend-spec",
            summary: "missed an EARS requirement",
          },
        },
        {
          at: "2026-05-19T11:00:00.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: {
            from: "EXECUTE.work",
            to: "SPEC.spec",
            back_edge: { action: "amend-spec", finding_id: "FND-001" },
          },
        },
      ],
      {
        feature_dir: dir,
        snapshot: seed.snapshot,
        tail_seq: seed.tailSeq,
        entries: seed.entries,
        meta: seed.meta,
        fsync: false,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.snapshot.state!.sub_state).toBe("SPEC.spec");
      expect(r.snapshot.state!.spec_locked).toBe(false);
      expect(r.snapshot.findings).toHaveLength(1);
      expect(r.snapshot.findings[0]!.id).toBe("FND-001");
      expect(r.snapshot.findings[0]!.action).toBe("amend-spec");
    }
  });

  test("phase_advanced back_edge alone (unresolved finding_id) → FINDING_NOT_FOUND reason=not_found", async () => {
    const dir = await tmpFeatureDir();
    const baseSnap = snapshotPostLock("EXECUTE.work");
    const r = await mutateBatch(
      [
        {
          at: "2026-05-19T11:00:00.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: {
            from: "EXECUTE.work",
            to: "SPEC.spec",
            back_edge: { action: "amend-spec", finding_id: "FND-999" },
          },
        },
      ],
      { feature_dir: dir, snapshot: baseSnap, tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("FINDING_NOT_FOUND");
      expect(r.detail!["reason"]).toBe("not_found");
    }
  });

  test("phase_advanced back_edge with already_closed finding → FINDING_NOT_FOUND reason=already_closed (codex r96 §4)", async () => {
    const dir = await tmpFeatureDir();
    const baseSnap = snapshotPostLock("EXECUTE.work", {
      findings: [{ id: "FND-001", action: "amend-spec", status: "closed" }],
    });
    const r = await mutateBatch(
      [
        {
          at: "2026-05-19T11:00:00.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: {
            from: "EXECUTE.work",
            to: "SPEC.spec",
            back_edge: { action: "amend-spec", finding_id: "FND-001" },
          },
        },
      ],
      { feature_dir: dir, snapshot: baseSnap, tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("FINDING_NOT_FOUND");
      expect(r.detail!["reason"]).toBe("already_closed");
    }
  });

  test("phase_advanced back_edge action_mismatch (finding has action=fix-impl) → FINDING_NOT_FOUND reason=action_mismatch", async () => {
    const dir = await tmpFeatureDir();
    const baseSnap = snapshotPostLock("EXECUTE.work", {
      findings: [{ id: "FND-001", action: "fix-impl", status: "open" }],
    });
    const r = await mutateBatch(
      [
        {
          at: "2026-05-19T11:00:00.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: {
            from: "EXECUTE.work",
            to: "SPEC.spec",
            back_edge: { action: "amend-spec", finding_id: "FND-001" },
          },
        },
      ],
      { feature_dir: dir, snapshot: baseSnap, tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("FINDING_NOT_FOUND");
      expect(r.detail!["reason"]).toBe("action_mismatch");
    }
  });

  test("finding:raised amend-spec alone (no back-edge phase_advanced) — graceful raw-mutate path", async () => {
    const dir = await tmpFeatureDir();
    const seed = await seedRealJournalAtExecuteWork(dir);
    const r = await mutateBatch(
      [
        {
          at: "2026-05-19T11:00:00.000Z",
          actor: "human:engineer@test.local",
          entry_schema_version: 1,
          kind: "finding:raised",
          payload: {
            id: "FND-001",
            category: "spec-gap",
            action: "amend-spec",
            summary: "raw-mutate orphan finding for graceful-degrade test",
          },
        },
      ],
      {
        feature_dir: dir,
        snapshot: seed.snapshot,
        tail_seq: seed.tailSeq,
        entries: seed.entries,
        meta: seed.meta,
        fsync: false,
      },
    );
    // Codex r96 accept: standalone amend-spec is legal at the
    // schema level (records finding, leaves cursor + lock alone).
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.snapshot.state!.sub_state).toBe("EXECUTE.work");
      expect(r.snapshot.state!.spec_locked).toBe(true);
      expect(r.snapshot.findings).toHaveLength(1);
    }
  });

  test("FINDING_AMEND_SPEC_NOT_LOCKED fires when spec_locked=false (pre-lock amend-spec attempted)", async () => {
    const dir = await tmpFeatureDir();
    const baseSnap = snapshotPostLock("EXECUTE.work", { spec_locked: false });
    const r = await mutateBatch(
      [
        {
          at: "2026-05-19T11:00:00.000Z",
          actor: "human:engineer@test.local",
          entry_schema_version: 1,
          kind: "finding:raised",
          payload: {
            id: "FND-001",
            category: "spec-gap",
            action: "amend-spec",
            summary: "should reject pre-lock amend-spec",
          },
        },
      ],
      { feature_dir: dir, snapshot: baseSnap, tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("FINDING_AMEND_SPEC_NOT_LOCKED");
      expect(r.detail!["current_spec_locked"]).toBe(false);
    }
  });
});

// ── REPLAY ANCHOR — Slice B journal-derivability (codex r94 Finding 1 / Q7) ──

describe("replay anchor — Slice B journal-derivability", () => {
  // The whole point of carrying back_edge on the payload (vs a
  // transient mutateBatch flag) is that replayJournal can rebuild
  // the snapshot from the journal alone. These tests fail under
  // any design where authorization is hidden in mutateBatch context.
  //
  // Strategy: emit the 2-entry batch via mutateBatch (which writes
  // journal.jsonl), then replay that journal from disk. The
  // resulting snapshot must match the in-memory result.

  test("positive: emit [finding:raised, phase_advanced back_edge] batch, then replayJournal reproduces sub_state=SPEC.spec + spec_locked=false", async () => {
    const dir = await tmpFeatureDir();

    // Pre-seed a journal with the snapshot-equivalent entries that
    // reach EXECUTE.work + spec_locked=true (session:started +
    // phase_advanced walk + spec_submitted + tasks_planned +
    // gate:decided spec-lock approved + phase_advanced ...). This
    // would be long. For the anchor test, we instead emit the
    // 2-entry batch starting from tail_seq=-1 with the snapshot
    // injected; the replay below starts from journal entry 0 which
    // is the finding:raised. This is sufficient to prove
    // back_edge authorization is journal-derivable: the finding
    // entry lands first, then phase_advanced sees it via reducer's
    // accumulated snapshot during replay.
    //
    // To make replay walk from a real session start, the test
    // builds a small bootstrap journal first.

    const journalPath = path.join(dir, "journal.jsonl");

    // Bootstrap: session:started + walk to EXECUTE.work + gate-decide spec-lock approved.
    // We use raw appendEntry here to set up the on-disk preconditions.
    let seq = 0;
    const bootstrap: Array<JournalEntry> = [
      makeEntry(seq++, "session:started", {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "auth-refresh",
        ceremony: STANDARD,
      }, "cli:loaf"),
    ];
    const walk: Array<[SubState, SubState]> = [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
    ];
    for (const [from, to] of walk) {
      bootstrap.push(makeEntry(seq++, "event:phase_advanced", { from, to }, "cli:loaf"));
    }
    // gate:decided spec-lock approved at SPEC.design (locks)
    bootstrap.push(
      makeEntry(seq++, "gate:decided", {
        gate_kind: "spec-lock",
        decision: "approved",
        reason: "anchor-test bootstrap",
      }, "human:engineer@test.local"),
    );
    // phase_advanced SPEC.design → EXECUTE.plan → EXECUTE.work
    bootstrap.push(
      makeEntry(seq++, "event:phase_advanced", { from: "SPEC.design", to: "EXECUTE.plan" }, "cli:loaf"),
    );
    bootstrap.push(
      makeEntry(seq++, "event:phase_advanced", { from: "EXECUTE.plan", to: "EXECUTE.work" }, "cli:loaf"),
    );
    {
      let m = emptyMeta();
      for (const e of bootstrap) m = await appendEntry(journalPath, e, m, { fsync: false });
    }

    // The bootstrap leaves cursor at EXECUTE.work, spec_locked=true.
    // Sanity replay to confirm. collect_entries:true so the mutateBatch
    // below gets the authoritative {entries, meta} prefix (Phase 15 SC2).
    const pre = await replayJournal(journalPath, { collect_entries: true });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.snapshot.state!.sub_state).toBe("EXECUTE.work");
      expect(pre.snapshot.state!.spec_locked).toBe(true);
    }

    // Now emit the amend-spec 2-entry batch via mutateBatch using
    // the just-replayed snapshot. mutateBatch appends to the same
    // journal file.
    const r = await mutateBatch(
      [
        {
          at: "2026-05-19T11:00:00.000Z",
          actor: "human:engineer@test.local",
          entry_schema_version: 1,
          kind: "finding:raised",
          payload: {
            id: "FND-001",
            category: "spec-gap",
            action: "amend-spec",
            summary: "anchor-test amend-spec sponsorship",
          },
        },
        {
          at: "2026-05-19T11:00:00.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: {
            from: "EXECUTE.work",
            to: "SPEC.spec",
            back_edge: { action: "amend-spec", finding_id: "FND-001" },
          },
        },
      ],
      {
        feature_dir: dir,
        snapshot: pre.ok ? pre.snapshot : initialSnapshot(),
        tail_seq: seq - 1,
        entries: pre.ok ? pre.entries ?? [] : [],
        meta: pre.ok ? pre.meta : emptyMeta(),
        fsync: false,
      },
    );
    expect(r.ok).toBe(true);

    // THE ANCHOR: replay the full journal from disk; the back_edge
    // entry must succeed during replay (which runs apply()'s
    // internal preflight, separate from mutateBatch's Pass 1).
    const post = await replayJournal(journalPath);
    expect(post.ok).toBe(true);
    if (post.ok) {
      expect(post.snapshot.state!.sub_state).toBe("SPEC.spec");
      expect(post.snapshot.state!.spec_locked).toBe(false);
      expect(post.snapshot.findings).toHaveLength(1);
      expect(post.snapshot.findings[0]!.id).toBe("FND-001");
    }
  });

  test("negative: phase_advanced back_edge referencing a finding that was closed before this entry is rejected at replay (codex r96 §4)", async () => {
    // Construct an evil journal by hand: finding raised → finding
    // closed → phase_advanced back_edge=already_closed_id. Replay
    // must fail at the third entry with FINDING_NOT_FOUND
    // (reason=already_closed). This is the test that proves
    // journal-derivability extends to stale sponsorship — replay
    // is faithful to the AT-TIME-OF-APPLY state, not the original
    // emission moment.
    const dir = await tmpFeatureDir();
    const journalPath = path.join(dir, "journal.jsonl");

    // Bootstrap to EXECUTE.work + spec_locked=true (same walk as above).
    let seq = 0;
    const bootstrap: Array<JournalEntry> = [
      makeEntry(seq++, "session:started", {
        session_id: "660e8400-e29b-41d4-a716-446655440001",
        feature: "auth-refresh",
        ceremony: STANDARD,
      }, "cli:loaf"),
    ];
    for (const [from, to] of [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
    ] as Array<[SubState, SubState]>) {
      bootstrap.push(makeEntry(seq++, "event:phase_advanced", { from, to }, "cli:loaf"));
    }
    bootstrap.push(
      makeEntry(seq++, "gate:decided", {
        gate_kind: "spec-lock",
        decision: "approved",
        reason: "anchor-negative bootstrap",
      }, "human:engineer@test.local"),
    );
    bootstrap.push(
      makeEntry(seq++, "event:phase_advanced", { from: "SPEC.design", to: "EXECUTE.plan" }, "cli:loaf"),
    );
    bootstrap.push(
      makeEntry(seq++, "event:phase_advanced", { from: "EXECUTE.plan", to: "EXECUTE.work" }, "cli:loaf"),
    );
    // Now the evil sequence: raise + close + stale back_edge reference.
    bootstrap.push(
      makeEntry(seq++, "finding:raised", {
        id: "FND-001",
        category: "spec-gap",
        action: "amend-spec",
        summary: "raised then closed without using the sponsorship",
      }, "human:engineer@test.local"),
    );
    bootstrap.push(
      makeEntry(seq++, "finding:closed", { id: "FND-001" }, "human:engineer@test.local"),
    );
    bootstrap.push(
      makeEntry(seq++, "event:phase_advanced", {
        from: "EXECUTE.work",
        to: "SPEC.spec",
        back_edge: { action: "amend-spec", finding_id: "FND-001" },
      }, "cli:loaf"),
    );
    {
      let m = emptyMeta();
      for (const e of bootstrap) m = await appendEntry(journalPath, e, m, { fsync: false });
    }

    const result = await replayJournal(journalPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // replayJournal wraps inner apply failures as REDUCER_REJECTED
      // (journal-bootstrap.ts:153) — the inner FINDING_NOT_FOUND
      // surfaces through message + detail.reason.
      expect(result.code).toBe("REDUCER_REJECTED");
      expect(result.message).toMatch(/already_closed/);
      expect(result.detail).toBeDefined();
      expect((result.detail as { reason?: string }).reason).toBe("already_closed");
    }
  });
});
