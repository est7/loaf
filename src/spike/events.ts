// loaf-cli spike — Event union
//
// 10 event kinds chosen to exercise the architecture, not full protocol coverage:
//   session_started / spec_submitted / spec_locked /
//   tasks_submitted / task_claimed /
//   step_done (compound w/ evidence — the B4-critical case) /
//   evidence_added (independent, e.g. waiver) /
//   pending_raised / pending_resolved /
//   advanced
//
// Per-event `event_version` (codex M6). No global `seq` (codex B2 — canonical
// order is physical file order). `step_done` is the ONLY event that closes a
// step + carries proof; `evidence_added` is for independent evidence (waivers,
// manual notes) — single source of truth per kind (codex M4).

import { z } from "zod";

export const EVENT_VERSION = 1 as const;

export const Phase = z.enum(["TRIAGE", "SPEC", "EXECUTE", "VERIFY", "SETTLE", "DONE"]);
export type Phase = z.infer<typeof Phase>;

export const SubState = z.enum([
  "TRIAGE.score", "TRIAGE.confirm",
  "SPEC.proposal", "SPEC.spec", "SPEC.plan", "SPEC.design",
  "EXECUTE.plan", "EXECUTE.work", "EXECUTE.done",
  "VERIFY.plan", "VERIFY.run", "VERIFY.review", "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept",
  "SETTLE.reconcile", "SETTLE.lessons",
  "DONE.delivered", "DONE.archived", "DONE.abandoned",
]);
export type SubState = z.infer<typeof SubState>;

export const TaskKind = z.enum(["behavioral", "structural", "visual-ui", "docs", "spike", "chore"]);
export type TaskKind = z.infer<typeof TaskKind>;

export const StepStatus = z.enum(["pending", "running", "passed", "failed", "waived", "na"]);
export type StepStatus = z.infer<typeof StepStatus>;

export const Ceremony = z.object({
  spec_phase: z.boolean(),
  verify_phase: z.boolean(),
  settle_phase: z.boolean(),
  strict_spec_review: z.boolean(),
  lessons_required: z.enum(["must", "may", "skip"]),
  strict_drift_check: z.boolean(),
}).refine((c) => !c.settle_phase || c.verify_phase, "settle_phase=true requires verify_phase=true")
  .refine((c) => !c.strict_spec_review || c.spec_phase, "strict_spec_review=true requires spec_phase=true")
  .refine((c) => c.lessons_required === "skip" || c.settle_phase, "lessons_required!=skip requires settle_phase=true")
  .refine((c) => !c.strict_drift_check || c.settle_phase, "strict_drift_check=true requires settle_phase=true");
export type Ceremony = z.infer<typeof Ceremony>;

const TaskId = z.string().regex(/^T-\d{3,}$/);
const EvidenceId = z.string().regex(/^EV-\d{3,}$/);
const FindingId = z.string().regex(/^FND-\d{3,}$/);
const PendingId = z.string().regex(/^PEND-\d{3,}$/);

const TimestampISO = z.string().min(20); // ISO 8601 — keep loose for spike
const Iso = TimestampISO;

const TaskSummary = z.object({
  id: TaskId,
  kind: TaskKind,
  drives: z.array(z.string()).default([]),
  depends_on: z.array(TaskId).default([]),
  status: z.enum(["pending", "in_progress", "done", "abandoned"]).default("pending"),
  labels: z.array(z.string()).default([]),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

const EvidenceBody = z.object({
  id: EvidenceId,
  kind: z.enum(["manual", "build", "test", "verify-review", "acceptance", "visual-review", "waiver", "gate-decision", "local-check"]),
  result: z.enum(["passed", "failed", "inconclusive", "waived"]),
  covers: z.array(z.string()).default([]), // REQ-* / SCEN-* / VIS-* / T-N
  actor: z.string(),
  summary: z.string().min(3),
  task_id: TaskId.optional(),
  step: z.string().optional(),
});
export type EvidenceBody = z.infer<typeof EvidenceBody>;

const PendingEntryBody = z.object({
  id: PendingId,
  kind: z.enum(["ask_user_question", "gate_decision", "spec_clarification", "finding_decision", "profile_escalation"]),
  question: z.string().min(3),
  options: z.array(z.string()).default([]),
  raised_by_task_id: TaskId.optional(),
  at: Iso,
});
export type PendingEntryBody = z.infer<typeof PendingEntryBody>;

// ─── Event variants ─────────────────────────────────────────────────────────
// `version` = event-schema version (per-event, codex M6).
// All discriminators on `kind`. All carry `at` (ISO timestamp).

const Base = z.object({
  version: z.literal(EVENT_VERSION),
  at: Iso,
});

export const SessionStarted = Base.extend({
  kind: z.literal("session_started"),
  session_id: z.string().uuid(),
  feature: z.string().min(1),
  ceremony: Ceremony,
  ceremony_label: z.string().default("standard"),
});

export const SpecSubmitted = Base.extend({
  kind: z.literal("spec_submitted"),
  spec_version: z.number().int().positive(),
  frontmatter_hash: z.string().min(8),
});

export const SpecLocked = Base.extend({
  kind: z.literal("spec_locked"),
  actor: z.string(),
});

export const TasksSubmitted = Base.extend({
  kind: z.literal("tasks_submitted"),
  tasks_version: z.number().int().positive(),
  tasks: z.array(TaskSummary),
});

export const TaskClaimed = Base.extend({
  kind: z.literal("task_claimed"),
  task_id: TaskId,
  by_actor: z.string(),
});

export const StepDone = Base.extend({
  kind: z.literal("step_done"),
  task_id: TaskId,
  step: z.string().min(1),
  status: z.enum(["passed", "failed", "waived", "na"]),
  evidence: EvidenceBody, // compound — codex M4: only path that closes step w/ proof
  task_completed: z.boolean().default(false), // if true, mark task.status=done after
});

export const EvidenceAdded = Base.extend({
  kind: z.literal("evidence_added"),
  evidence: EvidenceBody,
  // Independent evidence (waiver / manual note). Does NOT close any step.
});

export const PendingRaised = Base.extend({
  kind: z.literal("pending_raised"),
  entry: PendingEntryBody,
});

export const PendingResolved = Base.extend({
  kind: z.literal("pending_resolved"),
  pending_id: PendingId, // for audit; head must match at reduce time
  answer: z.string().min(1),
});

export const Advanced = Base.extend({
  kind: z.literal("advanced"),
  from: SubState,
  to: SubState,
  iteration: z.number().int().positive(),
});

export const Event = z.discriminatedUnion("kind", [
  SessionStarted,
  SpecSubmitted,
  SpecLocked,
  TasksSubmitted,
  TaskClaimed,
  StepDone,
  EvidenceAdded,
  PendingRaised,
  PendingResolved,
  Advanced,
]);
export type Event = z.infer<typeof Event>;

export const EVENT_BYTE_LIMIT = 4096 as const;
