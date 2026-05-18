// spec-lock-check — pure gate evaluator (3 active checks: 1 is caller's,
// 2 and 5 land here; 3/4/6/7/8 stand by for sub-cycle 3 TaskState extension).
//
// Tests treat the function as it really is: snapshot + already-parsed
// SpecFrontmatter → SpecLockResult. Multi-failure accumulation is the
// default; check 1 mapping lives in the caller and is NOT tested here
// (codex r20 GO v2 — moved to sub-cycle 3).

import { describe, expect, test } from "vitest";

import { specLockCheck } from "../../../src/core/gates/spec-lock-check.js";
import { initialSnapshot } from "../../../src/core/reducer.js";
import type { SpecFrontmatter } from "../../../src/core/spec-schema.js";

const REQ_VERIFIABLE: SpecFrontmatter["requirements"][number] = {
  id: "REQ-AUTH-001",
  type: "event-driven",
  trigger: "an API request returns 401",
  response: "the system shall refresh the access token before surfacing failure",
  verified_by_scenarios: ["SCEN-AUTH-E2E-001"],
};

const REQ_UNVERIFIABLE: SpecFrontmatter["requirements"][number] = {
  id: "REQ-AUTH-002",
  type: "ubiquitous",
  response: "the system shall provide reasonable behavior here",
};

const REQ_UNVERIFIABLE_2: SpecFrontmatter["requirements"][number] = {
  id: "REQ-AUTH-003",
  type: "ubiquitous",
  response: "the login flow shall surface reasonable error feedback",
};

function makeFrontmatter(overrides: Partial<SpecFrontmatter> = {}): SpecFrontmatter {
  return {
    schema_version: 2,
    spec_version: 1,
    feature: { id: "F-001", name: "OAuth token refresh" },
    intent: "users should not perceive auth recovery flows in flight",
    adr_refs: [],
    requirements: [REQ_VERIFIABLE],
    scenarios: [],
    needs_clarification: [],
    ...overrides,
  };
}

describe("specLockCheck — Slice 1.B sub-cycle 2 (checks 2 + 5)", () => {
  test("ok=true when all active checks pass", () => {
    const result = specLockCheck(initialSnapshot(), makeFrontmatter());
    expect(result.ok).toBe(true);
  });

  test("check 2 fails when needs_clarification has unresolved entries", () => {
    const result = specLockCheck(
      initialSnapshot(),
      makeFrontmatter({
        needs_clarification: [
          { id: "NC-001", question: "should we support OAuth 2.1?" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]!.check).toBe(2);
      expect(result.checks[0]!.code).toBe("SPEC_HAS_UNCLARIFIED");
      expect(result.checks[0]!.detail?.ids).toEqual(["NC-001"]);
    }
  });

  test("check 5 fails on REQ without verifiability — codex r20 boundary witness", () => {
    // This is the test codex r20 demanded: structurally valid REQ with no
    // verifiability triad must NOT fail at frontmatter parse (check 1),
    // must land here as check 5 / MISSING_VERIFIABILITY.
    const result = specLockCheck(
      initialSnapshot(),
      makeFrontmatter({ requirements: [REQ_UNVERIFIABLE] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]!.check).toBe(5);
      expect(result.checks[0]!.code).toBe("MISSING_VERIFIABILITY");
      expect(result.checks[0]!.detail?.req_id).toBe("REQ-AUTH-002");
    }
  });

  test("check 5 reports each unverifiable REQ separately (accumulation)", () => {
    const result = specLockCheck(
      initialSnapshot(),
      makeFrontmatter({
        requirements: [REQ_UNVERIFIABLE, REQ_VERIFIABLE, REQ_UNVERIFIABLE_2],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const failingReqIds = result.checks
        .filter((c) => c.check === 5)
        .map((c) => c.detail?.req_id);
      expect(failingReqIds).toEqual(["REQ-AUTH-002", "REQ-AUTH-003"]);
    }
  });

  test("checks 2 + 5 accumulate when both fail", () => {
    // codex r20 added test: check 1 short-circuits at the caller, but 2
    // and N×5 must all surface in one Result.
    const result = specLockCheck(
      initialSnapshot(),
      makeFrontmatter({
        requirements: [REQ_UNVERIFIABLE, REQ_UNVERIFIABLE_2],
        needs_clarification: [
          { id: "NC-001", question: "should we support OAuth 2.1?" },
          { id: "NC-002", question: "scope for refresh token rotation?" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 1 check 2 failure + 2 check 5 failures = 3 entries
      expect(result.checks).toHaveLength(3);
      expect(result.checks.filter((c) => c.check === 2)).toHaveLength(1);
      expect(result.checks.filter((c) => c.check === 5)).toHaveLength(2);
    }
  });

  test("REQ with acceptance_na+reason ≥10 chars passes check 5", () => {
    const result = specLockCheck(
      initialSnapshot(),
      makeFrontmatter({
        requirements: [
          {
            id: "REQ-UX-001",
            type: "ubiquitous",
            response: "the UI shall feel intuitive to first-time users",
            acceptance_na: true,
            acceptance_na_reason: "subjective UX validated via user testing scope",
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("REQ with measurable passes check 5", () => {
    const result = specLockCheck(
      initialSnapshot(),
      makeFrontmatter({
        requirements: [
          {
            id: "REQ-PERF-001",
            type: "ubiquitous",
            response: "the system shall complete the operation within bounded time",
            measurable: { metric: "p99_latency_ms", threshold: 500, direction: "lte" },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("REQ with empty verified_by_scenarios array fails check 5", () => {
    const result = specLockCheck(
      initialSnapshot(),
      makeFrontmatter({
        requirements: [
          {
            id: "REQ-AUTH-004",
            type: "ubiquitous",
            response: "the system shall provide reasonable behavior here",
            verified_by_scenarios: [],
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.checks[0]!.code).toBe("MISSING_VERIFIABILITY");
    }
  });

  test("REQ with acceptance_na but reason <10 chars fails check 5", () => {
    const result = specLockCheck(
      initialSnapshot(),
      makeFrontmatter({
        requirements: [
          {
            id: "REQ-AUTH-005",
            type: "ubiquitous",
            response: "the system shall do something reasonable here",
            acceptance_na: true,
            acceptance_na_reason: "short",
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.checks[0]!.code).toBe("MISSING_VERIFIABILITY");
    }
  });
});
