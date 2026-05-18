// Task schema — runtime mirror of docs/schemas.ts §14 (Task discriminated union).
//
// Sub-cycle 3a closes F-010 ripple #1+#2: event:tasks_amended gains a strict
// payload (replacing RecordPayload), event:tasks_planned gains the full
// canonical body (replacing the loose `{ tasks: [{ id, kind? }] }` shape).
// Co-located in this neutral module rather than `journal-entry.ts` because
// the task schema is a sibling domain to the journal envelope.
//
// Layering mirrors spec-schema.ts: strict structural shapes live here;
// reducer extracts a slim projection (TaskState) at apply time.
//
// Canonical truth lives in the journal payload, NOT in the projection —
// `loaf doctor --rebuild` reconstructs tasks.json from these payloads, so
// all body fields (execution.evidence_refs, started_at, etc.) must
// round-trip through the journal.

import { z } from "zod";

import { ReqIdPayload, ScenIdPayload, VisIdPayload } from "./spec-schema.js";

// ── ID + cross-reference regexes ────────────────────────────────────────

export const TaskIdPayload = z.string().regex(/^T-\d{3,}$/);
export const EvidenceRefPayload = z.string().regex(/^EV-\d{6,}$/);

// drives[] accepts any of REQ-* / SCEN-* / VIS-* (per docs/schemas.ts §14
// `DrivesRef`). Spec-lock check 4/6/7 cross-refs against requirements /
// scenarios / visual_contracts projections respectively.
const RawDrivesRef = z.string().regex(/^(REQ|SCEN|VIS)-[A-Z][A-Z0-9-]*-\d{3,}$/);

// Discriminate on prefix without re-parsing — use the typed ID schemas to
// build a union (gives downstream code more precise types).
export const DrivesRefPayload = z.union([ReqIdPayload, ScenIdPayload, VisIdPayload]);
// Keep RawDrivesRef as a fallback for tests that don't need precise typing.
export { RawDrivesRef };

// ── Execution step + per-kind execution schemas ─────────────────────────

export const ApplicabilityPayload = z.enum(["must", "optional", "na"]);
export type ApplicabilityPayload = z.infer<typeof ApplicabilityPayload>;

export const StepStatusPayload = z.enum([
  "na",
  "pending",
  "running",
  "passed",
  "failed",
  "waived",
]);
export type StepStatusPayload = z.infer<typeof StepStatusPayload>;

export const TaskExecutionStepPayload = z.object({
  applicability: ApplicabilityPayload,
  status: StepStatusPayload,
  reason: z.string().optional(),
  evidence_refs: z.array(EvidenceRefPayload).default([]),
  started_at: z.string().datetime().optional(),
});
export type TaskExecutionStepPayload = z.infer<typeof TaskExecutionStepPayload>;

export const BehavioralExecutionPayload = z.object({
  red: TaskExecutionStepPayload,
  implement: TaskExecutionStepPayload,
  refactor: TaskExecutionStepPayload,
});
export const StructuralExecutionPayload = z.object({
  implement: TaskExecutionStepPayload,
  refactor: TaskExecutionStepPayload,
});
export const VisualUiExecutionPayload = z.object({
  mockup: TaskExecutionStepPayload,
  implement: TaskExecutionStepPayload,
  "screenshot-compare": TaskExecutionStepPayload,
});
export const DocsExecutionPayload = z.object({
  draft: TaskExecutionStepPayload,
  review: TaskExecutionStepPayload,
});
export const SpikeExecutionPayload = z.object({
  explore: TaskExecutionStepPayload,
  prototype: TaskExecutionStepPayload,
  record: TaskExecutionStepPayload,
});
export const ChoreExecutionPayload = z.object({
  execute: TaskExecutionStepPayload,
});

// ── TaskBase shared fields ──────────────────────────────────────────────

const TaskStatusPayload = z.enum([
  "pending",
  "ready",
  "in_progress",
  "done",
  "abandoned",
]);

const TaskBase = z.object({
  id: TaskIdPayload,
  depends_on: z.array(TaskIdPayload).default([]),
  labels: z.array(z.string()).default([]),
  status: TaskStatusPayload,
});

// ── Per-kind task variants ──────────────────────────────────────────────
// Each variant extends TaskBase + adds kind-specific required fields +
// (where applicable) refines for cross-field rules (e.g. behavioral with
// label=bug must have red_test_registered=true).

export const TaskBehavioralPayload = TaskBase.extend({
  kind: z.literal("behavioral"),
  drives: z.array(RawDrivesRef).min(1),
  tests: z.array(z.string().min(3)).min(1),
  test_layer: z.enum(["unit", "integration", "e2e"]).optional(),
  red_test_registered: z.boolean().optional(),
  execution: BehavioralExecutionPayload,
  requires_acceptance: z.boolean().optional(),
  // protocol.md §1223: behavioral tasks can trigger a visual must by
  // setting requires_visual=true; spec-lock check 7 consumes this in
  // sub-cycle 3b. Codex r24 BLOCK fix.
  requires_visual: z.boolean().optional(),
}).refine(
  (t) => !t.labels.includes("bug") || t.red_test_registered === true,
  { message: "behavioral tasks with labels=['bug'] require red_test_registered=true" },
);

export const TaskStructuralPayload = TaskBase.extend({
  kind: z.literal("structural"),
  drives: z.array(RawDrivesRef).optional(),
  no_test_rationale: z.string().min(10),
  execution: StructuralExecutionPayload,
});

export const TaskVisualUiPayload = TaskBase.extend({
  kind: z.literal("visual-ui"),
  drives: z.array(RawDrivesRef).optional(),
  visual_contract_refs: z.array(VisIdPayload).min(1),
  no_test_rationale: z.string().min(10).optional(),
  execution: VisualUiExecutionPayload,
});

export const TaskDocsPayload = TaskBase.extend({
  kind: z.literal("docs"),
  drives: z.array(RawDrivesRef).optional(),
  no_test_rationale: z.string().min(10),
  execution: DocsExecutionPayload,
});

export const TaskSpikePayload = TaskBase.extend({
  kind: z.literal("spike"),
  drives: z.array(RawDrivesRef).optional(),
  no_test_rationale: z.string().min(10),
  execution: SpikeExecutionPayload,
});

export const TaskChorePayload = TaskBase.extend({
  kind: z.literal("chore"),
  drives: z.array(RawDrivesRef).optional(),
  no_test_rationale: z.string().min(10),
  execution: ChoreExecutionPayload,
});

// TaskFull — discriminated union via .or() chain (Z does not combine
// .discriminatedUnion with .refine() on members, so we use a plain union
// and rely on `kind` literal narrowing for downstream code).
export const TaskFullPayload = z.union([
  TaskBehavioralPayload,
  TaskStructuralPayload,
  TaskVisualUiPayload,
  TaskDocsPayload,
  TaskSpikePayload,
  TaskChorePayload,
]);
export type TaskFullPayload = z.infer<typeof TaskFullPayload>;

// Helper: extract the seeded execution-step record from a parsed TaskFull
// payload into the slim projection shape `{ stepName: { applicability,
// status } }`. evidence_refs / reason / started_at stay in the journal
// payload as canonical truth; the projection only carries what
// spec-lock check 8 + auto-promote need.
export function extractTaskSteps(
  exec: Record<string, TaskExecutionStepPayload>,
): Record<string, { applicability: ApplicabilityPayload; status: StepStatusPayload }> {
  const out: Record<string, { applicability: ApplicabilityPayload; status: StepStatusPayload }> = {};
  for (const [name, step] of Object.entries(exec)) {
    out[name] = { applicability: step.applicability, status: step.status };
  }
  return out;
}

/**
 * Structural type that any TaskFullPayload variant satisfies after preflight
 * zod validation. Reducer narrows on `kind` to extract per-variant fields.
 */
export type TaskFullProjection = {
  id: string;
  kind: "behavioral" | "structural" | "visual-ui" | "docs" | "spike" | "chore";
  status: "pending" | "ready" | "in_progress" | "done" | "abandoned";
  depends_on: string[];
  labels: string[];
  drives?: string[];
  execution: Record<string, TaskExecutionStepPayload>;
  // Optional per-kind extras (narrowed by `kind`):
  red_test_registered?: boolean;
  no_test_rationale?: string;
  visual_contract_refs?: string[];
  requires_acceptance?: boolean;
  requires_visual?: boolean;
};

/**
 * Extract a slim TaskState projection from a TaskFull payload. Body fields
 * (tests / test_layer / execution.evidence_refs / reason / started_at) stay
 * in the journal payload as canonical truth — only cross-cutting fields
 * needed by spec-lock checks + auto-promote land in the projection.
 */
export function extractTaskSlim(t: TaskFullProjection): {
  id: string;
  kind: TaskFullProjection["kind"];
  status: TaskFullProjection["status"];
  steps: Record<string, { applicability: ApplicabilityPayload; status: StepStatusPayload }>;
  drives: string[];
  depends_on: string[];
  labels: string[];
  red_test_registered?: boolean;
  no_test_rationale?: string;
  visual_contract_refs?: string[];
  requires_acceptance?: boolean;
  requires_visual?: boolean;
} {
  const out: ReturnType<typeof extractTaskSlim> = {
    id: t.id,
    kind: t.kind,
    status: t.status,
    steps: extractTaskSteps(t.execution),
    drives: t.drives ?? [],
    depends_on: t.depends_on,
    labels: t.labels,
  };
  if (t.red_test_registered !== undefined) out.red_test_registered = t.red_test_registered;
  if (t.no_test_rationale !== undefined) out.no_test_rationale = t.no_test_rationale;
  if (t.visual_contract_refs !== undefined) out.visual_contract_refs = t.visual_contract_refs;
  if (t.requires_acceptance !== undefined) out.requires_acceptance = t.requires_acceptance;
  if (t.requires_visual !== undefined) out.requires_visual = t.requires_visual;
  return out;
}

/**
 * Auto-promote predicate (codex r23 BLOCK 2 fix): a task is ready to be
 * promoted to status="done" when every must-applicable step is in a
 * terminal-positive state. Optional / na applicability never blocks.
 */
export function shouldPromoteToDone(
  steps: Record<string, { applicability: ApplicabilityPayload; status: StepStatusPayload }>,
): boolean {
  const mustSteps = Object.values(steps).filter((s) => s.applicability === "must");
  if (mustSteps.length === 0) return false;
  return mustSteps.every((s) => s.status === "passed" || s.status === "waived" || s.status === "na");
}
