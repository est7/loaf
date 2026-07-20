# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

<!-- Semantic ownership: do not copy protocol or runtime values into this file. Any intentional mirror needs an explicit semantic-claim block and an owner-backed checker in `tests/scripts/claude-semantic-gate.test.ts`. -->

## What this is

`loaf-cli` is the **protocol kernel** for Loaf's feature-lifecycle workflow.

<!-- claude-semantic-claim: protocol-revision owner=docs/protocol.md -->
The authoritative protocol currently declares rev 5.2.
<!-- /claude-semantic-claim -->

Runtime contracts — including the journal truth model, projections, state machine, IDs, journal kinds, and diagnostics — are owned by `docs/machine-contract.md` and the runtime sources it indexes. ADR context for the truth model lives in `docs/adr/0005-truth-model-single-typed-journal.md`.

It is NOT a generic Bun scaffold. Despite Bun being the package manager and dev runner, the published binary is plain Node ESM, and the test runner is **Vitest** (not `bun test`).

A sibling layer `loaf-skill` (separate codebase, post-v0.1.0) handles workflow orchestration — see `skills/CONTRACT.md`. Do not pull `loaf-skill` concerns (`flatten`, `warn`, `fan-out`, decomposition policy) into this repo.

## Tech & commands

- **Runtime and compiler policy**: Node ESM; see `package.json` and `tsconfig.json`
- **Package manager**: Bun (`bun.lock`)
- **CLI**: Commander + Ink/React for TUI screens
- **Schemas**: Zod
- **Tests**: Vitest (`bun run test` → `vitest run`)
- **Build**: tsdown (`bun run build` → emits `dist/cli.mjs`)

```bash
bun install
bun run dev -- <args>            # bun run src/cli.tsx -- <args>
bun run typecheck                # tsc --noEmit
bun run test                     # vitest run (full suite)
bun run check                    # typecheck && test && build
bunx vitest run tests/core/spec-init.test.ts          # single file
bunx vitest run -t "spec init writes valid scaffold"  # single test name
```

Do **NOT** invoke `bun test` — Bun's test runner is not used here; tests rely on Vitest globals + `vi.*`.

## Architecture (big picture)

### Runtime ownership

- Use `docs/machine-contract.md` as the wayfinder for schema, FSM, ID, kind-registry, error-catalog, and generated-contract ownership. Read the indexed runtime owner before changing a contract.
- Route state changes through `src/core/journal-mutate.ts`; direct append APIs are reserved for explicitly owned recovery and migration paths.
- Register kind-specific behavior through `src/core/kind-registry.ts` instead of maintaining parallel kind tables.
- Keep preflight validation and reducer application aligned. Shared facts belong in stable invariant helpers, while each boundary retains its own typed error surface.
- The reducer in `src/core/reducer.ts` **mutates in place** — don't hold a pre-mutation snapshot reference; clone it first if you need the prior state.

### Where core behavior lives

Navigation only — each file owns its own contract; read the source before changing it.

| Concern | Owner |
|---|---|
| Transactional mutation entry point (preflight → dry-run → gates → sidecar → append) | `src/core/journal-mutate.ts` |
| Projection application | `src/core/reducer.ts` |
| Admission validation + typed failure codes | `src/core/reducer/preflight.ts` |
| Shared invariant predicates used by both surfaces | `src/core/reducer/invariants.ts` |
| Per-kind tables (payload, actor, sub_state, reducer-implemented) | `src/core/kind-registry.ts` |
| Legal transitions + guards | `src/core/reducer/transition.ts`, `src/core/machine.ts` |
| Gate evaluation | `src/core/gates/` |
| Task-graph admission | `src/core/task-graph.ts` |
| Actor resolution policy | `src/core/actor-resolver.ts` |
| Long-field promotion | `src/core/sidecar.ts` |

The mutation pipeline is staged and **all-or-nothing before write**: per-entry preflight and reducer dry-run run first, then gate evaluation, then sidecar promotion, then a final dry-run plus drift check, and only then a single fsync'd append. Once the append syscall starts there is no in-process rollback — partial writes are recoverable only through `loaf doctor`. Read `src/core/journal-mutate.ts` for the current pass order rather than assuming it.

### Schema source of truth

Runtime source IS the machine contract; `docs/machine-contract.md` is its index. Domain schemas live under `src/core/` and `src/cli/input-schemas.ts`; `src/core/error-catalog.ts` owns diagnostic definitions.

When changing diagnostics, update the runtime owner, run `bun run gen:i18n` and `bun run gen:errors`, then run `bun run verify:codegen`. Do not hand-maintain generated mirrors. Placeholder names must match the runtime `detail.*` keys. Avoid literal `{` in templates that are not placeholders — the substituter collides with set notation, so use backticks or `X or Y` instead.

### CLI surface

Treat the live Commander tree as the command authority: inspect `loaf --help` and subcommand help before changing or documenting a command. The protocol's command-to-kind contract is indexed from `docs/protocol.md`; implementation registration lives under `src/cli/commands/`.

Keep input schemas strict. Do not accept caller-owned IDs or journal envelope fields where the CLI owns allocation and stamping; use the runtime schemas and allocators indexed by `docs/machine-contract.md` rather than copying their closed sets here.

## Test conventions

- **Real-FS integration**: `tests/core/cli.test.ts` uses `runCli([...argv])` (helper at top of file) with `fs.mkdtemp` per case. No mocking. Tests cover the full mutator pipeline + reducer apply.
- **Stable core unit tests**: live under `tests/core/`; representative files include `tests/core/journal-mutate.test.ts`, `tests/core/reducer.test.ts`, and `tests/core/preflight-validation.test.ts`. Table-driven where shape allows.
- **Seed helpers**: `seedFeatureAtSpecDesign` / `seedFeatureAtVerifyAccept` / `seedAtSpecProposalPostSubmit` chain `event:phase_advanced` entries to set up sub_state-specific fixtures. Reuse rather than re-roll.
- **Per-kind payload fixtures**: `tests/core/per-kind-fixture-builder.ts` synthesizes the minimum valid payload for any kind in `REDUCER_IMPLEMENTED_KINDS` — drives `per-kind-substate.test.ts`'s sub_state × kind matrix.

## Planning workflow (session-spanning)

The retired planning trio (`task_plan.md` / `progress.md` / `findings.md`) was
consolidated into **`backlog.md`** (gitignored, repo root) at v0.1.1 — read it
before any non-trivial work. It tracks only what is **not yet implemented**;
per-cycle history now lives in the thick commit bodies.

Commit message bodies are **thick** — each sub-cycle commit carries: design decisions / codex review trace / RED tests / Deferred / Residual risk. `git show <hash>` is the per-cycle ground truth.

## Workflow conventions

- **One sub-cycle = one commit**. Within a sub-cycle: RED test → impl → codex review (often via orchestrator AMQ thread `review/cli-lifecycle-plan`) → adjust → sign-off → commit. Commit subject `feat(core|cli): <surface> — Slice X.Y sub-cycle Z <topic>`.
- **Plan-first when `PUBLIC_IMPACT=true`**: schema additions, reducer/preflight code unions, ERROR_CATALOG / DiagnosticCode additions, journal entry shape, ADR-touching decisions. Dispatch a plan to codex before RED.
- **Boy Scout flag, don't fix**: in-scope refactors only; out-of-scope findings go in the commit's `不在范围` section with `[file:line — problem — suggestion]`.
- **Generated diagnostics stay derived**: change `src/core/error-catalog.ts`, regenerate the i18n and protocol artifacts with the package scripts, and verify codegen drift. Do not patch generated mirrors by hand.
- **Strict over Postel** at every CLI input boundary: `.strict()` Zod schemas, closed `z.enum` (no `.passthrough()` on closed-set fields like `EvidenceKind` / `FindingAction` / `PendingPromptKind`), reject caller-supplied ids, reject envelope fields.

## Ship & distribution

Not published to npm (`npm view loaf-cli` → 404). The CLI is distributed **straight from git** — GitHub repo is `est7/loaf` (repo name ≠ package name `loaf-cli`; remote `git@github.com:est7/loaf.git`).

- **`dist/cli.mjs` is committed.** `.gitignore` ignores `dist/` by default and re-includes only `dist/cli.mjs`; `package.json` `files` also includes the artifact. Git consumers run the committed binary directly — there is **no `prepare` script**, so nothing rebuilds on `pnpm add`. The committed `dist/cli.mjs` IS the shipped artifact. Stage the rebuilt binary with **`git add -f dist/cli.mjs`**: the `dist/` deny-by-default rule makes a plain `git add dist/cli.mjs` warn `paths ignored: dist` and exit 1 *even though the file is tracked*. Deny-by-default is intentional — it keeps build sidecars (`cli.mjs.map`, `.d.ts`) out of the commit; the `-f` is the price, not a bug to "fix" by loosening the ignore.
- **Release flow (`chore(release): vX.Y.Z`)**: bump `package.json` version → `bun run build` (regenerate `dist/cli.mjs`) → CHANGELOG: add **both** the `## [X.Y.Z]` entry **and** the bottom `[X.Y.Z]: …/releases/tag/vX.Y.Z` reference-link line → bump README install pins → `git add -f dist/cli.mjs` + the doc/manifest files → commit → `git tag vX.Y.Z` → push commit + tag. The bottom link line is **not optional**: CI's `release-consistency` job (`scripts/ga-consistency-check.sh`, runs on the tag ref) fails `CHANGELOG_MISSING` on the `## [X.Y.Z]` heading alone (check 3). The same gate also enforces **tag commit == origin/main** (check 4 `HEAD_NOT_ORIGIN`): a post-tag fix must move the tag (`git tag -f vX.Y.Z <fix> && git push -f origin vX.Y.Z`) so it tracks the new HEAD, not just land on `main`. Skipping the rebuild ships a stale binary: git consumers get the old `--version` even though `package.json` bumped. Verify before commit: `git show HEAD:dist/cli.mjs | grep '"X.Y.Z"'` and `bash scripts/ga-consistency-check.sh --expected-tag vX.Y.Z`.
- **Install / update the global binary** (consumer side, pnpm):
  ```bash
  pnpm add -g github:est7/loaf            # installs/updates from main HEAD
  pnpm add -g github:est7/loaf#vX.Y.Z     # pin to a tag (reproducible)
  loaf --version                          # verify
  ```
  Re-run the same command to update — pnpm re-resolves the ref. Do **not** suggest `pnpm update -g loaf-cli` (no npm upstream to pull). Installing from `$PWD` (`pnpm add -g $PWD`) is local-dev only; the canonical source is GitHub.

## Don'ts

- Don't bypass `mutateBatch` — direct `appendEntry` / `appendMany` calls skip preflight + reducer dry-run + sidecar promote + REDUCER_IMPLEMENTED gate. Reserved for migration / doctor only.
- Don't introduce side-files for state. Single typed journal — every projection field must be derivable by replay.
- Don't write spec.md / tasks.json / etc. as truth — they are derived projections.
- Don't add `.passthrough()` on closed-enum fields — caller typos (e.g. `gate-decision` vs `gate_decision`) silently bypass invariants (Slice 3 SC1 r64 BLOCK).
- Don't let `{id, ...rest}` spreads accept caller id over allocated id (Slice 4 SC2 r77 BLOCK pattern).
- Don't compose YAML scalars containing `:` / leading `-` / `#` unquoted — production `readSpecFrontmatter` rejects them. Use `JSON.stringify(value)` for embedded scalars (Slice 4 SC4 r80 BLOCK).
- Don't drift `ERROR_CATALOG` placeholders from runtime `detail.*` keys — `{phase}` vs `{kind}` etc. are easy to miss. Use `rg` to cross-check.
- Don't suggest history-rewriting commands (rebase / reset --hard / filter-repo) unless explicitly asked.
- Don't push without explicit user instruction.

## Key references

- `docs/protocol.md` — authoritative protocol; §10.8 owns the CLI command table
- `docs/machine-contract.md` — index mapping the machine contract to its runtime owners (`src/core/error-catalog.ts` = `ERROR_CATALOG` + `DiagnosticCode`; `src/core/kind-registry.ts` = `PER_KIND_PAYLOAD`; `src/core/machine.ts` = state axis)
- `docs/adr/0005-truth-model-single-typed-journal.md` — current truth model
- `docs/adr/` — ADR history; deprecated decisions are marked by later ADRs
- `docs/archive/moni-review.md` — earlier review artifact
- `skills/CONTRACT.md` — loaf-cli ↔ loaf-skill boundary contract
- `loaf.config.example.json` — feature-config schema (protected_files / stable_core / paths / commands)
