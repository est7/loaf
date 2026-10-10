// Schema-valid journal payloads, including deliberately omitted defaults.
import type { EntryKind } from "../../src/core/journal-entry.js";

const ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};
const step = { applicability: "must", status: "pending" };
const task = {
  id: "T-001",
  kind: "chore",
  status: "pending",
  no_test_rationale: "No observable behavior changes",
  execution: { execute: step },
};
const req = {
  id: "REQ-AUTH-001",
  type: "ubiquitous",
  response: "The system shall preserve fields",
  measurable: { metric: "latency", threshold: 100 },
};
const scenario = {
  id: "SCEN-AUTH-001",
  name: "Keeps original content",
  given: ["a session"],
  when: ["an event arrives"],
  then: ["the projection updates"],
};
export const admissionPayloadFixtures: Record<EntryKind, unknown> = {
  "event:phase_advanced": { from: "EXECUTE.work", to: "EXECUTE.done" },
  "event:ceremony_set": ceremony,
  "event:tasks_planned": { based_on: { spec: 1 }, tasks: [task] },
  "event:tasks_amended": { mode: "replace", task },
  "event:task_claimed": { task_id: "T-001" },
  "event:task_step_started": { task_id: "T-001", step: "execute" },
  "event:task_step_done": { task_id: "T-001", step: "execute", result: "passed" },
  "event:task_step_reset": { task_id: "T-001", step: "execute", finding_id: "FND-001" },
  "event:task_abandoned": { task_id: "T-001", reason: "No longer needed" },
  "event:spec_submitted": {
    spec_version: 2,
    feature: { id: "F-001", name: "Probe feature" },
    intent: "Preserve current serialized projection bytes",
    adr_refs: [],
    needs_clarification: [{ id: "NC-001", question: "What is the expected result?" }],
  },
  "event:spec_req_added": { spec_version: 2, req },
  "event:spec_scenario_added": { spec_version: 2, scenario },
  "event:spec_visual_added": {
    spec_version: 2,
    visual: { id: "VIS-AUTH-001", target: "Result panel", checks: ["Display correctly"] },
  },
  "evidence:added": {
    id: "EV-000001",
    kind: "local-check",
    iteration: 1,
    actor: "cli:loaf",
    result: "passed",
    summary: "Check passed",
  },
  "lesson:recorded": {
    id: "LSN-001",
    iteration: 1,
    reason: "A reusable finding from this probe",
    summary: "Preserve the source representation",
  },
  "scope:recorded": { iteration: 1, paths: ["src/core/reducer.ts"] },
  "finding:raised": { id: "FND-001", category: "spec-gap", action: "amend-spec" },
  "finding:closed": { id: "FND-001" },
  "pending:added": {
    id: "PEND-0001",
    kind: "ask_user_question",
    question: "Which option should be selected?",
  },
  "pending:resolved": { id: "PEND-0001" },
  "gate:decided": { gate_kind: "spec-lock", decision: "approved", reason: "Approved" },
  "session:started": {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    feature: "probe",
    ceremony,
    ceremony_label: "standard",
    workspace: "default",
    loaf_version_required: "^0.9.0",
  },
  "session:resumed": {
    resumed_from_pack: {
      at: "2026-10-10T00:00:00.000Z",
      reason: "Resume this session",
      session_id: "550e8400-e29b-41d4-a716-446655440000",
    },
  },
  "session:delivered": {},
  "session:archived": { reason: "Finished" },
  "session:abandoned": { reason: "Cancelled" },
  "spike:converted": { to_feature: "F-002", reason: "Continue with implementation" },
};
