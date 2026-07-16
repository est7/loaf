// loaf-cli protocol schema compatibility facade.
//
// Canonical declarations live with their runtime domain owners. This module
// intentionally contains re-exports only so legacy docs/schemas consumers keep
// a stable import path without creating a second contract source.

export {
  AttachmentPayload as Attachment,
  EvidenceAddInput,
  EvidenceAddInputBatched,
  EvidenceKind,
  EvidenceResult,
  VerifyCheckKind,
} from "../src/core/evidence-schema.js";
export { EVIDENCE_COMPAT } from "../src/core/evidence-compat.js";
export { DiagnosticCode, ErrorEntry, ERROR_CATALOG } from "../src/core/error-catalog.js";
export {
  FINDING_ACTION_GRID,
  FINDING_ACTION_TARGET_MODE as FINDING_ACTION_EFFECTS,
  FINDING_UNUSUAL_REASON_MIN_LENGTH,
  FindingAction,
  FINDING_ACTION_TARGET_MODE as FindingActionEffect,
  FindingActionRisk,
  FindingCategory,
  FindingsEvent,
  FindingTarget as FindingResolutionPayload,
} from "../src/core/finding-schema.js";
export {
  ActorString,
  AttachmentRef,
  BatchId,
  Ceremony,
  CeremonyLabel,
  EntryId,
  EntryKind,
  GateName,
  JournalEntry,
  LongTextField,
  PendingId,
  PendingPromptKind,
  Phase,
  SignatureEnvelope,
  SubState,
} from "../src/core/journal-entry.js";
export {
  EarsType,
  MeasurablePayload as Measurable,
  NeedsClarification,
  RequirementEarsVerifiable as RequirementEars,
  RequirementEventDrivenShape as RequirementEventDriven,
  RequirementOptionalShape as RequirementOptional,
  RequirementStateDrivenShape as RequirementStateDriven,
  RequirementUbiquitousShape as RequirementUbiquitous,
  RequirementUnwantedShape as RequirementUnwanted,
  ScenarioGherkin,
  SchemaVersionPayload as SchemaVersion,
  SpecFrontmatter,
  VisualContract,
} from "../src/core/spec-schema.js";
export {
  AnyStep,
  ApplicabilityPayload as Applicability,
  BehavioralExecutionPayload as BehavioralExecution,
  BehavioralStep,
  ChoreExecutionPayload as ChoreExecution,
  ChoreStep,
  DocsExecutionPayload as DocsExecution,
  DocsStep,
  RECOMMENDED_TASK_LABELS,
  STEP_TO_KIND,
  SpikeExecutionPayload as SpikeExecution,
  SpikeStep,
  StepStatusPayload as StepStatus,
  StructuralExecutionPayload as StructuralExecution,
  StructuralStep,
  TaskBehavioralPayload as TaskBehavioral,
  TaskChorePayload as TaskChore,
  TaskDocsPayload as TaskDocs,
  TaskExecutionStepPayload as TaskExecutionStep,
  TaskFullPayload as Task,
  TaskInput,
  TaskInputBatched,
  TaskKind,
  TaskSpikePayload as TaskSpike,
  TaskStructuralPayload as TaskStructural,
  TaskVisualUiPayload as TaskVisualUi,
  VisualUiExecutionPayload as VisualUiExecution,
  VisualUiStep,
} from "../src/core/task-schema.js";

export {
  ENTRY_SCHEMA_VERSIONS,
  MIGRATION_V1_TO_V2_BOUNDARY,
  UPCASTER_REGISTRY,
} from "../src/core/migration.js";
export type { Upcaster } from "../src/core/migration.js";
export { SnapshotMeta } from "../src/core/snapshot.js";
export {
  EvidenceEntry,
  EvidenceJson,
  FindingsJson,
  PendingJson,
  PendingProjectionEntry,
  PendingQueueEntry as PendingPrompt,
  PendingQueueEntry as PendingPromptEntry,
  RegistryFile,
  SessionRuntimeFile,
  StateProjection,
  TasksJson,
} from "../src/core/projection-schema.js";
export {
  AcCoverage,
  Drift,
  IterationStats,
  ReconcileJson,
  VerifyCheckSnapshot,
} from "../src/core/reconcile-schema.js";
export { NextAction, NextOwnerVerb } from "../src/core/reducer/transition.js";
export { NextOutput } from "../src/core/next-action.js";
export { GateDiagnostic } from "../src/core/gates/gate-diagnostic.js";
export {
  RESUME_PACK_RECENT_CAP,
  ResumePack,
  TasksActiveSummary,
} from "../src/core/resume-pack-schema.js";
export { LoafConfig } from "../src/core/loaf-config.js";
export { TraceEvent } from "../src/cli/trace-writer.js";
export {
  ESCALATION_DETECTIONS,
  EscalationDetection,
  EscalationTrigger,
} from "../src/core/escalation-schema.js";
export {
  MutationRights,
  SubStateContract,
  SUB_STATE_CONTRACTS,
} from "../src/core/sub-state-contracts.js";
export {
  STEP_WRITE_CATEGORIES_BY_KIND,
  STEP_WRITE_PATHS_BY_KIND,
  VERIFY_CHECK_WRITE_CATEGORIES,
  VERIFY_CHECK_WRITE_PATHS,
  WriteCategory,
} from "../src/core/step-write-paths.js";
export { SPEC_LOCK_CHECKS } from "../src/core/gates/spec-lock-check.js";
export { VERIFY_ACCEPT_CHECKS } from "../src/core/gates/verify-accept-check.js";
export { TASK_CACHE_CONSISTENCY_CHECKS } from "../src/core/gates/task-proof.js";
export { ChangedPath } from "../src/core/write-guard.js";
export { I18N_BUNDLE_CATEGORIES } from "../src/cli/i18n.js";
export { V1_DONE_CRITERIA } from "../src/core/version-contract.js";
export { CONCURRENCY_INVARIANTS } from "../src/core/concurrency-contract.js";
export { FLAG_EXCLUSIONS } from "../src/cli/flag-exclusions.js";
export { HOOK_EVENT_TO_CLAUDE_CODE, HookEvent } from "../src/core/hook-events.js";
export {
  CONTEXT_PACK_TEMPLATES,
  ContextPackProjection,
} from "../src/cli/context-pack-schema.js";
export {
  INPUT_SCHEMAS,
  MutatorCommand,
  SpecReqInput,
  SpecReqInputBatched,
  SpecScenarioInput,
  SpecScenarioInputBatched,
  SpecVisualInput,
  SpecVisualInputBatched,
} from "../src/cli/input-schemas.js";
export { InputSourceResolver } from "../src/cli/input-source.js";
