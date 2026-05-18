// Per-kind reducer invariants (ADR-0005 §3.6 table).
//
// Two declarative tables drive preflight authority checks:
//
//   - PER_KIND_SUB_STATE — set of sub_states from which this entry kind is
//     legal to emit (closed set; "*" widens to "any sub_state but DONE.*").
//
//   - PER_KIND_ACTOR — actor prefix whitelist per kind. Empty = no constraint
//     beyond ActorString regex; non-empty = strict subset enforcement.
//
// Per-kind extra refines (`tasks_planned` requires based_on.spec ===
// spec_version; `session:archived` requires reason; etc.) are intentionally
// NOT in these tables — they live alongside the reducer apply path in
// `reducer.ts` per Stage 2 (incremental promotion from spike). This split
// keeps preflight's authority gates table-driven (data) and the apply path
// stateful (code that touches the projection).

import type { EntryKind, SubState } from "../journal-entry.js";

// Wildcards used by the sub_state table — saves enumerating 20 sub_states
// where a kind is broadly legal.
export const ANY_SUB_STATE = Symbol("any-sub-state");
export const ANY_NON_DONE = Symbol("any-non-done");

type SubStateGuard = ReadonlySet<SubState> | typeof ANY_SUB_STATE | typeof ANY_NON_DONE;

const VERIFY_OR_POST_LOCK_EXECUTE: SubState[] = [
  "EXECUTE.plan", "EXECUTE.work", "EXECUTE.done",
  "VERIFY.plan", "VERIFY.run", "VERIFY.review",
  "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept",
];

const ALL_SPEC: SubState[] = [
  "SPEC.proposal", "SPEC.spec", "SPEC.plan", "SPEC.design",
];

const ALL_EXECUTE: SubState[] = ["EXECUTE.plan", "EXECUTE.work", "EXECUTE.done"];

export const PER_KIND_SUB_STATE: Record<EntryKind, SubStateGuard> = {
  // State machine transitions
  "event:phase_advanced": ANY_SUB_STATE, // validateTransition gates the edge itself
  "event:ceremony_set": new Set(["TRIAGE.score", "TRIAGE.confirm"]),
  // Protocol §1800+1848: `loaf tasks submit` (initial whole-plan) emits
  // event:tasks_planned at SPEC.design (so spec-lock check 3 can verify
  // tasks_based_on.spec === spec.spec_version before the gate moves the
  // session to EXECUTE.plan). EXECUTE.plan stays as an additional allowed
  // sub_state for re-planning after a finding-triggered rollback to SPEC.
  "event:tasks_planned": new Set(["SPEC.design", "EXECUTE.plan"]),
  "event:tasks_amended": new Set(VERIFY_OR_POST_LOCK_EXECUTE),
  "event:task_claimed": new Set(["EXECUTE.work"]),
  "event:task_step_started": new Set(["EXECUTE.work"]),
  "event:task_step_done": new Set(["EXECUTE.work"]),
  "event:task_abandoned": new Set(["EXECUTE.work"]),
  "event:spec_req_added": new Set(ALL_SPEC),
  "event:spec_scenario_added": new Set(ALL_SPEC),
  "event:spec_visual_added": new Set(ALL_SPEC),
  "event:spec_submitted": new Set(ALL_SPEC),

  // Domain ledger entries
  "evidence:added": new Set([...ALL_EXECUTE, ...VERIFY_OR_POST_LOCK_EXECUTE.filter((s) => s.startsWith("VERIFY"))]),
  "finding:raised": new Set(VERIFY_OR_POST_LOCK_EXECUTE),
  "finding:closed": new Set(VERIFY_OR_POST_LOCK_EXECUTE),
  "pending:added": ANY_SUB_STATE,
  "pending:resolved": ANY_SUB_STATE,

  // Gates — sub_state checked via shared validateTransition; this table only
  // says the emit point is the gate's source sub_state.
  "gate:decided": new Set(["SPEC.design", "VERIFY.accept"]),

  // Session lifecycle
  "session:started": ANY_SUB_STATE, // boundary case (seq=0 invariant lives in apply)
  "session:resumed": ANY_SUB_STATE,
  "session:delivered": new Set(["EXECUTE.done", "VERIFY.accept", "SETTLE.lessons"]),
  "session:archived": ANY_NON_DONE,
  "session:abandoned": ANY_NON_DONE,

  // Spike branch closure
  "spike:converted": ANY_NON_DONE,

  // Migration
  "migration:snapshot_imported": ANY_SUB_STATE, // seq=0/1 invariant lives in apply
};

export type ActorPrefix = "human" | "skill" | "ci" | "cli" | "migration";

const ALL_NON_MIGRATION: readonly ActorPrefix[] = ["human", "skill", "ci", "cli"];
const HUMAN_ONLY: readonly ActorPrefix[] = ["human"];
const MIGRATION_ONLY: readonly ActorPrefix[] = ["migration"];

// Actor authority table — ADR-0005 §3.4. Empty array would denote "any actor";
// here every kind has an explicit whitelist for safety + greppability.
export const PER_KIND_ACTOR: Record<EntryKind, readonly ActorPrefix[]> = {
  "event:phase_advanced": ALL_NON_MIGRATION,
  "event:ceremony_set": ALL_NON_MIGRATION,
  "event:tasks_planned": ALL_NON_MIGRATION,
  "event:tasks_amended": ALL_NON_MIGRATION,
  "event:task_claimed": ALL_NON_MIGRATION,
  "event:task_step_started": ALL_NON_MIGRATION,
  "event:task_step_done": ALL_NON_MIGRATION,
  "event:task_abandoned": ALL_NON_MIGRATION,
  "event:spec_req_added": ALL_NON_MIGRATION,
  "event:spec_scenario_added": ALL_NON_MIGRATION,
  "event:spec_visual_added": ALL_NON_MIGRATION,
  "event:spec_submitted": ALL_NON_MIGRATION,

  "evidence:added": ALL_NON_MIGRATION, // payload.kind=manual/waiver narrows to human (per-kind extra refine)
  "finding:raised": ALL_NON_MIGRATION,
  "finding:closed": ALL_NON_MIGRATION,
  "pending:added": ALL_NON_MIGRATION,
  "pending:resolved": ALL_NON_MIGRATION,

  "gate:decided": HUMAN_ONLY,

  "session:started": ALL_NON_MIGRATION,
  "session:resumed": ALL_NON_MIGRATION,
  "session:delivered": HUMAN_ONLY,
  "session:archived": HUMAN_ONLY,
  "session:abandoned": HUMAN_ONLY,

  "spike:converted": HUMAN_ONLY,

  "migration:snapshot_imported": MIGRATION_ONLY,
};

export function actorPrefix(actor: string): ActorPrefix | null {
  const m = /^(human|skill|ci|cli|migration):/.exec(actor);
  return m ? (m[1] as ActorPrefix) : null;
}

export function isSubStateAllowed(kind: EntryKind, subState: SubState): boolean {
  const guard = PER_KIND_SUB_STATE[kind];
  if (guard === ANY_SUB_STATE) return true;
  if (guard === ANY_NON_DONE) return !subState.startsWith("DONE.");
  return guard.has(subState);
}

export function isActorAllowed(kind: EntryKind, actor: string): boolean {
  const prefix = actorPrefix(actor);
  if (prefix === null) return false;
  return PER_KIND_ACTOR[kind].includes(prefix);
}
