import { describe, expect, test } from "vitest";

import {
  initialSnapshot,
  type FindingState,
  type RequirementState,
  type Snapshot,
  type TaskState,
} from "../../src/core/reducer.js";
import type { Ceremony, SubState } from "../../src/core/journal-entry.js";
import {
  ORDERED_CHECKS,
  preflight,
  type PreflightFailureCode,
} from "../../src/core/reducer/preflight.js";

const STANDARD_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

const QUICK_CEREMONY: Ceremony = {
  spec_phase: false,
  verify_phase: false,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

type PrecedenceRow = {
  name: string;
  entry: Record<string, unknown>;
  ctx: { snapshot: Snapshot; tail_seq: number };
  expected: PreflightFailureCode;
};

function mkSnapshot(
  sub_state: SubState,
  ceremony: Ceremony = STANDARD_CEREMONY,
  overrides: {
    verify_accepted?: boolean;
    spec_locked?: boolean;
    spec_version?: number;
    tasks?: TaskState[];
    findings?: FindingState[];
    pending?: Snapshot["pending"];
    requirements?: RequirementState[];
  } = {},
): Snapshot {
  const phase = sub_state.split(".")[0] as NonNullable<Snapshot["state"]>["phase"];
  return {
    ...initialSnapshot(),
    state: {
      session_id: "test-session",
      feature: "test",
      phase,
      sub_state,
      iteration: 1,
      spec_locked: overrides.spec_locked ?? false,
      verify_accepted: overrides.verify_accepted ?? false,
      spec_version: overrides.spec_version ?? 0,
      ceremony,
    },
    tasks: overrides.tasks ?? [],
    findings: overrides.findings ?? [],
    pending: overrides.pending ?? [],
    requirements: overrides.requirements ?? [],
  };
}

function baseEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 0,
    entry_id: "JE-000001",
    at: "2026-05-15T10:00:00.000Z",
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind: "pending:added",
    payload: { id: "PEND-0001", kind: "ask_user_question", question: "stub" },
    ...overrides,
  };
}

function task(overrides: Partial<TaskState> = {}): TaskState {
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

function behavioralFull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const execStep = (applicability: string, status = "pending"): Record<string, unknown> => ({
    applicability,
    status,
    evidence_refs: [],
  });
  return {
    id: "T-001",
    kind: "behavioral",
    drives: ["REQ-AUTH-001"],
    tests: ["TokenCoord.refreshOnce"],
    status: "pending",
    depends_on: [],
    labels: [],
    execution: {
      red: execStep("must"),
      implement: execStep("must"),
      refactor: execStep("optional"),
    },
    ...overrides,
  };
}

function req(overrides: Record<string, unknown> = {}): RequirementState {
  return {
    id: "REQ-AUTH-001",
    type: "ubiquitous",
    response: "The system refreshes tokens exactly once.",
    acceptance_na: true,
    acceptance_na_reason: "covered by characterization fixture",
    ...overrides,
  } as RequirementState;
}

const pendingGateHead = [{ id: "PEND-0001", kind: "gate_decision", resolved: false }];
const pendingQuestionHead = [{ id: "PEND-0001", kind: "ask_user_question", resolved: false }];

const PRECEDENCE_PAIRS: PrecedenceRow[] = [
  {
    name: "bad envelope + bad payload -> INVALID_ENVELOPE because envelope parse runs first",
    entry: baseEntry({ kind: undefined, payload: "not-an-object" }),
    ctx: { snapshot: mkSnapshot("TRIAGE.score"), tail_seq: -1 },
    expected: "INVALID_ENVELOPE",
  },
  {
    name: "bad seq + bad sub_state -> SEQ_NOT_MONOTONIC because seq runs before sub_state authority",
    entry: baseEntry({
      seq: 5,
      kind: "event:task_step_done",
      payload: { task_id: "T-001", step: "implement" },
    }),
    ctx: { snapshot: mkSnapshot("TRIAGE.score"), tail_seq: -1 },
    expected: "SEQ_NOT_MONOTONIC",
  },
  {
    name: "bad sub_state + bad actor -> SUB_STATE_AUTHORITY_VIOLATION because sub_state runs before actor",
    entry: baseEntry({
      actor: "cli:loaf",
      kind: "gate:decided",
      payload: { gate_kind: "spec-lock", decision: "approved", reason: "ok" },
    }),
    ctx: { snapshot: mkSnapshot("TRIAGE.score"), tail_seq: -1 },
    expected: "SUB_STATE_AUTHORITY_VIOLATION",
  },
  {
    name: "bad actor + bad payload -> ACTOR_AUTHORITY_VIOLATION because actor runs before payload schema",
    entry: baseEntry({ kind: "gate:decided", payload: {} }),
    ctx: { snapshot: mkSnapshot("SPEC.design"), tail_seq: -1 },
    expected: "ACTOR_AUTHORITY_VIOLATION",
  },
  {
    name: "bad payload + gate wrong lane -> INVALID_PAYLOAD because payload schema runs before typed gate refines",
    entry: baseEntry({
      actor: "human:est9",
      kind: "gate:decided",
      payload: { gate_kind: "spec-lock", decision: "approved" },
    }),
    ctx: { snapshot: mkSnapshot("VERIFY.accept"), tail_seq: -1 },
    expected: "INVALID_PAYLOAD",
  },
  {
    name: "gate wrong lane + non-gate pending head -> SUB_STATE_AUTHORITY_VIOLATION because gate lane refine runs before pending guard",
    entry: baseEntry({
      actor: "human:est9",
      kind: "gate:decided",
      payload: { gate_kind: "spec-lock", decision: "approved", reason: "ok" },
    }),
    ctx: {
      snapshot: mkSnapshot("VERIFY.accept", STANDARD_CEREMONY, { pending: pendingQuestionHead }),
      tail_seq: -1,
    },
    expected: "SUB_STATE_AUTHORITY_VIOLATION",
  },
  {
    name: "phase from mismatch + pending blocker -> FROM_CURSOR_MISMATCH because cursor coherence runs before pending",
    entry: baseEntry({
      kind: "event:phase_advanced",
      payload: { from: "EXECUTE.work", to: "EXECUTE.done" },
    }),
    ctx: {
      snapshot: mkSnapshot("TRIAGE.score", STANDARD_CEREMONY, { pending: pendingGateHead }),
      tail_seq: -1,
    },
    expected: "FROM_CURSOR_MISMATCH",
  },
  {
    name: "phase pending blocker + missing back_edge finding -> PENDING_BLOCKS_ADVANCE because pending runs before sponsor lookup",
    entry: baseEntry({
      kind: "event:phase_advanced",
      payload: {
        from: "EXECUTE.work",
        to: "EXECUTE.done",
        back_edge: { action: "amend-spec", finding_id: "FND-999" },
      },
    }),
    ctx: {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, { pending: pendingGateHead }),
      tail_seq: -1,
    },
    expected: "PENDING_BLOCKS_ADVANCE",
  },
  {
    name: "phase missing back_edge finding + illegal back_edge target -> FINDING_NOT_FOUND because sponsor lookup runs before transition",
    entry: baseEntry({
      kind: "event:phase_advanced",
      payload: {
        from: "EXECUTE.work",
        to: "EXECUTE.done",
        back_edge: { action: "amend-spec", finding_id: "FND-999" },
      },
    }),
    ctx: { snapshot: mkSnapshot("EXECUTE.work"), tail_seq: -1 },
    expected: "FINDING_NOT_FOUND",
  },
  {
    name: "deliver active spike + not accepted -> DELIVER_SPIKE_TASKS because spike block is first in deliver cluster",
    entry: baseEntry({ actor: "human:est9", kind: "session:delivered", payload: {} }),
    ctx: {
      snapshot: mkSnapshot("EXECUTE.done", STANDARD_CEREMONY, {
        tasks: [task({ kind: "spike", status: "done" })],
        verify_accepted: false,
      }),
      tail_seq: -1,
    },
    expected: "DELIVER_SPIKE_TASKS",
  },
  {
    name: "tasks_planned duplicate id + red flag misuse -> DUPLICATE_TASK_ID because duplicate scan runs before creation red-flag rejection",
    entry: baseEntry({
      kind: "event:tasks_planned",
      payload: {
        based_on: { spec: 1 },
        tasks: [behavioralFull(), behavioralFull({ id: "T-001", red_test_registered: true })],
      },
    }),
    ctx: { snapshot: mkSnapshot("SPEC.design"), tail_seq: -1 },
    expected: "DUPLICATE_TASK_ID",
  },
  {
    name: "sponsored tasks_amended missing sponsor + wrong sponsored sub_state -> FINDING_NOT_FOUND because sponsor lookup runs before rights",
    entry: baseEntry({
      kind: "event:tasks_amended",
      payload: {
        mode: "add",
        task: behavioralFull({ id: "T-050" }),
        sponsored_by_finding_id: "FND-999",
      },
    }),
    ctx: { snapshot: mkSnapshot("VERIFY.accept"), tail_seq: -1 },
    expected: "FINDING_NOT_FOUND",
  },
  {
    name: "unsponsored tasks_amended add + wrong replace sub_state -> MUTATION_OUT_OF_RIGHTS because unsponsored add check runs first",
    entry: baseEntry({
      kind: "event:tasks_amended",
      payload: { mode: "add", task: behavioralFull({ id: "T-050" }) },
    }),
    ctx: { snapshot: mkSnapshot("VERIFY.accept"), tail_seq: -1 },
    expected: "MUTATION_OUT_OF_RIGHTS",
  },
  {
    name: "task_claimed already in_progress + deps not satisfied -> TASK_ALREADY_CLAIMED because claim status runs before deps",
    entry: baseEntry({ kind: "event:task_claimed", payload: { task_id: "T-001" } }),
    ctx: {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, {
        tasks: [task({ status: "in_progress", depends_on: ["T-002"] })],
      }),
      tail_seq: -1,
    },
    expected: "TASK_ALREADY_CLAIMED",
  },
  {
    name: "task_step_done not claimed + bug red gaps -> TASK_NOT_CLAIMED because claimed-state runs before bug/red refinements",
    entry: baseEntry({
      kind: "event:task_step_done",
      payload: {
        task_id: "T-001",
        step: "implement",
        result: "passed",
        red_test_registered: true,
      },
    }),
    ctx: {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, {
        tasks: [task({ labels: ["bug"], red_test_registered: false })],
      }),
      tail_seq: -1,
    },
    expected: "TASK_NOT_CLAIMED",
  },
  {
    name: "task_abandoned already done + active dependent -> TASK_NOT_ABANDONABLE because terminal-state runs before dependent blocker",
    entry: baseEntry({
      kind: "event:task_abandoned",
      payload: { task_id: "T-001", reason: "done task cannot be abandoned" },
    }),
    ctx: {
      snapshot: mkSnapshot("EXECUTE.work", STANDARD_CEREMONY, {
        tasks: [
          task({ status: "done" }),
          task({ id: "T-002", status: "pending", depends_on: ["T-001"] }),
        ],
      }),
      tail_seq: -1,
    },
    expected: "TASK_NOT_ABANDONABLE",
  },
  {
    name: "finding incoherent cell + missing required target -> FINDING_ACTION_INCOHERENT because grid coherence runs before target checks",
    entry: baseEntry({
      kind: "finding:raised",
      payload: {
        id: "FND-001",
        category: "spec-gap",
        action: "fix-impl",
        summary: "missing target",
      },
    }),
    ctx: { snapshot: mkSnapshot("EXECUTE.work"), tail_seq: -1 },
    expected: "FINDING_ACTION_INCOHERENT",
  },
  {
    name: "spec req add locked + not initialized/duplicate/version mismatch -> SPEC_LOCKED_NO_DIRECT_EDIT because lock runs before spec refines",
    entry: baseEntry({
      kind: "event:spec_req_added",
      payload: { spec_version: 2, req: req() },
    }),
    ctx: {
      snapshot: mkSnapshot("SPEC.spec", STANDARD_CEREMONY, {
        spec_locked: true,
        spec_version: 0,
        requirements: [req()],
      }),
      tail_seq: -1,
    },
    expected: "SPEC_LOCKED_NO_DIRECT_EDIT",
  },
  {
    name: "spec req add not initialized + duplicate/version mismatch -> SPEC_NOT_INITIALIZED because init gate runs before duplicate/version",
    entry: baseEntry({
      kind: "event:spec_req_added",
      payload: { spec_version: 2, req: req() },
    }),
    ctx: {
      snapshot: mkSnapshot("SPEC.spec", STANDARD_CEREMONY, {
        spec_version: 0,
        requirements: [req()],
      }),
      tail_seq: -1,
    },
    expected: "SPEC_NOT_INITIALIZED",
  },
  {
    name: "spec req add duplicate + version mismatch -> DUPLICATE_REQ_ID because duplicate check runs before version check",
    entry: baseEntry({
      kind: "event:spec_req_added",
      payload: { spec_version: 3, req: req() },
    }),
    ctx: {
      snapshot: mkSnapshot("SPEC.spec", STANDARD_CEREMONY, {
        spec_version: 1,
        requirements: [req()],
      }),
      tail_seq: -1,
    },
    expected: "DUPLICATE_REQ_ID",
  },
  {
    name: "spec_submitted bad batch_index + bad version -> SPEC_VERSION_BATCH_MISMATCH because batch head check runs before monotonicity",
    entry: baseEntry({
      kind: "event:spec_submitted",
      batch_id: "11111111-1111-4111-8111-111111111111",
      batch_index: 1,
      batch_count: 2,
      payload: {
        spec_version: 99,
        feature: { id: "F-001", name: "Feature fixture" },
        intent: "Long enough intent for precedence characterization.",
        adr_refs: [],
        needs_clarification: [],
      },
    }),
    ctx: {
      snapshot: mkSnapshot("SPEC.spec", STANDARD_CEREMONY, { spec_version: 1 }),
      tail_seq: -1,
    },
    expected: "SPEC_VERSION_BATCH_MISMATCH",
  },
  {
    name: "phase bad actor + bad transition -> ACTOR_AUTHORITY_VIOLATION because actor authority runs before transition",
    entry: baseEntry({
      actor: "migration:fixture",
      kind: "event:phase_advanced",
      payload: { from: "EXECUTE.work", to: "DONE.delivered" },
    }),
    ctx: { snapshot: mkSnapshot("EXECUTE.work", QUICK_CEREMONY), tail_seq: -1 },
    expected: "ACTOR_AUTHORITY_VIOLATION",
  },
  // W9a — pin the round-2 W1 transition code SPEC_LOCK_NOT_SATISFIED's
  // precedence position (it post-dates the original SC-10 row set). These lock
  // the order the W9b extraction must preserve.
  {
    name: "spec-lock advance + bad actor -> ACTOR_AUTHORITY_VIOLATION because actor authority runs before the transition spec-lock refine",
    entry: baseEntry({
      actor: "migration:fixture",
      kind: "event:phase_advanced",
      payload: { from: "SPEC.design", to: "EXECUTE.plan" },
    }),
    ctx: {
      snapshot: mkSnapshot("SPEC.design", STANDARD_CEREMONY, { spec_locked: false }),
      tail_seq: -1,
    },
    expected: "ACTOR_AUTHORITY_VIOLATION",
  },
  {
    name: "spec-lock advance + pending head -> PENDING_BLOCKS_ADVANCE because the pending guard runs before the transition spec-lock refine",
    entry: baseEntry({
      kind: "event:phase_advanced",
      payload: { from: "SPEC.design", to: "EXECUTE.plan" },
    }),
    ctx: {
      snapshot: mkSnapshot("SPEC.design", STANDARD_CEREMONY, {
        spec_locked: false,
        pending: pendingGateHead,
      }),
      tail_seq: -1,
    },
    expected: "PENDING_BLOCKS_ADVANCE",
  },
  {
    name: "spec-lock advance illegal target + unlocked -> TRANSITION_ILLEGAL because edge legality runs before the spec-lock refine inside validateTransition",
    entry: baseEntry({
      kind: "event:phase_advanced",
      payload: { from: "SPEC.design", to: "VERIFY.run" },
    }),
    ctx: {
      snapshot: mkSnapshot("SPEC.design", STANDARD_CEREMONY, { spec_locked: false }),
      tail_seq: -1,
    },
    expected: "TRANSITION_ILLEGAL",
  },
  {
    name: "spec-lock advance, legal edge, unlocked, nothing higher -> SPEC_LOCK_NOT_SATISFIED (positive: the W1 refine fires when no earlier check does)",
    entry: baseEntry({
      kind: "event:phase_advanced",
      payload: { from: "SPEC.design", to: "EXECUTE.plan" },
    }),
    ctx: {
      snapshot: mkSnapshot("SPEC.design", STANDARD_CEREMONY, { spec_locked: false }),
      tail_seq: -1,
    },
    expected: "SPEC_LOCK_NOT_SATISFIED",
  },
];

describe("preflight — error precedence characterization", () => {
  test.each(PRECEDENCE_PAIRS)("$name", ({ entry, ctx, expected }) => {
    const r = preflight(entry, ctx);
    expect(r).toMatchObject({ ok: false, code: expected });
  });

  test("PRECEDENCE_PAIRS keeps the converged row count (SC-10: 22 + W9a: 4)", () => {
    expect(PRECEDENCE_PAIRS).toHaveLength(26);
  });
});

// W9b — the ordered pipeline IS the precedence contract. Pin the sequence by
// name so a reorder (or an inserted / dropped check) fails loudly, even for a
// pair the PRECEDENCE_PAIRS rows above don't happen to cover. The two checks
// that run inline in preflight() before the pipeline (envelope parse, per-kind
// payload parse — they build the check context) are intentionally absent here;
// INVALID_PAYLOAD's precedence slot is held by checkPerKindPayload below.
describe("preflight — ORDERED_CHECKS pipeline order", () => {
  test("the check sequence is the load-bearing precedence order", () => {
    expect(ORDERED_CHECKS.map((c) => c.name)).toEqual([
      "checkSeqMonotonic", // (2)
      "checkSubStateAuthority", // (3)
      "checkActorAuthority", // (4)
      "checkPerKindPayload", // (4b)
      "checkGateDecided", // (5a)
      "checkPhaseAdvanced", // (5b)
      "checkSessionDelivered", // (5c)
      "checkSpikeConverted", // (5c.3)
      "checkCeremonySet", // (5c.4)
      "checkSessionTerminalReason", // (5c.2)
      "checkTasksPlanned", // (5d.1)
      "checkTasksAmended", // (5d.2)
      "checkTaskLifecycle", // (5e)
      "checkTaskAbandoned", // (5e.3)
      "checkTaskStepReset", // (5e.4)
      "checkFindingRaised", // (5g)
      "checkSpecContentPhase", // (5i)
      "checkSpecDuplicateIds", // (5h)
      "checkSpecVersion", // (5j)
      "checkTransitionEdge", // (5f)
    ]);
  });
});
