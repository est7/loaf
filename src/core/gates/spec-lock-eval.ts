// spec-lock gate evaluator — IO + check-1 mapping wire.
//
// Slice 1.B sub-cycle 3c: composes `readSpecFrontmatter` (disk I/O) with
// `specLockCheck` (pure logic). When the frontmatter read fails, the
// failure is translated into a `check: 1` FailedCheck with the read
// subcode preserved on `detail.subcode` so the caller (mutateBatch wire
// + future CLI surface) can render an actionable diagnostic.
//
// L7: the read+check-1+dispatch body is shared with verify-accept-eval via
// `gateEvalFromCheck`; only the pure check differs.
//
// Module-split rationale (codex r28 GO v2):
//   - `gates/spec-lock-check.ts` = pure stable logic, zero IO, table-tested.
//   - `gates/spec-lock-eval.ts`  = IO boundary, check-1 mapping, called by
//                                   mutateBatch Pass 1.5 + (later) CLI.

import type { Snapshot } from "../projection-types.js";
import { specLockCheck } from "./spec-lock-check.js";
import type { SpecLockResult } from "./spec-lock-check.js";
import { gateEvalFromCheck } from "./gate-eval.js";

/** Alias for downstream readability (codex r28 Q2.2 — same shape). */
export type FullSpecLockResult = SpecLockResult;

const evaluateSpecLockGate = gateEvalFromCheck(specLockCheck);

// Thin `export async function` wrapper (codex L7 Q4): preserves the existing
// exported declaration form / name / hoisting of this public-ish core export
// (used by journal-mutate + CLI) while the IO skeleton lives in the factory.
export async function evaluateSpecLock(
  snapshot: Snapshot,
  featureDir: string,
): Promise<FullSpecLockResult> {
  return evaluateSpecLockGate(snapshot, featureDir);
}
