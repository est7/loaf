// Regression ledger for reducer checks removed in entry-admission Step 2.
// Baseline line references below identify the deleted rules at 75fb29e.
import { describe, expect, test } from "vitest";
import { PER_KIND_PAYLOAD } from "../../src/core/kind-registry.js";
import { preflight } from "../../src/core/reducer/preflight.js";
import { admitEntry } from "../../src/core/entry-admission.js";
import { initialSnapshot, type Snapshot } from "../../src/core/reducer.js";
import type { EntryKind, JournalEntry, SubState } from "../../src/core/journal-entry.js";

const ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip" as const,
  strict_drift_check: false,
};
const step = { applicability: "must", status: "pending" };
const task = {
  id: "T-001",
  kind: "structural",
  status: "pending",
  drives: ["REQ-AUTH-001"],
  depends_on: [],
  labels: [],
  no_test_rationale: "pure rename without behavior changes",
  execution: { implement: step, refactor: step },
};
const req = {
  id: "REQ-AUTH-001",
  type: "ubiquitous" as const,
  response: "the system shall preserve the journal",
  acceptance_na: true as const,
  acceptance_na_reason: "verified by the static contract audit",
};
const scenario = {
  id: "SCEN-AUTH-E2E-001",
  name: "admission guard",
  tag: "e2e" as const,
  requires_acceptance: true,
  given: ["a session"],
  when: ["an entry"],
  then: ["a projection"],
};
const visual = {
  id: "VIS-AUTH-001",
  target: "the admission result panel",
  checks: ["shows the declared result"],
  requires_visual: true,
};
const submitted = {
  spec_version: 2,
  feature: { id: "F-001", name: "admission guards" },
  intent: "preserve the existing entry admission contract",
  adr_refs: [],
  needs_clarification: [],
};
const schemas: Array<{
  kind: EntryKind;
  payload: Record<string, unknown>;
  fields: string[];
  rules: number[];
}> = [
  {
    kind: "gate:decided",
    payload: { gate_kind: "spec-lock", decision: "approved", reason: "approved" },
    fields: ["gate_kind"],
    rules: [264],
  },
  {
    kind: "event:tasks_planned",
    payload: { based_on: { spec: 1 }, tasks: [task] },
    fields: ["based_on", "based_on.spec"],
    rules: [284],
  },
  { kind: "event:tasks_amended", payload: { mode: "replace", task }, fields: ["task"], rules: [318] },
  { kind: "event:task_claimed", payload: { task_id: "T-001" }, fields: ["task_id"], rules: [354] },
  {
    kind: "event:task_step_started",
    payload: { task_id: "T-001", step: "implement" },
    fields: ["task_id", "step"],
    rules: [376],
  },
  {
    kind: "event:task_step_done",
    payload: { task_id: "T-001", step: "implement" },
    fields: ["task_id", "step"],
    rules: [425],
  },
  {
    kind: "event:task_step_reset",
    payload: { task_id: "T-001", step: "implement", finding_id: "FND-001" },
    fields: ["task_id", "step"],
    rules: [482],
  },
  {
    kind: "event:task_abandoned",
    payload: { task_id: "T-001", reason: "out of scope" },
    fields: ["task_id"],
    rules: [522],
  },
  { kind: "event:spec_submitted", payload: submitted, fields: ["spec_version"], rules: [552] },
  {
    kind: "event:spec_req_added",
    payload: { spec_version: 2, req },
    fields: ["spec_version", "req"],
    rules: [587],
  },
  {
    kind: "event:spec_scenario_added",
    payload: { spec_version: 2, scenario },
    fields: ["spec_version", "scenario"],
    rules: [615],
  },
  {
    kind: "event:spec_visual_added",
    payload: { spec_version: 2, visual },
    fields: ["spec_version", "visual"],
    rules: [640],
  },
  {
    kind: "evidence:added",
    payload: {
      id: "EV-000001",
      kind: "local-check",
      iteration: 1,
      actor: "cli:loaf",
      result: "passed",
      summary: "targeted check passed",
    },
    fields: ["id", "kind"],
    rules: [682],
  },
  {
    kind: "finding:raised",
    payload: { id: "FND-001", category: "spec-gap", action: "amend-spec" },
    fields: ["id", "category", "action"],
    rules: [724],
  },
  { kind: "finding:closed", payload: { id: "FND-001" }, fields: ["id"], rules: [746] },
  {
    kind: "pending:added",
    payload: { id: "PEND-0001", kind: "ask_user_question", question: "choose an option" },
    fields: ["id", "kind"],
    rules: [773],
  },
  { kind: "pending:resolved", payload: { id: "PEND-0001" }, fields: ["id"], rules: [785] },
];
function entry(kind: EntryKind, payload: unknown): JournalEntry {
  return {
    seq: 0,
    entry_id: "JE-000001",
    at: "2026-05-15T10:00:00.000Z",
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind,
    payload,
  };
}
function snapshot(sub_state: SubState = "EXECUTE.work"): Snapshot {
  return {
    ...initialSnapshot(),
    state: {
      session_id: "guard-test",
      feature: "admission",
      phase: sub_state.startsWith("SPEC") ? "SPEC" : "EXECUTE",
      sub_state,
      iteration: 1,
      spec_locked: false,
      verify_accepted: false,
      spec_version: 1,
      ceremony,
    },
    tasks: [
      {
        id: "T-001",
        kind: "structural",
        status: "in_progress",
        steps: { implement: { applicability: "must", status: "pending" } },
        drives: [],
        depends_on: [],
        labels: [],
      },
    ],
    findings: [
      {
        id: "FND-001",
        status: "open",
        category: "bug",
        action: "fix-impl",
        target: { task_id: "T-001", step: "implement" },
      },
    ],
  };
}

describe("reducer duplicate guards — authoritative schemas", () => {
  for (const row of schemas) {
    for (const field of row.fields) {
      test(`schema ${row.kind} rejects missing ${field} (reducer ${row.rules.join(",")})`, () => {
        const schema = PER_KIND_PAYLOAD[row.kind];
        expect(schema.safeParse(row.payload).success).toBe(true);
        const invalid = structuredClone(row.payload);
        if (field === "based_on.spec") delete (invalid.based_on as Record<string, unknown>).spec;
        else delete invalid[field];
        const result = schema.safeParse(invalid);
        expect(result.success).toBe(false);
        if (!result.success)
          expect(result.error.issues.some((issue) => issue.path.join(".") === field)).toBe(true);
      });
    }
  }
  test("schema gate:decided rejects unknown gate kind (reducer 264)", () => {
    expect(
      PER_KIND_PAYLOAD["gate:decided"].safeParse({
        gate_kind: "unknown",
        decision: "approved",
        reason: "approved",
      }).success,
    ).toBe(false);
  });
});

describe("reducer duplicate guards — authoritative preflight", () => {
  for (const kind of [
    "event:task_claimed",
    "event:task_step_started",
    "event:task_step_done",
  ] as const) {
    test(`lifecycle ${kind} rejects missing task (reducer 358/380/429)`, () => {
      const result = preflight(entry(kind, { task_id: "T-999", step: "implement" }), {
        snapshot: snapshot(),
      });
      expect(result).toMatchObject({
        ok: false,
        code: "TASK_NOT_FOUND",
        detail: { task_id: "T-999" },
      });
    });
  }
  for (const sponsored of [false, true]) {
    test(`amended replace rejects missing task sponsored=${sponsored} (reducer 335)`, () => {
      const prev = snapshot(sponsored ? "EXECUTE.work" : "EXECUTE.plan");
      prev.findings[0]!.action = "amend-tasks";
      const result = preflight(
        entry("event:tasks_amended", { mode: "replace",
          task: { ...task, id: "T-999" },
          ...(sponsored ? { sponsored_by_finding_id: "FND-001" } : {}),
        }),
        { snapshot: prev },
      );
      expect(result).toMatchObject({
        ok: false,
        code: "TASK_NOT_FOUND",
        detail: { task_id: "T-999" },
      });
    });
  }
  for (const missing of ["task", "step"]) {
    test(`reset rejects missing ${missing} (reducer 487/496)`, () => {
      const prev = snapshot();
      if (missing === "task") prev.tasks = [];
      else prev.tasks[0]!.steps = {};
      const result = preflight(
        entry("event:task_step_reset", {
          task_id: "T-001",
          step: "implement",
          finding_id: "FND-001",
        }),
        { snapshot: prev },
      );
      expect(result).toMatchObject({
        ok: false,
        code: "MUTATION_OUT_OF_RIGHTS",
        detail: { reason: "task_step_reset_target_mismatch" },
      });
    });
  }
  test("planned rejects duplicate task ids (reducer 289)", () => {
    const result = preflight(
      entry("event:tasks_planned", { based_on: { spec: 1 }, tasks: [task, task] }),
      { snapshot: snapshot("EXECUTE.plan") },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "DUPLICATE_TASK_ID",
      detail: { task_id: "T-001" },
    });
  });
  test("submitted rejects continuation position (reducer 904,560)", () => {
    const candidate = {
      ...entry("event:spec_submitted", submitted),
      batch_id: "550e8400-e29b-41d4-a716-446655440000",
      batch_index: 1,
      batch_count: 2,
    };
    expect(preflight(candidate, { snapshot: snapshot("SPEC.spec") })).toMatchObject({
      ok: false,
      code: "SPEC_VERSION_BATCH_MISMATCH",
    });
  });
  for (const [kind, payload] of [
    ["event:spec_submitted", submitted],
    ["event:spec_req_added", { spec_version: 2, req }],
    ["event:spec_scenario_added", { spec_version: 2, scenario }],
    ["event:spec_visual_added", { spec_version: 2, visual }],
  ] as const) {
    test(`version ${kind} rejects stale head (reducer 914/928,560/591/619/644)`, () => {
      expect(
        preflight(entry(kind, { ...payload, spec_version: 1 }), {
          snapshot: snapshot("SPEC.spec"),
        }),
      ).toMatchObject({ ok: false, code: "SPEC_VERSION_NOT_MONOTONIC" });
    });
    if (kind !== "event:spec_submitted") {
      test(`version ${kind} rejects mismatched continuation (reducer 928,591/619/644)`, () => {
        const candidate = {
          ...entry(kind, payload),
          batch_id: "550e8400-e29b-41d4-a716-446655440000",
          batch_index: 1,
          batch_count: 2,
        };
        expect(preflight(candidate, { snapshot: snapshot("SPEC.spec") })).toMatchObject({
          ok: false,
          code: "SPEC_VERSION_BATCH_MISMATCH",
        });
      });
    }
  }
  for (const [kind, field, content, code] of [
    ["event:spec_req_added", "req", req, "DUPLICATE_REQ_ID"],
    ["event:spec_scenario_added", "scenario", scenario, "DUPLICATE_SCEN_ID"],
    ["event:spec_visual_added", "visual", visual, "DUPLICATE_VIS_ID"],
  ] as const) {
    test(`collision ${kind} rejects existing id (reducer 594/622/647)`, () => {
      const prev = snapshot("SPEC.spec");
      if (kind === "event:spec_req_added") prev.requirements.push(req);
      if (kind === "event:spec_scenario_added") prev.scenarios.push(scenario);
      if (kind === "event:spec_visual_added") prev.visual_contracts.push(visual);
      expect(
        preflight(entry(kind, { spec_version: 2, [field]: content }), { snapshot: prev }),
      ).toMatchObject({ ok: false, code, detail: { id: content.id } });
    });
  }
});

test("reducer normalizes omitted default arrays without changing canonical steps", () => {
  const { depends_on: _deps, labels: _labels, ...rawTask } = task;
  const prev = snapshot("EXECUTE.plan");
  const result = admitEntry(
    prev,
    entry("event:tasks_planned", {
      based_on: { spec: 1 },
      tasks: [rawTask],
    }),
    { tail_seq: -1 },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  expect(JSON.stringify(result.snapshot.tasks)).toBe(
    JSON.stringify([
      {
        id: "T-001",
        kind: "structural",
        status: "pending",
        steps: { implement: step, refactor: step },
        drives: ["REQ-AUTH-001"],
        depends_on: [],
        labels: [],
        no_test_rationale: task.no_test_rationale,
      },
    ]),
  );
});
