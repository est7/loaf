# E2E Test Scenarios — loaf-cli worker workflow

Protocol-derived acceptance inventory for the end-to-end test layer. The
**protocol** (`docs/protocol.md`, rev 5.0 / ADR-0005) is the source of
truth — every scenario here is derived from the protocol, NOT from the
current `src/cli.tsx`. A scenario whose implementation does not exist yet
is not a wrong scenario; it is a correct acceptance criterion for a
not-yet-built slice.

## Methodology

- **Gherkin prose, no runner.** Scenarios are written `Given / When / Then`
  (protocol.md §9.3 forbids Cucumber or any Gherkin runner). The runner is
  **Vitest**; each test drives the CLI through `runCli([...argv])` only —
  no raw `mutate`. `tests/core/e2e-lifecycle.test.ts` is the home file.
- **`master` stays green.** The repo forbids committed RED tests. A
  scenario whose implementation is absent lands as `test.todo("SCEN-E2E-NNN
  …")` — a runner-visible checklist entry that does not break the green
  bar. When the implementing slice lands, the `todo` becomes a real test.
- **Right layer.** E2E covers *workflow* scenarios. Exhaustive failure
  permutations (every gate-check, every schema-invalid input) belong to
  unit/integration tests — see the Excluded section; those are still
  protocol-tested, just not at E2E cost.

## Field legend

- **Tier** — `§15-close` (the 4 scenarios that close `task_plan.md` §15
  done-when 1+2) · `inventory` (workflow scenario worth an E2E test) ·
  `optional` (nice-to-have) · `future` (needs an unimplemented command or
  back-edge; `test.todo` until that slice) · `not-e2e` (recorded for
  completeness; tested at unit/integration layer).
- **Status** — `green` (test written, passing) · `todo` (placeholder) ·
  `n/a` (not-e2e tier).
- **Impl** — implementation note: shared-file folding, or the command/slice
  a `future` scenario waits on.

Source: codex independent enumeration r119 (AMQ thread
`review/cli-lifecycle-plan`), cross-checked against a 19-scenario draft.

---

## §15 close set — 3 standard + 1 deep

### SCEN-E2E-001 — Standard behavioral happy path
- **Tier** §15-close · **Status** green · **Impl** `e2e-lifecycle.test.ts`
- **Given** a standard-ceremony feature with one EARS REQ and one
  behavioral task driving it.
- **When** `runCli` drives TRIAGE → SPEC (init/submit/add-req) → SPEC.design
  → `tasks submit` → gate spec-lock → EXECUTE (claim + red/implement steps)
  → VERIFY lanes → evidence add → gate verify-accept → `deliver`.
- **Then** the session reaches `DONE.delivered`.
- **Covers** the full standard spine; the baseline regression guard.

### SCEN-E2E-002 — Standard structural / DAG append path
- **Tier** §15-close · **Status** green
- **Given** a standard feature whose SPEC.design task graph is built with
  `tasks add` and contains two structural tasks linked by `depends_on`.
- **When** `tasks amend --policy` narrows the optional `refactor` step,
  `tasks next` / `tasks claim` execute the tasks in dependency order, and
  the lifecycle continues to the gates.
- **Then** verify-accept and `deliver` succeed.
- **Covers** `tasks add` id allocation + canonical-graph preservation,
  EXECUTE.plan policy mutation, `depends_on` DAG readiness.

### SCEN-E2E-003 — Standard visual / docs / chore mixed task path
- **Tier** §15-close · **Status** green
- **Given** a standard feature with `add-req` / `add-scenario` / `add-visual`
  content and visual-ui + docs + chore tasks.
- **When** each kind's step ladder completes and evidence covers the
  VIS / SCEN / REQ / T obligations.
- **Then** verify-accept and `deliver` succeed.
- **Covers** non-behavioral execution shapes; the incremental `spec add-*`
  surface.

### SCEN-E2E-004 — Deep happy path with settle
- **Tier** §15-close · **Status** green · **Impl** absorbs SCEN-E2E-008
- **Given** a deep-ceremony feature with implementer evidence and a separate
  human/skill spec-review actor (deep sets `strict_spec_review`).
- **When** VERIFY.accept is approved, a direct `deliver` is rejected,
  `settle` moves VERIFY.accept → SETTLE.reconcile, `advance` reaches
  SETTLE.lessons, and `deliver` runs from SETTLE.lessons.
- **Then** the session reaches `DONE.delivered`.
- **Covers** `settle_phase`, `strict_spec_review`, the
  `strict_drift_check` / `lessons_required` deep branch.

---

## Ceremony / phase-skip

### SCEN-E2E-005 — Quick direct-deliver fail-closed
- **Tier** inventory · **Status** green · **Impl** assert fail-closed now;
  upgrade to a happy path when verify-min lands.
- **Given** a quick-ceremony feature (quick skips SPEC / VERIFY / SETTLE).
- **When** execution reaches EXECUTE.done and `deliver` is called.
- **Then** the MVP returns `DELIVER_VERIFY_MIN_UNAVAILABLE`.
- **Covers** the quick fork and the current verify-min deferred boundary.

### SCEN-E2E-006 — Light direct-deliver fail-closed
- **Tier** inventory · **Status** green · **Impl** assert fail-closed now;
  later assert the light warning once verify-min exists.
- **Given** a light-ceremony feature (light runs SPEC, skips VERIFY/SETTLE).
- **When** execution reaches EXECUTE.done and `deliver` is called.
- **Then** the MVP returns `DELIVER_VERIFY_MIN_UNAVAILABLE`.
- **Covers** light's "intent-anchored but not closed" contract.

### SCEN-E2E-007 — Standard settle disabled
- **Tier** inventory · **Status** green
- **Given** a standard feature at VERIFY.accept with `verify_accepted=true`.
- **When** `settle` is called.
- **Then** the CLI returns `SETTLE_PHASE_DISABLED`.
- **Covers** the standard no-SETTLE branch (rev 5.x).

### SCEN-E2E-008 — Deep deliver cannot bypass settle
- **Tier** inventory · **Status** green · **Impl** may fold into SCEN-E2E-004
- **Given** a deep feature at VERIFY.accept with `verify_accepted=true`.
- **When** `deliver` is called before `settle`.
- **Then** the CLI returns `DELIVER_SETTLE_PHASE_BYPASS`.
- **Covers** deep terminal routing.

---

## Task-kind coverage

### SCEN-E2E-009 — Behavioral bug RED gate
- **Tier** inventory · **Status** green
- **Given** a claimed behavioral task with `labels=["bug"]`.
- **When** the `implement` step is started or done before `register-red`.
- **Then** the CLI returns `BUG_TASK_REQUIRES_RED`; after
  `tasks register-red`, `implement` completes and the task finishes.
- **Covers** the Slice C R2 bug-RED runtime boundary.

### SCEN-E2E-010 — Structural task no-red shape
- **Tier** inventory · **Status** green · **Impl** fold into SCEN-E2E-002
- **Given** a structural task with `no_test_rationale`.
- **When** `implement` / `refactor` complete with no `red` step.
- **Then** the task auto-promotes and verify can cover it.
- **Covers** the structural execution shape.

### SCEN-E2E-011 — Visual-ui task shape
- **Tier** inventory · **Status** green · **Impl** fold into SCEN-E2E-003
- **Given** a visual-ui task referencing a `VIS-*` contract.
- **When** `mockup` / `implement` / `screenshot-compare` complete and
  visual-review evidence covers the VIS.
- **Then** verify-accept passes.
- **Covers** `visual_contract_refs` and VIS evidence.

### SCEN-E2E-012 — Docs task shape
- **Tier** optional · **Status** green · **Impl** fold into SCEN-E2E-003
- **Given** a docs task.
- **When** `draft` / `review` complete and evidence covers task/REQ.
- **Then** the task closes.
- **Covers** the docs step ladder.

### SCEN-E2E-013 — Chore task shape
- **Tier** optional · **Status** green · **Impl** fold into SCEN-E2E-003
- **Given** a chore task.
- **When** the single `execute` step completes.
- **Then** the task closes with no `red` / `refactor`.
- **Covers** the single-step kind.

### SCEN-E2E-014 — Spike cannot deliver
- **Tier** inventory · **Status** green
- **Given** a session containing a non-abandoned spike task.
- **When** `deliver` is called from an otherwise deliverable source.
- **Then** the CLI returns `DELIVER_SPIKE_TASKS`.
- **Covers** the session-level spike hard block (spike exits —
  archive/abandon/convert — are SCEN-E2E-035..037, future).

---

## Append / mutation paths

### SCEN-E2E-015 — SPEC incremental append pre-lock
- **Tier** inventory · **Status** green
- **Given** a feature in SPEC.spec / plan / design, pre-lock.
- **When** `spec add-req` / `add-scenario` / `add-visual` are called with
  single and batch inputs.
- **Then** ids are allocated per namespace and `spec_version` bumps once
  per invocation.
- **Covers** the id allocator + version semantics.

### SCEN-E2E-016 — SPEC append post-lock rejected
- **Tier** optional · **Status** green
- **Given** `spec_locked=true` in EXECUTE / VERIFY.
- **When** `spec add-*` is called directly.
- **Then** `SPEC_LOCKED_NO_DIRECT_EDIT` (or sub_state authority) rejects;
  the caller must use a `finding amend-spec`.
- **Covers** the post-lock mutation boundary.

### SCEN-E2E-017 — tasks add at SPEC.design
- **Tier** inventory · **Status** green · **Impl** fold into SCEN-E2E-002
- **Given** an existing planned task graph.
- **When** `tasks add` appends id-less single / batch input.
- **Then** allocated `T-` ids are returned and existing canonical task
  bodies are preserved.
- **Covers** the whole-replacement graph-rebuild risk.

### SCEN-E2E-018 — tasks amend --policy at EXECUTE.plan
- **Tier** inventory · **Status** green · **Impl** fold into SCEN-E2E-002
- **Given** a locked task graph with the cursor at EXECUTE.plan.
- **When** `tasks amend T --policy refactor=na` runs.
- **Then** only `applicability` changes; the task executes under the
  amended policy.
- **Covers** the §8.6 mutation-rights boundary.

---

## Iteration / back-edges

### SCEN-E2E-019 — amend-spec back-edge and re-lock
- **Tier** inventory · **Status** green
- **Given** a locked session in EXECUTE or VERIFY.
- **When** `finding raise --action amend-spec` is emitted.
- **Then** the cursor returns to SPEC.spec, `spec_locked` resets to false,
  spec content changes, spec-lock must be re-approved, and the session can
  still reach `DONE.delivered`.
- **Covers** the amend-spec finding back-edge wired in `src/cli.tsx`.

### SCEN-E2E-020 — amend-tasks back-edge
- **Tier** inventory · **Status** green
- **Given** VERIFY finds task-graph drift.
- **When** `finding raise --action amend-tasks` is emitted.
- **Then** the cursor returns to EXECUTE.work, iteration is bumped, the
  `amend-tasks` finding stays open, and the journal carries the atomic
  `[finding:raised, event:phase_advanced(back_edge)]` batch.
- **Covers** the amend-tasks back-edge (SC1 is back-edge-only — the task
  graph is not yet amended; that lands in SC1b).

### SCEN-E2E-021 — fix-impl loop
- **Tier** inventory · **Status** green
- **Given** a done behavioral task and an `impl-defect` `fix-impl` finding
  targeting `{task_id, step:"implement"}`.
- **When** `finding raise --action fix-impl` is emitted.
- **Then** the atomic 3-entry batch `[finding:raised,
  event:task_step_reset, event:phase_advanced(back_edge)]` lands; the
  cursor returns to EXECUTE.work, iteration is bumped, the target task's
  `implement` step resets to `pending` and the task reopens to
  `in_progress`, the `fix-impl` finding stays open, and prior execution
  history (the passed `red` step) is not erased.
- **Covers** the impl-defect repair path + the `event:task_step_reset`
  kind (Phase 11 Item 3 SC2).

### SCEN-E2E-022 — fix-test loop
- **Tier** inventory · **Status** green · **Impl** as SCEN-E2E-021, target
  step `red`.
- **Given** a done behavioral task and a `test-defect` `fix-test` finding
  targeting `{task_id, step:"red"}`.
- **When** `finding raise --action fix-test` is emitted.
- **Then** the same atomic 3-entry batch `[finding:raised,
  event:task_step_reset, event:phase_advanced(back_edge)]` lands; the
  cursor returns to EXECUTE.work, iteration is bumped, the target task's
  `red` step resets to `pending` and the task reopens to `in_progress`,
  the `fix-test` finding stays open, and prior execution history (the
  passed `implement` step) is not erased.
- **Covers** the test-defect / TDD repair path — `event:task_step_reset`
  reused for fix-test (Phase 11 Item 3 SC3).

### SCEN-E2E-023 — defer/backlog finding blocks accept until closed
- **Tier** optional · **Status** green
- **Given** VERIFY has an open `defer` / `backlog` finding.
- **When** `gate verify-accept --approve` is attempted.
- **Then** `OPEN_FINDINGS_PRESENT`; after `finding close`, approve passes.
- **Covers** the verify gate open-finding invariant without a back-edge.

### SCEN-E2E-039 — fix-impl back-edge repair loop carried through to delivery
- **Tier** inventory · **Status** green
- **Given** a standard feature driven to VERIFY.accept with proper REQ /
  task / evidence (verify-accept CAN pass) and a done behavioral task.
- **When** `finding raise --action fix-impl` is emitted from a VERIFY
  sub_state, the reset `implement` step is rerun to `passed`, the cursor
  re-advances EXECUTE.work → EXECUTE.done → VERIFY.* → VERIFY.accept,
  `gate verify-accept --approve` is attempted, the finding is closed, and
  `gate verify-accept --approve` then `deliver` are run.
- **Then** the back-edge co-emits its atomic 3-entry batch and bumps
  iteration; `gate verify-accept --approve` is blocked
  `OPEN_FINDINGS_PRESENT` (verify-accept check 2) while the `fix-impl`
  finding is open; after rerunning the reset step + `finding close`,
  `--approve` succeeds; `deliver` reaches `DONE.delivered`; at the end the
  iteration is still bumped and the `fix-impl` finding is `closed`.
- **Covers** the full back-edge repair loop closing the lifecycle —
  SCEN-E2E-020/021/022 prove only that a back-edge LANDS (the finding
  stays open); SCEN-E2E-023 proves the open-finding gate block for a
  non-back-edge defer finding. This is the distinct cross-cutting proof: a
  back-edge repair finding carried all the way through to delivery (Phase
  11 Item 3 SC4).
- **Note** new id — post-dates the codex r119 38-scenario enumeration; the
  Phase 11 Item 3 SC4 close-out scenario.

---

## Gate rejection

### SCEN-E2E-024 — spec-lock reject then approve
- **Tier** inventory · **Status** green
- **Given** SPEC.design with valid spec + tasks.
- **When** `gate spec-lock --reject` runs, then later `--approve`.
- **Then** after `--reject` the cursor stays SPEC.design and `spec_locked`
  stays false; after `--approve` the cursor moves to EXECUTE.plan.
- **Covers** reject no-side-effect; the approve dual-entry batch.

### SCEN-E2E-025 — verify-accept reject then approve
- **Tier** inventory · **Status** green
- **Given** VERIFY.accept with passing evidence.
- **When** `gate verify-accept --reject` runs, then `deliver`, then a later
  `--approve`.
- **Then** after `--reject` the cursor stays VERIFY.accept and
  `verify_accepted` stays false; `deliver` fails `DELIVER_NOT_ACCEPTED`
  until `--approve`.
- **Covers** reject semantics; the `verify_accepted` gate.

---

## Pending / blocking

### SCEN-E2E-026 — pending blocks advance (blocking-kind contract)
- **Tier** inventory · **Status** green
- **Given** a session with a pending head.
- **When** the head is a `profile_escalation` pending and `advance` is
  attempted, then the pending is resolved; and separately, the head is a
  `spec_clarification` pending and `advance` is attempted.
- **Then** `advance` is rejected with `PENDING_BLOCKS_ADVANCE` for the
  `profile_escalation` head and proceeds after resolve; `advance` is NOT
  blocked by the `spec_clarification` head.
- **Covers** the exact `advance` block set — head kind ∈
  `{gate_decision, profile_escalation}` only (protocol.md §4.1 / :207;
  `src/core/reducer/preflight.ts`). `ask_user_question` / `spec_clarification`
  / `finding_decision` pendings are FIFO-visible but never block `advance`.
  `gate_decision` blocking is exercised via SCEN-E2E-027.

### SCEN-E2E-027 — gate pending co-resolution
- **Tier** optional · **Status** green
- **Given** a pending head of kind `gate_decision`.
- **When** a gate approve command runs.
- **Then** `gate:decided` and `pending:resolved` are co-emitted in one
  batch and the head clears.
- **Covers** the atomic pending/gate batch.

### SCEN-E2E-028 — pending FIFO no skip
- **Tier** optional · **Status** green
- **Given** two pending entries.
- **When** `pending resolve` runs.
- **Then** only the head resolves; the second becomes head; there is no
  `--id` skip path.
- **Covers** FIFO discipline.

---

## Graph / concurrency shape

### SCEN-E2E-029 — multi-task DAG readiness
- **Tier** inventory · **Status** green · **Impl** fold into SCEN-E2E-002
- **Given** T-002 `depends_on` T-001.
- **When** `tasks next` / `tasks list` run before and after T-001 completes.
- **Then** T-002 is not ready before, ready after.
- **Covers** `depends_on` stable-core behavior through the CLI.

### SCEN-E2E-030 — fan-out independent tasks
- **Tier** optional · **Status** green · **Impl** the "legal only after both
  terminal" clause is enforced by the F-016 `EXECUTE_DONE_TASKS_NOT_FINAL`
  preflight guard; the test asserts both the rejection (tasks in_progress)
  and the post-completion success.
- **Given** two independent tasks.
- **When** both are claimed and `in_progress` before either finishes.
- **Then** both can complete; EXECUTE.done is legal only after both are
  terminal.
- **Covers** the worker active-set / fan-out projection.

---

## Evidence / attachment / batch

### SCEN-E2E-031 — task step done with co-emitted evidence
- **Tier** inventory · **Status** green
- **Given** an in-progress task step.
- **When** `tasks step done` includes `--evidence-*` flags.
- **Then** one CLI call closes the step and adds `EV-` evidence, returning
  the EV id.
- **Covers** batch atomicity at the user-facing CLI level.

### SCEN-E2E-032 — visual evidence attachment happy path
- **Tier** optional · **Status** green · **Impl** assert the current
  pre-hashed payload path; do not assert auto-hash/copy until it lands.
- **Given** visual-review evidence with a pre-hashed attachment payload.
- **When** `evidence add` runs.
- **Then** VIS coverage can satisfy verify-accept.
- **Covers** the current evidence-attachment schema path.

### SCEN-E2E-033 — batch invalid item aborts whole command
- **Tier** not-e2e · **Status** n/a · **Impl** one integration-level
  transaction test, not an E2E variant.
- **Given** a `spec add-*` or `tasks add` batch with one invalid item.
- **When** the command runs.
- **Then** no partial ids / projection changes occur.
- **Covers** CLI-level batch atomicity (integration suite).

---

## Actor / terminal

### SCEN-E2E-034 — human actor resolution for gate / deliver
- **Tier** optional · **Status** green
- **Given** a non-TTY `runCli` invocation.
- **When** gate / deliver run with `LOAF_USER` set, and again without it
  and without a git fallback.
- **Then** with `LOAF_USER` they succeed with a `human:` actor; without,
  they fail `NO_HUMAN_ACTOR`.
- **Covers** the human-only command boundary.

### SCEN-E2E-035 — archive terminal
- **Tier** optional · **Status** green · **Impl** `loaf archive --reason`
  emits `session:archived` (Item 2).
- **Given** a started session.
- **When** `archive --reason` runs.
- **Then** the session reaches `DONE.archived`.
- **Covers** the non-delivered archive exit.

### SCEN-E2E-036 — abandon terminal
- **Tier** optional · **Status** green · **Impl** `loaf abandon --reason`
  emits `session:abandoned` (Item 2).
- **Given** a started session.
- **When** `abandon --reason` runs.
- **Then** the session reaches `DONE.abandoned`.
- **Covers** the non-delivered abandon exit.

### SCEN-E2E-037 — spike convert
- **Tier** future · **Status** todo · **Impl** `loaf spike convert` is absent
  from `src/cli.tsx` (protocol-only).
- **Given** a session with spike findings.
- **When** `spike convert --to-feature` runs.
- **Then** the old session archives and a new feature is scaffolded.
- **Covers** the spike-to-feature conversion exit.

### SCEN-E2E-038 — doctor / migration rebuild
- **Tier** not-e2e · **Status** n/a · **Impl** belongs to the
  migration/doctor integration suite, not the worker lifecycle.
- **Given** legacy or corrupt snapshots.
- **When** `doctor --rebuild` / `--migrate-v2` runs.
- **Then** it repairs or reports.
- **Covers** snapshot rebuild / v0.0.x migration.

---

## Excluded from E2E (tested at unit / integration layer)

E2E is expensive; these protocol behaviours are covered better and cheaper
elsewhere. Recorded so the boundary is explicit, not forgotten.

- **Every individual spec-lock check failure.** One happy path through
  spec-lock at E2E; the 8-check failure matrix lives in
  `tests/core/gates/spec-lock-check.test.ts`.
- **Every individual verify-accept check failure.** E2E covers open-finding
  / missing-`verify_accepted` / deep spec-review once (SCEN-E2E-023/025/004);
  the `canSatisfy` matrix and lane permutations live in
  `tests/core/gates/verify-accept-check.test.ts`.
- **Every schema-invalid JSON shape** for spec / tasks / evidence / finding —
  CLI-boundary unit tests.
- **Id-allocator edge cases** beyond one single+batch happy path (duplicate
  ids, regex variants, malformed namespaces) — unit / integration tests.
- **The full 6×6 finding action grid** — E2E covers two back-edges
  (SCEN-E2E-019 amend-spec, SCEN-E2E-020 amend-tasks) and one open-finding
  block (SCEN-E2E-023); grid coherence lives in preflight unit tests.
- **Commander usage errors** for every missing flag — CLI unit tests for
  deterministic stderr / exit 2.
- **Journal tail corruption, checksum, migration sidecars, crash recovery** —
  storage / doctor integration tests.
- **Text-mode formatting snapshots** for list / status / next — E2E uses
  `--json`; formatting tests stay narrow.

---

## Implementation order

1. **§15 close set** — SCEN-E2E-001 (green) + 002 / 003 / 004 → green.
   Closes `task_plan.md` §15 done-when 1+2.
2. **`inventory` tier** — 005-009, 014, 015, 019, 024-026, 031 (and the
   `fold` scenarios 010/011/017/018/029 absorbed into 002/003). One
   sub-cycle per scenario or per coherent cluster.
3. **`optional` tier** — as budget allows.
4. **`future` tier** — each scenario's `test.todo` becomes a real test in
   the slice that implements its command / back-edge (amend-tasks,
   fix-impl/fix-test, archive, abandon, spike convert).
