# Quality closure — the three deferred refactors (W8 / W9 / W10)

**Status:** DRAFT — plan only, awaiting go-ahead per item.
**Type:** refactor + CI closure plan.
**Date:** 2026-06-08.
**Companion to:** `quality-closure-round2.md` (W1–W7 + flake, all landed) and
`claude-code-quality-deduction-closure.md` (the 8.6 baseline). These three are
the remaining **8.6 → 9.1 / 9.2** ladder items; W8/W9 are explicitly *not scored*
if done as mechanical splits (see each item's "scored vs not").

Each is independent — they can land in any order, separate branches/PRs. All
verify against the existing 2293-test suite as the behavior-preservation net.

---

## W8 — `cli.tsx` command-surface split — `PUBLIC_IMPACT=true` (observable CLI behavior)

### Problem / current state
`src/cli.tsx` is ~6.3k lines. The bloat is NOT helper logic (already extracted to
`src/cli/*`: command-context, batch-builders, check-file, sessions-list, …) — it
is ~30 per-command `.command().action()` closures inlined inside one `main()`
function (lifecycle / gate / tasks / pending / evidence / finding / terminal /
spike / profile / config / doctor). `gate decide` alone is ~175 lines. The file
is navigable but a merge-conflict magnet and the closures can't be unit-tested in
isolation.

### Scored vs not
- **Scored:** each slice genuinely OWNS its command family's input-read → actor
  resolve → dispatch → mutate → output-routing, with a clear `register(program,
  deps)` seam. The existing `registerSpecAdd()` is the template — generalize it.
- **NOT scored:** a mechanical "cut lines 2429–3700 into tasks.tsx" move that
  leaves the same tangle behind a different filename.

### Approach
1. Establish `src/cli/commands/<family>.tsx`, each exporting
   `registerX(program: Command, deps: MainDeps): void` — the same `MainDeps` DI
   seam `main()` already threads. `cli.tsx` `main()` shrinks to: build program →
   call each `registerX` → parse → exit.
2. One family per commit, in dependency-safe order (leaf families first):
   `evidence` + `waive` → `pending` → `finding` → `tasks` (+ `step`) →
   `gate` → terminal (`deliver`/`archive`/`abandon`/`settle`/`resume`/`handoff`) →
   `spike`/`profile`/`config`/`doctor` → lifecycle (`start`/`advance`/`status`/
   `next`). Lifecycle last — it's the most cross-cutting.
3. Shared per-command scaffolding (parse args → resolve actor → loadSession →
   build partial → runMutator → format `{ok}`/`{ok:false}` → exit) that repeats
   across families is hoisted into a `command-context.ts` helper if not already
   there — but only where the repetition is real, not a speculative framework
   (the 8.6 doc explicitly warns against "a shallow command framework").

### Sequencing / verification
- **Behavior-preservation net:** `tests/core/cli.test.ts` (151 runCli integration
  cases) + e2e-lifecycle. Run the FULL suite after EACH family extraction — a
  green suite is the contract (no output/exit-code/JSON-shape drift).
- Optional pre-work: capture a golden snapshot of `--help` + representative
  command JSON outputs before starting, diff after each commit (catches Hyrum
  drift the unit tests miss).
- `bun run check` (lint + typecheck + test + build) green per commit.

### Risk
High churn; the import graph must not regenerate cycles (run `madge --circular`
each commit — b330719 just broke 4). `cli.tsx` is shared — coordinate so this
doesn't collide with in-flight feature work. Behavior drift is the real hazard;
the integration suite is the guard, but only as good as its output assertions
(many are `.code`-based, stable; the 28 `stderr.toContain` substring matches are
Hyrum-fragile — do not reword strings during the move).

---

## W9 — `preflight.ts` policy-cluster extraction + precedence lock — `PUBLIC_IMPACT=true`

### Problem / current state
`src/core/reducer/preflight.ts` is ~1.9k lines: one `preflight()` with an ORDERED
check sequence — (1) envelope, (2) monotonic seq, (3) sub_state authority,
(4) actor authority, (5) per-kind payload refines, transition delegation
(`checkTransition` → `validateTransition`), then gate/back-edge refines. The
ORDER is a load-bearing contract (error precedence); `preflight-precedence.test.ts`
already pins 22 simultaneous-violation rows.

### Scored vs not
- **Scored:** extract coherent policy CLUSTERS into named pure predicates
  (`checkSeqMonotonic`, `checkSubStateAuthority`, `checkActorAuthority`,
  `checkPerKindPayload`, …) AND extend the precedence test so it fails if the
  ordering changes — the extraction must make the order *explicit and tested*,
  not just relocated.
- **NOT scored:** a jump-table / dispatch-map split that preserves behavior but
  adds no precedence coverage — that trades one big function for one big table
  and proves nothing.

### Approach
1. Extract each check into a pure `(entry, ctx) => PreflightFailure | null`
   predicate; `preflight()` becomes an explicit ordered pipeline
   `for (const check of ORDERED_CHECKS) { const f = check(...); if (f) return f; }`
   — the order array IS the precedence contract, in one readable place.
2. Extend `preflight-precedence.test.ts`: for every adjacent pair in
   `ORDERED_CHECKS`, a fixture that violates BOTH and asserts the earlier wins.
   A test that iterates the order array means reordering it (or inserting a check)
   without updating intent fails loudly.
3. Keep the W1 `spec_locked` threading and the `checkTransition` delegation intact
   — they're recent and correct; this is restructure-around, not rewrite.

### Sequencing / verification
- One cluster per commit if the extraction is large; or one commit if the pipeline
  rewrite is atomic and the diff stays reviewable.
- `preflight-validation.test.ts` + `preflight-precedence.test.ts` +
  `per-kind-substate.test.ts` are the net. Full `bun run test` green per commit.

### Risk
Precedence is the invariant most likely to silently drift during extraction
(a moved check changes which error a caller sees — observable, Hyrum-relevant).
The extended precedence test is the entire point; write it FIRST (it should pass
against current behavior, then keep passing through the refactor — a
characterization test).

---

## W10 — CI gate — `PUBLIC_IMPACT=true` (build/release path) — **depends on flake fix (landed)**

### Problem / current state
No `.github/workflows/`. All gates run locally only; nothing prevents a red
`main`. The flake fix (`testTimeout` 20s, landed in round-2) was the prerequisite
— full-parallel `bun run test` is now stably green, so CI won't flap.

### Scope
A single unattended GitHub Actions workflow (repo is `github:est7/loaf`) on
push + PR, running the gates that already exist locally:
`bun run lint` · `bun run typecheck` · `bun run test` · `bun run build` ·
`bunx madge --circular --extensions ts,tsx src` · `bash scripts/ga-consistency-check.sh --no-fetch` ·
`bash scripts/ga-package-smoke.sh` · `bash scripts/check-event-drift.sh`.

### Approach
1. `.github/workflows/ci.yml`: `oven-sh/setup-bun@v2` → `bun install` → the gate
   sequence above as discrete steps (discrete so a failure names the gate).
2. Pin bun version to match local (`bun.lock` / `package.json` engines).
3. Decide matrix: single Node 22 / latest-bun is enough for an MVP; no OS matrix
   unless the scripts are platform-sensitive (they use `bash`, so `ubuntu-latest`).
4. `dist/cli.mjs` is committed and IS the shipped artifact — add a CI check that
   `bun run build` produces no diff to `dist/cli.mjs` (catches the "forgot to
   rebuild dist" release-hazard the CLAUDE.md ship section warns about).

### Sequencing / verification
- Single commit (`ci: add unattended gate workflow`). Verify by pushing the branch
  and watching the Actions run go green (the only item whose verification is
  remote, not local).

### Risk
Low logic risk — config, not code. Watch: (a) the `ga-*`/`check-event-drift`
scripts must be CI-safe (no interactive auth, no network unless `--no-fetch`);
(b) the dist-no-diff check must use the same bun/tsdown version as local or it
false-positives. Cheapest of the three; highest leverage (locks every other gate
in place going forward).

---

## Recommended order

W10 first (cheap, locks the gates), then W9 (smaller, self-contained, characterization-test-first), then W8 (largest, most churn — do it when no other cli.tsx work is in flight). None blocks another; W10 has no code dependency beyond the already-landed flake fix.

## Out of scope (named, not addressed here)
- Widening the W3 write-fence to `doctor --rebuild` / `handoff` projection writes (the named partial-fence boundary — a separate hardening).
- `dist/cli.mjs` rebuild — release-time, per CLAUDE.md ship flow.
- 9.5-ladder items beyond schema-drift guards (golden CLI behavior suite, property/sequence tests, mutation/fault-injection) — future, once W8–W10 land.
