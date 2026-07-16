// Canonical VerifyCheckSnapshot, IterationStats, Drift, AcCoverage, ReconcileJson contract owner.

import { z } from "zod";

import { VerifyCheckKind } from "./evidence-schema.js";
import { FindingAction, FindingCategory } from "./finding-schema.js";
import {
  ApplicabilityPayload as Applicability,
  StepStatusPayload as StepStatus,
} from "./task-schema.js";

const SchemaVersion = z.literal(2);

export const VerifyCheckSnapshot = z.object({
  applicability: Applicability,
  status: StepStatus,
  reason: z.string().optional(),
  evidence_refs: z.array(z.string().regex(/^EV-\d{6,}$/)).default([]),
});

export const IterationStats = z.object({
  total: z.number().int().positive(),
  findings_total: z.number().int().nonnegative(),
  findings_by_action: z.record(FindingAction, z.number().int().nonnegative()),
  findings_by_category: z.record(FindingCategory, z.number().int().nonnegative()),
});

export const Drift = z.object({
  path: z.string(),
  category: z.enum(["out_of_planned", "planned_not_touched"]),
  reason: z.string().min(5),
  resolution: z.enum(["spec_amended", "carried_forward", "abandoned", "deferred"]),
  finding_id: z
    .string()
    .regex(/^FND-\d{3,}$/)
    .optional(),
});

export const AcCoverage = z.object({
  ac_id: z.string().regex(/^(REQ|SCEN|VIS)-[A-Z][A-Z0-9-]*-\d{3,}$/),
  evidence_refs: z.array(z.string().regex(/^EV-\d{6,}$/)),
  status: z.enum(["passed", "failed", "waived", "na"]),
});

export const ReconcileJson = z.object({
  schema_version: SchemaVersion,
  based_on: z.object({
    spec: z.number().int().positive(),
    tasks: z.number().int().positive(),
  }),
  planned_scope: z.array(z.string()),
  actual_scope: z.array(z.string()),
  drift: z.array(Drift),
  ac_coverage: z.array(AcCoverage),
  verify_checks_status: z.record(VerifyCheckKind, VerifyCheckSnapshot),
  iteration_stats: IterationStats,
  // rev 4.3 (ADR-0004 A7): finding raise events tagged ActionRisk="unusual"
  // are counted here so reviewers see at a glance how many findings sit in
  // the non-typical band of FINDING_ACTION_GRID. Does not include incoherent
  // attempts (those are blocked at raise time, never landed). Default 0
  // when no unusual findings were raised in this reconcile window.
  unusual_findings_count: z.number().int().nonnegative().default(0),
});

export type ReconcileJson = z.infer<typeof ReconcileJson>;
