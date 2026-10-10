// Spec-lock snapshot boundary and eight-check characterization.

import { describe, expect, test } from "vitest";

import { evaluateSpecLockFromSnapshot } from "../../../src/core/gates/spec-lock-eval.js";
import { initialSnapshot } from "../../../src/core/reducer.js";
import type { Snapshot, TaskState } from "../../../src/core/reducer.js";
import type { SpecFrontmatter } from "../../../src/core/spec-schema.js";

function specDesignSnapshot(): Snapshot {
  const base = initialSnapshot();
  return {
    ...base,
    state: {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "F-001",
      phase: "SPEC",
      sub_state: "SPEC.design",
      iteration: 1,
      spec_locked: false,
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
  };
}

const VERIFIABLE_REQ: SpecFrontmatter["requirements"][number] = {
  id: "REQ-AUTH-001",
  type: "event-driven",
  trigger: "an API request returns 401",
  response: "the system shall refresh the access token before surfacing failure",
  verified_by_scenarios: ["SCEN-AUTH-E2E-001"],
};

function frontmatter(overrides: Partial<SpecFrontmatter> = {}): SpecFrontmatter {
  return {
    schema_version: 2,
    spec_version: 1,
    feature: { id: "F-001", name: "OAuth token refresh" },
    intent: "users should not perceive auth recovery flows in flight",
    adr_refs: [],
    requirements: [VERIFIABLE_REQ],
    scenarios: [],
    visual_contracts: [],
    needs_clarification: [],
    ...overrides,
  };
}

function step(applicability: "must" | "optional" | "na") {
  return { applicability, status: "pending" as const };
}

function behavioralTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "T-001",
    kind: "behavioral",
    status: "pending",
    steps: { red: step("must"), implement: step("must"), refactor: step("optional") },
    drives: ["REQ-AUTH-001"],
    depends_on: [],
    labels: [],
    ...overrides,
  };
}

function replaySnapshot(fm: SpecFrontmatter, overrides: Partial<Snapshot> = {}): Snapshot {
  const base = specDesignSnapshot();
  return {
    ...base,
    spec_header: {
      feature: fm.feature,
      intent: fm.intent,
      adr_refs: fm.adr_refs,
      needs_clarification: fm.needs_clarification,
    },
    requirements: fm.requirements,
    scenarios: fm.scenarios,
    visual_contracts: fm.visual_contracts ?? [],
    tasks: [behavioralTask()],
    tasks_based_on: { spec: fm.spec_version },
    ...overrides,
  };
}

describe("snapshot spec boundary", () => {
  test.each([
    "session",
    "header",
  ])("missing %s fails closed with snapshot-sourced check 1", (missing) => {
    const snapshot = replaySnapshot(frontmatter());
    if (missing === "session") snapshot.state = null;
    else snapshot.spec_header = null;
    expect(evaluateSpecLockFromSnapshot(snapshot)).toEqual({
      ok: false,
      checks: [
        {
          check: 1,
          code: "SPEC_FRONTMATTER_INVALID",
          detail: {
            source: "snapshot",
            subcode: "SPEC_NOT_FOUND",
            reason: missing === "session" ? "session_state_missing" : "spec_header_missing",
          },
        },
      ],
    });
  });

  test("malformed snapshot spec fails closed without a file path or YAML subcode", () => {
    const snapshot = replaySnapshot(frontmatter({ intent: "short" }));
    const result = evaluateSpecLockFromSnapshot(snapshot);
    expect(result).toMatchObject({
      ok: false,
      checks: [
        {
          check: 1,
          code: "SPEC_FRONTMATTER_INVALID",
          detail: {
            source: "snapshot",
            subcode: "SPEC_FRONTMATTER_INVALID",
            issues: [expect.objectContaining({ path: ["intent"] })],
          },
        },
      ],
    });
    if (result.ok) throw new Error("expected invalid snapshot spec");
    expect(result.checks[0]!.detail).not.toHaveProperty("path");
  });
});

describe("evaluateSpecLockFromSnapshot — eight-check characterization before replay-input extraction", () => {
  test("clean replay returns the exact pass shape", async () => {
    const fm = frontmatter();

    await expect(evaluateSpecLockFromSnapshot(replaySnapshot(fm))).toEqual({ ok: true });
  });

  test("check 3 failure has the exact shape and suppresses checks 4, 6, and 7", async () => {
    const fm = frontmatter();

    await expect(
      evaluateSpecLockFromSnapshot(replaySnapshot(fm, { tasks_based_on: null })),
    ).toEqual({
      ok: false,
      checks: [
        {
          check: 3,
          code: "TASKS_NOT_PLANNED",
          detail: {},
        },
      ],
    });
  });

  test("checks 2, 4, 5, 6, 7, and 8 retain exact failure ordering and shapes", async () => {
    const unverifiableReq: SpecFrontmatter["requirements"][number] = {
      id: "REQ-AUTH-099",
      type: "ubiquitous",
      response: "the system shall provide reasonable behavior here",
    };
    const fm = frontmatter({
      requirements: [unverifiableReq],
      scenarios: [
        {
          id: "SCEN-AUTH-E2E-001",
          name: "Expired token recovered",
          tag: "e2e",
          requires_acceptance: true,
          given: ["a valid refresh token"],
          when: ["the user opens orders"],
          then: ["the access token is refreshed"],
        },
      ],
      visual_contracts: [
        {
          id: "VIS-AUTH-001",
          target: "Login button during refresh",
          checks: ["shows a spinner"],
          requires_visual: true,
        },
      ],
      needs_clarification: [{ id: "NC-001", question: "should OAuth 2.1 be required?" }],
    });
    const invalidVisualTask: TaskState = {
      id: "T-200",
      kind: "visual-ui",
      status: "pending",
      steps: {
        mockup: step("must"),
        implement: step("must"),
        "screenshot-compare": step("must"),
      },
      drives: [],
      depends_on: [],
      labels: [],
      visual_contract_refs: [],
    };

    await expect(
      evaluateSpecLockFromSnapshot(replaySnapshot(fm, { tasks: [invalidVisualTask] })),
    ).toEqual({
      ok: false,
      checks: [
        {
          check: 2,
          code: "SPEC_HAS_UNCLARIFIED",

          detail: { count: 1, ids: ["NC-001"] },
        },
        {
          check: 4,
          code: "REQ_NOT_DRIVEN",

          detail: { req_id: "REQ-AUTH-099" },
        },
        {
          check: 5,
          code: "MISSING_VERIFIABILITY",

          detail: { req_id: "REQ-AUTH-099", req_type: "ubiquitous" },
        },
        {
          check: 6,
          code: "E2E_SCENARIO_UNBOUND",

          detail: { scenario_id: "SCEN-AUTH-E2E-001" },
        },
        {
          check: 7,
          code: "VISUAL_CONTRACT_UNBOUND",

          detail: { visual_id: "VIS-AUTH-001" },
        },
        {
          check: 8,
          code: "TASK_KIND_SCHEMA_VIOLATION",

          detail: {
            task_id: "T-200",
            kind: "visual-ui",
            reasons: ["visual-ui task requires visual_contract_refs[] with ≥1 entry"],
          },
        },
      ],
    });
  });
});
