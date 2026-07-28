import { describe, expect, test } from "vitest";

import type { Ceremony, SubState } from "../../src/core/journal-entry.js";
import {
  nextLegalTargets,
  type TransitionContext,
  type TransitionResult,
  validateTransition,
} from "../../src/core/reducer/transition.js";

const QUICK: Ceremony = {
  spec_phase: false,
  verify_phase: false,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

const LIGHT: Ceremony = {
  ...QUICK,
  spec_phase: true,
};

const STANDARD: Ceremony = {
  ...LIGHT,
  verify_phase: true,
};

const DEEP: Ceremony = {
  ...STANDARD,
  settle_phase: true,
  strict_spec_review: true,
  lessons_required: "must",
  strict_drift_check: true,
};

const ACTOR = "cli:loaf";

type TransitionFailure = Extract<TransitionResult, { ok: false }>;

function expectFailure(
  actual: TransitionResult,
  expected: TransitionFailure,
  detailKeys: readonly string[],
): void {
  expect(actual).toEqual(expected);
  expect(actual.ok).toBe(false);
  if (!actual.ok) {
    expect(Object.keys(actual.detail ?? {})).toEqual(detailKeys);
  }
}

const AMEND_SPEC_FROM = [
  "EXECUTE.plan",
  "EXECUTE.work",
  "EXECUTE.done",
  "VERIFY.plan",
  "VERIFY.run",
  "VERIFY.review",
  "VERIFY.acceptance",
  "VERIFY.visual",
  "VERIFY.accept",
] as const satisfies readonly SubState[];

const EXECUTE_AND_VERIFY_FROM = [
  "EXECUTE.work",
  "EXECUTE.done",
  "VERIFY.plan",
  "VERIFY.run",
  "VERIFY.review",
  "VERIFY.acceptance",
  "VERIFY.visual",
  "VERIFY.accept",
] as const satisfies readonly SubState[];

const BACK_EDGE_CASES = [
  {
    action: "amend-spec",
    expectedTarget: "SPEC.spec",
    mismatchTarget: "EXECUTE.work",
    disallowedFrom: "SPEC.proposal",
    allowedFrom: AMEND_SPEC_FROM,
    allowedFromLabel: "EXECUTE.* + VERIFY.*",
  },
  {
    action: "amend-tasks",
    expectedTarget: "EXECUTE.work",
    mismatchTarget: "SPEC.spec",
    disallowedFrom: "EXECUTE.plan",
    allowedFrom: EXECUTE_AND_VERIFY_FROM,
    allowedFromLabel: "EXECUTE.work / EXECUTE.done + VERIFY.*",
  },
  {
    action: "fix-impl",
    expectedTarget: "EXECUTE.work",
    mismatchTarget: "SPEC.spec",
    disallowedFrom: "EXECUTE.plan",
    allowedFrom: EXECUTE_AND_VERIFY_FROM,
    allowedFromLabel: "EXECUTE.work / EXECUTE.done + VERIFY.*",
  },
  {
    action: "fix-test",
    expectedTarget: "EXECUTE.work",
    mismatchTarget: "SPEC.spec",
    disallowedFrom: "EXECUTE.plan",
    allowedFrom: EXECUTE_AND_VERIFY_FROM,
    allowedFromLabel: "EXECUTE.work / EXECUTE.done + VERIFY.*",
  },
] as const;

describe("validateTransition characterization — back-edge error surface", () => {
  test.each(BACK_EDGE_CASES)("$action target mismatch is byte-stable", (row) => {
    const result = validateTransition("VERIFY.run", row.mismatchTarget, {
      ceremony: STANDARD,
      actor: ACTOR,
      back_edge: { action: row.action, finding_id: "FND-001" },
    });

    expectFailure(
      result,
      {
        ok: false,
        code: "TRANSITION_ILLEGAL",
        message: `back_edge action=${row.action} requires target=${row.expectedTarget}, got ${row.mismatchTarget}`,
        detail: {
          from: "VERIFY.run",
          to: row.mismatchTarget,
          back_edge_action: row.action,
          expected_target: row.expectedTarget,
          reason: "back_edge_target_mismatch",
        },
      },
      ["from", "to", "back_edge_action", "expected_target", "reason"],
    );
  });

  test.each(BACK_EDGE_CASES)("$action disallowed source is byte-stable", (row) => {
    const result = validateTransition(row.disallowedFrom, row.expectedTarget, {
      ceremony: STANDARD,
      actor: ACTOR,
      back_edge: { action: row.action, finding_id: "FND-001" },
    });

    expectFailure(
      result,
      {
        ok: false,
        code: "TRANSITION_ILLEGAL",
        message: `back_edge action=${row.action} is not legal from ${row.disallowedFrom}; allowed from ${row.allowedFromLabel}`,
        detail: {
          from: row.disallowedFrom,
          to: row.expectedTarget,
          back_edge_action: row.action,
          allowed_from: [...row.allowedFrom],
          reason: "back_edge_from_not_allowed",
        },
      },
      ["from", "to", "back_edge_action", "allowed_from", "reason"],
    );
  });

  test("unknown action fallback is byte-stable", () => {
    const backEdge = {
      action: "future-action",
      finding_id: "FND-001",
    } as unknown as NonNullable<TransitionContext["back_edge"]>;
    const result = validateTransition("VERIFY.run", "EXECUTE.work", {
      ceremony: STANDARD,
      actor: ACTOR,
      back_edge: backEdge,
    });

    expectFailure(
      result,
      {
        ok: false,
        code: "TRANSITION_ILLEGAL",
        message: "unknown back_edge.action future-action",
        detail: {
          back_edge: backEdge,
          reason: "back_edge_action_unknown",
        },
      },
      ["back_edge", "reason"],
    );
  });
});

describe("validateTransition characterization — forward and guard error surface", () => {
  test("illegal edge exposes the full allowed-forward surface", () => {
    const result = validateTransition("TRIAGE.score", "SPEC.proposal", {
      ceremony: STANDARD,
      actor: ACTOR,
    });

    expectFailure(
      result,
      {
        ok: false,
        code: "TRANSITION_ILLEGAL",
        message: "cannot transition TRIAGE.score → SPEC.proposal",
        detail: {
          from: "TRIAGE.score",
          to: "SPEC.proposal",
          allowed_forward: ["TRIAGE.confirm"],
        },
      },
      ["from", "to", "allowed_forward"],
    );
  });

  test("forward legality wins before a source-state guard", () => {
    const result = validateTransition("SPEC.design", "DONE.delivered", {
      ceremony: STANDARD,
      actor: ACTOR,
      spec_locked: false,
    });

    expectFailure(
      result,
      {
        ok: false,
        code: "TRANSITION_ILLEGAL",
        message: "cannot transition SPEC.design → DONE.delivered",
        detail: {
          from: "SPEC.design",
          to: "DONE.delivered",
          allowed_forward: ["EXECUTE.plan"],
        },
      },
      ["from", "to", "allowed_forward"],
    );
  });

  test("plain EXECUTE.work self-loop requires a sponsored back-edge", () => {
    const result = validateTransition("EXECUTE.work", "EXECUTE.work", {
      ceremony: STANDARD,
      actor: ACTOR,
    });

    expectFailure(
      result,
      {
        ok: false,
        code: "TRANSITION_ILLEGAL",
        message: "cannot transition EXECUTE.work → EXECUTE.work",
        detail: {
          from: "EXECUTE.work",
          to: "EXECUTE.work",
          allowed_forward: ["EXECUTE.done"],
        },
      },
      ["from", "to", "allowed_forward"],
    );
  });

  test.each([QUICK, LIGHT, STANDARD, DEEP])(
    "nextLegalTargets exposes only EXECUTE.done from EXECUTE.work",
    (ceremony) => {
      expect(nextLegalTargets("EXECUTE.work", ceremony)).toEqual(["EXECUTE.done"]);
    },
  );

  test("spec-phase-required error is byte-stable", () => {
    const result = validateTransition("TRIAGE.confirm", "SPEC.proposal", {
      ceremony: QUICK,
      actor: ACTOR,
    });

    expectFailure(
      result,
      {
        ok: false,
        code: "SPEC_PHASE_FORK_VIOLATION",
        message: "TRIAGE.confirm → SPEC.proposal requires ceremony.spec_phase=true",
        detail: { from: "TRIAGE.confirm", to: "SPEC.proposal", spec_phase: false },
      },
      ["from", "to", "spec_phase"],
    );
  });

  test("spec-phase-forbidden error is byte-stable", () => {
    const result = validateTransition("TRIAGE.confirm", "EXECUTE.plan", {
      ceremony: STANDARD,
      actor: ACTOR,
    });

    expectFailure(
      result,
      {
        ok: false,
        code: "SPEC_PHASE_FORK_VIOLATION",
        message:
          "TRIAGE.confirm → EXECUTE.plan requires ceremony.spec_phase=false (quick); profiles with spec_phase=true must traverse SPEC.*",
        detail: { from: "TRIAGE.confirm", to: "EXECUTE.plan", spec_phase: true },
      },
      ["from", "to", "spec_phase"],
    );
  });

  test("verify-phase-required error is byte-stable", () => {
    const result = validateTransition("EXECUTE.done", "VERIFY.plan", {
      ceremony: LIGHT,
      actor: ACTOR,
    });

    expectFailure(
      result,
      {
        ok: false,
        code: "VERIFY_PHASE_FORK_VIOLATION",
        message: "EXECUTE.done → VERIFY.plan requires ceremony.verify_phase=true (standard / deep)",
        detail: { from: "EXECUTE.done", to: "VERIFY.plan", verify_phase: false },
      },
      ["from", "to", "verify_phase"],
    );
  });

  test("spec-lock-required error is byte-stable", () => {
    const result = validateTransition("SPEC.design", "EXECUTE.plan", {
      ceremony: STANDARD,
      actor: ACTOR,
    });

    expectFailure(
      result,
      {
        ok: false,
        code: "SPEC_LOCK_NOT_SATISFIED",
        message:
          "SPEC.design → EXECUTE.plan requires spec_locked=true (run `loaf gate decide spec-lock --approve` first)",
        detail: { from: "SPEC.design", to: "EXECUTE.plan", spec_locked: false },
      },
      ["from", "to", "spec_locked"],
    );
  });

  test("settle-phase error wins before verify-accepted and is byte-stable", () => {
    const result = validateTransition("VERIFY.accept", "SETTLE.lessons", {
      ceremony: STANDARD,
      actor: ACTOR,
      verify_accepted: false,
    });

    expectFailure(
      result,
      {
        ok: false,
        code: "SETTLE_PHASE_DISABLED",
        message:
          "VERIFY.accept → SETTLE.lessons requires ceremony.settle_phase=true (deep only)",
        detail: { from: "VERIFY.accept", to: "SETTLE.lessons", settle_phase: false },
      },
      ["from", "to", "settle_phase"],
    );
  });

  test("verify-accepted-required error is byte-stable", () => {
    const result = validateTransition("VERIFY.accept", "SETTLE.lessons", {
      ceremony: DEEP,
      actor: ACTOR,
      verify_accepted: false,
    });

    expectFailure(
      result,
      {
        ok: false,
        code: "SETTLE_NOT_ACCEPTED",
        message:
          "VERIFY.accept → SETTLE.lessons requires verify_accepted=true (run `loaf gate decide verify-accept --approve` first)",
        detail: { from: "VERIFY.accept", to: "SETTLE.lessons", verify_accepted: false },
      },
      ["from", "to", "verify_accepted"],
    );
  });

  test.each([QUICK, LIGHT, STANDARD, DEEP])(
    "nextLegalTargets keeps SPEC.design blocked without spec_locked",
    (ceremony) => {
      expect(nextLegalTargets("SPEC.design", ceremony)).toEqual([]);
    },
  );
});
