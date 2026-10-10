import { FindingCategory, FindingAction } from "../../src/core/finding-schema.js";
import { describe, expect, test } from "vitest";
import {
  cellRisk,
  FINDING_ACTION_TARGET_MODE,
  FIX_ACTION_STEP,
  FINDING_UNUSUAL_REASON_MIN_LENGTH,
  isFindingDeferralAction,
  findingActionEffect,
} from "../../src/core/intervention-policy.js";

// Literal protocol witnesses, independent of the implementation's tables.
const categories = [
  "spec-gap",
  "spec-defect",
  "impl-defect",
  "test-defect",
  "new-scope",
  "risk-escalation",
] as const;
const actions = ["amend-spec", "amend-tasks", "fix-impl", "fix-test", "defer", "backlog"] as const;
const riskRows = [
  ["typical", "unusual", "incoherent", "incoherent", "typical", "typical"],
  ["typical", "unusual", "unusual", "unusual", "typical", "typical"],
  ["unusual", "typical", "typical", "unusual", "typical", "typical"],
  ["unusual", "typical", "unusual", "typical", "typical", "typical"],
  ["typical", "typical", "incoherent", "incoherent", "typical", "typical"],
  ["unusual", "typical", "unusual", "unusual", "typical", "typical"],
];

describe("finding action policy characterization", () => {
  test("schema vocabulary retains literal order", () => {
    expect(FindingCategory.options).toEqual(categories);
    expect(FindingAction.options).toEqual(actions);
  });
  for (const [index, category] of categories.entries()) {
    test(`${category} retains all six risk cells`, () => {
      expect(actions.map((action) => cellRisk(category, action))).toEqual(riskRows[index]);
    });
  }
  test("target requirements, reset steps and reason threshold remain literal", () => {
    expect(FINDING_ACTION_TARGET_MODE).toEqual({
      "amend-spec": "none",
      "amend-tasks": "task_id_optional",
      "fix-impl": "task_id_step",
      "fix-test": "task_id_step",
      defer: "none",
      backlog: "none",
    });
    expect(FIX_ACTION_STEP).toEqual({ "fix-impl": "implement", "fix-test": "red" });
    expect(FINDING_UNUSUAL_REASON_MIN_LENGTH).toBe(20);
  });
  test("mechanical action effects keep literal targets and canonical reset steps", () => {
    expect(findingActionEffect("amend-spec")).toEqual({ kind: "back-edge", target: "SPEC.spec" });
    expect(findingActionEffect("amend-tasks")).toEqual({
      kind: "back-edge",
      target: "EXECUTE.work",
    });
    expect(findingActionEffect("fix-impl")).toEqual({
      kind: "fix-reset",
      target: "EXECUTE.work",
      step: "implement",
    });
    expect(findingActionEffect("fix-test")).toEqual({
      kind: "fix-reset",
      target: "EXECUTE.work",
      step: "red",
    });
    for (const action of ["defer", "backlog", "future-action"])
      expect(findingActionEffect(action)).toEqual({ kind: "none" });
  });
  test("only defer/backlog dispositions are non-blocking; loose historical strings remain blocking", () => {
    expect(actions.filter(isFindingDeferralAction)).toEqual(["defer", "backlog"]);
    for (const action of ["", "future-action", "deferred", "constructor", "__proto__"])
      expect(isFindingDeferralAction(action)).toBe(false);
  });
});
