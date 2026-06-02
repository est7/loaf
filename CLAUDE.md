# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`loaf-cli` is the **protocol kernel** for the loaf feature-lifecycle workflow (rev 5.0 / ADR-0005). Every state change is one `JournalEntry` appended to `.loaf/<feature>/journal.jsonl`; the reducer projects derived state (`SessionState` / `TaskState` / `EvidenceState` / `FindingState` / `PendingState`) from that journal. There is no `state.json` source of truth — only the typed journal and its in-memory projection.

It is NOT a generic Bun scaffold. Despite Bun being the package manager and dev runner, the published binary is plain Node 22+ ESM, and the test runner is **Vitest** (not `bun test`).

The CLI surface implements the **worker workflow** (TRIAGE → SPEC → SPEC-content → EXECUTE.work → VERIFY → DONE) end-to-end as of Slice 4 close.

A sibling layer `loaf-skill` (separate codebase, post-v0.1.0) handles workflow orchestration — see `skills/CONTRACT.md`. Do not pull `loaf-skill` concerns (`flatten`, `warn`, `fan-out`, decomposition policy) into this repo.

## Tech & commands

- **Runtime**: Node 22+, ESM, TS strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`
- **Package manager**: Bun 1.3+ (`bun.lock`)
- **CLI**: Commander 14 + Ink 7 (React 19 for TUI screens)
- **Schemas**: Zod 4
- **Tests**: Vitest 4 (`bun run test` → `vitest run`)
- **Build**: tsdown (`bun run build` → emits `dist/cli.mjs`)

```bash
bun install
bun run dev -- <args>            # bun run src/cli.tsx -- <args>
bun run typecheck                # tsc --noEmit
bun run test                     # vitest run (full suite)
bun run check                    # typecheck && test && build
bunx vitest run tests/core/spec-init.test.ts          # single file
bunx vitest run -t "spec init writes valid scaffold"  # single test name
bunx vitest run tests/spike                           # spike perf tests (F-005 is a known flake)
```

Do **NOT** invoke `bun test` — Bun's test runner is not used here; tests rely on Vitest globals + `vi.*`.

## Architecture (big picture)

### Single typed journal (ADR-0005)

`.loaf/<feature>/` layout:

```
journal.jsonl       # source of truth — append-only, one JournalEntry per line
attachments/<JE-id>/ # sidecar attachments for long fields (≥8KB) and visual contracts
snapshots/_meta.json # derived projection (lazy; doctor --rebuild is a Slice 5 deferral)
.lock                # per-feature single-writer lock
spec.md             # derived projection of spec content (writer is current open work — slice A)
```

`JournalEntry` envelope (see `src/core/journal-entry.ts`): `{seq, entry_id (JE-NNNNNN), at (ISO ts), actor (^(human|skill|ci|cli|migration):.+$), entry_schema_version=1, kind, payload}`. Per-kind payload schemas live alongside (`PER_KIND_PAYLOAD`) and the reducer-implemented subset is gated by `REDUCER_IMPLEMENTED_KINDS`.

### Mutator pipeline (`src/core/journal-mutate.ts`)

`mutateBatch(partials[], ctx)` is the canonical transactional API. `mutate(partial, ctx)` is a 1-line wrapper. Pipeline:

```
Pass 0  runtime reject forbidden fields (seq / entry_id / batch_id / batch_index / batch_count) on caller input
Pass 1  per-entry preflight + REDUCER_IMPLEMENTED gate + reducer dry-run on UNPROMOTED
        (snapshot is structuredClone'd; chained kinds see incrementally-mutated state)
Pass 1.5 gate eval (spec-lock / verify-accept) — IO boundary reads spec.md frontmatter
Pass 2  sidecar promote (long-text fields → attachments/<JE-id>/)
Pass 3  final reducer dry-run on PROMOTED + drift check (sidecar refs match snapshot)
        + envelope/byte-cap final validate inside appendMany
Pass 4  appendMany single fsync'd multi-line write (atomicity boundary)
```

All-or-nothing **before** write. Once `appendMany` starts writing, partial corruption is reported as `JOURNAL_CORRUPTION` and is recoverable only by `loaf doctor` (no in-process rollback after syscall enters).

### Reducer + preflight + gates split (stable core)

| Module | Role |
|---|---|
| `src/core/reducer.ts` | `apply(snapshot, entry) → snapshot` — in-place projection mutation. Narrows on `kind` discriminator. |
| `src/core/reducer/preflight.ts` | sub_state authority + seq monotonicity + ceremony + per-kind payload refines. Returns typed `PreflightFailureCode`. |
| `src/core/reducer/per-kind.ts` | `PER_KIND_AUTHORITY` (allowed actor prefixes) + `PER_KIND_SUB_STATE` (allowed sub_states). |
| `src/core/reducer/transition.ts` | `validateTransition` shared by reducer + preflight. `event:phase_advanced` is the ONLY kind that moves cursor; `gate:decided` flips flags (`spec_locked` / `verify_accepted`) but does NOT move cursor (Slice 1.A normalization). |
| `src/core/gates/spec-lock-check.ts` | 8 pure checks: frontmatter / needs_clarification / tasks.based_on.spec / REQ coverage / spec-review / scenario coverage / visual coverage / orphan check. |
| `src/core/gates/spec-lock-eval.ts` | IO boundary — reads `spec.md` via `readSpecFrontmatter`, maps file-read failures to `check:1 SPEC_FRONTMATTER_INVALID` with `detail.subcode`. |
| `src/core/gates/verify-accept-{check,eval}.ts` | Same shape for verify-accept gate (5 checks: lane status / open findings / coverage / done-task evidence / spec-review). |
| `src/core/actor-resolver.ts` | Pure policy: `$LOAF_USER` → git email → `NO_HUMAN_ACTOR`. IO (env read / git read) injected from `cli-runtime.ts`. CI safety: never derive `human:` in non-interactive without explicit env. |
| `src/core/journal-append.ts` | `appendEntry` is a 1-line wrapper over `appendMany`. Hard byte caps: 64KB per entry, batch-total enforced. |
| `src/core/sidecar.ts` | Long-text-field promotion via `LongTextField` discriminated union (`inline` → `sidecar`). |

The reducer **mutates in place** — don't hold a pre-`mutate()` snapshot reference; clone it first if you need the prior state.

### Schema source of truth

`docs/schemas.ts` is the **Zod source of truth + ERROR_CATALOG**. The runtime `src/core/*-schema.ts` files mirror a subset for type inference. When adding a `DiagnosticCode` / `PreflightFailureCode` / `MutateFailureCode`:

1. Add to the union in `src/core/reducer/preflight.ts` (or wherever it's surfaced).
2. Register in `docs/schemas.ts` `DiagnosticCode` enum + `ERROR_CATALOG` (with `message_template`, `fix_template`, `doc_anchor`).
3. Add `i18n/en.json` + `i18n/zh.json` template entries — placeholders must match the `detail.*` keys actually emitted at runtime (codex r45/r80 catch this).
4. Avoid literal `{` in templates that are NOT placeholders — `ERROR_CATALOG` placeholder substituter collides with set notation `{a, b, c}` (use backticks / `X or Y`).

### CLI surface (`src/cli.tsx`)

Single-file ~95KB. Pattern per command: parse args → resolve actor → loadSession → build partial entry → `mutateBatch(...)` → format `{ok}` / `{ok:false, code, message, detail}` via JSON or text mode → exit (0 / 2 / 3).

Top-level commands (Slice 4 close):

```
start <feature> --ceremony <quick|light|standard|deep>
advance <sub_state> --feature <X>
status --feature <X>
spec init|submit|add-req|add-scenario|add-visual --feature <X> [--input file]
tasks submit|claim|list|next  +  tasks step start|done
pending raise|list|status|resolve
evidence add --input <file>
finding raise|list|close
gate decide <gate-name> --approve|--reject --reason <…>
deliver | settle
```

Strict input boundaries: CLI rejects caller-supplied `id` on `add-*` / `evidence add` / `finding raise` / `pending raise` (allocators stamp the id via max-serial+1 zero-pad). Caller-supplied envelope fields (`seq` / `entry_id` / `batch_id` / `batch_index` / `batch_count`) are rejected at Pass 0.

Id formats (closed):

```
F-NNN     feature id
JE-NNNNNN journal entry id
T-NNN     task id
REQ-<NS>-NNN / SCEN-<NS>-NNN / VIS-<NS>-NNN  spec content (id_namespace allocator)
PEND-NNNN pending prompt
EV-NNNNNN evidence entry
FND-NNN   finding
```

## Test conventions

- **Real-FS integration**: `tests/core/cli.test.ts` uses `runCli([...argv])` (helper at top of file) with `fs.mkdtemp` per case. No mocking. Tests cover the full mutator pipeline + reducer apply.
- **Stable core unit tests**: `tests/core/{actor-resolver,journal-append,journal-mutate,reducer,preflight-validation,...}.test.ts`. Table-driven where shape allows.
- **Seed helpers**: `seedFeatureAtSpecDesign` / `seedFeatureAtVerifyAccept` / `seedAtSpecProposalPostSubmit` chain `event:phase_advanced` entries to set up sub_state-specific fixtures. Reuse rather than re-roll.
- **Per-kind payload fixtures**: `tests/core/per-kind-fixture-builder.ts` synthesizes the minimum valid payload for any kind in `REDUCER_IMPLEMENTED_KINDS` — drives `per-kind-substate.test.ts`'s sub_state × kind matrix.
- **Spike perf** (`tests/spike/perf.test.ts:124`): **F-005** — threshold ~300ms cap intermittently fires at 300–600ms. Pre-existing, tracked across sessions. Use `bunx vitest run tests/core` (skip `tests/spike`) for non-flake runs.

## Planning workflow (session-spanning)

This repo carries three live planning docs that survive context resets — read them before any non-trivial work:

| File | Role |
|---|---|
| `task_plan.md` | Phase / Slice / Sub-cycle table with CLOSED status + source-of-truth pointers. |
| `progress.md` | Session-by-session narrative with codex review trace (rXX rounds + BLOCKs + sign-offs). |
| `findings.md` | F-NNN findings: design ambiguities, blocker analyses, codex consult records. |

Commit message bodies are **thick** — each sub-cycle commit carries: design decisions / codex review trace / RED tests / Deferred / Residual risk. Last 8 commits cover Slice 3 + Slice 4 close; `git show <hash>` is the per-cycle ground truth, NOT progress.md.

## Workflow conventions

- **One sub-cycle = one commit**. Within a sub-cycle: RED test → impl → codex review (often via orchestrator AMQ thread `review/cli-lifecycle-plan`) → adjust → sign-off → commit. Commit subject `feat(core|cli): <surface> — Slice X.Y sub-cycle Z <topic>`.
- **Plan-first when `PUBLIC_IMPACT=true`**: schema additions, reducer/preflight code unions, ERROR_CATALOG / DiagnosticCode additions, journal entry shape, ADR-touching decisions. Dispatch a plan to codex before RED.
- **Boy Scout flag, don't fix**: in-scope refactors only; out-of-scope findings go in the commit's `不在范围` section with `[file:line — problem — suggestion]`.
- **i18n templates mirror ERROR_CATALOG**: when adding a `DiagnosticCode`, write the template in `en.json` + `zh.json` simultaneously and check that placeholder names match the `detail.*` keys actually emitted (codex r80 BLOCK pattern).
- **Strict over Postel** at every CLI input boundary: `.strict()` Zod schemas, closed `z.enum` (no `.passthrough()` on closed-set fields like `EvidenceKind` / `FindingAction` / `PendingPromptKind`), reject caller-supplied ids, reject envelope fields.

## Don'ts

- Don't bypass `mutateBatch` — direct `appendEntry` / `appendMany` calls skip preflight + reducer dry-run + sidecar promote + REDUCER_IMPLEMENTED gate. Reserved for migration / doctor only.
- Don't introduce side-files for state. Single typed journal — every projection field must be derivable by replay.
- Don't write spec.md / tasks.json / etc. as truth — they are derived projections (writer for `spec.md` is currently being implemented in slice A).
- Don't add `.passthrough()` on closed-enum fields — caller typos (e.g. `gate-decision` vs `gate_decision`) silently bypass invariants (Slice 3 SC1 r64 BLOCK).
- Don't let `{id, ...rest}` spreads accept caller id over allocated id (Slice 4 SC2 r77 BLOCK pattern).
- Don't compose YAML scalars containing `:` / leading `-` / `#` unquoted — production `readSpecFrontmatter` rejects them. Use `JSON.stringify(value)` for embedded scalars (Slice 4 SC4 r80 BLOCK).
- Don't drift `ERROR_CATALOG` placeholders from runtime `detail.*` keys — `{phase}` vs `{kind}` etc. are easy to miss. Use `rg` to cross-check.
- Don't suggest history-rewriting commands (rebase / reset --hard / filter-repo) unless explicitly asked.
- Don't push without explicit user instruction.

## Key references

- `docs/protocol.md` — protocol spec rev 5.0 (~200KB, §10.8 CLI command table is the authoritative surface)
- `docs/schemas.ts` — Zod source of truth + `ERROR_CATALOG` + `DiagnosticCode` enum + `PER_KIND_PAYLOAD` table
- `docs/adr/0005-truth-model-single-typed-journal.md` — current truth model
- `docs/adr/0001..0004` — earlier ADRs (deprecated parts marked in 0005)
- `docs/archive/moni-review.md` / `docs/plan.md` — earlier review artifacts
- `skills/CONTRACT.md` — loaf-cli ↔ loaf-skill boundary contract
- `loaf.config.example.json` — feature-config schema (protected_files / stable_core / paths / commands)
