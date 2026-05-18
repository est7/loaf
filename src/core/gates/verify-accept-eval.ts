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
import type { Snapshot } from "../reducer.js";
import { verifyAcceptCheck } from "./verify-accept-check.js";
import type { VerifyAcceptResult } from "./verify-accept-check.js";

/** Alias for downstream readability — same shape as VerifyAcceptResult. */
export type FullVerifyAcceptResult = VerifyAcceptResult;

export async function evaluateVerifyAccept(
  snapshot: Snapshot,
  featureDir: string,
): Promise<FullVerifyAcceptResult> {
  const read = await readSpecFrontmatter(featureDir);
  if (!read.ok) {
    // ReadSpecResult preserves a specific code (SPEC_NOT_FOUND |
    // SPEC_YAML_INVALID | SPEC_FRONTMATTER_INVALID). The gate result
    // collapses these to a single user-visible code with the read
    // subcode in detail so the catalog template can branch on it.
    return {
      ok: false,
      checks: [
        {
          check: 1,
          code: "SPEC_FRONTMATTER_INVALID",
          message: read.message,
          detail: { subcode: read.code, ...(read.detail ?? {}) },
        },
      ],
    };
  }
  return verifyAcceptCheck(snapshot, read.frontmatter);
}
