import type { EvidenceKind, VerifyCheckKind } from "../core/evidence-schema.js";
import {
  ERROR_CATALOG,
  DIAGNOSTIC_VARIANTS,
  type DiagnosticCode,
  type DiagnosticContext,
} from "../core/error-catalog.js";
import type { FindingAction, FindingCategory } from "../core/finding-schema.js";
import type { SubState } from "../core/journal-entry.js";
import type { TaskFullProjection } from "../core/task-schema.js";
import type { TuiStatusBucket } from "./tui/types.js";

export type TaskKind = TaskFullProjection["kind"];
export type TaskStatus = TaskFullProjection["status"];
export type FindingStatus = "open" | "closed";
export type Applicability = "must" | "optional" | "na";
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

export const TASK_STATUS_VALUES = [
  "pending",
  "ready",
  "in_progress",
  "done",
  "abandoned",
] as const satisfies readonly TaskStatus[];

export const FINDING_STATUS_VALUES = ["open", "closed"] as const satisfies readonly FindingStatus[];

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

const TASK_STATUS_KEYS = {
  pending: "task_status.pending",
  ready: "task_status.ready",
  in_progress: "task_status.in_progress",
  done: "task_status.done",
  abandoned: "task_status.abandoned",
} as const satisfies Record<TaskStatus, string>;

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

const VERIFY_CHECK_KIND_KEYS = {
  run: "verify_check_kind.run",
  review: "verify_check_kind.review",
  acceptance: "verify_check_kind.acceptance",
  visual: "verify_check_kind.visual",
} as const satisfies Record<VerifyCheckKind, string>;

const APPLICABILITY_KEYS = {
  must: "applicability.must",
  optional: "applicability.optional",
  na: "applicability.na",
} as const satisfies Record<Applicability, string>;

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

const FINDING_STATUS_KEYS = {
  open: "finding_status.open",
  closed: "finding_status.closed",
} as const satisfies Record<FindingStatus, string>;

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
  "SETTLE.lessons": "sub_state.SETTLE.lessons",
  "DONE.delivered": "sub_state.DONE.delivered",
  "DONE.archived": "sub_state.DONE.archived",
  "DONE.abandoned": "sub_state.DONE.abandoned",
} as const satisfies Record<SubState, string>;

// Sole adapter/identity subset registry. Its member type and diagnostic key
// map derive below; diagnostic-failure.ts exhaustively covers this same set.
export type DiagnosticI18nKey =
  | `diagnostic.${DiagnosticCode}`
  | `diagnostic_fix.${DiagnosticCode}`
  | `diagnostic_variant.${DiagnosticContext}`
  | `diagnostic_variant_fix.${DiagnosticContext}`;
const DIAGNOSTIC_KEYS: DiagnosticI18nKey[] = [
  ...Object.keys(ERROR_CATALOG).flatMap(
    (code) => [`diagnostic.${code}`, `diagnostic_fix.${code}`] as DiagnosticI18nKey[],
  ),
  ...Object.keys(DIAGNOSTIC_VARIANTS).flatMap(
    (context) =>
      [`diagnostic_variant.${context}`, `diagnostic_variant_fix.${context}`] as DiagnosticI18nKey[],
  ),
];

export const SUCCESS_KEYS = {
  nextFullCommandPointer: "success.next.full_command_pointer",
  nextDeliver: "success.next.deliver",
  nextSettle: "success.next.settle",
  nextSettleLessons: "success.next.settle_lessons",
  startStateChange: "success.start.state_change",
  advanceStateChange: "success.advance.state_change",
  gateSpecLockApprovedStateChange: "success.gate.spec_lock_approved_state_change",
  gateVerifyAcceptApprovedStateChange: "success.gate.verify_accept_approved_state_change",
  gateRejectedStateChange: "success.gate.rejected_state_change",
  deliverStateChange: "success.deliver.state_change",
  deliverNext: "success.deliver.next",
  archiveStateChange: "success.archive.state_change",
  abandonStateChange: "success.abandon.state_change",
  spikeConvertStateChange: "success.spike.convert_state_change",
  profileEscalateStateChange: "success.profile.escalate_state_change",
  tasksSubmitTextOne: "success.tasks.submit_text_one",
  tasksSubmitTextMany: "success.tasks.submit_text_many",
  tasksSubmitStateChange: "success.tasks.submit_state_change",
  tasksAddTextOne: "success.tasks.add_text_one",
  tasksAddTextMany: "success.tasks.add_text_many",
  tasksAddSponsoredTextOne: "success.tasks.add_sponsored_text_one",
  tasksAddSponsoredTextMany: "success.tasks.add_sponsored_text_many",
  tasksAddStateChange: "success.tasks.add_state_change",
  tasksClaimStateChange: "success.tasks.claim_state_change",
  tasksAbandonStateChange: "success.tasks.abandon_state_change",
  doctorRebuildTextOne: "success.doctor.rebuild_text_one",
  doctorRebuildTextMany: "success.doctor.rebuild_text_many",
  doctorRebuildStateChangeOne: "success.doctor.rebuild_state_change_one",
  doctorRebuildStateChangeMany: "success.doctor.rebuild_state_change_many",
  snapshotAsOfSeq: "success.snapshot.as_of_seq",
  amendSponsoredText: "success.amend.sponsored_text",
  amendPolicyText: "success.amend.policy_text",
  amendStateChange: "success.amend.state_change",
  tasksRegisterRedStateChange: "success.tasks.register_red_state_change",
  stepStartStateChange: "success.step.start_state_change",
  stepDoneText: "success.step.done_text",
  stepDoneEvidenceSuffix: "success.step.done_evidence_suffix",
  stepDonePromoteSuffix: "success.step.done_promote_suffix",
  stepDoneStateChange: "success.step.done_state_change",
  settleStateChange: "success.settle.state_change",
  settleText: "success.settle.text",
  resumeStateChange: "success.resume.state_change",
  handoffStateChange: "success.handoff.state_change",
  pendingRaiseStateChange: "success.pending.raise_state_change",
  pendingResolveText: "success.pending.resolve_text",
  pendingResolveStateChange: "success.pending.resolve_state_change",
  waiveStateChange: "success.waive.state_change",
  lessonsAddStateChange: "success.lessons.add_state_change",
  evidenceCoversNone: "success.evidence.covers_none",
  evidenceAddStateChangeSingle: "success.evidence.add_state_change_single",
  evidenceAddStateChangeBatchHomogeneous: "success.evidence.add_state_change_batch_homogeneous",
  evidenceAddStateChangeBatchMixed: "success.evidence.add_state_change_batch_mixed",
  findingCloseText: "success.finding.close_text",
  findingCloseStateChange: "success.finding.close_state_change",
  specSubmitText: "success.spec.submit_text",
  specSubmitStateChange: "success.spec.submit_state_change",
  specSubmitNext: "success.spec.submit_next",
  specInitStateChange: "success.spec.init_state_change",
  specInitNext: "success.spec.init_next",
  specEditText: "success.spec.edit_text",
  specEditStateChange: "success.spec.edit_state_change",
  specEditInputStateChange: "success.spec.edit_input_state_change",
  specAddReqTextOne: "success.spec.add_req_text_one",
  specAddReqTextMany: "success.spec.add_req_text_many",
  specAddReqStateChangeOne: "success.spec.add_req_state_change_one",
  specAddReqStateChangeMany: "success.spec.add_req_state_change_many",
  specAddScenarioTextOne: "success.spec.add_scenario_text_one",
  specAddScenarioTextMany: "success.spec.add_scenario_text_many",
  specAddScenarioStateChangeOne: "success.spec.add_scenario_state_change_one",
  specAddScenarioStateChangeMany: "success.spec.add_scenario_state_change_many",
  specAddVisualTextOne: "success.spec.add_visual_text_one",
  specAddVisualTextMany: "success.spec.add_visual_text_many",
  specAddVisualStateChangeOne: "success.spec.add_visual_state_change_one",
  specAddVisualStateChangeMany: "success.spec.add_visual_state_change_many",
} as const;

export type SuccessKey = (typeof SUCCESS_KEYS)[keyof typeof SUCCESS_KEYS];

export const CHROME_KEYS = {
  statusFeature: "chrome.status.feature",
  statusPhase: "chrome.status.phase",
  statusCursor: "chrome.status.cursor",
  statusTail: "chrome.status.tail",
  statusCounts: "chrome.status.counts",
  statusSnapshotAsOfProjectionLoader: "chrome.status.snapshot_as_of_projection_loader",
  tasksListEmptyFiltered: "chrome.tasks.list_empty_filtered",
  tasksListEmpty: "chrome.tasks.list_empty",
  tasksListReadyMarker: "chrome.tasks.ready_marker",
  tasksListRow: "chrome.tasks.list_row",
  tasksListRowReady: "chrome.tasks.list_row_ready",
  tasksCompleteText: "chrome.tasks.complete_text",
  pendingListRow: "chrome.pending.list_row",
  pendingStatusNoOpen: "chrome.pending.no_open",
  pendingOpen: "chrome.pending.open",
  pendingResolved: "chrome.pending.resolved",
  pendingHead: "chrome.pending.head",
  pendingNonHead: "chrome.pending.non_head",
  findingListRow: "chrome.finding.list_row",
  journalListRow: "chrome.journal.list_row",
  journalListRowBatch: "chrome.journal.list_row_batch",
  journalListEmpty: "chrome.journal.list_empty",
  evidenceListRow: "chrome.evidence.list_row",
  evidenceListEmpty: "chrome.evidence.list_empty",
  evidenceCompatibilityWarning: "chrome.evidence.compatibility_warning",
  specStatusPass: "chrome.spec_status.pass",
  specStatusFailureRow: "chrome.spec_status.failure_row",
  specStatusSuppressedRow: "chrome.spec_status.suppressed_row",
  sessionsListEmpty: "chrome.sessions.empty",
  sessionsWarning: "chrome.sessions.warning",
  sessionsActionSkipped: "chrome.sessions.action_skipped",
  sessionsActionFilteredOut: "chrome.sessions.action_filtered_out",
  sessionsActionOrphanCwd: "chrome.sessions.action_orphan_cwd",
  relativeJustNow: "chrome.relative.just_now",
  relativeMinuteOne: "chrome.relative.minute_one",
  relativeMinuteMany: "chrome.relative.minute_many",
  relativeHourOne: "chrome.relative.hour_one",
  relativeHourMany: "chrome.relative.hour_many",
  relativeDayOne: "chrome.relative.day_one",
  relativeDayMany: "chrome.relative.day_many",
  checkOk: "chrome.check.ok",
  verifyStatusPass: "chrome.verify_status.pass",
  verifyStatusFail: "chrome.verify_status.fail",
  verifyStatusNa: "chrome.verify_status.na",
  verifyStatusCheckLaneStatus: "chrome.verify_status.check_lane_status",
  verifyStatusCheckOpenFindings: "chrome.verify_status.check_open_findings",
  verifyStatusCheckCoverage: "chrome.verify_status.check_coverage",
  verifyStatusCheckTaskEvidence: "chrome.verify_status.check_task_evidence",
  verifyStatusCheckSpecReview: "chrome.verify_status.check_spec_review",
  verifyStatusCheckDeferredFindings: "chrome.verify_status.check_deferred_findings",
  verifyStatusInfo: "chrome.verify_status.info",
  verifyStatusDeferredSummary: "chrome.verify_status.deferred_summary",
  verifyStatusFailureSummaryOne: "chrome.verify_status.failure_summary_one",
  verifyStatusFailureSummaryMany: "chrome.verify_status.failure_summary_many",
  verifyStatusDiagnosticOnly: "chrome.verify_status.diagnostic_only",
  verifyStatusLaneLabel: "chrome.verify_status.lane_label",
  verifyStatusLaneReason: "chrome.verify_status.lane_reason",
  verifyStatusLaneReasonNoDoneTasks: "chrome.verify_status.lane_reason_no_done_tasks",
  verifyStatusLaneReasonNoReviewObligations:
    "chrome.verify_status.lane_reason_no_review_obligations",
  verifyStatusLaneReasonNoE2eScenarios: "chrome.verify_status.lane_reason_no_e2e_scenarios",
  verifyStatusLaneReasonNoVisualContracts: "chrome.verify_status.lane_reason_no_visual_contracts",
  tuiListTitle: "chrome.tui.list.title",
  tuiListSort: "chrome.tui.list.sort",
  tuiListSortTime: "chrome.tui.list.sort_time",
  tuiListSortStatus: "chrome.tui.list.sort_status",
  tuiListReloading: "chrome.tui.list.reloading",
  tuiListEmpty: "chrome.tui.list.empty",
  tuiListHelp: "chrome.tui.list.help",
  tuiListRowIteration: "chrome.tui.list.row_iteration",
  tuiDetailTitle: "chrome.tui.detail.title",
  tuiDetailHelp: "chrome.tui.detail.help",
  tuiDetailNoSelected: "chrome.tui.detail.no_selected",
  tuiDetailLoading: "chrome.tui.detail.loading",
  tuiDetailMissingTitle: "chrome.tui.detail.missing_title",
  tuiDetailMissingMessage: "chrome.tui.detail.missing_message",
  tuiDetailStaleTitle: "chrome.tui.detail.stale_title",
  tuiDetailStaleMessage: "chrome.tui.detail.stale_message",
  tuiDetailErrorTitle: "chrome.tui.detail.error_title",
  tuiDetailNone: "chrome.tui.detail.none",
  tuiDetailBooleanTrue: "chrome.tui.detail.boolean_true",
  tuiDetailBooleanFalse: "chrome.tui.detail.boolean_false",
  tuiDetailFieldFeature: "chrome.tui.detail.field_feature",
  tuiDetailFieldSession: "chrome.tui.detail.field_session",
  tuiDetailFieldLabel: "chrome.tui.detail.field_label",
  tuiDetailFieldWorkspace: "chrome.tui.detail.field_workspace",
  tuiDetailFieldCeremony: "chrome.tui.detail.field_ceremony",
  tuiDetailFieldPhase: "chrome.tui.detail.field_phase",
  tuiDetailFieldIteration: "chrome.tui.detail.field_iteration",
  tuiDetailFieldComplexity: "chrome.tui.detail.field_complexity",
  tuiDetailFieldBasedOn: "chrome.tui.detail.field_based_on",
  tuiDetailFieldCreated: "chrome.tui.detail.field_created",
  tuiDetailFieldUpdated: "chrome.tui.detail.field_updated",
  tuiDetailFieldSpecLocked: "chrome.tui.detail.field_spec_locked",
  tuiDetailFieldVerifyAccepted: "chrome.tui.detail.field_verify_accepted",
  tuiDetailFieldSpecVersion: "chrome.tui.detail.field_spec_version",
  tuiDetailFieldTailSeq: "chrome.tui.detail.field_tail_seq",
  tuiDetailSectionTasks: "chrome.tui.detail.section_tasks",
  tuiDetailSectionEvidence: "chrome.tui.detail.section_evidence",
  tuiDetailSectionOpenFindings: "chrome.tui.detail.section_open_findings",
  tuiDetailSectionPending: "chrome.tui.detail.section_pending",
  tuiDetailEvidenceBadgePass: "chrome.tui.detail.evidence_badge_pass",
  tuiDetailEvidenceBadgeFail: "chrome.tui.detail.evidence_badge_fail",
  tuiDetailEvidenceBadgeWaived: "chrome.tui.detail.evidence_badge_waived",
  tuiDetailSidecarSummary: "chrome.tui.detail.sidecar_summary",
  tuiDetailStepSummary: "chrome.tui.detail.step_summary",
  tuiDetailRowSteps: "chrome.tui.detail.row_steps",
  tuiDetailRowIteration: "chrome.tui.detail.row_iteration",
  tuiDetailRowTask: "chrome.tui.detail.row_task",
  tuiDetailRowTarget: "chrome.tui.detail.row_target",
  tuiDetailRowBlocks: "chrome.tui.detail.row_blocks",
  tuiDetailRowOptions: "chrome.tui.detail.row_options",
} as const;

export type ChromeKey = (typeof CHROME_KEYS)[keyof typeof CHROME_KEYS];

export type RuntimeI18nKey =
  | (typeof STATUS_INDICATOR_KEYS)[keyof typeof STATUS_INDICATOR_KEYS]
  | (typeof TASK_KIND_KEYS)[keyof typeof TASK_KIND_KEYS]
  | (typeof TASK_STATUS_KEYS)[keyof typeof TASK_STATUS_KEYS]
  | (typeof EVIDENCE_KIND_KEYS)[keyof typeof EVIDENCE_KIND_KEYS]
  | (typeof VERIFY_CHECK_KIND_KEYS)[keyof typeof VERIFY_CHECK_KIND_KEYS]
  | (typeof APPLICABILITY_KEYS)[keyof typeof APPLICABILITY_KEYS]
  | (typeof FINDING_CATEGORY_KEYS)[keyof typeof FINDING_CATEGORY_KEYS]
  | (typeof FINDING_ACTION_KEYS)[keyof typeof FINDING_ACTION_KEYS]
  | (typeof FINDING_STATUS_KEYS)[keyof typeof FINDING_STATUS_KEYS]
  | (typeof PENDING_KIND_KEYS)[keyof typeof PENDING_KIND_KEYS]
  | (typeof PHASE_KEYS)[keyof typeof PHASE_KEYS]
  | (typeof SUB_STATE_KEYS)[keyof typeof SUB_STATE_KEYS]
  | DiagnosticI18nKey
  | SuccessKey
  | ChromeKey;

export const RUNTIME_I18N_KEYS: readonly RuntimeI18nKey[] = [
  ...Object.values(STATUS_INDICATOR_KEYS),
  ...Object.values(TASK_KIND_KEYS),
  ...Object.values(TASK_STATUS_KEYS),
  ...Object.values(EVIDENCE_KIND_KEYS),
  ...Object.values(VERIFY_CHECK_KIND_KEYS),
  ...Object.values(APPLICABILITY_KEYS),
  ...Object.values(FINDING_CATEGORY_KEYS),
  ...Object.values(FINDING_ACTION_KEYS),
  ...Object.values(FINDING_STATUS_KEYS),
  ...Object.values(PENDING_KIND_KEYS),
  ...Object.values(PHASE_KEYS),
  ...Object.values(SUB_STATE_KEYS),
  ...Object.values(DIAGNOSTIC_KEYS),
  ...Object.values(SUCCESS_KEYS),
  ...Object.values(CHROME_KEYS),
];

export function statusIndicatorKey(bucket: TuiStatusBucket): RuntimeI18nKey {
  return STATUS_INDICATOR_KEYS[bucket];
}

export function taskKindKey(kind: TaskKind): RuntimeI18nKey {
  return TASK_KIND_KEYS[kind];
}

export function taskStatusKey(status: TaskStatus): RuntimeI18nKey {
  return TASK_STATUS_KEYS[status];
}

export function evidenceKindKey(kind: EvidenceKind): RuntimeI18nKey {
  return EVIDENCE_KIND_KEYS[kind];
}

export function verifyCheckKindKey(kind: VerifyCheckKind): RuntimeI18nKey {
  return VERIFY_CHECK_KIND_KEYS[kind];
}

export function applicabilityKey(applicability: Applicability): RuntimeI18nKey {
  return APPLICABILITY_KEYS[applicability];
}

export function findingCategoryKey(category: FindingCategory): RuntimeI18nKey {
  return FINDING_CATEGORY_KEYS[category];
}

export function findingActionKey(action: FindingAction): RuntimeI18nKey {
  return FINDING_ACTION_KEYS[action];
}

export function findingStatusKey(status: FindingStatus): RuntimeI18nKey {
  return FINDING_STATUS_KEYS[status];
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
