# Quality closure — round 2 (enforcement + integrity)

**Status:** DRAFT — awaiting scope confirmation before code edits.
**Type:** correctness + hardening + hygiene closure plan.
**Date:** 2026-06-08.
**Basis:** independent 4-subsystem audit (kernel / schema-error-i18n / tests /
CLI-gates) + direct kernel re-read on current `main` (v0.3.1).

## Why this exists

`claude-code-quality-deduction-closure.md` refreshed the live score to **8.6 / 10**
and asserts *"No BLOCK-severity live bug was found in any audited subsystem."* The
round-2 review does not align with that headline. Two real gaps sit **outside** the
doc's "five remaining deductions," and the deduction list is internally
inconsistent (the prose names `local-only gate enforcement` as a deduction; the
numbered closures substitute `CI gate` — they do not match, and neither names the
findings below).

Independent synthesized score with these counted: **8.0 / 10**. Closing W1+W2
is what makes 8.6 honest; the rest follows the existing ladder.

The two new items are correctness/enforcement, not hygiene:

- **W1** — the spec-lock gate is bypassable on the write path.
- **W2** — `replayJournal` does not validate `seq` monotonicity.

Both verified against source (file:line below), not inferred from comments.

---

## W1 — spec-lock write-path guard (highest priority) — `PUBLIC_IMPACT=true`

**Problem.** `validateTransition` is the shared write-path gatekeeper for
`event:phase_advanced`. It guards `VERIFY.accept → SETTLE.reconcile` on
`verify_accepted` (`transition.ts:601` → `SETTLE_NOT_ACCEPTED`) but has **no
parallel `spec_locked` guard** on `SPEC.design → EXECUTE.plan`. So a bare
`loaf advance EXECUTE.plan` from `SPEC.design` succeeds with `spec_locked=false`,
crossing the spec-lock boundary without the 8 spec-lock checks ever running
(those fire only in `mutateBatch` Pass 1.5 when a `gate:decided` approval is in
the batch — `journal-mutate.ts:309-325`). The kernel is the documented
enforcement authority (CLAUDE.md / ADR-0005) and must not rely on the loaf-skill
layer staging a pending prompt to hold the gate.

**Evidence (verified).**
- `transition.ts:592-610` — verify-accept twin guard present; no spec-lock equivalent before the final `return { ok: true }` at `:612`.
- `transition.ts:165` — the `spec-lock && !spec_locked` block lives in `transitionOwnerFor` (advisory "next action"), NOT in `validateTransition` (enforcement).
- `transition.ts:314-325` — `TransitionContext` carries `verify_accepted?` but **NOT** `spec_locked` (correcting the audit's loose claim; a small signature change IS required).
- No `spec_locked`/`EXECUTE.plan` guard exists on the advance path in `preflight.ts` (the `:1605`/`:1641` hits gate `finding raise action=amend-spec` and direct spec-content edits, not the cursor advance).

**Fix.** Mirror `SETTLE_NOT_ACCEPTED` exactly (it is the proven 5-touchpoint pattern):

1. `transition.ts` — add `spec_locked?: boolean` to `TransitionContext` (`:314`); add the new code `SPEC_LOCK_NOT_SATISFIED` to the `TransitionResult` union (`:349`); add the guard in `validateTransition` after the existing forks:
   ```
   if (prev === "SPEC.design" && target === "EXECUTE.plan" && !ctx.spec_locked) {
     return { ok: false, code: "SPEC_LOCK_NOT_SATISFIED", message: "...run `loaf gate decide spec-lock --approve` first", detail: { from: prev, to: target, spec_locked: !!ctx.spec_locked } };
   }
   ```
2. `preflight.ts` — derive `const spec_locked = ctx.snapshot.state?.spec_locked ?? false;` (mirror of `:457`), thread it into the `TransitionContext` it builds for `validateTransition`, and add `SPEC_LOCK_NOT_SATISFIED` to the `PreflightFailureCode` union (`:90-93`).
3. `docs/schemas.ts` — add `SPEC_LOCK_NOT_SATISFIED` to the `DiagnosticCode` enum (next to `SETTLE_NOT_ACCEPTED`, `:4155`) + an `ERROR_CATALOG` entry (`~:5143`) with `message_template` / `fix_template` / `doc_anchor`.
4. `i18n/en.json` + `i18n/zh.json` — add the `diagnostic.SPEC_LOCK_NOT_SATISFIED` template; placeholders must match the emitted `detail.*` keys (`from` / `to` / `spec_locked`).

**Decision needed `[需要 nod]`:** new code `SPEC_LOCK_NOT_SATISFIED` (recommended — symmetric, self-documenting) vs. reuse `GATE_PRECONDITION_VIOLATION`. Recommendation: new code, because the existing reuse path only fires from Pass 1.5 with a gate batch, whereas this guard fires on a bare advance where no gate entry exists.

**RED test (write first).** `tests/core/transition.test.ts` — assert
`validateTransition("SPEC.design","EXECUTE.plan",{spec_locked:false,...}).ok === false`
with `code === "SPEC_LOCK_NOT_SATISFIED"`, and `=== true` when `spec_locked:true`.
Plus an e2e in `tests/core/cli.test.ts`: seed at `SPEC.design`, `loaf advance
EXECUTE.plan` without a prior `gate decide spec-lock --approve` → exit 2 + code.
This asymmetry is currently **untested** — that is why it survived.

**Verify.** `bunx vitest run tests/core/transition.test.ts tests/core/cli.test.ts`
+ `bun run check` + i18n lockstep test green.

**Risk.** Any existing test/fixture that advances `SPEC.design → EXECUTE.plan`
without first locking will now correctly fail — audit those; if a seed helper
relies on the bypass, fix the seed to lock first (the lock flip is a
`gate:decided spec-lock approved` entry; `spec_locked` does NOT move the cursor).

---

## W2 — replay seq-monotonicity validation — `PUBLIC_IMPACT=true`

**Problem.** `replayJournal` applies entries in file order and never asserts
`entry.seq === lastSeq + 1`. `apply()` calls `preflight(entry,{tail_seq: entry.seq-1})`
(`reducer.ts:205`), making preflight's monotonicity gate **tautological** on the
replay path (`expectedSeq = (entry.seq-1)+1 = entry.seq`). So a journal with a
duplicated / gapped / reordered `seq` replays to `ok` as long as each entry's
transition is individually legal. Monotonicity is enforced only on the append
path (`appendMany:227`), not on read. Single-writer journals are monotonic by
construction; the gap matters under tampering, the (unimplemented) `.lock`
concurrent-double-append, or partial-batch tail corruption.

**Evidence (verified).**
- `journal-bootstrap.ts:113-183` — loop tracks `lastSeq = entry.seq` but never compares to `lastSeq + 1`.
- `reducer.ts:205-207` — the `tail_seq: entry.seq - 1` comment "sequence already validated by journal-append" holds on append, not on replay.

**Fix.** In `replayJournal`, before `apply`, assert `entry.seq === lastSeq + 1`;
on mismatch return `{ ok:false, code:"INVALID_ENTRY", at_seq: entry.seq, detail:{ expected: lastSeq+1, got: entry.seq } }` (reuse `INVALID_ENTRY` — no new code needed; it already signals an unreplayable journal). Migration entries
(`migration:snapshot_imported`, seq 0) keep their bootstrap path.

**RED test (write first).** `tests/core/journal-bootstrap.test.ts` (or replay
test file) — hand-build a journal with (a) a duplicated seq, (b) a gap, (c) a
reorder; assert each returns `INVALID_ENTRY` with `at_seq` pointing at the first
offending line. A monotonic journal must still replay `ok`.

**Verify.** `bunx vitest run` on the replay test file + full `bun run check`.

**Risk.** Low — this only rejects journals that are already corrupt. Confirm no
test fixture ships a deliberately non-monotonic journal that currently replays
green (grep test fixtures for hand-written `.jsonl`).

**Note.** W2 is distinct from W3. The write-contention fence stops concurrent
double-append; W2 catches an already-corrupt/tampered journal on read. Closing
W3 alone does not close W2.

---

## W3 — write-contention fence (hardening) — `PUBLIC_IMPACT=true`

Matches the existing doc's deduction #3. Add a **throw-only** `O_EXCL` lock-file
guard (or `flock`) around the disk-touching span in `mutateBatch` (Pass 2 →
step 9). No wait loops, no PID-stealing, no timeout machinery, no lock manager —
on contention, throw a typed `WRITE_CONTENTION` failure and let the caller retry.
This finally implements the `.lock` the layout diagram already advertises (and
which CLAUDE.md / the audited doc should stop presenting as existing until then).

**RED test.** Two overlapping `mutateBatch` calls on the same feature dir → one
succeeds, the other throws `WRITE_CONTENTION` (not a duplicate-seq journal).

**Risk.** Must release the lock on every exit path (success + every early
return). Use `try/finally`. Test the crash-mid-write lock-stale case or document
`doctor` as the recovery.

---

## W4 — doc reconcile (cheap, do alongside W1) — `PUBLIC_IMPACT=false`

- Reconcile the two non-matching "five deductions" lists in `claude-code-quality-deduction-closure.md` (`:15` prose vs `:50` numbered).
- Add W1 (spec-lock guard) + W2 (replay monotonicity) as scored deductions; re-state the live score as **8.0** until they close, then the ladder.
- Either soften the "no BLOCK found" line or justify why direct-CLI gate bypass is out of the kernel threat model — but that contradicts the documented "kernel is enforcement authority," so softening is the honest path.
- Correct the `.lock` layout claim (CLAUDE.md + headers) to "deferred until W3."
- Correct exit-code doc `0/2/3` → actual `0/1/2/130`.

---

## W5–W7 — schema/i18n hygiene (the audit's 6/10 layer) — mostly `PUBLIC_IMPACT=false`

- **W5** Delete the 10 phantom `diagnostic.*` i18n keys (verified absent from enum + src: `AMEND_REJECTED_POST_LOCK`, `ABANDON_REQUIRES_REASON`, +8). Decide on the 48 valid-but-unreachable keys: prune to the 9 reachable (`MIGRATED_DIAGNOSTIC_CODES`) or wire ERROR_CATALOG rendering through them. Add a test gate: every `diagnostic.*` key ∈ `DiagnosticCode` enum (this catches the *next* stale rename automatically — the current denylist cannot).
- **W6** Add a test asserting each runtime mirror enum (`EvidenceKind` / `FindingAction` / …) equals its `docs/schemas.ts` counterpart, so the hand-copied "source of truth" can't silently drift.
- **W7** Reconcile spec-input `.passthrough()` (`spec-schema.ts:206/256/274/287`) vs the documented "Strict over Postel": either tighten to `.strict()` (separate `refactor(core):` commit + forward-compat-field note) or carve the exception explicitly in CLAUDE.md. `PUBLIC_IMPACT=true` if tightened (input-boundary contract change).

---

## W8–W10 — existing doc's maintainability five (separate later commits)

- **W8** `cli.tsx` vertical-slice split (doc #1) — by command domain, each slice owning read/dispatch/mutate/output. Mechanical split not scored.
- **W9** `preflight.ts` policy-cluster extraction + precedence tests that fail on reordering (doc #2). Jump-table split without stronger tests not scored. (Note: `preflight-precedence.test.ts` already pins 22 rows — extend, don't duplicate.)
- **W10** CI gate (doc #4) — unattended workflow running lint / typecheck / test / build / madge / GA consistency / pack smoke / event drift.

---

## Sequencing

```
W1  spec-lock guard      ─┐ correctness — do first, one commit each
W2  replay monotonicity  ─┘ (RED → impl → codex audit → commit)
W4  doc reconcile         ── alongside W1 (same PR or trailing)
W3  write fence           ── hardening; after W1/W2 land
W5  i18n cleanup + gate   ─┐ hygiene — independent, parallelizable
W6  mirror-drift test     ─┤
W7  strict spec-input     ─┘
W8  cli.tsx split         ─┐ large refactors — own commits, after the above
W9  preflight cluster     ─┤
W10 CI gate               ─┘
```

Each item: one sub-cycle = one commit. RED test → impl → codex independent audit
→ commit, per repo convention. W1/W2/W3/W7 are `PUBLIC_IMPACT=true` → plan-first
already satisfied by this doc; dispatch to codex before RED.

## Per-item verification matrix

| Item | Verify command | Pass = |
| --- | --- | --- |
| W1 | `bunx vitest run tests/core/transition.test.ts tests/core/cli.test.ts` + i18n lockstep | new RED green, no regressions |
| W2 | `bunx vitest run` replay test file | corrupt journals → INVALID_ENTRY; monotonic → ok |
| W3 | `bunx vitest run` contention test | second writer → WRITE_CONTENTION, journal intact |
| W5 | i18n lockstep + new enum-subset gate | 0 phantom keys; gate catches injected stale key |
| W6 | new mirror-drift test | injected enum drift fails |
| all | `bun run check` + `madge --circular` | green, no new cycles |

## Out of scope (this plan)

- TUI screens (`src/cli/tui/*`), `doctor`/`migration` deep paths — not audited this round.
- The `apply()` half-pure contract is doc + test-pinned (`reducer-apply-contract.test.ts`); a TS opaque-brand return type is a possible later hardening, not scored here.
