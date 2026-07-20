// Pure replay constructor for the spec-lock evaluator.
//
// The journal-derived Snapshot is authoritative for read-side diagnostics.
// Gate approval retains its historical spec.md semantics by projecting parsed
// frontmatter into a transient Snapshot before calling this same constructor.

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
 * Compatibility adapter for the gate IO path. It projects an already parsed
 * spec.md frontmatter value into a transient snapshot view, after which the
 * gate uses the same replay constructor as read-side diagnostics. This keeps
 * the historical gate behavior for a divergent derived file without teaching
 * the checker or constructor about file IO.
 */
export function withSpecFrontmatterProjection(
  snapshot: Snapshot,
  frontmatter: SpecFrontmatter,
): Snapshot {
  if (snapshot.state === null) return snapshot;
  return {
    ...snapshot,
    state: { ...snapshot.state, spec_version: frontmatter.spec_version },
    spec_header: {
      feature: frontmatter.feature,
      intent: frontmatter.intent,
      adr_refs: frontmatter.adr_refs,
      needs_clarification: frontmatter.needs_clarification,
    },
    requirements: frontmatter.requirements,
    scenarios: frontmatter.scenarios,
    visual_contracts: frontmatter.visual_contracts ?? [],
  };
}

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
        message: "snapshot has no projected spec; submit a spec before evaluating spec-lock",
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
        message: "snapshot spec projection failed SpecFrontmatter schema validation",
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
