// Snapshot = projection target. All five domains preserved as separate
// projection modules (codex M7 — the 9-file split has real conceptual structure;
// ES keeps the boundaries even if storage is unified).

import type { Phase, SubState, Ceremony, TaskSummary, EvidenceBody, PendingEntryBody } from "./events.js";

export interface Snapshot {
  // Dispatch / liveness — was state.json
  state: {
    session_id: string;
    feature: string;
    phase: Phase;
    sub_state: SubState;
    iteration: number;
    spec_locked: boolean;
    spec_version: number;
    ceremony: Ceremony;
    ceremony_label: string;
    started_at: string;
    updated_at: string;
  } | null;

  // Execution graph — was tasks.json
  tasks: {
    version: number;
    list: TaskSummary[];
  };

  // Proof ledger — was evidence.jsonl
  evidence: EvidenceBody[];

  // Pending FIFO — was state.pending (codex Q6: physical order is canonical)
  pending: PendingEntryBody[];

  // (findings / reconcile / lessons deferred for spike — out of B4 critical path)
}

export function createInitialSnapshot(): Snapshot {
  return {
    state: null,
    tasks: { version: 0, list: [] },
    evidence: [],
    pending: [],
  };
}
