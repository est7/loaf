// Pure replay constructor for the spec-lock evaluator.
//
// The journal-derived Snapshot is authoritative for approval and diagnostics.

import type { Snapshot } from "../projection-types.js";
import { SCHEMA_VERSION, SpecFrontmatter } from "../spec-schema.js";
import type { FailedCheck } from "./spec-lock-check.js";

export type SpecLockCheckInput = {
  snapshot: Snapshot;
  frontmatter: SpecFrontmatter;
};

export type SpecLockCheckInputResult =
  | { ok: true; input: SpecLockCheckInput }
  | { ok: false; failure: FailedCheck };

/**
 * Reconstruct the full spec-lock input from replayed snapshot state.
 * Pure and total: projection absence/drift becomes the check-1 failure shape
 * rather than file IO or an exception.
 */
export function buildSpecLockCheckInput(snapshot: Snapshot): SpecLockCheckInputResult {
  if (snapshot.state === null || snapshot.spec_header === null) {
    return {
      ok: false,
      failure: {
        check: 1,
        code: "SPEC_FRONTMATTER_INVALID",

        detail: {
          source: "snapshot",
          subcode: "SPEC_NOT_FOUND",
          reason: snapshot.state === null ? "session_state_missing" : "spec_header_missing",
        },
      },
    };
  }

  const parsed = SpecFrontmatter.safeParse({
    schema_version: SCHEMA_VERSION,
    spec_version: snapshot.state.spec_version,
    feature: snapshot.spec_header.feature,
    intent: snapshot.spec_header.intent,
    adr_refs: snapshot.spec_header.adr_refs,
    requirements: snapshot.requirements,
    scenarios: snapshot.scenarios,
    visual_contracts: snapshot.visual_contracts,
    needs_clarification: snapshot.spec_header.needs_clarification,
  });
  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        check: 1,
        code: "SPEC_FRONTMATTER_INVALID",

        detail: {
          source: "snapshot",
          subcode: "SPEC_FRONTMATTER_INVALID",
          issues: parsed.error.issues,
        },
      },
    };
  }

  return { ok: true, input: { snapshot, frontmatter: parsed.data } };
}
