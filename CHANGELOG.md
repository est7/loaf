# Changelog

All notable changes to `loaf-cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-25

First general-availability release of the loaf protocol kernel
(ADR-0005 / rev 5.0). Promotes `0.1.0-rc.1` to stable per codex thread
`review/cli-lifecycle-plan` r183 (GA path verdict). RC bake was
condensed — codex r183 explicitly acknowledged "no real downstream
consumers or external integrations yet", so longer bake collects
hypothetical confidence not signal. Real-workflow exercise begins
post-tag via `loaf-skill` integration.

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
