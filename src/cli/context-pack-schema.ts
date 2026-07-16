// Canonical ContextPackProjection, CONTEXT_PACK_TEMPLATES contract owner.

import { z } from "zod";

import { SubState } from "../core/journal-entry.js";

export const ContextPackProjection = z.object({
  description: z.string().min(3),
  include: z.array(z.string().min(1)),
  exclude: z.array(z.string().min(1)).default([]),
});

export type ContextPackProjection = z.infer<typeof ContextPackProjection>;

export const CONTEXT_PACK_TEMPLATES: Record<z.infer<typeof SubState>, ContextPackProjection> = {
  "TRIAGE.score": {
    description: "Feature intent + scoring inputs + ceremony presets",
    include: ["feature.intent", "scoring_axes", "ceremony_presets"],
    exclude: ["spec", "tasks", "evidence"],
  },
  "TRIAGE.confirm": {
    description: "Triage outcome + ceremony to confirm",
    include: ["feature.intent", "ceremony", "ceremony_label", "scoring_summary"],
    exclude: ["spec", "tasks", "evidence"],
  },
  "SPEC.proposal": {
    description: "Feature meta + proposal draft state",
    include: ["feature.intent", "spec_version", "proposal_draft", "needs_clarification"],
    exclude: ["tasks", "evidence", "verify_checks"],
  },
  "SPEC.spec": {
    description: "EARS / scenario / visual contract building",
    include: [
      "feature.intent",
      "spec_version",
      "req_count",
      "scen_count",
      "vis_count",
      "verifiability_gaps",
      "needs_clarification",
      "pending_head",
    ],
    exclude: ["tasks", "evidence", "verify_checks"],
  },
  "SPEC.plan": {
    description: "Spec-locked summary + task plan inputs",
    include: ["spec_summary", "spec_version", "ceremony", "task_kinds_planned"],
    exclude: ["evidence", "verify_checks"],
  },
  "SPEC.design": {
    description: "Design notes + cross-cutting concerns",
    include: ["spec_summary", "design_notes", "adr_refs"],
    exclude: ["tasks_detail", "evidence"],
  },
  "EXECUTE.plan": {
    description: "Derive per-task execution policy",
    include: ["ceremony", "tasks_summary", "tasks_dag", "open_findings"],
    exclude: ["spec_ears_detail", "evidence"],
  },
  "EXECUTE.work": {
    description: "Worker active set + ready leaves + open findings",
    include: [
      "ceremony",
      "tasks_status_summary",
      "in_progress_step",
      "ready_leaves_top_5",
      "open_findings",
      "pending",
      "write_scope",
    ],
    exclude: ["spec_ears_detail", "verify_checks_detail"],
  },
  "EXECUTE.done": {
    description: "Final task statuses pre-VERIFY",
    include: ["tasks_status_summary", "task_summary_evidence", "open_findings"],
    exclude: ["spec_ears_detail"],
  },
  "VERIFY.plan": {
    description: "Compute applicable verify checks",
    include: ["spec_summary", "verify_checks_applicable", "ceremony"],
    exclude: ["tasks_dag"],
  },
  "VERIFY.run": {
    description: "Running run check (test + lint + typecheck)",
    include: ["verify_check_status.run", "ac_coverage_run", "open_findings", "pending"],
    exclude: ["tasks_dag"],
  },
  "VERIFY.review": {
    description: "Running review check (quality reviewer)",
    include: ["verify_check_status.review", "spec_summary", "open_findings", "pending"],
    exclude: ["tasks_dag"],
  },
  "VERIFY.acceptance": {
    description: "Running acceptance check (Gherkin E2E)",
    include: ["verify_check_status.acceptance", "scen_coverage", "open_findings", "pending"],
    exclude: ["tasks_dag"],
  },
  "VERIFY.visual": {
    description: "Running visual check (visual contract)",
    include: ["verify_check_status.visual", "vis_coverage", "open_findings", "pending"],
    exclude: ["tasks_dag"],
  },
  "VERIFY.accept": {
    description: "Machine + human gate snapshot",
    include: [
      "verify_checks_status_all",
      "ac_coverage",
      "open_findings",
      "pending",
      "gate_diagnostic",
    ],
    exclude: ["tasks_dag"],
  },
  "SETTLE.reconcile": {
    description: "Drift + AC coverage + findings reconciliation",
    include: ["iteration_stats", "drift", "ac_coverage", "findings_by_category_action"],
    exclude: ["tasks_dag", "spec_ears_detail"],
  },
  "SETTLE.lessons": {
    description: "Iteration totals + lessons.md inputs",
    include: ["iteration_stats", "findings_by_category_action", "drift_summary"],
    exclude: ["tasks_detail", "spec_ears_detail"],
  },
  "DONE.delivered": {
    description: "Terminal delivered snapshot",
    include: ["feature.intent", "iteration_stats", "delivery_record"],
    exclude: ["tasks_dag", "pending"],
  },
  "DONE.archived": {
    description: "Terminal archived snapshot",
    include: ["feature.intent", "archive_reason", "iteration_stats"],
    exclude: ["tasks_dag", "pending"],
  },
  "DONE.abandoned": {
    description: "Terminal abandoned snapshot",
    include: ["feature.intent", "abandon_reason", "iteration_stats"],
    exclude: ["tasks_dag", "pending"],
  },
} as const;
