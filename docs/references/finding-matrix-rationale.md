# Finding Action Grid — per-cell rationale (rev 4.3)

> **Status**: normative reference for the 6×6 `FINDING_ACTION_GRID`
> defined in `src/core/finding-schema.ts` and surfaced as protocol behavior in
> `protocol.md` §4.5. Each of the 36 cells is classified as
> `typical` / `unusual` / `incoherent`; this document justifies the
> classification cell-by-cell.
>
> Authoritative decision source: `adr/0004-moni-audit-resolution.md`
> §A7 and §R3. The grid is **frozen** with the ADR; this reference
> is a derivative explanation, not a venue for re-litigation.

## 1. Why the grid exists

`loaf finding raise --category X --action Y` had 6 × 6 = 36 legal
combinations under rev 4.2 protocol (any pair allowed). Practice
showed this is too permissive in two directions:

1. **Some combinations are structurally invalid** — the action's
   transition has no target task to apply to. Naively allowing the
   raise just defers the failure: the LLM raises a finding, then
   sees the transition fail one round-trip later, then has to
   amend either the category or the action anyway. Early block ⇒
   cheaper LLM feedback loop.
2. **Some combinations are coherent but non-typical** — the
   category × action pairing is logically possible but unusual
   enough that a downstream reviewer (human or skill) will want
   to see *why* this combination was chosen. Requiring a 20+
   character `--reason` keeps the audit trail honest without
   blocking legitimate edge cases.

The grid encodes both directions:

- `typical` — accept silently (reason optional)
- `unusual` — accept with `--reason ≥ 20` (else exit 2
  `FINDING_ACTION_UNUSUAL_REASON_REQUIRED`)
- `incoherent` — block with exit 2 `FINDING_ACTION_INCOHERENT`
  + stderr nudge to `amend-spec` first

`reconcile.json.unusual_findings_count` aggregates per-iteration
`unusual` raises so SETTLE-time review surfaces them
automatically. `incoherent` raises **never land** (they fail at
raise time), so they do not appear in the count or in
`findings.jsonl`.

## 2. Reading the matrix

Vertical axis = `FindingCategory` (6, `src/core/finding-schema.ts`).
Horizontal axis = `FindingAction` (6, `src/core/finding-schema.ts`).

| category \ action | amend-spec | amend-tasks | fix-impl | fix-test | defer | backlog |
|---|---|---|---|---|---|---|
| `spec-gap` | typical | unusual | **incoherent** | **incoherent** | typical | typical |
| `spec-defect` | typical | unusual | unusual | unusual | typical | typical |
| `impl-defect` | unusual | typical | typical | unusual | typical | typical |
| `test-defect` | unusual | typical | unusual | typical | typical | typical |
| `new-scope` | typical | typical | **incoherent** | **incoherent** | typical | typical |
| `risk-escalation` | unusual | typical | unusual | unusual | typical | typical |

The 4 incoherent cells are `spec-gap × {fix-impl, fix-test}` and
`new-scope × {fix-impl, fix-test}` — see §3.1 and §3.5.

## 3. Per-category rationale

Each subsection walks the row left-to-right. `defer` and `backlog`
are universally `typical` (they close the finding into a deferred
drift record or a backlog item; both are valid for any category),
so they are not re-justified per row.

### 3.1 `spec-gap` — spec is silent on this aspect

| action | risk | rationale |
|---|---|---|
| `amend-spec` | typical | The canonical resolution: REQ/SCEN/VIS is missing; add it. `add-*` (rev 4.3) or full `spec submit` plus re-pass spec-lock. |
| `amend-tasks` | unusual | Sometimes the gap is in plan-time decomposition (task missing, REQ already covers it) rather than the spec itself. Requires reason because the boundary between "spec is silent" and "task is missing" is subtle — reviewer needs the reasoning. |
| `fix-impl` | **incoherent** | The transition for `fix-impl` is `task.execution.implement.status = running`. But `spec-gap` means the REQ that *would* drive a task does not yet exist. Therefore no task to set running. The LLM should `amend-spec` first; once the new REQ is locked, planning will yield a task, and only then can `fix-impl` target it. |
| `fix-test` | **incoherent** | Same argument as `fix-impl`: no REQ ⇒ no task ⇒ no `task.execution.red.status` to flip. Reach the REQ first. |
| `defer` | typical | "We see the gap; we will not fix it this run." Records into `reconcile.drift`. |
| `backlog` | typical | "We see the gap; carry to a future feature / lessons." |

### 3.2 `spec-defect` — spec is wrong (not silent)

| action | risk | rationale |
|---|---|---|
| `amend-spec` | typical | Canonical resolution: the REQ/SCEN exists but says the wrong thing. Edit it via `spec add-*` (overwrite by raising and editing) or full re-submit. |
| `amend-tasks` | unusual | Edge case: spec is wrong, but the existing tasks are still salvageable with a plan-time tweak. Requires reason because amending tasks without first fixing the spec leaves the spec as a misleading anchor for future iterations. |
| `fix-impl` | unusual | Edge case: spec is wrong but the implementation already does the right thing (the spec was wrong about the desired behavior; the impl matches the intended behavior). Rare but legitimate. Requires reason to call this out so reviewers verify the spec really is the wrong one. |
| `fix-test` | unusual | Symmetric edge case: spec is wrong, test was written against the wrong spec, fix the test to match the corrected spec. Requires reason to confirm the test is the one drifting, not the impl. |
| `defer` | typical | Defer the spec fix into drift / next iteration. |
| `backlog` | typical | Carry to lessons. |

### 3.3 `impl-defect` — implementation is wrong

| action | risk | rationale |
|---|---|---|
| `amend-spec` | unusual | Usually impl bugs are fixed by changing impl. But sometimes a closer look at the bug reveals the spec was ambiguous and the impl chose a defensible interpretation — fixing the spec to disambiguate is the higher-leverage move. Requires reason so reviewers can confirm the bug was actually a spec ambiguity, not an impl bug being papered over. |
| `amend-tasks` | typical | Common case: the impl is wrong because the task plan missed a sub-task. Replan tasks. |
| `fix-impl` | typical | Canonical resolution: change the impl. `task.execution.implement.status` flips to running. |
| `fix-test` | unusual | Sometimes the impl bug only surfaces when the test is strengthened first. Requires reason to justify why touching the test (rather than the impl) is the right entry point. |
| `defer` | typical | Known impl defect, accepted risk for this run. |
| `backlog` | typical | Carry to future feature. |

### 3.4 `test-defect` — test (or test environment) is wrong

| action | risk | rationale |
|---|---|---|
| `amend-spec` | unusual | Like §3.3 `impl-defect × amend-spec`: a "test defect" may turn out to be a spec ambiguity that produced an ambiguous test. Requires reason. |
| `amend-tasks` | typical | Common: missing test task; replan. |
| `fix-impl` | unusual | Edge: the test is failing because the impl is also slightly wrong, and the right fix is impl-side (not test-side). Requires reason so reviewer confirms the test really is fine. |
| `fix-test` | typical | Canonical resolution: change the test. |
| `defer` | typical | Known test defect, accept. |
| `backlog` | typical | Carry. |

### 3.5 `new-scope` — out of current scope, needs new task

Structurally adjacent to `spec-gap`: there is no existing REQ/SCEN
covering this scope, just a recognition that scope expansion is
needed.

| action | risk | rationale |
|---|---|---|
| `amend-spec` | typical | New scope ⇒ new REQ ⇒ amend spec to introduce it. |
| `amend-tasks` | typical | Equally canonical: new scope ⇒ new task entry. Both `amend-spec` and `amend-tasks` are direct paths into adding scope; which one comes first depends on whether the new scope already has REQ coverage in mind or needs both REQ and task. |
| `fix-impl` | **incoherent** | Same target-determinacy argument as `spec-gap × fix-impl`: there is no task yet to flip `execution.implement.status` on. Add the task (`amend-tasks`) and the REQ (`amend-spec`) first. |
| `fix-test` | **incoherent** | Same: no task ⇒ no `execution.red.status` to flip. |
| `defer` | typical | "We see new scope, not fixing this run." |
| `backlog` | typical | "Defer to a future feature; record." |

### 3.6 `risk-escalation` — complexity exceeds current profile

This category is distinct from the four defect categories: it
doesn't say the spec/impl/test is wrong, only that the work is
heavier than the chosen ceremony anticipated. The matrix row
matches `impl-defect` closely because the most common resolution
is "amend tasks to add the missing rigor steps", but escalation
can also reshape the spec.

| action | risk | rationale |
|---|---|---|
| `amend-spec` | unusual | If escalation reveals that the spec was understating an axis (e.g. concurrency, security), amend the spec. Requires reason to surface this — escalation that reshapes the spec is rare and high-impact. |
| `amend-tasks` | typical | Canonical resolution: escalation widens the task plan (add review steps / extra evidence kinds / etc.). |
| `fix-impl` | unusual | Escalation generally drives plan changes, not direct impl edits. Requires reason for cases where the escalation directly identifies an impl flaw. |
| `fix-test` | unusual | Symmetric to `fix-impl`. |
| `defer` | typical | "Acknowledge escalation, do not raise ceremony this run." |
| `backlog` | typical | Carry. |

## 4. How loaf-skill consumes this matrix

A workflow skill (Wang / GSD / openspec / ad-hoc) about to call
`loaf finding raise` SHOULD:

1. Determine the intended `category` and `action` from the LLM's
   reasoning.
2. Look up the cell in `FINDING_ACTION_GRID`
   (`src/core/finding-schema.ts` or this document's matrix).
3. If `typical`: invoke `loaf finding raise` directly.
4. If `unusual`: invoke `loaf finding raise --reason "<≥20 chars
   explaining why this non-typical combination applies>"`.
5. If `incoherent`: do **not** invoke `finding raise`. Surface a
   skill-level prompt to the LLM: "the combination
   `<category> × <action>` is structurally invalid; the spec must
   be amended first. Suggesting `amend-spec` (or `amend-tasks`
   for `new-scope`)." Then let the LLM produce a corrected
   finding.

Skipping the skill-side pre-check is allowed (the CLI will still
emit the correct exit 2 with a fix nudge), but pre-checking saves
one round-trip per incoherent attempt.

## 5. Cross-references

- Decision: `adr/0004-moni-audit-resolution.md` §A7 (the grid
  itself) + §R3 (rejection of the "all warn, no block" alternative)
- Machine binding: `src/core/finding-schema.ts` `FindingActionRisk` enum +
  `FINDING_ACTION_GRID` const + `FINDING_UNUSUAL_REASON_MIN_LENGTH`
- Protocol behavior: `protocol.md` §4.5 (raise enforcement) +
  §4.6 (`reconcile.json.unusual_findings_count`)
- Companion reference: `references/incremental-construction.md`
  for the broader Tier 1 mutator design principles this matrix
  participates in
