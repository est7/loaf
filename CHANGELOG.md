# Changelog

All notable changes to `loaf-cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Replay-derived spec-lock diagnostics:** added read-only `loaf spec status`
  with exact failure and suppression rows. The command reconstructs its check
  input from journal-replayed snapshot state; check 3 explicitly reports checks
  4, 6, and 7 as suppressed while independent checks continue to run.
- **Read-only observability lists:** added canonical `loaf journal list` with
  the `loaf log` Commander alias and envelope-only timeline filters, plus
  `loaf evidence list` for coverage, task, and evidence-kind queries over the
  freshness-checked evidence projection. Both commands expose exact bounded
  JSON row shapes and never pass through raw journal payloads.

### Changed

- **Documentation correction:** removed the XDG/`LOAF_CONFIG` contract from the
  protocol; `~/.loaf/` is the user-level estate, with no runtime-reachable data
  to migrate from the abandoned contract.
- **Breaking protocol changes (protocol rev 5.1 → 5.2; next release must bump the
  package version):** `loaf lessons add`
  now emits the independent `lesson:recorded` journal kind with CLI-allocated
  `LSN-NNN` ids. JSON output keeps the stable `id` key. `lessons.md` permanently
  dual-reads the new kind and legacy lesson-shaped `evidence:added` entries;
  new lessons no longer enter evidence projections, coverage, status/board/TUI
  evidence counts, or resume packs. The journal contract also adds
  `scope:recorded@1`: a CLI-only, EXECUTE-closure audit entry with canonical
  repo-relative paths, sidecar support, one-entry-per-iteration enforcement,
  and replay-derived set-union projection. Machine-local
  `~/.loaf/runtime/<session_id>.json` now carries the strict nullable
  `pending_scope` accumulator behind a dedicated PID- and owner-token-aware
  runtime lock and atomic replacement; hook accumulation and advance emission
  remain staged.
- **`loaf spec add-req --schema`** now emits the actual runtime allocation
  boundary: `id_namespace` plus the EARS `type`, with the remaining requirement
  body passed through for downstream validation. The former closed schema that
  advertised per-variant body and verifiability fields at this boundary is gone.
- **`loaf spec add-scenario --schema`** now matches runtime parsing by requiring
  only `id_namespace` and `name` at allocation time and allowing the remaining
  scenario body, rather than advertising `given` / `when` / `then` as required
  by this earlier boundary.
- **`loaf spec add-visual --schema`** now matches runtime parsing by requiring
  only `id_namespace` and `target` at allocation time and allowing the remaining
  visual-contract body, rather than advertising `checks` as required here.
- **`loaf tasks add --schema`** now emits the runtime `z.union` composition as
  JSON Schema `anyOf` instead of the former compatibility copy's `oneOf`; the six
  strict task variant shapes are unchanged.
- **`loaf evidence add --schema`** now exposes the runtime `summary` contract:
  either a non-empty string or an inline/sidecar `LongTextField`, including the
  sidecar attachment reference fields (`path`, `sha256`, and `size`).

## [0.5.0] — 2026-06-09

Session garbage collection — the `loaf prune` command line. Finished (terminal)
sessions can be reclaimed to recoverable trash, restored, hard-purged, or swept
by retention age, with a persisted audit log. Every change codex-signed-off on an
independent cold-audit thread; each data-loss and double-fault path is guarded by
an explicit rollback.

### Added

- **`loaf prune`** — garbage-collect finished sessions (terminal-only by default;
  recoverable trash). Scope with `--in-cwd` / `--project <path>` / `--all` /
  `--orphans`, or the global `--session <id>`. Previews by default — `--yes`
  executes. Flags: `--force` (include active sessions, never overrides a held
  lock), `--purge` (hard-delete instead of trash), `--history` (print the audit
  log at `~/.loaf/prune-log.jsonl`), `--trash --older-than <days>` (retention
  sweep of old trash buckets).
- **`loaf prune restore <session-id>`** — restore a trashed session (registry
  entry + feature dir) from the prune trash; `--dry-run` previews without
  changing state.

### Changed

- Prune execution is transactional: a registry-move or feature-move failure rolls
  back the whole operation, partial failure exits `2` and is recorded as failed in
  the audit log, and the trash bucket is preserved on a rollback double-fault.
- Session resolution under `--in-cwd` / `--project` uses `realpath` symmetry so
  symlinked and canonical cwds resolve to the same registered session.

## [0.4.0] — 2026-06-08

Enforcement-integrity quality closure (W1–W10) + the `loaf board` browser view.
Internal kernel hardening and a large behavior-preserving CLI refactor (cli.tsx
5952 → 943 lines) with one new user-facing command. Every change codex-signed-off
on an independent cold-audit thread; the W8 refactor is goldens-identical for all
existing commands.

### Added

- **`loaf board`** — open a local, read-only board of all sessions in the browser
  (`--once` for a one-shot snapshot, `--in-cwd` to scope to the current project,
  `--open` to launch the browser, `--port` for the loopback port). Read-only: walks
  the session registry, never mutates the journal.

### Changed

- **W8 — cli.tsx deep-module split.** The ~15-helper `main()` cluster folded into
  `CommandContext` (presentation shims) + a new `CommandMutator` (mutation
  orchestration); ~30 commands moved into 13 `src/cli/commands/<family>.tsx` files.
  `command-context.ts` no longer imports `mutate`/`mutateBatch` (layer boundary).
  Behavior-preserving — the 43-probe `--help`/JSON/stderr golden set is identical.
- **W9b — preflight ORDERED_CHECKS pipeline.** The ~1.3k-line `preflight()` is now an
  explicit ordered predicate array; the error-precedence order is a named, tested
  contract.

### Fixed

- **W1 — spec-lock write-path gate.** `SPEC.design → EXECUTE.plan` now requires
  `spec_locked` (new `SPEC_LOCK_NOT_SATISFIED`); the write path can no longer bypass
  the gate the read path enforced.
- **W2 — replay seq-monotonicity.** `replayJournal` asserts contiguous `seq` before
  apply (`INVALID_ENTRY` with expected/got), closing a silent-corruption gap.
- **W3 — per-feature write-contention fence.** Throw-only `.lock` acquisition around
  the mutate write window (`WRITE_CONTENTION`).
- **W8 follow-up — production hook stdin.** `loaf hook scope-track` / `write-guard`
  piped-stdin path restored after the Phase 0 helper move (codex BLOCK; child-process
  regression test added).

### Tests / CI

- **W9a** — error-precedence characterization (26 simultaneous-violation rows) +
  `ORDERED_CHECKS` order pin.
- **W10** — unattended GitHub Actions gate (lint · typecheck · test · committed-dist
  guard · pack-smoke · build · madge · event-drift) + tag-only release-consistency.

## [0.3.1] — 2026-06-08

Code-quality deduction closure (P2–P7). Behavior-preserving refactor plus one
evidence-validation tightening; reviewed three ways (kernel / schemas+gates /
CLI surface) — APPROVE.

### Changed

- **biome lint/format toolchain** — `bun run lint` (formatter-disabled rule
  gate) wired into `bun run check`; repo-wide format pass.
- **Stable-core leaf-module extraction** — `projection-types.ts` (13 projection
  types lifted out of `reducer.ts`, re-exported) and `tui/types.ts`
  (`TuiStatusBucket`) break import cycles; pure moves.
- **Single-source spec-version mode** — `resolveSpecVersionMode` in
  `reducer/invariants.ts`, delegated by both reducer and preflight (L3 parity).
- **`apply()` in-place contract** — documented (`prev` consumed) without
  behavioral change.
- **Key-order-insensitive drift check** — `journal-mutate.ts` swaps
  `JSON.stringify` comparison for `isDeepStrictEqual`.
- **Human-actor resolution dedup** — 10 inlined sites collapse into
  `resolveHumanActorOrFail`, preserving the `$LOAF_USER → git email →
  NO_HUMAN_ACTOR` order and the non-interactive CI-safety guard; selector
  pre-parse helpers extracted.

### Fixed

- **Reject manual evidence with `result=waived`** — `kind=manual` must use
  `kind=waiver` to waive; surfaces as `INVALID_PAYLOAD` at preflight, consistent
  with its sibling evidence semantic refines.
- Remove 5 stale-rename diagnostic i18n keys (dead; live replacements present in
  ERROR_CATALOG).
- Exclude generated/runtime dirs from the event-drift CI gate.

### Tests

- Preflight error-precedence contract (table-driven) and `reducer.apply()`
  in-place contract pinned.
- `manual≠waived` rejection locked end-to-end (`loaf evidence add` → exit 2 +
  `INVALID_PAYLOAD`) and at the ceremony-independent preflight unit level.

## [0.3.0] — 2026-06-03

Adds `loaf next`, the read-side dual of the transition kernel: given the
current cursor, ceremony, pending head, and VERIFY lane applicability it
computes the one determined next owner command. Read-only, deterministic, and
not an advisory layer — routing is the protocol state machine, not a skill
concern.

### Added

- **`loaf next`** — computes the next owner command (`advance` / `deliver` /
  `settle` / `gate decide` / `tasks next` / `pending resolve` /
  `profile escalate`) from projections (+ `spec.md` frontmatter for VERIFY.*).
  Read-only (exit 0 normal/blocked/terminal, exit 2 errors; `--dry-run`
  rejected); `blocked=true` only for gate/pending/human-input; terminal states
  omit `next_action`. Forward-route ownership is single-source in
  `reducer/transition.ts` (`transitionOwnerFor` + `buildGateDecideAction` +
  `gateNameForCursor`); `next-action.ts` composes pending precedence + VERIFY
  lane selection. Public contract: `NextOutput` / `NextAction` in
  `docs/schemas.ts` §18b. §10.8 command-table row added.

### Fixed

- **`loaf next` pending-resolve recommendation** no longer emits an illegal
  positional id. The real `pending resolve` is strict-FIFO with no `--id`, so
  the prior `loaf pending resolve <PEND-id> --answer …` was rejected by the CLI
  (commander.excessArguments, exit 2). Now emits
  `loaf pending resolve --answer "<answer>"`.

### Verification

- `bun run typecheck` clean; `bun run test` (Vitest) full suite green —
  `tests/core` 65 files / 1360 tests. New `tests/core/next-action.test.ts`
  (lane-routing kernel) + `loaf next` CLI block round-trips all 7 owner verbs
  and the frontmatter-derived VERIFY lane skips.
- `bun run build` regenerated `dist/cli.mjs`; `dist/cli.mjs --version` → `0.3.0`.

## [0.2.0] — 2026-06-02

Two feature surfaces land together: a master-detail `loaf tui` and a CLI-wide
runtime i18n layer (en/zh). Both are presentation-layer additions — the typed
journal, reducer, preflight, and JSON machine contract are untouched.

### Added

- **`loaf tui` master-detail** — the flat session table becomes a
  project→feature→session grouped tree (rendered as a pure flat render plan)
  with an active-only filter (`a` toggles DONE.* visibility), time/status sort
  (`s`), fold (`space`), and an Enter/Esc full-screen per-session detail view
  (lazy `loadProjections`, row-local on missing/stale/error). Status badge `⏸`
  replaced with `‖` for terminal-font legibility.
- **Runtime i18n (ADR-0006)** — `LOAF_LANG` / `~/.loaf/config.json`
  `locale.default_lang` select `en`/`zh`; resolution order `--lang` (future) >
  `$LOAF_LANG` > user config > project `loaf.config.json` locale > parsed
  `$LANG`/`$LC_*` > `en`. Localized surfaces: TUI list/detail + chrome, enum
  labels, diagnostics (1:1 `diagnostic.<CODE>` + broad `failure.<site>.<reason>`
  site keys), action success/advisory text, and read-only command renderers
  (`status` / `tasks list` / `pending` / `finding` / `sessions list`). New
  `INVALID_LOCALE` diagnostic (exit 2 on explicit bad locale).

### Invariants

- **JSON never localized** — success payloads and failure JSON `message` stay
  canonical English; `t()` runs only in text renderers / lazy advisories.
  Localization missing at runtime degrades gracefully (locale → en → raw key);
  test-time gates assert every runtime-emitted key exists in en+zh.
- `en` fixed-column list cells keep raw single-token enums (scriptable);
  `next:` / `error:` prefixes, diagnostic CODE values, IDs/paths, and the
  `cursor` sub_state token stay English/raw. Stable core imports no i18n.

### Changed

- `protocol.md` §18.3 locale-resolution order revised to match ADR-0006
  (supersedes the old `LOAF_LANG > loaf.config.json > $LANG > en` single layer).

### Verification

- `bun run test` (Vitest): full suite green — 2084 tests across 122 files.
- `bun run typecheck` clean; `bun run build` regenerated `dist/cli.mjs`.
- Manual: `LOAF_LANG=zh` renders Chinese across TUI + `status`/`tasks list`;
  `--format json` payloads byte-identical to `en`.
- `dist/cli.mjs --version` → `0.2.0`.

## [0.1.2] — 2026-06-01

Two delivery-gate correctness fixes surfaced by an independent review of the
prototype e2e: the per-task evidence gates accepted non-passing evidence as
completion proof. Both are behavior-tightening (the gates now reject what they
formerly accepted) and run at decision time — no stored state affected, no
migration.

### Fixed

- **verify-min required a passing result** (quick/light deliver gate) — `loaf deliver` from `EXECUTE.done` matched a done task's per-task evidence by kind + covers only, never `ev.result`, so a feature could ship with a `result:failed` `local-check` on record. Now requires `result ∈ {passed, approved, waived}`; `waiver` satisfies only when its own result is positive (failed/rejected waiver no longer escapes). Reproduced end-to-end. See commit `ff8a260`.
- **verify-accept check 4 required a passing result** (standard/deep gate) — the sibling hole: check 4 matched per-task evidence by kind + covers only; the lane check (check 1) is result-aware but session-wide, so in a multi-task feature a done task whose only covering evidence was `failed` still passed as long as another task supplied the passing lane evidence. Now requires `result ∈ {passed, approved, waived}` per task, via the same exported `isPassingResult` (single source of truth with verify-min, so the two gates cannot drift again). See commit `64d0a45`.

### Changed

- `TASK_DONE_NO_EVIDENCE` message now reads "no PASSING evidence" (covers both absent and non-passing covering evidence). No new `DiagnosticCode` / `ERROR_CATALOG` / i18n key.
- `protocol.md` §5.2 check 4 + verify-min contract (§3.2) now state covered evidence must be passing; the stale claim that plain `loaf tasks step done` without evidence fails preflight with `TASK_STATUS_WITHOUT_PROOF` is corrected — plain step-done may stay single-entry, missing task evidence is enforced by verify-min / verify-accept, and `TASK_STATUS_WITHOUT_PROOF` is reserved for the future `loaf tasks check` (F-023).
- Stale `ERROR_CATALOG` remediations corrected: `TASK_STATUS_WITHOUT_PROOF` no longer points at the non-existent `loaf tasks set`; `DELIVER_SPIKE_TASKS` now points at `loaf tasks abandon` (was an invalid `tasks step done --result abandoned`). `CLAUDE.md` journal-envelope drift (`iso_ts`/`schema_version` → `at`/`entry_schema_version`; Pass 0 forbidden set) corrected.

### Verification

- `bun run test` (Vitest): full suite green — 1969 tests across 116 files (the pre-existing `tests/spike/perf.test.ts:124` F-005 perf flake did not fire this run).
- `bun run typecheck` clean; `bun run build` ok.
- Both fixes RED→GREEN independently reproduced (revert only the predicate with the new tests present → exactly the new negative cases fail; restore → green).
- `dist/cli.mjs --version` → `0.1.2`.

[0.5.0]: https://github.com/est7/loaf/releases/tag/v0.5.0
[0.4.0]: https://github.com/est7/loaf/releases/tag/v0.4.0
[0.3.1]: https://github.com/est7/loaf/releases/tag/v0.3.1
[0.3.0]: https://github.com/est7/loaf/releases/tag/v0.3.0
[0.2.0]: https://github.com/est7/loaf/releases/tag/v0.2.0
[0.1.2]: https://github.com/est7/loaf/releases/tag/v0.1.2

## [0.1.1] — 2026-06-01

Post-v0.1.0 follow-up closing the two "do" items from the F-028 grill-me
review of the v0.1.0 deferrals. The remaining deferrals (single-writer
lock, `loaf context pack`, `loaf tui` interactions, scope-track writer)
stay deferred with owners and do NOT re-open v0.1.0.

### Added

- **`lessons.md` projection writer** (F-024) — `loaf lessons add` now produces a user-facing top-level `.loaf/<feature>/lessons.md` markdown projection (rebuilt from the journal on every mutate; skipped/removed when no lessons), not just the evidence ledger. A lesson selector (kind=manual + empty covers + no task/check/gate + human actor) excludes `loaf evidence add --kind manual` verification evidence; sidecar lesson bodies are read + sha256/size-verified (mismatch → `PROJECTION_WRITE_FAILED`). See commit `951b89c`.
- **verify-min deliver gate** (protocol §3.2) — quick/light `loaf deliver` from `EXECUTE.done` now runs a per-task evidence check instead of fail-closing, unblocking the quick/light ceremonies end-to-end. Code tasks require `local-check` build/test evidence, visual-ui require visual-review/manual, docs require task-summary/manual, chore require any; `waiver` always satisfies; a done bug task without a registered RED test fails with `BUG_TASK_RED_NOT_REGISTERED`. Missing evidence → `DELIVER_VERIFY_MIN_INCOMPLETE`; standard/deep that attempt deliver from `EXECUTE.done` → `DELIVER_NOT_ACCEPTED` (must traverse VERIFY). See commit `1e49a7a`.

### Changed

- `DELIVER_VERIFY_MIN_UNAVAILABLE` reframed reserved/history — the v0.1.0 fail-closed stub is no longer emitted; superseded by `DELIVER_VERIFY_MIN_INCOMPLETE`.
- `loaf lessons add` advisory now states `lessons.md updated` (was "projection writer deferred").

### Verification

- `bun run typecheck` clean; `bun run check` (Vitest): full suite green (1958 tests; modulo the pre-existing `tests/spike/perf.test.ts:124` F-005 perf flake).
- `bun run ga:check` passes against the release commit.
- `dist/cli.mjs --version` → `0.1.1`.

### codex review trace (thread `review/cli-lifecycle-plan`)

- F-024 — plan-first → 1 PATCH (lesson selector vs `kind=manual`; IO/pure sidecar split) → SIGN-OFF.
- verify-min — plan-first → GO (Q2 locked stricter: `task-summary` alone does not satisfy code tasks) → 1 PATCH (stale doc/catalog wording) → SIGN-OFF.

[0.1.1]: https://github.com/est7/loaf/releases/tag/v0.1.1

## [0.1.0] — 2026-05-25

First general-availability release of the loaf protocol kernel
(ADR-0005 / rev 5.0). Promotes `0.1.0-rc.1` to stable per codex thread
`review/cli-lifecycle-plan` r183 (GA path verdict). RC bake was
condensed — codex r183 explicitly acknowledged "no real downstream
consumers or external integrations yet", so longer bake collects
hypothetical confidence not signal. Real-workflow exercise begins
post-tag via `loaf-skill` integration.

> **Tag scope note** (backfilled): this entry's 2026-05-25 date is the
> GA-cut. The `v0.1.0` tag was deferred (per `task_plan.md`) to the close
> of **Phase 16 — Complete CLI surface alignment** and points at commit
> `42455e5` (2026-05-31), so v0.1.0 ships the full Phase 16 surface, not
> just the GA-cut mechanics below: the complete worker-workflow CLI
> (TRIAGE→SPEC→EXECUTE→VERIFY→DONE), the DiagnosticCode catalog +
> presentation/behavior flags, the `--session`/registry dispatch layer,
> the projection-read commands + `<artifact> schema` emitters, `loaf
> check`, `spec edit`, the lifecycle commands (`resume` / `handoff`), the
> `loaf tui` read-only session manager, and the 4-event Claude Code hook
> surface (`session-start` / `closure-check` read-side; `write-guard` /
> `scope-track` write-side). Per-SC detail lives in the commit bodies
> (SC-0 … SC-17) and `task_plan.md`; this note corrects the GA-cut entry
> below, which predated that work.

### Added

- **GA-cut release gate** (`scripts/ga-package-smoke.sh` + `scripts/ga-consistency-check.sh` + `package.json scripts` `ga:check`) — packs via `bun pm pack`, installs into a clean temp dir, runs the r183-minimum lifecycle smoke (`--version` / `start` / `status` / `doctor --rebuild`), and gates the cut on version/tag/CHANGELOG/worktree/HEAD parity. Stable machine-readable failure codes on stderr (12 codes). 13 vitest cases under `tests/scripts/`. See commit `bd21575`.
- **`dist/cli.mjs` committed to repo** (`.gitignore` exception) — enables `bunx github:est7/loaf#v0.1.0` / `bun add github:est7/loaf#v0.1.0` consumer installs with zero post-install build step. Required for `loaf-skill` integration via direct GitHub install. (An earlier attempt during this same release used a `prepare` script to build on install; bun blocks lifecycle scripts for untrusted github-installed packages by default, so the script never ran. Committing the bundle is the standard pattern for github-installed Node CLIs.)
- **GA cut workflow** section in `README.md` documenting `bun run ga:check` as the pre-tag gate, plus consumer install examples (`bunx` / `npx` / `bun add` from GitHub tag).

### Changed

- **`README.md`** rewritten from rev-3.x scaffold-era framing to the loaf protocol-kernel framing (commit `6ad91d2`).
- **`package.json description`** aligned with the rewrite.

### Verification

- `bun run typecheck` clean.
- `bun run check` (Vitest): full suite green (modulo the pre-existing `tests/spike/perf.test.ts:124` F-005 perf flake — non-blocking, tracked across sessions).
- `bun run ga:check` passes against the GA cut commit.
- `dist/cli.mjs --version` → `0.1.0`.

### codex review trace (thread `review/cli-lifecycle-plan`)

- r183 — GA path locked to (a) iterate to stable on short RC bake.
- r184 — Plan-First for GA checklist scripts (PATCH-REQUIRED → GO).
- r185 — diff review (BLOCK on substring VERSION_MISMATCH).
- r186 — patch follow-up GO.
- r187 — retrospective post-tag sign-off (queued).

[0.1.0]: https://github.com/est7/loaf/releases/tag/v0.1.0

## [0.1.0-rc.1] — 2026-05-25

First release candidate for the loaf protocol kernel (ADR-0005 / rev 5.0).
This RC completes the snapshot persistence and read-contract closure —
the RC-critical phase per codex thread `review/cli-lifecycle-plan` r166.

### Added — Phase 15 (Snapshot persistence / read-contract closure)

- **`src/core/projection-loader.ts`** — read-side snapshot consumer for
  the four CLI commands that read `.loaf/<feature>/snapshots/*.json`.
  M0-anchored TOCTOU contract: read `_meta.json` → fast-check → read
  requested projection leaves → fast-check the same cached meta again
  (linearization guard against mid-call mutators). Single freshness
  transaction per call. No silent fallback on any stale or corruption
  reason.
- **Test-only seam `loadProjectionsWithHooks(input, hooks)`** —
  `@internal` export that enables deterministic TOCTOU regression
  testing. Public `loadProjections(input)` signature unchanged.
- **`SnapshotMeta` empty-sentinel refine** — when
  `last_applied_seq === -1` the meta must structurally match
  `emptyMeta()` (offset=0, both hashes=`ZERO_HASH`,
  `feature_schema_version=current`). Mirrors runtime `isEmptyMeta()`
  exactly; closes a silent-fallback hole where a corrupt sentinel
  meta would translate to `NO_SESSION` via the seq-only fast-check.
- **`writeProjections` mutator integration** — every `mutateBatch`
  landing writes all five `snapshots/*.json` plus `_meta.json` after
  the journal append (atomic tmp+rename, meta written last).
- **`StateProjection` schema split** — formerly-monolithic `StateJson`
  separated into the journal-derived `StateProjection` (Buckets A/B/C
  identity) and the machine-local `SessionRuntimeFile` (Bucket D —
  `cwd` / `debug` / `heartbeat_at`, never replay-derived).
- **`loaf start --label <text> --workspace <name>`** — Bucket-C
  identity fields widened onto the `session:started` payload.
- **`SNAPSHOT_STALE_REBUILD_REQUIRED` diagnostic** — added to
  `DiagnosticCode` enum, `ERROR_CATALOG`, and `i18n/{en,zh}.json`.
  9-reason taxonomy on `detail.reason`:
  `journal_missing` · `journal_empty` · `tail_offset_mismatch` ·
  `tail_hash_mismatch` · `trailing_partial_line` · `meta_missing` ·
  `meta_invalid` (with `detail.cause: "json_parse" | "schema"`) ·
  `projection_missing` (with `detail.projection_kind`) ·
  `projection_invalid` (with both).
- **E2E lifecycle tests** — `tests/core/sc4-e2e.test.ts` exercises
  the full write → fast-check → consume → stale-fails → rebuild →
  read-OK cycle across all four wired commands.

### Changed

- **`loaf status` reads from `snapshots/state.json` via
  `projection-loader`** (was `loadSession` full journal replay). Other
  reads in the same command (tasks count, evidence count, findings
  count, pending count) go through the same single freshness
  transaction. `status.state` is adapted to the prior
  `SessionState`-compatible 9-key shape; `state.feature` re-injected
  from `--feature`.
- **`loaf tasks list` reads from `snapshots/tasks.json`** — adapter
  projects each `TaskFullPayload` to the prior slim `TaskState` shape
  plus the derived `ready` column. Post-`loaf start` pre-submit
  (no plan) returns `count: 0, tasks: []` per the writer's
  conditional-skip contract (no `projection_missing` error).
- **`loaf pending list` reads from `snapshots/pending.json`** —
  adapter maps `pending_id → id` and drops richer queue fields to
  preserve the prior `{id, kind, resolved, head}` shape.
- **`loaf finding list` reads from `snapshots/findings.json`** —
  `FindingState` shape matches 1:1, no adapter.
- **`loaf status` on a pre-`loaf start` directory now exits 2 with
  `NO_SESSION`** — previously exit 0 with `state: null`. Aligns
  `status` with the other three read commands (`tasks list` /
  `pending list` / `finding list`) which already had this contract.
  CI scripts probing session existence via `loaf status` exit code
  need to adapt to the uniform fail-fast behavior. Documented in
  `docs/protocol.md` §10.8.
- **`loaf doctor --rebuild`** now rebuilds all 5 projection files
  (was 4/5 — `state.json` was a Phase 14 deferral, landed in
  Phase 15 SC1).
- **`MutateContext` now requires `entries` + `meta`** — used by mutate
  step 8 to write snapshots without re-reading the journal.
  `appendMany` consumes the prior `SnapshotMeta` and returns the
  post-append meta (`PRIOR_META_STALE` on prefix drift).

### Fixed

- **`loaf_version_required` regex widened to accept semver
  prerelease + build-metadata identifiers** (RC blocker — caught
  during release housekeeping smoke). Old regex
  `/^[\^~]?\d+\.\d+(\.\d+)?$/` rejected `^0.1.0-rc.1`, which the CLI
  auto-derives from `package.json` when the package version itself
  carries a prerelease suffix. Every `loaf start` then failed
  INVALID_PAYLOAD on session:started, blocking the RC tag. New regex
  `/^[\^~]?\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/`
  is backward-compatible (legacy `^0.1.0` / `~1.0` pins still parse)
  and applied to all three contract copies — `SessionStartedPayload`,
  `StateProjection`, and the `docs/schemas.ts` mirror. See commit
  `e1bdc9c`.
- **`composeStateProjection` re-parses `session:started` through
  `SessionStartedPayload`** — distinguishes legacy (bucket-C field
  absent → documented fallback) from corrupt (present but malformed
  → throw). Previously laundered corrupt fields into fallbacks.
- **`state.json.pending` no longer leaks the `resolved` ledger flag**
  — the public read contract is `PendingQueueEntry[]` (no `resolved`),
  separate from `pending.json`'s `PendingProjectionEntry[]` (with
  `resolved`).
- **`appendMany` empty-prefix rejection** — a non-empty-sentinel prior
  meta passed for an empty journal would fold a corrupt
  `rolling_checksum` into the returned meta. Now rejected upstream
  via `isEmptyMeta()` + `last_entry_offset` non-zero guard.

### Documentation

- **`docs/protocol.md` §10.15 / Gate #5** — annotated with the
  9-reason taxonomy and the four commands wired in this RC.
  Explicitly scopes SC3 to those four; other read commands remain on
  `loadSession` full replay (migration is post-RC backlog).
- **`docs/schemas.ts` §39 `ERROR_CATALOG`** — adds
  `SNAPSHOT_STALE_REBUILD_REQUIRED` entry with the message and fix
  templates that the i18n bundles mirror.
- **`docs/adr/0005-truth-model-single-typed-journal.md`** — remains
  the canonical truth-model spec; no schema-level changes this RC.

### Known limitations / deferred (non-RC backlog)

- Other read-only commands (`loaf tasks check` / `tasks next` /
  `verify status` / `pending status` / `sessions list` / `<artifact>
  schema` / `check <path>` / `tui` / `handoff` / etc.) still execute
  `loadSession` full journal replay. Migration to `projection-loader`
  is post-RC and follows the same per-command shape as the four
  wired in this release.
- `loaf doctor` modes other than `--rebuild` are not implemented in
  this release (bare `loaf doctor` exits 2 with
  `DOCTOR_MODE_NOT_IMPLEMENTED`). The deferred surfaces are
  `--check-tail`, `--migrate-v2`, `--scope cwd`, `--verify-checksum`
  (per `docs/protocol.md` §10.15).
- v0.0.x-migrated journals cannot be rebuilt by `loaf doctor
  --rebuild` (intersects the deferred `--migrate-v2` work — exits 2
  `DOCTOR_REBUILD_MIGRATED_UNSUPPORTED`).
- `complexity_score` is always `null` in `StateProjection` — no
  journal source exists yet; folded into the future TRIAGE-scoring
  slice.
- `SessionRuntimeFile` has a schema contract (`docs/schemas.ts` §12b)
  but no runtime writer in this release — machine-local liveness is
  not yet persisted.
- The mutator preflight + reducer dry-run continue to consume the
  full snapshot + entries from `loadSession`; the projection-loader
  read-path is currently scoped to read-only consumers only.
- The kind→projection affected-file filter inside `writeProjections`
  is deferred — every `mutateBatch` rewrites all five leaves. Recorded
  perf cost: `tests/core` ~7s → ~55s, every CLI mutation fsyncs ~12
  files.

### Verification

- `bun run typecheck` clean (existing Zod v4 `[6385]` deprecation
  warnings are not errors and are out of RC scope).
- `bun run test` (Vitest): **1189 passed, 0 todo** across 55 test
  files (1149 SC4 close + 40 regex test cases from the RC blocker fix).
- `bun run build` (tsdown): `dist/cli.mjs` 264 KB, gzip 56 KB.
- Manual `dist/cli.mjs` smoke after build: `--version` → `0.1.0-rc.1`;
  `loaf start` → `loaf status` end-to-end exit 0; `state.json.loaf_
  version_required` = `"^0.1.0-rc.1"` (preserved verbatim).

### codex review trace (thread `review/cli-lifecycle-plan`)

Sessions 11-13, rounds r155-r180 across Phase 14 (`loaf doctor
--rebuild` + projection serializer), Phase 8 (doc sync), Phase 15
(SC1 contract split → SC2 mutate step 8 → SC3 reader fast-check →
SC4 E2E closure), and r180 RC-readiness ruling. Per-SC trace
preserved in commit bodies (`git show <hash>`).

[0.1.0-rc.1]: https://github.com/est7/loaf/releases/tag/v0.1.0-rc.1
