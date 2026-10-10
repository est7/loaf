import { describe, expect, it } from "vitest";
import { validateTransition } from "../../src/core/reducer/transition.js";
import { checkTaskGraph } from "../../src/core/task-graph.js";

describe("core diagnostic records", () => {
  it("preserves forward rejection data without producer prose", () => {
    expect(
      validateTransition("TRIAGE.score", "EXECUTE.done", {
        actor: "cli:loaf",
        ceremony: {
          spec_phase: true,
          verify_phase: true,
          settle_phase: false,
          strict_spec_review: false,
          lessons_required: "may",
          strict_drift_check: false,
        },
      }),
    ).toEqual({
      ok: false,
      code: "TRANSITION_ILLEGAL",
      detail: { from: "TRIAGE.score", to: "EXECUTE.done", allowed_forward: ["TRIAGE.confirm"] },
    });
  });
  it("preserves dependency field values without producer prose", () => {
    expect(checkTaskGraph([{ id: "T-1", status: "pending", depends_on: ["T-2"] }])).toEqual({
      code: "TASK_DEP_NOT_FOUND",
      detail: { task_id: "T-1", field: "depends_on[0]", ref: "T-2" },
    });
  });
});
