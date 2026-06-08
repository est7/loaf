// L2 — per-kind guard vocabulary (the table-construction primitives shared by
// kind-registry.ts). Split out of reducer/per-kind.ts so kind-registry can
// import these without a runtime cycle. Type-only dependency on journal-entry.

import type { SubState } from "./journal-entry.js";

// Wildcards used by the sub_state table — saves enumerating 20 sub_states where
// a kind is broadly legal.
export const ANY_SUB_STATE = Symbol("any-sub-state");
export const ANY_NON_DONE = Symbol("any-non-done");

export type SubStateGuard = ReadonlySet<SubState> | typeof ANY_SUB_STATE | typeof ANY_NON_DONE;

// ── sub_state from-sets (groupings reused across kinds) ──────────────────────
export const VERIFY_OR_POST_LOCK_EXECUTE: SubState[] = [
  "EXECUTE.plan",
  "EXECUTE.work",
  "EXECUTE.done",
  "VERIFY.plan",
  "VERIFY.run",
  "VERIFY.review",
  "VERIFY.acceptance",
  "VERIFY.visual",
  "VERIFY.accept",
];

export const ALL_SPEC: SubState[] = ["SPEC.proposal", "SPEC.spec", "SPEC.plan", "SPEC.design"];

export const ALL_EXECUTE: SubState[] = ["EXECUTE.plan", "EXECUTE.work", "EXECUTE.done"];

// Phase 11 Item 3 SC2/SC3 — the fix back-edge from-set (codex r139 Q4, r142):
// the VERIFY_OR_POST_LOCK_EXECUTE band minus EXECUTE.plan. event:task_step_reset
// is co-emitted from exactly these sub_states by both fix-impl and fix-test (it
// mirrors the fix-impl / fix-test BACK_EDGE_FROM rows in transition.ts).
export const FIX_BACK_EDGE_FROM: SubState[] = [
  "EXECUTE.work",
  "EXECUTE.done",
  "VERIFY.plan",
  "VERIFY.run",
  "VERIFY.review",
  "VERIFY.acceptance",
  "VERIFY.visual",
  "VERIFY.accept",
];

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
