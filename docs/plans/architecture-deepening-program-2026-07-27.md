# Architecture deepening program

**Status:** APPROVED / IN PROGRESS
**Approved:** 2026-07-27
**Owner:** loaf-cli maintainers
**Execution rule:** one completed optimization or refactor per local commit
**Publication boundary:** local commits only; no push, tag, release, or version bump

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
| A03 | Implement | Attachment authority module | A02 | [ ] Pending |
| A04 | Implement | Feature write lease | A03 | [ ] Pending |
| A05 | Implement | Explicit mutation commit outcomes | A04 | [ ] Pending |
| A06 | Implement | Deep CommandMutator boundary | A05 | [ ] Pending |
| A07 | Implement | Unified CLI input ingestion | A01 | [ ] Pending |
| A08 | Implement | Strict CLI-owned task intake | A06, A07 | [ ] Pending |
| A09 | Implement | Canonical scope-closure fact policy | A03 | [ ] Pending |
| A10 | Retire | Phantom reconcile execution contract | A09 | [ ] Pending |
| A11 | Implement | Canonical lifecycle advice | A06, A10 | [ ] Pending |
| A12 | Retire | Live task-step `evidence_refs` contract | A08 | [ ] Pending |
| A13 | Retire | Dead context-pack contract | A01 | [ ] Pending |
| A14 | Implement | Skill-driven orchestration journey gate | A11, A13 | [ ] Pending |
| A15 | Implement | Mutation/rebuild replay equivalence | A04 | [ ] Pending |
| A16 | Implement/close | TUI observability and F-026 disposition | A11 | [ ] Pending |
| A17 | Implement | Executable contract-drift guards | A04–A16 | [ ] Pending |
| A18 | Close | Freshness ledger and abstraction triggers | A17 | [ ] Pending |
| A19 | Verify | Final distribution and history audit | A02–A18 | [ ] Pending |

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

**Status:** [ ] Pending
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

- [ ] Lesson, scope, and migration consumers no longer perform raw
  `path.join(featureDir, ref.path)` plus local hash logic.
- [ ] A ref's bucket must match the owning journal `entry_id`.
- [ ] Realpath containment rejects a file or intermediate directory symlink
  that resolves outside the owning entry bucket.
- [ ] Size and SHA-256 verification are identical for all readers, including
  migration.
- [ ] Sidecar promotion cannot write through a pre-existing escaping symlink.
- [ ] Existing happy-path sidecars and migration rehydration remain
  byte-compatible.

### Validation

`bunx vitest run tests/core/sidecar.test.ts tests/core/lessons-projection.test.ts tests/core/scope-recorded.test.ts tests/core/v0.0.x-migration.test.ts`

### Migration and recovery

Canonical sidecars need no migration. Unauthorized or corrupt historical refs
fail closed with an observable integrity error; doctor must not copy their
content.

### Evidence

Pending.

## A04 — Feature write lease

**Status:** [ ] Pending
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

- [ ] A dedicated `feature-write-lease` module owns acquire, bounded retry,
  stale recovery, ownership verification, and release.
- [ ] Lease metadata is mode `0600` and contains an owner token plus PID.
- [ ] `mutateBatch`, doctor projection rebuild, handoff feature-local writes,
  and migration canonical writes either use the lease or carry an explicit
  evidence-backed exemption.
- [ ] Dry-run validates against a stable tail under the same lease.
- [ ] SIGINT/error paths release only the current owner.
- [ ] Runtime lock ordering is documented and deterministically tested.
- [ ] `CONCURRENCY_INVARIANTS` and ADR/protocol text match the implementation.

### Validation

`bunx vitest run tests/core/journal-mutate.test.ts tests/core/doctor-rebuild.test.ts tests/cli/handoff-end-to-end.test.ts tests/core/v0.0.x-migration.test.ts tests/core/session-runtime.test.ts`
`bun run verify:codegen`

### Migration and recovery

The first new writer can reclaim an old zero-byte MVP lock only under an
explicit compatibility rule. Live owner leases are never stolen. Recovery
instructions must distinguish old empty locks, malformed leases, and verifiably
dead owners.

### Evidence

Pending.

## A05 — Explicit mutation commit outcomes

**Status:** [ ] Pending
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

- [ ] The result union has an explicit commit-state discriminant.
- [ ] All post-append projection failures return the committed variant.
- [ ] `executeClosureTransaction` no longer probes arbitrary detail data or
  rereads the journal merely to discover whether commit occurred.
- [ ] CLI routing preserves the original diagnostic and the no-retry recovery
  guidance.
- [ ] Fault-injection tests distinguish pre-commit and post-commit failures.

### Validation

`bunx vitest run tests/core/journal-mutate.test.ts tests/core/mutate-step8.test.ts tests/core/execute-closure-transaction.test.ts tests/core/mutate-registry.test.ts`

### Migration and recovery

This is a TypeScript/API result change, not a journal change. Callers migrate
exhaustively in the same commit.

### Evidence

Pending.

## A06 — Deep CommandMutator boundary

**Status:** [ ] Pending
**Commit subject:** `refactor(cli): make CommandMutator the mutation adapter`

### Destination

Make one CLI adapter own mutation context construction, entry/batch stamping,
dry-run behavior, commit-aware failure routing, and success advisories.

### Non-goals

- `executeClosureTransaction` remains a core transaction because it couples the
  session-runtime lock and journal commit point.
- No user-facing command behavior change.

### Acceptance criteria

- [ ] CommandMutator supports single entries, pre-built batches, and an
  explicit per-entry timestamp strategy.
- [ ] `src/cli/commands/**` has no direct `mutate`/`mutateBatch` import.
- [ ] Spec submit/edit and sponsored task authoring use the same adapter.
- [ ] Legacy bypass helpers, allowlists, and stale bypass-count comments are
  deleted.
- [ ] Static dry-run and registry-context gates enforce the new boundary.

### Validation

`bunx vitest run tests/scripts/sc6c-dry-run-gate.test.ts tests/scripts/sc7-registry-ctx-gate.test.ts tests/cli/spec-submit-batch.test.ts tests/core/sponsored-tasks-amended.test.ts`

### Migration and recovery

Behavior-preserving preparatory refactor. Revert is local and does not change
persistent data.

### Evidence

Pending.

## A07 — Unified CLI input ingestion

**Status:** [ ] Pending
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

- [ ] Commands call one ingestion API instead of composing `input-source`,
  `input-read`, and `stdin` policy themselves.
- [ ] No command repeats the stdin-is-TTY rejection branch.
- [ ] File, inline JSON, stdin, `-`, no-input, malformed JSON, and read failure
  semantics remain stable.
- [ ] Representative spec/tasks/evidence help and errors are generated from the
  same modality declaration.
- [ ] The three superseded shallow modules are deleted or reduced to explicit
  adapters with a single owner.

### Validation

`bunx vitest run tests/cli/input-read.test.ts tests/core/spec-input-modality.test.ts tests/core/tasks-input-modality.test.ts tests/core/evidence-input-modality.test.ts tests/core/ambient-input-gate.test.ts`

### Migration and recovery

Internal refactor. Public input behavior is characterized before extraction.

### Evidence

Pending.

## A08 — Strict CLI-owned task intake

**Status:** [ ] Pending
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

- [ ] `TasksSubmitInput` is strict and rejects caller-owned IDs, status,
  execution progress, envelope fields, duplicate local keys, and unknown keys.
- [ ] Dependency refs distinguish existing `task_id` from same-batch
  `local_key`.
- [ ] Two-pass allocation resolves forward refs deterministically under the
  feature lease.
- [ ] `tasks add` uses the same semantic dependency-ref contract.
- [ ] The resulting journal payload remains the existing full task shape and
  replays on the prior reader.
- [ ] `tasks submit --schema` describes the real authoring contract.
- [ ] Migration policy is explicit: a bounded legacy full-input compatibility
  path is either implemented with a deprecation signal or intentionally
  rejected as the approved breaking change.

### Validation

`bunx vitest run tests/core/tasks-input-modality.test.ts tests/cli/schema-emit-end-to-end.test.ts tests/core/task-graph-admission.test.ts tests/cli/sc11-end-to-end.test.ts tests/core/replay.test.ts`
`bun run verify:codegen`

### Migration and recovery

Historical journal entries remain readable. The authoring migration is
input-only and must return the allocated `local_key -> task_id` map.

### Evidence

Pending.

## A09 — Canonical scope-closure fact policy

**Status:** [ ] Pending
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

- [ ] The policy validates adjacency, one marker and one closure per batch,
  batch indexes/counts, actor/source state, and marker iteration equal to the
  current/closing iteration.
- [ ] A wrong-iteration marker cannot poison a future iteration's duplicate
  guard.
- [ ] Writer, commit-proof, and projection paths use the same closure-fact
  parser instead of separate predicates.
- [ ] Invalid same-batch/non-adjacent, wrong-index/count, wrong-iteration, and
  duplicate histories have negative tests.
- [ ] Valid historical closures still derive canonical unioned actual scope;
  missing markers remain observable as `ACTUAL_SCOPE_HISTORY_INCOMPLETE`.

### Validation

`bunx vitest run tests/core/scope-recorded.test.ts tests/core/reconcile-scope.test.ts tests/core/execute-closure-transaction.test.ts tests/core/journal-mutate.test.ts`

### Migration and recovery

Historical valid records remain valid. Already-corrupt histories fail
observably; they are not silently reinterpreted.

### Evidence

Pending.

## A10 — Phantom reconcile execution contract

**Status:** [ ] Pending
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

- [ ] New lifecycle routes never require or enter `SETTLE.reconcile`.
- [ ] `loaf settle` advances an accepted deep flow to the next real settle
  state.
- [ ] Historical journals containing `SETTLE.reconcile` still replay and can
  advance out through a compatibility edge.
- [ ] Machine contracts, skills, protocol, and docs do not claim a current
  reconcile writer or exit gate.
- [ ] `ReconcileJson` is clearly compatibility-only or removed from live
  projection loading while legacy validation remains isolated.
- [ ] No gate reads reconcile data.

### Validation

`bunx vitest run tests/core/machine-transition.test.ts tests/core/e2e-lifecycle.test.ts tests/core/reconcile-scope.test.ts tests/cli/next-advisory.test.ts tests/scripts/protocol-contract-gates.test.ts`
`bun run verify:codegen`

### Migration and recovery

This is a forward lifecycle change with tolerant historical replay. A rollback
can restore the new transition target because no new persistent kind is added.

### Evidence

Pending.

## A11 — Canonical lifecycle advice

**Status:** [ ] Pending
**Commit subject:** `refactor(cli): derive lifecycle advice from core routing`

### Destination

Core owns pure next-action routing facts. One CLI adapter owns selector
injection, i18n, command rendering, and success advisory presentation.

### Non-goals

- No workflow policy in presentation modules.
- No i18n dependency from stable core.
- No automatic execution of the advised command.

### Acceptance criteria

- [ ] `loaf next` and post-mutation advisories consume the same routing result.
- [ ] Applicable verify lanes, pending head, settle/deliver branch, and
  feature/session selectors agree across entry points.
- [ ] Command files no longer hardcode routes already owned by core.
- [ ] Core tests cover routing; CLI tests cover rendering and selector
  injection separately.

### Validation

`bunx vitest run tests/core/next-action.test.ts tests/cli/next-advisory.test.ts tests/core/e2e-lifecycle.test.ts tests/cli/sc11-end-to-end.test.ts`

### Migration and recovery

Behavior-preserving except for proven advisory contradictions, which are fixed
to match the current machine.

### Evidence

Pending.

## A12 — Live task-step `evidence_refs` contract

**Status:** [ ] Pending
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

- [ ] New task authoring/projections do not expose a writable proof relation in
  task execution steps.
- [ ] Legacy task payloads containing `evidence_refs` still replay.
- [ ] A done task with only legacy refs and no matching evidence ledger entry
  fails proof.
- [ ] Sponsored amend cannot forge proof or delete authoritative evidence.
- [ ] History/amend code no longer carries dead live-field complexity.
- [ ] Protocol and schema docs identify the legacy-read boundary.

### Validation

`bunx vitest run tests/core/task-proof.test.ts tests/core/verify-min.test.ts tests/core/gates/verify-accept-check.test.ts tests/core/sponsored-tasks-amended.test.ts tests/core/replay.test.ts`

### Migration and recovery

Use a compatibility parser/adapter for old task bodies; emit the narrower live
projection for new sessions. No journal rewrite.

### Evidence

Pending.

## A13 — Dead context-pack contract

**Status:** [ ] Pending
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

- [ ] `src/cli/context-pack-schema.ts` is deleted.
- [ ] No live machine-contract index points to a dead owner.
- [ ] Protocol, reference docs, and backlog-facing tracked docs no longer
  promise `loaf context pack` or direct projection reads.
- [ ] ADR-0004 carries an explicit supersession note rather than rewritten
  history.
- [ ] Future work requires a fresh consumer-driven spec.

### Validation

`bunx vitest run tests/scripts/docs-runtime-boundary.test.ts tests/scripts/protocol-contract-gates.test.ts tests/scripts/skills-semantic-gate.test.ts`

### Migration and recovery

No command or journal data ever shipped for this contract. Removal has no data
migration.

### Evidence

Pending.

## A14 — Skill-driven orchestration journey gate

**Status:** [ ] Pending
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

- [ ] `CLAUDE.md`, `README.md`, and `skills/CONTRACT.md` describe the
  in-repository plugin boundary consistently.
- [ ] A journey test follows skill instructions through representative public
  CLI transitions and checks the same next action as core.
- [ ] The journey stops at each human-owned decision with an observable pending
  action.
- [ ] Static semantic gates reject direct artifact mutation and stale command
  references.
- [ ] Human-gated and non-blocking actions are explicitly classified.

### Validation

`bunx vitest run tests/scripts/skills-semantic-gate.test.ts tests/scripts/claude-semantic-gate.test.ts tests/core/e2e-lifecycle.test.ts`

### Migration and recovery

Skills and docs change together. Kernel actor/gate rules remain authoritative.

### Evidence

Pending.

## A15 — Mutation/rebuild replay equivalence

**Status:** [ ] Pending
**Commit subject:** `test(core): prove projection rebuild equivalence`

### Destination

Prove that snapshots written after normal mutation and snapshots rebuilt by
doctor from the same journal are byte-equivalent through the shared serializer.

### Non-goals

- No projection-format change unless the test exposes a real mismatch.
- No normalization that hides meaningful bytes.

### Acceptance criteria

- [ ] A representative lifecycle produces every currently supported snapshot
  leaf through normal mutation.
- [ ] The test captures bytes, removes derived leaves, runs doctor rebuild, and
  compares every regenerated leaf.
- [ ] Any intentionally volatile metadata is independently specified and
  compared by its real contract, not erased wholesale.
- [ ] A reversible negative control proves the test detects serializer drift.

### Validation

`bunx vitest run tests/core/doctor-rebuild.test.ts tests/core/replay.test.ts tests/core/projection-writer.test.ts`

### Migration and recovery

Test-only unless a mismatch is found. Any resulting fix stays within the same
task because equivalence is its acceptance criterion.

### Evidence

Pending.

## A16 — TUI/Board status semantics and F-026 disposition

**Status:** [ ] Pending
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

- [ ] One shared pure module owns `done > blocked > running > idle` session
  status classification for both TUI and Board.
- [ ] `SessionRow` exposes the pending-head kind as additive display data.
- [ ] Gate/profile decisions render distinctly from ask/spec/finding pending
  work without becoming gate authority.
- [ ] Pending queue depth behavior remains unchanged.
- [ ] Help text and tests reflect existing Enter/detail, `a` active/all, and
  `r` manual reload behavior.
- [ ] Protocol/ADR supersession notes explicitly retire `d`, pending popup,
  archive hotkey, auto-polling, and heartbeat-stale promises.
- [ ] Full TUI/Board detail-model extraction remains closed until at least two
  independently changing consumers repeat another non-trivial policy.

### Validation

`bunx vitest run tests/cli/sessions-list.test.ts tests/cli/tui-list-model.test.ts tests/cli/tui-detail-model.test.ts tests/cli/tui-end-to-end.test.ts tests/cli/tui-chrome.test.ts tests/cli/board-model.test.ts tests/cli/board-server.test.ts`

### Migration and recovery

`SessionRow` JSON gains an additive read-only field. Status priority and
existing keys remain stable.

### Evidence

Pending.

## A17 — Executable contract-drift guards

**Status:** [ ] Pending
**Commit subject:** `test(architecture): bind declarative contracts to runtime`

### Destination

Turn high-risk declarative comments/contracts into executable assertions or
delete them when they merely duplicate implementation.

### Non-goals

- No broad prose rewrite.
- No tests that pin incidental source line numbers or implementation spelling.

### Acceptance criteria

- [ ] Concurrency contract assertions cover the implemented lease/outcome
  semantics rather than string snapshots alone.
- [ ] Static ownership gates cover Attachment authority, CommandMutator, scope
  closure, and no-live-context-pack boundaries.
- [ ] Known stale comments in projection writer, profile/doctor,
  CommandMutator, and journal mutation are corrected or deleted.
- [ ] `docs/index.html` no longer contradicts journal proof, feature lease,
  reconcile, or skill ownership.
- [ ] Each guard fails under a targeted negative control.

### Validation

`bunx vitest run tests/scripts/docs-runtime-boundary.test.ts tests/scripts/protocol-contract-gates.test.ts tests/scripts/skills-semantic-gate.test.ts tests/scripts/claude-semantic-gate.test.ts`
`bun run verify:codegen`

### Migration and recovery

Tests and comments only unless a guard exposes an in-scope live contradiction.

### Evidence

Pending.

## A18 — Freshness ledger and abstraction triggers

**Status:** [ ] Pending
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

- [ ] A tracked architecture note or existing current docs contain all required
  decisions and trigger conditions.
- [ ] Tracked documentation does not cite ignored local files as authoritative.
- [ ] `git ls-files` confirms retired root planning/audit files are not tracked.
- [ ] No unsupported “implemented” claim remains in current docs.

### Validation

`bunx vitest run tests/scripts/docs-runtime-boundary.test.ts`
`git status --short`

### Migration and recovery

Documentation only. Local ignored files remain untouched.

### Evidence

Pending.

## A19 — Final distribution and history audit

**Status:** [ ] Pending
**Commit subject:** `chore(architecture): close the deepening program`

### Destination

Close the ledger only after every prior task satisfies its acceptance criteria
and the local commit sequence is independently auditable.

### Non-goals

- No version bump, tag, push, or release.
- No unrelated cleanup discovered during final verification.

### Acceptance criteria

- [ ] A02–A18 are marked complete with literal validation evidence.
- [ ] `bun run check` passes from the hermetic root test tree.
- [ ] `bun run ga:pack-smoke` and `bun run ga:consistency` pass where they do
  not require a release tag.
- [ ] `dist/cli.mjs` matches the final source.
- [ ] Git history contains one scoped commit per task and no user-owned path.
- [ ] `git status --short --branch` contains only the pre-existing user-owned
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

Pending.
