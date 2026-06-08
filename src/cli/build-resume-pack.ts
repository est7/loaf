// Phase 16 SC-13a — pure builder for ResumePack snapshot.
//
// Composes the resume-pack from current snapshot + recent journal tail
// IDs, capped at RESUME_PACK_RECENT_CAP. Pure — caller (cli.tsx) owns
// the disk write (atomic tmp+rename) + advisory.
//
// tasks_active_summary derivation (codex r167 Q2 context): state.json
// no longer carries `current_task`/`current_step`, so the resume pack
// re-computes these here from the active set so a fresh session knows
// what was mid-flight. `current_step` is the name of the step whose
// `task.execution.<step>.status === "running"`, or null when no step
// is currently running (e.g. between steps or paused).

import type { Snapshot } from "../core/reducer.js";
import type { JournalEntry } from "../core/journal-entry.js";
import { composeStateProjection } from "../core/projection-writer.js";
import {
  RESUME_PACK_RECENT_CAP,
  type ResumePack,
  type TasksActiveSummary,
} from "../core/resume-pack-schema.js";

export interface BuildResumePackArgs {
  /** Snapshot at the time of handoff. */
  snapshot: Snapshot;
  /** Journal entries — needed by composeStateProjection to derive the
   *  full StateProjection (bucket-C identity fields + timestamps). */
  entries: readonly JournalEntry[];
  /** Handoff timestamp (ISO; injected for deterministic tests). */
  at: string;
  /** Reason for the handoff (≥5 chars; validated upstream). */
  reason: string;
  /** Optional free-form notes. */
  notes?: string;
}

export function buildResumePack(args: BuildResumePackArgs): ResumePack {
  const { snapshot, at, reason } = args;
  const state = snapshot.state;
  if (!state) {
    throw new Error("buildResumePack: snapshot.state is null (no session started)");
  }

  // Active set: tasks status ∈ {ready, in_progress}, plus the currently
  // running step name (where execution.<step>.status === "running") if any.
  const tasksActive: TasksActiveSummary[] = [];
  for (const task of snapshot.tasks) {
    if (task.status !== "ready" && task.status !== "in_progress") continue;
    let currentStep: string | null = null;
    for (const [stepName, step] of Object.entries(task.steps ?? {})) {
      if ((step as { status: string }).status === "running") {
        currentStep = stepName;
        break;
      }
    }
    tasksActive.push({
      task_id: task.id,
      status: task.status,
      current_step: currentStep,
    });
  }

  // Recent IDs: last N from each ledger. Snapshot keeps them ordered by
  // append seq via reducer; we slice the tail.
  const recentEvidenceIds = snapshot.evidence.map((e) => e.id).slice(-RESUME_PACK_RECENT_CAP);
  const recentFindingIds = snapshot.findings.map((f) => f.id).slice(-RESUME_PACK_RECENT_CAP);

  // Compose the full StateProjection (bucket-C identity + timestamps +
  // pending queue) — same path the projection writer uses to emit
  // state.json. ResumePack carries the projection form, not the slim
  // reducer SessionState.
  const stateProjection = composeStateProjection(snapshot, args.entries);
  if (stateProjection === null) {
    throw new Error(
      "buildResumePack: composeStateProjection returned null (state should be non-null at this point)",
    );
  }

  // open_pending: FIFO head of unresolved pending entries from the
  // composed projection's live queue. The projection writer already
  // synthesizes PendingQueueEntry shape from journal — we just take
  // index 0.
  const openPending = stateProjection.pending.length > 0 ? stateProjection.pending[0]! : null;

  return {
    schema_version: 2,
    at,
    session_id: state.session_id,
    reason,
    state_snapshot: stateProjection,
    tasks_active_summary: tasksActive,
    recent_evidence: recentEvidenceIds,
    recent_findings: recentFindingIds,
    open_pending: openPending,
    ...(args.notes !== undefined && { notes: args.notes }),
  };
}
