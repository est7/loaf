// Evidence compatibility — canSatisfy() + EVIDENCE_COMPAT table.
//
// Slice 1.C sub-cycle 2 (codex r33 Q2 lock): canonical compatibility
// policy in a stable core module. Used by:
//   - gates/verify-accept-check.ts (Slice 1.C sub-cycle 3) check 3:
//     every REQ/SCEN/VIS (non *_na) has ≥1 evidence passing canSatisfy()
//   - loaf evidence add CLI (Slice 3 ledger surface) for input-time
//     diagnostic when a covers[] entry doesn't fit the evidence kind
//
// EVIDENCE_COMPAT is the protocol-level compatibility rule table:
//   { idKind → { allowed: EvidenceKind[], manual_requires_reason,
//                requires_attachment_for_visual_review? } }
//
// canSatisfy(evidence, coveredId) returns true iff:
//   1. coveredId parses as a known idKind (REQ-* / SCEN-* / VIS-* / T-* / GATE)
//   2. evidence.kind ∈ rule.allowed
//   3. if evidence.kind ∈ {manual, waiver} AND rule.manual_requires_reason:
//      actor MUST start with "human:" AND reason MUST be ≥ 10 chars
//   4. if idKind === "VIS" AND evidence.kind === "visual-review":
//      attachments MUST be non-empty
//
// Neutral stable core: runtime imports only from evidence-schema (types) +
// spec-schema (ReqId/ScenId/VisId regexes) + task-schema (TaskId regex).
// Type-only `EvidenceState` import from reducer is permitted under
// verbatimModuleSyntax — it does not contribute to the runtime import
// graph. No reverse runtime dependency: gates / journal-entry import from
// here, not vice versa.

import type { EvidenceKind } from "./evidence-schema.js";
import { ReqIdPayload, ScenIdPayload, VisIdPayload } from "./spec-schema.js";
import { TaskIdPayload } from "./task-schema.js";
import type { EvidenceState } from "./reducer.js";

export type IdKind = "REQ" | "SCEN" | "VIS" | "T" | "GATE";

export interface CompatRule {
  readonly allowed: ReadonlyArray<EvidenceKind>;
  readonly manual_requires_reason: boolean;
  readonly requires_attachment_for_visual_review?: boolean;
}

export interface EvidenceCompatibilityMismatch {
  covered_id: string;
  supplied_kind: EvidenceKind;
  allowed_kinds: ReadonlyArray<EvidenceKind>;
}

// Canonical compatibility table. Update this owner if
// the protocol adds an evidence kind or a coverage-id family.
export const EVIDENCE_COMPAT: Record<IdKind, CompatRule> = {
  REQ: {
    allowed: ["task-summary", "verify-review", "spec-review", "manual", "waiver"],
    manual_requires_reason: true,
  },
  SCEN: {
    allowed: ["acceptance", "manual", "waiver"],
    manual_requires_reason: true,
  },
  VIS: {
    allowed: ["visual-review", "manual", "waiver"],
    manual_requires_reason: true,
    requires_attachment_for_visual_review: true,
  },
  T: {
    allowed: ["task-summary", "local-check", "manual", "waiver"],
    manual_requires_reason: false,
  },
  GATE: {
    allowed: ["gate-decision"],
    manual_requires_reason: false,
  },
};

/**
 * Recognize a coverage-id string and map to its IdKind. Returns null for
 * malformed or unknown shapes. Strict — uses the documented regexes
 * from spec-schema / task-schema, so "REQ-bad" returns null (not "REQ").
 */
export function parseIdKind(coveredId: string): IdKind | null {
  if (coveredId === "GATE") return "GATE";
  if (ReqIdPayload.safeParse(coveredId).success) return "REQ";
  if (ScenIdPayload.safeParse(coveredId).success) return "SCEN";
  if (VisIdPayload.safeParse(coveredId).success) return "VIS";
  if (TaskIdPayload.safeParse(coveredId).success) return "T";
  return null;
}

/**
 * Returns true iff the evidence can satisfy the given coverage id per
 * protocol §5.4. Pure function over EvidenceState projection — no IO.
 *
 * Note: EvidenceState may be loosely-populated (legacy migration entries
 * lack reason/attachments). canSatisfy double-checks the projection-level
 * shape even though EvidenceFullPayload enforces it at journal append —
 * defense-in-depth for any caller path that bypasses the schema gate.
 */
export function canSatisfy(evidence: EvidenceState, coveredId: string): boolean {
  const idKind = parseIdKind(coveredId);
  if (idKind === null) return false;

  const rule = EVIDENCE_COMPAT[idKind];
  if (!rule.allowed.includes(evidence.kind)) return false;

  if (evidence.kind === "manual" || evidence.kind === "waiver") {
    if (rule.manual_requires_reason) {
      if (!evidence.actor.startsWith("human:")) return false;
      if (!evidence.reason || evidence.reason.length < 10) return false;
    }
  }

  if (idKind === "VIS" && evidence.kind === "visual-review") {
    if (!evidence.attachments || evidence.attachments.length === 0) return false;
  }

  return true;
}

/**
 * Return the actionable write-time diagnostic payload when `canSatisfy`
 * rejects an evidence/obligation pair. This fulfills the input-time
 * diagnostic promised by this module since Slice 3 while keeping the gate
 * and CLI on the same predicate and compatibility table.
 *
 * The full predicate is evaluated, not kind membership alone. Successful
 * `evidence add` writes have already passed EvidenceFullPayload, so the
 * actor/reason/attachment refinements normally collapse to the same result
 * as membership; retaining the full predicate prevents future drift if a
 * new compatibility condition is added here.
 */
export function evidenceCompatibilityMismatch(
  evidence: EvidenceState,
  coveredId: string,
): EvidenceCompatibilityMismatch | null {
  if (canSatisfy(evidence, coveredId)) return null;
  const idKind = parseIdKind(coveredId);
  if (idKind === null) return null;
  return {
    covered_id: coveredId,
    supplied_kind: evidence.kind,
    allowed_kinds: EVIDENCE_COMPAT[idKind].allowed,
  };
}
