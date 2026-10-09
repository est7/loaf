# Entry admission as one deep module

**Status:** IN PROGRESS — step 1 landed; step 2 pending
**Origin:** architecture review 2026-10-09, candidate #1 ("Deepen entry admission
into one module"); design decisions settled with the maintainer in the same
session (see §3).
**Scope:** `src/core/` only. No CLI-visible error shape change is intended
(§5 lists the exceptions that need an explicit decision before they land).
**Related:** ADR-0005 (single typed journal — this plan implements it, it does
not reopen it); architecture deepening program A15/A20 (they prove mutation and
replay produce equal *results*; this plan unifies the *code path*).

## 1. Problem

The rule "how one journal entry is admitted onto a snapshot" has no owner. Its
ordering is re-implemented at four call sites, and they disagree:

| Call site | Bootstrap kinds | NO_SESSION vs preflight | Failure wrapping |
| --- | --- | --- | --- |
| `reducer.ts:119` `apply()` (replay only, via `applyReplayed`) | skip preflight | NO_SESSION **first** | raw `ApplyResult` |
| `journal-mutate.ts:426` Pass 1 | **run** preflight | preflight **first**, then NO_SESSION | preflight code top-level; dry-run → `REDUCER_ERROR` + `detail.code` |
| `journal-mutate.ts:676` Pass 3 | skip preflight | preflight first, then NO_SESSION | everything → `REDUCER_ERROR` + `detail.code` |
| `journal-bootstrap.ts:154-200` replay | migration intercepted before apply | via `apply()` | `REDUCER_REJECTED` + `inner_code` |

Consequences:

- The same entry can yield a different diagnostic depending on path. With
  `state === null`, a non-bootstrap entry on the mutation path is checked
  against the default `TRIAGE.score` sub_state and may report an authority
  violation instead of `NO_SESSION`.
- `applyValidated` (`reducer.ts:174`) is `@internal` by comment only; three
  callers must each remember to run preflight before it.
- `JournalEntry.payload` is `z.unknown()` (`journal-entry.ts:280`). Preflight
  parses it with `PER_KIND_PAYLOAD` and then discards the typed result; the
  reducer re-casts by hand (21× `entry.payload as` in `reducer.ts`, 12× in
  `preflight/checks-*`).
- The reducer keeps "defense-in-depth" copies of preflight rules (27
  `ok: false` sites), defending against bypass paths that the module structure
  could instead make impossible.

Deletion test: deleting `apply()` or `applyReplayed()` today does not remove
complexity — the ordering knowledge would be copied once more into the caller.
The missing piece is a module that owns that knowledge.

## 2. Target shape

One in-process module — working name `src/core/entry-admission.ts` — owns:

1. Mode-specific admission order (canonical order in §3 D1).
2. Preflight invocation and the typed payload it produces.
3. The reducer dry-run (`applyValidated` becomes private to this module or
   its directory; no other production import).
4. The replay-only legacy allowance currently in `applyReplayed`
   (`VERIFY.accept → SETTLE.reconcile`).

Sketch (names provisional; final shape settled in the step-1 plan review):

```ts
type AdmissionMode =
  | { kind: "mutation"; tail_seq: number }
  | { kind: "replay" };

type AdmissionResult =
  | { ok: true; snapshot: Snapshot }            // step 2 adds the typed entry
  | {
      ok: false;
      stage: "admission" | "reducer";
      code: string;                             // narrowed in step 2
      message: string;
      detail: Record<string, unknown>;
    };

function admitEntry(prev: Snapshot, entry: unknown, mode: AdmissionMode): AdmissionResult;
```

Not owned by this module (stay where they are):

- Batch/history invariants, gate evaluation, sidecar promotion, lease, append —
  `journal-mutate.ts`.
- Replay seq contiguity (`INVALID_ENTRY`) and migration rehydration from
  sidecars (async, needs `feature_dir`) — `journal-bootstrap.ts`.
- The `REDUCER_IMPLEMENTED_KINDS` gate in Pass 1 — deferred to candidate #2
  (KIND_REGISTRY ownership), which may delete it.
- `ORDERED_CHECKS` and error precedence — still owned by `reducer/preflight.ts`;
  this module calls it, it does not reorder it.

## 3. Settled decisions

| ID | Decision |
| --- | --- |
| D1 | **Canonical order, refined.** Both modes: non-bootstrap entry with `state === null` → `NO_SESSION` first. Mutation mode then runs preflight for **all** kinds, bootstrap included (preserves today's Pass 1 payload/actor validation of `session:started`). Replay mode skips preflight for bootstrap kinds (preserves today's tolerant read of historical journals). Then reducer dry-run. The mode difference lives inside the module, not at call sites. |
| D2 | **Two steps, two commits.** Step 1 unifies the entry point and ordering with the reducer signature unchanged. Step 2 adds the typed admitted entry and removes the hand casts. |
| D3 | **Delete reducer defense-in-depth copies** in step 2, once admission is the sole caller of the reducer. Rules with a preflight twin are deleted; reducer-only rules move to preflight first (see §4 inventory). |
| D4 | **Pass 3 stays**, rewritten to call the admission module in mutation mode. Whether Pass 3 should exist at all is a separate decision, out of scope. |
| D5 | **One typed failure out of the module; callers keep their wrapping.** Mutation keeps top-level preflight codes / `REDUCER_ERROR`; replay keeps `REDUCER_REJECTED` + `inner_code`. Unifying wrappers belongs to review candidate #4. |
| D6 | **Migration rehydration stays in replay.** The module stays pure. The mutation-vs-replay snapshot divergence for `migration:snapshot_imported` is recorded (§6), not fixed. |
| D7 | **Replace, don't layer.** `apply()` and `applyReplayed()` are deleted; tests move to the admission interface. No compatibility forwarders. `tests/core/preflight-precedence.test.ts` keeps testing `ORDERED_CHECKS` directly (internal precedence contract). |

## 4. Reducer-only rule inventory (input to D3)

Located by grepping reducer failure codes against `reducer/preflight*`:

| Reducer code | Preflight twin? | Step-2 action |
| --- | --- | --- |
| `DUPLICATE_TASK_ID`, `TASK_NOT_FOUND`, `FINDING_NOT_FOUND`, `INVALID_PAYLOAD` | yes | delete reducer copy after confirming the predicates match case by case |
| `TASK_STEP_NOT_FOUND` (`reducer.ts:442,491,549`) | **no** | move to preflight (`checks-task`) before deleting |
| `PENDING_NOT_FOUND` (`reducer.ts:842,850`) | **no** | move to preflight (`checks-workflow`) before deleting |
| `ALREADY_STARTED` (`reducer.ts:184,212`) | no — bootstrap-only | stays with the bootstrap reducer branch |
| `event:task_abandoned` unknown `task_id` (`reducer.ts:572`) | `checks-task.ts:418` refines task_abandoned; coverage of unknown id unverified | verify; if uncovered, add the preflight check (closes audit M3) |
| `REDUCER_NOT_IMPLEMENTED` / `_exhaustive` (`reducer.ts:913-916`) | n/a | out of scope — candidate #2 |

The remaining `ok: false` sites without a literal code on the same line must be
classified during step 2; the table above is located evidence, not exhaustive.

## 5. Observable-behaviour risks (decide before landing)

- **Moving `TASK_STEP_NOT_FOUND` / `PENDING_NOT_FOUND` into preflight changes
  the mutation-path shape** from `REDUCER_ERROR` + `detail.code` to a top-level
  code. CLI handlers already pre-check both (`tasks/authoring.ts:686`,
  `pending.tsx:191,244`), so the shape should be unreachable through the CLI;
  step 2 must prove that with a test or keep the reducer-stage wrapping for
  those codes.
- **D1 changes which code wins** when `state === null` on the mutation path.
  The CLI's `emitNoSessionFailure` normally intercepts first; step 1 must pin
  current per-path codes with characterization tests and update them
  deliberately.
- `PreflightFailureCode` gains members in step 2 → per CLAUDE.md this is
  `PUBLIC_IMPACT=true` (reducer/preflight code unions): dispatch the step-2 plan
  for review before RED. Step 1 changes no union and no wire shape.

## 6. Recorded, not fixed

- Mutation applies `migration:snapshot_imported` through the default bootstrap;
  replay rehydrates from sidecars. Same entry, different snapshot. Revisit only
  when a live migration writer exists.

## 7. Steps

### Step 1 — single entry point, unchanged reducer

1. RED / characterization: a table test over {mutation, replay} × {bootstrap,
   non-bootstrap} × {state null, state set} × {preflight-pass, preflight-fail}
   pinning today's code per path; mark the rows D1 intentionally changes.
2. Add the admission module; route Pass 1, Pass 3 and replay through it;
   delete `apply()` / `applyReplayed()`; restrict `applyValidated` imports.
3. Migrate the 14 test files that call `apply`/`applyReplayed`/`applyValidated`
   to the admission interface.
4. Guard: a test (or lint rule) that `applyValidated` has no production
   importer outside the admission module.

Acceptance:

- [x] Characterization table passes with only the D1 rows changed, each change
  named in the commit body. Evidence: baseline 24/24 green; the four D1
  changes are recorded in `entry-admission-characterization.test.ts` and the
  step-1 commit body. Auditor fault probe: disabling NO_SESSION-first in
  `admitEntry` fails 6/24 rows; restoring returns 24/24.
- [x] `rg "applyValidated\(" src` matches only the admission module. Evidence:
  its only **call** is in `entry-admission.ts`; the unchanged exported reducer
  declaration also matches this literal search. The AST ownership guard passes
  and a temporary second importer makes it fail (1 failed / 1 skipped), then
  removal restores 2/2 green.
- [x] `rg "export function (apply|applyReplayed)\b" src` matches nothing.
- [x] Mutation/rebuild equivalence tests (A15/A20) pass unchanged. Evidence:
  assertions preserved; test setup imports/calls migrated to admission. All
  15 targeted files pass (345/345), including journal-mutate and doctor-rebuild.
- [x] `bun run check` passes; `dist/cli.mjs` rebuilt. Evidence: lint, typecheck,
  release identity, 179 Vitest files / 2753 tests, and tsdown all pass;
  `node dist/cli.mjs --version` prints `0.7.0`.

Commit: `refactor(core): admit journal entries through one module`

### Step 2 — typed admitted entry, delete reducer duplicates

1. Plan review (PUBLIC_IMPACT) covering §4 and §5.
2. RED: preflight tests for `TASK_STEP_NOT_FOUND`, `PENDING_NOT_FOUND`, and
   unknown-id `task_abandoned` (if uncovered).
3. Admission returns a discriminated typed entry (payload typed per kind via
   `PER_KIND_PAYLOAD`); reducer cases consume it.
4. Delete the hand casts and the reducer copies with preflight twins.

Acceptance:

- [ ] `rg "entry\.payload as" src/core/reducer.ts src/core/reducer/preflight` → 0.
- [ ] Every deleted reducer rule has a named preflight test that fails if the
  preflight rule is removed (fault sensitivity shown by a reversible negative
  control).
- [ ] `bun run verify:codegen` passes if any catalog/union changed.
- [ ] `bun run check` passes; `dist/cli.mjs` rebuilt.

Commit: `refactor(core): type admitted entries and drop reducer duplicates`

## 8. Recovery

Both steps are in-process refactors with no persisted-format change; revert the
commit. Journals written before or after either step replay identically
(A15/A20 equivalence is the guard).
