// Verify approval and diagnostics share journal-derived snapshot spec truth.

import type { Diagnostic } from "../error-catalog.js";
import { buildSpecFrontmatterFromSnapshot } from "../spec-snapshot.js";
import type { Snapshot } from "../projection-types.js";
import {
  deriveVerifyLaneApplicability,
  evaluateAllChecks,
  verifyAcceptCheck,
} from "./verify-accept-check.js";
import type {
  PerCheckResult,
  VerifyAcceptResult,
  VerifyLaneApplicability,
} from "./verify-accept-check.js";

/** Alias for downstream readability — same shape as VerifyAcceptResult. */
export type FullVerifyAcceptResult = VerifyAcceptResult;

export function evaluateVerifyAccept(snapshot: Snapshot): FullVerifyAcceptResult {
  const built = buildSpecFrontmatterFromSnapshot(snapshot);
  if (!built.ok)
    return { ok: false, checks: [{ check: 1, code: built.code, detail: built.detail }] };
  return verifyAcceptCheck(snapshot, built.frontmatter);
}

// An invalid canonical spec aborts diagnostics before any check can run.
// Keep the structured failure distinct from the gate's check-1 row.
export type VerifyDiagnosticResult =
  | { ok: true; checks: PerCheckResult[]; lanes: VerifyLaneApplicability[] }
  | ({ ok: false } & Diagnostic<"SPEC_FRONTMATTER_INVALID">);

export function evaluateVerifyAcceptDiagnostic(snapshot: Snapshot): VerifyDiagnosticResult {
  const built = buildSpecFrontmatterFromSnapshot(snapshot);
  if (!built.ok) return built;
  return {
    ok: true,
    checks: evaluateAllChecks(snapshot, built.frontmatter),
    lanes: deriveVerifyLaneApplicability(snapshot, built.frontmatter),
  };
}
