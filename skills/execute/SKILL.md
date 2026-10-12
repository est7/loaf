---
name: execute
description: Run the loaf EXECUTE phase — derive task execution policy, then work the task graph (claim → step → evidence → done), fanning out independent leaves to sub-agents when useful, until every task is done. This skill should be used when a loaf feature is in or entering the EXECUTE phase, or when the user wants to implement tasks, run the work loop, record evidence, or raise findings.
user-invocable: true
allowed-tools: ["Bash(loaf:*)", "Read", "Write", "Task"]
---

# /loaf:execute — EXECUTE phase

You drive **EXECUTE**: turn a locked task graph into completed work, walking
`plan` → `work` → `done`. This is the **only** phase where you may fan out
concurrent sub-agents.

You are the orchestrator; the kernel owns all state. Mutate only through `loaf`
commands — never touch `.loaf/` or its snapshots (ADR-0005 single writer). Pass
`--feature <F>` on every command.

## Step 1 — Read state & enter (re-entry safe)

`loaf status --feature <F> --format json`

- `FEATURE_NOT_FOUND` → wrong skill; tell the user to run `/loaf:start`.
- `sub_state = SPEC.design` → the spec is not locked yet (approving spec-lock
  moves the cursor straight to `EXECUTE.plan`); route back to `/loaf:spec`.
- `sub_state = TRIAGE.confirm` (quick path) → you are the receiving skill: run
  `loaf next` and the advance it returns to reach `EXECUTE.plan`. `quick` has
  no task graph; do the work directly and deliver from `EXECUTE.done`.
- `sub_state` in `EXECUTE.*` → resume at that sub-state.
- `sub_state` past EXECUTE → done here; skip to **Done — report & stop**.

## Step 2 — `EXECUTE.plan`: derive execution policy

Each task arrives with every kind step `must` (or the submitted `step_policy`).
Narrow where appropriate with `loaf tasks amend <T-id> --policy <step>=<must|optional|na>`
(repeatable; policy fields only — cannot change `drives` / `kind` /
`depends_on`; an unknown step is `TASK_STEP_NOT_FOUND`). `loaf tasks list` to
review, then `loaf advance EXECUTE.work`.

## Step 3 — `EXECUTE.work`: the work loop

Repeat until every task is `done` or `abandoned`:

1. `loaf next` returns `loaf tasks next` (task-level, non-blocking) — the next
   ready task; or `loaf tasks list` to see the whole graph.
2. `loaf tasks claim <T-id>`, then `loaf tasks step start --task <T-id> --step <s>`.
3. Do the work — write code / run tests, touching only that task's own scope.
4. `loaf evidence add --input <file>` — its `covers[]` must include the **task
   id** (`T-id`): the verify-accept gate (standard/deep) requires every done
   task to carry passing evidence covering its own id, else it fails
   `TASK_DONE_NO_EVIDENCE`. For `light`, deliver enforces verify-min instead:
   behavioral/structural tasks need passing `local-check` evidence covering the
   T-id, visual-ui needs `visual-review` or `manual`, docs needs `task-summary`
   or `manual`, chore needs `local-check`, `manual`, or `task-summary`; a human
   `waiver` satisfies any kind (else `DELIVER_VERIFY_MIN_INCOMPLETE`). Record
   REQ / SCEN / VIS coverage with separate evidence whose `covers[]` names those
   obligation ids. Evidence `kind` constrains which obligation a record can
   satisfy; choose a compatible kind before writing it:

   | `covers[]` obligation | allowed evidence kinds |
   |---|---|
   | `REQ-*` | `task-summary`, `verify-review`, `spec-review`, `manual`, `waiver` |
   | `SCEN-*` | `acceptance`, `manual`, `waiver` |
   | `VIS-*` | `visual-review`, `manual`, `waiver` |
   | `T-*` | `task-summary`, `local-check`, `manual`, `waiver` |

   An `evidence add` compatibility warning means the supplied kind cannot
   satisfy that coverage lane; it is not noise. `manual` / `waiver` evidence
   always requires a `human:*` payload actor and a reason of at least 10
   characters; every `visual-review` requires at least one attachment. Then
   `loaf tasks step done --task <T-id> --step <s>`.
   Completing the last must-step auto-promotes the task to `done`.
   The step outcome and evidence outcome are independent: a RED reproduction
   step can complete with `--result passed` while its evidence records the
   system-under-test failure with `result=failed`.
   For a behavioral task labelled `bug`, call `loaf tasks register-red <T-id>`
   only after the failing RED test exists. It records ordering proof before the
   implement step; it is not a shortcut for completing RED or for non-bug
   tasks. In evidence input, payload `actor` is the evidence attester; the
   journal envelope actor is writer provenance, and the two may differ.
5. Problem found → `loaf finding raise --category <c> --action <a> --summary
   "<…>" [--target-task <T-id> --target-step <s>] [--reason "<≥20 chars>"]`.
   `fix-impl` requires target step `implement` and `fix-test` requires `red`;
   `--target-task` and `--target-step` go together; unusual category × action
   cells need `--reason`, incoherent cells are rejected. `fix-impl` /
   `fix-test` / `amend-tasks` back-edges return you here; `amend-spec`
   back-edges to `SPEC.spec`. Close the finding with
   `loaf finding close <FND-id>` once the retry passes.

Independent ready leaves may run **concurrently** — see
[references/fan-out.md](references/fan-out.md). Side effects fan out; **loaf
writes always stay serial** (single writer). When every task is terminal →
`loaf advance EXECUTE.done`. PostToolUse `scope-track` hooks accumulate each
worker's canonical paths in the owner-locked machine-local runtime file; this
advance flushes one `scope:recorded` marker immediately before the phase
transition in the same journal batch. Never edit `~/.loaf/runtime/` directly.

## Done — report & stop

Run `loaf next --feature <F> --format json`, **report** its result, then
**stop**. Do not act on it: do not invoke another phase skill, do not
`deliver`, do not run a blocking action — routing and the next hop belong to
`/loaf:run` (or the user's next explicit command).

Report enough that the user can continue by hand: (1) `next_action.command` +
`reason` (or `blocked` / `terminal`), and (2) the next phase's skill — map
`next_action.target`'s phase to its skill (`TRIAGE`→`/loaf:start`; `SPEC` /
`EXECUTE` / `VERIFY` / `SETTLE` are same-named; `DONE` = finished). Or suggest
`/loaf:run` to drive the rest automatically.

(At `EXECUTE.done`, `loaf next` points at `loaf deliver` for `quick`/`light` or
the VERIFY phase for `standard`/`deep` — `/loaf:run` routes accordingly.)

## Skeleton invariants (every phase skill carries these)

- **Single writer** — mutate only via `loaf`; never touch `.loaf/`, `spec.md`,
  or snapshots by hand.
- **Re-entry safe** — read `loaf status` first; never assume you start at the
  phase's first sub-state.
- **Routing belongs to `/loaf:run`** — end your phase by reporting `loaf next`'s
  recommendation; never advance into another phase yourself.
- **Pause points are explicit** — stop and ask at each `*.confirm` / gate /
  decision boundary rather than guessing.
