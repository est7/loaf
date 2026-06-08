// spec-schema layer tests — proves the BLOCK fix from codex r20:
// SpecFrontmatter (structural) accepts a REQ that RequirementEarsVerifiable
// rejects, so missing-verifiability is reachable as spec-lock check 5
// rather than swallowed at frontmatter parse time.

import { describe, expect, test } from "vitest";

import {
  RequirementEarsShape,
  RequirementEarsVerifiable,
  SpecFrontmatter,
  SpecSubmitInput,
  hasVerifiability,
} from "../../src/core/spec-schema.js";

const REQ_WITH_VERIFIABILITY = {
  id: "REQ-AUTH-001",
  type: "event-driven" as const,
  trigger: "an API request returns 401",
  response: "the system shall refresh the access token before surfacing failure",
  verified_by_scenarios: ["SCEN-AUTH-E2E-001"],
};

const REQ_WITHOUT_VERIFIABILITY = {
  id: "REQ-AUTH-002",
  type: "ubiquitous" as const,
  response: "the system shall provide reasonable behavior here",
  // intentionally NO measurable, verified_by_scenarios, acceptance_na
};

const VALID_FRONTMATTER_HEADER = {
  schema_version: 2,
  spec_version: 1,
  feature: { id: "F-001", name: "OAuth token refresh" },
  intent: "users should not perceive auth recovery flows in flight",
  adr_refs: [],
  scenarios: [],
  needs_clarification: [],
};

describe("hasVerifiability — single source of three-way rule (protocol §4.2)", () => {
  test("returns true when measurable is present", () => {
    expect(hasVerifiability({ measurable: { metric: "x", threshold: 1 } })).toBe(true);
  });

  test("returns true when verified_by_scenarios has ≥1 entry", () => {
    expect(hasVerifiability({ verified_by_scenarios: ["SCEN-X-001"] })).toBe(true);
  });

  test("returns true when acceptance_na=true with reason ≥10 chars", () => {
    expect(
      hasVerifiability({
        acceptance_na: true,
        acceptance_na_reason: "ten char minimum reason here",
      }),
    ).toBe(true);
  });

  test("returns false when verified_by_scenarios is empty array", () => {
    expect(hasVerifiability({ verified_by_scenarios: [] })).toBe(false);
  });

  test("returns false when acceptance_na=true but reason < 10 chars", () => {
    expect(hasVerifiability({ acceptance_na: true, acceptance_na_reason: "short" })).toBe(false);
  });

  test("returns false when none of three is present", () => {
    expect(hasVerifiability({})).toBe(false);
  });
});

describe("RequirementEarsShape vs RequirementEarsVerifiable — layer split (codex r20)", () => {
  test("RequirementEarsShape ACCEPTS a structurally valid REQ without verifiability", () => {
    const parsed = RequirementEarsShape.safeParse(REQ_WITHOUT_VERIFIABILITY);
    expect(parsed.success).toBe(true);
  });

  test("RequirementEarsVerifiable REJECTS the same unverifiable REQ", () => {
    const parsed = RequirementEarsVerifiable.safeParse(REQ_WITHOUT_VERIFIABILITY);
    expect(parsed.success).toBe(false);
  });

  test("RequirementEarsShape rejects malformed REQ body — event-driven missing trigger", () => {
    const parsed = RequirementEarsShape.safeParse({
      id: "REQ-AUTH-001",
      type: "event-driven",
      // trigger intentionally missing
      response: "the system shall do something at least ten chars long",
    });
    expect(parsed.success).toBe(false);
  });

  test("both accept a structurally valid REQ WITH verifiability", () => {
    expect(RequirementEarsShape.safeParse(REQ_WITH_VERIFIABILITY).success).toBe(true);
    expect(RequirementEarsVerifiable.safeParse(REQ_WITH_VERIFIABILITY).success).toBe(true);
  });
});

describe("SpecFrontmatter — uses structural shape so missing verifiability slips through", () => {
  test("ACCEPTS frontmatter containing a REQ without verifiability", () => {
    const parsed = SpecFrontmatter.safeParse({
      ...VALID_FRONTMATTER_HEADER,
      requirements: [REQ_WITHOUT_VERIFIABILITY],
    });
    expect(parsed.success).toBe(true);
  });

  test("REJECTS frontmatter with malformed REQ body (event-driven missing trigger)", () => {
    const parsed = SpecFrontmatter.safeParse({
      ...VALID_FRONTMATTER_HEADER,
      requirements: [
        {
          id: "REQ-AUTH-001",
          type: "event-driven",
          // trigger missing
          response: "the system shall do something at least ten chars long",
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  test("REJECTS frontmatter missing required top-level adr_refs", () => {
    const { adr_refs: _omit, ...withoutAdrRefs } = VALID_FRONTMATTER_HEADER;
    const parsed = SpecFrontmatter.safeParse({
      ...withoutAdrRefs,
      requirements: [],
    });
    expect(parsed.success).toBe(false);
  });

  test("ACCEPTS frontmatter with current schema_version=2", () => {
    const parsed = SpecFrontmatter.safeParse({
      ...VALID_FRONTMATTER_HEADER,
      schema_version: 2,
      requirements: [],
    });
    expect(parsed.success).toBe(true);
  });

  test("REJECTS frontmatter with legacy schema_version=1 (codex r21 fix)", () => {
    const parsed = SpecFrontmatter.safeParse({
      ...VALID_FRONTMATTER_HEADER,
      schema_version: 1,
      requirements: [],
    });
    expect(parsed.success).toBe(false);
  });

  test("REJECTS frontmatter with future schema_version=3 (codex r21 fix)", () => {
    const parsed = SpecFrontmatter.safeParse({
      ...VALID_FRONTMATTER_HEADER,
      schema_version: 3,
      requirements: [],
    });
    expect(parsed.success).toBe(false);
  });
});

// ── W7 — SpecSubmitInput is .strict() at the CLI input boundary ─────────
describe("SpecSubmitInput — strict input boundary (W7)", () => {
  const VALID_SUBMIT = {
    feature: { id: "F-001", name: "OAuth token refresh" },
    intent: "users should not perceive auth recovery flows in flight here",
    adr_refs: [],
    requirements: [],
    scenarios: [],
    visual_contracts: [],
    needs_clarification: [],
  };

  test("ACCEPTS a fully-specified submit input", () => {
    expect(SpecSubmitInput.safeParse(VALID_SUBMIT).success).toBe(true);
  });

  test("REJECTS an unknown top-level key (caller typo, not silently dropped)", () => {
    // `requirments` is a misspelling of `requirements` — under the prior
    // .passthrough() it slipped through and the real field defaulted to [].
    const parsed = SpecSubmitInput.safeParse({ ...VALID_SUBMIT, requirments: [] });
    expect(parsed.success).toBe(false);
  });

  test("REJECTS an arbitrary extra field", () => {
    const parsed = SpecSubmitInput.safeParse({ ...VALID_SUBMIT, surprise: true });
    expect(parsed.success).toBe(false);
  });
});
