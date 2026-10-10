// Spec-lock approval and diagnostics share journal-derived snapshot truth.

import type { Snapshot } from "../projection-types.js";
import { buildSpecFrontmatterFromSnapshot } from "../spec-snapshot.js";
import { specLockCheck } from "./spec-lock-check.js";
import type { SpecLockResult } from "./spec-lock-check.js";

/** Alias for downstream readability (codex r28 Q2.2 — same shape). */
export type FullSpecLockResult = SpecLockResult;

/** Evaluate all spec-lock semantics from journal-replayed snapshot state. */
export function evaluateSpecLockFromSnapshot(snapshot: Snapshot): FullSpecLockResult {
  const built = buildSpecFrontmatterFromSnapshot(snapshot);
  if (!built.ok)
    return { ok: false, checks: [{ check: 1, code: built.code, detail: built.detail }] };
  return specLockCheck(snapshot, built.frontmatter);
}
