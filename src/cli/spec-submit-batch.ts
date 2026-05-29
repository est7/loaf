// Phase 16 SC-12a-1 — shared `spec submit` batch builder.
//
// Single source for the `event:spec_submitted` + companion entries
// shape, reused by:
//   - `loaf spec submit` (existing; whole-replacement from --input JSON)
//   - `loaf spec edit`   (SC-12a-2; $EDITOR-driven whole-replacement
//                          after frontmatter re-validation)
//
// Per codex r331 P1: CLI owns spec_version stamping — caller passes the
// pre-validated `SpecSubmitInput`, builder fills `spec_version` from
// snapshot when input.spec_version is absent (default path) or honors
// the input value when explicitly set (subject to downstream reducer's
// SPEC_VERSION_NOT_MONOTONIC enforcement at append time).
//
// Per codex r331 P2 / r332 r334: pure module, no IO; caller owns the
// mutate() call. Test surface asserts the partial-entry shape, NOT CLI
// stdout/stderr — keeps the builder below the presentation layer.

import type { Snapshot } from "../core/reducer.js";
import type { SpecSubmitInput } from "../core/spec-schema.js";

export interface BuildSpecSubmitBatchArgs {
  /** Validated SpecSubmitInput (already passed `.safeParse`). */
  input: SpecSubmitInput;
  /** Snapshot at the time of submission — used for spec_version stamping
   *  fallback when `input.spec_version` is undefined. */
  snapshot: Snapshot;
  /** Resolved actor (sub_state-authorized; refines run downstream). */
  actor: string;
  /** ISO timestamp for ALL entries in the batch (shared `at`). */
  now: string;
}

/** Partial mutate-batch entry shape — matches Parameters<typeof
 *  mutateBatch>[0][number] without importing the heavy mutate types. */
export interface SpecSubmitBatchEntry {
  at: string;
  actor: string;
  entry_schema_version: 1;
  kind:
    | "event:spec_submitted"
    | "event:spec_req_added"
    | "event:spec_scenario_added"
    | "event:spec_visual_added";
  payload: Record<string, unknown>;
}

/** Build the canonical spec-submit batch: 1 head `event:spec_submitted`
 *  + N `event:spec_req_added` + M `event:spec_scenario_added` + K
 *  `event:spec_visual_added`. All entries share `at` / `actor` /
 *  `entry_schema_version` / payload's `spec_version`. */
export function buildSpecSubmitBatch(
  args: BuildSpecSubmitBatchArgs,
): SpecSubmitBatchEntry[] {
  const { input, snapshot, actor, now } = args;

  // codex r331 P1 lock: CLI fills with current+1 when absent. When
  // input.spec_version is explicitly set, defer to reducer's monotonic
  // check (SPEC_VERSION_NOT_MONOTONIC at append) — same surface as the
  // pre-refactor inline code at src/cli.tsx:4684.
  const currentVersion = snapshot.state?.spec_version ?? 0;
  const specVersion = input.spec_version ?? currentVersion + 1;

  const entries: SpecSubmitBatchEntry[] = [
    {
      at: now,
      actor,
      entry_schema_version: 1,
      kind: "event:spec_submitted",
      payload: {
        spec_version: specVersion,
        feature: input.feature,
        intent: input.intent,
        adr_refs: input.adr_refs,
        needs_clarification: input.needs_clarification,
      },
    },
  ];

  for (const req of input.requirements) {
    entries.push({
      at: now,
      actor,
      entry_schema_version: 1,
      kind: "event:spec_req_added",
      payload: { spec_version: specVersion, req },
    });
  }
  for (const scen of input.scenarios) {
    entries.push({
      at: now,
      actor,
      entry_schema_version: 1,
      kind: "event:spec_scenario_added",
      payload: { spec_version: specVersion, scenario: scen },
    });
  }
  for (const vis of input.visual_contracts) {
    entries.push({
      at: now,
      actor,
      entry_schema_version: 1,
      kind: "event:spec_visual_added",
      payload: { spec_version: specVersion, visual: vis },
    });
  }

  return entries;
}
