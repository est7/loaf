// L3 — shared invariant predicates (stable core).
//
// Single home for the scalar invariants that preflight and reducer each
// enforce. Both layers DELEGATE here and map the returned fact to their own
// error surface — preflight to a typed DiagnosticCode + detail.*, reducer to a
// defensive invalidPayload(...) message. De-duplicating the *rule* (not the two
// error shapes) is the point; the deliberate defense-in-depth (ADR-0005) stays
// — both layers still call.
//
// Pure: no IO, no Snapshot. Raw scalars only, so projection state cannot couple
// back into the predicate.

export type SpecVersionMode = "head" | "continuation";

export type SpecVersionCheck = { ok: true; nextVersion: number } | { ok: false; expected: number };

export function resolveSpecVersionMode(batchIndex: number | undefined): SpecVersionMode {
  return batchIndex === undefined || batchIndex === 0 ? "head" : "continuation";
}

/**
 * spec_version monotonicity, parametrised by batch position.
 *
 * - "head": the first entry of a batch must bump to `currentVersion + 1`.
 * - "continuation": a non-head entry must repeat `currentVersion` (the head
 *   already bumped state).
 *
 * On success returns the accepted `nextVersion` so the reducer can set
 * `state.spec_version` without recomputing the rule; on failure returns the
 * `expected` version so each layer formats its own message/detail.
 *
 * NOTE: the structural guard for `spec_submitted` at batch_index > 0 is NOT this
 * predicate's concern (it has no kind/batch_index) and must be checked by the
 * caller before delegating here.
 */
export function checkSpecVersion(
  payloadVersion: number,
  currentVersion: number,
  mode: SpecVersionMode,
): SpecVersionCheck {
  const expected = mode === "head" ? currentVersion + 1 : currentVersion;
  return payloadVersion === expected
    ? { ok: true, nextVersion: expected }
    : { ok: false, expected };
}

/**
 * Self-scan: the first id that appears more than once within `ids`, else null.
 * For `tasks_planned`, where the duplicate question is internal to the incoming
 * task list. Returns the first id encountered a second time (scan order) so the
 * offender is deterministic.
 */
export function findDuplicateId(ids: readonly string[]): { id: string } | null {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return { id };
    seen.add(id);
  }
  return null;
}

/**
 * Membership: does `incomingId` already exist among `existing`, else null. For
 * REQ/SCEN/VIS add-one, where the question is collision against the projection
 * — NOT whether the projection is internally corrupt. A pre-existing duplicate
 * in `existing` unrelated to `incomingId` must not change the answer.
 *
 * Takes the source items + an id selector and short-circuits on the first match,
 * so callers pass the projection array directly — no throwaway `.map(...)` id
 * array per check on the per-mutation path.
 */
export function findCollision<T>(
  incomingId: string,
  existing: readonly T[],
  selectId: (item: T) => string,
): { id: string } | null {
  for (const item of existing) {
    if (selectId(item) === incomingId) return { id: incomingId };
  }
  return null;
}
