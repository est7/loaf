// evidence-compat — Slice 1.C sub-cycle 2.
//
// Port of docs/schemas.ts §16 EVIDENCE_COMPAT + canSatisfy() helper to the
// stable core. Used by gates/verify-accept-check.ts (Slice 1.C sub-cycle 3)
// check 3 (REQ/SCEN/VIS canSatisfy) and future loaf evidence add CLI (Slice 3
// ledger surface).
//
// Mechanical 1:1 mirror of the docs table; tests are table-driven across the
// id-kind × evidence-kind matrix + manual/waiver actor+reason invariants +
// VIS visual-review attachment requirement.

import { describe, expect, test } from "vitest";

import { canSatisfy, parseIdKind, EVIDENCE_COMPAT } from "../../src/core/evidence-compat.js";
import type { IdKind } from "../../src/core/evidence-compat.js";
import type { EvidenceState } from "../../src/core/reducer.js";

const SHA = "a".repeat(64);

function ev(overrides: Partial<EvidenceState> = {}): EvidenceState {
  return {
    id: "EV-000001",
    kind: "task-summary",
    covers: [],
    actor: "cli:loaf",
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────
// parseIdKind — recognize valid coverage-id formats; reject malformed.
// ───────────────────────────────────────────────────────────────────────

describe("parseIdKind", () => {
  test("recognizes REQ-* ids", () => {
    expect(parseIdKind("REQ-AUTH-001")).toBe("REQ");
    expect(parseIdKind("REQ-PAYMENT-999")).toBe("REQ");
  });

  test("recognizes SCEN-* ids", () => {
    expect(parseIdKind("SCEN-AUTH-E2E-001")).toBe("SCEN");
    expect(parseIdKind("SCEN-HAPPY-001")).toBe("SCEN");
  });

  test("recognizes VIS-* ids", () => {
    expect(parseIdKind("VIS-AUTH-001")).toBe("VIS");
    expect(parseIdKind("VIS-DASH-999")).toBe("VIS");
  });

  test("recognizes T-* ids", () => {
    expect(parseIdKind("T-001")).toBe("T");
    expect(parseIdKind("T-999")).toBe("T");
  });

  test("recognizes literal GATE", () => {
    expect(parseIdKind("GATE")).toBe("GATE");
  });

  test("rejects ids that fail the documented regex (REQ without trailing digits)", () => {
    expect(parseIdKind("REQ-AUTH")).toBeNull();
  });

  test("rejects ids with too-short id segment", () => {
    expect(parseIdKind("T-1")).toBeNull();
    expect(parseIdKind("REQ-AUTH-1")).toBeNull();
  });

  test("rejects entirely unknown id prefixes", () => {
    expect(parseIdKind("FOO-001")).toBeNull();
    expect(parseIdKind("REQ001")).toBeNull();
  });

  test("rejects empty / non-string-shaped input", () => {
    expect(parseIdKind("")).toBeNull();
    expect(parseIdKind("gate")).toBeNull();  // case-sensitive — must be literal GATE
  });
});

// ───────────────────────────────────────────────────────────────────────
// EVIDENCE_COMPAT table mirror — matches docs/schemas.ts §16:1800-1824
// ───────────────────────────────────────────────────────────────────────

describe("EVIDENCE_COMPAT table mirror (docs §16:1800-1824)", () => {
  test("REQ allows task-summary / verify-review / spec-review / manual / waiver", () => {
    expect([...EVIDENCE_COMPAT.REQ.allowed]).toEqual([
      "task-summary",
      "verify-review",
      "spec-review",
      "manual",
      "waiver",
    ]);
    expect(EVIDENCE_COMPAT.REQ.manual_requires_reason).toBe(true);
  });

  test("SCEN allows acceptance / manual / waiver", () => {
    expect([...EVIDENCE_COMPAT.SCEN.allowed]).toEqual(["acceptance", "manual", "waiver"]);
    expect(EVIDENCE_COMPAT.SCEN.manual_requires_reason).toBe(true);
  });

  test("VIS allows visual-review / manual / waiver + requires attachment for visual-review", () => {
    expect([...EVIDENCE_COMPAT.VIS.allowed]).toEqual([
      "visual-review",
      "manual",
      "waiver",
    ]);
    expect(EVIDENCE_COMPAT.VIS.manual_requires_reason).toBe(true);
    expect(EVIDENCE_COMPAT.VIS.requires_attachment_for_visual_review).toBe(true);
  });

  test("T allows task-summary / local-check / manual / waiver (no manual reason gate)", () => {
    expect([...EVIDENCE_COMPAT.T.allowed]).toEqual([
      "task-summary",
      "local-check",
      "manual",
      "waiver",
    ]);
    expect(EVIDENCE_COMPAT.T.manual_requires_reason).toBe(false);
  });

  test("GATE allows gate-decision only", () => {
    expect([...EVIDENCE_COMPAT.GATE.allowed]).toEqual(["gate-decision"]);
    expect(EVIDENCE_COMPAT.GATE.manual_requires_reason).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────
// canSatisfy happy paths — each id-kind × allowed evidence-kind pair
// ───────────────────────────────────────────────────────────────────────

describe("canSatisfy — happy paths (allowed evidence kinds)", () => {
  test("task-summary satisfies REQ-*", () => {
    expect(canSatisfy(ev({ kind: "task-summary" }), "REQ-AUTH-001")).toBe(true);
  });

  test("verify-review satisfies REQ-*", () => {
    expect(canSatisfy(ev({ kind: "verify-review" }), "REQ-AUTH-001")).toBe(true);
  });

  test("acceptance satisfies SCEN-*", () => {
    expect(canSatisfy(ev({ kind: "acceptance" }), "SCEN-AUTH-E2E-001")).toBe(true);
  });

  test("visual-review with attachments satisfies VIS-*", () => {
    expect(
      canSatisfy(
        ev({
          kind: "visual-review",
          attachments: [{ path: "shot.png", sha256: SHA, mime: "image/png" }],
        }),
        "VIS-AUTH-001",
      ),
    ).toBe(true);
  });

  test("local-check satisfies T-*", () => {
    expect(canSatisfy(ev({ kind: "local-check" }), "T-001")).toBe(true);
  });

  test("task-summary satisfies T-*", () => {
    expect(canSatisfy(ev({ kind: "task-summary" }), "T-001")).toBe(true);
  });

  test("gate-decision satisfies GATE", () => {
    expect(
      canSatisfy(
        ev({ kind: "gate-decision", actor: "human:reviewer@example.com" }),
        "GATE",
      ),
    ).toBe(true);
  });

  test("manual with human actor + reason ≥10 satisfies REQ-*", () => {
    expect(
      canSatisfy(
        ev({
          kind: "manual",
          actor: "human:tester@example.com",
          reason: "tested the flow manually on staging",
        }),
        "REQ-AUTH-001",
      ),
    ).toBe(true);
  });

  test("waiver with human actor + reason ≥10 satisfies VIS-*", () => {
    expect(
      canSatisfy(
        ev({
          kind: "waiver",
          actor: "human:reviewer@example.com",
          reason: "approved waiver for visual regression",
        }),
        "VIS-AUTH-001",
      ),
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// canSatisfy reject — evidence kind not in allowed list
// ───────────────────────────────────────────────────────────────────────

describe("canSatisfy — kind mismatch rejects", () => {
  test("local-check does NOT satisfy REQ-*", () => {
    expect(canSatisfy(ev({ kind: "local-check" }), "REQ-AUTH-001")).toBe(false);
  });

  test("acceptance does NOT satisfy REQ-* (REQ table excludes it)", () => {
    expect(canSatisfy(ev({ kind: "acceptance" }), "REQ-AUTH-001")).toBe(false);
  });

  test("visual-review does NOT satisfy REQ-*", () => {
    expect(
      canSatisfy(
        ev({
          kind: "visual-review",
          attachments: [{ path: "shot.png", sha256: SHA, mime: "image/png" }],
        }),
        "REQ-AUTH-001",
      ),
    ).toBe(false);
  });

  test("task-summary does NOT satisfy SCEN-*", () => {
    expect(canSatisfy(ev({ kind: "task-summary" }), "SCEN-AUTH-E2E-001")).toBe(false);
  });

  test("acceptance does NOT satisfy VIS-*", () => {
    expect(canSatisfy(ev({ kind: "acceptance" }), "VIS-AUTH-001")).toBe(false);
  });

  test("gate-decision does NOT satisfy T-*", () => {
    expect(canSatisfy(ev({ kind: "gate-decision" }), "T-001")).toBe(false);
  });

  test("local-check does NOT satisfy GATE", () => {
    expect(canSatisfy(ev({ kind: "local-check" }), "GATE")).toBe(false);
  });

  test("manual does NOT satisfy GATE (GATE allows gate-decision only)", () => {
    expect(
      canSatisfy(
        ev({
          kind: "manual",
          actor: "human:tester@example.com",
          reason: "tested the flow manually on staging",
        }),
        "GATE",
      ),
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────
// canSatisfy reject — manual/waiver actor + reason invariants
// ───────────────────────────────────────────────────────────────────────

describe("canSatisfy — manual/waiver actor + reason invariants", () => {
  test("manual without human:* actor rejects (REQ-*)", () => {
    expect(
      canSatisfy(
        ev({
          kind: "manual",
          actor: "cli:loaf",
          reason: "tested the flow manually on staging",
        }),
        "REQ-AUTH-001",
      ),
    ).toBe(false);
  });

  test("manual with human:* actor but reason <10 rejects (REQ-*)", () => {
    expect(
      canSatisfy(
        ev({
          kind: "manual",
          actor: "human:tester@example.com",
          reason: "short",
        }),
        "REQ-AUTH-001",
      ),
    ).toBe(false);
  });

  test("manual with missing reason rejects (REQ-*)", () => {
    expect(
      canSatisfy(
        ev({ kind: "manual", actor: "human:tester@example.com" }),
        "REQ-AUTH-001",
      ),
    ).toBe(false);
  });

  test("waiver without human:* actor rejects (VIS-*)", () => {
    expect(
      canSatisfy(
        ev({
          kind: "waiver",
          actor: "skill:auto-waiver",
          reason: "auto-waived per CI policy",
        }),
        "VIS-AUTH-001",
      ),
    ).toBe(false);
  });

  test("manual on T-* tolerates non-human actor (T table has manual_requires_reason=false)", () => {
    // T table per docs §16:1815-1818 sets manual_requires_reason=false; this
    // means the actor+reason gate does NOT fire for T-* + manual. Future
    // tightening would need to update both docs and this test together.
    expect(
      canSatisfy(
        ev({ kind: "manual", actor: "cli:loaf" }),
        "T-001",
      ),
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// canSatisfy reject — VIS visual-review attachment requirement
// ───────────────────────────────────────────────────────────────────────

describe("canSatisfy — VIS visual-review attachment invariant", () => {
  test("visual-review on VIS-* without attachments rejects", () => {
    expect(
      canSatisfy(ev({ kind: "visual-review" }), "VIS-AUTH-001"),
    ).toBe(false);
  });

  test("visual-review on VIS-* with empty attachments rejects", () => {
    expect(
      canSatisfy(ev({ kind: "visual-review", attachments: [] }), "VIS-AUTH-001"),
    ).toBe(false);
  });

  test("visual-review on VIS-* with ≥1 attachment passes", () => {
    expect(
      canSatisfy(
        ev({
          kind: "visual-review",
          attachments: [{ path: "shot.png", sha256: SHA, mime: "image/png" }],
        }),
        "VIS-AUTH-001",
      ),
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// canSatisfy reject — unknown / malformed coveredId
// ───────────────────────────────────────────────────────────────────────

describe("canSatisfy — unknown coveredId rejects", () => {
  test("unknown id-prefix (FOO-001) rejects regardless of evidence shape", () => {
    expect(canSatisfy(ev({ kind: "task-summary" }), "FOO-001")).toBe(false);
  });

  test("malformed REQ id (too short) rejects", () => {
    expect(canSatisfy(ev({ kind: "task-summary" }), "REQ-1")).toBe(false);
  });

  test("lowercase 'gate' rejects (case-sensitive GATE literal)", () => {
    expect(canSatisfy(ev({ kind: "gate-decision" }), "gate")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────
// IdKind type export — sanity check the union members
// ───────────────────────────────────────────────────────────────────────

describe("IdKind type union (compile-time mirror)", () => {
  test("type IdKind covers REQ / SCEN / VIS / T / GATE", () => {
    const kinds: IdKind[] = ["REQ", "SCEN", "VIS", "T", "GATE"];
    for (const k of kinds) {
      expect(EVIDENCE_COMPAT[k]).toBeDefined();
    }
  });
});
