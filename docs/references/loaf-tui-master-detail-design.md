# `loaf tui` Master-Detail Design Note

Status: implemented reference with explicit F-026 disposition.

Implementation disposition (2026-07-27):

- The project/feature/session render plan, active/all toggle, time/status sort,
  folding, and Enter/Esc lazy detail path are implemented.
- TUI and Board share only the non-trivial
  `done > blocked > running > idle` classifier. A broader view-model extraction
  stays closed until another independently changing consumer repeats policy.
- Pending-head kind is additive read-only display data. Gate/profile
  escalation is presented as a human decision; ask/spec/finding is presented
  as a question. Queue-depth semantics are unchanged.
- The earlier `[d]`, pending popup, archive hotkey, automatic polling, and
  registry-vs-runtime heartbeat stale proposals are retired. Snapshot
  stale/missing detail remains owned by the projection loader; workflow
  mutation remains owned by explicit CLI commands.

## Context

The current `loaf tui` is a thin Ink surface over registry rows from
`~/.loaf/registry/<uuid>.json`. It renders a flat four-column table:
`LABEL / PHASE.SUB / ITER / STATUS`.

The next step is a master-detail TUI with these confirmed requirements:

- Active filter: hide `DONE.*` terminal sessions by default; toggle to show all.
- Hierarchy: `project(cwd) > feature > session`.
- One feature can have many sessions.
- Sort dimensions: updated time and status.
- Group dimensions: project and feature.
- No separate "by session" grouping axis; each leaf row is already a session.

The implementation must preserve the existing layering rule: Ink components stay
thin; status precedence, grouping, filtering, sorting, label truncation, width
calculation, and detail-state classification live in pure helpers.

## Decision 1: List Organization Model

Options:

- **A. Flat list with switchable sort keys**
- **B. Grouped/tree list: project -> feature -> sessions, with group headers and folding**

Recommendation: **B, but model it as a flat render plan of typed rows.**

Use a pure helper to transform `SessionRow[]` into a `TuiListItem[]` render plan:

```ts
type TuiListItem =
  | { kind: "project"; cwd: string; visible_session_count: number; collapsed: boolean }
  | { kind: "feature"; cwd: string; feature: string; visible_session_count: number; collapsed: boolean }
  | { kind: "session"; row: SessionRow; detail_status: "unknown" | "loading" | "ready" | "stale" | "missing" | "error" };
```

The Ink component should only render the current plan, maintain selection/fold
state, and dispatch hotkeys. Filtering, grouping, sorting, and row labels should
be deterministic pure functions.

### Why B

- The confirmed hierarchy is project-first and feature-first; a flat list makes
  the user rediscover that hierarchy on every scan.
- Repeated starts for the same feature are a real case, not an edge case. A flat
  list turns hundreds of same-feature sessions into visual noise.
- Group headers give a cheap answer to "which project/feature am I in?" without
  loading detail projections.
- Folding lets old or noisy features stay available without occupying the whole
  viewport.
- Status sorting can still exist inside each group, so B does not remove the
  useful part of A.

### Tradeoffs

- B adds interaction state: selected row, project folds, feature folds, active
  filter, and sort mode. Keep this state presentation-local and serializable;
  do not push it into the registry or feature projections.
- B needs a stable row identity for every render item. Use deterministic keys:
  `project:${cwd}`, `feature:${cwd}:${feature}`, `session:${session_id}`.
- B can hide information behind folds. Default folds should therefore be
  conservative: active project/feature groups expanded, terminal-only groups
  hidden by the active filter unless "show all" is enabled.
- Group headers consume vertical space. This is acceptable because they reduce
  cognitive load in the high-duplication case; it is still better than forcing
  every row to repeat project/feature context.

### Sorting and Filtering Semantics

Apply transformations in this order:

1. Read registry rows and warnings.
2. Classify active vs terminal from `sub_state.startsWith("DONE.")`.
3. Apply the active filter.
4. Group by canonical `cwd`, then `feature`.
5. Sort groups by their most recent visible session by default.
6. Sort sessions within each feature by updated time descending by default.
7. When status sort is enabled, sort sessions by status bucket first, then
   updated time descending.

Status sort should be a coarse UI bucket, not a new protocol state:

```ts
type TuiStatusBucket = "blocked" | "running" | "idle" | "done";
```

`blocked` comes from pending queue depth, `running` from active tasks, `done`
from `DONE.*`, and `idle` from the remaining sub-states. This mirrors the
current `STATUS` precedence without creating a second source of truth.

## Decision 2: Detail Layout

Options:

- **a. Persistent top/bottom split**
- **b. Persistent left/right split**
- **c. Full-screen drill-down with Enter/Esc**

Recommendation: **c for the first master-detail release.**

Use `Enter` to open the selected session detail as a full-screen detail view and
`Esc` to return to the master list. Keep the list selection stable when returning
from detail.

### Why c

- Narrow terminals are a first-class constraint. Below 100 columns, a left/right
  split makes both list and detail cramped.
- Top/bottom split is worse for this product shape because the master list is
  the density-critical surface; it would cut the visible session count in half
  precisely when the user has many sessions.
- Lazy detail loading is simpler and safer: load projections only after the user
  asks for a detail view.
- `loadProjections` failures stay local to one selected session. A stale,
  missing, or corrupt detail can render an error detail screen without taking
  down the master list.
- The existing `loaf status --feature` detail projection already fits a whole
  screen better than a narrow side pane.

### Tradeoffs

- c is less "always visible" than a classic master-detail split. The payoff is
  lower layout risk and better behavior in narrow terminals.
- c requires one extra keystroke to compare list and detail. Preserve selection
  and show enough summary fields in the master row to reduce unnecessary drills.
- Wide terminals could benefit from b later. Treat b as an additive enhancement:
  if terminal width is at least 100 columns, the TUI can offer a preview pane,
  but the Enter/Esc full-screen path should remain the baseline behavior.

### Rejected Default: Top/Bottom Split

Top/bottom split should not be the default. It consumes the scarce vertical
dimension, makes group headers more expensive, and still fails to provide enough
horizontal room for tasks/evidence/findings summaries.

### Rejected Default: Left/Right Split

Left/right split should not be the first release default. It creates responsive
layout complexity before the detail interaction and stale-error states are
proven. It is a reasonable future enhancement only after the pure detail view
model is stable.

## Detail Loading and Error Handling

Each session row has registry metadata immediately, but detail is lazy.

Detail loading should resolve the selected row's feature directory and call:

```ts
loadProjections({
  feature_dir,
  kinds: ["state", "tasks", "evidence", "findings", "pending"],
});
```

The TUI should classify loader outcomes into display states:

- `ready`: render projected state, task count, evidence count, finding count,
  pending count, and selected high-signal summaries.
- `missing`: render a no-session/missing detail for a registry row whose feature
  directory no longer has a valid session.
- `stale`: render the stale reason and the existing rebuild hint.
- `error`: render a short unexpected-error envelope.

The master list should remain usable in all cases. A failed detail load is a
row-local detail state, not a process-level failure.

## Orphan and Stale Session Policy

Registry warnings should be visible but not fatal:

- `orphan-cwd`: keep the registry row in the all-project view with an orphan
  marker; exclude it from current-cwd filtering.
- corrupt or schema-invalid registry files: keep them out of the session tree,
  but show an aggregate warning line in the footer.
- stale snapshot on detail load: keep the session row, mark its detail as stale,
  and show the rebuild hint in the detail screen.

This preserves the current recovery value of the registry: the TUI helps users
find and diagnose old sessions instead of silently dropping them.

## Proposed Key Map

- `q` / `Ctrl-C`: quit.
- `r`: reload registry.
- `a`: toggle active-only vs all sessions.
- `s`: toggle sort mode between updated time and status.
- `Enter`: open selected session detail.
- `Esc`: return from detail to master list; quit only when already on master.
- `Space`: toggle fold on selected project or feature header.

Selectors and machine-readable output should remain rejected for `loaf tui`.
Scriptable output continues to belong to `loaf sessions list --format json`.

## Implementation Boundary

Stable helpers:

- active filtering.
- group construction.
- group/session sorting.
- status bucket classification.
- render-plan construction.
- detail loader outcome classification.
- width calculation and truncation.

Presentation component:

- selection cursor.
- fold state.
- active/all toggle state.
- sort mode state.
- loading state for the selected detail.
- rendering the helper-produced rows/screens.

This keeps the current Stable/Presentation boundary intact. Tests should target
the helper contracts and CLI guards; Ink render tests are optional unless a
specific interaction regression appears.

## Summary

- Use **B** for the master list: grouped/tree organization, represented as a
  pure flat render plan.
- Use **c** for the first detail layout: Enter/Esc full-screen drill-down.
- Keep detail lazy and row-local.
- Preserve `loaf tui` as interactive-only; keep scriptable session output in
  `loaf sessions list`.
- Treat wide-screen left/right preview as a later additive feature, not the
  baseline contract.
