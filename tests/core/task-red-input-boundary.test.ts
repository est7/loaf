import { describe, expect, test } from "vitest";
import { preflight } from "../../src/core/reducer/preflight.js";
import { initialSnapshot, type Snapshot } from "../../src/core/reducer.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";

const step = { applicability: "must", status: "pending" };
const taskCases = [
  { kind: "structural", execution: { implement: step, refactor: step } },
  {
    kind: "visual-ui",
    execution: { mockup: step, implement: step, "screenshot-compare": step },
    visual_contract_refs: ["VIS-AUTH-001"],
  },
  { kind: "docs", execution: { draft: step, review: step } },
  { kind: "spike", execution: { explore: step, prototype: step, record: step } },
  { kind: "chore", execution: { execute: step } },
];
function context(amended: boolean): Snapshot {
  return {
    ...initialSnapshot(),
    state: {
      session_id: "probe",
      feature: "probe",
      phase: amended ? "EXECUTE" : "SPEC",
      sub_state: amended ? "EXECUTE.work" : "SPEC.design",
      iteration: 1,
      spec_locked: amended,
      verify_accepted: false,
      spec_version: 1,
      ceremony: {
        spec_phase: true,
        verify_phase: true,
        settle_phase: false,
        strict_spec_review: false,
        lessons_required: "skip",
        strict_drift_check: false,
      },
    },
    findings: [{ id: "FND-001", category: "new-scope", action: "amend-tasks", status: "open" }],
  };
}
function entry(amended: boolean, task: unknown): JournalEntry {
  return {
    seq: 0,
    entry_id: "JE-000001",
    at: "2026-10-10T00:00:00.000Z",
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind: amended ? "event:tasks_amended" : "event:tasks_planned",
    payload: amended
      ? { mode: "add", task, sponsored_by_finding_id: "FND-001" }
      : { based_on: { spec: 1 }, tasks: [task] },
  };
}

describe("task RED input boundary", () => {
  for (const amended of [false, true]) {
    for (const task of taskCases) {
      for (const flag of [true, false, undefined]) {
        const contract = amended ? "deliberate amended tightening" : "preserved planned predicate";
        test(`${contract}: ${task.kind} red_test_registered=${String(flag)}`, () => {
          const result = preflight(
            entry(amended, {
              id: "T-001",
              status: "pending",
              no_test_rationale: "No observable behavior changes",
              ...task,
              red_test_registered: flag,
            }),
            { snapshot: context(amended) },
          );
          if (flag === true) {
            expect(result).toMatchObject({
              ok: false,
              code: "BUG_TASK_FLAG_MISUSE",
              detail: { task_id: "T-001" },
            });
          } else {
            expect(result.ok, JSON.stringify(result)).toBe(true);
          }
        });
      }
    }
  }
  for (const amended of [false, true]) {
    for (const flag of [true, false]) {
      test(`behavioral ${amended ? "amended freshness" : "planned creation"} semantics unchanged (flag=${flag})`, () => {
        const result = preflight(
          entry(amended, {
            id: "T-001",
            kind: "behavioral",
            status: "pending",
            drives: ["REQ-AUTH-001"],
            tests: ["UnitTest.run"],
            labels: [],
            depends_on: [],
            execution: { red: step, implement: step, refactor: step },
            red_test_registered: flag,
          }),
          { snapshot: context(amended) },
        );
        if (flag) {
          expect(result).toMatchObject({
            ok: false,
            code: amended ? "MUTATION_OUT_OF_RIGHTS" : "BUG_TASK_FLAG_MISUSE",
          });
        } else {
          expect(result.ok, JSON.stringify(result)).toBe(true);
        }
      });
    }
  }
});
