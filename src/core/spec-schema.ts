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
    req.verified_by_scenarios !== undefined &&
    req.verified_by_scenarios.length > 0;
  const hasNa =
    req.acceptance_na === true &&
    (req.acceptance_na_reason?.length ?? 0) >= 10;
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

export const RequirementEarsVerifiable = RequirementEarsShape.refine(
  hasVerifiability,
  { message: "REQ must declare measurable, verified_by_scenarios[], or acceptance_na+reason (≥10 chars)" },
);
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
  .refine(
    (s) => !(s.tag === "e2e" && s.acceptance_na !== undefined && s.requires_acceptance),
    { message: "cannot set both requires_acceptance and acceptance_na" },
  );
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
