// Phase 11 Item 3 SC1 — finding amend-tasks back-edge batch tests.
//
// SC1 is back-edge-only (codex r134 GO): `finding raise --action
// amend-tasks` co-emits a 2-entry batch [finding:raised,
// event:phase_advanced(back_edge → EXECUTE.work)] — exactly mirroring
// how amend-spec co-emits [finding:raised, event:phase_advanced(
// back_edge → SPEC.spec)]. No event:tasks_amended, no real task-graph
// change (that is SC1b). The finding stays open; iteration +1 is
// inherited from SC0's generic back_edge reducer bump.
//
// Covers (mirrors amend-spec-back-edge.test.ts):
//   - validateTransition: amend-tasks back-edge action→target/from
//     contract (target must be EXECUTE.work; from-set = amend-spec row
//     minus EXECUTE.plan; EXECUTE.work → EXECUTE.work self-loop legal).
//   - PhaseAdvancedPayload.parse: the discriminatedUnion accepts an
//     amend-tasks back_edge arm and rejects unknown keys (.strict()).
//   - mutateBatch integration: 2-entry happy path + iteration bump +
//     finding stays open.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { mutateBatch } from "../../src/core/journal-mutate.js";
import { appendEntry } from "../../src/core/journal-append.js";
import { replayJournal } from "../../src/core/journal-bootstrap.js";
import { emptyMeta, type SnapshotMeta } from "../../src/core/snapshot.js";
import { initialSnapshot, type Snapshot } from "../../src/core/reducer.js";
import { validateTransition } from "../../src/core/reducer/transition.js";
import { PhaseAdvancedPayload } from "../../src/core/journal-entry.js";
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
  return fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc1-amend-tasks-"));
}

// Build a snapshot at a post-lock sub_state with state.spec_locked=true,
// optionally pre-populating findings. amend-tasks does NOT clear the
// lock, so spec_locked stays true through the back-edge.
function snapshotAt(
  subState: SubState,
  opts: {
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
    spec_locked: true,
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
      category: "new-scope",
      action: f.action as "amend-tasks",
      status: f.status,
    });
  }
  return snap;
}

// ── validateTransition direct tests ────────────────────────────────────

describe("validateTransition — Item 3 SC1 amend-tasks back-edge", () => {
  test("amend-tasks back_edge EXECUTE.work → EXECUTE.work self-loop is legal", () => {
    // Intentional self-loop (codex r134 Q1): mid-work task drift. Cursor
    // stays at EXECUTE.work; the iteration bump is cursor-independent.
    const r = validateTransition("EXECUTE.work", "EXECUTE.work", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "amend-tasks", finding_id: "FND-001" },
    });
    expect(r.ok).toBe(true);
  });

  test("amend-tasks back_edge from a VERIFY.* source → EXECUTE.work is legal", () => {
    const r = validateTransition("VERIFY.review", "EXECUTE.work", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "amend-tasks", finding_id: "FND-042" },
    });
    expect(r.ok).toBe(true);
  });

  test("amend-tasks back_edge from EXECUTE.plan rejected (back_edge_from_not_allowed)", () => {
    // EXECUTE.plan is excluded from the amend-tasks from-set: at the
    // planning surface a task graph change is the plain forward edge,
    // not a back-edge (codex r134 Q1).
    const r = validateTransition("EXECUTE.plan", "EXECUTE.work", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "amend-tasks", finding_id: "FND-001" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TRANSITION_ILLEGAL");
      expect(r.detail!["reason"]).toBe("back_edge_from_not_allowed");
    }
  });

  test("forward EXECUTE.plan → EXECUTE.work WITHOUT back_edge still legal", () => {
    // The plain forward edge from the planning surface is untouched.
    const r = validateTransition("EXECUTE.plan", "EXECUTE.work", {
      ceremony: STANDARD,
      actor: "cli:loaf",
    });
    expect(r.ok).toBe(true);
  });

  test("amend-tasks back_edge with target!=EXECUTE.work rejected (back_edge_target_mismatch)", () => {
    const r = validateTransition("VERIFY.run", "SPEC.spec", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "amend-tasks", finding_id: "FND-001" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TRANSITION_ILLEGAL");
      expect(r.detail!["reason"]).toBe("back_edge_target_mismatch");
    }
  });

  test.each([
    "EXECUTE.work",
    "EXECUTE.done",
    "VERIFY.plan",
    "VERIFY.run",
    "VERIFY.review",
    "VERIFY.acceptance",
    "VERIFY.visual",
    "VERIFY.accept",
  ] as const)("amend-tasks back_edge from %s → EXECUTE.work legal", (prev) => {
    const r = validateTransition(prev, "EXECUTE.work", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "amend-tasks", finding_id: "FND-042" },
    });
    expect(r.ok).toBe(true);
  });
});

// ── PhaseAdvancedPayload discriminatedUnion parse ──────────────────────

describe("PhaseAdvancedPayload — Item 3 SC1 amend-tasks back_edge arm", () => {
  test("parses an amend-tasks back_edge payload", () => {
    const r = PhaseAdvancedPayload.safeParse({
      from: "VERIFY.review",
      to: "EXECUTE.work",
      back_edge: { action: "amend-tasks", finding_id: "FND-007" },
    });
    expect(r.success).toBe(true);
  });

  test("rejects an unknown key inside the amend-tasks back_edge arm (.strict())", () => {
    const r = PhaseAdvancedPayload.safeParse({
      from: "VERIFY.review",
      to: "EXECUTE.work",
      back_edge: { action: "amend-tasks", finding_id: "FND-007", task_id: "T-001" },
    });
    expect(r.success).toBe(false);
  });
});

// Seed a REAL journal up to `subState` (Phase 15 SC2: mutateBatch step 8
// re-serializes all five projection files, so the entry stream must be
// consistent with the snapshot — a synthetic `snapshotAt` over an empty
// journal is no longer admissible). amend-tasks needs no task graph, so the
// bootstrap skips tasks_planned; the EXECUTE.work→EXECUTE.done edge is
// vacuously all-tasks-final. Raw `appendEntry` builds the journal (bypassing
// mutateBatch's Pass 1.5 gate eval — fine for a fixture); `replayJournal`
// then derives the authentic {snapshot, entries, meta} triple.
async function seedRealJournalAt(
  dir: string,
  subState: "EXECUTE.work" | "VERIFY.review",
): Promise<{
  snapshot: Snapshot;
  tailSeq: number;
  entries: JournalEntry[];
  meta: SnapshotMeta;
}> {
  const journalPath = path.join(dir, "journal.jsonl");
  let seq = 0;
  const mk = (kind: JournalEntry["kind"], payload: unknown, actor = "cli:loaf"): JournalEntry => {
    const s = seq % 60;
    const m = Math.floor(seq / 60) % 60;
    return {
      seq: seq++,
      entry_id: `JE-${String(seq).padStart(6, "0")}`,
      at: `2026-05-20T10:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`,
      actor,
      entry_schema_version: 1,
      kind,
      payload,
    } as JournalEntry;
  };
  const bootstrap: JournalEntry[] = [
    mk("session:started", {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "auth-refresh",
      ceremony: STANDARD,
    }),
  ];
  for (const [from, to] of [
    ["TRIAGE.score", "TRIAGE.confirm"],
    ["TRIAGE.confirm", "SPEC.proposal"],
    ["SPEC.proposal", "SPEC.spec"],
    ["SPEC.spec", "SPEC.plan"],
    ["SPEC.plan", "SPEC.design"],
  ] as Array<[string, string]>) {
    bootstrap.push(mk("event:phase_advanced", { from, to }));
  }
  bootstrap.push(
    mk("gate:decided", { gate_kind: "spec-lock", decision: "approved", reason: "fixture" },
      "human:engineer@test.local"),
  );
  bootstrap.push(mk("event:phase_advanced", { from: "SPEC.design", to: "EXECUTE.plan" }));
  bootstrap.push(mk("event:phase_advanced", { from: "EXECUTE.plan", to: "EXECUTE.work" }));
  if (subState === "VERIFY.review") {
    for (const [from, to] of [
      ["EXECUTE.work", "EXECUTE.done"],
      ["EXECUTE.done", "VERIFY.plan"],
      ["VERIFY.plan", "VERIFY.run"],
      ["VERIFY.run", "VERIFY.review"],
    ] as Array<[string, string]>) {
      bootstrap.push(mk("event:phase_advanced", { from, to }));
    }
  }

  let meta = emptyMeta();
  for (const e of bootstrap) meta = await appendEntry(journalPath, e, meta, { fsync: false });

  const replay = await replayJournal(journalPath, { collect_entries: true });
  if (!replay.ok) throw new Error(`seedRealJournalAt replay failed: ${replay.code} ${replay.message}`);
  return {
    snapshot: replay.snapshot,
    tailSeq: replay.meta.last_applied_seq,
    entries: replay.entries ?? [],
    meta: replay.meta,
  };
}

// ── mutateBatch integration ─────────────────────────────────────────────

describe("mutateBatch — Item 3 SC1 amend-tasks batch integration", () => {
  test("[finding:raised amend-tasks, phase_advanced back_edge] from EXECUTE.work → EXECUTE.work self-loop, iteration +1, finding open", async () => {
    const dir = await tmpFeatureDir();
    const seed = await seedRealJournalAt(dir, "EXECUTE.work");
    const r = await mutateBatch(
      [
        {
          at: "2026-05-20T11:00:00.000Z",
          actor: "human:engineer@test.local",
          entry_schema_version: 1,
          kind: "finding:raised",
          payload: {
            id: "FND-001",
            category: "new-scope",
            action: "amend-tasks",
            summary: "the task graph misses a step surfaced during execution",
          },
        },
        {
          at: "2026-05-20T11:00:00.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: {
            from: "EXECUTE.work",
            to: "EXECUTE.work",
            back_edge: { action: "amend-tasks", finding_id: "FND-001" },
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
      expect(r.snapshot.state!.sub_state).toBe("EXECUTE.work");
      // amend-tasks does NOT clear the lock.
      expect(r.snapshot.state!.spec_locked).toBe(true);
      // SC0 generic back_edge bump — one over the seed's iteration.
      expect(r.snapshot.state!.iteration).toBe(seed.snapshot.state!.iteration + 1);
      expect(r.snapshot.findings).toHaveLength(1);
      expect(r.snapshot.findings[0]!.id).toBe("FND-001");
      expect(r.snapshot.findings[0]!.action).toBe("amend-tasks");
      // SC1 is back-edge-only — the finding stays open.
      expect(r.snapshot.findings[0]!.status).toBe("open");
    }
  });

  test("[finding:raised amend-tasks, phase_advanced back_edge] from VERIFY.review → EXECUTE.work, iteration +1", async () => {
    const dir = await tmpFeatureDir();
    const seed = await seedRealJournalAt(dir, "VERIFY.review");
    const r = await mutateBatch(
      [
        {
          at: "2026-05-20T11:00:00.000Z",
          actor: "human:engineer@test.local",
          entry_schema_version: 1,
          kind: "finding:raised",
          payload: {
            id: "FND-001",
            category: "new-scope",
            action: "amend-tasks",
            summary: "verify surfaced task-graph drift",
          },
        },
        {
          at: "2026-05-20T11:00:00.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: {
            from: "VERIFY.review",
            to: "EXECUTE.work",
            back_edge: { action: "amend-tasks", finding_id: "FND-001" },
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
      expect(r.snapshot.state!.sub_state).toBe("EXECUTE.work");
      expect(r.snapshot.state!.iteration).toBe(seed.snapshot.state!.iteration + 1);
      expect(r.snapshot.findings[0]!.status).toBe("open");
    }
  });

  test("phase_advanced amend-tasks back_edge alone (unresolved finding_id) → FINDING_NOT_FOUND reason=not_found", async () => {
    const dir = await tmpFeatureDir();
    const baseSnap = snapshotAt("EXECUTE.work");
    const r = await mutateBatch(
      [
        {
          at: "2026-05-20T11:00:00.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: {
            from: "EXECUTE.work",
            to: "EXECUTE.work",
            back_edge: { action: "amend-tasks", finding_id: "FND-999" },
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
});
