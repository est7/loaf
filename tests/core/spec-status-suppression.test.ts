// Links `loaf spec status`'s published suppression contract to the checker's
// ACTUAL cascade behavior.
//
// `buildSpecStatusEnvelope` publishes a hardcoded {4, 6, 7} suppressed-by-3
// set, while the suppression itself lives as inline `if (!check3Failed)`
// guards in `specLockCheck`. Nothing structural ties the two together, so a
// future cascade change would leave the published contract silently lying.
// This test derives the suppressed set from behavior — run the same fixture
// with a healthy task graph and with a missing one, diff the failing check
// numbers — and asserts the published contract equals it.

import { describe, expect, test } from "vitest";

import { buildSpecStatusEnvelope } from "../../src/cli/spec-status.js";
import { specLockCheck } from "../../src/core/gates/spec-lock-check.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import type { Snapshot } from "../../src/core/reducer.js";
import type { SpecFrontmatter } from "../../src/core/spec-schema.js";

// Frontmatter that trips every coverage check: an uncovered REQ (check 4),
// an unbound e2e scenario (check 6), and an unbound visual contract (7).
const UNCOVERED_SPEC: SpecFrontmatter = {
  schema_version: 2,
  spec_version: 1,
  feature: { id: "F-001", name: "OAuth token refresh" },
  intent: "users should not perceive auth recovery flows in flight",
  adr_refs: [],
  requirements: [
    {
      id: "REQ-AUTH-001",
      type: "event-driven",
      trigger: "an API request returns 401",
      response: "the system shall refresh the access token before surfacing failure",
      verified_by_scenarios: ["SCEN-AUTH-E2E-001"],
    },
  ],
  scenarios: [
    {
      id: "SCEN-AUTH-E2E-001",
      name: "Expired token recovered",
      tag: "e2e",
      requires_acceptance: true,
      given: ["x"],
      when: ["y"],
      then: ["z"],
    },
  ],
  visual_contracts: [{ id: "VIS-AUTH-001", target: "Login button", checks: ["spinner"] }],
  needs_clarification: [],
};

function failingCheckNumbers(snapshot: Snapshot): Set<number> {
  const result = specLockCheck(snapshot, UNCOVERED_SPEC);
  return new Set(result.ok ? [] : result.checks.map((failure) => failure.check));
}

describe("spec status suppression contract matches checker cascade", () => {
  test("published suppressed_checks equals the checks the cascade actually silences", () => {
    // Check 3 passes: the coverage checks run and fail on their own merits.
    const withGraph: Snapshot = { ...initialSnapshot(), tasks_based_on: { spec: 1 } };
    const failedWithGraph = failingCheckNumbers(withGraph);

    // Check 3 fails (tasks never planned): the cascade silences a subset.
    const withoutGraph = initialSnapshot();
    const failedWithoutGraph = failingCheckNumbers(withoutGraph);

    expect(failedWithoutGraph.has(3), "fixture must trip check 3").toBe(true);

    const silenced = [...failedWithGraph]
      .filter((check) => !failedWithoutGraph.has(check))
      .sort((a, b) => a - b);
    expect(silenced.length, "fixture must trip at least one suppressible check").toBeGreaterThan(0);

    const published = buildSpecStatusEnvelope(specLockCheck(withoutGraph, UNCOVERED_SPEC));
    expect(published.suppressed_checks.map((row) => row.check).sort((a, b) => a - b)).toEqual(
      silenced,
    );
    for (const row of published.suppressed_checks) {
      expect(row.blocked_by).toBe(3);
    }
  });
});
