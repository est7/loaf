// Per-kind representative-anchor fixture builder (Stage 2 §3.6 invariants matrix).
//
// **Naming clarification (audit r1 fix #10)**: this builder is NOT a full
// Cartesian generator despite the original plan.md wording. It emits one
// positive + one negative anchor per EntryKind — enough to assert the
// PER_KIND_SUB_STATE / PER_KIND_ACTOR tables are wired into preflight, but
// NOT a guarantee that every (kind × sub_state × actor) combination is
// observed. The 25×20 sub_state matrix + 25×5 actor matrix is left as a
// follow-up — to be added if a regression surfaces a coverage hole.
//
// For each EntryKind we emit:
//   - one "legal" case: kind paired with a sub_state where it is allowed
//   - one "illegal" case: kind paired with a sub_state where it is rejected

import type { EntryKind, SubState } from "../../src/core/journal-entry.js";
import {
  ANY_NON_DONE,
  ANY_SUB_STATE,
  PER_KIND_SUB_STATE,
  PER_KIND_ACTOR,
  type ActorPrefix,
} from "../../src/core/reducer/per-kind.js";

const ALL_SUB_STATES: SubState[] = [
  "TRIAGE.score", "TRIAGE.confirm",
  "SPEC.proposal", "SPEC.spec", "SPEC.plan", "SPEC.design",
  "EXECUTE.plan", "EXECUTE.work", "EXECUTE.done",
  "VERIFY.plan", "VERIFY.run", "VERIFY.review", "VERIFY.acceptance",
  "VERIFY.visual", "VERIFY.accept",
  "SETTLE.reconcile", "SETTLE.lessons",
  "DONE.delivered", "DONE.archived", "DONE.abandoned",
];

export interface KindSubStateFixture {
  kind: EntryKind;
  sub_state: SubState;
  expected: "legal" | "illegal";
}

function legalSubState(kind: EntryKind): SubState {
  const guard = PER_KIND_SUB_STATE[kind];
  if (guard === ANY_SUB_STATE) return "EXECUTE.work";
  if (guard === ANY_NON_DONE) return "EXECUTE.work";
  // ReadonlySet — pick first element.
  const first = guard.values().next().value;
  if (first === undefined) {
    throw new Error(`no legal sub_state for kind=${kind}`);
  }
  return first;
}

function illegalSubState(kind: EntryKind): SubState | null {
  const guard = PER_KIND_SUB_STATE[kind];
  if (guard === ANY_SUB_STATE) return null; // every sub_state is legal — no illegal anchor
  if (guard === ANY_NON_DONE) return "DONE.delivered";
  // Find any sub_state not in the set.
  for (const candidate of ALL_SUB_STATES) {
    if (!guard.has(candidate)) return candidate;
  }
  return null;
}

export function kindSubStateFixtures(): KindSubStateFixture[] {
  const out: KindSubStateFixture[] = [];
  const kinds = Object.keys(PER_KIND_SUB_STATE) as EntryKind[];
  for (const kind of kinds) {
    out.push({ kind, sub_state: legalSubState(kind), expected: "legal" });
    const bad = illegalSubState(kind);
    if (bad !== null) {
      out.push({ kind, sub_state: bad, expected: "illegal" });
    }
  }
  return out;
}

export interface KindActorFixture {
  kind: EntryKind;
  actor: string;
  expected: "legal" | "illegal";
}

const ALL_PREFIXES: ActorPrefix[] = ["human", "skill", "ci", "cli", "migration"];

export function kindActorFixtures(): KindActorFixture[] {
  const out: KindActorFixture[] = [];
  const kinds = Object.keys(PER_KIND_ACTOR) as EntryKind[];
  for (const kind of kinds) {
    const allowed = new Set(PER_KIND_ACTOR[kind]);
    const allowedPrefix = [...allowed][0];
    if (allowedPrefix !== undefined) {
      out.push({ kind, actor: `${allowedPrefix}:tester`, expected: "legal" });
    }
    const disallowedPrefix = ALL_PREFIXES.find((p) => !allowed.has(p));
    if (disallowedPrefix !== undefined) {
      out.push({ kind, actor: `${disallowedPrefix}:tester`, expected: "illegal" });
    }
  }
  return out;
}
