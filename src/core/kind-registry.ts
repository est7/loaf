// L2 — per-kind metadata registry. Single source of the five STATIC per-kind
// facts that were scattered across journal-entry.ts (payload schema),
// reducer/per-kind.ts (sub_state + actor authority), and journal-mutate.ts
// (spec-emitting), plus current entry versions previously in migration.ts.
// Static per-kind metadata is defined in one registry entry.
//
// METADATA ONLY (ADR-0005 split, see reducer/per-kind.ts history): the registry
// holds static facts. Stateful per-kind refines (reducer apply, preflight step
// 5a/5c, transition validation, snapshot-dependent checks) stay where they are.
// `satisfies Record<EntryKind, KindMeta>` checks totality without erasing schemas.
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
  ALL_ACTOR_PREFIXES,
  ALL_SPEC,
  ANY_NON_DONE,
  ANY_SUB_STATE,
  CLI_ONLY,
  FIX_BACK_EDGE_FROM,
  HUMAN_ONLY,
  VERIFY_OR_POST_LOCK_EXECUTE,
  actorPrefix,
  type ActorPrefix,
  type SubStateGuard,
} from "./kind-guards.js";

export type KindMeta = {
  /** Zod schema the payload is parsed against (preflight + final validate). */
  readonly payload: z.ZodTypeAny;
  /** Current wire version stamped by writers and checked by tail recovery. */
  readonly entrySchemaVersion: number;
  /** sub_states this kind is legal to emit from (preflight authority). */
  readonly subStates: SubStateGuard;
  /** actor-prefix whitelist (preflight authority). */
  readonly actors: readonly ActorPrefix[];
  /** mutateBatch syncs spec.md after appending this kind. */
  readonly emitsSpec: boolean;
};

export const KIND_REGISTRY = {
  // ── State machine transitions ──────────────────────────────────────────────
  "event:phase_advanced": {
    payload: PhaseAdvancedPayload,
    entrySchemaVersion: 1,
    subStates: ANY_SUB_STATE,
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: false,
  },
  "event:ceremony_set": {
    payload: CeremonyPayload,
    entrySchemaVersion: 1,
    subStates: new Set<SubState>(["TRIAGE.score", "TRIAGE.confirm", ...ALL_SPEC, ...ALL_EXECUTE]),
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: false,
  },
  "event:tasks_planned": {
    payload: TasksPlannedPayload,
    entrySchemaVersion: 1,
    subStates: new Set<SubState>(["SPEC.design", "EXECUTE.plan"]),
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: false,
  },
  "event:tasks_amended": {
    payload: TasksAmendedPayload,
    entrySchemaVersion: 1,
    subStates: new Set(VERIFY_OR_POST_LOCK_EXECUTE),
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: false,
  },
  "event:task_claimed": {
    payload: TaskRefPayload,
    entrySchemaVersion: 1,
    subStates: new Set<SubState>(["EXECUTE.work"]),
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: false,
  },
  "event:task_step_started": {
    payload: TaskStepRefPayload,
    entrySchemaVersion: 1,
    subStates: new Set<SubState>(["EXECUTE.work"]),
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: false,
  },
  "event:task_step_done": {
    payload: TaskStepDonePayload,
    entrySchemaVersion: 1,
    subStates: new Set<SubState>(["EXECUTE.work"]),
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: false,
  },
  "event:task_step_reset": {
    payload: TaskStepResetPayload,
    entrySchemaVersion: 1,
    subStates: new Set(FIX_BACK_EDGE_FROM),
    actors: CLI_ONLY,
    emitsSpec: false,
  },
  "event:task_abandoned": {
    payload: TaskAbandonedPayload,
    entrySchemaVersion: 1,
    subStates: new Set<SubState>(["EXECUTE.work"]),
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: false,
  },
  "event:spec_req_added": {
    payload: SpecReqAddedPayload,
    entrySchemaVersion: 1,
    subStates: new Set(ALL_SPEC),
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: true,
  },
  "event:spec_scenario_added": {
    payload: SpecScenarioAddedPayload,
    entrySchemaVersion: 1,
    subStates: new Set(ALL_SPEC),
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: true,
  },
  "event:spec_visual_added": {
    payload: SpecVisualAddedPayload,
    entrySchemaVersion: 1,
    subStates: new Set(ALL_SPEC),
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: true,
  },
  "event:spec_submitted": {
    payload: SpecSubmittedPayload,
    entrySchemaVersion: 1,
    subStates: new Set(ALL_SPEC),
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: true,
  },

  // ── Domain ledger entries ──────────────────────────────────────────────────
  "evidence:added": {
    payload: EvidenceAddedPayload,
    entrySchemaVersion: 1,
    subStates: new Set<SubState>([
      ...ALL_EXECUTE,
      ...VERIFY_OR_POST_LOCK_EXECUTE.filter((s) => s.startsWith("VERIFY")),
    ]),
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: false,
  },
  "lesson:recorded": {
    payload: LessonRecordedPayload,
    entrySchemaVersion: 1,
    subStates: ANY_NON_DONE,
    actors: HUMAN_ONLY,
    emitsSpec: false,
  },
  "scope:recorded": {
    payload: ScopeRecordedPayload,
    entrySchemaVersion: 1,
    subStates: new Set<SubState>(["EXECUTE.work"]),
    actors: CLI_ONLY,
    emitsSpec: false,
  },
  "finding:raised": {
    payload: FindingRaisedPayload,
    entrySchemaVersion: 1,
    subStates: new Set(VERIFY_OR_POST_LOCK_EXECUTE),
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: false,
  },
  "finding:closed": {
    payload: FindingClosedPayload,
    entrySchemaVersion: 1,
    subStates: new Set(VERIFY_OR_POST_LOCK_EXECUTE),
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: false,
  },
  "pending:added": {
    payload: PendingAddedPayload,
    entrySchemaVersion: 1,
    subStates: ANY_SUB_STATE,
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: false,
  },
  "pending:resolved": {
    payload: PendingResolvedPayload,
    entrySchemaVersion: 1,
    subStates: ANY_SUB_STATE,
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: false,
  },

  // ── Gates ──────────────────────────────────────────────────────────────────
  "gate:decided": {
    payload: GateDecidedPayload,
    entrySchemaVersion: 1,
    subStates: new Set<SubState>(["SPEC.design", "VERIFY.accept"]),
    actors: HUMAN_ONLY,
    emitsSpec: false,
  },

  // ── Session lifecycle ──────────────────────────────────────────────────────
  "session:started": {
    payload: SessionStartedPayload,
    entrySchemaVersion: 1,
    subStates: ANY_SUB_STATE,
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: false,
  },
  "session:resumed": {
    payload: SessionResumedPayload,
    entrySchemaVersion: 1,
    subStates: ANY_SUB_STATE,
    actors: ALL_ACTOR_PREFIXES,
    emitsSpec: false,
  },
  "session:delivered": {
    payload: SessionReasonPayload,
    entrySchemaVersion: 1,
    subStates: new Set<SubState>(["EXECUTE.done", "VERIFY.accept", "SETTLE.lessons"]),
    actors: HUMAN_ONLY,
    emitsSpec: false,
  },
  "session:archived": {
    payload: SessionReasonPayload,
    entrySchemaVersion: 1,
    subStates: ANY_NON_DONE,
    actors: HUMAN_ONLY,
    emitsSpec: false,
  },
  "session:abandoned": {
    payload: SessionReasonPayload,
    entrySchemaVersion: 1,
    subStates: ANY_NON_DONE,
    actors: HUMAN_ONLY,
    emitsSpec: false,
  },

  // ── Spike branch closure ───────────────────────────────────────────────────
  "spike:converted": {
    payload: SpikeConvertedPayload,
    entrySchemaVersion: 1,
    subStates: ANY_NON_DONE,
    actors: HUMAN_ONLY,
    emitsSpec: false,
  },
} satisfies Record<EntryKind, KindMeta>;

const ALL_KINDS = Object.keys(KIND_REGISTRY) as EntryKind[];

// ── Derived surfaces (the five metadata tables — same names, now single-sourced) ──

export const ENTRY_SCHEMA_VERSIONS: Record<EntryKind, number> = Object.fromEntries(
  ALL_KINDS.map((kind) => [kind, KIND_REGISTRY[kind].entrySchemaVersion]),
) as Record<EntryKind, number>;

export type PayloadSchemas = {
  [K in EntryKind]: (typeof KIND_REGISTRY)[K]["payload"];
};

export const PER_KIND_PAYLOAD = Object.fromEntries(
  ALL_KINDS.map((k) => [k, KIND_REGISTRY[k].payload]),
) as PayloadSchemas;

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
  const meta: KindMeta = KIND_REGISTRY[kind];
  return meta.actors.includes(prefix);
}
