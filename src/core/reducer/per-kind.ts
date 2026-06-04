// Post-L2 shim — the per-kind authority tables + guard vocabulary moved to
// kind-guards.ts (primitives) + kind-registry.ts (derived tables / accessors).
// This file re-exports the same names so existing importers keep working.

export {
  ANY_SUB_STATE,
  ANY_NON_DONE,
  actorPrefix,
} from "../kind-guards.js";
export type { ActorPrefix } from "../kind-guards.js";

export {
  PER_KIND_SUB_STATE,
  PER_KIND_ACTOR,
  isSubStateAllowed,
  isActorAllowed,
} from "../kind-registry.js";
