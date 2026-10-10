# Packet F — drop historical-format compatibility

**Status:** APPROVED (maintainer, 2026-10-10) — execute F7 → F2+F5 → F3 → F1+F4; F6 kept.
**Baseline:** HEAD `9d03765` (read via `git show` / `git grep HEAD`; the working
tree carries in-flight Packet B edits that this inventory ignores).
**Decision input:** loaf-cli has never been used on a real project, so no
historical journal, projection leaf, or lock file needs to stay readable
(maintainer, 2026-10-09).
**Release impact:** removes a `SubState` value, an `EntryKind`, and several
diagnostic codes → breaking minor bump (0.9.0) recorded in
`docs/release-identity.json`.

## Explicitly out of scope

- `src/core/evidence-compat.ts` — product behaviour (evidence-kind vs
  obligation compatibility), consumed by `src/cli/commands/evidence.tsx:10,208`
  and `src/core/gates/verify-accept-check.ts:46` (`canSatisfy`). Not a
  historical-format reader. **Not touched.**
- The `skills/` ↔ CLI contract (`skills/CONTRACT.md` and skill prompts). **Not
  changed.** F2 has one wording conflict with it; see F2 "Decision needed".

## Summary

| ID | Item | Purely historical? | Risk | Verdict |
| --- | --- | --- | --- | --- |
| F1 | `entry-admission.ts` replay-mode allowances | Yes | Low–Medium | Delete; collapse modes (depends on F2, F3; analysed in step 2) |
| F2 | `SETTLE.reconcile` + `reconcile-schema.ts` + legacy reconcile reader | Yes | Medium | Delete (one skills wording decision) |
| F3 | `migration:snapshot_imported`, v0.0.x import, `migration.ts` | Yes — no production caller | Medium (large diff, dead code) | Delete |
| F4 | Reducer historical `session:started` truthiness guard | Yes (only reachable via F1 bypass) | Low | Delete with F1 |
| F5 | `projection-loader` legacy branches | Yes — they are F2 | Low | Delete with F2 |
| F6 | `feature-write-lease` `legacy-empty` | **No — live crash recovery** | High if removed | **Keep** (optional rename) |
| F7 | `lessons-projection` legacy lesson heuristic | Yes | Low | Delete (also fixes a false positive) |

## F1 — replay-mode allowances in entry admission

- **Where:** `src/core/entry-admission.ts:30-31` (bootstrap kinds include
  `migration:snapshot_imported`), `:43-49` (`legacyReconcile`), `:50` (replay
  skips preflight for bootstrap and the legacy edge); header comment `:20-23`.
- **Callers:** `replayJournal` only (`src/core/journal-bootstrap.ts:189`,
  `{ kind: "replay" }`). Mutation never takes these branches.
- **Historical only?** Yes. The reconcile edge has had no writer since A10;
  every current `session:started` is written through mutation, which already
  preflights it.
- **Tests affected:** `tests/core/entry-admission-characterization.test.ts`
  (replay rows for bootstrap + preflight-fail currently expect `OK` /
  `ALREADY_STARTED`), `tests/core/entry-admission-boundary.test.ts` (migration
  mode-difference test), `tests/core/reducer.test.ts:26` (historical reconcile
  replay test).
- **Depends on:** F2 (edge target disappears) and F3 (migration bootstrap
  disappears). Whether `AdmissionMode` collapses entirely is step 2.
- **Risk:** Low–Medium — changes which journals replay accepts; acceptable
  under the no-history decision.

## F2 — `SETTLE.reconcile` state and the reconcile projection reader

- **Where (source):**
  - `src/core/journal-entry.ts:192` — `SubState` enum value (wire value).
  - `src/core/machine.ts:293-305` — compatibility-only state + edge.
  - `src/core/reconcile-schema.ts` — whole file (compat-only schema).
  - `src/core/projection-loader.ts:48,58-60,68,119-126,447-460` —
    `"reconcile"` projection kind, `COMPATIBILITY_LEAF_SCHEMA`,
    `loadLegacyReconcileProjection`.
  - `src/cli/board/static.ts:41`, `src/cli/runtime-i18n-keys.ts:150` (+ i18n
    bundles), `src/core/migration.ts:527` (v0.0.x mapping; gone with F3),
    comment at `src/cli/commands/terminal-settle.tsx:46-47`.
- **Callers:** `loadLegacyReconcileProjection` has **no production caller**
  (only `tests/core/reconcile-scope.test.ts:146`). `ReconcileJson` is used
  only by `projection-loader.ts` and tests.
- **Generated/doc surfaces:** `docs/protocol.md` (37 hits incl. generated FSM
  block), `docs/fsm.mmd`, `docs/machine-contract.md` (4) — regenerate via
  `gen:*`, never hand-edit generated blocks.
- **Tests affected:** `tests/core/reconcile-scope.test.ts` (5 tests; the
  `ReconcileJson` / legacy-leaf ones delete), `tests/core/reducer.test.ts:26`,
  `tests/core/transition.test.ts:121` (rewrite: the value no longer exists),
  `tests/core/machine-transition.test.ts:23`,
  `tests/cli/__snapshots__/schema-emit.test.ts.snap`,
  `tests/core/per-kind-fixture-builder.ts`,
  `tests/scripts/architecture-ownership-gates.test.ts:94-95,206-211` (doc
  regex gates — retarget or drop). `tests/core/cli.test.ts:2136-2137`
  (negative "no reconcile.json" assertions) stays valid.
- **Decision needed:** `skills/settle/SKILL.md:24,40-42` tells the skill what
  to do when `sub_state = SETTLE.reconcile`. After F2 that branch is
  unreachable. Options: (a) leave the skill text as-is (stale but harmless;
  honours "skills contract unchanged"), or (b) delete those lines as a
  doc-consistency edit. **Resolved: (b).** The branch is unreachable today:
  the only way in is the retired edge, which `admitEntry` admits only in
  replay (`src/core/entry-admission.ts:43-49`), and every current writer goes
  through `mutateBatch` preflight, which rejects it (`TRANSITION_ILLEGAL`). No
  test pins the skill text. F2 deletes the `SETTLE.reconcile` bullet
  (`skills/settle/SKILL.md:24-25`) and the `ReconcileJson` sentence (`:40-41`);
  `skills/CONTRACT.md` is unchanged.
- **Public impact:** `SubState` loses `SETTLE.reconcile` (appears in JSON
  outputs, schema emit, board). Breaking.
- **Risk:** Medium (wide surface, generated docs).

## F3 — `migration:snapshot_imported`, v0.0.x import, `migration.ts`

- **Key fact:** `doctor --migrate-v2` is **not a registered CLI option**
  (`src/cli/commands/profile-config.tsx:319` registers only `--rebuild`).
  `migrateV2` / `verifyMigrationSidecars` have **no production caller**; only
  `tests/core/v0.0.x-migration.test.ts` and `tests/core/doctor-rebuild.test.ts`
  import them. The import path is dead code that the docs still advertise.
- **Where:**
  - `src/core/migration.ts` (842 lines): `MIGRATION_V1_TO_V2_BOUNDARY`,
    `migrateV2`, `rehydrateMigration`, `verifyMigrationSidecars`,
    `MigrationError`, plus `ENTRY_SCHEMA_VERSIONS` (moved out by Packet C) and
    `UPCASTER_REGISTRY` (retired by Packet D).
  - Kind: `src/core/journal-entry.ts:148,268`, `src/core/kind-registry.ts:250`,
    `src/core/attachment-authority.ts:23`.
  - Replay: `src/core/journal-bootstrap.ts:30,61,165-185`.
  - Admission / reducer: `src/core/entry-admission.ts:31`,
    `src/core/reducer.ts:117-140`.
  - Guards that only exist because of migrated journals:
    `src/cli/commands/profile-config.tsx:387-395`,
    `src/core/projection-writer.ts:91`, `src/core/gates/spec-lock-check.ts:184`.
  - Contract text: `src/core/concurrency-contract.ts:244-246,331-336,370-377`.
  - Diagnostics (`src/core/error-catalog.ts`): `MIGRATION_BACKUP_MISSING`
    (807), `MIGRATION_INCOMPLETE` (815), `MIGRATION_REPLAY_ATTEMPT` (823),
    `MIGRATION_SIDECAR_MISSING` (831), `DOCTOR_REBUILD_MIGRATED_UNSUPPORTED`
    (1524); `NO_SESSION` fix text (762) mentions `--migrate-v2`.
- **Tests affected:** `tests/core/v0.0.x-migration.test.ts` (18 tests, delete
  file); references in `doctor-rebuild` (3), `entry-admission-boundary` (1),
  `journal-append` (3), `journal-mutate` (1), `kind-registry` (3),
  `per-kind-substate` (1), `preflight-validation` (3).
- **Sequencing:** after Packet C (moves `ENTRY_SCHEMA_VERSIONS` out of
  `migration.ts`). Packet D's edits to `migration.ts` become moot if F3 lands;
  D's doc-promise retirement still applies.
- **Public impact:** removes an `EntryKind`, 5 diagnostic codes, i18n entries,
  protocol §0c / §10.15 text. Breaking.
- **Risk:** Medium — large deletion; behaviourally dead.

## F4 — reducer historical `session:started` guard

- **Where:** `src/core/reducer.ts` session bootstrap branch (HEAD ~`:150-170`):
  truthiness check on `session_id` / `feature` / `ceremony` returning
  `INVALID_PAYLOAD`.
- **Callers:** reachable only when replay skips preflight for bootstrap (F1);
  mutation always schema-validates first.
- **Tests affected:** to confirm during F1 (search for the
  `session:started payload requires` message).
- **Risk:** Low. Lands with F1.

## F5 — `projection-loader` legacy branches

- The only legacy code in `src/core/projection-loader.ts` is the reconcile
  reader listed under F2 (`COMPATIBILITY_LEAF_SCHEMA`,
  `loadLegacyReconcileProjection`). No other branch exists. Lands with F2.

## F6 — `feature-write-lease` `legacy-empty` — KEEP

- **Where:** `src/core/feature-write-lease.ts:26,61,73,115,155,183,242-243`.
- **Why it is live:** `createLease` (`:134-139`) opens the lock with `"wx"`
  and then writes the metadata. A crash between `open` and `writeFile` leaves
  an **empty lock file in the current format**; the `legacy-empty` +
  `legacyLockStaleMs` path is what recovers it. Removing it would make that
  crash leave a permanently wedged feature.
- **Verdict:** keep. Optional cosmetic follow-up: rename to `empty` /
  `emptyLockStaleMs` so the name stops implying history.

## F7 — legacy lesson heuristic

- **Where:** `src/core/lessons-projection.ts:2,21-37` (`isLesson`),
  `:50-75` (`selectLessonEntries` dual read of `evidence:added`).
- **Callers:** `src/core/projection-writer.ts:440` (lessons projection) only.
- **Historical only?** Yes — `loaf lessons add` writes `lesson:recorded`
  (`src/cli/commands/lessons.tsx:119`) since `e823fc8`.
- **Side benefit:** today a human `loaf evidence add --kind manual
  --result passed` with no covers/task/check/gate is misread as a lesson.
  Removing the heuristic fixes that false positive.
- **Tests affected:** `tests/core/lessons-projection.test.ts` `isLesson`
  cases (`:43-58`) and the dual-read case (`:105`);
  `tests/scripts/architecture-ownership-gates.test.ts` if it pins the bridge.
- **Risk:** Low.

## Other historical-format code found (not in the original table)

Listed for a scope decision; not yet verified in depth.

| Location | What it tolerates | Note |
| --- | --- | --- |
| `src/core/journal-entry.ts:342-365`, `src/core/projection-writer.ts:60-115` | pre-SC1 `session:started` without `session_label` / `ceremony_label` / `workspace` / `loaf_version_required` | Check whether `loaf start` always writes them before making them required |
| `src/core/journal-entry.ts:530` | `tasks_amended` without `mode` replays as replace-only | Check current writers |
| `src/core/task-schema.ts:14` | historical step `evidence_refs` (A12) | Likely deletable |
| `src/core/gates/verify-accept-check.ts:74` | guard for historical journals at verify-accept | Needs reading |

Not historical compatibility (keep): newer-writer tail gate
(`src/core/journal-bootstrap.ts:406`), Pass 3 forward guard
(`src/core/journal-mutate.ts:636`), `legacy-fail` failure route
(`src/cli/commands/lifecycle.tsx:124,198,249` — review candidate #4),
`spec-lock-input` "historical spec.md semantics" (review candidate #6 —
behaviour, not format).

## Proposed order

1. F7 (independent, low risk).
2. F2 + F5.
3. F3 (after Packets C and D land).
4. F1 + F4 (after F2/F3 remove the edge and the migration bootstrap; shaped
   by the step-2 replay analysis).

Each lands as its own commit with RED/negative controls, `bun run check`, and
`bun run verify:codegen` where generated docs change.

## F1 analysis (approved)

Branches in `admitEntry` (`src/core/entry-admission.ts`):

| Branch | Trigger | Mutation | Replay |
| --- | --- | --- | --- |
| NO_SESSION first (`:32`) | non-bootstrap kind, `prev.state === null` | reject | reject |
| Bootstrap allowance (`:30-31`, `:49`) | `session:started` / `migration:snapshot_imported` | preflight | **skips preflight** |
| Retired reconcile edge (`:43-49`) | replay, `VERIFY.accept`, `phase_advanced` to `SETTLE.reconcile` | n/a (preflight rejects) | **skips preflight** |
| `tail_seq` (`:52`) | always | passed | omitted; `replayJournal` checks contiguity first (`journal-bootstrap.ts:155-163`) |

`migration:snapshot_imported` never reaches `admitEntry` through replay:
`replayJournal` intercepts it at `journal-bootstrap.ts:168`.

Writers: the only production `appendMany` caller is `mutateBatch`
(`journal-mutate.ts:687`), which preflights every entry in Pass 1 and the
promoted form in Pass 3. The only bypass is `migrateV2` (`migration.ts:449`),
which has no production caller. Because preflight is a function of entry and
snapshot and replay rebuilds the same snapshot (A15/A20), every entry written
by current code passes replay preflight. Entries that uniform preflight would
reject — invalid `session:started`, `migration:snapshot_imported`, the retired
reconcile edge — can only come from old, hand-edited, or corrupt journals.

Merge: after F2 and F3, D1 becomes "NO_SESSION first, then preflight every
kind, then reducer" for both callers. `AdmissionMode` reduces to an optional
`tail_seq` (whether the caller owns continuity). D5 wrappers are unchanged. F4
becomes unreachable and is deleted with F1. Corrupt-journal diagnostics change
(for example `inner_code` `ALREADY_STARTED` → `ACTOR_AUTHORITY_VIOLATION`).

Probe (isolated HEAD copy, uniform preflight): 8 of 2823 tests fail; 7 need
updating, 1 is a probe artifact (`public-contract-version-check` needs `.git`):

- `entry-admission-characterization.test.ts`: `replay:` and `replayJournal:`
  rows for `bootstrap=true state=null preflight=fail` and
  `bootstrap=true state=set preflight=fail` → expect `ACTOR_AUTHORITY_VIOLATION`.
- `entry-admission-boundary.test.ts`: `migration bootstrap preflights in
  mutation but remains tolerant in replay` → delete with F3.
- `reducer-apply-contract.test.ts`: `session:started bypasses preflight actor
  authority` → invert to a rejection.
- `reducer.test.ts`: `historical reconcile entry replays and can advance
  through its compatibility edge` → delete with F2.

The other 127 replay-mode `admitEntry` call sites in tests pass unchanged.
