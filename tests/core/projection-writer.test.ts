// Phase 14 SC1 — `loaf doctor --rebuild` projection serializer unit tests.
//
// Covers the pure compose + IO write split (findings.md F-018, codex
// r155/r156):
//   composeTasksJson      — null when no plan; THROWS on a snapshot task
//                           with no canonical journal body; `version`
//                           counts plan + amend; runtime-status overlay.
//   composeEvidenceJson   — `evidence:added` payloads + envelope-derived
//                           schema_version/at; empty journal → empty array.
//   composeFindingsJson   — projects snapshot.findings (open + closed).
//   composePendingJson    — `pending:added` → projection entry; `resolved`
//                           flips on a matching `pending:resolved`; field
//                           rename id→pending_id, task_id→raised_by_task_id.
//   writeProjections      — writes the 4 (or 3, no-tasks) files + _meta.json;
//                           tasks.json skipped without a plan; _meta matches
//                           the passed meta; idempotent.
//
// The compose functions are PURE — the focused tests hand-build
// `JournalEntry[]` fixtures (the `entry()` helper, mirroring
// task-history.test.ts). The end-to-end writeProjections cases drive a
// real journal through `mutateBatch` and `replayJournal(collect_entries)`
// so the {snapshot, entries, meta} triple is authentic journal truth.

import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  composeEvidenceJson,
  composeFindingsJson,
  composePendingJson,
  composeStateProjection,
  composeTasksJson,
  writeProjections,
} from "../../src/core/projection-writer.js";
import { initialSnapshot, apply, type Snapshot } from "../../src/core/reducer.js";
import type { Ceremony, JournalEntry } from "../../src/core/journal-entry.js";
import { mutateBatch } from "../../src/core/journal-mutate.js";
import { appendEntry } from "../../src/core/journal-append.js";
import { replayJournal } from "../../src/core/journal-bootstrap.js";
import { emptyMeta } from "../../src/core/snapshot.js";

const STANDARD: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

// ── Hand-built JournalEntry fixtures (pure-function tests) ───────────────

function entry(seq: number, kind: JournalEntry["kind"], payload: unknown): JournalEntry {
  return {
    seq,
    entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
    at: `2026-05-21T10:00:${String(seq).padStart(2, "0")}.000Z`,
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind,
    payload,
  };
}

function behavioralTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

/** A slim TaskState matching `behavioralTask` — lives in `Snapshot.tasks`. */
function slimTask(overrides: Partial<Snapshot["tasks"][number]> = {}): Snapshot["tasks"][number] {
  return {
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
    ...overrides,
  };
}

// ── composeTasksJson ─────────────────────────────────────────────────────

describe("composeTasksJson — Phase 14 SC1", () => {
  test("returns null when snapshot.tasks_based_on is null (no task plan → file skipped)", () => {
    const snap = initialSnapshot();
    expect(composeTasksJson(snap, [])).toBeNull();
  });

  test("THROWS when a snapshot task has no canonical journal body (projection corruption)", () => {
    const snap = initialSnapshot();
    snap.tasks_based_on = { spec: 1 };
    snap.tasks = [slimTask({ id: "T-099" })];
    // entries carry NO body for T-099 — composeTasksJson must not invent one.
    expect(() => composeTasksJson(snap, [])).toThrow(/T-099/);
    expect(() => composeTasksJson(snap, [])).toThrow(/no canonical journal body/);
  });

  test("version counts every plan + amend entry", () => {
    const snap = initialSnapshot();
    snap.tasks_based_on = { spec: 2 };
    snap.tasks = [slimTask()];
    const entries = [
      entry(0, "event:tasks_planned", {
        based_on: { spec: 1 },
        tasks: [behavioralTask()],
      }),
      entry(1, "event:tasks_amended", { task: behavioralTask({ tests: ["new.test"] }) }),
      entry(2, "event:tasks_planned", {
        based_on: { spec: 2 },
        tasks: [behavioralTask()],
      }),
      // a non-plan/amend entry must NOT bump the counter
      entry(3, "event:task_claimed", { task_id: "T-001" }),
    ];
    const tj = composeTasksJson(snap, entries);
    expect(tj).not.toBeNull();
    expect(tj!.version).toBe(3);
    expect(tj!.based_on.spec).toBe(2);
    expect(tj!.schema_version).toBe(2);
  });

  test("overlays the live runtime status from the slim TaskState onto the canonical body", () => {
    const snap = initialSnapshot();
    snap.tasks_based_on = { spec: 1 };
    // Slim projection says the task is in_progress with red passed —
    // the canonical body (from the plan) still says pending.
    snap.tasks = [
      slimTask({
        status: "in_progress",
        steps: {
          red: { applicability: "must", status: "passed" },
          implement: { applicability: "must", status: "running" },
          refactor: { applicability: "optional", status: "pending" },
        },
      }),
    ];
    const entries = [
      entry(0, "event:tasks_planned", {
        based_on: { spec: 1 },
        tasks: [behavioralTask()],
      }),
    ];
    const tj = composeTasksJson(snap, entries);
    const task = tj!.tasks[0]!;
    expect(task.status).toBe("in_progress");
    const exec = task.execution as Record<string, { status: string }>;
    expect(exec.red!.status).toBe("passed");
    expect(exec.implement!.status).toBe("running");
    // canonical body-only fields survive the overlay
    expect((task as { tests: string[] }).tests).toEqual(["TokenCoord.refreshOnce"]);
  });

  test("strips legacy task-step evidence_refs from the live projection", () => {
    const snap = initialSnapshot();
    snap.tasks_based_on = { spec: 1 };
    snap.tasks = [slimTask()];
    const legacyTask = behavioralTask() as Record<string, any>;
    legacyTask.execution.red.evidence_refs = ["EV-000001"];
    const projected = composeTasksJson(snap, [
      entry(0, "event:tasks_planned", {
        based_on: { spec: 1 },
        tasks: [legacyTask],
      }),
    ]);
    const execution = projected!.tasks[0]!.execution as Record<string, unknown>;
    expect(execution.red).not.toHaveProperty("evidence_refs");
  });
});

// ── composeEvidenceJson ──────────────────────────────────────────────────

describe("composeEvidenceJson — Phase 14 SC1", () => {
  test("empty journal → empty evidence array", () => {
    const ej = composeEvidenceJson([]);
    expect(ej.schema_version).toBe(2);
    expect(ej.evidence).toEqual([]);
  });

  test("evidence:added payloads round-trip with schema_version + at re-attached", () => {
    const entries = [
      entry(5, "event:phase_advanced", { from: "EXECUTE.plan", to: "EXECUTE.work" }),
      entry(6, "evidence:added", {
        id: "EV-000001",
        kind: "local-check",
        iteration: 1,
        actor: "cli:loaf",
        result: "passed",
        summary: "typecheck + lint clean",
        covers: [],
      }),
      entry(7, "evidence:added", {
        id: "EV-000002",
        kind: "task-summary",
        iteration: 1,
        actor: "cli:loaf",
        result: "passed",
        summary: "T-001 closed",
        covers: ["T-001"],
        task_id: "T-001",
      }),
    ];
    const ej = composeEvidenceJson(entries);
    expect(ej.evidence).toHaveLength(2);
    const first = ej.evidence[0]!;
    expect(first.id).toBe("EV-000001");
    expect(first.kind).toBe("local-check");
    expect(first.schema_version).toBe(2);
    // `at` is taken from the journal envelope, not the payload.
    expect(first.at).toBe("2026-05-21T10:00:06.000Z");
    expect(ej.evidence[1]!.id).toBe("EV-000002");
    expect(ej.evidence[1]!.at).toBe("2026-05-21T10:00:07.000Z");
  });

  test("preserves journal order", () => {
    const entries = [
      entry(0, "evidence:added", {
        id: "EV-000002",
        kind: "local-check",
        iteration: 1,
        actor: "cli:loaf",
        result: "passed",
        summary: "second by seq",
        covers: [],
      }),
      entry(1, "evidence:added", {
        id: "EV-000001",
        kind: "local-check",
        iteration: 1,
        actor: "cli:loaf",
        result: "passed",
        summary: "first by seq",
        covers: [],
      }),
    ];
    const ej = composeEvidenceJson(entries);
    expect(ej.evidence.map((e) => e.id)).toEqual(["EV-000002", "EV-000001"]);
  });

  test("THROWS on a refine-violating evidence payload — `--rebuild` must not launder corruption (codex r158)", () => {
    // `kind: manual` requires a human:* actor + reason >=10 chars.
    // replayJournal validates only the envelope, so an envelope-valid but
    // refine-violating payload reaches the serializer — it must reject it,
    // not materialize it into a clean evidence.json.
    const bad = entry(0, "evidence:added", {
      id: "EV-000001",
      kind: "manual",
      iteration: 1,
      actor: "cli:loaf",
      result: "passed",
      summary: "manual evidence with no human actor and no reason",
      covers: [],
    });
    expect(() => composeEvidenceJson([bad])).toThrow();
  });
});

// ── composeFindingsJson ──────────────────────────────────────────────────

describe("composeFindingsJson — Phase 14 SC1", () => {
  test("empty findings → empty array", () => {
    const fj = composeFindingsJson(initialSnapshot());
    expect(fj.schema_version).toBe(2);
    expect(fj.findings).toEqual([]);
  });

  test("projects snapshot.findings including open + closed status", () => {
    const snap = initialSnapshot();
    snap.findings = [
      {
        id: "FND-001",
        category: "spec-gap",
        action: "amend-spec",
        status: "open",
        summary: "missing error path",
      },
      {
        id: "FND-002",
        category: "impl-defect",
        action: "fix-impl",
        status: "closed",
        summary: "off-by-one",
        target: { task_id: "T-001", step: "implement" },
      },
    ];
    const fj = composeFindingsJson(snap);
    expect(fj.findings).toHaveLength(2);
    expect(fj.findings[0]!.status).toBe("open");
    expect(fj.findings[1]!.status).toBe("closed");
    expect(fj.findings[1]!.target).toEqual({ task_id: "T-001", step: "implement" });
  });
});

// ── composePendingJson ───────────────────────────────────────────────────

describe("composePendingJson — Phase 14 SC1", () => {
  test("empty journal → empty pending array", () => {
    const pj = composePendingJson([]);
    expect(pj.schema_version).toBe(2);
    expect(pj.pending).toEqual([]);
  });

  test("pending:added → projection entry with envelope-derived raised_by / at / raised_at", () => {
    const e = {
      ...entry(3, "pending:added", {
        id: "PEND-0001",
        kind: "ask_user_question",
        question: "which retry policy applies here?",
      }),
      actor: "human:est9",
    };
    const pj = composePendingJson([e]);
    expect(pj.pending).toHaveLength(1);
    const item = pj.pending[0]!;
    expect(item.pending_id).toBe("PEND-0001");
    expect(item.kind).toBe("ask_user_question");
    expect(item.question).toBe("which retry policy applies here?");
    // envelope-derived fields
    expect(item.raised_by).toBe("human:est9");
    expect(item.at).toBe("2026-05-21T10:00:03.000Z");
    expect(item.raised_at).toBe("2026-05-21T10:00:03.000Z");
    // constant — the journal payload never carried `blocks`
    expect(item.blocks).toBe("advance");
    // no matching pending:resolved → resolved stays false
    expect(item.resolved).toBe(false);
  });

  test("resolved flips true when a matching pending:resolved entry exists", () => {
    const entries = [
      entry(0, "pending:added", {
        id: "PEND-0001",
        kind: "ask_user_question",
        question: "first prompt — gets resolved",
      }),
      entry(1, "pending:added", {
        id: "PEND-0002",
        kind: "ask_user_question",
        question: "second prompt — stays open",
      }),
      entry(2, "pending:resolved", { id: "PEND-0001" }),
    ];
    const pj = composePendingJson(entries);
    const byId = new Map(pj.pending.map((p) => [p.pending_id, p]));
    expect(byId.get("PEND-0001")!.resolved).toBe(true);
    expect(byId.get("PEND-0002")!.resolved).toBe(false);
  });

  test("maps payload id→pending_id, task_id→raised_by_task_id, carries options when present", () => {
    const e = entry(0, "pending:added", {
      id: "PEND-0007",
      kind: "finding_decision",
      question: "amend the spec or defer this finding?",
      options: ["amend-spec", "defer"],
      task_id: "T-003",
    });
    const pj = composePendingJson([e]);
    const item = pj.pending[0]!;
    expect(item.pending_id).toBe("PEND-0007");
    expect(item.raised_by_task_id).toBe("T-003");
    expect(item.options).toEqual(["amend-spec", "defer"]);
  });

  test("omits options / raised_by_task_id when the payload lacks them", () => {
    const e = entry(0, "pending:added", {
      id: "PEND-0009",
      kind: "spec_clarification",
      question: "session-level clarification, no task linkage",
    });
    const pj = composePendingJson([e]);
    const item = pj.pending[0]!;
    expect(item.options).toBeUndefined();
    expect(item.raised_by_task_id).toBeUndefined();
  });
});

// ── writeProjections — end-to-end on a real journal ──────────────────────

/**
 * Drive a real journal via `mutateBatch` from session:started through
 * SPEC.design, submit a one-task plan, walk into EXECUTE.work, and append
 * an evidence + finding + pending ledger entry. Returns the feature dir.
 *
 * `replayJournal(collect_entries:true)` over the resulting journal gives
 * the authentic {snapshot, entries, meta} triple writeProjections consumes.
 */
async function buildFullFeatureJournal(opts: { withPlan: boolean }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "loaf-projection-writer-"));
  let snapshot = initialSnapshot();
  let tail = -1;
  let entries: JournalEntry[] = [];
  let meta = emptyMeta();

  async function step(partials: Parameters<typeof mutateBatch>[0]): Promise<void> {
    const r = await mutateBatch(partials, {
      feature_dir: dir,
      snapshot,
      tail_seq: tail,
      entries,
      meta,
      fsync: false,
    });
    if (!r.ok) throw new Error(`journal build step failed: ${r.code} ${r.message}`);
    snapshot = r.snapshot;
    tail += partials.length;
    entries = entries.concat(r.entries);
    meta = r.meta;
  }

  await step([
    {
      at: "2026-05-21T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "auth-refresh",
        ceremony: STANDARD,
      },
    },
  ]);

  // Walk TRIAGE → SPEC.design.
  const toSpecDesign: Array<[string, string]> = [
    ["TRIAGE.score", "TRIAGE.confirm"],
    ["TRIAGE.confirm", "SPEC.proposal"],
    ["SPEC.proposal", "SPEC.spec"],
    ["SPEC.spec", "SPEC.plan"],
    ["SPEC.plan", "SPEC.design"],
  ];
  for (const [from, to] of toSpecDesign) {
    await step([
      {
        at: "2026-05-21T10:00:01.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from, to } as unknown as Record<string, unknown>,
      },
    ]);
  }

  // Submit a spec so spec_version=1, then a one-task plan at SPEC.design.
  await step([
    {
      at: "2026-05-21T10:00:02.000Z",
      actor: "human:tester@example.invalid",
      entry_schema_version: 1,
      kind: "event:spec_submitted",
      payload: {
        spec_version: 1,
        feature: { id: "F-001", name: "OAuth access token refresh" },
        intent: "users should not perceive auth recovery flows in flight",
        adr_refs: [],
        needs_clarification: [],
      },
    },
  ]);

  if (opts.withPlan) {
    await step([
      {
        at: "2026-05-21T10:00:03.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:tasks_planned",
        payload: {
          based_on: { spec: 1 },
          tasks: [behavioralTask()],
        },
      },
    ]);
  }

  // Approve spec-lock before SPEC.design → EXECUTE.plan (guard added in
  // fix/enforcement-integrity-closure). appendEntry bypasses Pass 1.5
  // (evaluateSpecLock); also apply in-memory so snapshot.state.spec_locked=true
  // when step() calls mutateBatch for the next edge.
  {
    const journalPath = path.join(dir, "journal.jsonl");
    const gateSeq = tail + 1;
    const gateEntry: JournalEntry = {
      seq: gateSeq,
      entry_id: `JE-${String(gateSeq + 1).padStart(6, "0")}`,
      at: "2026-05-21T10:00:03.500Z",
      actor: "human:est9",
      entry_schema_version: 1,
      kind: "gate:decided",
      payload: { gate_kind: "spec-lock", decision: "approved", reason: "seed" },
    };
    meta = await appendEntry(journalPath, gateEntry, meta, { fsync: false });
    const applyResult = apply(snapshot, gateEntry);
    if (!applyResult.ok) throw new Error(`gate apply failed: ${applyResult.code}`);
    snapshot = applyResult.snapshot;
    tail = gateSeq;
    entries = entries.concat(gateEntry);
  }
  // SPEC.design → EXECUTE.plan → EXECUTE.work.
  for (const [from, to] of [
    ["SPEC.design", "EXECUTE.plan"],
    ["EXECUTE.plan", "EXECUTE.work"],
  ] as Array<[string, string]>) {
    await step([
      {
        at: "2026-05-21T10:00:04.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from, to } as unknown as Record<string, unknown>,
      },
    ]);
  }

  // A ledger trio at EXECUTE.work — evidence + finding + pending.
  await step([
    {
      at: "2026-05-21T10:00:05.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "evidence:added",
      payload: {
        id: "EV-000001",
        kind: "local-check",
        iteration: 1,
        actor: "cli:loaf",
        result: "passed",
        summary: "typecheck + lint clean",
        covers: [],
      },
    },
  ]);
  await step([
    {
      at: "2026-05-21T10:00:06.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "finding:raised",
      payload: {
        id: "FND-001",
        category: "spec-gap",
        action: "defer",
        summary: "edge case not covered by current scope",
      },
    },
  ]);
  await step([
    {
      at: "2026-05-21T10:00:07.000Z",
      actor: "human:est9",
      entry_schema_version: 1,
      kind: "pending:added",
      payload: {
        id: "PEND-0001",
        kind: "ask_user_question",
        question: "should the retry budget be configurable?",
      },
    },
  ]);

  return dir;
}

// ── composeStateProjection (Phase 15 SC1, F-019) ─────────────────────────

type SState = NonNullable<Snapshot["state"]>;

function sessionState(overrides: Partial<SState> = {}): SState {
  return {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    feature: "auth-refresh",
    phase: "SPEC",
    sub_state: "SPEC.design",
    iteration: 1,
    spec_locked: false,
    verify_accepted: false,
    spec_version: 1,
    ceremony: STANDARD,
    ...overrides,
  };
}

function stateSnapshot(
  overrides: Partial<SState> = {},
  snapOverrides: Partial<Snapshot> = {},
): Snapshot {
  return { ...initialSnapshot(), state: sessionState(overrides), ...snapOverrides };
}

/** A widened (post-SC1) session:started entry carrying the bucket-C fields. */
function startedWidened(): JournalEntry {
  return entry(0, "session:started", {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    feature: "auth-refresh",
    ceremony: STANDARD,
    session_label: "OAuth refresh",
    ceremony_label: "standard",
    workspace: "team-a",
    loaf_version_required: "^0.1.0",
  });
}

/** A legacy (pre-SC1) session:started entry — bucket-C fields absent. */
function startedLegacy(): JournalEntry {
  return entry(0, "session:started", {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    feature: "auth-refresh",
    ceremony: STANDARD,
  });
}

describe("composeStateProjection — Phase 15 SC1", () => {
  test("returns null when the snapshot has no session (empty journal → file skipped)", () => {
    expect(composeStateProjection(initialSnapshot(), [])).toBeNull();
  });

  test("widened session:started — bucket-C fields project verbatim", () => {
    const state = composeStateProjection(stateSnapshot(), [startedWidened()]);
    expect(state).not.toBeNull();
    expect(state!.session_label).toBe("OAuth refresh");
    expect(state!.ceremony_label).toBe("standard");
    expect(state!.workspace).toBe("team-a");
    expect(state!.loaf_version_required).toBe("^0.1.0");
  });

  test("legacy session:started — bucket-C fields fall back to the documented defaults", () => {
    const state = composeStateProjection(stateSnapshot(), [startedLegacy()]);
    expect(state!.session_label).toBeNull();
    expect(state!.loaf_version_required).toBeNull();
    expect(state!.workspace).toBe("default");
    expect(state!.ceremony_label).toBe("");
  });

  test("complexity_score is always null — no journal source (F-019)", () => {
    const state = composeStateProjection(stateSnapshot(), [startedWidened()]);
    expect(state!.complexity_score).toBeNull();
  });

  test("created_at = session:started envelope; updated_at = last replayed entry", () => {
    const entries = [
      startedWidened(),
      entry(1, "event:phase_advanced", { from: "TRIAGE.score", to: "TRIAGE.confirm" }),
      entry(2, "event:phase_advanced", { from: "TRIAGE.confirm", to: "SPEC.proposal" }),
    ];
    const state = composeStateProjection(stateSnapshot(), entries);
    expect(state!.created_at).toBe("2026-05-21T10:00:00.000Z");
    expect(state!.updated_at).toBe("2026-05-21T10:00:02.000Z");
  });

  test("D-bucket fields (cwd / debug / heartbeat_at) never appear in the projection", () => {
    const state = composeStateProjection(stateSnapshot(), [startedWidened()]);
    expect(state).not.toHaveProperty("cwd");
    expect(state).not.toHaveProperty("debug");
    expect(state).not.toHaveProperty("heartbeat_at");
  });

  test("based_on.tasks counts plan + amend; based_on.spec from tasks_based_on", () => {
    const entries = [
      startedWidened(),
      entry(1, "event:tasks_planned", { based_on: { spec: 2 }, tasks: [behavioralTask()] }),
      entry(2, "event:tasks_amended", { task: behavioralTask({ tests: ["x.test"] }) }),
    ];
    const snap = stateSnapshot({}, { tasks_based_on: { spec: 2 } });
    const state = composeStateProjection(snap, entries);
    expect(state!.based_on).toEqual({ spec: 2, tasks: 2 });
  });

  test("pending is the LIVE queue — resolved filtered out, no `resolved` key (BLOCK 1)", () => {
    const entries = [
      startedWidened(),
      entry(1, "pending:added", { id: "PEND-0001", kind: "ask_user_question", question: "first?" }),
      entry(2, "pending:added", {
        id: "PEND-0002",
        kind: "ask_user_question",
        question: "second?",
      }),
      entry(3, "pending:resolved", { id: "PEND-0001" }),
    ];
    const state = composeStateProjection(stateSnapshot(), entries);
    expect(state!.pending).toHaveLength(1);
    expect(state!.pending[0]!.pending_id).toBe("PEND-0002");
    // state.json carries the live-queue shape — the `resolved` tag belongs
    // to pending.json alone (codex r168 BLOCK 1).
    expect(state!.pending[0]).not.toHaveProperty("resolved");
  });

  test("THROWS on a present-but-invalid bucket-C field — rebuild must not launder corruption (BLOCK 2)", () => {
    // session_label present but not a string — corruption, not legacy absence.
    const badLabel = entry(0, "session:started", {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "auth-refresh",
      ceremony: STANDARD,
      session_label: 42,
    });
    expect(() => composeStateProjection(stateSnapshot(), [badLabel])).toThrow();

    // loaf_version_required present but malformed — fails the version regex.
    const badVersion = entry(0, "session:started", {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "auth-refresh",
      ceremony: STANDARD,
      loaf_version_required: "not-a-version",
    });
    expect(() => composeStateProjection(stateSnapshot(), [badVersion])).toThrow();
  });

  test("DONE.* terminal — an empty live queue satisfies the pending=[] invariant", () => {
    const entries = [
      startedWidened(),
      entry(1, "pending:added", { id: "PEND-0001", kind: "ask_user_question", question: "blk?" }),
      entry(2, "pending:resolved", { id: "PEND-0001" }),
    ];
    const state = composeStateProjection(
      stateSnapshot({ phase: "DONE", sub_state: "DONE.delivered" }),
      entries,
    );
    expect(state!.pending).toEqual([]);
    expect(state!.sub_state).toBe("DONE.delivered");
  });

  test("THROWS when sub_state does not match phase (StateProjection refine — corruption)", () => {
    expect(() =>
      composeStateProjection(stateSnapshot({ phase: "SPEC", sub_state: "EXECUTE.work" }), [
        startedWidened(),
      ]),
    ).toThrow();
  });

  test("THROWS when the snapshot has session state but no session:started entry", () => {
    expect(() => composeStateProjection(stateSnapshot(), [])).toThrow(/no session:started/);
  });
});

describe("writeProjections — Phase 14 SC1 end-to-end", () => {
  test("writes state/tasks/evidence/findings/pending + _meta.json from a real journal", async () => {
    const dir = await buildFullFeatureJournal({ withPlan: true });
    try {
      const replay = await replayJournal(path.join(dir, "journal.jsonl"), {
        collect_entries: true,
        feature_dir: dir,
      });
      if (!replay.ok) throw new Error(`replay failed: ${replay.code}`);

      await writeProjections(dir, {
        snapshot: replay.snapshot,
        entries: replay.entries!,
        meta: replay.meta,
      });

      const snapDir = path.join(dir, "snapshots");
      const state = JSON.parse(await readFile(path.join(snapDir, "state.json"), "utf8"));
      const tasks = JSON.parse(await readFile(path.join(snapDir, "tasks.json"), "utf8"));
      const evidence = JSON.parse(await readFile(path.join(snapDir, "evidence.json"), "utf8"));
      const findings = JSON.parse(await readFile(path.join(snapDir, "findings.json"), "utf8"));
      const pending = JSON.parse(await readFile(path.join(snapDir, "pending.json"), "utf8"));
      const meta = JSON.parse(await readFile(path.join(snapDir, "_meta.json"), "utf8"));

      expect(state.session_id).toBeTruthy();
      expect(state.sub_state.startsWith(state.phase + ".")).toBe(true);

      expect(tasks.tasks).toHaveLength(1);
      expect(tasks.tasks[0].id).toBe("T-001");
      expect(tasks.version).toBe(1);
      expect(tasks.based_on.spec).toBe(1);

      expect(evidence.evidence).toHaveLength(1);
      expect(evidence.evidence[0].id).toBe("EV-000001");
      expect(evidence.evidence[0].at).toBe("2026-05-21T10:00:05.000Z");

      expect(findings.findings).toHaveLength(1);
      expect(findings.findings[0].id).toBe("FND-001");

      expect(pending.pending).toHaveLength(1);
      expect(pending.pending[0].pending_id).toBe("PEND-0001");
      expect(pending.pending[0].raised_by).toBe("human:est9");

      // _meta.json content matches the passed replay meta verbatim.
      expect(meta.last_applied_seq).toBe(replay.meta.last_applied_seq);
      expect(meta.rolling_checksum).toBe(replay.meta.rolling_checksum);
      expect(meta.feature_schema_version).toBe(replay.meta.feature_schema_version);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("tasks.json is absent when no task plan landed (composeTasksJson null)", async () => {
    const dir = await buildFullFeatureJournal({ withPlan: false });
    try {
      const replay = await replayJournal(path.join(dir, "journal.jsonl"), {
        collect_entries: true,
        feature_dir: dir,
      });
      if (!replay.ok) throw new Error(`replay failed: ${replay.code}`);

      await writeProjections(dir, {
        snapshot: replay.snapshot,
        entries: replay.entries!,
        meta: replay.meta,
      });

      const snapDir = path.join(dir, "snapshots");
      // tasks.json must NOT exist — never written empty.
      await expect(stat(path.join(snapDir, "tasks.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      // state.json + the other three + _meta.json are still present.
      expect((await stat(path.join(snapDir, "state.json"))).isFile()).toBe(true);
      expect((await stat(path.join(snapDir, "evidence.json"))).isFile()).toBe(true);
      expect((await stat(path.join(snapDir, "findings.json"))).isFile()).toBe(true);
      expect((await stat(path.join(snapDir, "pending.json"))).isFile()).toBe(true);
      expect((await stat(path.join(snapDir, "_meta.json"))).isFile()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removes a stale tasks.json when the rebuild has no task plan (codex r158 BLOCK)", async () => {
    const dir = await buildFullFeatureJournal({ withPlan: false });
    try {
      const snapDir = path.join(dir, "snapshots");
      // Plant a stale tasks.json from a hypothetical prior state.
      await mkdir(snapDir, { recursive: true });
      await writeFile(path.join(snapDir, "tasks.json"), '{"stale":true}', "utf8");

      const replay = await replayJournal(path.join(dir, "journal.jsonl"), {
        collect_entries: true,
        feature_dir: dir,
      });
      if (!replay.ok) throw new Error(`replay failed: ${replay.code}`);

      await writeProjections(dir, {
        snapshot: replay.snapshot,
        entries: replay.entries!,
        meta: replay.meta,
      });

      // The stale tasks.json must be gone — a fresh _meta.json must never
      // point a reader at a projection the journal no longer supports.
      await expect(stat(path.join(snapDir, "tasks.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-run is idempotent — identical files on the second writeProjections", async () => {
    const dir = await buildFullFeatureJournal({ withPlan: true });
    try {
      const replay = await replayJournal(path.join(dir, "journal.jsonl"), {
        collect_entries: true,
        feature_dir: dir,
      });
      if (!replay.ok) throw new Error(`replay failed: ${replay.code}`);

      // _meta.json carries `written_at` (a wall-clock stamp) — pin the
      // passed meta so the two runs are byte-comparable for every file.
      const meta = { ...replay.meta, written_at: emptyMeta().written_at };
      const input = { snapshot: replay.snapshot, entries: replay.entries!, meta };

      await writeProjections(dir, input);
      const snapDir = path.join(dir, "snapshots");
      const files = [
        "state.json",
        "tasks.json",
        "evidence.json",
        "findings.json",
        "pending.json",
        "_meta.json",
      ];
      const first: Record<string, string> = {};
      for (const f of files) first[f] = await readFile(path.join(snapDir, f), "utf8");

      await writeProjections(dir, input);
      for (const f of files) {
        expect(await readFile(path.join(snapDir, f), "utf8")).toBe(first[f]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates the snapshots/ directory when absent (fresh feature dir)", async () => {
    const dir = await buildFullFeatureJournal({ withPlan: false });
    try {
      const replay = await replayJournal(path.join(dir, "journal.jsonl"), {
        collect_entries: true,
        feature_dir: dir,
      });
      if (!replay.ok) throw new Error(`replay failed: ${replay.code}`);

      // `buildFullFeatureJournal` drives the journal via `mutateBatch`, whose
      // step 8 (Phase 15 SC2) already wrote `snapshots/`. Remove it so this
      // test can re-prove writeProjections' own mkdir behavior on an absent
      // directory.
      await rm(path.join(dir, "snapshots"), { recursive: true, force: true });
      await expect(stat(path.join(dir, "snapshots"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await writeProjections(dir, {
        snapshot: replay.snapshot,
        entries: replay.entries!,
        meta: replay.meta,
      });
      expect((await stat(path.join(dir, "snapshots"))).isDirectory()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
