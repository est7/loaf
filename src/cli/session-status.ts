import type { PendingPromptKind, SubState } from "../core/journal-entry.js";

export type SessionStatusBucket = "done" | "blocked" | "running" | "idle";
export type PendingHeadDisplayClass = "decision" | "question";

export interface SessionStatusInput {
  sub_state: SubState;
  pending_queue_depth: number;
  active_tasks: readonly string[];
}

export function classifySessionStatus(row: SessionStatusInput): SessionStatusBucket {
  if (row.sub_state.startsWith("DONE.")) return "done";
  if (row.pending_queue_depth > 0) return "blocked";
  if (row.active_tasks.length > 0) return "running";
  return "idle";
}

export function classifyPendingHead(
  kind: PendingPromptKind | null,
): PendingHeadDisplayClass | null {
  if (kind === null) return null;
  return kind === "gate_decision" || kind === "profile_escalation" ? "decision" : "question";
}
