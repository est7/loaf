import { describe, expect, test } from "vitest";
import {
  requireFindingSponsor,
  findingForClosure,
  checkFindingReset,
} from "../../src/core/intervention-policy.js";
import type { FindingState, TaskState, Snapshot } from "../../src/core/projection-types.js";
import { admitEntry } from "../../src/core/entry-admission.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import { preflight } from "../../src/core/reducer/preflight.js";
import { JournalEntry, type Ceremony } from "../../src/core/journal-entry.js";

const finding: FindingState = {
  id: "FND-002",
  category: "impl-defect",
  action: "fix-test",
  status: "open",
  target: { task_id: "T-001", step: "red" },
};
const task: TaskState = {
  id: "T-001",
  kind: "behavioral",
  status: "done",
  steps: { red: { status: "passed", applicability: "must" } },
  drives: [],
  depends_on: [],
  labels: [],
};
const payload = { finding_id: "FND-002", task_id: "T-001", step: "red" };

describe("finding sponsorship owner", () => {
  for (const expected of ["amend-tasks", ["fix-impl", "fix-test"]] as const) {
    test(`${String(expected)}: missing and closed precede action matching`, () => {
      expect(requireFindingSponsor([], finding.id, expected)).toEqual({
        ok: false,
        code: "FINDING_NOT_FOUND",
        detail: { id: finding.id, reason: "not_found" },
      });
      expect(
        requireFindingSponsor(
          [{ ...finding, action: "defer", status: "closed" }],
          finding.id,
          expected,
        ),
      ).toEqual({
        ok: false,
        code: "FINDING_NOT_FOUND",
        detail: { id: finding.id, reason: "already_closed" },
      });
      expect(
        requireFindingSponsor([{ ...finding, action: "defer" }], finding.id, expected),
      ).toEqual({
        ok: false,
        code: "FINDING_NOT_FOUND",
        detail: {
          id: finding.id,
          reason: "action_mismatch",
          expected_action: expected,
          actual_action: "defer",
        },
      });
    });
  }
  test("success preserves the original finding and its position; checked action is narrowed", () => {
    const rows = [{ ...finding, id: "FND-001" }, finding];
    const bytes = JSON.stringify(rows);
    const result = requireFindingSponsor(rows, finding.id, ["fix-impl", "fix-test"]);
    expect(result).toEqual({ ok: true, finding, index: 1 });
    if (!result.ok) throw new Error("expected sponsor");
    expect(result.finding).toBe(finding);
    const action: "fix-impl" | "fix-test" = result.finding.action;
    expect(action).toBe("fix-test");
    expect(JSON.stringify(rows)).toBe(bytes);
  });
  test("closure retains unknown versus already_closed and imposes no action restriction", () => {
    expect(findingForClosure([], finding.id)).toEqual({
      ok: false,
      code: "FINDING_NOT_FOUND",
      detail: { id: finding.id, reason: "unknown" },
    });
    expect(findingForClosure([{ ...finding, status: "closed" }], finding.id)).toEqual({
      ok: false,
      code: "FINDING_NOT_FOUND",
      detail: { id: finding.id, reason: "already_closed" },
    });
    const deferred = { ...finding, action: "backlog" };
    expect(findingForClosure([deferred], finding.id)).toEqual({
      ok: true,
      finding: deferred,
      index: 0,
    });
  });
  test("reset checks canonical step before target and abandoned status", () => {
    expect(
      checkFindingReset(
        { ...payload, step: "implement" },
        { findings: [finding], tasks: [{ ...task, status: "abandoned" }] },
        "EXECUTE.work",
      ),
    ).toEqual({
      ok: false,
      code: "MUTATION_OUT_OF_RIGHTS",
      detail: {
        finding_id: finding.id,
        sub_state: "EXECUTE.work",
        task_id: task.id,
        step: "implement",
        expected_step: "red",
        reason: "task_step_reset_step_mismatch",
      },
    });
  });
  test("reset missing target reports exact expected/actual fields before missing task", () => {
    const untargeted: FindingState = {
      id: finding.id,
      category: finding.category,
      action: finding.action,
      status: finding.status,
    };
    expect(
      checkFindingReset(payload, { findings: [untargeted], tasks: [] }, "EXECUTE.work"),
    ).toEqual({
      ok: false,
      code: "MUTATION_OUT_OF_RIGHTS",
      detail: {
        finding_id: finding.id,
        sub_state: "EXECUTE.work",
        task_id: task.id,
        expected_target: null,
        actual_target: { task_id: task.id, step: "red" },
        reason: "task_step_reset_target_mismatch",
      },
    });
  });
  test("reset missing task and abandoned task retain their distinct details; done task may reopen", () => {
    expect(checkFindingReset(payload, { findings: [finding], tasks: [] }, "EXECUTE.work")).toEqual({
      ok: false,
      code: "MUTATION_OUT_OF_RIGHTS",
      detail: {
        finding_id: finding.id,
        sub_state: "EXECUTE.work",
        task_id: task.id,
        step: "red",
        reason: "task_step_reset_target_mismatch",
      },
    });
    expect(
      checkFindingReset(
        payload,
        { findings: [finding], tasks: [{ ...task, status: "abandoned" }] },
        "EXECUTE.work",
      ),
    ).toEqual({
      ok: false,
      code: "MUTATION_OUT_OF_RIGHTS",
      detail: {
        finding_id: finding.id,
        sub_state: "EXECUTE.work",
        task_id: task.id,
        status: "abandoned",
        reason: "task_step_reset_task_abandoned",
      },
    });
    expect(
      checkFindingReset(payload, { findings: [finding], tasks: [task] }, "EXECUTE.work"),
    ).toBeNull();
  });
  test("closure errors remain reducer-stage after successful preflight and do not mutate snapshot", () => {
    const ceremony: Ceremony = {
      spec_phase: true,
      verify_phase: true,
      settle_phase: false,
      strict_spec_review: false,
      lessons_required: "skip",
      strict_drift_check: false,
    };
    for (const findings of [[], [{ ...finding, status: "closed" as const }]]) {
      const snapshot: Snapshot = {
        ...initialSnapshot(),
        state: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "witness",
          phase: "EXECUTE",
          sub_state: "EXECUTE.work",
          iteration: 1,
          spec_locked: true,
          verify_accepted: false,
          spec_version: 1,
          ceremony,
        },
        findings,
      };
      const entry = JournalEntry.parse({
        seq: 0,
        entry_id: "JE-000001",
        at: "2026-05-28T11:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "finding:closed",
        payload: { id: finding.id },
      });
      const bytes = JSON.stringify(snapshot);
      expect(preflight(entry, { snapshot }).ok).toBe(true);
      expect(admitEntry(snapshot, entry)).toEqual({
        ok: false,
        stage: "reducer",
        code: "FINDING_NOT_FOUND",
        detail: { id: finding.id, reason: findings.length === 0 ? "unknown" : "already_closed" },
      });
      expect(JSON.stringify(snapshot)).toBe(bytes);
    }
  });
});
