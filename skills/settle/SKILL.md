---
name: settle
description: Run the loaf SETTLE phase — audit scope evidence, capture lessons learned, then hand off for delivery. This skill should be used when a deep-ceremony loaf feature is in or entering the SETTLE phase, or when the user wants to review scope drift, record lessons, or close out a feature.
user-invocable: true
allowed-tools: ["Bash(loaf:*)", "Read", "Write"]
---

# /loaf:settle — SETTLE phase

You drive **SETTLE**: close the feature out cleanly by entering `lessons`,
auditing available scope evidence, and recording lessons. SETTLE runs only for the `deep` ceremony (`quick` /
`light` / `standard` skip it and deliver earlier).

You are the orchestrator; the kernel owns all state. Mutate only through `loaf`
commands (ADR-0005 single writer). Pass `--feature <F>` on every command.

## Step 1 — Read state & enter (re-entry safe)

`loaf status --feature <F> --format json`

- `FEATURE_NOT_FOUND` → wrong skill; tell the user to run `/loaf:start`.
- `sub_state = VERIFY.accept` (just approved) → you are the receiving skill: run
  `loaf next` and the `loaf settle` it returns to enter `SETTLE.lessons`.
- `sub_state = SETTLE.lessons` → resume at lessons.
- `sub_state` is `DONE.*` → already delivered; report and stop.

## Step 2 — Audit scope evidence

Build the audit view through CLI readers:

- `loaf spec status --feature <F> --format json`
- `loaf tasks list --feature <F> --format json`
- `loaf evidence list --feature <F> --format json`
- `loaf finding list --feature <F> --format json`
- `loaf journal list --feature <F> --kind scope:recorded --format json`

The last command confirms closure markers but intentionally does not expose
payload paths. Do not invent planned scope or read/write a
reconcile snapshot as truth. Findings cannot be raised or closed at
`SETTLE.lessons`; fix actionable drift before verify-accept. At this point,
record drift as a lesson or surface it to the human, who may close via
`loaf archive` / `loaf abandon`.

## Step 3 — Capture lessons

For `lessons_required: must`, the kernel rejects delivery from SETTLE.lessons
until the session contains at least one admitted `lesson:recorded` entry.
`loaf next` uses the same predicate as delivery admission: with zero lessons it
returns blocking `lessons add` with reason `LESSONS_REQUIRED_BEFORE_DELIVER`.
Surface this human fact request; never invent a lesson. After a human supplies
the lesson, record it before handing off. An earlier-iteration lesson already
satisfies the session-wide requirement. Record each:

`loaf lessons add --text "<lesson>" --reason "<why it matters, ≥10 chars>"`
(or `--file <path>` instead of `--text`). This appends a strict
`lesson:recorded` journal entry with an `LSN-NNN` id and projects it into
`lessons.md`; it does not enter evidence-derived views. When lessons are
captured → hand off.

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

(At `SETTLE.lessons`, `loaf next` first requests a human lesson when required;
after recording it, the route points at `loaf deliver` as the deliver stop. To close without delivering, the human may instead run
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
