# W8 (option B) — fold main()'s helper cluster into CommandContext, then split commands into family files

**Status:** APPROVED (codex plan-audit: GO-WITH-CHANGES, thread enforce-integrity-audit
2026-06-09). The three required plan edits are folded in below (CommandMutator split /
mutate locus / keyed-failure injection / mandatory goldens / corrected Hyrum numbers).
**Supersedes:** the `quality-closure-refactors.md` §W8 sketch (which was option A — move
command registrations into family files that each receive a ~15-field `RegisterDeps`
bundle). A-as-specced is a mechanical relocation: it moves the command closures behind a
different filename but leaves every family coupled to all ~15 helpers (the plan's own
"NOT scored" caveat). Option B targets the actual complexity reduction.

## Problem (measured)

`src/cli.tsx` is 6346 lines. `main()` (505–~6240) holds three things:
1. ~470 lines pre-parse / program setup (505–973).
2. **~380 lines of a shared helper cluster (977–1353)** — `actor` + ~15 interdependent
   closures every command action closes over: `fail` / `emitFailure` /
   `emitNoSessionFailure` / `resolveHumanActorOrFail` / `dispatchOrFail` /
   `dispatchForHookOptional` / `resolveHookPath` / `resolveDispatchForWriteGuard` /
   `emitDryRunSuccess` / `rejectIfDryRun` / `emitMutatorSchemaAndExit` / `routeMutateFailure` /
   `mctxFor` / `finishMutate` / `runMutator` (overloaded) / `loadProjectionsOrFail`.
3. **~4900 lines of ~30 inline `.command().action()` registrations (1355–6240).**

The bloat is (3); the coupling magnet is (2). Any family extraction that doesn't address
(2) just threads a fat bundle.

## Key observation

Most of the (2) cluster are **thin shims over the existing `CommandContext`** (the 982-line
comment says so explicitly — "fail()/emitFailure() become thin shims so all 28 unmigrated
commands transparently route through ctx"):
- `emitFailure` → `ctx.failureKeyed` (keyed) else `ctx.failure` (the `emitKeyedFailure`
  try-keyed-then-plain wrapper).
- `emitNoSessionFailure` → `ctx.failureKeyed("NO_SESSION", …)`.
- `dispatchOrFail` / `dispatchForHookOptional` / `resolveDispatchForWriteGuard` →
  `ctx.resolveDispatch` + emit + `ctx.recordTraceTarget`.
- `loadProjectionsOrFail` → `ctx.resolveProjections` + emit.
- `rejectIfDryRun` / `emitDryRunSuccess` → `ctx.dryRun` + `ctx.failure`/`ctx.success`.
- `resolveHumanActorOrFail` → `resolveHumanActor` (core) + `ctx.noInput` + emit.

CommandContext already OWNS output / presentation / dispatch / session-load / failure
routing. Folding these shims into it is cohesive — they are the same responsibility
(presentation-side command plumbing), not a new one.

## Plan

### Phase 0 — relocate the cluster into TWO cohesive surfaces (the deep-module move)

codex GO-WITH-CHANGES required this split — do NOT fold all 15 onto a flat ~35-member ctx.

**0a — presentation shims → CommandContext methods.** The ~10 thin ctx-shims
(`src/cli.tsx:1000-1228` + `1330-1353`): `fail` / `emitFailure` / `emitNoSessionFailure` /
`resolveHumanActorOrFail` / `dispatchOrFail` / `dispatchForHookOptional` / `resolveHookPath` /
`resolveDispatchForWriteGuard` / `emitDryRunSuccess` / `rejectIfDryRun` / `loadProjectionsOrFail`.
These are cohesive with ctx's existing failure/dispatch/session responsibility. New
`CommandContextDeps` fields (all already injectable from `main()`):
- `readGitConfig?: () => string | null` / `isInteractiveHuman?: () => boolean`
  (`resolveHumanActorOrFail`; already MainDeps fields).
- `readStdin?: () => Promise<string>` / `isStdinTty?: () => boolean` (`resolveHookPath`).
- keyed-failure mapper — **decided (codex tension 3):** extract `diagnosticVarsFor` into a new
  small `src/cli/diagnostic-failure.ts` (single-source); ctx imports it for `emitFailure`'s
  try-keyed-then-plain logic. `diagnosticKey` / `MigratedDiagnosticCode` already live in
  `src/cli/runtime-i18n-keys.ts`. Do NOT move `diagnosticVarsFor` wholesale into
  command-context.ts; the dedicated module keeps ctx generic.

**0b — mutation orchestration → `src/cli/command-mutator.ts` (NEW).** `runMutator` (overloaded) /
`mctxFor` / `finishMutate` / `routeMutateFailure` / `emitMutatorSchemaAndExit`
(`src/cli.tsx:1249-1320` + `1225-1228`) become a `CommandMutator` built by
`createCommandMutator(ctx, deps)`. **This module — not command-context.ts — imports
`mutate`/`mutateBatch` (stable core).** command-context.ts MUST NOT import mutate/mutateBatch
(codex tension 2: keeps every ctx consumer off the mutation-orchestration surface). The
mutator depends on ctx for `dryRun` / `success` / `failure` / `failureKeyed` and on
`registryWriter` (from deps) for `mctxFor`.

`actor` (a pure `cli:loaf@<user>` string) is NOT context — it stays a `main()` const passed to
family `register*` functions. Families receive `(program, ctx, mutator, actor)`.

After Phase 0, `main()`'s helper cluster is deleted; the ~30 action bodies call
`ctx.emitFailure` / `ctx.dispatchOrFail` / `mutator.run` / `mutator.emitSchemaAndExit` instead of
the bare closures. **Phase 0 is behavior-preserving and independently shippable ONLY together
with the 0a/0b split + unit coverage for both surfaces** (codex tension 4 — a flat +15-method
ctx with no split would be churn-without-payoff).

**Mandatory before/after goldens (codex required — Hyrum surface is large).** Before Phase 0,
capture goldens of `--help` (root + each subcommand group) + representative success/failure
JSON + stderr for a spread of commands. Diff after 0a, after 0b, and after each family commit.
Measured Hyrum surface in `tests/core/cli.test.ts`: ~250 `runCli(` invocations, ~160
exact-ish stdout/stderr expectations, ~95 `toContain` — do NOT reword any string during the move.

### Phase 1..N — split command registrations into family files

With (2) split into ctx (0a) + mutator (0b), each family file needs only
`(program, ctx, mutator, actor)`:

    // src/cli/commands/evidence.tsx
    export function registerEvidence(
      program: Command, ctx: CommandContext, mutator: CommandMutator, actor: string,
    ): void { … }

`main()` shrinks to: setup → build ctx + mutator → `registerEvidence(program, ctx, mutator, actor)` … →
`program.parseAsync`. Families, leaf-first (disjoint command subtrees):
evidence+waive → lessons → pending → finding → tasks(+step) → gate →
terminal(deliver/archive/abandon/settle/resume/handoff) → spike/profile/config/doctor/hook →
sessions/check/verify/state → lifecycle(start/advance/status/next). Lifecycle last (most
cross-cutting). One family per commit.

### Verification (every commit)

- `tests/cli/*` (esp. `command-context.test.ts` for Phase 0; the 151 `runCli` integration
  cases in `tests/core/cli.test.ts` for Phase 1+) + full `bun run test` green.
- `bunx madge --circular` clean (the import graph must not regenerate cycles —
  command-context.ts importing mutate/mutateBatch is new; verify no cycle).
- `bun run lint` + `bun run typecheck` + `bun run build`.
- Optional golden snapshot of `--help` + representative command JSON before Phase 0, diffed
  after each commit (Hyrum drift the unit tests miss — 28 `stderr.toContain` substring
  matches are fragile; do not reword strings during the move).

## Design tensions for codex to adjudicate (audit asks)

1. **God-object risk.** CommandContext already exposes ~20 members; folding +15 makes ~35.
   Is that a cohesive deep module, or should the mutation helpers (`runMutator` / `mctxFor` /
   `finishMutate` / `routeMutateFailure` / `emitMutatorSchemaAndExit`) live in a SEPARATE
   `CommandMutator` object (built atop ctx) rather than on ctx itself? Cohesion vs surface.
2. **Stable-core ↔ presentation boundary (the `cli-layering-gates` line).** `runMutator`
   pulls `mutate` / `mutateBatch` (stable-core) into `command-context.ts` (presentation).
   Today cli.tsx already imports them, so the dependency exists — but is concentrating
   mutation orchestration in the presentation context a boundary violation, or is `runMutator`
   legitimately presentation (it owns dry-run routing + failure-route selection + success
   formatting, all presentation concerns)? Where should the mutate/mutateBatch call site live?
3. **Keyed-failure mapping locus.** `emitFailure`'s `emitKeyedFailure` depends on
   `diagnosticVarsFor` / `diagnosticKey` / the `MigratedDiagnosticCode` catalog. Move the
   mapping into command-context.ts (ctx owns the full keyed-failure decision), or keep it in
   cli.tsx and inject as a `keyedFailureVars` function dep (ctx stays thin, cli.tsx keeps the
   catalog knowledge)? Trade: single-source vs context-bloat.
4. **Is Phase 0 worth shipping alone?** If Phase 1+ (family split) stalls or de-scopes, does
   Phase 0 (cluster → ctx) stand on its own as a net improvement, or is it only justified as
   setup for the family split (i.e. churn with no payoff unless the families follow)?
5. **Sequencing risk.** Any reason NOT to do Phase 0 first as one atomic commit (it touches
   ~30 call sites for the `emitFailure(` → `ctx.emitFailure(` rename)? Would a per-helper
   migration (one closure at a time) be safer given the 28 Hyrum-fragile substring assertions?

## Out of scope
- cli.tsx pre-parse / program-setup region (505–973) — not part of this split.
- `dist/cli.mjs` rebuild (release-time only; this is a non-release refactor series).
