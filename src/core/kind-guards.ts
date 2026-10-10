// L2 — per-kind guard vocabulary (the table-construction primitives shared by
// kind-registry.ts). Split out of reducer/per-kind.ts so kind-registry can
// import these without a runtime cycle. Transition policy owns back-edge
// source sets; journal-entry remains the base schema layer.

import type { SubState } from "./journal-entry.js";
import { backEdgeSourceStates } from "./reducer/transition.js";

// Wildcards used by the sub_state table — saves enumerating 20 sub_states where
// a kind is broadly legal.
export const ANY_SUB_STATE = Symbol("any-sub-state");
export const ANY_NON_DONE = Symbol("any-non-done");

export type SubStateGuard = ReadonlySet<SubState> | typeof ANY_SUB_STATE | typeof ANY_NON_DONE;

// ── sub_state from-sets (groupings reused across kinds) ──────────────────────
export const VERIFY_OR_POST_LOCK_EXECUTE = backEdgeSourceStates("amend-spec");

export const ALL_SPEC: SubState[] = ["SPEC.proposal", "SPEC.spec", "SPEC.plan", "SPEC.design"];

export const ALL_EXECUTE: SubState[] = ["EXECUTE.plan", "EXECUTE.work", "EXECUTE.done"];

// task_step_reset is co-emitted from the fix back-edge source band.
// fix-impl and fix-test share the same transition-owned source policy.
export const FIX_BACK_EDGE_FROM = backEdgeSourceStates("fix-impl");

// ── actor authority vocabulary (ADR-0005 §3.4) ───────────────────────────────
export type ActorPrefix = "human" | "skill" | "ci" | "cli" | "migration";

export const ALL_NON_MIGRATION: readonly ActorPrefix[] = ["human", "skill", "ci", "cli"];
export const HUMAN_ONLY: readonly ActorPrefix[] = ["human"];
export const CLI_ONLY: readonly ActorPrefix[] = ["cli"];
export const MIGRATION_ONLY: readonly ActorPrefix[] = ["migration"];

export function actorPrefix(actor: string): ActorPrefix | null {
  const m = /^(human|skill|ci|cli|migration):/.exec(actor);
  return m ? (m[1] as ActorPrefix) : null;
}
