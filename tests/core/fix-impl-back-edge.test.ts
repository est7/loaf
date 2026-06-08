// Phase 11 Item 3 SC2 — finding fix-impl back-edge + event:task_step_reset.
//
// SC2 (codex r139 GO to RED): `finding raise --action fix-impl` co-emits a
// 3-entry batch [finding:raised, event:task_step_reset, event:phase_advanced(
// back_edge fix-impl → EXECUTE.work)]. event:task_step_reset is a NEW journal
// kind that resets a task's `implement` step to `pending` (and reopens a done
// task to `in_progress`) so the fix-impl repair loop can re-run it.
//
// Covers (mirrors amend-tasks-back-edge.test.ts):
//   - validateTransition: fix-impl back-edge action→target/from contract
//     (target must be EXECUTE.work; from-set = the SC1 amend-tasks row).
//   - PhaseAdvancedPayload.parse: the discriminatedUnion accepts a fix-impl
//     back_edge arm and rejects unknown keys (.strict()).
//   - TaskStepResetPayload.parse: strict {task_id, step, finding_id}.
//   - preflight event:task_step_reset refines (Q3): finding existence /
//     open / action + target/step authority.
//   - reducer apply: step → pending, task → in_progress (even a done task),
//     applicability preserved.
//   - mutateBatch integration: the atomic 3-entry batch happy path + reject
//     paths.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { mutateBatch } from "../../src/core/journal-mutate.js";
import { appendEntry } from "../../src/core/journal-append.js";
import { replayJournal } from "../../src/core/journal-bootstrap.js";
import { emptyMeta, type SnapshotMeta } from "../../src/core/snapshot.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";
import { apply } from "../../src/core/reducer.js";
import {
  initialSnapshot,
  type FindingState,
  type Snapshot,
  type TaskState,
} from "../../src/core/reducer.js";
import { preflight } from "../../src/core/reducer/preflight.js";
import { validateTransition } from "../../src/core/reducer/transition.js";
import { PhaseAdvancedPayload, TaskStepResetPayload } from "../../src/core/journal-entry.js";
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
  return fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc2-fix-impl-"));
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
// + findings. fix-impl does NOT clear the lock, so spec_locked stays true.
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

// An open fix-impl finding targeting T-001's implement step.
function fixImplFinding(overrides: Partial<FindingState> = {}): FindingState {
  return {
    id: "FND-001",
    category: "impl-defect",
    action: "fix-impl",
    status: "open",
    target: { task_id: "T-001", step: "implement" },
    ...overrides,
  };
}

// ── validateTransition — fix-impl back-edge ─────────────────────────────

describe("validateTransition — Item 3 SC2 fix-impl back-edge", () => {
  test("fix-impl back_edge from a VERIFY.* source → EXECUTE.work is legal", () => {
    const r = validateTransition("VERIFY.review", "EXECUTE.work", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "fix-impl", finding_id: "FND-001" },
    });
    expect(r.ok).toBe(true);
  });

  test("fix-impl back_edge EXECUTE.work → EXECUTE.work self-loop is legal", () => {
    const r = validateTransition("EXECUTE.work", "EXECUTE.work", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "fix-impl", finding_id: "FND-001" },
    });
    expect(r.ok).toBe(true);
  });

  test("fix-impl back_edge from EXECUTE.plan rejected (back_edge_from_not_allowed)", () => {
    const r = validateTransition("EXECUTE.plan", "EXECUTE.work", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "fix-impl", finding_id: "FND-001" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TRANSITION_ILLEGAL");
      expect(r.detail!["reason"]).toBe("back_edge_from_not_allowed");
    }
  });

  test("fix-impl back_edge with target!=EXECUTE.work rejected (back_edge_target_mismatch)", () => {
    const r = validateTransition("VERIFY.run", "SPEC.spec", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "fix-impl", finding_id: "FND-001" },
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
  ] as const)("fix-impl back_edge from %s → EXECUTE.work legal", (prev) => {
    const r = validateTransition(prev, "EXECUTE.work", {
      ceremony: STANDARD,
      actor: "cli:loaf",
      back_edge: { action: "fix-impl", finding_id: "FND-042" },
    });
    expect(r.ok).toBe(true);
  });
});

// ── payload schema parse ────────────────────────────────────────────────

describe("PhaseAdvancedPayload — Item 3 SC2 fix-impl back_edge arm", () => {
  test("parses a fix-impl back_edge payload", () => {
    const r = PhaseAdvancedPayload.safeParse({
      from: "VERIFY.review",
      to: "EXECUTE.work",
      back_edge: { action: "fix-impl", finding_id: "FND-007" },
    });
    expect(r.success).toBe(true);
  });

  test("rejects an unknown key inside the fix-impl back_edge arm (.strict())", () => {
    const r = PhaseAdvancedPayload.safeParse({
      from: "VERIFY.review",
      to: "EXECUTE.work",
      back_edge: { action: "fix-impl", finding_id: "FND-007", task_id: "T-001" },
    });
    expect(r.success).toBe(false);
  });
});

describe("TaskStepResetPayload — Item 3 SC2", () => {
  test("parses a strict {task_id, step, finding_id} payload", () => {
    const r = TaskStepResetPayload.safeParse({
      task_id: "T-001",
      step: "implement",
      finding_id: "FND-001",
    });
    expect(r.success).toBe(true);
  });

  test("rejects an unknown top-level key (.strict())", () => {
    const r = TaskStepResetPayload.safeParse({
      task_id: "T-001",
      step: "implement",
      finding_id: "FND-001",
      reason: "smuggled",
    });
    expect(r.success).toBe(false);
  });

  test("rejects an empty step", () => {
    const r = TaskStepResetPayload.safeParse({
      task_id: "T-001",
      step: "",
      finding_id: "FND-001",
    });
    expect(r.success).toBe(false);
  });

  test("rejects a malformed finding_id", () => {
    const r = TaskStepResetPayload.safeParse({
      task_id: "T-001",
      step: "implement",
      finding_id: "not-a-finding",
    });
    expect(r.success).toBe(false);
  });
});

// ── reducer apply — event:task_step_reset ───────────────────────────────

describe("reducer apply — event:task_step_reset", () => {
  function resetEntry() {
    return {
      seq: 1,
      entry_id: "JE-000002",
      at: "2026-05-21T11:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "event:task_step_reset" as const,
      payload: { task_id: "T-001", step: "implement", finding_id: "FND-001" },
    };
  }

  test("resets the implement step to pending and the task to in_progress", () => {
    const snap = snapshotAt("EXECUTE.work", {
      tasks: [mkTask()],
      findings: [fixImplFinding()],
    });
    const r = apply(snap, resetEntry());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const t = r.snapshot.tasks[0]!;
      expect(t.steps["implement"]!.status).toBe("pending");
      expect(t.status).toBe("in_progress");
      // applicability is preserved.
      expect(t.steps["implement"]!.applicability).toBe("must");
      // sibling steps are untouched.
      expect(t.steps["red"]!.status).toBe("passed");
    }
  });

  test("reopens a done task back to in_progress", () => {
    const doneTask = mkTask({
      status: "done",
      steps: {
        red: { applicability: "must", status: "passed" },
        implement: { applicability: "must", status: "passed" },
        refactor: { applicability: "optional", status: "passed" },
      },
    });
    const snap = snapshotAt("VERIFY.review", {
      tasks: [doneTask],
      findings: [fixImplFinding()],
    });
    const r = apply(snap, resetEntry());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const t = r.snapshot.tasks[0]!;
      expect(t.status).toBe("in_progress");
      expect(t.steps["implement"]!.status).toBe("pending");
    }
  });
});

// ── preflight — event:task_step_reset refines (Q3) ──────────────────────

describe("preflight — event:task_step_reset (Item 3 SC2 Q3)", () => {
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

  test("happy: open fix-impl finding + matching target → ok", () => {
    const r = preflight(
      resetEntry({ task_id: "T-001", step: "implement", finding_id: "FND-001" }),
      {
        snapshot: snapshotAt("EXECUTE.work", {
          tasks: [mkTask()],
          findings: [fixImplFinding()],
        }),
        tail_seq: 0,
      },
    );
    expect(r.ok).toBe(true);
  });

  test("happy: fix-impl reset from VERIFY.review → ok", () => {
    const r = preflight(
      resetEntry({ task_id: "T-001", step: "implement", finding_id: "FND-001" }),
      {
        snapshot: snapshotAt("VERIFY.review", {
          tasks: [mkTask({ status: "done" })],
          findings: [fixImplFinding()],
        }),
        tail_seq: 0,
      },
    );
    expect(r.ok).toBe(true);
  });

  test("EXECUTE.plan rejected (SUB_STATE_AUTHORITY_VIOLATION)", () => {
    const r = preflight(
      resetEntry({ task_id: "T-001", step: "implement", finding_id: "FND-001" }),
      {
        snapshot: snapshotAt("EXECUTE.plan", {
          tasks: [mkTask()],
          findings: [fixImplFinding()],
        }),
        tail_seq: 0,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SUB_STATE_AUTHORITY_VIOLATION");
  });

  test("missing finding → FINDING_NOT_FOUND reason=not_found", () => {
    const r = preflight(
      resetEntry({ task_id: "T-001", step: "implement", finding_id: "FND-999" }),
      {
        snapshot: snapshotAt("EXECUTE.work", {
          tasks: [mkTask()],
          findings: [fixImplFinding()],
        }),
        tail_seq: 0,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("FINDING_NOT_FOUND");
      expect(r.detail!["reason"]).toBe("not_found");
    }
  });

  test("closed finding → FINDING_NOT_FOUND reason=already_closed", () => {
    const r = preflight(
      resetEntry({ task_id: "T-001", step: "implement", finding_id: "FND-001" }),
      {
        snapshot: snapshotAt("EXECUTE.work", {
          tasks: [mkTask()],
          findings: [fixImplFinding({ status: "closed" })],
        }),
        tail_seq: 0,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("FINDING_NOT_FOUND");
      expect(r.detail!["reason"]).toBe("already_closed");
    }
  });

  test("action-mismatch finding → FINDING_NOT_FOUND reason=action_mismatch", () => {
    const r = preflight(
      resetEntry({ task_id: "T-001", step: "implement", finding_id: "FND-001" }),
      {
        snapshot: snapshotAt("EXECUTE.work", {
          tasks: [mkTask()],
          findings: [fixImplFinding({ action: "amend-tasks" })],
        }),
        tail_seq: 0,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("FINDING_NOT_FOUND");
      expect(r.detail!["reason"]).toBe("action_mismatch");
    }
  });

  test("target mismatch (payload task_id != finding.target) → MUTATION_OUT_OF_RIGHTS task_step_reset_target_mismatch", () => {
    const r = preflight(
      resetEntry({ task_id: "T-002", step: "implement", finding_id: "FND-001" }),
      {
        snapshot: snapshotAt("EXECUTE.work", {
          tasks: [mkTask(), mkTask({ id: "T-002" })],
          findings: [fixImplFinding()],
        }),
        tail_seq: 0,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(r.detail!["reason"]).toBe("task_step_reset_target_mismatch");
    }
  });

  test("wrong step (not 'implement') → MUTATION_OUT_OF_RIGHTS task_step_reset_step_mismatch", () => {
    // The finding's target step is 'implement' (FINDING_TARGET refine forces
    // it); a reset payload claiming step='red' is a step mismatch.
    const r = preflight(resetEntry({ task_id: "T-001", step: "red", finding_id: "FND-001" }), {
      snapshot: snapshotAt("EXECUTE.work", {
        tasks: [mkTask()],
        findings: [fixImplFinding({ target: { task_id: "T-001", step: "red" } })],
      }),
      tail_seq: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(r.detail!["reason"]).toBe("task_step_reset_step_mismatch");
    }
  });

  test("step absent from the task → MUTATION_OUT_OF_RIGHTS (target mismatch — step not on task)", () => {
    // A task whose step set has no 'implement' step.
    const stepless = mkTask({
      steps: { red: { applicability: "must", status: "passed" } },
    });
    const r = preflight(
      resetEntry({ task_id: "T-001", step: "implement", finding_id: "FND-001" }),
      {
        snapshot: snapshotAt("EXECUTE.work", {
          tasks: [stepless],
          findings: [fixImplFinding()],
        }),
        tail_seq: 0,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MUTATION_OUT_OF_RIGHTS");
      expect(r.detail!["reason"]).toBe("task_step_reset_target_mismatch");
    }
  });

  test("abandoned target task → MUTATION_OUT_OF_RIGHTS task_step_reset_task_abandoned (codex r140 P1)", () => {
    // r139 Q5 reopens a `done` task (its step cannot otherwise re-run), but
    // `abandoned` is terminal — a fix-impl step reset must not resurrect it.
    const r = preflight(
      resetEntry({ task_id: "T-001", step: "implement", finding_id: "FND-001" }),
      {
        snapshot: snapshotAt("EXECUTE.work", {
          tasks: [mkTask({ status: "abandoned" })],
          findings: [fixImplFinding()],
        }),
        tail_seq: 0,
      },
    );
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

// ── mutateBatch — the atomic 3-entry fix-impl batch ─────────────────────

describe("mutateBatch — Item 3 SC2 fix-impl 3-entry batch", () => {
  function fixImplBatch(from: SubState) {
    return [
      {
        at: "2026-05-21T11:00:00.000Z",
        actor: "human:engineer@test.local",
        entry_schema_version: 1,
        kind: "finding:raised" as const,
        payload: {
          id: "FND-001",
          category: "impl-defect",
          action: "fix-impl",
          summary: "the implementation regressed against REQ-CORE-001",
          target: { task_id: "T-001", step: "implement" },
        },
      },
      {
        at: "2026-05-21T11:00:00.000Z",
        actor: "cli:loaf" as const,
        entry_schema_version: 1,
        kind: "event:task_step_reset" as const,
        payload: { task_id: "T-001", step: "implement", finding_id: "FND-001" },
      },
      {
        at: "2026-05-21T11:00:00.000Z",
        actor: "cli:loaf" as const,
        entry_schema_version: 1,
        kind: "event:phase_advanced" as const,
        payload: {
          from,
          to: "EXECUTE.work",
          back_edge: { action: "fix-impl", finding_id: "FND-001" },
        },
      },
    ];
  }

  test("happy: from VERIFY.review on a done task — step → pending, task → in_progress, iteration +1, finding open", async () => {
    const dir = await tmpFeatureDir();
    const seed = await seedRealJournalAt(dir, "VERIFY.review");
    const r = await mutateBatch(fixImplBatch("VERIFY.review"), {
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
      // The fix-impl back-edge bumps iteration by exactly 1 over the seed.
      expect(r.snapshot.state!.iteration).toBe(seed.snapshot.state!.iteration + 1);
      expect(r.snapshot.state!.spec_locked).toBe(true);
      const t = r.snapshot.tasks[0]!;
      expect(t.status).toBe("in_progress");
      expect(t.steps["implement"]!.status).toBe("pending");
      // SC2 is a repair loop — the finding stays open.
      expect(r.snapshot.findings[0]!.status).toBe("open");
    }
  });

  test("abandoned target task → 3-entry batch rejected (codex r140 P1)", async () => {
    // The reachable exploit: `finding raise --action fix-impl` targeting an
    // abandoned task. Preflight (run inside mutateBatch Pass 1) rejects the
    // event:task_step_reset entry — the abandoned task is never resurrected.
    const dir = await tmpFeatureDir();
    const baseSnap = snapshotAt("VERIFY.review", {
      tasks: [mkTask({ status: "abandoned" })],
    });
    const r = await mutateBatch(fixImplBatch("VERIFY.review"), {
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
    const r = await mutateBatch(fixImplBatch("EXECUTE.work"), {
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
      expect(r.snapshot.tasks[0]!.steps["implement"]!.status).toBe("pending");
    }
  });

  test("the phase back-edge target mismatch is still rejected (to != EXECUTE.work)", async () => {
    const dir = await tmpFeatureDir();
    const baseSnap = snapshotAt("VERIFY.review", { tasks: [mkTask()] });
    const batch = fixImplBatch("VERIFY.review");
    (batch[2]!.payload as { to: string }).to = "SPEC.spec";
    const r = await mutateBatch(batch, {
      feature_dir: dir,
      snapshot: baseSnap,
      tail_seq: -1,
      entries: [],
      meta: emptyMeta(),
      fsync: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TRANSITION_ILLEGAL");
      expect(r.detail!["reason"]).toBe("back_edge_target_mismatch");
    }
  });
});
