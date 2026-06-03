---
name: run
description: Drive a loaf feature end-to-end from one entry point — run TRIAGE, then walk every phase (SPEC → EXECUTE → VERIFY → SETTLE) to DONE by obeying `loaf next`, pausing for a human `go` at each non-gated phase boundary and for approval at every gate. This skill should be used when the user wants to run or drive a whole feature lifecycle from a single command, take a requirement "all the way to done", or orchestrate the full loaf workflow rather than one phase at a time.
user-invocable: true
allowed-tools: ["Bash(loaf:*)", "Read"]
---

# /loaf:run — end-to-end lifecycle driver

You drive the **whole** loaf lifecycle from one entry point: TRIAGE → SPEC →
EXECUTE → VERIFY → (SETTLE) → DONE. You own the **drive loop and the routing**;
each phase's real work belongs to that phase's skill, which you invoke. You
never cross a phase boundary without an explicit human `go` (non-gated
boundary) or a gate approval (gated boundary).

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
| `blocked: true` (`gate decide` / `pending resolve` / `profile escalate`) | **Gate stop.** Surface `next_action.command` + `reason`; let the human decide. On their reply run the decision command, then loop. Never auto-run a blocking action. |
| `next_action.owner_verb` is `deliver` | **Deliver stop.** Confirm with the human, then run `loaf deliver` (human-owned). Report `DONE`. |
| `next_action.target` prefix is another phase | **Phase boundary** — see Step 3. |
| `next_action.target` is `task-level` (or an `advance` inside the current phase) | You are mid-phase — the current phase skill owns this. Reached only if a phase skill returned early; re-invoke it to finish its loop. |

The phase skills own **their own** gates internally (`/loaf:spec` runs
spec-lock, `/loaf:verify` runs verify-accept). So the `blocked` row here is the
safety net for `pending` / `profile escalate` and any gate a phase skill left
unhandled — not the normal path for the two main gates.

## Step 3 — Phase boundary: confirm, then hand off

Map `next_action.target` prefix → skill: `TRIAGE`→`/loaf:start`,
`SPEC`→`/loaf:spec`, `EXECUTE`→`/loaf:execute`, `VERIFY`→`/loaf:verify`,
`SETTLE`→`/loaf:settle`.

Whether you ask first depends on the phase you just finished:

- **The phase you just ran ends in a gate** (`/loaf:spec`→spec-lock,
  `/loaf:verify`→verify-accept) and the human already approved it → the
  approval **is** the go. Invoke the next phase skill directly; do not ask
  again.
- **The phase you just ran has no terminal gate** (`/loaf:start`/TRIAGE,
  `/loaf:execute`/EXECUTE) → this is a non-gated boundary. Report
  `<phase> done. Next: <Phase> (/loaf:X). Reply go / continue.` and **stop**.
  When the human replies `go` / `continue`, invoke the phase skill (`/loaf:X`).

Net effect: every boundary needs human input — a gate approval at gated
boundaries (`SPEC`→`EXECUTE`, `VERIFY`→…), a `go` at non-gated ones
(`TRIAGE`→`SPEC`, `EXECUTE`→`VERIFY`) — but never two stops back-to-back.

After a phase skill returns, loop (Step 2). The human's `go` may arrive in a
later turn — on every (re-)entry re-read `loaf status` + `loaf next` to relocate
the cursor; never assume where you were.

## Invariants

- **Single writer** — mutate only via `loaf`; never touch `.loaf/`, `spec.md`,
  or snapshots.
- **Routing lives here** — phase skills no longer self-route; you are the only
  driver. Always re-derive the next hop from `loaf next`, never hardcode it.
- **No silent boundary crossing** — every phase hop needs a human `go` or a
  gate approval. Gates and `deliver` are always human-owned.
- **Re-entry safe** — `loaf status` first on every (re-)entry; resume from the
  real cursor.
