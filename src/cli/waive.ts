// Phase 16 SC-11 — `loaf waive <obligation-id> --reason "..."` sugar
// over `evidence:added` payload.kind=`waiver`.
//
// Per protocol §10.8:1939:
//   - actor MUST be human:* (existing EvidenceFullPayload refine)
//   - reason MUST be ≥10 chars (existing refine)
//   - result is forced to "waived"
//   - obligation id rides BOTH `covers` and `waiver_obligation_id`
//     (codex r321 Q1 Plan A — preserves canSatisfy + explicit linkage)
//
// PURE payload builder (codex r325 P1 Option A): returns the
// EvidenceFullPayload-shaped payload object; `src/cli.tsx` action owns
// the journal envelope (`at` / top-level `actor` / `entry_schema_version` /
// `kind`) construction before calling `mutate()`.

export interface BuildWaiveEvidenceArgs {
  /** Pre-allocated EV-id (via allocateNextEvidenceId). */
  evidenceId: string;
  /** CoversRefPayload-validated obligation id (REQ-/SCEN-/VIS-/T-). */
  obligationId: string;
  /** ≥10-char reason — CLI rejects shorter upstream, refine catches drift. */
  reason: string;
  /** Resolved human:* actor (via resolveHumanActor). */
  actor: string;
  /** Current session iteration. */
  iteration: number;
}

export function buildWaiveEvidencePayload(args: BuildWaiveEvidenceArgs): {
  id: string;
  kind: "waiver";
  iteration: number;
  actor: string;
  result: "waived";
  reason: string;
  summary: string;
  covers: string[];
  waiver_obligation_id: string;
} {
  return {
    id: args.evidenceId,
    kind: "waiver",
    iteration: args.iteration,
    actor: args.actor,
    result: "waived",
    reason: args.reason,
    // ≥3 char SummaryField satisfied; obligation id length is the floor
    summary: `waiver: ${args.obligationId}`,
    // Plan A — both fields populated (codex r321 Q1)
    covers: [args.obligationId],
    waiver_obligation_id: args.obligationId,
  };
}
