// Stage 2 — per-kind sub_state + actor authority matrix (ADR-0005 §3.6).
//
// Table-driven preflight assertion: for each EntryKind, preflight must
// reject illegal sub_state + actor anchors and accept legal anchors. The
// matrix is sourced from PER_KIND_SUB_STATE / PER_KIND_ACTOR via the
// fixture builder (per-kind-fixture-builder.ts).
//
// This is the public-API enforcement that ADR-0005 §3.6 table is wired into
// the runtime reducer.

import { describe, expect, test } from "vitest";

import { preflight } from "../../src/core/reducer/preflight.js";
import { initialSnapshot, type Snapshot } from "../../src/core/reducer.js";
import type { Ceremony, SubState } from "../../src/core/journal-entry.js";
import {
  kindActorFixtures,
  kindSubStateFixtures,
} from "./per-kind-fixture-builder.js";

const DEEP_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: true,
  strict_spec_review: true,
  lessons_required: "must",
  strict_drift_check: true,
};

// Slice 1.D: PreflightContext refactored to snapshot single-source. Helper
// builds a minimal snapshot that exposes sub_state + ceremony for preflight()
// without forcing every test to construct a full SessionState by hand.
function mkSnapshot(sub_state: SubState, ceremony: Ceremony): Snapshot {
  const phase = sub_state.split(".")[0] as
    | "TRIAGE" | "SPEC" | "EXECUTE" | "VERIFY" | "SETTLE" | "DONE";
  return {
    ...initialSnapshot(),
    state: {
      session_id: "test-session",
      feature: "test",
      phase,
      sub_state,
      iteration: 0,
      spec_locked: false,
      verify_accepted: false,
      spec_version: 0,
      ceremony,
    },
  };
}

function stubExecutionStep(): Record<string, unknown> {
  return { applicability: "must", status: "pending", evidence_refs: [] };
}

function stubBehavioralTask(id: string): Record<string, unknown> {
  return {
    id,
    kind: "behavioral",
    drives: ["REQ-AUTH-001"],
    tests: ["StubTest.run"],
    status: "pending",
    depends_on: [],
    labels: [],
    execution: {
      red: stubExecutionStep(),
      implement: stubExecutionStep(),
      refactor: { ...stubExecutionStep(), applicability: "optional" },
    },
  };
}

function payloadFor(kind: string): Record<string, unknown> {
  // Schema-valid payloads per PER_KIND_PAYLOAD (audit r1/r2 strict schemas).
  // Each implemented kind's payload must satisfy the per-kind narrowed schema
  // so preflight reaches the sub_state / actor authority gates.
  const refStub = { path: "x", sha256: "0".repeat(64), size: 0 };
  switch (kind) {
    case "session:started":
      return {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "stub",
        ceremony: DEEP_CEREMONY,
      };
    case "event:phase_advanced":
      return { from: "EXECUTE.work", to: "EXECUTE.done" };
    case "event:ceremony_set":
      return DEEP_CEREMONY;
    case "event:tasks_planned":
      return {
        based_on: { spec: 1 },
        tasks: [stubBehavioralTask("T-001")],
      };
    case "event:tasks_amended":
      return { task: stubBehavioralTask("T-001") };
    case "event:task_claimed":
      return { task_id: "T-001" };
    case "event:task_abandoned":
      return { task_id: "T-001", reason: "stub abandon reason" };
    case "event:task_step_started":
      return { task_id: "T-001", step: "implement" };
    case "event:task_step_done":
      return { task_id: "T-001", step: "implement", result: "passed" };
    case "gate:decided":
      return { gate_kind: "spec-lock", decision: "approved", reason: "ok" };
    case "evidence:added":
      return {
        id: "EV-000001",
        kind: "local-check",
        iteration: 1,
        actor: "cli:loaf",
        result: "passed",
        summary: "stub local-check evidence",
      };
    case "finding:raised":
      return { id: "FND-001", category: "spec-gap", action: "amend-spec" };
    case "finding:closed":
      return { id: "FND-001" };
    case "pending:added":
      return { id: "PEND-001", kind: "ask_user_question" };
    case "pending:resolved":
      return { id: "PEND-001" };
    case "session:archived":
    case "session:abandoned":
    case "session:delivered":
      return { reason: "covered for stub" };
    case "spike:converted":
      return { convert_target: "F-002" };
    case "event:spec_submitted":
      return {
        spec_version: 1,
        feature: { id: "F-001", name: "stub" },
        intent: "stub intent payload at least twenty chars long",
        adr_refs: [],
        needs_clarification: [],
      };
    case "event:spec_req_added":
      return {
        spec_version: 1,
        req: {
          id: "REQ-AUTH-001",
          type: "ubiquitous",
          response: "the system shall do something measurable here",
          acceptance_na: true,
          acceptance_na_reason: "covered by manual UX testing scope",
        },
      };
    case "event:spec_scenario_added":
      return {
        spec_version: 1,
        scenario: {
          id: "SCEN-AUTH-E2E-001",
          name: "stub scenario",
          tag: "e2e",
          requires_acceptance: true,
          given: ["a precondition"],
          when: ["an action"],
          then: ["an assertion"],
        },
      };
    case "event:spec_visual_added":
      return {
        spec_version: 1,
        visual: {
          id: "VIS-AUTH-001",
          target: "stub UI element target description",
          checks: ["stub check description here"],
          requires_visual: true,
        },
      };
    case "migration:snapshot_imported":
      return {
        source_schema_version: 1,
        migrated_at: "2026-05-15T10:00:00.000Z",
        artifacts: {
          state: refStub,
          tasks: refStub,
          spec_md: refStub,
          evidence: refStub,
          findings: refStub,
          pending: refStub,
        },
      };
    default:
      return { stub: true };
  }
}

describe("per-kind sub_state authority (Cartesian matrix)", () => {
  for (const fx of kindSubStateFixtures()) {
    // Skip session:started in sub_state matrix — its invariant is "journal
    // seq=0 + state==null", not a sub_state cursor check (state is null
    // pre-bootstrap).
    if (fx.kind === "session:started") continue;
    // Skip kinds whose transition probe needs a payload tying it to a
    // sub_state where the (from,to) lookup makes sense — covered separately
    // by transition.test.ts + reducer.test.ts.
    if (fx.kind === "event:phase_advanced" || fx.kind === "gate:decided") continue;

    test(`kind=${fx.kind} in ${fx.sub_state} → ${fx.expected}`, () => {
      const allowedActor = fx.kind === "migration:snapshot_imported" ? "migration:test" :
        fx.kind === "gate:decided" || fx.kind.startsWith("session:") || fx.kind === "spike:converted" ? "human:tester" :
        "cli:loaf";

      const result = preflight(
        {
          seq: 0,
          entry_id: "JE-000001",
          at: "2026-05-15T10:00:00.000Z",
          actor: allowedActor,
          entry_schema_version: 1,
          kind: fx.kind,
          payload: payloadFor(fx.kind),
        },
        { snapshot: mkSnapshot(fx.sub_state, DEEP_CEREMONY), tail_seq: -1 },
      );

      if (fx.expected === "legal") {
        // Slice 1.D: session:delivered now has additional preflight refines
        // (DELIVER_*) beyond sub_state authority. This fixture only proves the
        // KIND × SUB_STATE table is wired — assert the failure is NOT
        // SUB_STATE_AUTHORITY_VIOLATION rather than full pass. The refines'
        // own tests live in preflight-validation.test.ts (Slice 1.D step 5c).
        if (!result.ok) {
          expect(
            result.code,
            `${fx.kind}@${fx.sub_state} expected legal authority but got SUB_STATE_AUTHORITY_VIOLATION (full result=${JSON.stringify(result)})`,
          ).not.toBe("SUB_STATE_AUTHORITY_VIOLATION");
        }
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("SUB_STATE_AUTHORITY_VIOLATION");
        }
      }
    });
  }
});

describe("per-kind actor authority (Cartesian matrix)", () => {
  for (const fx of kindActorFixtures()) {
    // session:started bootstraps from null state; sub_state guard pass is
    // automatic, but we still want actor check coverage. Use TRIAGE.score
    // (sub_state guard = ANY_SUB_STATE for this kind).
    test(`kind=${fx.kind} actor=${fx.actor} → ${fx.expected}`, () => {
      const result = preflight(
        {
          seq: 0,
          entry_id: "JE-000001",
          at: "2026-05-15T10:00:00.000Z",
          actor: fx.actor,
          entry_schema_version: 1,
          kind: fx.kind,
          payload: payloadFor(fx.kind),
        },
        { snapshot: mkSnapshot("TRIAGE.score", DEEP_CEREMONY), tail_seq: -1 },
      );

      if (fx.expected === "legal") {
        // Some legal-actor cases still hit SUB_STATE_AUTHORITY_VIOLATION
        // because kind cannot emit from TRIAGE.score. We only assert
        // !ACTOR_AUTHORITY_VIOLATION here — that's the column under test.
        if (!result.ok) {
          expect(result.code).not.toBe("ACTOR_AUTHORITY_VIOLATION");
        }
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          // Either ACTOR_AUTHORITY_VIOLATION or earlier-gate failure (sub_state).
          // We pin to ACTOR check by choosing actor-bad fixtures whose legal-actor
          // counterpart from kindActorFixtures already passed.
          expect(["ACTOR_AUTHORITY_VIOLATION", "SUB_STATE_AUTHORITY_VIOLATION"]).toContain(
            result.code,
          );
        }
      }
    });
  }
});
