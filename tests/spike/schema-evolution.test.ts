// Spike Gate 4: schema evolution (codex M6).
//
// Append-only logs replay forever. Once events at v=1 are durably written,
// the system must replay them correctly even after schema additions/changes.
//
// Discipline:
//   1. Every event carries `version: number`.
//   2. New event kinds get added with version = (latest). Old kinds keep their version.
//   3. If an old kind's payload changes, BUMP that kind's version + write an upcaster.
//   4. The reducer dispatches on (kind, version). v_old events route through upcaster
//      first → fed to current reducer as v_latest shape.
//
// This file demonstrates the pattern with a synthetic v=0 → v=1 upcaster.
// Real impl would never have v=0; we use it as a fixture for the test.

import { describe, expect, test } from "vitest";
import { project } from "../../src/spike/reducer.js";
import { EVENT_VERSION, type Event, type EvidenceBody } from "../../src/spike/events.js";

// Hypothetical v=0 evidence_added — `description` field instead of `summary`.
interface EvidenceAddedV0 {
  version: 0;
  kind: "evidence_added";
  at: string;
  evidence: Omit<EvidenceBody, "summary"> & { description: string };
}

// Upcaster: v0 → v1. Renames `description` → `summary`.
function upcastEvidenceAddedV0ToV1(v0: EvidenceAddedV0): Event {
  const { description, ...rest } = v0.evidence;
  return {
    version: EVENT_VERSION,
    kind: "evidence_added",
    at: v0.at,
    evidence: {
      ...rest,
      summary: description,
    },
  };
}

// Generic dispatcher.
function loadEvent(raw: { version: number; kind: string } & Record<string, unknown>): Event {
  // Real impl maintains a (kind, version) → upcaster table. Spike inlines.
  if (raw.kind === "evidence_added" && raw.version === 0) {
    return upcastEvidenceAddedV0ToV1(raw as unknown as EvidenceAddedV0);
  }
  if (raw.version === EVENT_VERSION) {
    return raw as unknown as Event;
  }
  throw new Error(`no upcaster for (kind=${raw.kind}, version=${raw.version})`);
}

describe("Gate 4: schema evolution via per-event versioning + upcasters", () => {
  test("v=0 evidence_added upcasts to v=1 and projects correctly", () => {
    const v0Raw = {
      version: 0,
      kind: "evidence_added",
      at: "2026-05-12T10:00:00.000Z",
      evidence: {
        id: "EV-000001",
        kind: "manual" as const,
        result: "passed" as const,
        covers: [],
        actor: "human:est9",
        description: "this used to be a 'description' field in v=0", // ← old shape
      },
    };

    const sessionStart: Event = {
      version: EVENT_VERSION,
      kind: "session_started",
      at: "2026-05-12T09:59:59.000Z",
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "legacy",
      ceremony: {
        spec_phase: false,
        verify_phase: false,
        settle_phase: false,
        strict_spec_review: false,
        lessons_required: "skip",
        strict_drift_check: false,
      },
      ceremony_label: "quick",
    };

    const upcasted = loadEvent(v0Raw);

    expect(upcasted.kind).toBe("evidence_added");
    expect(upcasted.version).toBe(EVENT_VERSION);
    if (upcasted.kind === "evidence_added") {
      expect(upcasted.evidence.summary).toBe("this used to be a 'description' field in v=0");
      expect("description" in upcasted.evidence).toBe(false);
    }

    // Old + new events project through current reducer transparently
    const snapshot = project([sessionStart, upcasted]);
    expect(snapshot.evidence).toHaveLength(1);
    expect(snapshot.evidence[0]!.summary).toContain("this used to be");
  });

  test("unknown version throws — no silent semantic drift", () => {
    expect(() => loadEvent({ version: 99, kind: "evidence_added", at: "2026-05-12T10:00:00.000Z" })).toThrow(/no upcaster/);
  });

  test("v=1 event passes through without upcasting", () => {
    const v1: Event = {
      version: EVENT_VERSION,
      kind: "evidence_added",
      at: "2026-05-12T10:00:00.000Z",
      evidence: {
        id: "EV-000001",
        kind: "manual",
        result: "passed",
        covers: [],
        actor: "human:est9",
        summary: "v1 native",
      },
    };
    const loaded = loadEvent(v1 as unknown as { version: number; kind: string });
    expect(loaded).toEqual(v1);
  });
});
