---
name: spec
description: Run the loaf SPEC phase — author the proposal, EARS requirements, scenarios, plan, design, and task graph, then drive the spec-lock gate. This skill should be used when a loaf feature is in or entering the SPEC phase, or when the user wants to write or refine a spec, author requirements or scenarios, plan a feature, or lock the spec.
user-invocable: true
allowed-tools: ["Bash(loaf:*)", "Read", "Write"]
---

# /loaf:spec — SPEC phase

You drive **SPEC**: turn a triaged feature into a *locked* specification plus a
task graph that covers it, walking `proposal` → `spec` → `plan` → `design` and
ending at the **spec-lock gate** (a human decision).

You are the orchestrator; the kernel owns all state. Author only through `loaf
spec …` / `loaf tasks …` commands — never write `.loaf/` or `spec.md` directly
(ADR-0005 single writer). Pass `--feature <F>` on every command.

## Step 1 — Read state & enter the phase (re-entry safe)

`loaf status --feature <F> --format json`

- `FEATURE_NOT_FOUND` → wrong skill; tell the user to run `/loaf:start` first.
- `sub_state = TRIAGE.confirm` → you are the receiving skill. Run `loaf next`
  (it returns `loaf advance SPEC.proposal`) and run that advance to enter SPEC.
- `sub_state` already in `SPEC.*` → resume at that sub-state.
- `sub_state` past SPEC (`EXECUTE.*` …) → SPEC is done; skip to **Done — report & stop**.

## Step 2 — Walk the SPEC sub-states

Advance through the four sub-states, authoring each one's deliverable. These
advances stay **in your phase**, so you run them yourself after the human is
satisfied with the content.

| sub-state | author this | how | then |
|---|---|---|---|
| `SPEC.proposal` | why / scope / anti-scope | `loaf spec init`, fill the Proposal body via `loaf spec edit` | `loaf advance SPEC.spec` |
| `SPEC.spec` | EARS `REQ-*` (measurable + `verified_by_scenarios` or `acceptance_na`+reason), Gherkin `SCEN-*`, `VIS-*` if UI; `needs_clarification` must be empty | `loaf spec add-req` / `add-scenario` / `add-visual --input <file>` | `loaf advance SPEC.plan` |
| `SPEC.plan` | risks / dependencies / milestones | `loaf spec edit` (Plan body) | `loaf advance SPEC.design` |
| `SPEC.design` | design notes + task graph; **bind every `REQ`/`SCEN`/`VIS` to ≥1 task** via `task.drives[]` | `loaf tasks submit --input <file>` | gate → step 3 |

For add-* input, run that command with `--schema --format=json`. For the whole
task graph, run `loaf tasks schema --format=json`; `tasks submit` itself has no
`--schema` flag. Pass your file with `--input`. The CLI stamps
`REQ-`/`SCEN-`/`VIS-`/`T-` ids — never your own.

## Step 3 — The spec-lock gate (HUMAN decision point)

At `SPEC.design`, `loaf next --feature <F> --format json` returns a **blocking**
recommendation: `loaf gate decide spec-lock` (`blocked: true`). This is the
pause. The gate runs 8 mechanical checks (frontmatter, `needs_clarification`,
task↔spec coverage, REQ / scenario / visual coverage, spec-review, orphans) and
requires a `human:*` actor — which is why it is a human decision.

Before asking the human, run
`loaf spec status --feature <F> --format json` and summarize its failing and
suppressed checks alongside the task count. This replay-backed query replaces
reading derived `spec.md` to infer gate status. **Stop and let the human approve
or reject.** Then run their decision:

- approve → `loaf gate decide spec-lock --approve --reason "<why>" --feature <F>`
- reject  → `loaf gate decide spec-lock --reject --reason "<what's missing>" --feature <F>`

If `--approve` fails with failed checks (incomplete spec), surface them, return
to step 2 to fix the spec or tasks, then retry. **Never force a lock past a
failing check.** A reject keeps the cursor in SPEC — return to step 2.

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

(A successful spec-lock approve co-advances the cursor `SPEC.design` →
`EXECUTE.plan` in the same batch, so `loaf next` will already point at EXECUTE.)

## Skeleton invariants (every phase skill carries these)

- **Single writer** — mutate only via `loaf`; never touch `.loaf/`, `spec.md`,
  or snapshots by hand.
- **Re-entry safe** — read `loaf status` first; never assume you start at the
  phase's first sub-state.
- **Routing belongs to `/loaf:run`** — end your phase by reporting `loaf next`'s
  recommendation; never advance into another phase yourself.
- **Pause points are explicit** — stop and ask at each `*.confirm` / gate /
  decision boundary rather than guessing.
