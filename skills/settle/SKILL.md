---
name: settle
description: Run the loaf SETTLE phase — reconcile planned vs actual scope, capture lessons learned, then deliver the feature. This skill should be used when a deep-ceremony loaf feature is in or entering the SETTLE phase, or when the user wants to reconcile scope drift, record lessons, or deliver/close out a feature.
user-invocable: true
allowed-tools: ["Bash(loaf:*)", "Read", "Write"]
---

# /loaf:settle — SETTLE phase

You drive **SETTLE**: close the feature out cleanly, walking `reconcile` →
`lessons` → deliver. SETTLE runs only for the `deep` ceremony (`quick` /
`light` / `standard` skip it and deliver earlier).

You are the orchestrator; the kernel owns all state. Mutate only through `loaf`
commands (ADR-0005 single writer). Pass `--feature <F>` on every command.

## Step 1 — Read state & enter (re-entry safe)

`loaf status --feature <F> --format json`

- `FEATURE_NOT_FOUND` → wrong skill; tell the user to run `/loaf:start`.
- `sub_state = VERIFY.accept` (just approved) → you are the receiving skill: run
  `loaf next` and the `loaf settle` it returns to enter `SETTLE.reconcile`.
- `sub_state` in `SETTLE.*` → resume at that sub-state.
- `sub_state` is `DONE.*` → already delivered; report and stop.

## Step 2 — `SETTLE.reconcile`: resolve drift

Compare planned scope vs actual scope: tasks added / abandoned / amended,
findings raised, REQ/SCEN/VIS coverage as built. Resolve every drift (note it,
or raise/close findings as needed) and snapshot the verify-check status. When
reconciled → `loaf advance SETTLE.lessons`.

## Step 3 — `SETTLE.lessons`: capture lessons

`deep` requires at least one lesson (`lessons_required: must`). Record each:

`loaf lessons add --text "<lesson>" --reason "<why it matters, ≥10 chars>"`
(or `--file <path>` instead of `--text`). This appends a `kind=manual` evidence
entry projected into `lessons.md`. When lessons are captured → hand off.

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

(At `SETTLE.lessons`, `loaf next` points at `loaf deliver` — `/loaf:run` runs it
as the deliver stop. To close without delivering, the human may instead run
`loaf archive --reason "<…>"` or `loaf abandon --reason "<…>"`.)

## Skeleton invariants (every phase skill carries these)

- **Single writer** — mutate only via `loaf`; never touch `.loaf/`, `spec.md`,
  or snapshots by hand.
- **Re-entry safe** — read `loaf status` first; never assume you start at the
  phase's first sub-state.
- **Routing belongs to `/loaf:run`** — end your phase by reporting `loaf next`'s
  recommendation; never advance into another phase yourself.
- **Pause points are explicit** — stop and ask at each `*.confirm` / gate /
  decision boundary rather than guessing.
