// L9 — named atomic batch builders: ordering + per-entry actor + branch
// coverage. These pure builders encode the CLI co-emission SHAPE for the two
// command intents whose batch construction is a protocol decision. Tests assert
// exact kind sequence, exact actor per entry, and every co-emission branch.

import { describe, expect, test } from "vitest";

import { buildFindingRaiseBatch, buildGateApprovalBatch } from "../../src/cli/batch-builders.js";

const HUMAN = "human:alice@example.com";
const CLI = "cli:loaf@alice";

describe("buildGateApprovalBatch — approval co-emission ordering + actor split", () => {
  test("spec-lock, no pending head → [gate:decided(human), phase_advanced(cli)]", () => {
    const b = buildGateApprovalBatch({
      gate: "spec-lock", reason: "looks good", humanActor: HUMAN, cliActor: CLI, from: "SPEC.design",
    });
    expect(b.map((e) => e.kind)).toEqual(["gate:decided", "event:phase_advanced"]);
    expect(b.map((e) => e.actor)).toEqual([HUMAN, CLI]);
    expect(b[0]!.payload).toEqual({ gate_kind: "spec-lock", decision: "approved", reason: "looks good" });
    expect(b[1]!.payload).toEqual({ from: "SPEC.design", to: "EXECUTE.plan" });
  });

  test("spec-lock, pending head → pending:resolved(cli) BETWEEN decision and advance", () => {
    const b = buildGateApprovalBatch({
      gate: "spec-lock", reason: "ok", humanActor: HUMAN, cliActor: CLI, from: "SPEC.design", pendingHeadId: "PEND-0001",
    });
    expect(b.map((e) => e.kind)).toEqual(["gate:decided", "pending:resolved", "event:phase_advanced"]);
    expect(b.map((e) => e.actor)).toEqual([HUMAN, CLI, CLI]);
    expect(b[1]!.payload).toEqual({ id: "PEND-0001", answer: "gate-decide:spec-lock:approved" });
  });

  test("verify-accept, no pending head → [gate:decided(human)] only, NEVER phase_advanced", () => {
    const b = buildGateApprovalBatch({
      gate: "verify-accept", reason: "accept", humanActor: HUMAN, cliActor: CLI,
    });
    expect(b.map((e) => e.kind)).toEqual(["gate:decided"]);
    expect(b.map((e) => e.kind)).not.toContain("event:phase_advanced");
    expect(b[0]!.actor).toBe(HUMAN);
    expect(b[0]!.payload).toEqual({ gate_kind: "verify-accept", decision: "approved", reason: "accept" });
  });

  test("verify-accept, pending head → [gate:decided(human), pending:resolved(cli)], still NO phase_advanced", () => {
    const b = buildGateApprovalBatch({
      gate: "verify-accept", reason: "accept", humanActor: HUMAN, cliActor: CLI, pendingHeadId: "PEND-0002",
    });
    expect(b.map((e) => e.kind)).toEqual(["gate:decided", "pending:resolved"]);
    expect(b.map((e) => e.kind)).not.toContain("event:phase_advanced");
    expect(b[1]!.actor).toBe(CLI);
    expect(b[1]!.payload).toEqual({ id: "PEND-0002", answer: "gate-decide:verify-accept:approved" });
  });
});

describe("buildFindingRaiseBatch — action→batch mapping + actor split", () => {
  const base = {
    findingPayload: { id: "FND-001", category: "bug" },
    findingId: "FND-001",
    currentSubState: "EXECUTE.work" as const,
    findingActor: CLI,
  };

  test("fix-impl WITH target → 3-entry reset (→ EXECUTE.work); siblings literal cli:loaf", () => {
    // No `step` in the input target — the reset step is map-derived from the
    // action (FIX_RESET_STEP["fix-impl"] = "implement"), so asserting the output
    // step proves it comes from the action, not echoed from caller input.
    const r = buildFindingRaiseBatch({ ...base, action: "fix-impl", target: { taskId: "T-001" } });
    expect(r.kind).toBe("fix-reset");
    if (r.kind !== "fix-reset") return;
    expect(r.backEdgeTo).toBe("EXECUTE.work");
    expect(r.entries.map((e) => e.kind)).toEqual(["finding:raised", "event:task_step_reset", "event:phase_advanced"]);
    expect(r.entries.map((e) => e.actor)).toEqual([CLI, "cli:loaf", "cli:loaf"]);
    expect(r.entries[1]!.payload).toEqual({ task_id: "T-001", step: "implement", finding_id: "FND-001" });
  });

  test("fix-test WITH target → reset step 'red'", () => {
    const r = buildFindingRaiseBatch({ ...base, action: "fix-test", target: { taskId: "T-002" } });
    expect(r.kind).toBe("fix-reset");
    if (r.kind !== "fix-reset") return;
    expect((r.entries[1]!.payload as { step: string }).step).toBe("red");
  });

  test("fix-impl WITHOUT target → 'none' (lone path; preflight stays authoritative)", () => {
    expect(buildFindingRaiseBatch({ ...base, action: "fix-impl" })).toEqual({ kind: "none" });
  });

  test("amend-spec → 2-entry back-edge to SPEC.spec", () => {
    const r = buildFindingRaiseBatch({ ...base, action: "amend-spec" });
    expect(r.kind).toBe("back-edge");
    if (r.kind !== "back-edge") return;
    expect(r.backEdgeTo).toBe("SPEC.spec");
    expect(r.entries.map((e) => e.kind)).toEqual(["finding:raised", "event:phase_advanced"]);
    expect(r.entries.map((e) => e.actor)).toEqual([CLI, "cli:loaf"]);
  });

  test("amend-tasks → 2-entry back-edge to EXECUTE.work", () => {
    const r = buildFindingRaiseBatch({ ...base, action: "amend-tasks" });
    expect(r.kind).toBe("back-edge");
    if (r.kind !== "back-edge") return;
    expect(r.backEdgeTo).toBe("EXECUTE.work");
  });

  test("unknown action → 'none'", () => {
    expect(buildFindingRaiseBatch({ ...base, action: "observe" })).toEqual({ kind: "none" });
  });
});
