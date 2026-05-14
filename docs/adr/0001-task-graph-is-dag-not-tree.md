# ADR-0001 — Task graph is DAG, not tree

- Status: **Accepted**
- Date: 2026-05-12
- Scope: loaf-cli v1 (rev 3.1) — task model + workflow extensibility
- Supersedes: none
- Related: `protocol.md` §15 (v1 done-when freeze), §16 (v1 non-goals),
  §19 (三层架构); `schemas.ts` L658-733 (TaskBase / Task / TasksJson);
  `WangSnapshots/wang-workflow.md` (source workflow that triggered review)

## Context

A grilling pass against Wang Agentic Governance SDD Workflow surfaced an
apparent gap in loaf-cli v1 (rev 3.1): Wang describes hierarchical task
structure (split parent TK → child TKs → close parent after all children
done + parent integration verify). loaf-cli's `tasks.json` is flat
`Task[]` with only `depends_on: TaskId[]`.

Two candidate fixes were explored:

1. Add `parent_task_id?: TaskId` + `status: "split"` + three Zod refines
   (parent-of-non-leaf, all-children-done close gate, drives bottom-up
   fold). N-ary tree adjacency list, post-order traversal.
2. Rename (1) to `leaf_id` — cosmetic variant of (1).

Adjacent friction surfaced in the same session: Wang's `Sprint` container
also has no loaf-cli home, and rev 3.1's `decomposition_preference` /
`max_tasks_warning_threshold` advisory fields were questioned as
protocol-layer overreach.

## Decision

Task graph is a **DAG**, not a tree. v1 schema is unchanged.

Hierarchical workflow patterns are expressed via existing DAG mechanisms:

- Leaf tasks: independent, no `depends_on` (or only external deps)
- "Parent integration verify": a normal task with
  `depends_on: [leaf1, leaf2, ...]` and `kind: structural` (or other
  appropriate kind). Reuses normal task verify machinery — no new step
  enum, no new kind, no new gate.
- Grouping metadata: existing `labels: string[]` with namespace convention
  (`group:G-007`, `integration`). Namespace registry is documented in
  **loaf-skill**, not the protocol.

Runtime split (Wang's "task too large, decompose mid-execution") maps to:

- Original task → `status: "abandoned"` (existing enum value)
- New leaf tasks + integration task created via `amend-tasks` finding
  action (§1 principle 13: post-lock scope changes require finding)
- Original task's evidence remains in `evidence.jsonl` (append-only
  invariant preserved); reconcile coverage no longer counts the
  abandoned task — children carry coverage

Adjacent decisions absorbed here:

- **Sprint container**: project-management constructs (Sprint, milestone,
  epic) are explicitly NOT modeled in loaf-cli OR loaf-skill. A Sprint is
  a PM workflow, not an SDD workflow. Workflow skills that need Sprint
  semantics maintain their own state outside both layers
  (e.g. `.wang/sprint-2026-W19.json` or external tracker).
- **`decomposition_preference` / `max_tasks_warning_threshold`**: these
  rev 3.1 fields belong to skill content, not protocol shape (§1
  principle 14). Removal from v1 is a separate confirmation-boundary
  decision (not made by this ADR) — see "Open follow-ups" below.

## Why this is the right call

- v1 schema unchanged → rev 3.1 freeze (§15 done-when) preserved without
  a "we'll RC again" exception
- "One adapter = hypothetical seam": only Wang is the would-be user of
  first-class hierarchical tasks; no second workflow skill yet justifies
  protocol-level support
- Hyrum's Law: once `parent_task_id` ships, every consumer encodes it,
  v2 cannot remove without breaking world. DAG + `labels[]` namespace is
  evolvable in loaf-skill without protocol churn.
- DAG ⊇ tree (graph theory): any hierarchical structure has an
  expressively equivalent DAG form. The tree fields would have been
  redundant.
- Three-layer architecture (§19) intact: shape transformation
  (hierarchical → DAG flatten) belongs in loaf-skill, not protocol core.

## Consequences

- 3rd-party workflow skills (Wang, GSD, openspec, custom) must emit
  flat DAG `tasks.json`. To avoid each skill reimplementing the
  hierarchical-intent → DAG transformation, **loaf-skill provides a
  shared `flatten` helper**. See `references/loaf-skill-helpers.md`.
- Wang flow loops map to existing loaf-cli machinery as follows:
  | Wang loop | loaf-cli v1 home |
  |---|---|
  | Sprint main loop | feature TRIAGE → SPEC → EXECUTE → VERIFY → DONE |
  | Pre-Sprint asset builder | SPEC.{proposal, spec, plan, design, tasks} |
  | `CURSOR` resume point | `state.json` + `resume-pack.json` |
  | `TASKS` / leaf `TK` | `tasks.json` task entries |
  | Scheduler `serial` | `depends_on` + step state machine |
  | Scheduler `batch` parallel | **not supported** (§16 non-goal); skill degrades to serial |
  | Pre-check gate | `loaf advance` + spec-lock / verify-accept gates |
  | Review loop + round fuse | VERIFY checklist + `state.iteration`; fuse is skill-level |
  | Parallel review (arch/security) | skill emits multiple findings; no protocol fork |
  | Rule-candidate hardening | lessons.md (no auto-promote — §16 non-goal) |
  | State sync law | `state.json` + `reconcile.json` |
  | Sprint exit / next sprint | feature DONE.delivered; PM concern, outside scope |
- The broader implication (worth recording explicitly): **v1 (rev 3.1) is
  already sufficient for Wang-class hierarchical SDD workflows.** Every
  apparent gap surfaced during the grilling pass either (a) maps to
  existing protocol mechanisms via DAG expression, (b) is explicit v1
  non-goal that skills must emulate, or (c) is PM-layer concern outside
  loaf's scope entirely. The "v1 protocol is missing something" intuition
  that triggered this review was about discovering correct mapping,
  not about a real protocol shortfall.

## Alternatives considered

### A. Add `parent_task_id` + `status: "split"` + 3 refines

Rejected:

- Violates "One adapter = hypothetical seam" — only Wang would use it
- Breaks v1 rev 3.1 freeze (§15 done-when)
- Permanent Hyrum's Law surface: once shipped, cannot remove in v2
- Conflicts with §19 three-layer split — flatten is shape transformation,
  belongs to loaf-skill, not protocol

### B. Same as A, rename to `leaf_id`

Rejected — cosmetic. Either it duplicates topology information (single
source of truth violation, §1 principle 2) or it duplicates what
`labels: ["group:G-007"]` already expresses.

### C. Tree-as-data-model with thin schema (only `parent_task_id` + status)

Rejected — even with refines pushed to `transitions.ts`, the protocol
still leaks tree semantics. DAG with `depends_on` is identical
expressive power with zero new concepts. The post-order traversal
algorithm is also unnecessary: integration tasks make their own close
condition explicit via `depends_on`, no algorithm required.

## Follow-ups

Executed inline at this ADR's acceptance (2026-05-12):

- ✅ **Removed `decomposition_preference` + `max_tasks_warning_threshold`
  from rev 3.1** → rev 3.2 cleanup applied to `schemas.ts` (constitution
  block + revision history), `protocol.md` (§4.11 example + rev 3.2
  header note), `protocol.html` (title + pill + changelog + example),
  `loaf.config.example.json` (example). `verify_cadence` reject
  rationale preserved as NOTE in `schemas.ts` so future grilling does
  not re-propose it.
- ✅ **Memory `project_loaf_skill_decomposition_coarse.md` updated**:
  shifted from "loaf-cli `constitution.decomposition_preference` field"
  to "loaf-skill SPEC prompt default", with explicit warning that the
  config field no longer exists and `verify_cadence` is permanently
  rejected. MEMORY.md index line updated to match.

Still pending (outside this ADR's scope):

- **loaf-skill plugin scaffolding**: this ADR commits loaf-skill to
  carrying `flatten` + soft-suggestion + decomposition default. None
  exist yet. `references/loaf-skill-helpers.md` is the forward-looking
  design note; actual skill creation happens after v1 ships and
  v1.0.0 GA is tagged per §15 done-when criteria.
