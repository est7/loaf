# loaf-skill — contract with loaf-cli

> **Status**: design intent. `loaf-skill` is the middle layer in the
> three-tier architecture (`docs/design.md` §19):
>
> ```
> loaf-cli (protocol core, this repo)
>   → loaf-skill (workflow orchestration, separate codebase)
>     → 3rd-party workflow skill (domain dialogue)
> ```
>
> The capabilities described below are deliberately **NOT** implemented in
> loaf-cli. They are future `loaf-skill` responsibilities, recorded here so
> the loaf-cli ↔ loaf-skill boundary stays explicit. When the loaf-skill
> codebase boots up (post-v0.1.0 GA of loaf-cli), the requirements below are
> the starting contract.

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
- Original evidence preserved in `evidence.jsonl` (append-only invariant)
- Reconcile coverage counts only the new children; abandoned task drops
  out of coverage by virtue of `status="abandoned"`

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
level (`tasks.json` may carry N entries with `status="in_progress"`
simultaneously), but **orchestration is loaf-skill's responsibility** —
the protocol is unaware of sub-agents / concurrency count / write-scope
isolation. Those are workflow concerns.

### Protocol requirements (cross-file invariant)

The main skill, when fanning out during EXECUTE, **must follow this
4-step sequence**:

1. **Pick a batch of ready leaves** (skill-internal decision, protocol
   does not observe)
   - Read tasks from `tasks.json` with `status="pending"` and all
     `depends_on` set to `done`
   - Confirm mutually non-conflicting write scopes (derived from
     `STEP_WRITE_PATHS_BY_KIND[kind][step]` ∪ `loaf.config.json.paths.*`)
   - Pick N (typically 2–4; Wang convention; configurable in loaf-skill)
2. **Atomic batch transition**: main skill serially calls
   `loaf tasks step start --task T-X --step <s>` N times, moving N tasks
   from `status="pending"` → `"in_progress"` and setting each starting
   step's `task.execution.<step>.status="running"`. This step is
   **single-threaded**, with no race; `loaf advance` validates transition
   legality.
3. **Fan-out N sub-agents**: main skill starts N sub-agents (LLM
   inference concurrency), each owning one task:
   - Read `task.drives` / `task.execution` / `spec.md` / existing evidence
   - Run side effects (write code / run tests; **only modify own task's
     write scope**)
   - **Do NOT write loaf artifacts directly** (race avoidance) — return
     result to main skill
4. **Fan-in serial write**: after collecting N sub-agent results, the
   main skill serially calls `loaf evidence add` + `loaf tasks step done`
   + (if needed) `loaf finding raise`, persisting N tasks' step progress
   to `tasks.json` + `evidence.jsonl` + `findings.jsonl`. This step is
   **single-threaded**, with no race. Loop back to step 1 for the next
   batch.

### Key invariants (loaf-skill documents and self-checks)

- **Side effects truly concurrent** (step 3, sub-agents run code / tests)
- **loaf-artifact writes always serial** (steps 2 + 4, main skill
  single-threaded)
- **Write scopes do not overlap** (step 1 batch selection enforces this)
  — Wang's "ready precondition: write scopes do not conflict" intent
- **Failure handling**: if sub-agent A crashes (error / timeout), at
  fan-in the main skill calls
  `loaf finding raise --category test-defect --refs T-A`, then uses
  `amend-tasks` action to return to EXECUTE.work for a retry

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
  loaf-cli non-goal (§16). Workflow skills degrade to serial; if
  parallelism is critical, that's an orchestration-layer concern
  (multi-worker dispatch), not an SDD protocol concern.
- **`Rule-candidate` auto-promotion**: Wang's "immediately harden
  high-impact review finding into script + unit test + check-fast" is
  an automation concern. v0.1.0 non-goal (`loaf lessons promote`). Skills
  may flag rule-candidate intent in `lessons.md` notes, but
  materialization is user/CI responsibility.
- **Review round counter / fuse**: Wang's "iteration > 5 fuse" —
  loaf-cli has `state.iteration` (general) but no round-kind-specific
  fuse. Workflow skills may track their own fuse if desired; not
  protocol.
