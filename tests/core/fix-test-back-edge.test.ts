// Phase 11 Item 3 SC3 — finding fix-test back-edge (reuses event:task_step_reset).
//
// SC3 (codex r142 GO to RED): `finding raise --action fix-test` co-emits a
// 3-entry batch [finding:raised, event:task_step_reset, event:phase_advanced(
// back_edge fix-test → EXECUTE.work)] — the test-defect / TDD repair loop.
// SC3 introduces NO new journal kind: fix-test reuses the SC2 `event:
// task_step_reset` kind with step="red" (FIX_ACTION_STEP["fix-test"]).
//
// This file is scoped to the fix-test-NEW surface (the shared event:
// task_step_reset reducer + per-kind matrix are already exhaustively covered
// by fix-impl-back-edge.test.ts / per-kind-substate.test.ts):
//   - validateTransition: the fix-test back-edge action→target/from contract
//     (target EXECUTE.work; from-set = the SC1/SC2 row, EXECUTE.plan excluded).
//   - PhaseAdvancedPayload.parse: the discriminatedUnion accepts a fix-test
//     back_edge arm and rejects unknown keys (.strict()).
//   - the GENERALIZED preflight event:task_step_reset refine, exercised for a
//     fix-test finding: happy `red` reset; wrong step (`implement`) →
//     task_step_reset_step_mismatch; action-mismatch finding → FINDING_NOT_FOUND;
//     abandoned target → task_step_reset_task_abandoned.
//   - mutateBatch integration: the atomic 3-entry fix-test batch happy path.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { mutateBatch } from "../../src/core/journal-mutate.js";
import { appendEntry } from "../../src/core/journal-append.js";
import { replayJournal } from "../../src/core/journal-bootstrap.js";
import { emptyMeta, type SnapshotMeta } from "../../src/core/snapshot.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";
import {
  initialSnapshot,
  type FindingState,
  type Snapshot,
  type TaskState,
} from "../../src/core/reducer.js";
import { preflight } from "../../src/core/reducer/preflight.js";
import { validateTransition } from "../../src/core/reducer/transition.js";
import { PhaseAdvancedPayload } from "../../src/core/journal-entry.js";
import type { Ceremony, SubState } from "../../src/core/journal-entry.js";

const STANDARD: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

async function tmpFeatureDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc3-fix-test-"));
}

// A behavioral task with the canonical red/implement/refactor step set.
function mkTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "T-001",
    kind: "behavioral",
    status: "in_progress",
    steps: {
      red: { applicability: "must", status: "passed" },
      implement: { applicability: "must", status: "passed" },
      refactor: { applicability: "optional", status: "pending" },
    },
    drives: ["REQ-CORE-001"],
    depends_on: [],
    labels: [],
    ...overrides,
  };
}

// Build a snapshot at a post-lock sub_state, optionally pre-populating tasks
// + findings. fix-test does NOT clear the lock, so spec_locked stays true.
function snapshotAt(
  subState: SubState,
  opts: { tasks?: TaskState[]; findings?: FindingState[] } = {},
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
  snap.tasks = opts.tasks ?? [];
  snap.findings = opts.findings ?? [];
  return snap;
}

// An open fix-test finding targeting T-001's red step (the TDD failure lane).
function fixTestFinding(overrides: Partial<FindingState> = {}): FindingState {
  return {
    id: "FND-001",
    category: "test-defect",
    action: "fix-test",
    status: "open",
    target: { task_id: "T-001", step: "red" },
    ...overrides,
  };
}

// ── validateTransition — fix-test back-edge ─────────────────────────────

describe("validateTransition — Item 3 SC3 fix-test back-edge", () => {
  test("fix-test back_edge from a VERIFY.* source → EXECUTE.work is legal", () => {
    const r = validateTransition("VERIFY.review", "EXECUTE.work", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "fix-test", finding_id: "FND-001" },
    });
    expect(r.ok).toBe(true);
  });

  test("fix-test back_edge EXECUTE.work → EXECUTE.work self-loop is legal", () => {
    const r = validateTransition("EXECUTE.work", "EXECUTE.work", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "fix-test", finding_id: "FND-001" },
    });
    expect(r.ok).toBe(true);
  });

  test("fix-test back_edge from EXECUTE.plan rejected (back_edge_from_not_allowed)", () => {
    const r = validateTransition("EXECUTE.plan", "EXECUTE.work", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "fix-test", finding_id: "FND-001" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TRANSITION_ILLEGAL");
      expect(r.detail!["reason"]).toBe("back_edge_from_not_allowed");
    }
  });

  test("EXECUTE.plan → EXECUTE.work WITHOUT a back_edge stays a legal forward edge", () => {
    // The fix-test back-edge excludes EXECUTE.plan, but the plain forward
    // edge EXECUTE.plan → EXECUTE.work must remain legal — the exclusion
    // is back-edge-only.
    const r = validateTransition("EXECUTE.plan", "EXECUTE.work", {
      ceremony: STANDARD,
      actor: "cli:loaf",
    });
    expect(r.ok).toBe(true);
  });

  test("fix-test back_edge with target!=EXECUTE.work rejected (back_edge_target_mismatch)", () => {
    const r = validateTransition("VERIFY.run", "SPEC.spec", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "fix-test", finding_id: "FND-001" },
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
  ] as const)("fix-test back_edge from %s → EXECUTE.work legal", (prev) => {
    const r = validateTransition(prev, "EXECUTE.work", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "fix-test", finding_id: "FND-042" },
    });
    expect(r.ok).toBe(true);
  });
});

// ── payload schema parse — the fix-test back_edge arm ───────────────────

describe("PhaseAdvancedPayload — Item 3 SC3 fix-test back_edge arm", () => {
  test("parses a fix-test back_edge payload", () => {
    const r = PhaseAdvancedPayload.safeParse({
      from: "VERIFY.review",
      to: "EXECUTE.work",
      back_edge: { action: "fix-test", finding_id: "FND-007" },
    });
    expect(r.success).toBe(true);
  });

  test("rejects an unknown key inside the fix-test back_edge arm (.strict())", () => {
    const r = PhaseAdvancedPayload.safeParse({
      from: "VERIFY.review",
      to: "EXECUTE.work",
      back_edge: { action: "fix-test", finding_id: "FND-007", task_id: "T-001" },
    });
    expect(r.success).toBe(false);
  });

  test("rejects a malformed finding_id in the fix-test back_edge arm", () => {
    const r = PhaseAdvancedPayload.safeParse({
      from: "VERIFY.review",
      to: "EXECUTE.work",
      back_edge: { action: "fix-test", finding_id: "not-a-finding" },
    });
    expect(r.success).toBe(false);
  });
});

// ── preflight — the GENERALIZED event:task_step_reset refine, fix-test ───

describe("preflight — event:task_step_reset for a fix-test finding (Item 3 SC3)", () => {
  function resetEntry(payload: Record<string, unknown>) {
    return {
      seq: 1,
      entry_id: "JE-000002",
      at: "2026-05-21T11:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "event:task_step_reset",
      payload,
    };
  }

  test("happy: open fix-test finding + matching {task_id, step:red} → ok", () => {
    const r = preflight(resetEntry({ task_id: "T-001", step: "red", finding_id: "FND-001" }), {
      snapshot: snapshotAt("EXECUTE.work", {
        tasks: [mkTask()],
        findings: [fixTestFinding()],
      }),
      tail_seq: 0,
    });
    expect(r.ok).toBe(true);
  });

  test("happy: fix-test reset from VERIFY.review on a done task → ok", () => {
    const r = preflight(resetEntry({ task_id: "T-001", step: "red", finding_id: "FND-001" }), {
      snapshot: snapshotAt("VERIFY.review", {
        tasks: [mkTask({ status: "done" })],
        findings: [fixTestFinding()],
      }),
      tail_seq: 0,
    });
    expect(r.ok).toBe(true);
  });

  test("wrong step ('implement') for a fix-test finding → MUTATION_OUT_OF_RIGHTS task_step_reset_step_mismatch", () => {
    // fix-test resets the `red` step; a reset payload claiming `implement`
    // is a step mismatch — FIX_ACTION_STEP["fix-test"] === "red".
    const r = preflight(
      resetEntry({ task_id: "T-001", step: "implement", finding_id: "FND-001" }),
      {
        snapshot: snapshotAt("EXECUTE.work", {
          tasks: [mkTask()],
          findings: [fixTestFinding({ target: { task_id: "T-001", step: "implement" } })],
        }),
        tail_seq: 0,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(r.detail!["reason"]).toBe("task_step_reset_step_mismatch");
      // expected_step now reflects the fix-test canonical step.
      expect(r.detail!["expected_step"]).toBe("red");
    }
  });

  test("action-mismatch finding (defer) → FINDING_NOT_FOUND reason=action_mismatch", () => {
    // A `defer` finding cannot sponsor a step reset — only fix-impl /
    // fix-test (the generalized action set).
    const r = preflight(resetEntry({ task_id: "T-001", step: "red", finding_id: "FND-001" }), {
      snapshot: snapshotAt("EXECUTE.work", {
        tasks: [mkTask()],
        findings: [fixTestFinding({ action: "defer" })],
      }),
      tail_seq: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("FINDING_NOT_FOUND");
      expect(r.detail!["reason"]).toBe("action_mismatch");
    }
  });

  test("abandoned target task → MUTATION_OUT_OF_RIGHTS task_step_reset_task_abandoned (r141 guard, fix-test path)", () => {
    // The r141 abandoned guard is action-agnostic — a fix-test step reset
    // must not resurrect a terminal task either.
    const r = preflight(resetEntry({ task_id: "T-001", step: "red", finding_id: "FND-001" }), {
      snapshot: snapshotAt("EXECUTE.work", {
        tasks: [mkTask({ status: "abandoned" })],
        findings: [fixTestFinding()],
      }),
      tail_seq: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(r.detail!["reason"]).toBe("task_step_reset_task_abandoned");
    }
  });
});

// Seed a REAL journal up to `subState` with one behavioral task driven to
// `status: "done"` (Phase 15 SC2: mutateBatch step 8 re-serializes all five
// projection files, so the entry stream must be consistent with the
// snapshot — a synthetic `snapshotAt` over an empty journal is no longer
// admissible). Raw `appendEntry` builds the journal (bypassing mutateBatch's
// Pass 1.5 gate eval — fine for a fixture); `replayJournal(collect_entries)`
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
      at: `2026-05-21T10:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`,
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
    mk(
      "gate:decided",
      { gate_kind: "spec-lock", decision: "approved", reason: "fixture" },
      "human:engineer@test.local",
    ),
  );
  bootstrap.push(mk("event:phase_advanced", { from: "SPEC.design", to: "EXECUTE.plan" }));
  bootstrap.push(
    mk(
      "event:tasks_planned",
      {
        based_on: { spec: 1 },
        tasks: [
          {
            id: "T-001",
            kind: "behavioral",
            drives: ["REQ-CORE-001"],
            tests: ["Core.regressOnce"],
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
      "human:engineer@test.local",
    ),
  );
  bootstrap.push(mk("event:phase_advanced", { from: "EXECUTE.plan", to: "EXECUTE.work" }));
  bootstrap.push(mk("event:task_claimed", { task_id: "T-001" }));
  bootstrap.push(mk("event:task_step_done", { task_id: "T-001", step: "red", result: "passed" }));
  bootstrap.push(
    mk("event:task_step_done", { task_id: "T-001", step: "implement", result: "passed" }),
  );
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
  if (!replay.ok)
    throw new Error(`seedRealJournalAt replay failed: ${replay.code} ${replay.message}`);
  return {
    snapshot: replay.snapshot,
    tailSeq: replay.meta.last_applied_seq,
    entries: replay.entries ?? [],
    meta: replay.meta,
  };
}

// ── mutateBatch — the atomic 3-entry fix-test batch ─────────────────────

describe("mutateBatch — Item 3 SC3 fix-test 3-entry batch", () => {
  function fixTestBatch(from: SubState) {
    return [
      {
        at: "2026-05-21T11:00:00.000Z",
        actor: "human:engineer@test.local",
        entry_schema_version: 1,
        kind: "finding:raised" as const,
        payload: {
          id: "FND-001",
          category: "test-defect",
          action: "fix-test",
          summary: "the red test asserts the wrong contract for REQ-CORE-001",
          target: { task_id: "T-001", step: "red" },
        },
      },
      {
        at: "2026-05-21T11:00:00.000Z",
        actor: "cli:loaf" as const,
        entry_schema_version: 1,
        kind: "event:task_step_reset" as const,
        payload: { task_id: "T-001", step: "red", finding_id: "FND-001" },
      },
      {
        at: "2026-05-21T11:00:00.000Z",
        actor: "cli:loaf" as const,
        entry_schema_version: 1,
        kind: "event:phase_advanced" as const,
        payload: {
          from,
          to: "EXECUTE.work",
          back_edge: { action: "fix-test", finding_id: "FND-001" },
        },
      },
    ];
  }

  test("happy: from VERIFY.review on a done task — red step → pending, task → in_progress, iteration +1, finding open", async () => {
    const dir = await tmpFeatureDir();
    const seed = await seedRealJournalAt(dir, "VERIFY.review");
    const r = await mutateBatch(fixTestBatch("VERIFY.review"), {
      feature_dir: dir,
      snapshot: seed.snapshot,
      tail_seq: seed.tailSeq,
      entries: seed.entries,
      meta: seed.meta,
      fsync: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.snapshot.state!.sub_state).toBe("EXECUTE.work");
      expect(r.snapshot.state!.iteration).toBe(seed.snapshot.state!.iteration + 1);
      expect(r.snapshot.state!.spec_locked).toBe(true);
      const t = r.snapshot.tasks[0]!;
      expect(t.status).toBe("in_progress");
      expect(t.steps["red"]!.status).toBe("pending");
      // the sibling implement step keeps its passed status — only red reset.
      expect(t.steps["implement"]!.status).toBe("passed");
      // SC3 is a repair loop — the finding stays open.
      expect(r.snapshot.findings[0]!.status).toBe("open");
    }
  });

  test("abandoned target task → 3-entry fix-test batch rejected (r141 guard)", async () => {
    // The reachable exploit: `finding raise --action fix-test` targeting an
    // abandoned task. Preflight (run inside mutateBatch Pass 1) rejects the
    // event:task_step_reset entry — the abandoned task is never resurrected.
    const dir = await tmpFeatureDir();
    const baseSnap = snapshotAt("VERIFY.review", {
      tasks: [mkTask({ status: "abandoned" })],
    });
    const r = await mutateBatch(fixTestBatch("VERIFY.review"), {
      feature_dir: dir,
      snapshot: baseSnap,
      tail_seq: -1,
      entries: [],
      meta: emptyMeta(),
      fsync: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(r.detail?.["reason"]).toBe("task_step_reset_task_abandoned");
    }
  });

  test("happy: from EXECUTE.work self-loop on a done task — task reopens to in_progress", async () => {
    const dir = await tmpFeatureDir();
    const seed = await seedRealJournalAt(dir, "EXECUTE.work");
    const r = await mutateBatch(fixTestBatch("EXECUTE.work"), {
      feature_dir: dir,
      snapshot: seed.snapshot,
      tail_seq: seed.tailSeq,
      entries: seed.entries,
      meta: seed.meta,
      fsync: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.snapshot.tasks[0]!.status).toBe("in_progress");
      expect(r.snapshot.tasks[0]!.steps["red"]!.status).toBe("pending");
    }
  });
});
