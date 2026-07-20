// verify-accept gate evaluator — IO + spec.md frontmatter mapping wire.
//
// Slice 1.C sub-cycle 4: composes `readSpecFrontmatter` (disk I/O) with
// `verifyAcceptCheck` (pure logic). When the frontmatter read fails, the
// failure is translated into a `check: 1` FailedCheck with the read
// subcode preserved on `detail.subcode` so the caller (mutateBatch wire
// Slice 1.C sub-cycle 5 + CLI surface sub-cycle 6) can render an
// actionable diagnostic.
//
// Mirrors src/core/gates/spec-lock-eval.ts (Slice 1.B sub-cycle 3c).
//
// Module-split rationale:
//   - `gates/verify-accept-check.ts` = pure stable logic, zero IO, table-tested
//   - `gates/verify-accept-eval.ts`  = IO boundary, spec.md read mapping,
//                                       called by mutateBatch Pass 1.5 + CLI
//
// SpecFrontmatter is required by check 1/3/5 to derive applicable lanes
// + coverage obligations. Even though much of verify-accept's evaluation
// is snapshot-driven (findings / evidence / tasks), the spec content is
// the canonical source for applicable REQ/SCEN/VIS surface, so a missing
// or invalid spec.md still aborts the gate at check 1 rather than
// silently exempting all coverage obligations.

import { readSpecFrontmatter } from "../spec-frontmatter.js";
import type { Snapshot } from "../projection-types.js";
import { evaluateAllChecks, verifyAcceptCheck } from "./verify-accept-check.js";
import type { PerCheckResult, VerifyAcceptResult } from "./verify-accept-check.js";
import { gateEvalFromCheck } from "./gate-eval.js";

/** Alias for downstream readability — same shape as VerifyAcceptResult. */
export type FullVerifyAcceptResult = VerifyAcceptResult;

// L7: verify gate-mode keeps the gateEvalFromCheck IO factory. spec-lock now
// shares only its check-1 mapper because ticket #12B adds a replay constructor.
// The thin wrapper preserves the exported declaration form of this core export.
const evaluateVerifyAcceptGate = gateEvalFromCheck(verifyAcceptCheck);

export async function evaluateVerifyAccept(
  snapshot: Snapshot,
  featureDir: string,
): Promise<FullVerifyAcceptResult> {
  return evaluateVerifyAcceptGate(snapshot, featureDir);
}

// SC-9a-1: diagnostic eval entry for `loaf verify status` (read-only).
//
// Intentional divergence from evaluateVerifyAccept above (codex r302 lock):
// when spec.md frontmatter is unreadable, return a structured error at the
// IO boundary instead of synthesizing a check-1 row. The diagnostic
// command should not pretend to have evaluated 5 checks when 0 checks
// could actually run.
//
// On success: returns the 5-row PerCheckResult[] from evaluateAllChecks.
// On frontmatter failure: returns `{ok:false, code:"SPEC_FRONTMATTER_INVALID", detail}` —
// caller (src/cli/verify-status.ts) renders exit-2 stderr envelope.
export type VerifyDiagnosticResult =
  | { ok: true; checks: PerCheckResult[] }
  | {
      ok: false;
      code: "SPEC_FRONTMATTER_INVALID";
      message: string;
      detail: Record<string, unknown>;
    };

export async function evaluateVerifyAcceptDiagnostic(
  snapshot: Snapshot,
  featureDir: string,
): Promise<VerifyDiagnosticResult> {
  const read = await readSpecFrontmatter(featureDir);
  if (!read.ok) {
    return {
      ok: false,
      code: "SPEC_FRONTMATTER_INVALID",
      message: read.message,
      detail: { subcode: read.code, ...(read.detail ?? {}) },
    };
  }
  return { ok: true, checks: evaluateAllChecks(snapshot, read.frontmatter) };
}
