// L6 — neutral home for the evidence-result passing predicate. Lifted out of
// verify-accept-check.ts so the task-proof kernel (task-proof.ts) can share it
// without creating an import cycle: verify-accept-check.ts imports
// evaluateTaskProof from task-proof.ts, and task-proof.ts needs isPassingResult;
// keeping isPassingResult in verify-accept-check.ts would make the kernel depend
// on one of its own callers (codex L6 plan-first required adjustment).

import type { EvidenceState } from "../reducer.js";

/** Evidence results that count as a positive proof signal. `waived` is a human
 *  escape; spec-review uses a STRICTER notion (passed/approved only) and does
 *  NOT go through this set. */
export const PASSING_RESULTS = new Set(["passed", "approved", "waived"]);

/** True when an evidence result is a positive proof signal (passed / approved /
 *  waived). undefined (no result yet) is never passing. */
export function isPassingResult(result?: EvidenceState["result"]): boolean {
  return result !== undefined && PASSING_RESULTS.has(result);
}
