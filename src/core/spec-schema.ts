// Spec schema — shared zod shapes for spec.md frontmatter and journal payloads.
//
// Layering (codex r20 BLOCK fix): structural shape vs verifiability refine
// must be separable. SpecFrontmatter (disk parse) uses the structural shape
// so that a REQ missing measurable/scenarios/acceptance_na slips through
// frontmatter parsing and reaches spec-lock check 5 (MISSING_VERIFIABILITY).
// Journal payloads (PER_KIND_PAYLOAD) compose the verifiable variant so
// that journal append remains strict.
//
// Single source of truth: hasVerifiability() — both the refine in
// RequirementEarsVerifiable AND spec-lock check 5 call this helper, so the
// three-way rule (measurable | verified_by_scenarios[] | acceptance_na +
// reason ≥ 10 chars) is mirrored from docs/schemas.ts §7 in exactly one
// place at runtime.

import { z } from "zod";

// Runtime schema-version pin (mirrored from docs/schemas.ts:417-418, codex
// r21 fix). spec-lock check 1 only accepts the current contract version;
// future / legacy values must fail at frontmatter parse so sub-cycle 3
// gate wiring can't approve an incompatible spec.
export const SCHEMA_VERSION = 2 as const;
export const SchemaVersionPayload = z.literal(SCHEMA_VERSION);

// ── ID regexes (mirrored from docs/schemas.ts §7-9) ─────────────────────

export const ReqIdPayload = z.string().regex(/^REQ-[A-Z][A-Z0-9]*-\d{3,}$/);
export const ScenIdPayload = z.string().regex(/^SCEN-[A-Z][A-Z0-9-]*-\d{3,}$/);
export const VisIdPayload = z.string().regex(/^VIS-[A-Z][A-Z0-9-]*-\d{3,}$/);
export const FeatureIdPayload = z.string().regex(/^F-\d{3,}$/);
export const NcIdPayload = z.string().regex(/^NC-\d{3,}$/);

// ── Measurable + verifiability triad ────────────────────────────────────

export const MeasurablePayload = z
  .object({
    metric: z.string().min(3),
    threshold: z.union([z.string(), z.number()]),
    unit: z.string().optional(),
    direction: z.enum(["lte", "gte", "eq"]).default("lte"),
  })
  .passthrough();

// VerifiabilityFields — the 4 optional fields as a structural shape, NO
// refine. Stacks onto every EARS variant via .and(). The refine that
// enforces "at least one of three" is applied SEPARATELY in
// RequirementEarsVerifiable below.
const VerifiabilityFields = z.object({
  measurable: MeasurablePayload.optional(),
  verified_by_scenarios: z.array(ScenIdPayload).optional(),
  acceptance_na: z.literal(true).optional(),
  acceptance_na_reason: z.string().min(10).optional(),
});

// Single source for the three-way verifiability rule (protocol §4.2 / §5.1
// check 5). Used both by RequirementEarsVerifiable refine (journal append)
// AND by spec-lock-check.ts check 5 (gate evaluator).
export function hasVerifiability(req: {
  measurable?: unknown;
  verified_by_scenarios?: readonly string[] | undefined;
  acceptance_na?: true | undefined;
  acceptance_na_reason?: string | undefined;
}): boolean {
  const hasMeasurable = req.measurable !== undefined;
  const hasScenarios =
    req.verified_by_scenarios !== undefined && req.verified_by_scenarios.length > 0;
  const hasNa = req.acceptance_na === true && (req.acceptance_na_reason?.length ?? 0) >= 10;
  return hasMeasurable || hasScenarios || hasNa;
}

// ── EARS variants — STRUCTURAL shape (no verifiability refine) ──────────
// Used by SpecFrontmatter parsing. Body-shape failures (e.g. event-driven
// missing trigger) DO reject here; verifiability gaps do NOT — those land
// in spec-lock check 5.

const ReqBase = z.object({ id: ReqIdPayload });

const RequirementUbiquitousShape = ReqBase.extend({
  type: z.literal("ubiquitous"),
  response: z.string().min(10),
}).and(VerifiabilityFields);

const RequirementEventDrivenShape = ReqBase.extend({
  type: z.literal("event-driven"),
  trigger: z.string().min(5),
  response: z.string().min(10),
}).and(VerifiabilityFields);

const RequirementStateDrivenShape = ReqBase.extend({
  type: z.literal("state-driven"),
  while_: z.string().min(5),
  behavior: z.string().min(10),
}).and(VerifiabilityFields);

const RequirementOptionalShape = ReqBase.extend({
  type: z.literal("optional"),
  feature: z.string().min(5),
  response: z.string().min(10),
}).and(VerifiabilityFields);

const RequirementUnwantedShape = ReqBase.extend({
  type: z.literal("unwanted"),
  condition: z.string().min(5),
  response: z.string().min(10),
}).and(VerifiabilityFields);

export const RequirementEarsShape = z.union([
  RequirementUbiquitousShape,
  RequirementEventDrivenShape,
  RequirementStateDrivenShape,
  RequirementOptionalShape,
  RequirementUnwantedShape,
]);
export type RequirementEarsShape = z.infer<typeof RequirementEarsShape>;

// ── EARS variants — VERIFIABLE variant (shape + refine) ─────────────────
// Used by journal payloads (SpecReqAddedPayload). Refine fails the parse
// when no verifiability triad — this is the journal-strict gate so loaf
// can't append a REQ that violates protocol §4.2.

export const RequirementEarsVerifiable = RequirementEarsShape.refine(hasVerifiability, {
  message:
    "REQ must declare measurable, verified_by_scenarios[], or acceptance_na+reason (≥10 chars)",
});
export type RequirementEarsVerifiable = z.infer<typeof RequirementEarsVerifiable>;

// ── Scenarios + visual contracts + needs_clarification ──────────────────

export const ScenarioGherkin = z
  .object({
    id: ScenIdPayload,
    name: z.string().min(3),
    tag: z.enum(["happy", "edge", "error", "e2e"]).optional(),
    requires_acceptance: z.boolean().optional(),
    acceptance_na: z.string().min(5).optional(),
    given: z.array(z.string().min(3)).min(1),
    when: z.array(z.string().min(3)).min(1),
    then: z.array(z.string().min(3)).min(1),
  })
  .refine((s) => !(s.tag === "e2e" && s.acceptance_na !== undefined && s.requires_acceptance), {
    message: "cannot set both requires_acceptance and acceptance_na",
  });
export type ScenarioGherkin = z.infer<typeof ScenarioGherkin>;

export const VisualContract = z
  .object({
    id: VisIdPayload,
    target: z.string().min(3),
    checks: z.array(z.string().min(3)).min(1),
    requires_visual: z.boolean().optional(),
    visual_na: z.string().min(5).optional(),
  })
  .passthrough();
export type VisualContract = z.infer<typeof VisualContract>;

export const NeedsClarification = z
  .object({
    id: NcIdPayload,
    question: z.string().min(5),
    context: z.string().optional(),
    options: z.array(z.string()).optional(),
  })
  .passthrough();
export type NeedsClarification = z.infer<typeof NeedsClarification>;

// ── Whole spec.md frontmatter ───────────────────────────────────────────
// Uses RequirementEarsShape (NOT verifiable) so missing-verifiability is
// reachable as spec-lock check 5 rather than swallowed at parse time.

export const SpecFrontmatter = z.object({
  schema_version: SchemaVersionPayload,
  spec_version: z.number().int().positive(),
  feature: z.object({
    id: FeatureIdPayload,
    name: z.string().min(3),
  }),
  intent: z.string().min(20),
  adr_refs: z.array(z.string()),
  requirements: z.array(RequirementEarsShape),
  scenarios: z.array(ScenarioGherkin),
  visual_contracts: z.array(VisualContract).optional(),
  needs_clarification: z.array(NeedsClarification),
});
export type SpecFrontmatter = z.infer<typeof SpecFrontmatter>;

// ── SpecSubmitInput — `loaf spec submit --input` CLI boundary schema ────
//
// Slice 4 SC1 (codex r75 BLOCK fix): typed runtime guard at the CLI
// boundary. Diverges from `SpecFrontmatter` where the submit input
// contract diverges:
//   - `spec_version` is OPTIONAL (CLI fills with current+1 when absent;
//     when present, reducer enforces monotonic via SPEC_VERSION_NOT_MONOTONIC).
//   - `requirements` / `scenarios` / `visual_contracts` /
//     `needs_clarification` / `adr_refs` all default to `[]`.
//   - companions use the strict VERIFIABLE variant (RequirementEarsVerifiable)
//     because they round-trip through journal payloads that already gate
//     on verifiability.
//   - `.passthrough()` (not `.strict()`) so forward-compat extra fields
//     don't break callers; typed fields must match types or surface
//     SCHEMA_VALIDATION_FAILED before mutateBatch.
//
// A caller typo like `spec_version: "2"` or `requirements: "oops"` would
// previously have silently degraded (drop to current+1 / treat as empty)
// — codex r75 BLOCK forces this schema to reject those cases instead.

export const SpecSubmitInput = z
  .object({
    spec_version: z.number().int().positive().optional(),
    feature: z.object({
      id: FeatureIdPayload,
      name: z.string().min(3),
    }),
    intent: z.string().min(20),
    adr_refs: z.array(z.string()).default([]),
    requirements: z.array(RequirementEarsVerifiable).default([]),
    scenarios: z.array(ScenarioGherkin).default([]),
    visual_contracts: z.array(VisualContract).default([]),
    needs_clarification: z.array(NeedsClarification).default([]),
  })
  .passthrough();
export type SpecSubmitInput = z.infer<typeof SpecSubmitInput>;

// ── Slice 4 SC2 — id_namespace input regexes (rev 4.3 / ADR-0004 A5) ────
//
// Input: caller submits a namespace stem (no numeric suffix).
// Output: CLI stamps the canonical full id `<ns>-<3+digits>`.
// Two regexes are intentionally non-overlapping — a full id is NOT a
// legal namespace and vice versa.

export const ReqIdNamespace = z.string().regex(/^REQ-[A-Z][A-Z0-9]*$/);
export const ScenIdNamespace = z.string().regex(/^SCEN-[A-Z][A-Z0-9-]*$/);
export const VisIdNamespace = z.string().regex(/^VIS-[A-Z][A-Z0-9-]*$/);

// SpecAddReqInputItem / SpecAddScenarioInputItem / SpecAddVisualInputItem
// — CLI boundary shape for `loaf spec add-*`. id_namespace replaces the
// full `id` field used by the journal payload variants. The CLI stamps
// the full id (via per-namespace allocator) before emitting the
// event:spec_req_added entry. Heavy verifiability refines still fire at
// journal-append time via RequirementEarsVerifiable / ScenarioGherkin
// / VisualContract — this CLI-side schema only guards the structural
// shape needed for allocation (passthrough on non-id fields).
//
// Single-item or array-of-items both accepted. Array → batch path:
// one mutateBatch with N entries sharing one spec_version, allocator
// advances per-namespace across the batch.

// codex r76 BLOCK fix: refine rejects caller-supplied `id`. The CLI
// allocator owns the full id contract; accepting `id` from input would
// let caller bypass per-namespace allocation and silently desync stdout
// (which prints the allocated id) from journal (which would store the
// caller-supplied id via spread overwrite).
const rejectCallerSuppliedId = <T extends Record<string, unknown>>(v: T): boolean => !("id" in v);
const ID_REJECTION_MESSAGE =
  "id_namespace expected; full id is CLI-allocated and must not be supplied in input";

const SpecAddReqInputItemShape = z
  .object({
    id_namespace: ReqIdNamespace,
    type: z.enum(["ubiquitous", "event-driven", "state-driven", "optional", "unwanted"]),
  })
  .passthrough()
  .refine(rejectCallerSuppliedId, { message: ID_REJECTION_MESSAGE });
export const SpecAddReqInput = z.union([
  SpecAddReqInputItemShape,
  z.array(SpecAddReqInputItemShape).min(1),
]);
export type SpecAddReqInputItem = z.infer<typeof SpecAddReqInputItemShape>;

const SpecAddScenarioInputItemShape = z
  .object({
    id_namespace: ScenIdNamespace,
    name: z.string().min(3),
  })
  .passthrough()
  .refine(rejectCallerSuppliedId, { message: ID_REJECTION_MESSAGE });
export const SpecAddScenarioInput = z.union([
  SpecAddScenarioInputItemShape,
  z.array(SpecAddScenarioInputItemShape).min(1),
]);
export type SpecAddScenarioInputItem = z.infer<typeof SpecAddScenarioInputItemShape>;

const SpecAddVisualInputItemShape = z
  .object({
    id_namespace: VisIdNamespace,
    target: z.string().min(3),
  })
  .passthrough()
  .refine(rejectCallerSuppliedId, { message: ID_REJECTION_MESSAGE });
export const SpecAddVisualInput = z.union([
  SpecAddVisualInputItemShape,
  z.array(SpecAddVisualInputItemShape).min(1),
]);
export type SpecAddVisualInputItem = z.infer<typeof SpecAddVisualInputItemShape>;

/**
 * Per-namespace id allocator: scan existing ids in `existing` for
 * those matching `<namespace>-<digits>`, find max serial, return next.
 * Used by CLI to stamp full ids on add-* invocations.
 */
export function nextSerialInNamespace(existing: readonly string[], namespace: string): number {
  const prefix = `${namespace}-`;
  let max = 0;
  for (const id of existing) {
    if (!id.startsWith(prefix)) continue;
    const tail = id.slice(prefix.length);
    const n = Number.parseInt(tail, 10);
    if (Number.isNaN(n)) continue;
    if (n > max) max = n;
  }
  return max + 1;
}
