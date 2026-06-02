import type { EvidenceKind } from "../core/evidence-schema.js";
import type { FindingAction, FindingCategory } from "../core/finding-schema.js";
import type { SubState } from "../core/journal-entry.js";
import type { TaskFullProjection } from "../core/task-schema.js";
import type { TuiStatusBucket } from "./tui/list-model.js";

export type TaskKind = TaskFullProjection["kind"];
export type TaskStatus = TaskFullProjection["status"];
export type FindingStatus = "open" | "closed";
export type Phase = "TRIAGE" | "SPEC" | "EXECUTE" | "VERIFY" | "SETTLE" | "DONE";
export type PendingKind =
  | "ask_user_question"
  | "gate_decision"
  | "spec_clarification"
  | "finding_decision"
  | "profile_escalation";
export type MigratedDiagnosticCode =
  | "INVALID_FORMAT"
  | "MUTUALLY_EXCLUSIVE_FLAGS"
  | "DRY_RUN_NOT_APPLICABLE"
  | "FEATURE_NOT_FOUND"
  | "FEATURE_AMBIGUOUS"
  | "SESSION_CWD_MISMATCH"
  | "SESSION_SHORT_AMBIGUOUS"
  | "SESSION_NOT_FOUND";

export type FailureSiteDiagnosticCode =
  | "USAGE"
  | "SCHEMA_VALIDATION_FAILED"
  | "NO_SESSION"
  | "INPUT_FILE_NOT_FOUND";

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

export const FINDING_STATUS_VALUES = [
  "open",
  "closed",
] as const satisfies readonly FindingStatus[];

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
  "SETTLE.reconcile": "sub_state.SETTLE.reconcile",
  "SETTLE.lessons": "sub_state.SETTLE.lessons",
  "DONE.delivered": "sub_state.DONE.delivered",
  "DONE.archived": "sub_state.DONE.archived",
  "DONE.abandoned": "sub_state.DONE.abandoned",
} as const satisfies Record<SubState, string>;

export const MIGRATED_DIAGNOSTIC_CODES = [
  "INVALID_FORMAT",
  "MUTUALLY_EXCLUSIVE_FLAGS",
  "DRY_RUN_NOT_APPLICABLE",
  "FEATURE_NOT_FOUND",
  "FEATURE_AMBIGUOUS",
  "SESSION_CWD_MISMATCH",
  "SESSION_SHORT_AMBIGUOUS",
  "SESSION_NOT_FOUND",
] as const satisfies readonly MigratedDiagnosticCode[];

const DIAGNOSTIC_KEYS = {
  INVALID_FORMAT: "diagnostic.INVALID_FORMAT",
  MUTUALLY_EXCLUSIVE_FLAGS: "diagnostic.MUTUALLY_EXCLUSIVE_FLAGS",
  DRY_RUN_NOT_APPLICABLE: "diagnostic.DRY_RUN_NOT_APPLICABLE",
  FEATURE_NOT_FOUND: "diagnostic.FEATURE_NOT_FOUND",
  FEATURE_AMBIGUOUS: "diagnostic.FEATURE_AMBIGUOUS",
  SESSION_CWD_MISMATCH: "diagnostic.SESSION_CWD_MISMATCH",
  SESSION_SHORT_AMBIGUOUS: "diagnostic.SESSION_SHORT_AMBIGUOUS",
  SESSION_NOT_FOUND: "diagnostic.SESSION_NOT_FOUND",
} as const satisfies Record<MigratedDiagnosticCode, string>;

export const FAILURE_SITE_KEYS = {
  sessionsListSelectorConflict: "failure.sessions_list.selector_conflict",
  tuiSelectorConflict: "failure.tui.selector_conflict",
  tuiInteractiveOnly: "failure.tui.interactive_only",
  hookMissingEvent: "failure.hook.missing_event",
  hookUnknownEvent: "failure.hook.unknown_event",
  hookStdinParseFailed: "failure.hook.stdin_parse_failed",
  hookWritePathMissing: "failure.hook.write_path_missing",
  checkSelectorConflict: "failure.check.selector_conflict",
  checkKindRequired: "failure.check.kind_required",
  checkPathMissing: "failure.check.path_missing",
  checkKindInvalid: "failure.check.kind_invalid",
  schemaSelectorConflict: "failure.schema.selector_conflict",
  schemaValidation: "failure.schema.validation",
  dispatchSessionFeatureDirConflict: "failure.dispatch.session_feature_dir_conflict",
  dispatchFeatureDirRequiresFeature: "failure.dispatch.feature_dir_requires_feature",
  startLabelTooShort: "failure.start.label_too_short",
  startWorkspaceEmpty: "failure.start.workspace_empty",
  handoffReasonTooShort: "failure.handoff.reason_too_short",
  handoffPackValidationFailed: "failure.handoff.pack_validation_failed",
  profileInputFileMissing: "failure.profile.input_file_missing",
  profileInputFileUnreadable: "failure.profile.input_file_unreadable",
  tasksAddEmptyArray: "failure.tasks_add.empty_array",
  lessonsTextTooShort: "failure.lessons.text_too_short",
  lessonsReasonTooShort: "failure.lessons.reason_too_short",
  lessonsTextFileMutex: "failure.lessons.text_file_mutex",
  lessonsFileMissing: "failure.lessons.file_missing",
  findingStatusInvalid: "failure.finding.status_invalid",
  writeGuardConfigInvalid: "failure.write_guard.config_invalid",
  noSessionStatus: "failure.no_session.status",
  noSessionAdvance: "failure.no_session.advance",
  noSessionTasks: "failure.no_session.tasks",
  noSessionPending: "failure.no_session.pending",
  noSessionFinding: "failure.no_session.finding",
  noSessionVerify: "failure.no_session.verify",
  noSessionGeneric: "failure.no_session.generic",
} as const;

export type FailureSiteKey = (typeof FAILURE_SITE_KEYS)[keyof typeof FAILURE_SITE_KEYS];

export const FAILURE_SITE_TEMPLATES = {
  sessionsListSelectorConflict: {
    key: FAILURE_SITE_KEYS.sessionsListSelectorConflict,
    code: "USAGE",
    template: "sessions list does not accept {conflicting} — it lists across all sessions; use --in-cwd to filter",
  },
  tuiSelectorConflict: {
    key: FAILURE_SITE_KEYS.tuiSelectorConflict,
    code: "USAGE",
    template: "tui does not accept {conflicting} — it lists across all sessions; selectors are nonsensical for an interactive UI",
  },
  tuiInteractiveOnly: {
    key: FAILURE_SITE_KEYS.tuiInteractiveOnly,
    code: "USAGE",
    template: "tui is interactive-only; use `loaf sessions list --format json` for scriptable session output",
  },
  hookMissingEvent: {
    key: FAILURE_SITE_KEYS.hookMissingEvent,
    code: "USAGE",
    template: "loaf hook requires an event token; one of: {events}. Run `loaf hook --list-events` for the full enum",
  },
  hookUnknownEvent: {
    key: FAILURE_SITE_KEYS.hookUnknownEvent,
    code: "USAGE",
    template: "unknown hook event '{event}'; expected one of: {allowed}. Did you mean '{suggestion}'?",
  },
  hookStdinParseFailed: {
    key: FAILURE_SITE_KEYS.hookStdinParseFailed,
    code: "SCHEMA_VALIDATION_FAILED",
    template: "{reason}",
  },
  hookWritePathMissing: {
    key: FAILURE_SITE_KEYS.hookWritePathMissing,
    code: "USAGE",
    template: "write-side hook requires --path <P> or a non-TTY stdin hook payload (tool_input.file_path)",
  },
  checkSelectorConflict: {
    key: FAILURE_SITE_KEYS.checkSelectorConflict,
    code: "USAGE",
    template: "check does not accept {conflicting} — it validates a file by path, independent of any feature session",
  },
  checkKindRequired: {
    key: FAILURE_SITE_KEYS.checkKindRequired,
    code: "USAGE",
    template: "`{subject}` is not a file path. To validate a {kind} artifact, pass its path: `{suggestion}` (noun-first `loaf {kind} check` is reserved for a future release)",
  },
  checkPathMissing: {
    key: FAILURE_SITE_KEYS.checkPathMissing,
    code: "INPUT_FILE_NOT_FOUND",
    template: "file not found: {path}",
  },
  checkKindInvalid: {
    key: FAILURE_SITE_KEYS.checkKindInvalid,
    code: "USAGE",
    template: "--kind '{value}' is not recognized; expected one of {allowed_kinds_human}",
  },
  schemaSelectorConflict: {
    key: FAILURE_SITE_KEYS.schemaSelectorConflict,
    code: "USAGE",
    template: "{subject} does not accept {conflicting} — schema dumps are feature-agnostic",
  },
  schemaValidation: {
    key: FAILURE_SITE_KEYS.schemaValidation,
    code: "SCHEMA_VALIDATION_FAILED",
    template: "{kind} at {path} failed schema validation ({error_count} {error_word})",
  },
  dispatchSessionFeatureDirConflict: {
    key: FAILURE_SITE_KEYS.dispatchSessionFeatureDirConflict,
    code: "USAGE",
    template: "{conflicting} cannot be combined with --feature-dir (session identity comes from registry; manual featureDir is contradictory)",
  },
  dispatchFeatureDirRequiresFeature: {
    key: FAILURE_SITE_KEYS.dispatchFeatureDirRequiresFeature,
    code: "USAGE",
    template: "--feature-dir requires --feature <name> or $LOAF_FEATURE to name the feature",
  },
  startLabelTooShort: {
    key: FAILURE_SITE_KEYS.startLabelTooShort,
    code: "USAGE",
    template: "--label must be at least {min_length} characters",
  },
  startWorkspaceEmpty: {
    key: FAILURE_SITE_KEYS.startWorkspaceEmpty,
    code: "USAGE",
    template: "--workspace must not be empty",
  },
  handoffReasonTooShort: {
    key: FAILURE_SITE_KEYS.handoffReasonTooShort,
    code: "USAGE",
    template: "--reason must be ≥{min_length} chars (got {reason_length})",
  },
  handoffPackValidationFailed: {
    key: FAILURE_SITE_KEYS.handoffPackValidationFailed,
    code: "SCHEMA_VALIDATION_FAILED",
    template: "ResumePack failed runtime validation (builder bug or schema drift)",
  },
  profileInputFileMissing: {
    key: FAILURE_SITE_KEYS.profileInputFileMissing,
    code: "INPUT_FILE_NOT_FOUND",
    template: "input file does not exist: {path}",
  },
  profileInputFileUnreadable: {
    key: FAILURE_SITE_KEYS.profileInputFileUnreadable,
    code: "INPUT_FILE_NOT_FOUND",
    template: "cannot read input file {path}: {error}",
  },
  tasksAddEmptyArray: {
    key: FAILURE_SITE_KEYS.tasksAddEmptyArray,
    code: "SCHEMA_VALIDATION_FAILED",
    template: "tasks add input is an empty array",
  },
  lessonsTextTooShort: {
    key: FAILURE_SITE_KEYS.lessonsTextTooShort,
    code: "USAGE",
    template: "lesson text must be ≥{min_length} chars (got {lesson_text_length})",
  },
  lessonsReasonTooShort: {
    key: FAILURE_SITE_KEYS.lessonsReasonTooShort,
    code: "USAGE",
    template: "--reason must be ≥{min_length} chars (got {reason_length})",
  },
  lessonsTextFileMutex: {
    key: FAILURE_SITE_KEYS.lessonsTextFileMutex,
    code: "USAGE",
    template: "exactly one of --text or --file required ({provided_state})",
  },
  lessonsFileMissing: {
    key: FAILURE_SITE_KEYS.lessonsFileMissing,
    code: "INPUT_FILE_NOT_FOUND",
    template: "lesson file not found: {path}",
  },
  findingStatusInvalid: {
    key: FAILURE_SITE_KEYS.findingStatusInvalid,
    code: "USAGE",
    template: "--status must be one of: {allowed_statuses_human} (got {value})",
  },
  writeGuardConfigInvalid: {
    key: FAILURE_SITE_KEYS.writeGuardConfigInvalid,
    code: "SCHEMA_VALIDATION_FAILED",
    template: "write-guard blocked: {reason}",
  },
  noSessionStatus: {
    key: FAILURE_SITE_KEYS.noSessionStatus,
    code: "NO_SESSION",
    template: "run `loaf start {feature}` first",
  },
  noSessionAdvance: {
    key: FAILURE_SITE_KEYS.noSessionAdvance,
    code: "NO_SESSION",
    template: "run `loaf start {feature}` first",
  },
  noSessionTasks: {
    key: FAILURE_SITE_KEYS.noSessionTasks,
    code: "NO_SESSION",
    template: "run `loaf start {feature}` first",
  },
  noSessionPending: {
    key: FAILURE_SITE_KEYS.noSessionPending,
    code: "NO_SESSION",
    template: "run `loaf start {feature}` first",
  },
  noSessionFinding: {
    key: FAILURE_SITE_KEYS.noSessionFinding,
    code: "NO_SESSION",
    template: "run `loaf start {feature}` first",
  },
  noSessionVerify: {
    key: FAILURE_SITE_KEYS.noSessionVerify,
    code: "NO_SESSION",
    template: "run `loaf start {feature}` first",
  },
  noSessionGeneric: {
    key: FAILURE_SITE_KEYS.noSessionGeneric,
    code: "NO_SESSION",
    template: "run `loaf start {feature}` first",
  },
} as const satisfies Record<string, {
  key: FailureSiteKey;
  code: FailureSiteDiagnosticCode;
  template: string;
}>;

export const SUCCESS_KEYS = {
  nextAdvance: "success.next.advance",
  nextDeliver: "success.next.deliver",
  nextSettle: "success.next.settle",
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
  verifyStatusFailureSummaryOne: "chrome.verify_status.failure_summary_one",
  verifyStatusFailureSummaryMany: "chrome.verify_status.failure_summary_many",
  verifyStatusDiagnosticOnly: "chrome.verify_status.diagnostic_only",
} as const;

export type ChromeKey = (typeof CHROME_KEYS)[keyof typeof CHROME_KEYS];

export type RuntimeI18nKey =
  | (typeof STATUS_INDICATOR_KEYS)[keyof typeof STATUS_INDICATOR_KEYS]
  | (typeof TASK_KIND_KEYS)[keyof typeof TASK_KIND_KEYS]
  | (typeof TASK_STATUS_KEYS)[keyof typeof TASK_STATUS_KEYS]
  | (typeof EVIDENCE_KIND_KEYS)[keyof typeof EVIDENCE_KIND_KEYS]
  | (typeof FINDING_CATEGORY_KEYS)[keyof typeof FINDING_CATEGORY_KEYS]
  | (typeof FINDING_ACTION_KEYS)[keyof typeof FINDING_ACTION_KEYS]
  | (typeof FINDING_STATUS_KEYS)[keyof typeof FINDING_STATUS_KEYS]
  | (typeof PENDING_KIND_KEYS)[keyof typeof PENDING_KIND_KEYS]
  | (typeof PHASE_KEYS)[keyof typeof PHASE_KEYS]
  | (typeof SUB_STATE_KEYS)[keyof typeof SUB_STATE_KEYS]
  | (typeof DIAGNOSTIC_KEYS)[keyof typeof DIAGNOSTIC_KEYS]
  | FailureSiteKey
  | SuccessKey
  | ChromeKey;

export const RUNTIME_I18N_KEYS: readonly RuntimeI18nKey[] = [
  ...Object.values(STATUS_INDICATOR_KEYS),
  ...Object.values(TASK_KIND_KEYS),
  ...Object.values(TASK_STATUS_KEYS),
  ...Object.values(EVIDENCE_KIND_KEYS),
  ...Object.values(FINDING_CATEGORY_KEYS),
  ...Object.values(FINDING_ACTION_KEYS),
  ...Object.values(FINDING_STATUS_KEYS),
  ...Object.values(PENDING_KIND_KEYS),
  ...Object.values(PHASE_KEYS),
  ...Object.values(SUB_STATE_KEYS),
  ...Object.values(DIAGNOSTIC_KEYS),
  ...Object.values(FAILURE_SITE_KEYS),
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

export function diagnosticKey(code: MigratedDiagnosticCode): RuntimeI18nKey {
  return DIAGNOSTIC_KEYS[code];
}
