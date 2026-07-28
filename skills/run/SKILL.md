---
name: run
description: Drive a loaf feature end-to-end from one entry point — run TRIAGE, then walk every phase (SPEC → EXECUTE → VERIFY → SETTLE) to DONE by obeying `loaf next`, continuing through non-blocking machine work and stopping at human-owned decisions. This skill should be used when the user wants to run or drive a whole feature lifecycle from a single command, take a requirement "all the way to done", or orchestrate the full loaf workflow rather than one phase at a time.
user-invocable: true
allowed-tools: ["Bash(loaf:*)", "Read"]
---

# /loaf:run — end-to-end lifecycle driver

You drive the **whole** loaf lifecycle from one entry point: TRIAGE → SPEC →
EXECUTE → VERIFY → (SETTLE) → DONE. You own the **drive loop and the routing**;
each phase's real work belongs to that phase's skill, which you invoke. You
continue across non-blocking machine routes, and stop at every human-owned
decision or fact.

You are the orchestrator; the kernel (`loaf-cli`) owns all state. Never write
`.loaf/` directly. Pass `--feature <F>` on every `loaf` command.

## Step 1 — Bootstrap

Invoke **`/loaf:start`** (follow its instructions inline — skill chaining is
instruction-level, not a tool call). It is re-entry safe: for a new `<F>` it
scores complexity, stops for the human to confirm a ceremony, creates the
session, and runs TRIAGE; for an existing one it routes from the real cursor.
When it returns, control is back here.

## Step 2 — The drive loop

Repeat:

1. `loaf next --feature <F> --format json`.
2. Branch on the result:

| Result | Action |
|---|---|
| `terminal: true` | Lifecycle done — report `DONE` and stop. |
| `blocked: true` (`gate decide` / `pending resolve` / `profile escalate`) | **Human stop.** Surface `next_action.command` + `reason`; let the human decide. On their reply run the authorized command, then loop. Never auto-run a blocking action. |
| `next_action.owner_verb` is `deliver` | **Deliver stop.** Confirm with the human, then run `loaf deliver` (human-owned). Report `DONE`. |
| `next_action.target` prefix is another phase | **Phase boundary** — see Step 3. |
| `next_action.target` is `task-level` (or an `advance` inside the current phase) | You are mid-phase — the current phase skill owns this. Reached only if a phase skill returned early; re-invoke it to finish its loop. |

The phase skills own **their own** gates internally (`/loaf:spec` runs
spec-lock, `/loaf:verify` runs verify-accept). So the `blocked` row here is the
safety net for `pending` / `profile escalate` and any gate a phase skill left
unhandled — not the normal path for the two main gates.

### Executable supervision classification

This block is the machine-readable projection of the table above. It
classifies ownership only; `loaf next` remains the sole source of transition
targets and commands.

<!-- loaf-supervision-contract:start -->
```json
{
  "schema": 1,
  "route_command": "loaf next",
  "automatic_owner_verbs": ["advance", "tasks next"],
  "human_stops": [
    {
      "id": "spec-lock",
      "command_prefix": "loaf gate decide spec-lock"
    },
    {
      "id": "verify-accept",
      "command_prefix": "loaf gate decide verify-accept"
    },
    {
      "id": "deliver",
      "command_prefix": "loaf deliver"
    },
    {
      "id": "pending",
      "command_prefix": "loaf pending resolve"
    },
    {
      "id": "profile-escalation",
      "command_prefix": "loaf profile escalate"
    }
  ]
}
```
<!-- loaf-supervision-contract:end -->

## Step 3 — Phase boundary: follow non-blocking routes

Map `next_action.target` prefix → skill: `TRIAGE`→`/loaf:start`,
`SPEC`→`/loaf:spec`, `EXECUTE`→`/loaf:execute`, `VERIFY`→`/loaf:verify`,
`SETTLE`→`/loaf:settle`.

If `loaf next` reports a non-blocking route into another phase, invoke that
phase skill directly. Do not create a redundant `go` checkpoint. Gate approval
already supplies the human decision for a gated transition; ordinary
TRIAGE→SPEC and EXECUTE→VERIFY routing is machine work.

After a phase skill returns, loop (Step 2). After any human stop, re-read
`loaf status` + `loaf next` to relocate the cursor; never assume where you were.

## Invariants

- **Single writer** — mutate only via `loaf`; never touch `.loaf/`, `spec.md`,
  or snapshots.
- **Routing lives here** — phase skills no longer self-route; you are the only
  driver. Always re-derive the next hop from `loaf next`, never hardcode it.
- **Human facts stay human-owned** — gates, terminal choices, waivers, and
  manual attestations are never synthesized. `LOAF_USER` identifies an actor;
  it does not approve anything.
- **Re-entry safe** — `loaf status` first on every (re-)entry; resume from the
  real cursor.
