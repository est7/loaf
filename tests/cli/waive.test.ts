// Phase 16 SC-11 — pure tests for waive payload builder.
//
// Covers (codex r325 P1 Option A — payload only, no journal envelope):
//   - Plan A: covers AND waiver_obligation_id populated
//   - kind=waiver, result=waived, summary auto-synth
//   - reason / actor / iteration / evidenceId injection
//   - shape passes EvidenceFullPayload refine when wrapped in envelope

import { describe, expect, test } from "vitest";

import { buildWaiveEvidencePayload } from "../../src/cli/waive.js";
import { EvidenceFullPayload } from "../../src/core/evidence-schema.js";

describe("buildWaiveEvidencePayload — payload shape", () => {
  test("Plan A: obligation id rides BOTH covers and waiver_obligation_id", () => {
    const payload = buildWaiveEvidencePayload({
      evidenceId: "EV-000042",
      obligationId: "REQ-AUTH-001",
      reason: "manual UX coverage path",
      actor: "human:dev@example.com",
      iteration: 1,
    });
    expect(payload.covers).toEqual(["REQ-AUTH-001"]);
    expect(payload.waiver_obligation_id).toBe("REQ-AUTH-001");
  });

  test("kind=waiver, result=waived (both forced regardless of input)", () => {
    const payload = buildWaiveEvidencePayload({
      evidenceId: "EV-000001",
      obligationId: "T-001",
      reason: "task obligation explicitly waived",
      actor: "human:dev@example.com",
      iteration: 1,
    });
    expect(payload.kind).toBe("waiver");
    expect(payload.result).toBe("waived");
  });

  test("summary auto-synthesized from obligation id (≥3 chars)", () => {
    const payload = buildWaiveEvidencePayload({
      evidenceId: "EV-000001",
      obligationId: "VIS-AUTH-001",
      reason: "no visual surface in this feature",
      actor: "human:dev@example.com",
      iteration: 2,
    });
    expect(payload.summary).toBe("waiver: VIS-AUTH-001");
    expect(payload.summary.length).toBeGreaterThanOrEqual(3);
  });

  test("evidenceId / actor / iteration / reason passed through verbatim", () => {
    const payload = buildWaiveEvidencePayload({
      evidenceId: "EV-000099",
      obligationId: "SCEN-AUTH-E2E-001",
      reason: "covered by manual exploratory testing",
      actor: "human:reviewer@example.com",
      iteration: 3,
    });
    expect(payload.id).toBe("EV-000099");
    expect(payload.actor).toBe("human:reviewer@example.com");
    expect(payload.iteration).toBe(3);
    expect(payload.reason).toBe("covered by manual exploratory testing");
  });

  test("passes EvidenceFullPayload refine (kind=waiver + human:* actor + reason≥10)", () => {
    const payload = buildWaiveEvidencePayload({
      evidenceId: "EV-000007",
      obligationId: "REQ-AUTH-001",
      reason: "manual UX coverage path",
      actor: "human:dev@example.com",
      iteration: 1,
    });
    const result = EvidenceFullPayload.safeParse(payload);
    expect(result.success).toBe(true);
  });

  test("EvidenceFullPayload rejects payload with non-human actor", () => {
    const payload = buildWaiveEvidencePayload({
      evidenceId: "EV-000007",
      obligationId: "REQ-AUTH-001",
      reason: "manual UX coverage path",
      actor: "cli:loaf",
      iteration: 1,
    });
    const result = EvidenceFullPayload.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("EvidenceFullPayload rejects payload with reason <10 chars", () => {
    const payload = buildWaiveEvidencePayload({
      evidenceId: "EV-000007",
      obligationId: "REQ-AUTH-001",
      reason: "too short",
      actor: "human:dev@example.com",
      iteration: 1,
    });
    const result = EvidenceFullPayload.safeParse(payload);
    expect(result.success).toBe(false);
  });
});
