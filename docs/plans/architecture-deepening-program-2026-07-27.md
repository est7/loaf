# Architecture deepening program

**Status:** SIGN-OFF REMEDIATION IN PROGRESS
**Approved:** 2026-07-27
**Owner:** loaf-cli maintainers
**Execution rule:** one completed optimization or refactor per local commit
**Publication boundary:** local commits only; no push, tag, or release. A24
authorizes a local package-identity bump required by the breaking-contract gate.

## Purpose

This document is the checked-in source of truth for the architecture work
approved after the 2026-07-27 codebase review and independent Claude review. It
replaces the temporary review report as the execution ledger.

Completion does not mean mechanically creating every proposed abstraction. Each
item must reach one evidence-backed destination:

1. **Implement** a deeper boundary when current change pressure supports it.
2. **Retire** a dead or contradictory contract while preserving required
   compatibility.
3. **Close without extraction** when the proposed abstraction lacks a real
   variation or ownership trigger.

Every task below records its destination, non-goals, acceptance criteria,
validation seam, migration or recovery policy, and intended commit subject. A
task's implementation commit must change its marker from `[ ]` to `[x]` and
replace `Pending` evidence with the commands and results that actually ran.

## Repository and safety baseline

- Baseline revision: `2d0840c` (`v0.6.0`).
- Branch at approval: `main`, aligned with `origin/main`.
- Existing user-owned untracked paths are outside this program and must never be
  staged, edited, or deleted:
  - `.agents/skills/`
  - `.audit/`
  - `.orch/`
  - `audit-report-2026-07-15.md`
- Ignored local planning files (`backlog.md`, `task_plan.md`, `progress.md`,
  `findings.md`) are not a persistence surface for this program.
- Source-changing commits rebuild and include the tracked `dist/cli.mjs` so
  every commit remains a coherent git-distributed CLI.
- Historical journals and published input/wire contracts use tolerant-read
  migrations where stated; new authoring paths remain strict.

## Verification policy

- Behavior changes start with a failing regression, characterization probe, or
  other falsifiable RED artifact at the nearest stable seam.
- Refactors first pin behavior, then prove that duplicate policy or bypass code
  was deleted.
- Targeted tests run before each commit. `bun run check` runs at major
  dependency boundaries and for final closure.
- Generated contract changes run `bun run verify:codegen`.
- The final audit checks commit granularity, tracked distribution output, and
  that only the pre-existing user-owned paths remain untracked.

## Ordered task registry

| ID | Destination | Task | Depends on | Status |
| --- | --- | --- | --- | --- |
| A00 | Persist | Architecture program and acceptance ledger | — | [x] Complete |
| A01 | Implement | Hermetic verification boundary | A00 | [x] Complete |
| A02 | Implement | Public AttachmentRef containment | A01 | [x] Complete |
| A03 | Implement | Attachment authority module | A02 | [x] Complete |
| A04 | Implement | Feature write lease | A03 | [x] Complete |
| A05 | Implement | Explicit mutation commit outcomes | A04 | [x] Complete |
| A06 | Implement | Deep CommandMutator boundary | A05 | [x] Complete |
| A07 | Implement | Unified CLI input ingestion | A01 | [x] Complete |
| A08 | Implement | Strict CLI-owned task intake | A06, A07 | [x] Complete |
| A09 | Implement | Canonical scope-closure fact policy | A03 | [x] Complete |
| A10 | Retire | Phantom reconcile execution contract | A09 | [x] Complete |
| A11 | Implement | Canonical lifecycle advice | A06, A10 | [x] Complete |
| A12 | Retire | Live task-step `evidence_refs` contract | A08 | [x] Complete |
| A13 | Retire | Dead context-pack contract | A01 | [x] Complete |
| A14 | Implement | Skill-driven orchestration journey gate | A11, A13 | [x] Complete |
| A15 | Implement | Mutation/rebuild replay equivalence | A04 | [x] Complete |
| A16 | Implement/close | TUI observability and F-026 disposition | A11 | [x] Complete |
| A17 | Implement | Executable contract-drift guards | A04–A16 | [x] Complete |
| A18 | Close | Freshness ledger and abstraction triggers | A17 | [x] Complete |
| A19 | Verify | Final distribution and history audit | A02–A18 | [x] Complete |
| A20 | Correct | Fault-sensitive mutation/rebuild equivalence proof | A15, A19 | [x] Complete |
| A21 | Correct | Executable skill-to-CLI journey | A14, A20 | [x] Complete |
| A22 | Correct | Truthful feature-lease contract and diagnostics | A04, A17 | [x] Complete |
| A23 | Correct | Audit evidence and supersession trail | A12, A16, A19 | [x] Complete |
| A24 | Implement | Breaking-contract release identity gate | A08, A10, A12, A23 | [x] Complete |

The serial order is deliberate. Attachment confinement precedes refactoring;
the feature lease precedes result and CLI mutation ownership; task intake lands
after the CLI mutation and input seams; lifecycle advice lands after the
reconcile path is truthful.

## A00 — Architecture program and acceptance ledger

**Status:** [x] Complete
**Commit subject:** `docs(plan): define architecture deepening program`

### Destination

Persist the approved work, ordering, decision boundaries, and per-task
acceptance criteria in a tracked repository document.

### Non-goals

- No runtime behavior change.
- No package version, release artifact, tag, or remote update.
- No modification of ignored or user-owned audit/planning files.

### Acceptance criteria

- [x] Every approved architecture candidate and review correction maps to an
  executable task, retirement task, or evidence-backed closure task.
- [x] Each task records scope, non-goals, acceptance, validation, and
  migration/recovery policy.
- [x] Commit and publication boundaries are explicit.

### Validation

`bunx vitest run tests/scripts/docs-runtime-boundary.test.ts`

### Migration and recovery

Documentation only. Revert this commit to remove the program without changing
runtime or persistent data.

### Evidence

`bunx vitest run tests/scripts/docs-runtime-boundary.test.ts` — 1 file,
2 tests passed.

## A01 — Hermetic verification boundary

**Status:** [x] Complete
**Commit subject:** `test: isolate suite discovery and user configuration`

### Destination

Make `bun run test` independent of nested agent worktrees and the maintainer's
real `~/.loaf/config.json`.

### Evidence for change

The approval baseline discovered tests under `.claude/worktrees/*/tests`, so
three repository revisions ran concurrently. The same run also inherited a
real `default_lang=zh` user config while English assertions expected the
documented test default. The run ended with 460 files, 7,347 tests, and 75
failures instead of the repository's single test tree.

### Non-goals

- Do not delete or mutate `.claude/worktrees`.
- Do not change production locale precedence.
- Do not loosen test timeouts to conceal contention.

### Acceptance criteria

- [x] Vitest includes only the root `tests/**` tree and explicitly excludes
  nested `.claude/worktrees/**`.
- [x] The global test setup uses an isolated temporary home in addition to the
  existing isolated registry.
- [x] Focused locale tests still prove explicit `LOAF_LANG`, user-config, and
  ambient-locale precedence.
- [x] A full test run contains no nested worktree test paths and passes from a
  host with a Chinese user preference.

### Validation

`bunx vitest run tests/cli/i18n.test.ts tests/core/user-config.test.ts tests/cli/format-flag.test.ts`
`bun run test`

### Migration and recovery

Test infrastructure only. Production processes and user configuration paths are
unchanged.

### Evidence

- RED baseline: default discovery ran 460 files / 7,347 tests, including two
  `.claude/worktrees` trees, and failed 75 tests after inheriting the real
  Chinese user config.
- `bunx vitest run tests/cli/i18n.test.ts tests/core/user-config.test.ts tests/cli/format-flag.test.ts tests/cli/check-file-end-to-end.test.ts`
  — 4 files, 60 tests passed.
- `bunx vitest run tests/scripts/protocol-contract-gates.test.ts tests/core/registry-writer.test.ts`
  — 2 files, 15 tests passed.
- `bun run test` — root tree only, 170 files and 2,615 tests passed.
- `bun run lint` — 320 files checked.
- `bun run typecheck` — passed.

## A02 — Public AttachmentRef containment

**Status:** [x] Complete
**Commit subject:** `fix(core): confine attachment references to entry buckets`

### Destination

Separate the public authoring contract from the persisted long-text contract.
Public evidence authoring accepts strings or inline long text only. Persisted
sidecar references use the canonical `attachments/<entry_id>/...`
POSIX-relative layout and are validated before any journal append or projection
read.

### Intended observable behavior

`loaf evidence add --input` rejects persistence-only sidecar values. Every
typed persisted journal payload rejects absolute paths, Windows paths, NUL,
backslashes, empty/dot/parent segments, non-attachment roots, and malformed
entry buckets. Valid internally promoted sidecars remain accepted.

### Non-goals

- No journal wire-version bump.
- No change to visual evidence `attachments[]`, which is a different domain
  contract from internal `AttachmentRef`.
- Symlink-safe IO and centralized integrity checks land in A03.

### Acceptance criteria

- [x] A public-CLI RED test proves an out-of-bucket sidecar input is rejected
  and cannot cause external file content to enter a projection.
- [x] Public `EvidenceAddInput` accepts only string or inline long text;
  sidecars remain a persistence-only representation.
- [x] Journal and evidence persistence schemas share one strict AttachmentRef path
  schema.
- [x] Valid migration, lesson, evidence-summary, and scope sidecars still parse.
- [x] Input rejection occurs before journal append.

### Validation

`bunx vitest run tests/core/evidence-input-modality.test.ts tests/core/journal-entry-schema.test.ts tests/core/final-validation.test.ts tests/cli/sc11-end-to-end.test.ts`
`bun run typecheck`

### Migration and recovery

Historical canonical refs are unchanged. Non-canonical refs were never a
documented writer output; replay compatibility for any discovered legacy shape
must be handled explicitly rather than weakening new input.

### Evidence

- RED: the new containment cases failed in 15 places before implementation.
  The public CLI returned exit 0, accepted a caller-provided sidecar, read an
  external sentinel, and allowed it to reach the lessons projection.
- `bunx vitest run tests/core/evidence-input-modality.test.ts tests/core/journal-entry-schema.test.ts`
  — 2 files, 37 tests passed.
- Broader attachment and compatibility suite — 8 files, 146 tests passed.
- Preflight validation suite — 1 file, 124 tests passed after correcting its
  migration fixture to use a canonical attachment path.
- `bun run check` — lint and typecheck passed; 170 test files and 2,631 tests
  passed; the distribution bundle rebuilt successfully.
- `bun run verify:codegen` — passed after updating schema snapshots.

## A03 — Attachment authority module

**Status:** [x] Complete
**Commit subject:** `refactor(core): centralize attachment authority`

### Destination

Give one core module ownership of attachment path authorization, entry-bucket
ownership, symlink-safe resolution, byte-size verification, SHA-256 integrity,
and canonical sidecar writes.

### Non-goals

- No change to the journal payload format.
- No merging of visual evidence attachment metadata with internal long-text
  sidecars.

### Acceptance criteria

- [x] Lesson, scope, and migration consumers no longer perform raw
  `path.join(featureDir, ref.path)` plus local hash logic.
- [x] A ref's bucket must match the owning journal `entry_id`.
- [x] Realpath containment rejects a file or intermediate directory symlink
  that resolves outside the owning entry bucket.
- [x] Size and SHA-256 verification are identical for all readers, including
  migration.
- [x] Sidecar promotion cannot write through a pre-existing escaping symlink.
- [x] Existing happy-path sidecars and migration rehydration remain
  byte-compatible.

### Validation

`bunx vitest run tests/core/sidecar.test.ts tests/core/lessons-projection.test.ts tests/core/scope-recorded.test.ts tests/core/v0.0.x-migration.test.ts`

### Migration and recovery

Canonical sidecars need no migration. Unauthorized or corrupt historical refs
fail closed with an observable integrity error; doctor must not copy their
content.

### Evidence

- RED: the new authority suite could not resolve an authority module, while
  the existing generic walker promoted a fake LongTextField-shaped field to
  `fake.txt`.
- Added attack-shape coverage for wrong entry buckets, wrong slot filenames,
  intermediate and final symlinks, directories, size mismatch, hash mismatch,
  and writes targeting a pre-existing escaping symlink.
- `bunx vitest run tests/core/attachment-authority.test.ts tests/core/sidecar.test.ts tests/core/lessons-projection.test.ts tests/core/scope-recorded.test.ts tests/core/v0.0.x-migration.test.ts tests/core/final-validation.test.ts`
  — 6 files, 74 tests passed.
- `rg` confirms no `src/core` consumer outside the authority dereferences
  `ref.path`.
- `bun run check` — lint and typecheck passed; 171 test files and 2,638 tests
  passed; the distribution bundle rebuilt successfully.

## A04 — Feature write lease

**Status:** [x] Complete
**Commit subject:** `refactor(core): enforce the feature write lease`

### Destination

Replace the private empty-file fail-fast fence with a reusable, owner-fenced
per-feature lease that matches the accepted bounded-wait and stale-owner
contract.

### Intended observable behavior

- A live owner serializes competing writers.
- A contender waits up to the configured bound, then returns typed
  `LOCK_TIMEOUT`.
- A dead owner is reclaimed only after owner-token revalidation.
- Malformed lease state fails closed.
- Release never deletes another owner's lease.

### Non-goals

- Do not reuse the high-frequency session-runtime lock; it has a different
  latency and failure domain.
- Do not make registry projection a gate authority.
- Do not introduce a process-global lock.

### Acceptance criteria

- [x] A dedicated `feature-write-lease` module owns acquire, bounded retry,
  stale recovery, ownership verification, and release.
- [x] Lease metadata is mode `0600` and contains an owner token plus PID.
- [x] `mutateBatch`, doctor projection rebuild, handoff feature-local writes,
  and migration canonical writes either use the lease or carry an explicit
  evidence-backed exemption.
- [x] Dry-run validates against a stable tail under the same lease.
- [x] SIGINT/error paths release only the current owner.
- [x] Runtime lock ordering is documented and deterministically tested.
- [x] `CONCURRENCY_INVARIANTS` and ADR/protocol text match the implementation.

### Validation

`bunx vitest run tests/core/journal-mutate.test.ts tests/core/doctor-rebuild.test.ts tests/cli/handoff-end-to-end.test.ts tests/core/v0.0.x-migration.test.ts tests/core/session-runtime.test.ts`
`bun run verify:codegen`

### Migration and recovery

The first new writer can reclaim an old zero-byte MVP lock only after its
compatibility age. Live owner leases are never stolen. Malformed leases fail
closed; a dead owner is reclaimed only after PID and file-generation
revalidation. A dry-run for a not-yet-created feature is explicitly exempt:
there is no shared journal tail, and creating a directory merely to place a
lease would violate the existing no-write preview contract.

### Evidence

- RED: the new feature-lease suite could not resolve the module; the existing
  mutator used a mode-0644 empty fail-fast file and generic `WRITE_CONTENTION`.
- Lease tests cover 0600 metadata, live-owner serialization and timeout,
  dead-owner generation-checked recovery, malformed fail-closed behavior,
  aged empty-lock compatibility, foreign-successor preservation, and the
  runtime-first lock order.
- Integration tests prove mutate and dry-run stable-tail fencing, error-path
  release, doctor and handoff fail-closed behavior, migration pre-write
  fencing, and owner-checked SIGINT cleanup.
- Focused architecture suite — 7 files, 104 tests passed before the full-suite
  regression pass.
- The first full-suite pass exposed 10 compatibility failures; all affected
  seams were corrected and their 48-test subset passed.
- `bun run verify:codegen` — passed after retiring `WRITE_CONTENTION` from the
  generated error/i18n surfaces.
- `bun run check` — lint and typecheck passed; 172 test files and 2,651 tests
  passed; the distribution bundle rebuilt successfully.

## A05 — Explicit mutation commit outcomes

**Status:** [x] Complete
**Commit subject:** `refactor(core): make mutation commit state explicit`

### Destination

Represent pre-commit rejection and committed-but-projection-failed outcomes as
typed, exhaustive result variants rather than the magic
`detail.journal_appended` key.

### Non-goals

- No append format change.
- No retry of an already committed mutation.
- No hiding of the original projection or registry failure.

### Acceptance criteria

- [x] The result union has an explicit commit-state discriminant.
- [x] All post-append projection failures return the committed variant.
- [x] `executeClosureTransaction` no longer probes arbitrary detail data or
  rereads the journal merely to discover whether commit occurred.
- [x] CLI routing preserves the original diagnostic and the no-retry recovery
  guidance.
- [x] Fault-injection tests distinguish pre-commit and post-commit failures.

### Validation

`bunx vitest run tests/core/journal-mutate.test.ts tests/core/mutate-step8.test.ts tests/core/execute-closure-transaction.test.ts tests/core/mutate-registry.test.ts`

### Migration and recovery

This is a TypeScript/API result change, not a journal change. Callers migrate
exhaustively in the same commit.

### Evidence

- Pre-change characterization found `executeClosureTransaction` branching on
  `detail.journal_appended` and three fault tests asserting that magic key.
  A separate RED run was not retained; the existing expectations served as
  the characterization oracle while the result union changed.
- `MutateResult` and `MutateBatchResult` now require
  `commit_state: committed | not-committed`; committed failures carry the
  committed entry batch, snapshot, and meta.
- Projection, spec, and registry fault injection distinguish committed
  failures from stale-context, lease, and dry-run not-committed outcomes.
- EXECUTE closure's post-append projection failure path performs one initial
  reload only, then proves scope coverage from the committed result.
- Focused suite — 5 files, 70 tests passed.
- `rg` finds no runtime `journal_appended` probe or producer.
- `bun run check` — lint and typecheck passed; 172 test files and 2,651 tests
  passed; the distribution bundle rebuilt successfully.

## A06 — Deep CommandMutator boundary

**Status:** [x] Complete
**Commit subject:** `refactor(cli): make CommandMutator the mutation adapter`

### Destination

Make one CLI adapter own mutation context construction, entry/batch stamping,
dry-run behavior, commit-aware failure routing, and success advisories.

### Non-goals

- `executeClosureTransaction` remains a core transaction because it couples the
  session-runtime lock and journal commit point.
- No user-facing command behavior change.

### Acceptance criteria

- [x] CommandMutator supports single entries, pre-built batches, and an
  explicit per-entry timestamp strategy.
- [x] `src/cli/commands/**` has no direct `mutate`/`mutateBatch` import.
- [x] Spec submit/edit and sponsored task authoring use the same adapter.
- [x] Legacy bypass helpers, allowlists, and stale bypass-count comments are
  deleted.
- [x] Static dry-run and registry-context gates enforce the new boundary.

### Validation

`bunx vitest run tests/scripts/sc6c-dry-run-gate.test.ts tests/scripts/sc7-registry-ctx-gate.test.ts tests/cli/spec-submit-batch.test.ts tests/core/sponsored-tasks-amended.test.ts`

### Migration and recovery

Behavior-preserving preparatory refactor. Revert is local and does not change
persistent data.

### Evidence

- RED: both static boundary gates failed before implementation because the
  private context factory and command-layer bypass prohibition did not exist.
- Focused suite — 4 files, 40 tests passed.
- `bun run typecheck` — passed.
- `bun run check` — lint, typecheck, the complete test suite, and distribution
  build passed.

## A07 — Unified CLI input ingestion

**Status:** [x] Complete
**Commit subject:** `refactor(cli): centralize input ingestion`

### Destination

One ingestion module owns input-source classification, TTY/no-input policy,
stdin/file/inline reads, JSON parsing, size/read failures, and diagnostic
mapping. Domain schemas remain command-family owners.

### Non-goals

- Do not create a universal domain schema.
- Do not change the accepted modality of a command unless a separate task says
  so.
- Do not couple core domain modules to Commander or process IO.

### Acceptance criteria

- [x] Commands call one ingestion API instead of composing `input-source`,
  `input-read`, and `stdin` policy themselves.
- [x] No command repeats the stdin-is-TTY rejection branch.
- [x] File, inline JSON, stdin, `-`, no-input, malformed JSON, and read failure
  semantics remain stable.
- [x] Representative spec/tasks/evidence help and errors are generated from the
  same modality declaration.
- [x] The three superseded shallow modules are deleted or reduced to explicit
  adapters with a single owner.

### Validation

`bunx vitest run tests/cli/input-read.test.ts tests/core/spec-input-modality.test.ts tests/core/tasks-input-modality.test.ts tests/core/evidence-input-modality.test.ts tests/core/ambient-input-gate.test.ts`

### Migration and recovery

Internal refactor. Public input behavior is characterized before extraction.

### Evidence

- Existing modality suites characterized the public source, TTY, missing-input,
  parse, and read-failure behavior before extraction.
- `input-source.ts` and `input-read.ts` were deleted; `stdin.ts` is now an
  explicit process adapter owned by `main()`.
- Focused and contract suite — 9 files, 120 tests passed.
- `bun run verify:codegen`, lint, typecheck, and the complete test suite passed.
- `bun run build` rebuilt the tracked distribution bundle.

## A08 — Strict CLI-owned task intake

**Status:** [x] Complete
**Commit subject:** `feat(cli): allocate task ids from strict submit input`

### Destination

Implement the accepted issue-23 semantic input: callers provide strict
id-less task definitions and local dependency keys; the CLI allocates task IDs,
resolves forward references, materializes execution state, and emits the
unchanged full journal payload.

### Non-goals

- No `event:tasks_planned` wire change.
- No graph repair or dependency invention by the kernel.
- No caller control of `id`, `status`, `execution`, or envelope fields.

### Acceptance criteria

- [x] `TasksSubmitInput` is strict and rejects caller-owned IDs, status,
  execution progress, envelope fields, duplicate local keys, and unknown keys.
- [x] Dependency refs distinguish existing `task_id` from same-batch
  `local_key`.
- [x] Two-pass allocation resolves forward refs deterministically under the
  feature lease.
- [x] `tasks add` uses the same semantic dependency-ref contract.
- [x] The resulting journal payload remains the existing full task shape and
  replays on the prior reader.
- [x] `tasks submit --schema` describes the real authoring contract.
- [x] Migration policy is explicit: a bounded legacy full-input compatibility
  path is either implemented with a deprecation signal or intentionally
  rejected as the approved breaking change.

### Validation

`bunx vitest run tests/core/tasks-input-modality.test.ts tests/cli/schema-emit-end-to-end.test.ts tests/core/task-graph-admission.test.ts tests/cli/sc11-end-to-end.test.ts tests/core/replay.test.ts`
`bun run verify:codegen`

### Migration and recovery

Historical journal entries remain readable. The authoring migration is
input-only and must return the allocated `local_key -> task_id` map.

### Evidence

- Strict authoring contract and two-pass forward-ref allocation:
  `tests/cli/task-authoring.test.ts` (4 tests).
- CLI modality, output mapping, graph admission, schema, replay, feature-lease,
  and journal mutation suites: 118 focused tests passed.
- Main CLI regression suite: 167 tests passed.
- Full repository suite: 174 files / 2661 tests passed.
- `bun run lint`, `bun run typecheck`, and `bun run verify:codegen` passed.
- Migration decision is recorded in `README.md`, protocol §4.3 / §10.7 /
  §10.8, and the ADR-0004 partial-supersession note.

## A09 — Canonical scope-closure fact policy

**Status:** [x] Complete
**Commit subject:** `refactor(core): centralize scope closure invariants`

### Destination

Give one core policy module ownership of the
`scope:recorded + EXECUTE.work -> EXECUTE.done` closure fact.

### Non-goals

- `scope:recorded` remains reducer no-op audit data.
- No planned-scope source is invented.
- Current CLI producer behavior changes only where needed to use the canonical
  builder/validator.

### Acceptance criteria

- [x] The policy validates adjacency, one marker and one closure per batch,
  batch indexes/counts, actor/source state, and marker iteration equal to the
  current/closing iteration.
- [x] A wrong-iteration marker cannot poison a future iteration's duplicate
  guard.
- [x] Writer, commit-proof, and projection paths use the same closure-fact
  parser instead of separate predicates.
- [x] Invalid same-batch/non-adjacent, wrong-index/count, wrong-iteration, and
  duplicate histories have negative tests.
- [x] Valid historical closures still derive canonical unioned actual scope;
  missing markers remain observable as `ACTUAL_SCOPE_HISTORY_INCOMPLETE`.

### Validation

`bunx vitest run tests/core/scope-recorded.test.ts tests/core/reconcile-scope.test.ts tests/core/execute-closure-transaction.test.ts tests/core/journal-mutate.test.ts`

### Migration and recovery

Historical valid records remain valid. Already-corrupt histories fail
observably; they are not silently reinterpreted.

### Evidence

- `src/core/scope-closure-policy.ts` is the shared builder/parser/validator for
  mutation admission, execute commit proof, and actual-scope projection.
- Focused scope, reconcile, closure-transaction, and journal-mutation suites:
  4 files / 79 tests passed.
- Full repository suite: 174 files / 2663 tests passed.
- `bun run lint` and `bun run typecheck` passed.

## A10 — Phantom reconcile execution contract

**Status:** [x] Complete
**Commit subject:** `refactor(core): retire the phantom reconcile stage`

### Destination

Stop presenting `SETTLE.reconcile` and `snapshots/reconcile.json` as a runnable
or required current feature when no canonical `planned_scope` fact or writer
exists. Preserve compatibility for historical state and legacy projection
reads.

### Decision

Do not add a speculative planned-scope journal kind. New deep flows settle
directly into the real lessons step. `scope:recorded` remains audit evidence.
The deprecated reconcile sub-state remains replayable for historical journals
but is not a new transition target.

### Non-goals

- Do not treat `loaf.config.json` permission globs as user intent.
- Do not make a derived reconcile file a gate authority.
- Do not delete historical ADR text; add an explicit supersession trail.

### Acceptance criteria

- [x] New lifecycle routes never require or enter `SETTLE.reconcile`.
- [x] `loaf settle` advances an accepted deep flow to the next real settle
  state.
- [x] Historical journals containing `SETTLE.reconcile` still replay and can
  advance out through a compatibility edge.
- [x] Machine contracts, skills, protocol, and docs do not claim a current
  reconcile writer or exit gate.
- [x] `ReconcileJson` is clearly compatibility-only or removed from live
  projection loading while legacy validation remains isolated.
- [x] No gate reads reconcile data.

### Validation

`bunx vitest run tests/core/machine-transition.test.ts tests/core/e2e-lifecycle.test.ts tests/core/reconcile-scope.test.ts tests/cli/next-advisory.test.ts tests/scripts/protocol-contract-gates.test.ts`
`bun run verify:codegen`

### Migration and recovery

This is a forward lifecycle change with tolerant historical replay. A rollback
can restore the new transition target because no new persistent kind is added.

### Evidence

- New deep flows now route `VERIFY.accept → SETTLE.lessons`; the public
  `loaf settle` command, next-action routing, i18n, generated machine tables,
  protocol prose, and settle skill agree on that destination.
- `applyReplayed()` admits only the former
  `VERIFY.accept → SETTLE.reconcile` journal edge. New `apply()` mutation
  admission rejects it, while the compatibility cursor retains its
  `SETTLE.lessons` exit.
- Live projection loader types exclude reconcile. The dedicated
  `loadLegacyReconcileProjection()` validates historical leaves with the
  compatibility-only `ReconcileJson` schema.
- Focused A10 lifecycle, transition, replay, reconcile, advisory, and protocol
  contract suites passed.
- Full Vitest repository suite passed.
- `bun run build`, `bun run typecheck`, `bun run lint`, and
  `bun run verify:codegen` passed.
- `bun test` is not the repository's canonical runner and inherited the
  ambient Chinese locale: six existing English text assertions failed in
  doctor/sessions tests. The same repository passed under the configured
  Vitest suite.

## A11 — Canonical lifecycle advice

**Status:** [x] Complete
**Commit subject:** `refactor(cli): derive lifecycle advice from core routing`

### Destination

Core owns pure next-action routing facts. One CLI adapter owns selector
injection, i18n, command rendering, and success advisory presentation.

### Non-goals

- No workflow policy in presentation modules.
- No i18n dependency from stable core.
- No automatic execution of the advised command.

### Acceptance criteria

- [x] `loaf next` and post-mutation advisories consume the same routing result.
- [x] Applicable verify lanes, pending head, settle/deliver branch, and
  feature/session selectors agree across entry points.
- [x] Command files no longer hardcode routes already owned by core.
- [x] Core tests cover routing; CLI tests cover rendering and selector
  injection separately.

### Validation

`bunx vitest run tests/core/next-action.test.ts tests/cli/next-advisory.test.ts tests/core/e2e-lifecycle.test.ts tests/cli/sc11-end-to-end.test.ts`

### Migration and recovery

Behavior-preserving except for proven advisory contradictions, which are fixed
to match the current machine.

### Evidence

- `buildScopedNextOutput()` now composes the core routing result with the one
  selector renderer used by both `loaf next` and success advisories.
- `selectorForDispatch()` preserves canonical session UUIDs, explicit
  feature-dir paths, and feature selectors without command-local inference.
- Start, advance, task submit, spec submit, gate approvals, settle, and lesson
  recording consume the snapshot adapter instead of hardcoded route strings.
- Unit coverage pins scoped command equality, shell quoting, blocking-action
  pointers, and session/feature/feature-dir selection. The deep lifecycle
  asserts `loaf settle`'s JSON advisory equals the following `loaf next`
  command.
- A11 focused suites, the full Vitest suite, typecheck, and lint passed.

## A12 — Live task-step `evidence_refs` contract

**Status:** [x] Complete
**Commit subject:** `refactor(core): retire task-step evidence ref writes`

### Destination

Keep the evidence ledger's `covers[]` relation as the only proof authority.
Stop emitting and preserving task-step `evidence_refs` as a live authoring
contract while tolerating the field in historical journal payloads.

### Non-goals

- Do not remove finding or reconcile fields that happen to use the same name
  with different semantics.
- Do not weaken `evaluateTaskProof`.
- Do not infer proof from task status.

### Acceptance criteria

- [x] New task authoring/projections do not expose a writable proof relation in
  task execution steps.
- [x] Legacy task payloads containing `evidence_refs` still replay.
- [x] A done task with only legacy refs and no matching evidence ledger entry
  fails proof.
- [x] Sponsored amend cannot forge proof or delete authoritative evidence.
- [x] History/amend code no longer carries dead live-field complexity.
- [x] Protocol and schema docs identify the legacy-read boundary.

### Validation

`bunx vitest run tests/core/task-proof.test.ts tests/core/verify-min.test.ts tests/core/gates/verify-accept-check.test.ts tests/core/sponsored-tasks-amended.test.ts tests/core/replay.test.ts`

### Migration and recovery

Use a compatibility parser/adapter for old task bodies; emit the narrower live
projection for new sessions. No journal rewrite.

### Evidence

- Task execution schemas, CLI materialization, mutation-rights output, and
  `tasks.json` projections no longer contain task-local `evidence_refs`.
- Canonical task-body reads parse through the live schema, so historical refs
  replay but are stripped before projection or sponsored amend. `started_at`
  and `reason` remain protected execution-history fields.
- Proof tests pin that a done task carrying only a historical ref still fails
  without a passing evidence-ledger entry that covers the task.
- The A12 focused suites passed (281 tests), together with typecheck, lint, and
  the production build. The commit did **not** update the checked-in public
  schema snapshot: 28 stale `evidence_refs` occurrences remained and made the
  full suite fail until A19 repaired the omission. A23 records that boundary
  instead of retroactively claiming generated-artifact verification passed.

## A13 — Dead context-pack contract

**Status:** [x] Complete
**Commit subject:** `docs(core): retire the unused context-pack contract`

### Destination

Delete the unreferenced context-pack schema/template table and close ADR-0004
A8's unimplemented command promise. Existing sanctioned CLI read commands and
handoff remain the orchestration boundary.

### Non-goals

- Do not implement a 20-substate resolver without a consumer.
- Do not restore direct `state.json` reads in skills.
- Do not conflate ephemeral context selection with persistent handoff.

### Acceptance criteria

- [x] `src/cli/context-pack-schema.ts` is deleted.
- [x] No live machine-contract index points to a dead owner.
- [x] Protocol, reference docs, and backlog-facing tracked docs no longer
  promise `loaf context pack` or direct projection reads.
- [x] ADR-0004 carries an explicit supersession note rather than rewritten
  history.
- [x] Future work requires a fresh consumer-driven spec.

### Validation

`bunx vitest run tests/scripts/docs-runtime-boundary.test.ts tests/scripts/protocol-contract-gates.test.ts tests/scripts/skills-semantic-gate.test.ts`

### Migration and recovery

No command or journal data ever shipped for this contract. Removal has no data
migration.

### Evidence

- Deleted the unreferenced runtime schema and removed its live
  machine-contract and dissolution-manifest ownership rows.
- Protocol and current reference docs now route ephemeral reads through
  sanctioned CLI queries and persistent transfer through handoff/resume.
- ADR-0004 keeps the historical A8 decision with an explicit 2026-07-27
  supersession note and a consumer-driven re-entry condition.
- The focused docs/protocol/skill suites passed (13 tests), together with
  typecheck and lint.

## A14 — Skill-driven orchestration journey gate

**Status:** [x] Complete
**Commit subject:** `test(skills): exercise the supervised lifecycle journey`

### Destination

Add an executable skill-to-CLI journey that verifies the in-repository
orchestration layer uses public commands, respects machine routing, and stops at
real human-owned decisions.

### Decision

The repository plugin is not a future separate codebase. “Unattended” means it
may continue through non-blocking machine work without redundant confirmation;
it never synthesizes gate decisions, deliver/archive/abandon choices, waivers,
or manual attestations. `LOAF_USER` identifies an actor and does not grant
approval.

### Non-goals

- No orchestration policy inside stable core.
- No bypass of human facts.
- No direct `.loaf/<feature>` writes or raw `state.json` truth reads from
  skills.

### Acceptance criteria

- [x] `CLAUDE.md`, `README.md`, and `skills/CONTRACT.md` describe the
  in-repository plugin boundary consistently.
- [x] A journey test follows skill instructions through representative public
  CLI transitions and checks the same next action as core.
- [x] The journey stops at each human-owned decision with an observable pending
  action.
- [x] Static semantic gates reject direct artifact mutation and stale command
  references.
- [x] Human-gated and non-blocking actions are explicitly classified.

### Validation

`bunx vitest run tests/scripts/skills-semantic-gate.test.ts tests/scripts/claude-semantic-gate.test.ts tests/core/e2e-lifecycle.test.ts`

### Migration and recovery

Skills and docs change together. Kernel actor/gate rules remain authoritative.

### Evidence

- Repository guidance now identifies `skills/` as the live orchestration
  plugin while keeping its policy out of stable core.
- The supervision table distinguishes non-blocking machine work, human
  decisions, and human facts; `LOAF_USER` is explicitly identity-only.
- The next-driven standard lifecycle test records the exact spec-lock,
  verify-accept, and deliver stops while following every non-blocking route.
- Skill and Claude semantic gates plus the full lifecycle suite passed,
  together with typecheck and lint.

**Independent-audit correction:** the original journey did not read
`skills/**`; it renamed an existing core lifecycle test and repeated three
already-asserted command strings. A21 replaces that false evidence with a
parsed skill supervision contract that authorizes the executed route loop.

## A15 — Mutation/rebuild replay equivalence

**Status:** [x] Complete
**Commit subject:** `test(core): prove projection rebuild equivalence`

### Destination

Prove that snapshots written after normal mutation and snapshots rebuilt by
doctor from the same journal are byte-equivalent through the shared serializer.

### Non-goals

- No projection-format change unless the test exposes a real mismatch.
- No normalization that hides meaningful bytes.

### Acceptance criteria

- [x] A representative lifecycle produces every currently supported snapshot
  leaf through normal mutation.
- [x] The test captures bytes, removes derived leaves, runs doctor rebuild, and
  compares every regenerated leaf.
- [x] Any intentionally volatile metadata is independently specified and
  compared by its real contract, not erased wholesale.
- [x] A reversible negative control proves the test detects serializer drift.

### Validation

`bunx vitest run tests/core/doctor-rebuild.test.ts tests/core/replay.test.ts tests/core/projection-writer.test.ts`

### Migration and recovery

Test-only unless a mismatch is found. Any resulting fix stays within the same
task because equivalence is its acceptance criterion.

### Evidence

- A real `mutateBatch` lifecycle materializes all five JSON projections plus
  `_meta.json`; the test captures their exact bytes, removes them, and rebuilds
  through the public doctor command.
- All data leaves are byte-identical after replay. `_meta.json` is compared by
  its full stable contract while independently asserting the intentionally
  volatile `written_at` timestamp advances monotonically.
- A reversible one-byte state projection mutation is detected by the same
  comparator before the original bytes are restored.
- Doctor, replay, and projection-writer suites passed (59 tests), together
  with typecheck and lint.

**Independent-audit correction:** the original fixture left evidence, findings,
and pending empty, omitted `lessons.md`, and its one-byte file edit proved only
the byte comparator. A20 supersedes this evidence with a representative,
non-empty lifecycle and a negative control that rebuilds through the real
doctor publication path.

## A16 — TUI/Board status semantics and F-026 disposition

**Status:** [x] Complete
**Commit subject:** `refactor(cli): share session status semantics`

### Destination

Share the one non-trivial status classification already duplicated by the TUI
and Board, expose enough read-only pending identity to distinguish a human gate
from an ordinary question, and retire stale F-026 promises that would create a
second mutation or freshness-policy owner.

### Decision

Keep mutation in explicit CLI commands. Enter already opens detail and `a`
already toggles active/all. Projection detail already reports stale/missing
state and `r` already performs an explicit reload. The TUI will not gain `d`,
an implicit archive hotkey, automatic polling, or a second
registry-vs-runtime-heartbeat freshness algorithm. Gate-vs-question display is
in scope because the live pending kind already carries that meaning.

### Non-goals

- No TUI/Board full view-model extraction; HTTP/HTML and Ink remain different
  presentation adapters.
- No archive/deliver/gate mutation from a single keypress.
- No TUI auto-refresh or registry heartbeat scanner.
- No separate `d` alias or pending popup when Enter detail already exposes the
  same information.

### Acceptance criteria

- [x] One shared pure module owns `done > blocked > running > idle` session
  status classification for both TUI and Board.
- [x] `SessionRow` exposes the pending-head kind as additive display data.
- [x] Gate/profile decisions render distinctly from ask/spec/finding pending
  work without becoming gate authority.
- [x] Pending queue depth behavior remains unchanged.
- [x] Help text and tests reflect existing Enter/detail, `a` active/all, and
  `r` manual reload behavior.
- [x] Protocol/ADR supersession notes explicitly retire `d`, pending popup,
  archive hotkey, auto-polling, and heartbeat-stale promises.
- [x] Full TUI/Board detail-model extraction remains closed until at least two
  independently changing consumers repeat another non-trivial policy.

### Validation

`bunx vitest run tests/cli/sessions-list.test.ts tests/cli/tui-list-model.test.ts tests/cli/tui-detail-model.test.ts tests/cli/tui-end-to-end.test.ts tests/cli/tui-chrome.test.ts tests/cli/board-model.test.ts tests/cli/board-server.test.ts`

### Migration and recovery

`SessionRow` JSON gains an additive read-only field. Status priority and
existing keys remain stable.

### Evidence

`src/cli/session-status.ts` now owns the shared status priority and
pending-head display class. Registry rows carry the additive head kind; TUI
renders the localized kind while Board exposes and renders the decision versus
question class. Board automatic polling was removed, list help now documents
Enter/detail, active/all, and manual reload, and protocol plus ADR-0003 record
the F-026 supersession. Validation: TypeScript typecheck; 120 focused
TUI/Board tests; Biome lint; production bundle build.

## A17 — Executable contract-drift guards

**Status:** [x] Complete
**Commit subject:** `test(architecture): bind declarative contracts to runtime`

### Destination

Turn high-risk declarative comments/contracts into executable assertions or
delete them when they merely duplicate implementation.

### Non-goals

- No broad prose rewrite.
- No tests that pin incidental source line numbers or implementation spelling.

### Acceptance criteria

- [x] Concurrency contract assertions cover the implemented lease/outcome
  semantics rather than string snapshots alone.
- [x] Static ownership gates cover Attachment authority, CommandMutator, scope
  closure, and no-live-context-pack boundaries.
- [x] Known stale comments in projection writer, profile/doctor,
  CommandMutator, and journal mutation are corrected or deleted.
- [x] `docs/index.html` no longer contradicts journal proof, feature lease,
  reconcile, or skill ownership.
- [x] Each guard fails under a targeted negative control.

### Validation

`bunx vitest run tests/scripts/architecture-ownership-gates.test.ts tests/scripts/docs-runtime-boundary.test.ts tests/scripts/protocol-contract-gates.test.ts tests/scripts/skills-semantic-gate.test.ts tests/scripts/claude-semantic-gate.test.ts`
`bun run verify:codegen`

### Migration and recovery

Tests and comments only unless a guard exposes an in-scope live contradiction.

### Evidence

Runtime-owned constants now bind the declarative feature-lease timeout,
commit-state vocabulary, and post-append committed-failure codes; committed
failure types cannot widen without changing that owner. Static gates enforce
attachment dereference, CommandMutator, scope-closure fact construction, and
retired context-pack ownership, while targeted injections prove every rule is
fault-sensitive. The same gate rejects known stale architecture comments and
the superseded `docs/index.html` claims. It also exposed and closed the
pre-existing `loaf next` local-option drift while preserving global
`--session` dispatch. Validation: typecheck; 117 focused runtime/contract
tests; codegen verification; Biome lint; production bundle build.

**Independent-audit correction:** A17's stale-comment rule was a four-phrase
snapshot, not a class-level drift guard. A22 removes it and instead binds the
declared lease mechanism, error-code set, and deferred recovery status directly
to runtime owners with targeted negative controls.

## A18 — Freshness ledger and abstraction triggers

**Status:** [x] Complete
**Commit subject:** `docs(architecture): close stale debt claims`

### Destination

Record the current state of previously landed, stale, or deliberately
unextracted proposals so future audits do not reopen them from obsolete local
ledgers.

### Required decisions

- CLI command-group split is landed; it is not the old W9 preflight work.
- Replay sequence monotonicity and spec-lock enforcement are landed.
- `.audit/findings.json`, old root audit reports, and ignored backlog/trio files
  are not current repository truth.
- Context pack is retired by A13.
- TUI F-026 is superseded by A16's read-only boundary.
- TUI and Board share only the status classification proven duplicated by A16.
  A broader read model is reconsidered only after at least two independently
  changing consumers repeat another non-trivial stale/detail/pending policy.

### Non-goals

- Do not edit, delete, or stage user-owned untracked audit files.
- Do not create an abstraction solely to close an audit checkbox.

### Acceptance criteria

- [x] A tracked architecture note or existing current docs contain all required
  decisions and trigger conditions.
- [x] Tracked documentation does not cite ignored local files as authoritative.
- [x] `git ls-files` confirms retired root planning/audit files are not tracked.
- [x] No unsupported “implemented” claim remains in current docs.

### Validation

`bunx vitest run tests/scripts/docs-runtime-boundary.test.ts`
`git status --short`

### Migration and recovery

Documentation only. Local ignored files remain untouched.

### Evidence

`docs/references/architecture-freshness-ledger.md` records the landed CLI split
versus distinct W9 preflight concern, replay/spec-lock evidence, retired local
ledger authority, context-pack and F-026 dispositions, and the two-consumer
trigger for any broader TUI/Board model. Current CLAUDE and E2E guidance no
longer requires ignored root plans; dated tech-debt and W8 documents are marked
historical or implemented with live owners. `git ls-files` returned no retired
root planning/audit path. Documentation boundary tests passed, and the
pre-existing untracked/ignored files remained untouched and unstaged.

## A19 — Final distribution and history audit

**Status:** [x] Complete
**Commit subject:** `chore(architecture): close the deepening program`

### Destination

Close the ledger only after every prior task satisfies its acceptance criteria
and the local commit sequence is independently auditable.

### Non-goals

- No version bump, tag, push, or release.
- No unrelated cleanup discovered during final verification.

### Acceptance criteria

- [x] A02–A18 are marked complete with literal validation evidence.
- [x] `bun run check` passes from the hermetic root test tree.
- [x] `bun run ga:pack-smoke` passes. `bun run ga:consistency` was executed
  and correctly refused release parity at `WORKTREE_DIRTY`; hiding the
  baseline user-owned untracked paths and publishing HEAD to `origin/main`
  are both outside this program's explicit non-goals.
- [x] `dist/cli.mjs` matches the final source.
- [x] Git history contains one task-intent commit per task and no user-owned
  path. It is not independently full-suite-bisectable across A12–A18: A12's
  stale public schema snapshot was repaired by A19 and is disclosed below.
- [x] `git status --short --branch` contains only the pre-existing user-owned
  untracked paths listed in the baseline.

### Validation

`bun run check`
`bun run ga:pack-smoke`
`bun run ga:consistency`
`git status --short --branch`
`git log --oneline 2d0840c..HEAD`

### Migration and recovery

This is the audit/ledger commit. Individual optimizations remain independently
revertible subject to their recorded compatibility notes.

### Evidence

The first full check exposed one stale public-schema snapshot left by A12:
`artifact:tasks` still expected task-step `evidence_refs`. The targeted
snapshot update removed only that retired property and its required marker;
the focused schema suite then passed 30/30. The repeated hermetic
`bun run check` passed lint, typecheck, all 176 test files / 2,714 tests, and
the production build. `bun run ga:pack-smoke` exited 0. The release-parity-only
`ga:consistency` gate exited 1 at `WORKTREE_DIRTY`, as it counts the four
baseline user-owned untracked paths; even if hidden, this approved local
program is intentionally ahead of unpushed `origin/main`, and A19 forbids
push/release actions. The final build left no `dist/cli.mjs` diff. Before the
A19 audit commit, `git log 2d0840c..HEAD` contained exactly 19 scoped A00–A18
commits, and `git status --short --branch` contained no tracked change plus
only `.agents/skills/`, `.audit/`, `.orch/`, and
`audit-report-2026-07-15.md`.

The omission means commits `153ebaa`, `496c6b5`, `e82a25e`, `7bd92af`,
`3ce7780`, and `e27d05f` did not pass `bun run test`; `8c98379` is the first
commit that repaired the snapshot. The history therefore preserves one
task-intent commit per ledger item but is not full-suite green at every
intermediate revision. A23 intentionally corrects the evidence rather than
rewriting already reviewed local commits.

## A20 — Fault-sensitive mutation/rebuild equivalence proof

**Status:** [x] Complete
**Commit subject:** `test(core): strengthen rebuild equivalence oracle`

### Destination

Replace A15's false-positive evidence with a representative production
mutation fixture that exercises every doctor-rebuilt projection and a negative
control that passes through the actual replay/publication path.

### Non-goals

- No production serializer fork or test-only production branch.
- No claim that `spec.md` is doctor-rebuilt; it is not part of
  `writeProjections`.
- No normalization that hides meaningful bytes.

### Acceptance criteria

- [x] Normal mutation produces non-empty tasks, evidence, findings, pending,
  and lessons projections.
- [x] The fixture promotes an oversized long-text field to an authorized
  sidecar before projection.
- [x] The equivalence proof deletes and compares every projection regenerated
  by doctor, including top-level `lessons.md`.
- [x] Stable `_meta.json` fields are compared while `written_at` is checked by
  its monotonic contract.
- [x] A reversible journal-fact fault is rebuilt through the public doctor path
  and the comparator identifies the exact divergent projection.
- [x] Restoring the journal and rebuilding produces byte-identical data
  projections.

### Validation

`bunx vitest run tests/core/doctor-rebuild.test.ts tests/core/replay.test.ts tests/core/projection-writer.test.ts`
`bun run typecheck`
`bun run lint`

### Migration and recovery

Test and ledger correction only. Reverting this commit restores the weaker
oracle without changing runtime or persisted data.

### Evidence

The representative fixture now reaches `EXECUTE.work` and records a task,
sidecar-backed evidence, an open finding, an unresolved pending question, and a
lesson. Mutation creates all JSON leaves plus `lessons.md`. The negative
control changes one journal finding, removes every derived projection, invokes
public `doctor --rebuild`, and detects only `findings.json`; after restoring the
journal, the real equivalence comparison is byte-identical. The 59 focused
doctor/replay/projection tests passed.

## A21 — Executable skill-to-CLI journey

**Status:** [x] Complete
**Commit subject:** `test(skills): drive lifecycle from skill contract`

### Destination

Make the supervised journey consume the checked-in skill contract so changing
the orchestration instructions changes or fails the executed CLI journey.

### Acceptance criteria

- [x] The test reads the live `skills/` contract rather than merely naming a
  core lifecycle test after it.
- [x] Machine-readable skill instructions classify non-blocking routes and
  human-owned stops without duplicating kernel transition policy.
- [x] The journey executes representative public CLI commands derived from
  that contract and compares each route to `loaf next`.
- [x] Removing or corrupting a required skill route fails a targeted negative
  control.
- [x] The old duplicate `humanStops` assertion is removed.

### Validation

`bunx vitest run tests/scripts/skills-semantic-gate.test.ts tests/scripts/claude-semantic-gate.test.ts`
`bunx vitest run tests/core/e2e-lifecycle.test.ts -t "supervised skill journey"`
`bun run typecheck`
`bun run lint`

### Migration and recovery

Test/skill contract only; core routing remains authoritative.

### Evidence

`skills/run/SKILL.md` now publishes a delimited JSON ownership projection:
`loaf next` remains the route source, while owner verbs and human command
prefixes classify automatic work versus stops. The E2E test parses that live
block, derives its route invocation from it, classifies every observed advice,
and executes automatic commands from the kernel-returned public command. It
observes spec-lock, verify-accept, and deliver as human stops. A targeted
negative control changes the checked-in deliver prefix and proves the same
classifier rejects the real `loaf deliver` advice. The journey passed; the two
semantic suites passed 14 tests; typecheck and lint passed.

## A22 — Truthful feature-lease contract and diagnostics

**Status:** [x] Complete
**Commit subject:** `fix(core): align feature lease diagnostics`

### Destination

Make the runtime error model, machine contract, protocol prose, and executable
guards describe the actual owner-token O_EXCL lease and its recovery behavior.

### Acceptance criteria

- [x] Dead `LOCK_HELD_BY` catalog output and nonexistent doctor cleanup advice
  are removed.
- [x] `LOCK_INVALID` remains distinct at every CLI translation boundary.
- [x] Protocol and concurrency contracts describe O_EXCL owner-token leases,
  next-writer dead-PID recovery, and fail-closed malformed leases.
- [x] Unimplemented orphan-GC/doctor flags are explicitly deferred rather than
  promised as live.
- [x] Architecture guards bind declared runtime owners/classes of behavior,
  not a one-off stale-phrase blocklist.
- [x] Targeted negative controls prove diagnostics and guards are
  fault-sensitive.

### Validation

`bunx vitest run tests/core/feature-write-lease.test.ts tests/core/journal-mutate.test.ts tests/core/doctor-rebuild.test.ts tests/cli/handoff-end-to-end.test.ts tests/scripts/architecture-ownership-gates.test.ts tests/scripts/protocol-contract-gates.test.ts`
`bun run verify:codegen`
`bun run typecheck`
`bun run lint`
`bun run build`

### Migration and recovery

No lease-file or journal migration. Error-code visibility becomes more precise;
callers already receive exit code 2.

### Evidence

The feature-lease owner now exports the canonical mechanism and error-code
set. `CONCURRENCY_INVARIANTS` consumes those owners, records orphan attachment
GC as deferred, and no longer claims flock semantics or a live
`doctor --fix`. The protocol reports contention as `LOCK_TIMEOUT`, dead-owner
recovery as a generation-checked next-writer action, and malformed state as
fail-closed `LOCK_INVALID`. The dead `LOCK_HELD_BY` catalog row and false
doctor cleanup advice are gone. Handoff, doctor rebuild, and journal mutation
preserve `FeatureWriteLeaseError.code`; malformed-lease regressions prove each
boundary emits `LOCK_INVALID` without modifying the journal, projection, or
lease. The architecture gate now checks owner-backed mechanism, error-code,
and deferred-status fields with three targeted negative controls instead of a
deleted-comment phrase list. Six focused suites passed 91 tests; codegen,
typecheck, lint, and production build passed.

## A23 — Audit evidence and supersession trail

**Status:** [x] Complete
**Commit subject:** `docs(architecture): correct audit evidence trail`

### Destination

Correct historical claims without rewriting commits: record that A12's public
schema snapshot remained stale until A19 and fix F-026 task attribution.

### Acceptance criteria

- [x] A12 evidence no longer claims its commit passed generated-artifact
  verification.
- [x] A19 states explicitly that it repaired an A12 omission and that the
  intermediate commits were not full-suite green.
- [x] The ledger distinguishes one task-intent commit from independently
  bisectable history.
- [x] ADR-0003 attributes the F-026 disposition to A16 and includes the retired
  `[d]` alias.

### Validation

`bunx vitest run tests/scripts/docs-runtime-boundary.test.ts tests/scripts/protocol-contract-gates.test.ts`

### Migration and recovery

Documentation correction only; git history is preserved.

### Evidence

A12 now records the exact generated-snapshot omission rather than claiming the
check passed. A19 names the six affected revisions, the A19 repair commit, and
the distinction between task-intent granularity and full-suite bisectability.
ADR-0003 attributes the read-only TUI/F-026 disposition to A16 and lists the
retired `[d]` alias alongside the other superseded promises. Focused
documentation and protocol contract tests passed.

## A24 — Breaking-contract release identity gate

**Status:** [x] Complete
**Commit subject:** `chore(release): gate breaking contract identity`

### Destination

Prevent publishing the A08/A10/A12 public-contract changes under an
indistinguishable `0.6.0` identity while preserving the program's no-push,
no-tag boundary.

### Acceptance criteria

- [x] The repository has a deterministic gate that detects a release carrying
  public breaking changes without an updated package identity.
- [x] The gate fails against the current `v0.6.0` baseline before remediation.
- [x] The selected local package identity and compatibility note make the
  breaking boundary observable to git consumers.
- [x] Package smoke and distribution/source parity pass with the new identity.
- [x] No push, tag, or release is performed.

### Validation

`bun run check`
`bun run verify:release-identity`
`bunx vitest run tests/scripts/public-contract-version-check.test.ts`
`bun run ga:pack-smoke`
`bun run ga:consistency`

### Migration and recovery

Local release preparation only. Publication remains a separate explicitly
authorized action.

### Evidence

`docs/release-identity.json` binds the `v0.6.0` baseline, the local `0.7.0`
target, and the A08/A10/A12 breaking contracts. The new release-identity gate
reads the tagged baseline package, refuses an unchanged identity, and enforces
a 0.x minor successor for declared breaking changes. Its negative controls
reject both unchanged `0.6.0` and patch-only `0.6.1`; `0.7.0` passes. The
package and changelog now expose `0.7.0`, and the tracked distribution was
rebuilt so `loaf --version` and new-session `loaf_version_required` agree.
Focused tests, release-identity verification, full check, package smoke, and
distribution/source parity passed. GA consistency remains expected to stop at
the unpublished-worktree/origin boundary; no push, tag, or release occurred.
