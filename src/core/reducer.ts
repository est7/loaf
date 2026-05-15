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

import type { Ceremony, EntryKind, JournalEntry, SubState } from "./journal-entry.js";
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

// Per-projection state — reducer mutates these alongside SessionState as
// domain entries (tasks, evidence, findings, pending) land on the journal.

export type TaskStepStatus = "pending" | "running" | "passed" | "failed" | "waived" | "na";

export interface TaskState {
  id: string;
  kind?: string;
  status: "pending" | "in_progress" | "done" | "abandoned";
  steps: Record<string, { status: TaskStepStatus }>;
}

export interface EvidenceState {
  id: string;
  kind: string;
  result?: string;
  covers: string[];
  actor: string;
}

export interface FindingState {
  id: string;
  category: string;
  action: string;
  status: "open" | "closed";
}

export interface PendingState {
  id: string;
  kind: string;
  resolved: boolean;
}

export interface Snapshot {
  state: SessionState | null;
  tasks: TaskState[];
  evidence: EvidenceState[];
  findings: FindingState[];
  pending: PendingState[];
}

export function initialSnapshot(): Snapshot {
  return { state: null, tasks: [], evidence: [], findings: [], pending: [] };
}

export type ApplyResult =
  | { ok: true; snapshot: Snapshot }
  | {
      ok: false;
      code:
        | PreflightFailureCode
        | "NO_SESSION"
        | "ALREADY_STARTED"
        | "INVALID_PAYLOAD"
        | "REDUCER_NOT_IMPLEMENTED"
        | "PENDING_NOT_FOUND"
        | "FINDING_NOT_FOUND";
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
        ...prev,
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
        ...prev,
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
      return { ok: true, snapshot: { ...prev, state: next } };
    }

    case "event:ceremony_set": {
      const payload = entry.payload as Ceremony;
      return {
        ok: true,
        snapshot: { ...prev, state: { ...prev.state, ceremony: payload } },
      };
    }

    case "gate:decided": {
      const payload = entry.payload as { gate_kind: "spec-lock" | "verify-accept"; decision: string };
      if (payload.gate_kind === "spec-lock") {
        return {
          ok: true,
          snapshot: {
            ...prev,
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
            ...prev,
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

    case "event:tasks_planned": {
      // payload: { tasks: TaskSummary[] }
      const payload = entry.payload as { tasks?: Array<{ id: string; kind?: string }> };
      const taskList: TaskState[] = (payload.tasks ?? []).map((t) => {
        const base: TaskState = { id: t.id, status: "pending", steps: {} };
        return t.kind !== undefined ? { ...base, kind: t.kind } : base;
      });
      return { ok: true, snapshot: { ...prev, tasks: taskList } };
    }

    case "event:task_claimed": {
      // payload: { task_id }
      const payload = entry.payload as { task_id?: string };
      if (!payload.task_id) return invalidPayload(entry.kind, "missing task_id");
      const tasks = prev.tasks.map((t) =>
        t.id === payload.task_id ? { ...t, status: "in_progress" as const } : t,
      );
      return { ok: true, snapshot: { ...prev, tasks } };
    }

    case "event:task_step_started": {
      // payload: { task_id, step }
      const payload = entry.payload as { task_id?: string; step?: string };
      if (!payload.task_id || !payload.step) return invalidPayload(entry.kind, "missing task_id/step");
      const tasks = prev.tasks.map((t) =>
        t.id === payload.task_id
          ? { ...t, steps: { ...t.steps, [payload.step!]: { status: "running" as const } } }
          : t,
      );
      return { ok: true, snapshot: { ...prev, tasks } };
    }

    case "event:task_step_done": {
      // payload: { task_id, step, result? }
      const payload = entry.payload as { task_id?: string; step?: string; result?: "passed" | "failed" | "waived" | "na" };
      if (!payload.task_id || !payload.step) return invalidPayload(entry.kind, "missing task_id/step");
      const result = payload.result ?? "passed";
      const tasks = prev.tasks.map((t) =>
        t.id === payload.task_id
          ? { ...t, steps: { ...t.steps, [payload.step!]: { status: result } } }
          : t,
      );
      return { ok: true, snapshot: { ...prev, tasks } };
    }

    case "event:task_abandoned": {
      const payload = entry.payload as { task_id?: string };
      if (!payload.task_id) return invalidPayload(entry.kind, "missing task_id");
      const tasks = prev.tasks.map((t) =>
        t.id === payload.task_id ? { ...t, status: "abandoned" as const } : t,
      );
      return { ok: true, snapshot: { ...prev, tasks } };
    }

    case "evidence:added": {
      const payload = entry.payload as { id?: string; kind?: string; result?: string; covers?: string[]; actor?: string };
      if (!payload.id || !payload.kind) return invalidPayload(entry.kind, "missing id/kind");
      const evBase: EvidenceState = {
        id: payload.id,
        kind: payload.kind,
        covers: payload.covers ?? [],
        actor: payload.actor ?? entry.actor,
      };
      const ev: EvidenceState = payload.result !== undefined ? { ...evBase, result: payload.result } : evBase;
      prev.evidence.push(ev);
      return { ok: true, snapshot: prev };
    }

    case "finding:raised": {
      const payload = entry.payload as { id?: string; category?: string; action?: string };
      if (!payload.id || !payload.category || !payload.action) {
        return invalidPayload(entry.kind, "missing id/category/action");
      }
      const f: FindingState = {
        id: payload.id,
        category: payload.category,
        action: payload.action,
        status: "open",
      };
      prev.findings.push(f);
      return { ok: true, snapshot: prev };
    }

    case "finding:closed": {
      const payload = entry.payload as { id?: string };
      if (!payload.id) return invalidPayload(entry.kind, "missing id");
      const idx = prev.findings.findIndex((f) => f.id === payload.id);
      if (idx === -1) {
        return {
          ok: false,
          code: "FINDING_NOT_FOUND",
          message: `finding:closed references unknown finding id=${payload.id}`,
        };
      }
      const findings = prev.findings.map((f, i) => (i === idx ? { ...f, status: "closed" as const } : f));
      return { ok: true, snapshot: { ...prev, findings } };
    }

    case "pending:added": {
      const payload = entry.payload as { id?: string; kind?: string };
      if (!payload.id || !payload.kind) return invalidPayload(entry.kind, "missing id/kind");
      const p: PendingState = { id: payload.id, kind: payload.kind, resolved: false };
      // Mutating push (apply is the SSoT for snapshot evolution; callers
      // treat the prev reference as consumed). Avoids O(N²) replay cost
      // for long pending queues.
      prev.pending.push(p);
      return { ok: true, snapshot: prev };
    }

    case "pending:resolved": {
      // FIFO: only the head (first unresolved) may be marked resolved per §10.7.
      const payload = entry.payload as { id?: string };
      if (!payload.id) return invalidPayload(entry.kind, "missing id");
      const headIdx = prev.pending.findIndex((p) => !p.resolved);
      if (headIdx === -1) {
        return {
          ok: false,
          code: "PENDING_NOT_FOUND",
          message: `pending:resolved with no pending head`,
        };
      }
      const head = prev.pending[headIdx]!;
      if (head.id !== payload.id) {
        return {
          ok: false,
          code: "PENDING_NOT_FOUND",
          message: `pending:resolved id=${payload.id} does not match head id=${head.id} (FIFO violation)`,
        };
      }
      const pending = prev.pending.map((p, i) =>
        i === headIdx ? { ...p, resolved: true } : p,
      );
      return { ok: true, snapshot: { ...prev, pending } };
    }

    case "session:delivered": {
      return {
        ok: true,
        snapshot: {
          ...prev,
          state: { ...prev.state, sub_state: "DONE.delivered", phase: "DONE" },
        },
      };
    }
    case "session:archived": {
      return {
        ok: true,
        snapshot: {
          ...prev,
          state: { ...prev.state, sub_state: "DONE.archived", phase: "DONE" },
        },
      };
    }
    case "session:abandoned": {
      return {
        ok: true,
        snapshot: {
          ...prev,
          state: { ...prev.state, sub_state: "DONE.abandoned", phase: "DONE" },
        },
      };
    }

    default: {
      // Audit r1 fix #5 — silent no-op was a "pass-through reducer" bug;
      // preflight passed but projection was never mutated. Unimplemented
      // kinds now fail-fast with REDUCER_NOT_IMPLEMENTED so the gap is
      // visible to CI and to the journal-mutate caller.
      const _exhaustive: EntryKind = entry.kind;
      return {
        ok: false,
        code: "REDUCER_NOT_IMPLEMENTED",
        message: `reducer.apply has no handler for kind=${_exhaustive}`,
        detail: { kind: _exhaustive },
      };
    }
  }
}

function invalidPayload(kind: string, reason: string): ApplyResult {
  return {
    ok: false,
    code: "INVALID_PAYLOAD",
    message: `${kind}: ${reason}`,
  };
}
