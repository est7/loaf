// Slice 1.B sub-cycle 1 — SPEC content reducer (§11.2 step 7 + protocol §4.2 / §5.1).
//
// 4 new kinds — event:spec_submitted / event:spec_req_added /
// event:spec_scenario_added / event:spec_visual_added — must:
//   - bump state.spec_version per protocol §586 (per-invocation +1)
//   - reset arrays on spec_submitted (whole-replacement semantics per §576-587)
//   - push slim projection on add entries (canonical full body stays in entry.payload)
//   - reject stale / batch-mismatched / duplicate-id payloads
//
// Codex r16/r17 pre-impl design lock:
//   - Use entry.batch_index to disambiguate new-invocation head
//     (undefined|0; must bump) vs batch continuation (>0; must equal).
//   - Journal payload carries FULL canonical body (replay-able to spec.md);
//     reducer extracts slim projection (id + verifiability + cross-ref tags).
//
// All tests seed to SPEC.proposal so PER_KIND_SUB_STATE admits the spec
// content kinds (per-kind.ts:49-52 / ALL_SPEC).

import { describe, expect, test } from "vitest";

import { apply, initialSnapshot } from "../../src/core/reducer.js";
import type { Ceremony, JournalEntry } from "../../src/core/journal-entry.js";
import type { Snapshot } from "../../src/core/reducer.js";

const STANDARD_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

function mustOk<T extends { ok: boolean }>(
  r: T,
): Extract<T, { ok: true; snapshot: unknown }>["snapshot"] {
  if (!r.ok) throw new Error(`expected ok, got: ${JSON.stringify(r)}`);
  return (r as Extract<T, { ok: true; snapshot: unknown }>).snapshot;
}

function entry(
  seq: number,
  kind: JournalEntry["kind"],
  payload: unknown,
  batch?: { id: string; index: number; count: number },
): JournalEntry {
  const base = {
    seq,
    entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
    at: `2026-05-15T10:00:${String(seq).padStart(2, "0")}.000Z`,
    actor: "human:ffoisx@gmail.com",
    entry_schema_version: 1,
    kind,
    payload,
  };
  if (batch === undefined) return base as JournalEntry;
  return {
    ...base,
    batch_id: batch.id,
    batch_index: batch.index,
    batch_count: batch.count,
  } as JournalEntry;
}

// Full canonical payload fixtures. Journal must carry these in full so spec.md
// is replay-able from journal (codex r17). Reducer extracts slim subset to
// projection; the un-extracted body fields stay on entry.payload.

function fullSubmittedPayload(spec_version: number): unknown {
  return {
    spec_version,
    feature: { id: "F-001", name: "OAuth access token refresh" },
    intent: "users should not perceive auth recovery flows in flight",
    adr_refs: [],
    needs_clarification: [],
  };
}

function fullUbiquitousReqPayload(spec_version: number, id: string): unknown {
  return {
    spec_version,
    req: {
      id,
      type: "ubiquitous",
      response: "the system shall handle the case correctly under all conditions",
      acceptance_na: true,
      acceptance_na_reason: "subjective UX validated via manual testing scope",
    },
  };
}

function fullEventDrivenReqPayload(spec_version: number, id: string): unknown {
  return {
    spec_version,
    req: {
      id,
      type: "event-driven",
      trigger: "an API request receives HTTP 401",
      response: "the system shall attempt to refresh the access token before surfacing failure",
      verified_by_scenarios: ["SCEN-AUTH-E2E-001"],
    },
  };
}

// Slice A SC1: per-EARS-variant payload helpers — needed to prove the
// widened RequirementState preserves variant-specific body fields under
// the discriminated union (codex r86 §"per-variant REQ preservation").
// Each variant picks a different verifiability path (measurable /
// verified_by_scenarios / acceptance_na) to also exercise the
// VerifiabilityFields stack in passing.

function fullStateDrivenReqPayload(spec_version: number, id: string): unknown {
  return {
    spec_version,
    req: {
      id,
      type: "state-driven",
      while_: "session is in flight and refresh token is valid",
      behavior: "the system shall renew access tokens at most every 60s",
      measurable: { metric: "p99_renew_latency_ms", threshold: 300, direction: "lte" },
    },
  };
}

function fullOptionalReqPayload(spec_version: number, id: string): unknown {
  return {
    spec_version,
    req: {
      id,
      type: "optional",
      feature: "biometric unlock",
      response: "the system shall offer biometric prompt before password fallback",
      verified_by_scenarios: ["SCEN-AUTH-OPT-001"],
    },
  };
}

function fullUnwantedReqPayload(spec_version: number, id: string): unknown {
  return {
    spec_version,
    req: {
      id,
      type: "unwanted",
      condition: "user submits an empty password field",
      response: "the system shall reject submission without contacting the auth server",
      acceptance_na: true,
      acceptance_na_reason: "negative-path UX validated by manual smoke test",
    },
  };
}

function fullScenarioPayload(spec_version: number, id: string): unknown {
  return {
    spec_version,
    scenario: {
      id,
      name: "Expired token recovered by refresh",
      tag: "e2e",
      requires_acceptance: true,
      given: ["user has valid refresh token", "access token is expired"],
      when: ["user opens the order list"],
      then: ["system refreshes the access token", "order list is displayed"],
    },
  };
}

function fullVisualPayload(spec_version: number, id: string): unknown {
  return {
    spec_version,
    visual: {
      id,
      target: "Login primary button during refresh in-flight",
      checks: [
        "shows loading spinner inside button",
        "button is disabled to prevent repeated taps",
      ],
      requires_visual: true,
    },
  };
}

// Seed: session:started → phase_advanced TRIAGE.confirm → SPEC.proposal.
function seedAtSpecProposal(): Snapshot {
  let snap = initialSnapshot();
  snap = mustOk(
    apply(
      snap,
      entry(0, "session:started", {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "auth-refresh",
        ceremony: STANDARD_CEREMONY,
      }),
    ),
  );
  snap = mustOk(
    apply(
      snap,
      entry(1, "event:phase_advanced", {
        from: "TRIAGE.score",
        to: "TRIAGE.confirm",
      }),
    ),
  );
  snap = mustOk(
    apply(
      snap,
      entry(2, "event:phase_advanced", {
        from: "TRIAGE.confirm",
        to: "SPEC.proposal",
      }),
    ),
  );
  return snap;
}

// Slice 4 SC3: SPEC_NOT_INITIALIZED preflight (5i) blocks spec_*_added
// when state.spec_version === 0. Tests that need to exercise add-*
// against a populated spec build on this seed instead. Emits an empty
// `event:spec_submitted` to bump spec_version to 1 without populating
// any companions, so individual add-* assertions stay focused on the
// kind under test.
function seedAtSpecProposalPostSubmit(): Snapshot {
  let snap = seedAtSpecProposal();
  snap = mustOk(
    apply(
      snap,
      entry(3, "event:spec_submitted", {
        spec_version: 1,
        feature: { id: "F-001", name: "auth-refresh" },
        intent: "preflight seed for SPEC content add-* reducer tests",
        adr_refs: [],
        needs_clarification: [],
      }),
    ),
  );
  return snap;
}

describe("reducer SPEC content handlers — Slice 1.B sub-cycle 1", () => {
  test("initialSnapshot exposes empty SPEC projection arrays", () => {
    const snap = initialSnapshot();
    expect(snap.requirements).toEqual([]);
    expect(snap.scenarios).toEqual([]);
    expect(snap.visual_contracts).toEqual([]);
  });

  test("event:spec_submitted standalone bumps spec_version + arrays start empty", () => {
    const snap = seedAtSpecProposal();
    expect(snap.state!.spec_version).toBe(0);

    const next = mustOk(
      apply(snap, entry(3, "event:spec_submitted", fullSubmittedPayload(1))),
    );

    expect(next.state!.spec_version).toBe(1);
    expect(next.requirements).toEqual([]);
    expect(next.scenarios).toEqual([]);
    expect(next.visual_contracts).toEqual([]);
  });

  test("event:spec_submitted resets non-empty projection arrays on re-submit", () => {
    let snap = seedAtSpecProposal();
    snap = mustOk(
      apply(
        snap,
        entry(3, "event:spec_submitted", fullSubmittedPayload(1), {
          id: "11111111-2222-4333-8444-555555555555",
          index: 0,
          count: 2,
        }),
      ),
    );
    snap = mustOk(
      apply(
        snap,
        entry(4, "event:spec_req_added", fullUbiquitousReqPayload(1, "REQ-A-001"), {
          id: "11111111-2222-4333-8444-555555555555",
          index: 1,
          count: 2,
        }),
      ),
    );
    expect(snap.requirements).toHaveLength(1);

    snap = mustOk(
      apply(snap, entry(5, "event:spec_submitted", fullSubmittedPayload(2))),
    );
    expect(snap.state!.spec_version).toBe(2);
    expect(snap.requirements).toEqual([]);
    expect(snap.scenarios).toEqual([]);
    expect(snap.visual_contracts).toEqual([]);
  });

  test("event:spec_submitted + companion event:spec_req_added (batch) populates projection", () => {
    let snap = seedAtSpecProposal();
    snap = mustOk(
      apply(
        snap,
        entry(3, "event:spec_submitted", fullSubmittedPayload(1), {
          id: "11111111-2222-4333-8444-555555555555",
          index: 0,
          count: 2,
        }),
      ),
    );
    snap = mustOk(
      apply(
        snap,
        entry(4, "event:spec_req_added", fullEventDrivenReqPayload(1, "REQ-AUTH-001"), {
          id: "11111111-2222-4333-8444-555555555555",
          index: 1,
          count: 2,
        }),
      ),
    );

    expect(snap.state!.spec_version).toBe(1);
    expect(snap.requirements).toHaveLength(1);
    expect(snap.requirements[0]!.id).toBe("REQ-AUTH-001");
  });

  test("event:spec_req_added standalone bumps spec_version + appends (post-submit)", () => {
    // Slice 4 SC3: SPEC_NOT_INITIALIZED blocks standalone spec_*_added
    // when state.spec_version === 0. Seed past the spec submit step so
    // this test focuses on the standalone bump path (1 → 2), not on
    // the now-blocked 0 → 1 pre-submit path.
    const snap = seedAtSpecProposalPostSubmit();
    const next = mustOk(
      apply(
        snap,
        entry(4, "event:spec_req_added", fullUbiquitousReqPayload(2, "REQ-AUTH-001")),
      ),
    );
    expect(next.state!.spec_version).toBe(2);
    expect(next.requirements).toHaveLength(1);
    expect(next.requirements[0]!.id).toBe("REQ-AUTH-001");
  });

  test("event:spec_req_added preserves full event-driven REQ body in Snapshot.requirements[] (Slice A SC1 inversion)", () => {
    // Slice A SC1 (codex r84/r86): widen RequirementState slim → full.
    // Prior test (Slice 1.B SC1) asserted body fields stay OFF the
    // projection — that contract is reversed under spec.md projection
    // writer prereq. Body fields MUST land on Snapshot so
    // writeDerivedSpecMd can re-serialize the frontmatter without
    // re-reading the journal.
    const snap = seedAtSpecProposalPostSubmit();
    const fullPayload = fullEventDrivenReqPayload(2, "REQ-AUTH-001") as {
      spec_version: number;
      req: { id: string; type: string; trigger: string; response: string; verified_by_scenarios: string[] };
    };

    const next = mustOk(
      apply(snap, entry(4, "event:spec_req_added", fullPayload)),
    );

    const stored = next.requirements[0]! as unknown as Record<string, unknown>;
    expect(stored["id"]).toBe("REQ-AUTH-001");
    expect(stored["type"]).toBe("event-driven");
    expect(stored["trigger"]).toBe("an API request receives HTTP 401");
    expect(stored["response"]).toMatch(/refresh the access token/);
    expect(stored["verified_by_scenarios"]).toEqual(["SCEN-AUTH-E2E-001"]);
  });

  test("event:spec_req_added stale standalone version is rejected (post-submit)", () => {
    let snap = seedAtSpecProposalPostSubmit();
    snap = mustOk(
      apply(
        snap,
        entry(4, "event:spec_req_added", fullUbiquitousReqPayload(2, "REQ-AUTH-001")),
      ),
    );
    expect(snap.state!.spec_version).toBe(2);

    const result = apply(
      snap,
      entry(5, "event:spec_req_added", fullUbiquitousReqPayload(2, "REQ-AUTH-002")),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Slice E promotion: SPEC_VERSION_NOT_MONOTONIC surfaced from
      // preflight directly (was wrapped as INVALID_PAYLOAD by reducer
      // before the promotion).
      expect(result.code).toBe("SPEC_VERSION_NOT_MONOTONIC");
      expect(result.message).toMatch(/spec_version must be/);
    }
  });

  test("event:spec_req_added batch-continuation with wrong spec_version is rejected", () => {
    let snap = seedAtSpecProposal();
    snap = mustOk(
      apply(
        snap,
        entry(3, "event:spec_submitted", fullSubmittedPayload(1), {
          id: "11111111-2222-4333-8444-555555555555",
          index: 0,
          count: 2,
        }),
      ),
    );

    const result = apply(
      snap,
      entry(4, "event:spec_req_added", fullUbiquitousReqPayload(2, "REQ-AUTH-001"), {
        id: "11111111-2222-4333-8444-555555555555",
        index: 1,
        count: 2,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Slice E promotion: SPEC_VERSION_BATCH_MISMATCH from preflight.
      expect(result.code).toBe("SPEC_VERSION_BATCH_MISMATCH");
      expect(result.message).toMatch(/SPEC_VERSION_BATCH_MISMATCH|batch/i);
    }
  });

  test("event:spec_req_added with duplicate id is rejected", () => {
    let snap = seedAtSpecProposalPostSubmit();
    snap = mustOk(
      apply(
        snap,
        entry(4, "event:spec_req_added", fullUbiquitousReqPayload(2, "REQ-AUTH-001")),
      ),
    );

    const result = apply(
      snap,
      entry(5, "event:spec_req_added", fullUbiquitousReqPayload(3, "REQ-AUTH-001")),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Slice 4 SC1 promotion: DUPLICATE_REQ_ID is now a top-level
      // PreflightFailureCode (mirror Slice 2 SC4 DUPLICATE_TASK_ID).
      expect(result.code).toBe("DUPLICATE_REQ_ID");
      expect(result.message).toMatch(/REQ-AUTH-001/);
    }
  });

  test("event:spec_scenario_added standalone happy + duplicate rejected", () => {
    let snap = seedAtSpecProposalPostSubmit();
    snap = mustOk(
      apply(
        snap,
        entry(4, "event:spec_scenario_added", fullScenarioPayload(2, "SCEN-AUTH-E2E-001")),
      ),
    );
    expect(snap.state!.spec_version).toBe(2);
    expect(snap.scenarios).toHaveLength(1);
    expect(snap.scenarios[0]!.id).toBe("SCEN-AUTH-E2E-001");

    const dup = apply(
      snap,
      entry(5, "event:spec_scenario_added", fullScenarioPayload(2, "SCEN-AUTH-E2E-001")),
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.code).toBe("DUPLICATE_SCEN_ID");
      expect(dup.message).toMatch(/SCEN-AUTH-E2E-001/);
    }
  });

  test("event:spec_visual_added standalone happy + duplicate rejected", () => {
    let snap = seedAtSpecProposalPostSubmit();
    snap = mustOk(
      apply(
        snap,
        entry(4, "event:spec_visual_added", fullVisualPayload(2, "VIS-AUTH-001")),
      ),
    );
    expect(snap.state!.spec_version).toBe(2);
    expect(snap.visual_contracts).toHaveLength(1);
    expect(snap.visual_contracts[0]!.id).toBe("VIS-AUTH-001");

    const dup = apply(
      snap,
      entry(5, "event:spec_visual_added", fullVisualPayload(2, "VIS-AUTH-001")),
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.code).toBe("DUPLICATE_VIS_ID");
      expect(dup.message).toMatch(/VIS-AUTH-001/);
    }
  });

  test("event:spec_submitted with non-monotonic version is rejected", () => {
    let snap = seedAtSpecProposal();
    snap = mustOk(
      apply(snap, entry(3, "event:spec_submitted", fullSubmittedPayload(1))),
    );

    const result = apply(
      snap,
      entry(4, "event:spec_submitted", fullSubmittedPayload(1)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Slice E promotion: SPEC_VERSION_NOT_MONOTONIC from preflight
      // (was reducer message-string under INVALID_PAYLOAD before).
      expect(result.code).toBe("SPEC_VERSION_NOT_MONOTONIC");
      expect(result.message).toMatch(/spec_version must be/);
    }
  });
});

describe("SPEC payload schemas — canonical truth required for replay", () => {
  test("spec_req_added accepts event-driven REQ with full body", () => {
    const snap = seedAtSpecProposalPostSubmit();
    const result = apply(
      snap,
      entry(4, "event:spec_req_added", fullEventDrivenReqPayload(2, "REQ-AUTH-001")),
    );
    expect(result.ok).toBe(true);
  });

  test("spec_req_added rejects event-driven REQ missing trigger (preflight schema gate)", () => {
    const snap = seedAtSpecProposalPostSubmit();
    const result = apply(
      snap,
      entry(4, "event:spec_req_added", {
        spec_version: 2,
        req: {
          id: "REQ-AUTH-001",
          type: "event-driven",
          // trigger intentionally missing
          response: "the system shall attempt to refresh the access token first",
          verified_by_scenarios: ["SCEN-AUTH-E2E-001"],
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/payload schema|trigger/i);
    }
  });

  test("spec_req_added rejects REQ missing all three verifiability options", () => {
    const snap = seedAtSpecProposal();
    const result = apply(
      snap,
      entry(3, "event:spec_req_added", {
        spec_version: 1,
        req: {
          id: "REQ-AUTH-001",
          type: "ubiquitous",
          response: "the system shall do something with no measurable proof at all",
          // no measurable, no verified_by_scenarios, no acceptance_na — must reject
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/payload schema|measurable|verified_by_scenarios|acceptance_na/i);
    }
  });

  test("spec_submitted rejects payload missing adr_refs", () => {
    const snap = seedAtSpecProposal();
    const result = apply(
      snap,
      entry(3, "event:spec_submitted", {
        spec_version: 1,
        feature: { id: "F-001", name: "feat" },
        intent: "twenty char minimum intent string body required by zod min",
        // adr_refs missing — must reject (codex r17 ripple: explicit not defaulted)
        needs_clarification: [],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/payload schema|adr_refs/i);
    }
  });
});

// Slice A SC1 — full spec projection on Snapshot (codex r84 BLOCK → r85
// v2 ack → r86 GO). Adds:
//   - Snapshot.spec_header (feature/intent/adr_refs/needs_clarification)
//   - widened RequirementState / ScenarioState / VisualContractState
//     from slim id-only to full RequirementEarsShape / ScenarioGherkin /
//     VisualContract z.infer types.
// Unblocks SC-A2 spec.md projection writer (composeSpecMdFrontmatter
// becomes a pure function of Snapshot only). spec-lock-check is
// behaviorally unchanged: it reads parsed frontmatter, not snapshot
// arrays (src/core/gates/spec-lock-check.ts:64-214). Only id-only sites
// in reducer / preflight consume snapshot.requirements/scenarios/
// visual_contracts (DUPLICATE_*_ID promotion).

describe("reducer SPEC content full projection — Slice A SC1", () => {
  test("initialSnapshot().spec_header is null", () => {
    const snap = initialSnapshot();
    expect(snap.spec_header).toBeNull();
  });

  test("event:spec_submitted populates spec_header with full header fields", () => {
    const snap = seedAtSpecProposal();
    const next = mustOk(
      apply(snap, entry(3, "event:spec_submitted", fullSubmittedPayload(1))),
    );

    expect(next.spec_header).not.toBeNull();
    expect(next.spec_header!.feature).toEqual({ id: "F-001", name: "OAuth access token refresh" });
    expect(next.spec_header!.intent).toBe("users should not perceive auth recovery flows in flight");
    expect(next.spec_header!.adr_refs).toEqual([]);
    expect(next.spec_header!.needs_clarification).toEqual([]);
  });

  test("event:spec_submitted carries adr_refs[] and needs_clarification[] entries through to spec_header", () => {
    const snap = seedAtSpecProposal();
    const payload = {
      spec_version: 1,
      feature: { id: "F-007", name: "Refresh interceptor" },
      intent: "ensure auth recovery happens transparently across all request paths",
      adr_refs: ["ADR-0042", "ADR-0099"],
      needs_clarification: [
        { id: "NC-001", question: "should refresh be skipped on idempotent GETs?" },
      ],
    };
    const next = mustOk(apply(snap, entry(3, "event:spec_submitted", payload)));

    expect(next.spec_header!.feature.id).toBe("F-007");
    expect(next.spec_header!.adr_refs).toEqual(["ADR-0042", "ADR-0099"]);
    expect(next.spec_header!.needs_clarification).toHaveLength(1);
    expect(next.spec_header!.needs_clarification[0]!.id).toBe("NC-001");
  });

  test("event:spec_submitted re-submit rebuilds spec_header (whole-replacement semantics)", () => {
    let snap = seedAtSpecProposal();
    snap = mustOk(apply(snap, entry(3, "event:spec_submitted", fullSubmittedPayload(1))));
    expect(snap.spec_header!.feature.id).toBe("F-001");

    snap = mustOk(
      apply(
        snap,
        entry(4, "event:spec_submitted", {
          spec_version: 2,
          feature: { id: "F-002", name: "Logout flow hardening" },
          intent: "logout must not leave dangling refresh tokens in storage",
          adr_refs: ["ADR-0007"],
          needs_clarification: [],
        }),
      ),
    );

    // re-submit replaces — not merges
    expect(snap.spec_header!.feature).toEqual({ id: "F-002", name: "Logout flow hardening" });
    expect(snap.spec_header!.intent).toBe("logout must not leave dangling refresh tokens in storage");
    expect(snap.spec_header!.adr_refs).toEqual(["ADR-0007"]);
  });

  // Parameterized over 5 EARS variants. Without this, the widening could
  // accidentally only preserve the happy event-driven case (codex r86
  // explicit concern). Each variant probes a different variant-specific
  // body field that didn't survive the prior slim extractor.

  const EARS_VARIANTS: Array<{
    variant: string;
    payloadFn: (v: number, id: string) => unknown;
    bodyKey: string;
    bodyMatcher: RegExp;
  }> = [
    { variant: "ubiquitous", payloadFn: fullUbiquitousReqPayload, bodyKey: "response", bodyMatcher: /handle the case correctly/ },
    { variant: "event-driven", payloadFn: fullEventDrivenReqPayload, bodyKey: "trigger", bodyMatcher: /HTTP 401/ },
    { variant: "state-driven", payloadFn: fullStateDrivenReqPayload, bodyKey: "while_", bodyMatcher: /session is in flight/ },
    { variant: "optional", payloadFn: fullOptionalReqPayload, bodyKey: "feature", bodyMatcher: /biometric unlock/ },
    { variant: "unwanted", payloadFn: fullUnwantedReqPayload, bodyKey: "condition", bodyMatcher: /empty password field/ },
  ];

  test.each(EARS_VARIANTS)(
    "event:spec_req_added preserves full $variant REQ body in Snapshot.requirements[]",
    ({ payloadFn, bodyKey, bodyMatcher }) => {
      const snap = seedAtSpecProposalPostSubmit();
      const next = mustOk(
        apply(snap, entry(4, "event:spec_req_added", payloadFn(2, "REQ-VAR-001"))),
      );

      const stored = next.requirements[0]! as unknown as Record<string, unknown>;
      expect(stored["id"]).toBe("REQ-VAR-001");
      expect(stored[bodyKey]).toMatch(bodyMatcher);
    },
  );

  test("event:spec_scenario_added preserves full SCEN body (name/given/when/then) in Snapshot.scenarios[]", () => {
    const snap = seedAtSpecProposalPostSubmit();
    const next = mustOk(
      apply(snap, entry(4, "event:spec_scenario_added", fullScenarioPayload(2, "SCEN-AUTH-E2E-001"))),
    );

    const stored = next.scenarios[0]! as unknown as Record<string, unknown>;
    expect(stored["id"]).toBe("SCEN-AUTH-E2E-001");
    expect(stored["name"]).toBe("Expired token recovered by refresh");
    expect(stored["tag"]).toBe("e2e");
    expect(stored["given"]).toEqual(["user has valid refresh token", "access token is expired"]);
    expect(stored["when"]).toEqual(["user opens the order list"]);
    expect(stored["then"]).toEqual(["system refreshes the access token", "order list is displayed"]);
  });

  test("event:spec_visual_added preserves full VIS body (target/checks) in Snapshot.visual_contracts[]", () => {
    const snap = seedAtSpecProposalPostSubmit();
    const next = mustOk(
      apply(snap, entry(4, "event:spec_visual_added", fullVisualPayload(2, "VIS-AUTH-001"))),
    );

    const stored = next.visual_contracts[0]! as unknown as Record<string, unknown>;
    expect(stored["id"]).toBe("VIS-AUTH-001");
    expect(stored["target"]).toBe("Login primary button during refresh in-flight");
    expect(stored["checks"]).toEqual([
      "shows loading spinner inside button",
      "button is disabled to prevent repeated taps",
    ]);
  });
});
