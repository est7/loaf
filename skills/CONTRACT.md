# loaf-skill — contract with loaf-cli

> **Status**: design intent. `loaf-skill` is the middle layer in the
> three-tier architecture (`docs/protocol.md` §10 CLI Surface +
> [`docs/adr/0005-truth-model-single-typed-journal.md`](../docs/adr/0005-truth-model-single-typed-journal.md)):
>
> ```
> loaf-cli (protocol core, this repo)
>   → loaf-skill (workflow orchestration, separate codebase)
>     → 3rd-party workflow skill (domain dialogue)
> ```
>
> The thinker capabilities described below are deliberately **NOT** implemented
> in loaf-cli. They are future `loaf-skill` responsibilities, recorded here so
> the loaf-cli ↔ loaf-skill boundary stays explicit. Kernel validators named
> below are landed loaf-cli guarantees, not orchestration behavior. When the
> loaf-skill codebase boots up (post-v0.1.0 GA of loaf-cli, which shipped
> 2026-05-25), the requirements below are the starting contract.

## Source-of-truth note (ADR-0005)

After ADR-0005, the only canonical source of truth is
`.loaf/<feature>/journal.jsonl` (one `JournalEntry` per line). The files
this contract refers to elsewhere as `tasks.json` / `evidence.jsonl` /
`findings.jsonl` are **derived projections**, not source of truth.
Concretely:

- `.loaf/<feature>/snapshots/tasks.json` (and the other four
  `snapshots/*.json` leaves) — written by `mutateBatch` after every
  journal append, consumed by read-only CLI commands. A loaf-skill
  caller MUST NOT write these directly; mutate via the corresponding
  CLI verbs (`loaf tasks submit`, `loaf evidence add`, etc.), which
  append to the journal and trigger projection writes atomically.
- Consume task/evidence/spec-lock/journal views through `loaf tasks list`,
  `loaf evidence list`, `loaf spec status`, and `loaf journal list` rather
  than parsing projection files when those command contracts answer the
  question. `journal list` is envelope-only by design; it never exposes or
  interprets per-kind payloads.
- `evidence.jsonl` / `findings.jsonl` mentioned in §4 below are
  intent-name references — the actual on-disk artifacts are
  `journal.jsonl` (append-only journal of typed entries) plus the
  projection leaves above. Anywhere this doc says "writes to
  `<artifact>.jsonl`", read it as "appends a typed `JournalEntry`
  via `loaf <command>` which the reducer projects into the named
  leaf."

## Headless human-actor precondition

A non-interactive or headless agent MUST run
`export LOAF_USER=<stable-id>` before any mutating command. The value is the
raw stable identifier, without a `human:` prefix; loaf adds the namespace.
When `LOAF_USER` is unset, human-actor mutations fail `NO_HUMAN_ACTOR` because
loaf intentionally refuses to derive the human from `git config user.email`
in automation. This fail-closed behavior prevents an agent from guessing the
human responsible for a mutation or decision.

## 1. `flatten` — hierarchical intent → DAG `tasks.json`

### Why this lives in loaf-skill

3rd-party workflow skills (Wang, GSD, openspec, ad-hoc team workflows)
naturally think in hierarchical terms: "this work breaks into 3
deliverables, each into 4-5 leaf tasks, with an integration verify on
top." `loaf-cli` expresses task relationships as a DAG via `depends_on`
only — no `parent_task_id`, no tree fields.

Without a shared helper, each workflow skill would reimplement the
hierarchical → DAG transformation. That is a `shape transformation`
(structure of `tasks.json`), not domain content, so it belongs in
loaf-skill, not in each domain skill.

### Input (free-form, skill-defined)

Hierarchical intent. Example shape (skills may use any nested form):

```text
Group G-007: OAuth refresh integration
├─ leaf  T-007a  drives REQ-OAUTH-001  (refresh token endpoint)
├─ leaf  T-007b  drives REQ-OAUTH-002  (refresh interceptor)
├─ leaf  T-007c  drives REQ-OAUTH-003  (persistent storage)
└─ integration   verify end-to-end refresh flow across the three above
```

### Output (conforms to `tasks.json` schema)

Flat `Task[]`:

- N independent leaf tasks (no inter-`depends_on`, only external if any)
- 1 integration task with
  `depends_on: [T-007a, T-007b, T-007c]`, `kind: "structural"` (or
  skill-chosen kind), and integration test list / no_test_rationale
- All members carry `labels: ["group:G-007"]`
- Integration task additionally carries `labels: ["integration"]`

### DAG authorship and kernel admission contract

`loaf-skill` is the thinker and authors the graph. Each task node carries the
existing `depends_on: TaskId[]` adjacency list; there is no separate edge
record and no schema change. loaf-cli is the kernel/validator: it validates
the submitted graph but never invents, removes, deduplicates, or redirects
dependencies.

Graph validation is **admission-only**. For a graph-changing batch,
`mutateBatch` runs `checkTaskGraph` once at Pass 1.5 against the batch-final
projected `Task[]`, after all entries have passed preflight and reducer dry-run
and before any disk write. It is never called by `apply()` or journal replay.
Replay compatibility is a policy: historical journal entries are not
retrospectively checked against graph invariants added later. Future graph
invariants gate new admissions; historical graph shapes remain replayable.

The batch-final view makes intra-batch forward references legal: an earlier
entry may depend on a task introduced by a later entry in the same atomic
batch. If graph admission fails, the entire batch is rejected before write;
no prefix is accepted.

The structured semantic error surface is:

| invariant | diagnostic | detail |
|---|---|---|
| Every reference exists in the batch-final graph | `TASK_DEP_NOT_FOUND` | `{task_id, field: "depends_on[i]", ref}` |
| A task cannot depend on itself | `TASK_DEP_SELF` | `{task_id}` |
| One adjacency list cannot repeat a dependency | `TASK_DEP_DUPLICATE` | `{task_id, ref, indexes: [i, j]}` |
| The graph is acyclic | `TASK_DEP_CYCLE` | `{cycle: ["T-A", ..., "T-A"]}` as an ordered closed path |
| A non-terminal task cannot depend on an abandoned task | `TASK_DEP_ABANDONED` | `{task_id, field: "depends_on[i]", ref, hint}`; applies to `pending`, `ready`, and `in_progress` tasks only |

On any semantic rejection, loaf-skill rewrites the authored graph through the
`amend-tasks` loop and resubmits it. The kernel reports the defect and never
repairs the graph.

### `labels[]` namespace registry (maintained by loaf-skill)

| namespace prefix | meaning | example |
|---|---|---|
| `group:<id>` | tasks belong to same workflow-defined group / flatten output | `group:G-007` |
| `integration` | integration / aggregation task (no value) | — |
| `parent-of:<id>` | **RESERVED — do not use.** Tree semantics are rejected by design. | — |
| `parent:<id>` | **RESERVED — do not use.** Same. | — |

`loaf-cli` does NOT parse `labels[]` semantically — it only validates
they are `string[]`. Convention enforcement lives in loaf-skill.

### Runtime split (mid-execution decomposition)

When a workflow skill decides an in-progress task is too large:

- Original task → `status: "abandoned"` (existing enum, no new state)
- New leaf tasks + integration task emitted via `flatten`
- Finding raised with `action: "amend-tasks"` (§1 principle 13)
- Any non-terminal dependent is amended to reference the replacement task(s);
  `TASK_DEP_ABANDONED` sends an invalid adjacency back through this rewrite
  loop rather than allowing the kernel to repair it
- Original `evidence:added` entries remain preserved in the canonical journal
  and queryable through `loaf evidence list` (append-only invariant)
- Coverage/gate behavior follows the kernel's current non-terminal/terminal
  task rules; loaf-skill does not manufacture a reconcile projection

## 2. `warn` — soft suggestion (advisory only, no block)

### Why this lives in loaf-skill

The loaf-cli protocol carries only MUST / MAY tiers (`Applicability`
3-tier: `must / optional / na`); there is no `should`. But workflows
frequently need soft advice ("you should make this task smaller",
"consider adding a visual contract for this REQ", "you've decomposed into
12 tasks — usually a sign of over-decomposition").

loaf-skill provides a `warn` mechanism:

- Workflow skill emits advisory text via a shared helper
- loaf-skill renders to stderr / TUI as a warning prefix
- User can ignore freely — no gate, no block, no exit code change

## 3. `decomposition-default` — coarse-over-fine bias

### Why this lives in loaf-skill

LLM over-decomposition is a documented failure mode. The loaf-cli
protocol does not carry a decomposition preference — that's workflow
content, not protocol shape (§1 principle 14: 协议管 shape,skill 管
content).

loaf-skill carries:

- Default coarse bias in `newloaf:spec` prompt template
- Stderr warning when emitted `tasks.json` exceeds N tasks (N = 8 by
  current convention, configurable in loaf-skill prompt — not in
  protocol)
- 3rd-party workflow skills may override per-workflow (e.g. a "rapid
  prototyping" skill might prefer `balanced` or `fine`)

## 4. `fan-out` — EXECUTE phase concurrent orchestration

### Why this lives in loaf-skill

Root principle: **fan-out only in the worker phase** (EXECUTE).
EXECUTE is the session's most expensive segment (actually writing code /
running tests / changing files), where dispatching N sub-agent workers
to run mutually-independent leaf tasks **actually saves time**. Other
phases (TRIAGE / SPEC / VERIFY / SETTLE) are control phases — the main
skill runs serially, lightweight.

loaf-cli **supports** a multi-element worker active set at the protocol
level (`loaf tasks list` may report N entries with `status="in_progress"`
simultaneously), but **orchestration is loaf-skill's responsibility** —
the protocol does not schedule sub-agents or choose concurrency. It does,
however, audit PostToolUse paths through the machine-local scope accumulator
described below.

### Protocol requirements (cross-file invariant)

The main skill, when fanning out during EXECUTE, **must follow this
4-step sequence**:

1. **Pick a batch of ready leaves** (skill-internal decision, protocol
   does not observe)
   - Read tasks from `loaf tasks list --format json` with `status` in
     `pending | ready` and
     every referenced dependency in `status="done"`
   - Confirm mutually non-conflicting write scopes (derived from
     `STEP_WRITE_PATHS_BY_KIND[kind][step]` ∪ `loaf.config.json.paths.*`)
   - Pick N (typically 2–4; Wang convention; configurable in loaf-skill)
2. **Atomic batch transition**: main skill serially calls
   `loaf tasks step start --task T-X --step <s>` N times, moving N tasks
   from `status="pending" | "ready"` → `"in_progress"` and setting each
   starting step's `task.execution.<step>.status="running"`. This step is
   **single-threaded**, with no race; `loaf advance` validates transition
   legality.
3. **Fan-out N sub-agents**: main skill starts N sub-agents (LLM
   inference concurrency), each owning one task:
   - Receive the task context selected from `loaf tasks list`, validate
     spec-lock health with `loaf spec status`, and query existing proof with
     `loaf evidence list`; read derived `spec.md` only when the full authored
     prose is required because `spec status` intentionally exposes diagnostics,
     not document content
   - Run side effects (write code / run tests; **only modify own task's
     write scope**)
   - **Do NOT write loaf artifacts directly** (race avoidance) — return
     result to main skill
4. **Fan-in serial write**: after collecting N sub-agent results, the
   main skill serially calls `loaf evidence add` + `loaf tasks step done`
   + (if needed) `loaf finding raise`, persisting N tasks' step progress
   to the typed journal and projections. This step is **single-threaded**, with
   no race. Loop back to step 1 for the next batch.

During step 3, each successful Write/Edit PostToolUse invokes
`loaf hook scope-track`. The hook canonicalizes the target and merges it into
`~/.loaf/runtime/<session_id>.json` under an owner-fenced runtime lock; it does
not append the journal. The serial `loaf advance EXECUTE.done` closure holds
that runtime lock, emits `[scope:recorded, event:phase_advanced]` as one batch
(including an explicit empty marker), then clears pending scope only after the
journal commit point. Sub-agents and loaf-skill must never edit the runtime
file or lock directly.

### Key invariants (loaf-skill documents and self-checks)

- **One kernel-ready rule**: `(status === "pending" || status === "ready") &&
  areTaskDependenciesSatisfied(task, tasksById)`, where the shared predicate
  requires every dependency to be `done`. loaf-cli enforces this at claim with
  `TASK_DEPS_NOT_SATISFIED`; loaf-skill may rank or select eligible tasks but
  must not widen eligibility. Richer trigger-rule vocabulary remains entirely
  thinker-side and does not alter kernel readiness.
- **Side effects truly concurrent** (step 3, sub-agents run code / tests)
- **loaf-artifact writes always serial** (steps 2 + 4, main skill
  single-threaded)
- **scope hook writes are machine-local and lock-serialized**; they are not
  loaf-artifact mutations, and closure is their sole journal flush point
- **Write scopes do not overlap** (step 1 batch selection enforces this)
  — Wang's "ready precondition: write scopes do not conflict" intent
- **Failure handling**: if sub-agent A crashes (error / timeout), at
  fan-in the main skill calls
  `loaf finding raise --category test-defect --action fix-test --target-task T-A`,
  then uses the finding back-edge to return to EXECUTE.work for a retry

### Counter-example — `fan-out` is NEVER allowed in other phases

| Phase | Why not |
|---|---|
| TRIAGE | Scoring is a single judgment; main skill, single thread |
| SPEC | `spec.md` / plan / design is a single narrative; concurrent sub-agents produce fragments that fight over EARS REQs |
| VERIFY | The 4 checks are feature-level serial; concurrency does not speed them up; order is applicability-driven; intent is expressed by sub_state (`VERIFY.run / .review / .acceptance / .visual`) |
| SETTLE | Reconcile is an aggregate scan over all evidence + tasks + findings; lessons is narrative distillation |
| DONE | Terminal, no work |

## What does NOT live in loaf-skill

These were considered during the same grilling pass and ruled out of
both loaf-cli AND loaf-skill — they sit outside loaf's scope entirely:

- **Sprint / milestone / epic containers**: PM workflow, not SDD
  workflow. Workflow skills that need Sprint semantics maintain their
  own state outside loaf (`.wang/sprint-2026-W19.json`, external
  trackers, etc.)
- **Parallel `batch` execution (2–4 concurrent leaf TK)**: explicit
  loaf-cli non-goal (§16). The CLI does not schedule side effects; workflow
  skills may use the §4 fan-out contract, while kernel mutations remain serial.
- **`Rule-candidate` auto-promotion**: Wang's "immediately harden
  high-impact review finding into script + unit test + check-fast" is
  an automation concern. v0.1.0 non-goal (`loaf lessons promote`). Skills
  may flag rule-candidate intent in `lessons.md` notes, but
  materialization is user/CI responsibility.
- **Review round counter / fuse**: Wang's "iteration > 5 fuse" —
  loaf-cli has `state.iteration` (general) but no round-kind-specific
  fuse. Workflow skills may track their own fuse if desired; not
  protocol.
