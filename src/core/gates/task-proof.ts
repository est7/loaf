// L6 — the task-proof kernel (A5). "Is a done task proven?" was inlined at TWO
// sites with a DIVERGENT kind-policy: verify-accept check 4
// (verify-accept-check.ts) uses a kind-UNIFORM allow-list, while verify-min
// deliver (preflight.ts) uses a kind-PER-task required list. Both share the same
// mechanism — done-task iteration + the 3-clause evidence predicate (passing +
// covering + accepted-kind) + the bug-RED invariant + waiver as a universal
// escape — and differ ONLY in which evidence kinds count. That difference is the
// injected policy; everything else lives here. NOT a single `hasProof` (codex L6
// plan-first Q3): a per-task helper would leak the iteration + evidence scan back
// into both callers.
//
// The callers keep their own failure codes / messages / detail: evaluateTaskProof
// returns the FINEST verdict (a gap set per done task) and each caller maps gaps
// to its surface. verify-accept emits TASK_DONE_NO_EVIDENCE + BUG_TASK_RED_NOT_
// REGISTERED independently; verify-min short-circuits on the first bug-RED before
// assembling DELIVER_VERIFY_MIN_INCOMPLETE.

import type { Snapshot, TaskState, EvidenceState } from "../projection-types.js";
import { isPassingResult } from "./evidence-result.js";

export type TaskProofGap = "no-passing-evidence" | "bug-red-unregistered";

export interface TaskProofPolicy {
  /** Per-task accepted evidence kinds, EXCLUDING waiver. waiver is a universal
   *  human escape applied by `evaluateTaskProof`, never by a policy — both
   *  callers already accept it unconditionally, so it is evaluator-owned. */
  acceptedKinds(task: TaskState): readonly EvidenceState["kind"][];
}

export interface TaskProofFinding {
  task: TaskState;
  /** Non-empty. Fixed order: `no-passing-evidence` (when present) THEN
   *  `bug-red-unregistered` (when present) — mirrors verify-accept check 4's
   *  push order so its emitted-failure ordering is preserved verbatim. */
  gaps: TaskProofGap[];
}

/**
 * Per done task in `snapshot.tasks` (snapshot order, NOT sorted), compute the
 * proof gaps under `policy`. A task is evidence-proven when some evidence is
 * passing, covers the task, and has an accepted kind (or is a waiver). Returns
 * one finding per done task that has ≥1 gap; proven tasks produce no finding.
 * Iteration order is preserved so callers relying on first-gap-wins
 * (verify-min's bug-RED short-circuit) stay behavior-identical.
 */
export function evaluateTaskProof(snapshot: Snapshot, policy: TaskProofPolicy): TaskProofFinding[] {
  const findings: TaskProofFinding[] = [];
  for (const task of snapshot.tasks) {
    if (task.status !== "done") continue;
    const accepted = policy.acceptedKinds(task);
    const gaps: TaskProofGap[] = [];
    const proven = snapshot.evidence.some(
      (ev) =>
        isPassingResult(ev.result) &&
        ev.covers.includes(task.id) &&
        (accepted.includes(ev.kind) || ev.kind === "waiver"),
    );
    if (!proven) gaps.push("no-passing-evidence");
    if (
      task.kind === "behavioral" &&
      task.labels.includes("bug") &&
      task.red_test_registered !== true
    ) {
      gaps.push("bug-red-unregistered");
    }
    if (gaps.length > 0) findings.push({ task, gaps });
  }
  return findings;
}

// --- the two adapters (two ⇒ real seam) ---

// verify-accept check 4: kind-UNIFORM allow-list (was TASK_ALLOWED_EVIDENCE_KINDS
// in verify-accept-check.ts), waiver-free since waiver is universal here.
const VERIFY_ACCEPT_KINDS: readonly EvidenceState["kind"][] = [
  "task-summary",
  "local-check",
  "manual",
];

export const verifyAcceptPolicy: TaskProofPolicy = {
  acceptedKinds: () => VERIFY_ACCEPT_KINDS,
};

// verify-min deliver (§3.2): kind-PER-task required list (was inline in
// preflight.ts), waiver-free. spike is hard-blocked upstream (DELIVER_SPIKE_TASKS)
// so it never needs an entry → `?? []`. The waiver-free list is also what
// verify-min's DELIVER_VERIFY_MIN_INCOMPLETE message reports as `needs …`.
const VERIFY_MIN_REQUIRED_KINDS: Record<string, readonly EvidenceState["kind"][]> = {
  behavioral: ["local-check"],
  structural: ["local-check"],
  "visual-ui": ["visual-review", "manual"],
  docs: ["task-summary", "manual"],
  chore: ["local-check", "manual", "task-summary"],
};

export const verifyMinPolicy: TaskProofPolicy = {
  acceptedKinds: (task) => VERIFY_MIN_REQUIRED_KINDS[task.kind] ?? [],
};
