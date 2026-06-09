# `loaf prune` — session GC (recoverable trash + audited purge)

**Status:** IMPLEMENTED (slices 1–7) on `feat/prune-gc`; codex-signed across the
prune-audit rounds (core 1–4: 6 BLOCK rounds → LGTM; 6a partial-failure BLOCK → LGTM;
6b restore --dry-run BLOCK → LGTM).
**Type:** new top-level command (destructive ops; PUBLIC_IMPACT=true).
**Reviewed with:** the `create-cli` rubric — the 3 HIGH findings + M1/M2 are folded in
below (they are MVP requirements, not follow-ups).

## As-built (what landed)

- core: `src/cli/prune/{resolve,execute,restore,fs-move,audit,trash-gc,trash-ts}.ts`
  — status + ABSOLUTE lock gate, recoverable-trash execute (manifest-first,
  move-then-deregister, rollback on registry-move failure, bucket preserved on
  double-fault), restore (source/dest preflight, all-or-nothing, --dry-run preview),
  append-only audit log, retention sweep, fs-safe timestamp.
- surface: `src/cli/commands/prune.tsx` — `loaf prune <scope>` (preview/--yes/
  --force/--purge, partial failure → exit 2 `PRUNE_PARTIAL_FAILURE`), `prune restore
  <id> [--at]`, `--history`, `--trash --older-than <N>d`; honors the global
  `--session` / `--dry-run`. one-way resolve→execute; cwd realpath symmetry in resolve.
- catalog: `PRUNE_RESTORE_{NOT_FOUND,AMBIGUOUS,INCOMPLETE}` + `PRUNE_PATH_OCCUPIED` +
  `PRUNE_PARTIAL_FAILURE` in DiagnosticCode + ERROR_CATALOG + i18n; protocol §10.8 row.
- tests: prune-{resolve,execute,restore,audit,trash-gc,cli,help}.test.ts.

**Still tracked (non-blocking, post-v0.5.0):** `--history` surfacing for EACCES /
corrupt log lines (currently collapses to empty / skips silently); an optional
`loaf doctor` recovery for a retained double-fault bucket (manual move documented).

## Why

`~/.loaf/registry/` accumulates one entry per session with **no GC** (measured: 383
entries, many orphaned — the registry entry survives after its project's
`.loaf/<feature>/` dir is gone). Every `sessions list` / `board` walks the whole set.
There is no way to reclaim disk or declutter.

### The reframe (load-bearing)

loaf already models **retire**: `archive` / `abandon` / `deliver` push a session to a
terminal `DONE.*` state — recorded in the journal, replayable, on disk. What is missing
is **purge**: physically removing the registry entry + feature dir. So `prune` is a
**purge/GC op, NOT a journal operation** — it deletes journals, it does not append.
It is an operator command (sibling to `doctor`), bypassing the mutator.

`prune` is the name (not `clear` — ambiguous; not `gc` — opaque). It pairs with the
existing retire verbs: you `archive`/`abandon` (journaled) THEN `prune` (reclaim).

## Command tree / USAGE

```
loaf prune (--session <id> | --in-cwd | --project <path> | --all | --orphans) [flags]
loaf prune restore <id>
loaf prune --trash --older-than <N>d [--purge]      # trash retention GC
loaf prune --history                                  # query the prune audit log
```

Exactly one scope selector is required (mutually exclusive). No scope → `USAGE` (exit 2),
never a silent default.

## Scope selectors (session ⊂ project ⊂ global)

| selector | set |
|---|---|
| `--session <uuid\|prefix>` | one session |
| `--in-cwd` | sessions whose registered cwd == current cwd (mirrors `board --in-cwd`) |
| `--project <path>` | sessions whose registered cwd == `<path>` |
| `--all` | the entire registry (global, across all projects) |
| `--orphans` | registry-only: entries whose feature dir no longer exists. Composable with `--project`/`--all` to bound which orphans. |

## Flags

| flag | type | default | meaning |
|---|---|---|---|
| `--yes` | bool | false | Execute. **Absent ⇒ preview only (this IS the dry run).** |
| `--dry-run` | bool | false | Force preview; **forbids execution even with `--yes`** (belt-and-suspenders; resolves the H2 collision with loaf's global `--dry-run`). |
| `--force` | bool | false | Widen the status gate to include **active / in-flight** sessions. Narrow: it ONLY overrides the terminal gate. |
| `--purge` | bool | false | Hard `rm -rf` instead of the default move-to-trash. Irreversible. |
| `--format <text\|json>` | enum | text | Standard loaf presentation flag (NOT `--json` — H1). |
| `--older-than <N>d` | dur | — | (trash mode) retention cutoff. |

## Semantics

### Status gate (terminal-only default — chosen)
- Default set = terminal sessions only: `DONE.delivered` / `DONE.archived` / `DONE.abandoned`.
- Active sessions (`TRIAGE.*` / `SPEC.*` / `EXECUTE.*` / `VERIFY.*` / `SETTLE.*`) are
  **skipped** unless `--force`.
- **The `.lock` is an ABSOLUTE gate** (H3): a session whose per-feature `.lock` is held
  has a live writer → always skipped (`reason: "locked"`), **even with `--force`**.
  `--force` widens the *status* gate, never the lock gate.

### Two-axis safety (H3)
`--yes` (execute) and `--force` (include active) are **orthogonal**. Pruning an active
session requires **both** (`--force --yes`). `--force` must never imply `--yes`.

### Delete = recoverable trash (default — chosen)
- Move `~/.loaf/registry/<uuid>.json` AND `<cwd>/.loaf/<feature>/` to
  `~/.loaf/trash/<ISO-ts>/<uuid>/` (both preserved).
- **Operation order (M5):** move the feature dir to trash FIRST, then remove the registry
  entry. A crash mid-op then leaves a registry entry pointing at a moved dir (= a
  recoverable orphan, cleanable by `--orphans`), NOT a dangling entry over a live dir.
- `--purge` skips trash and hard-deletes (irreversible). Help + preview must state the
  default is MOVE-to-trash (L2).
- Unreachable feature dir (cross-machine path / already gone) ⇒ degrade to registry-only
  removal (still trash the registry entry json).

### Trash retention (M1 — MVP, not follow-up)
Recoverable trash without GC just relocates the unbounded growth. `loaf prune --trash
--older-than <N>d` empties old trash (default retention, e.g. 30d, documented). `--purge`
on trash mode hard-removes; absent, it is itself a no-op-safe report.

### Audit log (M2 — MVP, philosophical consistency)
A kernel that journals every state change must not have an **unaudited delete**. Each
executed prune appends one line to `~/.loaf/prune-log.jsonl` (append-only):
`{at, scope, mode: "trash"|"purge", pruned: [uuid…], skipped: [{uuid, reason}], actor}`.
`loaf prune --history` reads it back. The trash is passive recovery; the log is the
queryable record.

### restore (M4)
- Trash keyed by `<ts>/<uuid>`. `loaf prune restore <uuid>` restores the **latest**
  trashing; if multiple exist, error `PRUNE_RESTORE_AMBIGUOUS` listing timestamps
  (mirrors the existing `SESSION_SHORT_AMBIGUOUS` pattern) — pick with `--at <ts>`.
- Restore moves registry entry + feature dir back; if the original cwd path is occupied,
  refuse (no silent overwrite).

## Output & exit codes

- stdout = the report (human text default; `--format json` for the stable machine shape).
- JSON shape: `{ ok, scope, mode, dry_run, pruned: [{uuid, feature, cwd, sub_state, size}],
  skipped: [{uuid, reason: "active"|"locked"|"non-terminal"}], orphans_removed: [uuid…] }`.
- Preview (no `--yes`) sets `dry_run: true`, `pruned` = would-prune set, zero side effects.
- Errors → stderr, exit 2. Exit map:
  | code | exit | when |
  |---|---|---|
  | `USAGE` | 2 | no scope / >1 scope / bad selector |
  | `PRUNE_NOTHING_MATCHED` | 0 | empty set (report, not error) |
  | `PRUNE_RESTORE_AMBIGUOUS` | 2 | restore uuid hits multiple trashings |
  | `PRUNE_RESTORE_NOT_FOUND` | 2 | restore uuid not in trash |
  | `PRUNE_PATH_OCCUPIED` | 2 | restore target cwd path occupied |
  | (unexpected) | 3 | fs error outside the taxonomy |

## Architecture / layering (L1 — cross-ref `cli-layering-gates`)

- **Core (pure, unit-tested):** `src/cli/prune/` — resolve target set from the registry,
  apply status + lock gates, compute the trash plan, execute move/rm, write the audit log.
  No arg-parsing, no output formatting, no `ctx`.
- **Presentation:** `src/cli/commands/prune.tsx` — `registerPrune(program, ctx, deps)`
  (W8 family pattern). Parses flags → calls the core → routes `ctx.success` / `ctx.failure`.
  Bypasses the mutator (deletes journals; like `doctor`). No actor (no journal append) —
  but the audit log records the operator from `$LOAF_USER`/git for the `actor` field.

## Test plan (RED-first)

- scope resolution: each selector → correct set; no-scope/multi-scope → USAGE.
- status gate: active skipped by default; `--force` includes active; **`--force` never
  bypasses lock** (locked → skipped even with `--force --yes`).
- preview: no `--yes` ⇒ zero side effects + `dry_run:true`; `--dry-run --yes` ⇒ still no-op.
- trash round-trip: prune → restore restores registry entry + dir byte-identical.
- restore ambiguity: two trashings of one uuid → `PRUNE_RESTORE_AMBIGUOUS`.
- orphans: `--orphans` removes only entries with missing dirs; leaves live ones.
- partial failure (M5): move-ok + deregister-fail injected → lands in recoverable state.
- audit log: executed prune appends a line; `--history` reads it; preview writes nothing.
- `--format json` shape snapshot (the machine contract).
- trash retention: `--trash --older-than` removes only older entries.

## Out of scope / follow-ups
- Interactive multi-select TUI for prune (board already visualizes; prune stays scriptable).
- Cross-machine prune (registry entries with unreachable cwd degrade to registry-only).
- Auto-prune policy / scheduled GC — explicit invocation only for v1.

## Sequencing
Ship AFTER the current release (W8 + board). `prune` is a new destructive surface deserving
its own RED-first cycle + codex sign-off; it must not be crammed into this release.
