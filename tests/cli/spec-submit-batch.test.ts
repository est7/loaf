// Phase 16 SC-12a-1 — pure tests for shared spec submit batch builder.
//
// Covers (codex r332 P2 / r334 non-blocking ack):
//   - 1 head + N req + M scen + K vis entry count
//   - canonical order: head FIRST, then reqs, then scens, then vis
//   - all entries share `at` / `actor` / `entry_schema_version`
//   - spec_version stamping: snapshot.state.spec_version + 1 by default
//   - spec_version stamping: input.spec_version override honored
//   - head payload fields match input (feature / intent / adr_refs /
//     needs_clarification)
//   - companion payloads carry spec_version + the unwrapped item
//   - empty companion arrays → 1-entry batch (head only)

import { describe, expect, test } from "vitest";

import { buildSpecSubmitBatch } from "../../src/cli/spec-submit-batch.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import type { Snapshot, SessionState } from "../../src/core/reducer.js";
import type { SpecSubmitInput } from "../../src/core/spec-schema.js";

const ACTOR = "human:dev@example.com";
const NOW = "2026-05-29T07:00:00.000Z";

const REQ_VERIFIABLE: SpecSubmitInput["requirements"][number] = {
  id: "REQ-AUTH-001",
  type: "ubiquitous",
  response: "the system shall do something measurably here",
  acceptance_na: true,
  acceptance_na_reason: "covered by manual UX testing scope outside automation",
};

const SCEN_E2E: SpecSubmitInput["scenarios"][number] = {
  id: "SCEN-AUTH-E2E-001",
  name: "user refresh happy path",
  tag: "e2e",
  given: ["valid refresh token in cookie"],
  when: ["request to /protected returns 401"],
  then: ["refresh runs and original request retries"],
};

const VIS_001: NonNullable<SpecSubmitInput["visual_contracts"]>[number] = {
  id: "VIS-AUTH-001",
  target: "OAuth login button hover state",
  checks: ["pixel snapshot of hover variant"],
};

function makeState(specVersion: number): SessionState {
  return {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    feature: "auth-refresh",
    phase: "SPEC",
    sub_state: "SPEC.proposal",
    iteration: 1,
    spec_locked: false,
    verify_accepted: false,
    spec_version: specVersion,
    ceremony: {
      spec_phase: true,
      verify_phase: true,
      settle_phase: false,
      strict_spec_review: false,
      lessons_required: "skip",
      strict_drift_check: false,
    },
  };
}

function makeSnapshot(specVersion: number): Snapshot {
  const snap = initialSnapshot();
  snap.state = makeState(specVersion);
  return snap;
}

function makeInput(overrides: Partial<SpecSubmitInput> = {}): SpecSubmitInput {
  return {
    feature: { id: "F-001", name: "OAuth token refresh" },
    intent: "users should not perceive auth recovery flows in flight",
    adr_refs: [],
    requirements: [],
    scenarios: [],
    visual_contracts: [],
    needs_clarification: [],
    ...overrides,
  };
}

describe("buildSpecSubmitBatch — entry count + order", () => {
  test("empty companions → 1-entry batch (head only)", () => {
    const entries = buildSpecSubmitBatch({
      input: makeInput(),
      snapshot: makeSnapshot(0),
      actor: ACTOR,
      now: NOW,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("event:spec_submitted");
  });

  test("1 req + 1 scen + 1 vis → 4 entries, head first then req then scen then vis", () => {
    const entries = buildSpecSubmitBatch({
      input: makeInput({
        requirements: [REQ_VERIFIABLE],
        scenarios: [SCEN_E2E],
        visual_contracts: [VIS_001],
      }),
      snapshot: makeSnapshot(0),
      actor: ACTOR,
      now: NOW,
    });
    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.kind)).toEqual([
      "event:spec_submitted",
      "event:spec_req_added",
      "event:spec_scenario_added",
      "event:spec_visual_added",
    ]);
  });

  test("N reqs + M scens + K vis → 1+N+M+K entries", () => {
    const entries = buildSpecSubmitBatch({
      input: makeInput({
        requirements: [REQ_VERIFIABLE, { ...REQ_VERIFIABLE, id: "REQ-AUTH-002" }],
        scenarios: [SCEN_E2E],
        visual_contracts: [VIS_001, { ...VIS_001, id: "VIS-AUTH-002" }, { ...VIS_001, id: "VIS-AUTH-003" }],
      }),
      snapshot: makeSnapshot(0),
      actor: ACTOR,
      now: NOW,
    });
    expect(entries).toHaveLength(1 + 2 + 1 + 3);
  });
});

describe("buildSpecSubmitBatch — shared envelope fields", () => {
  test("all entries share `at` / `actor` / entry_schema_version", () => {
    const entries = buildSpecSubmitBatch({
      input: makeInput({
        requirements: [REQ_VERIFIABLE],
        scenarios: [SCEN_E2E],
      }),
      snapshot: makeSnapshot(0),
      actor: ACTOR,
      now: NOW,
    });
    for (const entry of entries) {
      expect(entry.at).toBe(NOW);
      expect(entry.actor).toBe(ACTOR);
      expect(entry.entry_schema_version).toBe(1);
    }
  });
});

describe("buildSpecSubmitBatch — spec_version stamping (codex r331 P1)", () => {
  test("snapshot.state.spec_version + 1 by default", () => {
    const entries = buildSpecSubmitBatch({
      input: makeInput(),  // input.spec_version absent
      snapshot: makeSnapshot(5),
      actor: ACTOR,
      now: NOW,
    });
    expect((entries[0]!.payload as { spec_version: number }).spec_version).toBe(6);
  });

  test("input.spec_version explicit override honored (reducer enforces monotonic downstream)", () => {
    const entries = buildSpecSubmitBatch({
      input: makeInput({ spec_version: 99 }),
      snapshot: makeSnapshot(5),
      actor: ACTOR,
      now: NOW,
    });
    expect((entries[0]!.payload as { spec_version: number }).spec_version).toBe(99);
  });

  test("snapshot with null state (pre-start edge) → starts from 1", () => {
    const snap = initialSnapshot();
    snap.state = null;
    const entries = buildSpecSubmitBatch({
      input: makeInput(),
      snapshot: snap,
      actor: ACTOR,
      now: NOW,
    });
    expect((entries[0]!.payload as { spec_version: number }).spec_version).toBe(1);
  });

  test("all companion entries carry the SAME spec_version as the head", () => {
    const entries = buildSpecSubmitBatch({
      input: makeInput({
        requirements: [REQ_VERIFIABLE],
        scenarios: [SCEN_E2E],
        visual_contracts: [VIS_001],
      }),
      snapshot: makeSnapshot(3),
      actor: ACTOR,
      now: NOW,
    });
    const headVersion = (entries[0]!.payload as { spec_version: number }).spec_version;
    expect(headVersion).toBe(4);
    for (const entry of entries.slice(1)) {
      expect((entry.payload as { spec_version: number }).spec_version).toBe(4);
    }
  });
});

describe("buildSpecSubmitBatch — payload field shapes", () => {
  test("head payload includes feature / intent / adr_refs / needs_clarification", () => {
    const input = makeInput({
      feature: { id: "F-007", name: "Custom feature name" },
      intent: "deliberately custom intent for shape regression check",
      adr_refs: ["adr-0005-truth-model", "adr-0001-baseline"],
      needs_clarification: [{
        id: "NC-001",
        question: "what is the expected hover state for the OAuth login button",
        status: "open",
      }],
    });
    const entries = buildSpecSubmitBatch({
      input, snapshot: makeSnapshot(0), actor: ACTOR, now: NOW,
    });
    const head = entries[0]!.payload as Record<string, unknown>;
    expect(head["feature"]).toEqual({ id: "F-007", name: "Custom feature name" });
    expect(head["intent"]).toBe("deliberately custom intent for shape regression check");
    expect(head["adr_refs"]).toEqual(["adr-0005-truth-model", "adr-0001-baseline"]);
    expect((head["needs_clarification"] as Array<{ id: string }>)).toHaveLength(1);
  });

  test("req companion payload: { spec_version, req }", () => {
    const entries = buildSpecSubmitBatch({
      input: makeInput({ requirements: [REQ_VERIFIABLE] }),
      snapshot: makeSnapshot(0),
      actor: ACTOR,
      now: NOW,
    });
    const reqEntry = entries[1]!;
    expect(reqEntry.kind).toBe("event:spec_req_added");
    expect(reqEntry.payload).toEqual({ spec_version: 1, req: REQ_VERIFIABLE });
  });

  test("scen companion payload: { spec_version, scenario }", () => {
    const entries = buildSpecSubmitBatch({
      input: makeInput({ scenarios: [SCEN_E2E] }),
      snapshot: makeSnapshot(0),
      actor: ACTOR,
      now: NOW,
    });
    const scenEntry = entries[1]!;
    expect(scenEntry.kind).toBe("event:spec_scenario_added");
    expect(scenEntry.payload).toEqual({ spec_version: 1, scenario: SCEN_E2E });
  });

  test("vis companion payload: { spec_version, visual }", () => {
    const entries = buildSpecSubmitBatch({
      input: makeInput({ visual_contracts: [VIS_001] }),
      snapshot: makeSnapshot(0),
      actor: ACTOR,
      now: NOW,
    });
    const visEntry = entries[1]!;
    expect(visEntry.kind).toBe("event:spec_visual_added");
    expect(visEntry.payload).toEqual({ spec_version: 1, visual: VIS_001 });
  });
});

describe("buildSpecSubmitBatch — byte-equal regression for canonical input", () => {
  test("fixed fixture produces stable entry array", () => {
    // This is the canonical-shape regression: any future change to the
    // builder that breaks the shape will fail this test.
    const entries = buildSpecSubmitBatch({
      input: makeInput({
        requirements: [REQ_VERIFIABLE],
        scenarios: [SCEN_E2E],
        visual_contracts: [VIS_001],
      }),
      snapshot: makeSnapshot(0),
      actor: ACTOR,
      now: NOW,
    });

    expect(entries).toEqual([
      {
        at: NOW,
        actor: ACTOR,
        entry_schema_version: 1,
        kind: "event:spec_submitted",
        payload: {
          spec_version: 1,
          feature: { id: "F-001", name: "OAuth token refresh" },
          intent: "users should not perceive auth recovery flows in flight",
          adr_refs: [],
          needs_clarification: [],
        },
      },
      {
        at: NOW,
        actor: ACTOR,
        entry_schema_version: 1,
        kind: "event:spec_req_added",
        payload: { spec_version: 1, req: REQ_VERIFIABLE },
      },
      {
        at: NOW,
        actor: ACTOR,
        entry_schema_version: 1,
        kind: "event:spec_scenario_added",
        payload: { spec_version: 1, scenario: SCEN_E2E },
      },
      {
        at: NOW,
        actor: ACTOR,
        entry_schema_version: 1,
        kind: "event:spec_visual_added",
        payload: { spec_version: 1, visual: VIS_001 },
      },
    ]);
  });
});
