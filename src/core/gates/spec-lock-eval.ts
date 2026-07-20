// spec-lock gate evaluator — IO + check-1 mapping wire.
//
// Slice 1.B sub-cycle 3c: preserves `readSpecFrontmatter` as the disk I/O
// and check-1 error boundary, then evaluates the replay-derived constructor
// shared with `loaf spec status`. When the frontmatter read fails, the
// failure is translated into a `check: 1` FailedCheck with the read
// subcode preserved on `detail.subcode` so the caller (mutateBatch wire
// + future CLI surface) can render an actionable diagnostic.
//
// Ticket #12B: the query calls evaluateSpecLockFromSnapshot directly. The gate
// keeps this explicit IO adapter to preserve historical derived-file behavior.
//
// Module-split rationale (codex r28 GO v2):
//   - `gates/spec-lock-check.ts` = pure stable logic, zero IO, table-tested.
//   - `gates/spec-lock-eval.ts`  = replay evaluator + gate-only IO adapter.

import type { Snapshot } from "../projection-types.js";
import { readSpecFrontmatter } from "../spec-frontmatter.js";
import {
  buildSpecLockCheckInput,
  withSpecFrontmatterProjection,
} from "./spec-lock-input.js";
import { specLockCheck } from "./spec-lock-check.js";
import type { SpecLockResult } from "./spec-lock-check.js";
import { specReadFailure } from "./gate-eval.js";

/** Alias for downstream readability (codex r28 Q2.2 — same shape). */
export type FullSpecLockResult = SpecLockResult;

/** Evaluate all spec-lock semantics from journal-replayed snapshot state. */
export function evaluateSpecLockFromSnapshot(snapshot: Snapshot): FullSpecLockResult {
  const built = buildSpecLockCheckInput(snapshot);
  if (!built.ok) return { ok: false, checks: [built.failure] };
  return specLockCheck(built.input.snapshot, built.input.frontmatter);
}

// Thin `export async function` wrapper (codex L7 Q4): preserves the existing
// exported declaration form / name / hoisting of this public-ish core export
// (used by journal-mutate + CLI) while the IO skeleton lives in the factory.
export async function evaluateSpecLock(
  snapshot: Snapshot,
  featureDir: string,
): Promise<FullSpecLockResult> {
  // Preserve the existing gate IO/error surface and its historical use of
  // parsed spec.md values. The parsed value is projected into a transient
  // snapshot view, then the shared pure replay constructor runs unchanged.
  const read = await readSpecFrontmatter(featureDir);
  if (!read.ok) return specReadFailure(read);
  return evaluateSpecLockFromSnapshot(withSpecFrontmatterProjection(snapshot, read.frontmatter));
}
