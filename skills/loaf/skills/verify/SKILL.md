---
name: verify
description: Run the loaf VERIFY phase — compute which verify lanes apply (run / review / acceptance / visual), work each applicable lane recording evidence, then drive the verify-accept gate. This skill should be used when a loaf feature is in or entering the VERIFY phase, or when the user wants to verify a feature, run checks, record verification evidence, close findings, or accept the work.
user-invocable: true
allowed-tools: ["Bash(loaf:*)", "Read", "Write"]
---

# /loaf:verify — VERIFY phase

You drive **VERIFY**: prove the work meets the spec, walking `plan` →
(`run` / `review` / `acceptance` / `visual`, whichever apply) → `accept`, ending
at the **verify-accept gate** (a human decision). VERIFY runs for `standard`
and `deep` ceremonies.

You are the orchestrator; the kernel owns all state. Mutate only through `loaf`
commands (ADR-0005 single writer). Pass `--feature <F>` on every command.

## Step 1 — Read state & enter (re-entry safe)

`loaf status --feature <F> --format json`

- `FEATURE_NOT_FOUND` → wrong skill; tell the user to run `/loaf:start`.
- `sub_state = EXECUTE.done` → you are the receiving skill: run `loaf next` and
  the advance it returns to reach `VERIFY.plan`.
- `sub_state` in `VERIFY.*` → resume at that sub-state.
- `sub_state` past VERIFY → done here; skip to **Handoff**.

## Step 2 — `VERIFY.plan`: compute applicability

Decide which lanes apply — `run` (test/lint/typecheck), `review` (spec+quality
fit), `acceptance` (Gherkin scenarios), `visual` (visual contracts) — each
`must` / `optional-elected` / `na`, with a reason for every `na`. Then let
`loaf next` route you to the first applicable lane and run that advance.

## Step 3 — Work each applicable lane

For each lane `loaf next` routes you to, do the check and record proof:

- `loaf evidence add --input <file>` with the lane's evidence `kind`
  (`local-check`/`task-summary` for run, `verify-review` for review,
  `acceptance` for acceptance, `visual-review` + attachments for visual).
- Failure → `loaf finding raise …`; close it with `loaf finding close <FND-id>`
  once resolved. Open findings block the gate.

`loaf next` walks the applicable lanes in order, then routes to `VERIFY.accept`.

## Step 4 — The verify-accept gate (HUMAN decision point)

At `VERIFY.accept`, `loaf verify status --feature <F> --format json` shows the
read-only 5-check diagnostic (lane status / open findings / coverage / done-task
evidence / spec-review). `loaf next` returns a **blocking** `loaf gate decide
verify-accept` (`blocked: true`); the gate needs a `human:*` actor.

Summarize `verify status` for the human, then **stop and let them approve or
reject**:

- approve → `loaf gate decide verify-accept --approve --reason "<why>" --feature <F>`
- reject  → `loaf gate decide verify-accept --reject --reason "<what fails>" --feature <F>`

If `--approve` fails on a check (open finding, missing evidence …), surface it,
return to step 3 to fix, then retry. **Never force-accept past a failing check.**

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

After a verify-accept approve: `deep` → `loaf next` returns `loaf settle` (hand
off to `/loaf:settle`); `standard` → returns `loaf deliver` (terminal, run it).

## Skeleton invariants (every phase skill carries these)

- **Single writer** — mutate only via `loaf`; never touch `.loaf/`, `spec.md`,
  or snapshots by hand.
- **Re-entry safe** — read `loaf status` first; never assume you start at the
  phase's first sub-state.
- **Routing is the kernel's** — end the phase with `loaf next` and obey it;
  don't re-derive the next phase yourself.
- **Pause points are explicit** — stop and ask at each `*.confirm` / gate /
  decision boundary rather than guessing.
