// Reducer = the new stable kernel (codex M3 / Q5).
//
// All cross-file invariants from the N-file model become single-snapshot
// invariants after every apply(). On invariant violation, throw with a
// diagnostic code — caller decides whether that's a programming error
// (replaying inconsistent log) or a genuine corruption case.

import { createInitialSnapshot, type Snapshot } from "./snapshot.js";
import type { Event, EvidenceBody, SubState } from "./events.js";

// Legal sub_state transitions (forward edges of the state-machine graph).
// Empty array = terminal. Per design.md §2 phase model — quick bypass +
// standard cycle merged. Back-edges (finding amend-spec / amend-tasks /
// fix-impl / fix-test) are handled outside `advanced` (separate event kinds
// in real impl; not exercised in this spike).
const LEGAL_TRANSITIONS: Record<SubState, readonly SubState[]> = {
  "TRIAGE.score": ["TRIAGE.confirm"],
  "TRIAGE.confirm": ["SPEC.proposal", "EXECUTE.plan"], // standard vs quick
  "SPEC.proposal": ["SPEC.spec"],
  "SPEC.spec": ["SPEC.plan"],
  "SPEC.plan": ["SPEC.design"],
  "SPEC.design": ["EXECUTE.plan"],
  "EXECUTE.plan": ["EXECUTE.work"],
  "EXECUTE.work": ["EXECUTE.done"],
  "EXECUTE.done": ["VERIFY.plan", "DONE.delivered"], // standard vs quick
  "VERIFY.plan": ["VERIFY.run"],
  "VERIFY.run": ["VERIFY.review", "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept"],
  "VERIFY.review": ["VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept"],
  "VERIFY.acceptance": ["VERIFY.visual", "VERIFY.accept"],
  "VERIFY.visual": ["VERIFY.accept"],
  // rev 5.x: settle_phase=true (deep) → SETTLE.reconcile;
  // settle_phase=false (standard) → DONE.delivered via `loaf deliver`.
  // validateTransition picks per ceremony.settle_phase.
  "VERIFY.accept": ["SETTLE.reconcile", "DONE.delivered"],
  "SETTLE.reconcile": ["SETTLE.lessons"],
  "SETTLE.lessons": ["DONE.delivered"],
  "DONE.delivered": [],
  "DONE.archived": [],
  "DONE.abandoned": [],
};

// Always-legal targets: user-explicit panic-eject paths. Per design.md §8.3
// (spike outlets) + §10 (loaf archive / loaf abandon) — these never get
// blocked by the protocol; they require user reason but the state machine
// permits them from any sub_state. (DONE invariants still apply post-transition:
// pending must clear, no in_progress task.)
const ALWAYS_LEGAL_TARGETS: ReadonlySet<SubState> = new Set([
  "DONE.archived",
  "DONE.abandoned",
]);

export class ReducerError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = "ReducerError";
  }
}

const r = (code: string, message: string, detail?: Record<string, unknown>): never => {
  throw new ReducerError(code, message, detail);
};

// apply MUTATES the snapshot in place and returns it. Callers that need
// pre/post comparisons must clone beforehand. This is the spike's deliberate
// trade-off against codex Q5 (reducer perf at scale): immutable per-event
// clone is O(snapshot-size) — over a 10k-event log that's O(N²) total.
// Real impl: same shape, optionally wrap with Immer if FP discipline matters.
export function apply(prev: Snapshot, event: Event): Snapshot {
  const next = prev;

  switch (event.kind) {
    case "session_started": {
      if (next.state !== null) r("ALREADY_STARTED", "session_started after state initialized");
      next.state = {
        session_id: event.session_id,
        feature: event.feature,
        phase: "TRIAGE",
        sub_state: "TRIAGE.score",
        iteration: 1,
        spec_locked: false,
        spec_version: 0,
        ceremony: event.ceremony,
        ceremony_label: event.ceremony_label,
        started_at: event.at,
        updated_at: event.at,
      };
      return next;
    }

    case "spec_submitted": {
      if (next.state === null) r("NO_SESSION", "spec_submitted before session_started");
      if (next.state!.spec_locked) r("SPEC_LOCKED", "spec_submitted after spec_locked", { lock: true });
      if (!next.state!.ceremony.spec_phase) r("SPEC_PHASE_DISABLED", "spec_submitted but ceremony.spec_phase=false");
      next.state!.spec_version = event.spec_version;
      next.state!.updated_at = event.at;
      return next;
    }

    case "spec_locked": {
      if (next.state === null) r("NO_SESSION", "spec_locked before session_started");
      if (next.state!.spec_locked) r("ALREADY_LOCKED", "spec_locked twice");
      if (next.state!.spec_version === 0) r("NO_SPEC", "spec_locked but no spec_submitted yet");
      next.state!.spec_locked = true;
      next.state!.updated_at = event.at;
      return next;
    }

    case "tasks_submitted": {
      if (next.state === null) r("NO_SESSION", "tasks_submitted before session_started");
      if (next.state!.spec_locked && event.tasks_version <= next.tasks.version) {
        r("POST_LOCK_REPLACE", "tasks_submitted with non-incrementing version after spec_locked");
      }
      // Validate task IDs are unique
      const seen = new Set<string>();
      for (const t of event.tasks) {
        if (seen.has(t.id)) r("DUPLICATE_TASK_ID", `task ${t.id} appears twice`);
        seen.add(t.id);
      }
      // Validate depends_on references exist within batch
      for (const t of event.tasks) {
        for (const dep of t.depends_on) {
          if (!seen.has(dep)) r("DANGLING_DEP", `task ${t.id} depends_on ${dep} (not in batch)`);
        }
      }
      next.tasks.version = event.tasks_version;
      // Deep-clone task entries — they get mutated later by task_claimed,
      // step_done. Without this, snapshot shares object refs with the event
      // payload, and replaying the same event array twice produces wrong
      // results (codex review-3 M5 isolation guard).
      next.tasks.list = structuredClone(event.tasks);
      next.state!.updated_at = event.at;
      return next;
    }

    case "task_claimed": {
      if (next.state === null) r("NO_SESSION", "task_claimed before session_started");
      const task = next.tasks.list.find((t) => t.id === event.task_id);
      if (!task) r("UNKNOWN_TASK", `task ${event.task_id} not in tasks list`);
      if (task!.status !== "pending") r("BAD_STATUS_TRANSITION", `claim ${event.task_id}: status=${task!.status}, want=pending`);
      // Verify all depends_on are done (codex's "ready" check at claim time)
      for (const dep of task!.depends_on) {
        const depTask = next.tasks.list.find((t) => t.id === dep);
        if (!depTask) r("DANGLING_DEP", `task ${event.task_id} depends_on ${dep} but ${dep} not in tasks list`);
        if (depTask!.status !== "done") r("DEP_NOT_DONE", `task ${event.task_id} cannot claim: dep ${dep} status=${depTask!.status}`);
      }
      task!.status = "in_progress";
      next.state!.updated_at = event.at;
      return next;
    }

    case "step_done": {
      // The B4-critical event: status mutation + evidence proof in ONE event.
      // Reader projecting this event sees both consistently — never the
      // "new status, old evidence" race window.
      if (next.state === null) r("NO_SESSION", "step_done before session_started");
      const task = next.tasks.list.find((t) => t.id === event.task_id);
      if (!task) r("UNKNOWN_TASK", `step_done on ${event.task_id} not in tasks list`);
      if (task!.status !== "in_progress") r("BAD_STATUS_TRANSITION", `step_done on ${event.task_id}: status=${task!.status}, want=in_progress`);
      // Evidence must cover this task (or one of its drives) — proof discipline.
      const coversOk = event.evidence.covers.some(
        (c) => c === event.task_id || task!.drives.includes(c),
      );
      if (!coversOk) {
        r("EVIDENCE_NOT_COVERING", `step_done evidence ${event.evidence.id} does not cover ${event.task_id} or its drives`, {
          task: event.task_id,
          drives: task!.drives,
          covers: event.evidence.covers,
        });
      }
      // Evidence id monotonic check
      assertEvidenceIdMonotonic(next.evidence, event.evidence);
      next.evidence.push(event.evidence);
      if (event.task_completed) {
        task!.status = "done";
      }
      next.state!.updated_at = event.at;
      return next;
    }

    case "evidence_added": {
      // Independent evidence (waiver, manual note). Does NOT close a step.
      if (next.state === null) r("NO_SESSION", "evidence_added before session_started");
      assertEvidenceIdMonotonic(next.evidence, event.evidence);
      next.evidence.push(event.evidence);
      next.state!.updated_at = event.at;
      return next;
    }

    case "pending_raised": {
      if (next.state === null) r("NO_SESSION", "pending_raised before session_started");
      // Pending id must be unique + monotonic relative to existing queue + resolved log
      // For spike, just enforce uniqueness within current pending queue.
      if (next.pending.some((p) => p.id === event.entry.id)) {
        r("DUPLICATE_PENDING", `pending ${event.entry.id} already in queue`);
      }
      next.pending.push(event.entry);
      next.state!.updated_at = event.at;
      return next;
    }

    case "pending_resolved": {
      if (next.state === null) r("NO_SESSION", "pending_resolved before session_started");
      if (next.pending.length === 0) r("EMPTY_QUEUE", "pending_resolved but queue empty");
      const head = next.pending[0]!;
      if (head.id !== event.pending_id) {
        r("NOT_FIFO_HEAD", `pending_resolved id=${event.pending_id} but head=${head.id}`);
      }
      next.pending.shift(); // strict FIFO pop
      next.state!.updated_at = event.at;
      return next;
    }

    case "advanced": {
      if (next.state === null) r("NO_SESSION", "advanced before session_started");
      if (next.state!.sub_state !== event.from) {
        r("ADVANCE_FROM_MISMATCH", `advanced.from=${event.from} but state.sub_state=${next.state!.sub_state}`);
      }
      // Transition legality (codex review-3 B1 fix): event.to must be a
      // forward edge from event.from, OR an always-legal user-eject target.
      const allowed = LEGAL_TRANSITIONS[event.from] ?? [];
      const isAlwaysLegal = ALWAYS_LEGAL_TARGETS.has(event.to);
      if (!allowed.includes(event.to) && !isAlwaysLegal) {
        r("TRANSITION_ILLEGAL", `cannot advance ${event.from} → ${event.to}`, {
          from: event.from,
          to: event.to,
          allowed_forward: [...allowed],
          always_legal: [...ALWAYS_LEGAL_TARGETS],
        });
      }
      // rev 5.x — ceremony guard on VERIFY.accept fork:
      //   settle_phase=true  (deep)     => MUST go SETTLE.reconcile
      //   settle_phase=false (standard) => MUST go DONE.delivered
      // LEGAL_TRANSITIONS lists both edges so the static graph is honest, but
      // ceremony.settle_phase picks the active branch at runtime. Always-legal
      // user-eject targets (DONE.archived/abandoned) bypass this guard.
      if (event.from === "VERIFY.accept" && !isAlwaysLegal) {
        const settlePhase = next.state!.ceremony.settle_phase;
        if (event.to === "SETTLE.reconcile" && !settlePhase) {
          r("SETTLE_PHASE_DISABLED", "VERIFY.accept → SETTLE.reconcile requires ceremony.settle_phase=true (deep only)", {
            from: event.from,
            to: event.to,
            settle_phase: settlePhase,
          });
        }
        if (event.to === "DONE.delivered" && settlePhase) {
          r("SETTLE_PHASE_BYPASS", "VERIFY.accept → DONE.delivered requires ceremony.settle_phase=false (deep must go through SETTLE)", {
            from: event.from,
            to: event.to,
            settle_phase: settlePhase,
          });
        }
      }
      // Pending head invariant (Q3 minimal): advance blocked if head is
      // gate_decision or profile_escalation. Audit log shouldn't contain such
      // an advance event when blocked, but reducer enforces anyway.
      if (next.pending.length > 0) {
        const headKind = next.pending[0]!.kind;
        if (headKind === "gate_decision" || headKind === "profile_escalation") {
          r("PENDING_BLOCKS_ADVANCE", `advance blocked by pending head kind=${headKind}`);
        }
      }
      // Subspace prefix invariant
      if (!event.to.startsWith(extractPhase(event.to) + ".")) {
        r("INVALID_SUB_STATE_FORMAT", `to=${event.to} not phase-prefixed`);
      }
      // DONE terminal invariant (codex Q4 — preserve as projection invariant)
      if (event.to.startsWith("DONE.")) {
        if (next.pending.length > 0) {
          r("DONE_WITH_PENDING", "cannot enter DONE.* with non-empty pending queue", {
            queue_depth: next.pending.length,
          });
        }
        const inProgress = next.tasks.list.filter((t) => t.status === "in_progress");
        if (inProgress.length > 0) {
          r("DONE_WITH_IN_PROGRESS", "cannot enter DONE.* with in_progress tasks", {
            tasks: inProgress.map((t) => t.id),
          });
        }
      }
      next.state!.phase = extractPhase(event.to);
      next.state!.sub_state = event.to;
      next.state!.iteration = event.iteration;
      next.state!.updated_at = event.at;
      return next;
    }

    default: {
      // Exhaustiveness — TS will complain if a kind isn't handled.
      const _exhaustive: never = event;
      void _exhaustive;
      r("UNKNOWN_EVENT_KIND", "reducer missing case");
      return prev;
    }
  }
}

function extractPhase(subState: string): import("./events.js").Phase {
  const dot = subState.indexOf(".");
  if (dot < 0) throw new ReducerError("INVALID_SUB_STATE", `${subState} has no '.'`);
  return subState.slice(0, dot) as import("./events.js").Phase;
}

function assertEvidenceIdMonotonic(existing: EvidenceBody[], next: EvidenceBody): void {
  // Pull numeric tail from "EV-000125"
  const n = parseInt(next.id.replace(/^EV-0*/, ""), 10);
  if (!Number.isFinite(n)) {
    throw new ReducerError("BAD_EVIDENCE_ID", `cannot parse ${next.id}`);
  }
  for (const e of existing) {
    if (e.id === next.id) {
      throw new ReducerError("DUPLICATE_EVIDENCE_ID", `${next.id} already exists`);
    }
  }
  if (existing.length > 0) {
    const last = existing[existing.length - 1]!;
    const lastN = parseInt(last.id.replace(/^EV-0*/, ""), 10);
    if (n <= lastN) {
      throw new ReducerError("EVIDENCE_ID_NOT_MONOTONIC", `${next.id} <= last ${last.id}`, {
        next: n,
        last: lastN,
      });
    }
  }
}

export function project(events: Event[]): Snapshot {
  // Fresh initial snapshot per project() call — avoids cross-call mutation.
  return events.reduce(apply, createInitialSnapshot());
}

// Re-exports for caller ergonomics.
export type { Snapshot } from "./snapshot.js";
export type { Event, TaskSummary, EvidenceBody, PendingEntryBody } from "./events.js";
