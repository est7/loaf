// Verify gate and diagnostic snapshot boundaries.

import { describe, expect, test } from "vitest";

import {
  evaluateVerifyAccept,
  evaluateVerifyAcceptDiagnostic,
} from "../../../src/core/gates/verify-accept-eval.js";
import { initialSnapshot } from "../../../src/core/reducer.js";
import type { Snapshot } from "../../../src/core/reducer.js";

function execSnapshot(): Snapshot {
  const base = initialSnapshot();
  return {
    ...base,
    state: {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "F-001",
      phase: "VERIFY",
      sub_state: "VERIFY.accept",
      iteration: 1,
      spec_locked: true,
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
    spec_header: {
      feature: { id: "F-001", name: "OAuth refresh" },
      intent: "keep auth invisible during refresh roundtrips",
      adr_refs: [],
      needs_clarification: [],
    },
    requirements: [
      {
        id: "REQ-AUTH-001",
        type: "ubiquitous",
        response: "the system shall preserve the original request after refresh",
        acceptance_na: true,
        acceptance_na_reason: "covered by manual UX walk-through scope",
      },
    ],
    tasks_based_on: { spec: 1 },
  };
}

describe("verify snapshot boundary", () => {
  test.each([
    "session",
    "header",
    "malformed",
  ])("%s spec returns a gate check-1 row and a diagnostic error", (mode) => {
    const snapshot = execSnapshot();
    if (mode === "session") snapshot.state = null;
    else if (mode === "header") snapshot.spec_header = null;
    else snapshot.spec_header!.intent = "short";
    const expectedDetail =
      mode === "malformed"
        ? {
            source: "snapshot",
            subcode: "SPEC_FRONTMATTER_INVALID",
            issues: [expect.objectContaining({ path: ["intent"] })],
          }
        : {
            source: "snapshot",
            subcode: "SPEC_NOT_FOUND",
            reason: mode === "session" ? "session_state_missing" : "spec_header_missing",
          };
    expect(evaluateVerifyAccept(snapshot)).toEqual({
      ok: false,
      checks: [{ check: 1, code: "SPEC_FRONTMATTER_INVALID", detail: expectedDetail }],
    });
    const diagnostic = evaluateVerifyAcceptDiagnostic(snapshot);
    expect(diagnostic).toEqual({
      ok: false,
      code: "SPEC_FRONTMATTER_INVALID",
      detail: expectedDetail,
    });
    expect(diagnostic).not.toHaveProperty("checks");
    expect(diagnostic).not.toHaveProperty("lanes");
  });

  test("valid canonical spec retains the pass shape and five diagnostic rows", () => {
    const snapshot = execSnapshot();
    expect(evaluateVerifyAccept(snapshot)).toEqual({ ok: true });
    const diagnostic = evaluateVerifyAcceptDiagnostic(snapshot);
    expect(diagnostic.ok).toBe(true);
    if (!diagnostic.ok) throw new Error("expected diagnostic evaluation");
    expect(diagnostic.checks.map(({ check }) => check)).toEqual([
      "lane_status",
      "open_findings",
      "coverage",
      "task_evidence",
      "spec_review",
    ]);
    expect(diagnostic.checks.every(({ status }) => status !== "fail")).toBe(true);
    expect(diagnostic.lanes).toHaveLength(4);
  });

  test("an open actionable finding still fails both gate and diagnostic evaluation", () => {
    const snapshot = execSnapshot();
    snapshot.findings.push({
      id: "FND-001",
      category: "impl-defect",
      action: "fix-impl",
      status: "open",
    });
    expect(evaluateVerifyAccept(snapshot)).toEqual({
      ok: false,
      checks: [
        { check: 2, code: "OPEN_FINDINGS_PRESENT", detail: { count: 1, open_ids: ["FND-001"] } },
      ],
    });
    const diagnostic = evaluateVerifyAcceptDiagnostic(snapshot);
    expect(diagnostic.ok).toBe(true);
    if (!diagnostic.ok) throw new Error("expected diagnostic evaluation");
    expect(diagnostic.checks.find(({ check }) => check === "open_findings")).toMatchObject({
      status: "fail",
      failures: [{ check: 2, code: "OPEN_FINDINGS_PRESENT" }],
    });
  });
});
