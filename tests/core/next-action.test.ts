// Unit coverage for src/core/next-action.ts `buildNextOutput`.
//
// The CLI integration tests (cli.test.ts "loaf next" block) prove the
// public command surface, pending precedence, and round-trip acceptance.
// This file isolates the pure routing kernel — specifically the VERIFY
// lane-selection path (`verifyNextTarget` × `transitionOwnerFor` ×
// `nextLegalTargets`), which the CLI tests do not construct because they
// only seed VERIFY.accept (audit Coverage Gap: VERIFY lane skip behavior
// had no test). Driving `buildNextOutput` directly lets us pin every
// (cursor × applicable-lane-set) combination deterministically without
// frontmatter fixtures.

import { describe, expect, test } from "vitest";
import type { Ceremony, SubState } from "../../src/core/journal-entry.js";
import type { VerifyCheckKind } from "../../src/core/evidence-schema.js";
import type { PendingQueueEntry } from "../../src/core/projection-schema.js";
import { buildNextOutput, type BuildNextOutputInput } from "../../src/core/next-action.js";

const STANDARD: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

const DEEP: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: true,
  strict_spec_review: false,
  lessons_required: "must",
  strict_drift_check: false,
};

const QUICK: Ceremony = {
  spec_phase: false,
  verify_phase: false,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

const ALL_LANES: ReadonlySet<VerifyCheckKind> = new Set(["run", "review", "acceptance", "visual"]);

function makePending(kind: PendingQueueEntry["kind"]): PendingQueueEntry {
  return {
    pending_id: "PEND-0001",
    kind,
    question: "fixture pending prompt",
    blocks: "all",
    raised_at: "2026-05-15T11:00:00.000Z",
    raised_by: "human:tester@example.invalid",
    at: "2026-05-15T11:00:00.000Z",
  };
}

function run(
  sub_state: SubState,
  overrides: Partial<BuildNextOutputInput> = {},
): ReturnType<typeof buildNextOutput> {
  return buildNextOutput({
    feature: "auth-refresh",
    feature_dir: "/tmp/fixture",
    phase: sub_state.split(".")[0]!,
    sub_state,
    ceremony: STANDARD,
    spec_locked: false,
    verify_accepted: false,
    pending: [],
    ...overrides,
  });
}

describe("buildNextOutput — VERIFY lane routing", () => {
  test("VERIFY.plan always advances to VERIFY.run regardless of applicable lanes", () => {
    // The graph forces VERIFY.plan → VERIFY.run; a non-run-only lane set
    // must NOT skip the mandatory run entry.
    for (const lanes of [
      ALL_LANES,
      new Set<VerifyCheckKind>(["visual"]),
      new Set<VerifyCheckKind>(),
    ]) {
      const out = run("VERIFY.plan", { verify_applicable_lanes: lanes });
      expect(out.next_action).toMatchObject({
        owner_verb: "advance",
        target: "VERIFY.run",
        blocking: false,
      });
    }
  });

  test("VERIFY.run with all lanes advances to the next ordered lane (review)", () => {
    const out = run("VERIFY.run", { verify_applicable_lanes: ALL_LANES });
    expect(out.next_action).toMatchObject({ owner_verb: "advance", target: "VERIFY.review" });
  });

  test("VERIFY.run skips non-applicable lanes to the first applicable one", () => {
    expect(
      run("VERIFY.run", { verify_applicable_lanes: new Set(["acceptance"]) }).next_action,
    ).toMatchObject({ target: "VERIFY.acceptance" });
    expect(
      run("VERIFY.run", { verify_applicable_lanes: new Set(["visual"]) }).next_action,
    ).toMatchObject({ target: "VERIFY.visual" });
  });

  test("VERIFY.run with no applicable downstream lane advances straight to VERIFY.accept", () => {
    const out = run("VERIFY.run", { verify_applicable_lanes: new Set() });
    expect(out.next_action).toMatchObject({ owner_verb: "advance", target: "VERIFY.accept" });
  });

  test("VERIFY.review and VERIFY.acceptance skip forward to the next applicable lane", () => {
    expect(
      run("VERIFY.review", { verify_applicable_lanes: new Set(["visual"]) }).next_action,
    ).toMatchObject({ target: "VERIFY.visual" });
    expect(run("VERIFY.review", { verify_applicable_lanes: ALL_LANES }).next_action).toMatchObject({
      target: "VERIFY.acceptance",
    });
    expect(
      run("VERIFY.acceptance", { verify_applicable_lanes: new Set(["visual"]) }).next_action,
    ).toMatchObject({ target: "VERIFY.visual" });
    expect(
      run("VERIFY.acceptance", { verify_applicable_lanes: new Set() }).next_action,
    ).toMatchObject({ target: "VERIFY.accept" });
  });

  test("VERIFY.visual always advances to VERIFY.accept", () => {
    expect(run("VERIFY.visual", { verify_applicable_lanes: new Set() }).next_action).toMatchObject({
      owner_verb: "advance",
      target: "VERIFY.accept",
    });
  });

  test("lane order is independent of applicable-Set insertion order (deterministic)", () => {
    const a = run("VERIFY.run", { verify_applicable_lanes: new Set(["visual", "acceptance"]) });
    const b = run("VERIFY.run", { verify_applicable_lanes: new Set(["acceptance", "visual"]) });
    // VERIFY_ORDER is fixed: acceptance precedes visual, so both pick acceptance.
    expect(a.next_action?.target).toBe("VERIFY.acceptance");
    expect(b.next_action?.target).toBe("VERIFY.acceptance");
  });

  test("undefined applicable-lane set defaults to all lanes applicable", () => {
    const out = run("VERIFY.run", { verify_applicable_lanes: undefined });
    expect(out.next_action).toMatchObject({ target: "VERIFY.review" });
  });
});

describe("buildNextOutput — VERIFY.accept gate / settle / deliver fork", () => {
  test("VERIFY.accept without verify_accepted blocks on the verify-accept gate", () => {
    const out = run("VERIFY.accept", { verify_accepted: false });
    expect(out.blocked).toBe(true);
    expect(out.next_action).toMatchObject({
      owner_verb: "gate decide",
      target: "verify-accept",
      blocking: true,
    });
  });

  test("VERIFY.accept accepted under standard ceremony recommends deliver", () => {
    const out = run("VERIFY.accept", { verify_accepted: true, ceremony: STANDARD });
    expect(out.next_action).toMatchObject({
      owner_verb: "deliver",
      target: "DONE.delivered",
      blocking: false,
    });
  });

  test("VERIFY.accept accepted under deep ceremony recommends settle", () => {
    const out = run("VERIFY.accept", { verify_accepted: true, ceremony: DEEP });
    expect(out.next_action).toMatchObject({
      owner_verb: "settle",
      target: "SETTLE.reconcile",
      blocking: false,
    });
  });
});

describe("buildNextOutput — pending precedence and forks", () => {
  test("ask_user_question head recommends the FIFO pending-resolve command (no positional id)", () => {
    const out = run("SPEC.design", { pending: [makePending("ask_user_question")] });
    expect(out.blocked).toBe(true);
    expect(out.next_action).toMatchObject({
      command: 'loaf pending resolve --answer "<answer>"',
      owner_verb: "pending resolve",
      target: "ask_user_question",
    });
  });

  test("gate_decision head at SPEC.design maps to the spec-lock gate", () => {
    const out = run("SPEC.design", { pending: [makePending("gate_decision")] });
    expect(out.next_action).toMatchObject({ owner_verb: "gate decide", target: "spec-lock" });
  });

  test("gate_decision head off a gate cursor falls back to pending resolve", () => {
    const out = run("EXECUTE.work", { pending: [makePending("gate_decision")] });
    expect(out.next_action).toMatchObject({
      owner_verb: "pending resolve",
      target: "gate_decision",
    });
  });

  test("profile_escalation head recommends profile escalate", () => {
    const out = run("SPEC.design", { pending: [makePending("profile_escalation")] });
    expect(out.next_action).toMatchObject({
      command: "loaf profile escalate --confirm --input <ceremony.json>",
      owner_verb: "profile escalate",
      target: "profile_escalation",
    });
  });

  test("TRIAGE.confirm forks on spec_phase: quick → EXECUTE.plan, standard → SPEC.proposal", () => {
    expect(run("TRIAGE.confirm", { ceremony: QUICK }).next_action).toMatchObject({
      owner_verb: "advance",
      target: "EXECUTE.plan",
    });
    expect(run("TRIAGE.confirm", { ceremony: STANDARD }).next_action).toMatchObject({
      owner_verb: "advance",
      target: "SPEC.proposal",
    });
  });

  test("EXECUTE.work delegates to the task loop and is not blocked", () => {
    const out = run("EXECUTE.work");
    expect(out.blocked).toBe(false);
    expect(out.next_action).toMatchObject({ owner_verb: "tasks next", target: "task-level" });
  });

  test("DONE.* is terminal and omits next_action", () => {
    const out = run("DONE.delivered");
    expect(out.terminal).toBe(true);
    expect(out.blocked).toBe(false);
    expect(out.next_action).toBeUndefined();
  });
});
