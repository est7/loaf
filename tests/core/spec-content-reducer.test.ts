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

  test("event:spec_req_added standalone bumps spec_version + appends", () => {
    const snap = seedAtSpecProposal();
    const next = mustOk(
      apply(
        snap,
        entry(3, "event:spec_req_added", fullUbiquitousReqPayload(1, "REQ-AUTH-001")),
      ),
    );
    expect(next.state!.spec_version).toBe(1);
    expect(next.requirements).toHaveLength(1);
    expect(next.requirements[0]!.id).toBe("REQ-AUTH-001");
  });

  test("projection is slim — full body in entry.payload, only slim fields enter Snapshot", () => {
    const snap = seedAtSpecProposal();
    const fullPayload = fullEventDrivenReqPayload(1, "REQ-AUTH-001") as {
      spec_version: number;
      req: { id: string; type: string; trigger: string; response: string; verified_by_scenarios: string[] };
    };

    const next = mustOk(
      apply(snap, entry(3, "event:spec_req_added", fullPayload)),
    );

    // canonical body fields are present in the journal payload (replay source)
    expect(fullPayload.req.trigger).toBe("an API request receives HTTP 401");
    expect(fullPayload.req.response).toMatch(/refresh the access token/);

    // projection is slim — only id/type/verifiability triad, no body fields
    const slim = next.requirements[0]!;
    expect(slim.id).toBe("REQ-AUTH-001");
    expect(slim.type).toBe("event-driven");
    expect(slim.verified_by_scenarios).toEqual(["SCEN-AUTH-E2E-001"]);
    expect((slim as unknown as Record<string, unknown>).trigger).toBeUndefined();
    expect((slim as unknown as Record<string, unknown>).response).toBeUndefined();
  });

  test("event:spec_req_added stale standalone version is rejected", () => {
    let snap = seedAtSpecProposal();
    snap = mustOk(
      apply(
        snap,
        entry(3, "event:spec_req_added", fullUbiquitousReqPayload(1, "REQ-AUTH-001")),
      ),
    );
    expect(snap.state!.spec_version).toBe(1);

    const result = apply(
      snap,
      entry(4, "event:spec_req_added", fullUbiquitousReqPayload(1, "REQ-AUTH-002")),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_PAYLOAD");
      expect(result.message).toMatch(/SPEC_VERSION_NOT_MONOTONIC|not monotonic/);
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
      expect(result.code).toBe("INVALID_PAYLOAD");
      expect(result.message).toMatch(/SPEC_VERSION_BATCH_MISMATCH|batch.*mismatch/i);
    }
  });

  test("event:spec_req_added with duplicate id is rejected", () => {
    let snap = seedAtSpecProposal();
    snap = mustOk(
      apply(
        snap,
        entry(3, "event:spec_req_added", fullUbiquitousReqPayload(1, "REQ-AUTH-001")),
      ),
    );

    const result = apply(
      snap,
      entry(4, "event:spec_req_added", fullUbiquitousReqPayload(2, "REQ-AUTH-001")),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_PAYLOAD");
      expect(result.message).toMatch(/DUPLICATE_REQ_ID|duplicate/i);
    }
  });

  test("event:spec_scenario_added standalone happy + duplicate rejected", () => {
    let snap = seedAtSpecProposal();
    snap = mustOk(
      apply(
        snap,
        entry(3, "event:spec_scenario_added", fullScenarioPayload(1, "SCEN-AUTH-E2E-001")),
      ),
    );
    expect(snap.state!.spec_version).toBe(1);
    expect(snap.scenarios).toHaveLength(1);
    expect(snap.scenarios[0]!.id).toBe("SCEN-AUTH-E2E-001");

    const dup = apply(
      snap,
      entry(4, "event:spec_scenario_added", fullScenarioPayload(2, "SCEN-AUTH-E2E-001")),
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.code).toBe("INVALID_PAYLOAD");
      expect(dup.message).toMatch(/DUPLICATE_SCEN_ID|duplicate/i);
    }
  });

  test("event:spec_visual_added standalone happy + duplicate rejected", () => {
    let snap = seedAtSpecProposal();
    snap = mustOk(
      apply(
        snap,
        entry(3, "event:spec_visual_added", fullVisualPayload(1, "VIS-AUTH-001")),
      ),
    );
    expect(snap.state!.spec_version).toBe(1);
    expect(snap.visual_contracts).toHaveLength(1);
    expect(snap.visual_contracts[0]!.id).toBe("VIS-AUTH-001");

    const dup = apply(
      snap,
      entry(4, "event:spec_visual_added", fullVisualPayload(2, "VIS-AUTH-001")),
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.code).toBe("INVALID_PAYLOAD");
      expect(dup.message).toMatch(/DUPLICATE_VIS_ID|duplicate/i);
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
      expect(result.code).toBe("INVALID_PAYLOAD");
      expect(result.message).toMatch(/SPEC_VERSION_NOT_MONOTONIC|not monotonic/);
    }
  });
});

describe("SPEC payload schemas — canonical truth required for replay", () => {
  test("spec_req_added accepts event-driven REQ with full body", () => {
    const snap = seedAtSpecProposal();
    const result = apply(
      snap,
      entry(3, "event:spec_req_added", fullEventDrivenReqPayload(1, "REQ-AUTH-001")),
    );
    expect(result.ok).toBe(true);
  });

  test("spec_req_added rejects event-driven REQ missing trigger (preflight schema gate)", () => {
    const snap = seedAtSpecProposal();
    const result = apply(
      snap,
      entry(3, "event:spec_req_added", {
        spec_version: 1,
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
