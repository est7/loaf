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

  // ── 2A.3: Slice 1.D — VERIFY.accept fork (rev 5.x → 1.D refactor) ──────
  //
  // After Slice 1.D, `VERIFY.accept → DONE.delivered` is no longer an
  // `event:phase_advanced` edge — `session:delivered` (loaf deliver) owns
  // that transition with its own preflight refines (DELIVER_*). The only
  // remaining `event:phase_advanced` target from VERIFY.accept is
  // SETTLE.reconcile, gated by ceremony.settle_phase AND verify_accepted.
  test("2A.3. VERIFY.accept → DONE.delivered always TRANSITION_ILLEGAL (standard ceremony)", () => {
    // pre-Slice-1.D this returned OK for settle_phase=false; the edge was
    // removed so loaf deliver owns the path through session:delivered.
    const result = validateTransition("VERIFY.accept", "DONE.delivered", {
      ceremony: STANDARD_CEREMONY,
      actor: ACTOR,
      verify_accepted: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSITION_ILLEGAL");
  });

  test("2A.3. VERIFY.accept → DONE.delivered always TRANSITION_ILLEGAL (deep ceremony)", () => {
    // pre-Slice-1.D this returned SETTLE_PHASE_BYPASS; the edge was removed.
    const result = validateTransition("VERIFY.accept", "DONE.delivered", {
      ceremony: DEEP_CEREMONY,
      actor: ACTOR,
      verify_accepted: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSITION_ILLEGAL");
  });

  test("2A.3. VERIFY.accept → SETTLE.reconcile rejected when settle_phase=false (standard)", () => {
    const result = validateTransition("VERIFY.accept", "SETTLE.reconcile", {
      ceremony: STANDARD_CEREMONY,
      actor: ACTOR,
      verify_accepted: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SETTLE_PHASE_DISABLED");
  });

  test("2A.3. VERIFY.accept → SETTLE.reconcile allowed when settle_phase=true + verify_accepted=true (deep)", () => {
    const result = validateTransition("VERIFY.accept", "SETTLE.reconcile", {
      ceremony: DEEP_CEREMONY,
      actor: ACTOR,
      verify_accepted: true,
    });
    expect(result.ok).toBe(true);
  });

  // ── 2A.3b: Slice 1.D — VERIFY.accept → SETTLE.reconcile verify_accepted refine ──
  test("2A.3b. VERIFY.accept → SETTLE.reconcile rejected when verify_accepted=false (deep)", () => {
    const result = validateTransition("VERIFY.accept", "SETTLE.reconcile", {
      ceremony: DEEP_CEREMONY,
      actor: ACTOR,
      verify_accepted: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SETTLE_NOT_ACCEPTED");
  });

  test("2A.3b. VERIFY.accept → SETTLE.reconcile verify_accepted check fires AFTER settle_phase check", () => {
    // settle_phase=false + verify_accepted=false → SETTLE_PHASE_DISABLED wins
    // (ceremony precondition checked first per transition.ts implementation).
    const result = validateTransition("VERIFY.accept", "SETTLE.reconcile", {
      ceremony: STANDARD_CEREMONY,
      actor: ACTOR,
      verify_accepted: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SETTLE_PHASE_DISABLED");
  });

  test("2A.3. DONE.archived eject bypasses ceremony guard from VERIFY.accept", () => {
    // User-explicit eject must not be blocked by ceremony.settle_phase mismatch.
    const result = validateTransition("VERIFY.accept", "DONE.archived", {
      ceremony: DEEP_CEREMONY,
      actor: ACTOR,
      verify_accepted: false,
    });
    expect(result.ok).toBe(true);
  });

  // ── 2A.4: Audit r1 Blocker #2 — TRIAGE.confirm spec_phase fork ──────────
  test("2A.4. TRIAGE.confirm → SPEC.proposal rejected when spec_phase=false (quick)", () => {
    const result = validateTransition("TRIAGE.confirm", "SPEC.proposal", {
      ceremony: QUICK_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SPEC_PHASE_FORK_VIOLATION");
  });

  test("2A.4. TRIAGE.confirm → EXECUTE.plan rejected when spec_phase=true (standard)", () => {
    const result = validateTransition("TRIAGE.confirm", "EXECUTE.plan", {
      ceremony: STANDARD_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SPEC_PHASE_FORK_VIOLATION");
  });

  test("2A.4. TRIAGE.confirm → SPEC.proposal allowed when spec_phase=true (standard)", () => {
    const result = validateTransition("TRIAGE.confirm", "SPEC.proposal", {
      ceremony: STANDARD_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(true);
  });

  test("2A.4. TRIAGE.confirm → EXECUTE.plan allowed when spec_phase=false (quick)", () => {
    const result = validateTransition("TRIAGE.confirm", "EXECUTE.plan", {
      ceremony: QUICK_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(true);
  });

  // ── 2A.5: Audit r1 Blocker #2 — EXECUTE.done verify_phase fork ──────────
  test("2A.5. EXECUTE.done → VERIFY.plan rejected when verify_phase=false (quick/light)", () => {
    const result = validateTransition("EXECUTE.done", "VERIFY.plan", {
      ceremony: QUICK_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("VERIFY_PHASE_FORK_VIOLATION");
  });

  test("2A.5. EXECUTE.done → DONE.delivered always TRANSITION_ILLEGAL (Slice 1.D — `loaf deliver` territory)", () => {
    // pre-Slice-1.D this returned VERIFY_PHASE_FORK_VIOLATION for verify_phase=true.
    // The edge was removed so loaf deliver owns EXECUTE.done → DONE.delivered
    // (gated by DELIVER_VERIFY_MIN_UNAVAILABLE in preflight step 5c).
    const result = validateTransition("EXECUTE.done", "DONE.delivered", {
      ceremony: STANDARD_CEREMONY,
      actor: ACTOR,
      verify_accepted: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSITION_ILLEGAL");
  });

  test("2A.5. EXECUTE.done → VERIFY.plan allowed when verify_phase=true (standard)", () => {
    const result = validateTransition("EXECUTE.done", "VERIFY.plan", {
      ceremony: STANDARD_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(true);
  });

  test("2A.5. EXECUTE.done → DONE.delivered always TRANSITION_ILLEGAL even when verify_phase=false (quick)", () => {
    // pre-Slice-1.D this returned OK for quick ceremony.
    const result = validateTransition("EXECUTE.done", "DONE.delivered", {
      ceremony: QUICK_CEREMONY,
      actor: ACTOR,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSITION_ILLEGAL");
  });

  // ── 2A.6: Slice 1.D — SETTLE.lessons → DONE.delivered edge removed ─────
  test("2A.6. SETTLE.lessons → DONE.delivered always TRANSITION_ILLEGAL (Slice 1.D — `loaf deliver` territory)", () => {
    const result = validateTransition("SETTLE.lessons", "DONE.delivered", {
      ceremony: DEEP_CEREMONY,
      actor: ACTOR,
      verify_accepted: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSITION_ILLEGAL");
  });

  test("2A.6. SETTLE.lessons → DONE.archived still allowed (user eject path)", () => {
    const result = validateTransition("SETTLE.lessons", "DONE.archived", {
      ceremony: DEEP_CEREMONY,
      actor: ACTOR,
      verify_accepted: true,
    });
    expect(result.ok).toBe(true);
  });
});
