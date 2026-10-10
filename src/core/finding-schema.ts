// Canonical Zod vocabulary and payload shapes for findings.
// Intervention decisions live in intervention-policy.ts; this schema layer
// does not import the policy owner or its transition/snapshot dependencies.

import { z } from "zod";

import { TaskIdPayload } from "./task-schema.js";

// ── FindingId (`/^FND-\d{3,}$/`) ────────────────────────────────────────

export const FindingId = z.string().regex(/^FND-\d{3,}$/);
export type FindingId = z.infer<typeof FindingId>;

// ── FindingCategory / FindingAction ─────────────────────────────────────

export const FindingCategory = z.enum([
  "spec-gap", // spec silent on this aspect
  "spec-defect", // spec wrong (covers design-gap)
  "impl-defect", // implementation wrong (covers visual-defect)
  "test-defect", // test or test-env wrong
  "new-scope", // out of current scope, needs new task
  "risk-escalation", // task complexity exceeds current profile
]);
export type FindingCategory = z.infer<typeof FindingCategory>;

export const FindingAction = z.enum([
  "amend-spec", // → SPEC.spec, spec_version+1
  "amend-tasks", // → EXECUTE.work, tasks.version+1
  "fix-impl", // → EXECUTE.work; event:task_step_reset sets execution.implement.status=pending
  "fix-test", // → EXECUTE.work; event:task_step_reset sets execution.red.status=pending
  "defer", // declared current-run deferral; remains open and is reconciled as carried work
  "backlog", // declared next-feature deferral; remains open as a carry-forward candidate
]);
export type FindingAction = z.infer<typeof FindingAction>;

// ── FindingActionRisk + 6×6 grid ────────────────────────────────────────

export const FindingActionRisk = z.enum(["typical", "unusual", "incoherent"]);
export type FindingActionRisk = z.infer<typeof FindingActionRisk>;

// ── Target payload shape ────────────────────────────────────────────────

export const FindingTarget = z
  .object({
    task_id: TaskIdPayload,
    step: z.string().min(1),
  })
  .strict();
export type FindingTarget = z.infer<typeof FindingTarget>;
