// L2 — per-kind metadata registry. Single source of the five STATIC per-kind
// facts that were scattered across journal-entry.ts (payload schema,
// reducer-implemented), reducer/per-kind.ts (sub_state + actor authority), and
// journal-mutate.ts (spec-emitting). Adding a kind is now one registry entry.
//
// METADATA ONLY (ADR-0005 split, see reducer/per-kind.ts history): the registry
// holds static facts. Stateful per-kind refines (reducer apply, preflight step
// 5a/5c, transition validation, snapshot-dependent checks) stay where they are.
// `Record<EntryKind, KindMeta>` makes the table total at compile time.
//
// Layering (no cycle): imports schema consts from journal-entry.ts (base) and
// guard vocabulary from kind-guards.ts. journal-entry.ts must NOT import back.

import type { z } from "zod";

import {
  type EntryKind,
  type SubState,
  CeremonyPayload,
  EvidenceAddedPayload,
  FindingClosedPayload,
  FindingRaisedPayload,
  GateDecidedPayload,
  LessonRecordedPayload,
  MigrationSnapshotImportedPayload,
  PendingAddedPayload,
  PendingResolvedPayload,
  PhaseAdvancedPayload,
  ScopeRecordedPayload,
  SessionReasonPayload,
  SessionResumedPayload,
  SessionStartedPayload,
  SpecReqAddedPayload,
  SpecScenarioAddedPayload,
  SpecSubmittedPayload,
  SpecVisualAddedPayload,
  SpikeConvertedPayload,
  TaskAbandonedPayload,
  TaskRefPayload,
  TaskStepDonePayload,
  TaskStepRefPayload,
  TaskStepResetPayload,
  TasksAmendedPayload,
  TasksPlannedPayload,
} from "./journal-entry.js";
import {
  ALL_EXECUTE,
  ALL_NON_MIGRATION,
  ALL_SPEC,
  ANY_NON_DONE,
  ANY_SUB_STATE,
  CLI_ONLY,
  FIX_BACK_EDGE_FROM,
  HUMAN_ONLY,
  MIGRATION_ONLY,
  VERIFY_OR_POST_LOCK_EXECUTE,
  actorPrefix,
  type ActorPrefix,
  type SubStateGuard,
} from "./kind-guards.js";

export type KindMeta = {
  /** Zod schema the payload is parsed against (preflight + final validate). */
  readonly payload: z.ZodTypeAny;
  /** reducer.ts has an apply case for this kind (journal-mutate gates on it). */
  readonly reducerImplemented: boolean;
  /** sub_states this kind is legal to emit from (preflight authority). */
  readonly subStates: SubStateGuard;
  /** actor-prefix whitelist (preflight authority). */
  readonly actors: readonly ActorPrefix[];
  /** mutateBatch syncs spec.md after appending this kind. */
  readonly emitsSpec: boolean;
};

export const KIND_REGISTRY: Record<EntryKind, KindMeta> = {
  // ── State machine transitions ──────────────────────────────────────────────
  "event:phase_advanced": {
    payload: PhaseAdvancedPayload,
    reducerImplemented: true,
    subStates: ANY_SUB_STATE,
    actors: ALL_NON_MIGRATION,
    emitsSpec: false,
  },
  "event:ceremony_set": {
    payload: CeremonyPayload,
    reducerImplemented: true,
    subStates: new Set<SubState>(["TRIAGE.score", "TRIAGE.confirm", ...ALL_SPEC, ...ALL_EXECUTE]),
    actors: ALL_NON_MIGRATION,
    emitsSpec: false,
  },
  "event:tasks_planned": {
    payload: TasksPlannedPayload,
    reducerImplemented: true,
    subStates: new Set<SubState>(["SPEC.design", "EXECUTE.plan"]),
    actors: ALL_NON_MIGRATION,
    emitsSpec: false,
  },
  "event:tasks_amended": {
    payload: TasksAmendedPayload,
    reducerImplemented: true,
    subStates: new Set(VERIFY_OR_POST_LOCK_EXECUTE),
    actors: ALL_NON_MIGRATION,
    emitsSpec: false,
  },
  "event:task_claimed": {
    payload: TaskRefPayload,
    reducerImplemented: true,
    subStates: new Set<SubState>(["EXECUTE.work"]),
    actors: ALL_NON_MIGRATION,
    emitsSpec: false,
  },
  "event:task_step_started": {
    payload: TaskStepRefPayload,
    reducerImplemented: true,
    subStates: new Set<SubState>(["EXECUTE.work"]),
    actors: ALL_NON_MIGRATION,
    emitsSpec: false,
  },
  "event:task_step_done": {
    payload: TaskStepDonePayload,
    reducerImplemented: true,
    subStates: new Set<SubState>(["EXECUTE.work"]),
    actors: ALL_NON_MIGRATION,
    emitsSpec: false,
  },
  "event:task_step_reset": {
    payload: TaskStepResetPayload,
    reducerImplemented: true,
    subStates: new Set(FIX_BACK_EDGE_FROM),
    actors: CLI_ONLY,
    emitsSpec: false,
  },
  "event:task_abandoned": {
    payload: TaskAbandonedPayload,
    reducerImplemented: true,
    subStates: new Set<SubState>(["EXECUTE.work"]),
    actors: ALL_NON_MIGRATION,
    emitsSpec: false,
  },
  "event:spec_req_added": {
    payload: SpecReqAddedPayload,
    reducerImplemented: true,
    subStates: new Set(ALL_SPEC),
    actors: ALL_NON_MIGRATION,
    emitsSpec: true,
  },
  "event:spec_scenario_added": {
    payload: SpecScenarioAddedPayload,
    reducerImplemented: true,
    subStates: new Set(ALL_SPEC),
    actors: ALL_NON_MIGRATION,
    emitsSpec: true,
  },
  "event:spec_visual_added": {
    payload: SpecVisualAddedPayload,
    reducerImplemented: true,
    subStates: new Set(ALL_SPEC),
    actors: ALL_NON_MIGRATION,
    emitsSpec: true,
  },
  "event:spec_submitted": {
    payload: SpecSubmittedPayload,
    reducerImplemented: true,
    subStates: new Set(ALL_SPEC),
    actors: ALL_NON_MIGRATION,
    emitsSpec: true,
  },

  // ── Domain ledger entries ──────────────────────────────────────────────────
  "evidence:added": {
    payload: EvidenceAddedPayload,
    reducerImplemented: true,
    subStates: new Set<SubState>([
      ...ALL_EXECUTE,
      ...VERIFY_OR_POST_LOCK_EXECUTE.filter((s) => s.startsWith("VERIFY")),
    ]),
    actors: ALL_NON_MIGRATION,
    emitsSpec: false,
  },
  "lesson:recorded": {
    payload: LessonRecordedPayload,
    reducerImplemented: true,
    subStates: ANY_NON_DONE,
    actors: HUMAN_ONLY,
    emitsSpec: false,
  },
  "scope:recorded": {
    payload: ScopeRecordedPayload,
    reducerImplemented: true,
    subStates: new Set<SubState>(["EXECUTE.work"]),
    actors: CLI_ONLY,
    emitsSpec: false,
  },
  "finding:raised": {
    payload: FindingRaisedPayload,
    reducerImplemented: true,
    subStates: new Set(VERIFY_OR_POST_LOCK_EXECUTE),
    actors: ALL_NON_MIGRATION,
    emitsSpec: false,
  },
  "finding:closed": {
    payload: FindingClosedPayload,
    reducerImplemented: true,
    subStates: new Set(VERIFY_OR_POST_LOCK_EXECUTE),
    actors: ALL_NON_MIGRATION,
    emitsSpec: false,
  },
  "pending:added": {
    payload: PendingAddedPayload,
    reducerImplemented: true,
    subStates: ANY_SUB_STATE,
    actors: ALL_NON_MIGRATION,
    emitsSpec: false,
  },
  "pending:resolved": {
    payload: PendingResolvedPayload,
    reducerImplemented: true,
    subStates: ANY_SUB_STATE,
    actors: ALL_NON_MIGRATION,
    emitsSpec: false,
  },

  // ── Gates ──────────────────────────────────────────────────────────────────
  "gate:decided": {
    payload: GateDecidedPayload,
    reducerImplemented: true,
    subStates: new Set<SubState>(["SPEC.design", "VERIFY.accept"]),
    actors: HUMAN_ONLY,
    emitsSpec: false,
  },

  // ── Session lifecycle ──────────────────────────────────────────────────────
  "session:started": {
    payload: SessionStartedPayload,
    reducerImplemented: true,
    subStates: ANY_SUB_STATE,
    actors: ALL_NON_MIGRATION,
    emitsSpec: false,
  },
  "session:resumed": {
    payload: SessionResumedPayload,
    reducerImplemented: true,
    subStates: ANY_SUB_STATE,
    actors: ALL_NON_MIGRATION,
    emitsSpec: false,
  },
  "session:delivered": {
    payload: SessionReasonPayload,
    reducerImplemented: true,
    subStates: new Set<SubState>(["EXECUTE.done", "VERIFY.accept", "SETTLE.lessons"]),
    actors: HUMAN_ONLY,
    emitsSpec: false,
  },
  "session:archived": {
    payload: SessionReasonPayload,
    reducerImplemented: true,
    subStates: ANY_NON_DONE,
    actors: HUMAN_ONLY,
    emitsSpec: false,
  },
  "session:abandoned": {
    payload: SessionReasonPayload,
    reducerImplemented: true,
    subStates: ANY_NON_DONE,
    actors: HUMAN_ONLY,
    emitsSpec: false,
  },

  // ── Spike branch closure ───────────────────────────────────────────────────
  "spike:converted": {
    payload: SpikeConvertedPayload,
    reducerImplemented: true,
    subStates: ANY_NON_DONE,
    actors: HUMAN_ONLY,
    emitsSpec: false,
  },

  // ── Migration ──────────────────────────────────────────────────────────────
  "migration:snapshot_imported": {
    payload: MigrationSnapshotImportedPayload,
    reducerImplemented: true,
    subStates: ANY_SUB_STATE,
    actors: MIGRATION_ONLY,
    emitsSpec: false,
  },
};

const ALL_KINDS = Object.keys(KIND_REGISTRY) as EntryKind[];

// ── Derived surfaces (the five old tables — same names, now single-sourced) ──

export const PER_KIND_PAYLOAD: Record<EntryKind, z.ZodTypeAny> = Object.fromEntries(
  ALL_KINDS.map((k) => [k, KIND_REGISTRY[k].payload]),
) as Record<EntryKind, z.ZodTypeAny>;

export const REDUCER_IMPLEMENTED_KINDS: ReadonlySet<EntryKind> = new Set(
  ALL_KINDS.filter((k) => KIND_REGISTRY[k].reducerImplemented),
);

export const PER_KIND_SUB_STATE: Record<EntryKind, SubStateGuard> = Object.fromEntries(
  ALL_KINDS.map((k) => [k, KIND_REGISTRY[k].subStates]),
) as Record<EntryKind, SubStateGuard>;

export const PER_KIND_ACTOR: Record<EntryKind, readonly ActorPrefix[]> = Object.fromEntries(
  ALL_KINDS.map((k) => [k, KIND_REGISTRY[k].actors]),
) as Record<EntryKind, readonly ActorPrefix[]>;

export const SPEC_EMITTING_KINDS: ReadonlySet<EntryKind> = new Set(
  ALL_KINDS.filter((k) => KIND_REGISTRY[k].emitsSpec),
);

// ── Accessors (authority checks; unchanged semantics) ────────────────────────

export function isSubStateAllowed(kind: EntryKind, subState: SubState): boolean {
  const guard = KIND_REGISTRY[kind].subStates;
  if (guard === ANY_SUB_STATE) return true;
  if (guard === ANY_NON_DONE) return !subState.startsWith("DONE.");
  return guard.has(subState);
}

export function isActorAllowed(kind: EntryKind, actor: string): boolean {
  const prefix = actorPrefix(actor);
  if (prefix === null) return false;
  return KIND_REGISTRY[kind].actors.includes(prefix);
}
