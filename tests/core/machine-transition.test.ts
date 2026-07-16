import { describe, expect, test } from "vitest";

import type { SubState } from "../../src/core/journal-entry.js";
import { MACHINE, type MachineNode } from "../../src/core/machine.js";
import { LEGAL_TRANSITIONS } from "../../src/core/reducer/transition.js";

const EXPECTED_FORWARD_GRAPH: Record<SubState, readonly SubState[]> = {
  "TRIAGE.score": ["TRIAGE.confirm"],
  "TRIAGE.confirm": ["SPEC.proposal", "EXECUTE.plan"],
  "SPEC.proposal": ["SPEC.spec"],
  "SPEC.spec": ["SPEC.plan"],
  "SPEC.plan": ["SPEC.design"],
  "SPEC.design": ["EXECUTE.plan"],
  "EXECUTE.plan": ["EXECUTE.work"],
  "EXECUTE.work": ["EXECUTE.done"],
  "EXECUTE.done": ["VERIFY.plan"],
  "VERIFY.plan": ["VERIFY.run"],
  "VERIFY.run": ["VERIFY.review", "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept"],
  "VERIFY.review": ["VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept"],
  "VERIFY.acceptance": ["VERIFY.visual", "VERIFY.accept"],
  "VERIFY.visual": ["VERIFY.accept"],
  "VERIFY.accept": ["SETTLE.reconcile"],
  "SETTLE.reconcile": ["SETTLE.lessons"],
  "SETTLE.lessons": [],
  "DONE.delivered": [],
  "DONE.archived": [],
  "DONE.abandoned": [],
};

function guardsFor(source: SubState, target: SubState): readonly string[] {
  const node: MachineNode = MACHINE[source];
  return (
    node.edges.find(
      (edge) => edge.owner_kind === "event:phase_advanced" && edge.target === target,
    )?.guards ?? []
  );
}

describe("MACHINE transition projections", () => {
  test("LEGAL_TRANSITIONS is the complete event:phase_advanced projection", () => {
    expect(LEGAL_TRANSITIONS).toEqual(EXPECTED_FORWARD_GRAPH);
  });

  test("fork and gate edges carry ordered named guard references", () => {
    expect(guardsFor("TRIAGE.confirm", "SPEC.proposal")).toEqual(["spec_phase_required"]);
    expect(guardsFor("TRIAGE.confirm", "EXECUTE.plan")).toEqual(["spec_phase_forbidden"]);
    expect(guardsFor("EXECUTE.done", "VERIFY.plan")).toEqual(["verify_phase_required"]);
    expect(guardsFor("SPEC.design", "EXECUTE.plan")).toEqual(["spec_locked_required"]);
    expect(guardsFor("VERIFY.accept", "SETTLE.reconcile")).toEqual([
      "settle_phase_required",
      "verify_accepted_required",
    ]);
  });
});
