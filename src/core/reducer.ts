// Reducer apply path — minimum viable Stage 2.
//
// preflight() (§11.2 step 3) validates authority + transition; apply() (step 7)
// narrows on kind and mutates the projection. Returns Result so callers can
// branch on typed error codes without try/catch.
//
// Stage 2 scope intentionally narrow: handle just enough kinds to demonstrate
// the apply path (`session:started`, `event:phase_advanced`, `gate:decided`).
// Remaining kinds — task lifecycle, evidence, findings, pending, settle, etc.
// — land incrementally in Stages 2-4 alongside their projections.

import type { Ceremony, JournalEntry, SubState } from "./journal-entry.js";
import { preflight } from "./reducer/preflight.js";
import type { PreflightFailureCode } from "./reducer/preflight.js";

export interface SessionState {
  session_id: string;
  feature: string;
  phase: "TRIAGE" | "SPEC" | "EXECUTE" | "VERIFY" | "SETTLE" | "DONE";
  sub_state: SubState;
  iteration: number;
  spec_locked: boolean;
  ceremony: Ceremony;
}

export interface Snapshot {
  state: SessionState | null;
}

export function initialSnapshot(): Snapshot {
  return { state: null };
}

export type ApplyResult =
  | { ok: true; snapshot: Snapshot }
  | {
      ok: false;
      code: PreflightFailureCode | "NO_SESSION" | "ALREADY_STARTED" | "INVALID_PAYLOAD";
      message: string;
      detail?: Record<string, unknown>;
    };

function extractPhase(sub: SubState): SessionState["phase"] {
  const idx = sub.indexOf(".");
  return sub.slice(0, idx) as SessionState["phase"];
}

// Default ceremony used by migration bootstrap when v0.0.x state.json's
// concrete ceremony is not yet rehydrated into the projection (Stage 5 MVP).
const MIGRATION_BOOTSTRAP_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

export function apply(prev: Snapshot, entry: JournalEntry): ApplyResult {
  // migration:snapshot_imported is also a bootstrap kind — it initializes
  // state from a v0.0.x legacy projection. Stage 5 MVP records the entry but
  // defers full projection rehydration (state stays at TRIAGE.score with a
  // default ceremony; the real state lives in attachments/JE-000000/migration/
  // and projection writers in later stages will rehydrate).
  if (entry.kind === "migration:snapshot_imported") {
    if (prev.state !== null) {
      return {
        ok: false,
        code: "ALREADY_STARTED",
        message: "migration:snapshot_imported after state already initialized",
      };
    }
    return {
      ok: true,
      snapshot: {
        state: {
          session_id: "00000000-0000-0000-0000-000000000000",
          feature: "migrated",
          phase: "TRIAGE",
          sub_state: "TRIAGE.score",
          iteration: 1,
          spec_locked: false,
          ceremony: MIGRATION_BOOTSTRAP_CEREMONY,
        },
      },
    };
  }

  // session:started is the bootstrap kind: it initializes state from null.
  if (entry.kind === "session:started") {
    if (prev.state !== null) {
      return {
        ok: false,
        code: "ALREADY_STARTED",
        message: "session:started after state already initialized",
      };
    }
    const payload = entry.payload as {
      session_id?: string;
      feature?: string;
      ceremony?: Ceremony;
    };
    if (!payload.session_id || !payload.feature || !payload.ceremony) {
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: "session:started payload requires session_id, feature, ceremony",
      };
    }
    return {
      ok: true,
      snapshot: {
        state: {
          session_id: payload.session_id,
          feature: payload.feature,
          phase: "TRIAGE",
          sub_state: "TRIAGE.score",
          iteration: 1,
          spec_locked: false,
          ceremony: payload.ceremony,
        },
      },
    };
  }

  // All other kinds require an initialized session.
  if (prev.state === null) {
    return {
      ok: false,
      code: "NO_SESSION",
      message: `kind=${entry.kind} requires a started session`,
    };
  }

  // Preflight (authority + transition) before mutation.
  const pre = preflight(entry, {
    sub_state: prev.state.sub_state,
    tail_seq: entry.seq - 1, // sequence already validated by journal-append
    ceremony: prev.state.ceremony,
  });
  if (!pre.ok) {
    return { ok: false, code: pre.code, message: pre.message, detail: pre.detail ?? {} };
  }

  // Apply per-kind state mutations.
  switch (entry.kind) {
    case "event:phase_advanced": {
      const payload = entry.payload as { to: SubState };
      const next: SessionState = {
        ...prev.state,
        sub_state: payload.to,
        phase: extractPhase(payload.to),
      };
      return { ok: true, snapshot: { state: next } };
    }

    case "gate:decided": {
      const payload = entry.payload as { gate_kind: "spec-lock" | "verify-accept"; decision: string };
      // gate:decided carries an implicit transition (§3.3 table). preflight
      // already validated via validateTransition; we now apply the cursor move.
      if (payload.gate_kind === "spec-lock") {
        return {
          ok: true,
          snapshot: {
            state: {
              ...prev.state,
              sub_state: "EXECUTE.plan",
              phase: "EXECUTE",
              spec_locked: true,
            },
          },
        };
      }
      if (payload.gate_kind === "verify-accept") {
        const target: SubState = prev.state.ceremony.settle_phase
          ? "SETTLE.reconcile"
          : "DONE.delivered";
        return {
          ok: true,
          snapshot: {
            state: {
              ...prev.state,
              sub_state: target,
              phase: extractPhase(target),
            },
          },
        };
      }
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: `gate:decided has unknown gate_kind: ${String(payload.gate_kind)}`,
      };
    }

    default:
      // Stage 2 stub: kinds not yet implemented pass through without mutation,
      // but preflight already vetted authority. Incremental impl lands in
      // Stages 2-4.
      return { ok: true, snapshot: prev };
  }
}
