// spec-lock gate evaluator (protocol §5.1, 3 active checks).
//
// Slice 1.B sub-cycle 2 lands the 3 checks whose data sources are already
// available:
//   - check 2: needs_clarification === []
//   - check 5: every REQ satisfies the three-way verifiability rule
//
// Check 1 (spec.md frontmatter passes SpecFrontmatter schema) is HANDLED BY
// THE CALLER. spec-lock-check assumes a successfully parsed frontmatter
// (codex r20 GO v2 signature lock) — if the caller's `readSpecFrontmatter`
// returned a failure, the caller maps that to gate-result check 1 directly
// without invoking specLockCheck.
//
// Checks 3/4/6/7/8 land in sub-cycle 3 alongside TaskState extension (the
// projection fields TaskState.based_on / drives[] / requires_acceptance /
// visual_contract_refs[] / kind-specific required fields don't exist yet).
//
// Pure, zero-IO. Tests inject parsed SpecFrontmatter fixtures directly.

import type { Snapshot } from "../reducer.js";
import { hasVerifiability } from "../spec-schema.js";
import type { SpecFrontmatter } from "../spec-schema.js";

// FailedCheck.check carries the protocol §5.1 check number (1..8) so future
// expansions stay backward-compatible. Sub-cycle 2 only produces 2/5.
export type FailedCheck = {
  check: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  code: "SPEC_FRONTMATTER_INVALID" | "SPEC_HAS_UNCLARIFIED" | "MISSING_VERIFIABILITY";
  message: string;
  detail?: Record<string, unknown>;
};

export type SpecLockResult =
  | { ok: true }
  | { ok: false; checks: FailedCheck[] };

/**
 * Evaluate the spec-lock gate against an already-parsed frontmatter +
 * current Snapshot. Failures accumulate — multiple checks can fail and all
 * are reported so callers fix everything in one cycle (codex r20).
 *
 * Snapshot is currently unused (checks 3/4/6/7/8 will consume it in
 * sub-cycle 3); declared in signature so the interface is stable across
 * sub-cycle growth.
 */
export function specLockCheck(
  _snapshot: Snapshot,
  frontmatter: SpecFrontmatter,
): SpecLockResult {
  const failures: FailedCheck[] = [];

  // Check 2: needs_clarification === [] (protocol §5.1 #2)
  if (frontmatter.needs_clarification.length > 0) {
    failures.push({
      check: 2,
      code: "SPEC_HAS_UNCLARIFIED",
      message: `spec has ${frontmatter.needs_clarification.length} unresolved needs_clarification entries; resolve or remove them before spec-lock`,
      detail: {
        ids: frontmatter.needs_clarification.map((nc) => nc.id),
      },
    });
  }

  // Check 5: every REQ satisfies three-way verifiability (protocol §5.1 #5)
  for (const req of frontmatter.requirements) {
    if (!hasVerifiability(req)) {
      failures.push({
        check: 5,
        code: "MISSING_VERIFIABILITY",
        message: `${req.id} must declare measurable, verified_by_scenarios[], or acceptance_na+acceptance_na_reason (≥10 chars)`,
        detail: { req_id: req.id, req_type: req.type },
      });
    }
  }

  if (failures.length === 0) return { ok: true };
  return { ok: false, checks: failures };
}
