---
name: start
description: Start a new loaf feature lifecycle by running TRIAGE — score complexity, pick a ceremony preset, create the session with `loaf start`, then hand off to the next phase. This skill should be used when the user wants to begin a new feature, kick off or enter the loaf workflow, triage a new piece of work, or asks where to start on a loaf feature.
user-invocable: true
allowed-tools: ["Bash(loaf:*)", "Read"]
---

# /loaf:start — TRIAGE phase

You drive **TRIAGE**: assess the work, agree on a ceremony level with the
human, create the session, then hand the cursor to the next phase.

You are the orchestrator; the kernel (`loaf-cli`) owns all state. Never write
`.loaf/` directly — every change goes through a `loaf` command (ADR-0005:
single typed journal, single writer). Pass `--feature <F>` on every command (a
bare `--feature-dir` is rejected). The sole exception is `loaf start`, which
takes `<F>` as its required positional. `<F>` is the feature being started.

## Steps

1. **Check for an existing session (re-entry safe).**
   `loaf status --feature <F> --format json`
   - Exit 2 `FEATURE_NOT_FOUND` → no session yet; continue to step 2.
   - Exit 0 with a `sub_state` → already started. Do **not** re-run `loaf
     start`. Skip to **Done — report & stop** — the kernel routes you to the real cursor.

2. **Score the work (your judgment).** Rate complexity 0–100 across **files /
   api / schema / concurrency / security**. The score only *suggests* a
   ceremony; the human decides in step 3. Mapping:
   [references/ceremony-presets.md](references/ceremony-presets.md).

3. **Pick the ceremony (HUMAN decision point).** Present your suggested preset
   with a one-line rationale and the four options — `quick` / `light` /
   `standard` / `deep`, monotonic (each turns on the next phase). **Stop until
   the human chooses.** Preset details: references/ceremony-presets.md.

4. **Create the session.**
   `loaf start <F> --ceremony <preset> [--label "<≥3 chars>"]`
   Emits `session:started`, enters `TRIAGE.score`. `--ceremony` defaults to
   `standard`.

5. **Confirm the profile.** `loaf advance TRIAGE.confirm --feature <F>`
   (`TRIAGE.score` → `TRIAGE.confirm` — the "accept or override profile"
   checkpoint). Then report & stop.

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

## Skeleton invariants (every phase skill carries these)

- **Single writer** — mutate only via `loaf`; never touch `.loaf/`, `spec.md`,
  or snapshots by hand.
- **Re-entry safe** — read `loaf status` first; never assume you start at the
  phase's first sub-state.
- **Routing belongs to `/loaf:run`** — end your phase by reporting `loaf next`'s
  recommendation; never advance into another phase yourself.
- **Pause points are explicit** — stop and ask at each `*.confirm` / gate /
  decision boundary rather than guessing.

## References

- [references/ceremony-presets.md](references/ceremony-presets.md) — six-flag
  preset expansion + the score → preset mapping you apply in step 2.
