// Spec-lock approval and diagnostics share journal-derived snapshot truth.

import type { Snapshot } from "../projection-types.js";
import { buildSpecLockCheckInput } from "./spec-lock-input.js";
import { specLockCheck } from "./spec-lock-check.js";
import type { SpecLockResult } from "./spec-lock-check.js";

/** Alias for downstream readability (codex r28 Q2.2 — same shape). */
export type FullSpecLockResult = SpecLockResult;

/** Evaluate all spec-lock semantics from journal-replayed snapshot state. */
export function evaluateSpecLockFromSnapshot(snapshot: Snapshot): FullSpecLockResult {
  const built = buildSpecLockCheckInput(snapshot);
  if (!built.ok) return { ok: false, checks: [built.failure] };
  return specLockCheck(built.input.snapshot, built.input.frontmatter);
}
