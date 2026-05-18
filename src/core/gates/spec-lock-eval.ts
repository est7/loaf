// spec-lock gate evaluator — IO + check-1 mapping wire.
//
// Slice 1.B sub-cycle 3c: composes `readSpecFrontmatter` (disk I/O) with
// `specLockCheck` (pure logic). When the frontmatter read fails, the
// failure is translated into a `check: 1` FailedCheck with the read
// subcode preserved on `detail.subcode` so the caller (mutateBatch wire
// + future CLI surface) can render an actionable diagnostic.
//
// Module-split rationale (codex r28 GO v2):
//   - `gates/spec-lock-check.ts` = pure stable logic, zero IO, table-tested.
//   - `gates/spec-lock-eval.ts`  = IO boundary, check-1 mapping, called by
//                                   mutateBatch Pass 1.5 + (later) CLI.

import { readSpecFrontmatter } from "../spec-frontmatter.js";
import type { Snapshot } from "../reducer.js";
import { specLockCheck } from "./spec-lock-check.js";
import type { SpecLockResult } from "./spec-lock-check.js";

/** Alias for downstream readability (codex r28 Q2.2 — same shape). */
export type FullSpecLockResult = SpecLockResult;

export async function evaluateSpecLock(
  snapshot: Snapshot,
  featureDir: string,
): Promise<FullSpecLockResult> {
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
  return specLockCheck(snapshot, read.frontmatter);
}
