import type { EvidenceKind } from "../core/evidence-schema.js";
import type { FindingAction, FindingCategory } from "../core/finding-schema.js";
import type { SubState } from "../core/journal-entry.js";
import type { TaskFullProjection } from "../core/task-schema.js";
import type { TuiStatusBucket } from "./tui/list-model.js";

export type TaskKind = TaskFullProjection["kind"];
export type Phase = "TRIAGE" | "SPEC" | "EXECUTE" | "VERIFY" | "SETTLE" | "DONE";
export type PendingKind =
  | "ask_user_question"
  | "gate_decision"
  | "spec_clarification"
  | "finding_decision"
  | "profile_escalation";

export const TASK_KIND_VALUES = [
  "behavioral",
  "structural",
  "visual-ui",
  "docs",
  "spike",
  "chore",
] as const satisfies readonly TaskKind[];

const STATUS_INDICATOR_KEYS = {
  done: "status_indicator.done",
  blocked: "status_indicator.ask",
  running: "status_indicator.run",
  idle: "status_indicator.idle",
} as const satisfies Record<TuiStatusBucket, string>;

const TASK_KIND_KEYS = {
  behavioral: "task_kind.behavioral",
  structural: "task_kind.structural",
  "visual-ui": "task_kind.visual-ui",
  docs: "task_kind.docs",
  spike: "task_kind.spike",
  chore: "task_kind.chore",
} as const satisfies Record<TaskKind, string>;

const EVIDENCE_KIND_KEYS = {
  "task-summary": "evidence_kind.task-summary",
  "verify-review": "evidence_kind.verify-review",
  "spec-review": "evidence_kind.spec-review",
  acceptance: "evidence_kind.acceptance",
  "visual-review": "evidence_kind.visual-review",
  "gate-decision": "evidence_kind.gate-decision",
  "local-check": "evidence_kind.local-check",
  manual: "evidence_kind.manual",
  waiver: "evidence_kind.waiver",
  "spike-finding": "evidence_kind.spike-finding",
} as const satisfies Record<EvidenceKind, string>;

const FINDING_CATEGORY_KEYS = {
  "spec-gap": "finding_category.spec-gap",
  "spec-defect": "finding_category.spec-defect",
  "impl-defect": "finding_category.impl-defect",
  "test-defect": "finding_category.test-defect",
  "new-scope": "finding_category.new-scope",
  "risk-escalation": "finding_category.risk-escalation",
} as const satisfies Record<FindingCategory, string>;

const FINDING_ACTION_KEYS = {
  "amend-spec": "finding_action.amend-spec",
  "amend-tasks": "finding_action.amend-tasks",
  "fix-impl": "finding_action.fix-impl",
  "fix-test": "finding_action.fix-test",
  defer: "finding_action.defer",
  backlog: "finding_action.backlog",
} as const satisfies Record<FindingAction, string>;

const PENDING_KIND_KEYS = {
  ask_user_question: "pending_kind.ask_user_question",
  gate_decision: "pending_kind.gate_decision",
  spec_clarification: "pending_kind.spec_clarification",
  finding_decision: "pending_kind.finding_decision",
  profile_escalation: "pending_kind.profile_escalation",
} as const satisfies Record<PendingKind, string>;

const PHASE_KEYS = {
  TRIAGE: "phase.TRIAGE",
  SPEC: "phase.SPEC",
  EXECUTE: "phase.EXECUTE",
  VERIFY: "phase.VERIFY",
  SETTLE: "phase.SETTLE",
  DONE: "phase.DONE",
} as const satisfies Record<Phase, string>;

const SUB_STATE_KEYS = {
  "TRIAGE.score": "sub_state.TRIAGE.score",
  "TRIAGE.confirm": "sub_state.TRIAGE.confirm",
  "SPEC.proposal": "sub_state.SPEC.proposal",
  "SPEC.spec": "sub_state.SPEC.spec",
  "SPEC.plan": "sub_state.SPEC.plan",
  "SPEC.design": "sub_state.SPEC.design",
  "EXECUTE.plan": "sub_state.EXECUTE.plan",
  "EXECUTE.work": "sub_state.EXECUTE.work",
  "EXECUTE.done": "sub_state.EXECUTE.done",
  "VERIFY.plan": "sub_state.VERIFY.plan",
  "VERIFY.run": "sub_state.VERIFY.run",
  "VERIFY.review": "sub_state.VERIFY.review",
  "VERIFY.acceptance": "sub_state.VERIFY.acceptance",
  "VERIFY.visual": "sub_state.VERIFY.visual",
  "VERIFY.accept": "sub_state.VERIFY.accept",
  "SETTLE.reconcile": "sub_state.SETTLE.reconcile",
  "SETTLE.lessons": "sub_state.SETTLE.lessons",
  "DONE.delivered": "sub_state.DONE.delivered",
  "DONE.archived": "sub_state.DONE.archived",
  "DONE.abandoned": "sub_state.DONE.abandoned",
} as const satisfies Record<SubState, string>;

export type RuntimeI18nKey =
  | (typeof STATUS_INDICATOR_KEYS)[keyof typeof STATUS_INDICATOR_KEYS]
  | (typeof TASK_KIND_KEYS)[keyof typeof TASK_KIND_KEYS]
  | (typeof EVIDENCE_KIND_KEYS)[keyof typeof EVIDENCE_KIND_KEYS]
  | (typeof FINDING_CATEGORY_KEYS)[keyof typeof FINDING_CATEGORY_KEYS]
  | (typeof FINDING_ACTION_KEYS)[keyof typeof FINDING_ACTION_KEYS]
  | (typeof PENDING_KIND_KEYS)[keyof typeof PENDING_KIND_KEYS]
  | (typeof PHASE_KEYS)[keyof typeof PHASE_KEYS]
  | (typeof SUB_STATE_KEYS)[keyof typeof SUB_STATE_KEYS];

export const RUNTIME_I18N_KEYS: readonly RuntimeI18nKey[] = [
  ...Object.values(STATUS_INDICATOR_KEYS),
  ...Object.values(TASK_KIND_KEYS),
  ...Object.values(EVIDENCE_KIND_KEYS),
  ...Object.values(FINDING_CATEGORY_KEYS),
  ...Object.values(FINDING_ACTION_KEYS),
  ...Object.values(PENDING_KIND_KEYS),
  ...Object.values(PHASE_KEYS),
  ...Object.values(SUB_STATE_KEYS),
];

export function statusIndicatorKey(bucket: TuiStatusBucket): RuntimeI18nKey {
  return STATUS_INDICATOR_KEYS[bucket];
}

export function taskKindKey(kind: TaskKind): RuntimeI18nKey {
  return TASK_KIND_KEYS[kind];
}

export function evidenceKindKey(kind: EvidenceKind): RuntimeI18nKey {
  return EVIDENCE_KIND_KEYS[kind];
}

export function findingCategoryKey(category: FindingCategory): RuntimeI18nKey {
  return FINDING_CATEGORY_KEYS[category];
}

export function findingActionKey(action: FindingAction): RuntimeI18nKey {
  return FINDING_ACTION_KEYS[action];
}

export function pendingKindKey(kind: PendingKind): RuntimeI18nKey {
  return PENDING_KIND_KEYS[kind];
}

export function phaseKey(phase: Phase): RuntimeI18nKey {
  return PHASE_KEYS[phase];
}

export function subStateKey(subState: SubState): RuntimeI18nKey {
  return SUB_STATE_KEYS[subState];
}
