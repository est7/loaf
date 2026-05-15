# loaf-cli v0.1.0 Implementation Plan

**Status**: Active, post ADR-0005 accept-with-gates verdict
**Scope**: Single typed journal as SSoT (γ truth model) — replaces v0.0.x N-file design
**Budget**: 25–27 day (20.5d base + 25–30% buffer; see ADR-0005 §6)
**Authoritative design**: [`docs/adr/0005-truth-model-single-typed-journal.md`](adr/0005-truth-model-single-typed-journal.md)

> **Read this first**: ADR-0005 §10 (Implementation Gates) + §3.5 (10-step crash contract) + §5
> (migration + spike→core promote). Plan.md only sequences and counts; it does **not** restate
> design. Design drift between plan.md and ADR-0005 is always resolved in favor of ADR-0005.

---

## 0. Scope statement

This plan covers the journal-SSoT refactor only — the body of work ADR-0005 sizes at 25–27d.
Anything tagged `v0.1.x` / `v0.2` in ADR-0005 §9 (signature scheme, cross-feature audit, snapshot
checkpoints, compaction, watch API) is **out of scope** here and does not block v0.1.0 release.

**v0.1.0 release blockers** (ADR-0005 §6, §10 milestone-gating note):

- §4.15 perf benchmark (10K / 100K entry rebuild, `tests/core/perf.test.ts`)
- §5.2 v0.0.x → v0.1.0 lossy snapshot import (`tests/core/v0.0.x-migration.test.ts`)

Both ship inside Stage 5–6. Neither is post-implementation cleanup.

---

## 1. Stage overview

Per-stage budgets below absorb both Journal-SSoT-refactor items and Cascade-decision items
into the stage they land in (no separate "cascade interleave" row). Mapping back to ADR-0005
§6 categorical totals (15.5d Journal SSoT + 5.0d Cascade = 20.5d base) is preserved by
§3.2 below.

| Stage | Body of work                                                                                  | Day  | Gate landed | Lead test files                                                  |
|-------|-----------------------------------------------------------------------------------------------|------|-------------|------------------------------------------------------------------|
| 0     | plan.md + protocol.md §5.1 diff + schemas.ts rev 5.0 (+ audit follow-up + H1 doc cleanup)     | —    | —           | (doc only; complete)                                             |
| 1     | journal envelope + journal-append + step 5 final validate + N16 entry_schema_version          | 3.0  | #2          | `final-validation.test.ts`, `journal-atomicity.test.ts`, `per-entry-upcast.test.ts` |
| 2     | reducer preflight + `validateTransition` helper + per-kind matrix + fixture builder + B1 actor authority + B3 tasks_amended + M1 tasks_planned + M3 strict_drift | 6.5  | #1          | `per-kind-substate.test.ts`, `preflight-validation.test.ts`, `actor-authority.test.ts`, `tasks-amended.test.ts`, `tasks-planned-claim.test.ts`, `strict-drift.test.ts` |
| 3     | projection rebuild + doctor + batch-aware tail recovery + H2 resolved_pending_log             | 2.0  | #4          | `tail-corruption.test.ts`, `batch-atomicity.test.ts`, `replay.test.ts`, `pending-resolved-log.test.ts` |
| 4     | sidecar transaction + orphan GC + final-validation harness                                    | 3.0  | #2 verified | `sidecar-crash.test.ts`, `final-validation.test.ts` (extended)   |
| 5     | migration sidecar import + crash table + Gate #3 enforcement                                  | 5.0  | #3          | `v0.0.x-migration.test.ts`                                       |
| 6     | reader staleness + read repair + §4.15 perf benchmark + rolling-checksum levels               | 1.0  | #5          | `perf.test.ts`, `reader-staleness.test.ts`                       |
|       | **Subtotal (base)** — Journal SSoT 15.5d + Cascade 5.0d, per ADR-0005 §6                      | **20.5** | —       |                                                                  |
|       | **Buffer (25–30% per ADR §6)**                                                                | **+4.5–6.5** | —   |                                                                  |
|       | **Total**                                                                                     | **25–27** | —      |                                                                  |

Stage 0 paperwork already landed across commits `aa24198` (plan + protocol.md), `48067ef`
(schemas.ts), and the `docs: ADR-0005 audit follow-up` commit (this batch); no day budget
remains.

---

## 2. Stage-by-stage detail

### Stage 0 — Foundation paperwork (complete)

**Deliverables**

- `docs/plan.md` — this file (✅ once committed).
- `docs/protocol.md` rev 4.3 → rev 5.0, per ADR-0005 §5.1:
  - §1 add bullet `15a` *single journal SSoT + reducer-derived projection*
  - §4.1 reword *state.json* as *派生投影*; §4.2–4.12 annotate authority layer
  - §10.8 command table: add `kind emitted` column, drop `--actor` flag, add 5 doctor sub-flags
  - §10.15 doctor checklist: add 7 new checks (orphan-attachment, tail-corruption, stale-tmp,
    snapshot-seq-mismatch, migration-v0.0.x, rolling-checksum-mismatch, sidecar-validation-drift)
  - §11.2 rewrite as 10-step crash contract (mirror ADR §3.5)
  - §13.1 authority layer 4-tier; §15 v1 done-when add schema_version freeze; §16 retract
    state.json-ES non-goal; §17 legacy comparison add truth-model evolution column
- `docs/schemas.ts` rev 4.3 → rev 5.0:
  - `SCHEMA_VERSION` 1 → 2
  - Add `JournalEntry`, `EntryKind`, `LongTextField`, `AttachmentRef`, `SignatureEnvelope`
    (reserve), `SnapshotMeta`, `MIGRATION_V1_TO_V2_BOUNDARY`, `ENTRY_SCHEMA_VERSIONS`,
    `UPCASTER_REGISTRY`
  - Rewrite §34 `CONCURRENCY_INVARIANTS` per ADR §3.5 (10-step + tail recovery batch-aware
    + checksum two-tier + step 5 final validate)

**Acceptance**: `bun run check` green (schemas.ts is a doc-as-code TS file, so typecheck
catches malformed Zod). protocol.md and schemas.ts re-read end-to-end against ADR §5.1 / §5.2
diff lists; no item left unticked.

**Gate landed**: none — this is foundation.

---

### Stage 1 — Journal core: schema + append + step 5 final validate + entry_schema_version (3.0d)

**Promote**: `src/spike/events.ts` → `src/core/journal-entry.ts`;
`src/spike/append.ts` → `src/core/journal-append.ts`.

**New / enriched**

- `journal-entry.ts`: envelope per ADR §3.2 — `seq`, `entry_id` (`JE-NNNNNN`), `at`, `actor`,
  `entry_schema_version`, `kind`, `payload`, optional batch markers (`batch_id`, `batch_index`,
  `batch_count`), optional `signature` (reserve). **No `prev_hash` / `rolling_checksum` on the
  envelope** — those live in `SnapshotMeta` (rolling_checksum chain) per ADR §3.1. Hard 64KB
  byte limit per entry; long fields via `LongTextField` (inline ≤ 8KB threshold) or
  `AttachmentRef` sidecar promoted at step 4.
- `journal-append.ts`: full 10-step transaction (ADR §3.5; mirror schemas.ts §34
  `transaction_order` exactly):
  1. acquire `.lock` (≤30s timeout → `LOCK_TIMEOUT`);
  2. read `journal.jsonl` tail + `snapshots/_meta.json`; fast-check
     `last_applied_seq` + `last_entry_offset` + `last_entry_line_hash`; mismatch → release
     lock + exit 2 `SNAPSHOT_STALE_REBUILD_REQUIRED`;
  3. **preflight validate** (CLI inject actor; Zod parse; cross-kind / sub_state /
     mutation_rights / actor refine; dry-run reducer apply on in-memory copy;
     assign `batch_id` / `batch_index` / `batch_count` if batch); abort on any failure (no
     step 4+ I/O);
  4. **prepare sidecar files** for any `LongTextField` over `sidecar_threshold_kb` or
     migration manifest refs (write `.tmp-<random>` → fsync file + parent → atomic rename
     → compute sha256 → embed final `AttachmentRef.{path,sha256,size}` into payload);
  5. **final validate** (Gate #2): re-Zod-parse with embedded final `AttachmentRef`;
     byte-size check (per entry ≤ 64KB; batch total ≤ 64KB); final dry-run reducer apply;
     reducer-visible result must equal step 3d output (sidecar refs embed deterministically);
     diff → abort + log `SIDECAR_VALIDATION_DRIFT` + clean sidecar tmp;
  6. **append journal entry/batch** — Gate #2 invariant: only the step-5-validated final-form
     entry may be appended; no re-serialization, no recompute of `AttachmentRef`, no edit to
     validated fields; single `write()` newline-separated; fsync `journal.jsonl`;
  7. **post-apply assert** (corruption check, not a rollback point): reducer apply final
     entries to in-memory state; on throw → log + flag `sidecar-validation-drift` in
     `loaf doctor`; journal is the fact, no rollback;
  8. **rebuild affected snapshots** (per-file tmp + atomic rename); update
     `snapshots/_meta.json` (`last_applied_seq`, `last_entry_offset`, `last_entry_line_hash`,
     `rolling_checksum` chain extend);
  9. **refresh registry projection** (`~/.loaf/registry/<id>.json`, tmp + rename);
  10. **release `.lock`** (unlink + close).
- **Gate #2 enforcement**: step 6 may only write the step-5-validated entry object. No
  re-serialization, no recompute of `AttachmentRef`, no edit to validated fields.

**Tests**

- `tests/core/journal-atomicity.test.ts` (promote from `tests/spike/atomicity.test.ts`)
- `tests/core/final-validation.test.ts` (new) — covers Gate #2 invariant: sidecar ref
  injection before step 5 → final-form entry equals validated entry on reducer-visible fields
- crash-injection fixtures for steps 4a/4b, 5, 6a/6b

**Acceptance**

- `vitest tests/core/journal-atomicity.test.ts tests/core/final-validation.test.ts` green
- `bun run typecheck` green
- Crash-injection runs leave no orphan tmp; doctor (when Stage 3 lands) can clean any residual

**Gate landed**: **#2 (Final-entry-only append)**.

---

### Stage 2 — Reducer preflight + transition helper + per-kind matrix + fixture builder + cascade B1/B3/M1/M3 (6.5d)

**Promote**: `src/spike/reducer.ts` → `src/core/reducer.ts`.

**New**

- `src/core/reducer/transition.ts` — **Gate #1**: shared
  `validateTransition(prevSubState, targetSubState, { ceremony, gate_kind?, actor })`.
  `event:phase_advanced` and `gate:decided` apply paths both call it; no per-kind if/else fork.
- `reducer.ts`:
  - Preflight: schema check + monotonic seq + actor authority (ADR §3.4 + §4.1) + per-kind
    invariants table (ADR §3.6 invariants table)
  - Apply: reducer.apply returns Result; preflight errors are typed
  - Per-kind invariants: every kind in ADR §3.3 namespace gets a row

**Tests**

- `tests/core/reducer.test.ts` (promote + extend per-kind matrix)
- `tests/core/preflight-validation.test.ts` (new) — full step-3 coverage
- `tests/core/per-kind-substate.test.ts` (new) — uses fixture builder below
- `tests/core/per-kind-fixture-builder.ts` (new) — full Cartesian matrix generator (1d
  carved out in §6 cascade subtotal)

**Acceptance**

- Per-kind matrix tests cover both `event:phase_advanced` and `gate:decided` going through
  `validateTransition`; greping the codebase shows no other transition logic outside that
  helper

**Gate landed**: **#1 (`validateTransition` shared helper)**.

---

### Stage 3 — Projection rebuild + doctor + batch-aware tail recovery + H2 resolved_pending_log (2.0d)

**Promote**

- `src/spike/snapshot.ts` → `src/core/snapshot.ts`
- `src/spike/project.ts` → `src/core/journal-bootstrap.ts`

**New / enriched**

- `journal-bootstrap.ts`: batch-aware tail recovery (Gate #4) — single partial entry truncates
  one line; partial batch (`batch_index < batch_count - 1` or batch-end partial) truncates
  the entire batch back to its first entry's pre-offset.
- `snapshot.ts`: 6 projection snapshots + `_meta.json` (last_seq, last_entry_line_hash,
  rolling_checksum). Two-tier checksum: fast (last entry line hash) + full (rolling chain,
  O(N) only on `doctor --verify-checksum`).
- `loaf doctor`: surface flags `--rebuild`, `--check-tail`, `--scope cwd`, `--verify-checksum`
  (the `--migrate-v2` flag lands in Stage 5).

**Tests**

- `tests/core/tail-corruption.test.ts` (new) — 7 scenarios from ADR §4.13 / Gate #4
- `tests/core/batch-atomicity.test.ts` (new) — 4 scenarios from ADR §4.16
- `tests/core/replay.test.ts` (promote + incremental replay coverage)

**Acceptance**: Gate #4 wire — recovery output table matches §4.13 expected actions on all
7 scenarios.

**Gate landed**: **#4 (Batch-aware tail recovery)**.

---

### Stage 4 — Sidecar transaction + orphan GC + final-validation harness (3.0d)

**New**

- Sidecar tmp+rename ladder integrated with step 4 of the 10-step transaction; orphan GC
  hook on `journal-append` step 9 and on `doctor` startup
- `final-validation.test.ts` extended with full crash-injection harness (rev 4 N20)
- `sidecar-crash.test.ts` (new) — covers H3 per-field sidecar + entry_id consistency

**Acceptance**

- Crash-inject between every step 2a–2d and 4a–4c never leaves journal entry without all
  declared sidecars resolvable; doctor cleans any orphan tmp inside one pass

**Gate landed**: **#2 verified** (end-to-end harness, not just unit-level invariant from
Stage 1).

---

### Stage 5 — v0.0.x migration sidecar import + crash table + Gate #3 (5.0d)

**New**

- `migration:snapshot_imported` kind handler (in reducer + journal-append):
  - Payload schema is `.strict()` Zod with only `AttachmentRef` manifest — Gate #3 enforced
    at schema layer
  - On apply: read sidecar files → verify sha256 against `AttachmentRef.sha256` → derive
    initial projection state (state / tasks / spec.md / evidence / findings / pending)
- `loaf doctor --migrate-v2`:
  - Step 1–7 per ADR §5.2 migration flow
  - Refuses on `MIGRATION_REPLAY_ATTEMPT` (journal already has migration entry)
  - Refuses on `MIGRATION_BACKUP_MISSING`
- Legacy `gate-decision` entries: project to derived evidence + derived gate views; never
  synthesize new `gate:decided` entries (rev 3 H "gate 双 truth" fix)

**Tests**

- `tests/core/v0.0.x-migration.test.ts` (new) — lossy snapshot import + sidecar ref
  consistency + Gate #3 schema rejection of inline artifact body + every row in §5.2 crash
  table

**Acceptance**

- Round-trip: v0.0.x fixture → `doctor --migrate-v2` → resulting journal + snapshots replay
  matches recorded v0.0.x state on all projection views
- Gate #3 schema rejection test passes: a malformed payload with inline `state` content
  (not `AttachmentRef`) is rejected at Zod parse, not at reducer

**Gate landed**: **#3 (Migration sidecar manifest-only)**.

---

### Stage 6 — Perf + checksum + reader staleness + read repair (1.0d)

**New**

- `tests/core/perf.test.ts` (promote + extend) — 10K and 100K entry rebuild benchmark;
  rolling-checksum incremental cost; full chain `--verify-checksum` cost
- `src/core/snapshot-reader.ts` — Gate #5 fast-check; on mismatch, exit 2
  `SNAPSHOT_STALE_REBUILD_REQUIRED`; **no silent cached-snapshot fallback**
- CLI footer `# snapshot as-of seq=N` on all read commands
- `tests/core/reader-staleness.test.ts` (new) — `_meta` mismatch → exit-code 2 verified

**Acceptance**

- Perf budget: 10K entry rebuild < 1s; 100K entry rebuild meets ADR §4.15 target (TBD
  numerical floor — pin during this stage; treat as v0.1.0 release blocker)
- Snapshot mismatch test exits 2; stderr names `loaf doctor --rebuild`

**Gate landed**: **#5 (Snapshot read fail-fast)**.

---

## 3. Cross-cutting trackers

### 3.1 Implementation gates → stage map

| Gate | Description                                     | Stage landed | Stage verified | Acceptance test                          |
|------|-------------------------------------------------|--------------|----------------|------------------------------------------|
| #1   | `validateTransition` shared helper              | 2            | 2              | `per-kind-substate.test.ts`              |
| #2   | Final-entry-only append (step 5 → step 6 only)  | 1            | 4              | `final-validation.test.ts`               |
| #3   | Migration sidecar manifest-only (`.strict()`)   | 5            | 5              | `v0.0.x-migration.test.ts`               |
| #4   | Batch-aware tail recovery                       | 3            | 3              | `tail-corruption.test.ts`                |
| #5   | Snapshot read fail-fast (exit 2, no fallback)   | 6            | 6              | `reader-staleness.test.ts`               |

### 3.2 Cascade decision sub-items (ADR-0005 §4 → stage)

ADR-0005 §6 lists the Cascade bucket as 5.0d (B1 1.0 + B3 1.0 + H1 0.5 + H2 0.5 + M1 0.5 +
M3 1.0 + §4.15 perf 0.5 = 5.0d; B2 / H3 / N11 / N13 / N14 folded inside Journal SSoT
already). Below is the stage placement.

| ID  | Item                                            | Stage | Day | Test                                |
|-----|-------------------------------------------------|-------|-----|-------------------------------------|
| B1  | actor authority + migration namespace           | 2     | 1.0 | `actor-authority.test.ts`           |
| B3  | `tasks_amended` complete invariant              | 2     | 1.0 | `tasks-amended.test.ts`             |
| H1  | protocol permissive + doc cleanup               | 0 (complete) | 0.5 | doc review (landed in audit follow-up commit) |
| H2  | `resolved_pending_log` snapshot projection      | 3     | 0.5 | `pending-resolved-log.test.ts`      |
| M1  | `ready` + `tasks_planned`                       | 2     | 0.5 | `tasks-planned-claim.test.ts`       |
| M3  | `strict_drift_check` enforcement                | 2     | 1.0 | `strict-drift.test.ts`              |
| §4.15 | perf benchmark + rolling-checksum two-tier    | 6     | 0.5 | `perf.test.ts`                      |
| N16 | per-entry `entry_schema_version` + upcaster     | 1     | 0.5 | `per-entry-upcast.test.ts`          |
| N18 | reader staleness contract + CLI footer + exit 2 | 6     | 0.5 | `reader-staleness.test.ts`          |

B2 (ceremony guard) and H3 (per-field sidecar) are folded into reducer / sidecar stages —
no separate day budget. N16 / N18 are Journal-SSoT line items (ADR §6), not Cascade — they
appear here for completeness of the cross-stage allocation view.

### 3.3 spike → core promote (ADR-0005 §5.3)

| From                                     | To                                       | Stage |
|------------------------------------------|------------------------------------------|-------|
| `src/spike/events.ts`                    | `src/core/journal-entry.ts`              | 1     |
| `src/spike/append.ts`                    | `src/core/journal-append.ts`             | 1     |
| `src/spike/reducer.ts`                   | `src/core/reducer.ts`                    | 2     |
| `src/spike/snapshot.ts`                  | `src/core/snapshot.ts`                   | 3     |
| `src/spike/project.ts`                   | `src/core/journal-bootstrap.ts`          | 3     |
| `tests/spike/atomicity.test.ts`          | `tests/core/journal-atomicity.test.ts`   | 1     |
| `tests/spike/reducer.test.ts`            | `tests/core/reducer.test.ts`             | 2     |
| `tests/spike/replay.test.ts`             | `tests/core/replay.test.ts`              | 3     |
| `tests/spike/schema-evolution.test.ts`   | `tests/core/per-entry-upcast.test.ts`    | 1     |
| `tests/spike/perf.test.ts`               | `tests/core/perf.test.ts`                | 6     |

After each stage promotes the relevant spike file, the spike copy is **deleted**, not left
side-by-side, to prevent the dual-source-of-truth that ADR-0005 §1.3 identifies as N10.

### 3.4 New test fixtures inventory (ADR-0005 §5.3 tail)

- `tests/core/sidecar-crash.test.ts` — Stage 4
- `tests/core/tail-corruption.test.ts` — Stage 3 (7 scenarios)
- `tests/core/batch-atomicity.test.ts` — Stage 3 (4 scenarios)
- `tests/core/preflight-validation.test.ts` — Stage 2
- `tests/core/final-validation.test.ts` — Stage 1 (+ extended Stage 4)
- `tests/core/per-kind-substate.test.ts` — Stage 2 (full Cartesian)
- `tests/core/reader-staleness.test.ts` — Stage 6
- `tests/core/v0.0.x-migration.test.ts` — Stage 5
- `tests/core/per-kind-fixture-builder.ts` — Stage 2 (1d standalone harness)

---

## 4. Workflow & verification

- TDD: every stage runs red-green-refactor; write the acceptance test file first, then
  promote/implement until green
- `bun run check` (typecheck + vitest + tsdown build) must pass at every stage close
- vitest is the actual runner today (`package.json` script); root CLAUDE.md mandates Bun
  defaults but the test runner currently configured is vitest. Migrating to `bun test` is
  **out of scope** for v0.1.0 and tracked separately if at all
- No commit lands with stage acceptance tests skipped; failing tests block stage close
- Each stage closes with: (a) all promoted spike files deleted; (b) ADR-0005 §10 gate row
  ticked in section 3.1 above

---

## 5. Risks & open knobs

- **Perf floor TBD**: Stage 6 picks the 100K-entry rebuild target. ADR-0005 §4.15 didn't
  pin a number; pinning happens during Stage 6 and that pin becomes a release blocker.
- **Migration coverage**: ADR §5.2 crash table has 7 rows; if any row's recovery path proves
  ambiguous in implementation, escalate (do not paper over with retry loops).
- **Fixture builder scope creep**: per-kind Cartesian matrix is bounded by `EntryKind`
  enum. If kind count grows mid-implementation (e.g. v0.1.x signature work bleeds back), the
  1d budget no longer covers it — re-estimate.
- **`bun test` vs vitest divergence**: project CLAUDE.md mandates Bun but `package.json`
  currently uses vitest. Plan stays on vitest; flag if the test runner change becomes urgent.

---

## 6. Out of scope for v0.1.0

Per ADR-0005 §9 — explicitly not on this plan, not blocking GA:

1. Signature scheme (ADR-0006)
2. Cross-feature audit
3. Snapshot checkpoint (>100K entries)
4. Compaction / archive
5. Reader watch-style API

---

## 7. References

- [`docs/adr/0005-truth-model-single-typed-journal.md`](adr/0005-truth-model-single-typed-journal.md) — single source of design truth
- [`docs/protocol.md`](protocol.md) — rev 5.0 (after Stage 0)
- [`docs/schemas.ts`](schemas.ts) — rev 5.0 (after Stage 0)
- [`docs/moni-review.md`](moni-review.md) — round-2 three-way audit source
- [`skills/CONTRACT.md`](../skills/CONTRACT.md) — loaf-skill recommended pattern (H1 landing)
