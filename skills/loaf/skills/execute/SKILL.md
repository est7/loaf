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
- `sub_state = SPEC.design` (just locked) or `TRIAGE.confirm` (quick path) →
  you are the receiving skill: run `loaf next` and the advance it returns to
  reach `EXECUTE.plan`.
- `sub_state` in `EXECUTE.*` → resume at that sub-state.
- `sub_state` past EXECUTE → done here; skip to **Handoff**.

## Step 2 — `EXECUTE.plan`: derive execution policy

For each task, set its per-step applicability from `kind × ceremony`. Narrow
edits only: `loaf tasks amend <T-id> --policy <…>` (policy fields only — cannot
change `drives` / `kind` / `depends_on`). `loaf tasks list` to review. When
every task has a policy → `loaf advance EXECUTE.work`.

## Step 3 — `EXECUTE.work`: the work loop

Repeat until every task is `done` or `abandoned`:

1. `loaf next` returns `loaf tasks next` (task-level, non-blocking) — the next
   ready task; or `loaf tasks list` to see the whole graph.
2. `loaf tasks claim <T-id>`, then `loaf tasks step start --task <T-id> --step <s>`.
3. Do the work — write code / run tests, touching only that task's own scope.
4. `loaf evidence add --input <file>` — its `covers[]` must include the **task
   id** (`T-id`): the verify-accept gate requires every done task to carry
   evidence covering its own id, else it fails `TASK_DONE_NO_EVIDENCE`. Record
   REQ / SCEN / VIS coverage with separate evidence whose `covers[]` names those
   obligation ids. Then `loaf tasks step done --task <T-id> --step <s>`.
   Completing the last must-step auto-promotes the task to `done`.
5. Problem found → `loaf finding raise --category <c> --action <a> --summary
   "<…>"` (`fix-impl` / `fix-test` / `amend-tasks` back-edges return you here).

Independent ready leaves may run **concurrently** — see
[references/fan-out.md](references/fan-out.md). Side effects fan out; **loaf
writes always stay serial** (single writer). When every task is terminal →
`loaf advance EXECUTE.done`.

## Handoff — always ask the kernel

Never hardcode the next step. Run `loaf next --feature <F> --format json` and
obey `next_action`:

- `terminal: true` → lifecycle done; report and stop.
- `blocked: true` (`gate decide` / `pending resolve` / `profile escalate`) → a
  human decision: surface `next_action.command` + `reason`, let the human
  choose, then run it. Never auto-run a blocking action.
- `owner_verb: deliver` → the terminal close; run `loaf deliver` (human-owned)
  and report `DONE`.
- `target` is in **another phase** (not `deliver`) → hand off to that phase's
  skill; it runs the boundary step on entry. Map target prefix → skill:
  `TRIAGE`→`/loaf:start`, `SPEC`→`/loaf:spec`, `EXECUTE`→`/loaf:execute`,
  `VERIFY`→`/loaf:verify`, `SETTLE`→`/loaf:settle`.
- otherwise (`advance` within your phase, or `tasks next`) → run
  `next_action.command`, then re-run `loaf next` and repeat.

At `EXECUTE.done`: `quick` / `light` → `loaf next` returns `loaf deliver`
(terminal close, run it here); `standard` / `deep` → hand off to `/loaf:verify`.

## Skeleton invariants (every phase skill carries these)

- **Single writer** — mutate only via `loaf`; never touch `.loaf/`, `spec.md`,
  or snapshots by hand.
- **Re-entry safe** — read `loaf status` first; never assume you start at the
  phase's first sub-state.
- **Routing is the kernel's** — end the phase with `loaf next` and obey it;
  don't re-derive the next phase yourself.
- **Pause points are explicit** — stop and ask at each `*.confirm` / gate /
  decision boundary rather than guessing.
