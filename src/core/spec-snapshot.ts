// Pure canonical spec constructor shared by approval and diagnostic readers.
//
// The journal-derived Snapshot is authoritative for approval and diagnostics.

import type { Snapshot } from "./projection-types.js";
import { SCHEMA_VERSION, SpecFrontmatter } from "./spec-schema.js";
import type { Diagnostic } from "./error-catalog.js";

export type SnapshotSpecResult =
  | { ok: true; frontmatter: SpecFrontmatter }
  | ({ ok: false } & Diagnostic<"SPEC_FRONTMATTER_INVALID">);

/** Reconstruct and validate spec content without consulting derived files. */
export function buildSpecFrontmatterFromSnapshot(snapshot: Snapshot): SnapshotSpecResult {
  if (snapshot.state === null || snapshot.spec_header === null) {
    return {
      ok: false,
      code: "SPEC_FRONTMATTER_INVALID",

      detail: {
        source: "snapshot",
        subcode: "SPEC_NOT_FOUND",
        reason: snapshot.state === null ? "session_state_missing" : "spec_header_missing",
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
      code: "SPEC_FRONTMATTER_INVALID",

      detail: {
        source: "snapshot",
        subcode: "SPEC_FRONTMATTER_INVALID",
        issues: parsed.error.issues,
      },
    };
  }

  return { ok: true, frontmatter: parsed.data };
}
