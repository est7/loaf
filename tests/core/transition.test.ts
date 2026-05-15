// Stage 2 — validateTransition shared helper (Gate #1, ADR-0005 §10).
//
// Spec source: protocol.md §2.1 + §5.2 + ADR-0005 §3.6.
// `event:phase_advanced` and `gate:decided` apply paths both call this
// helper — no per-kind if/else fork on the transition itself.
//
// Tests verify behavior through the public `validateTransition` API.

import { describe, expect, test } from "vitest";

import { validateTransition } from "../../src/core/reducer/transition.js";
import type { Ceremony } from "../../src/core/journal-entry.js";

const QUICK_CEREMONY: Ceremony = {
  spec_phase: false,
  verify_phase: false,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

const STANDARD_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false, // rev 5.x: standard 砍 SETTLE
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

const DEEP_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: true,
  strict_spec_review: true,
  lessons_required: "must",
  strict_drift_check: true,
};

const ACTOR = "cli:loaf";

describe("validateTransition — Gate #1", () => {
  // ── 2A.1: tracer — valid forward edge passes ───────────────────────────
  test("2A.1. valid forward edge (TRIAGE.score → TRIAGE.confirm)", () => {
    const result = validateTransition("TRIAGE.score", "TRIAGE.confirm", {
      ceremony: QUICK_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(true);
  });

  test("2A.1. invalid forward edge (TRIAGE.score → SPEC.proposal) → TRANSITION_ILLEGAL", () => {
    const result = validateTransition("TRIAGE.score", "SPEC.proposal", {
      ceremony: STANDARD_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TRANSITION_ILLEGAL");
    }
  });

  // ── 2A.2: always-legal user-explicit eject targets (§8.3) ──────────────
  test("2A.2. DONE.archived is reachable from any sub_state (user eject)", () => {
    const result = validateTransition("EXECUTE.plan", "DONE.archived", {
      ceremony: QUICK_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(true);
  });

  test("2A.2. DONE.abandoned is reachable from any sub_state (user eject)", () => {
    const result = validateTransition("SPEC.spec", "DONE.abandoned", {
      ceremony: STANDARD_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(true);
  });

  // ── 2A.3: rev 5.x VERIFY.accept ceremony fork (2x2 matrix) ─────────────
  test("2A.3. VERIFY.accept → DONE.delivered allowed when settle_phase=false (standard)", () => {
    const result = validateTransition("VERIFY.accept", "DONE.delivered", {
      ceremony: STANDARD_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(true);
  });

  test("2A.3. VERIFY.accept → SETTLE.reconcile rejected when settle_phase=false (standard)", () => {
    const result = validateTransition("VERIFY.accept", "SETTLE.reconcile", {
      ceremony: STANDARD_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SETTLE_PHASE_DISABLED");
    }
  });

  test("2A.3. VERIFY.accept → SETTLE.reconcile allowed when settle_phase=true (deep)", () => {
    const result = validateTransition("VERIFY.accept", "SETTLE.reconcile", {
      ceremony: DEEP_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(true);
  });

  test("2A.3. VERIFY.accept → DONE.delivered rejected when settle_phase=true (deep)", () => {
    const result = validateTransition("VERIFY.accept", "DONE.delivered", {
      ceremony: DEEP_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SETTLE_PHASE_BYPASS");
    }
  });

  test("2A.3. DONE.archived eject bypasses ceremony guard from VERIFY.accept", () => {
    // User-explicit eject must not be blocked by ceremony.settle_phase mismatch.
    const result = validateTransition("VERIFY.accept", "DONE.archived", {
      ceremony: DEEP_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(true);
  });
});
