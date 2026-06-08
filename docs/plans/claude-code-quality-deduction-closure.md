# Plan — code-quality deduction closure (Claude independent review)

**Status:** DRAFT FOR THIRD-PARTY AUDIT.
**Type:** quality / architecture closure plan.
**Author basis:** independent read-only scorecard, 2026-06-07. Three parallel
subsystem audits (cli.tsx / reducer+preflight / gates+schema+i18n) plus direct
verification of the transactional core, release gates, and two refuted "high
severity" claims.

**Current score basis:** **7.5 / 10 overall.** The protocol kernel subsystem
(mutator / reducer / journal / gates pure-core / tests / types) is ~8.5; the
repo is dragged to 7.5 by release-gate hygiene, dependency cycles, CLI
duplication residue, an untested preflight error-priority, and the absence of any
lint/format toolchain. (Note: file *length* — `cli.tsx` 6.4k, `preflight.ts`
1.9k — is explicitly NOT a deduction; see the P4 design principle.) **No BLOCK-severity live bug was found in any of the
three audited subsystems.**

This is a sibling document to `code-quality-deduction-closure.md` (the earlier
third-party-draft plan). The two AGREE on P0 release gates and dependency cycles.
They DIVERGE on file-splitting: applying *cohesion over length* (see the P4
design principle), this document demotes the CLI namespace split (P5) and the
preflight policy-cluster split (P6.2) to **optional, non-scored** navigability
investments, whereas the sibling still scores them as closure work — **on split
scoring this document supersedes the sibling** (a reconciliation note sits at the
sibling's top). The items unique to this review are P1 (stable-core contract
hardening), P3 (lint/format toolchain), P7 (reducer.apply contract), the
"Investigated and refuted" guard, the kernel-specific 9/9.5/10 ladder, and the §0
single-writer-lock reframing. This document is implementation-oriented: each item
states priority, why, how, pseudocode, and a verification path. It is not an ADR
and does not authorize implementation by itself.

---

## 0. Single-writer lock — reframed (operator decision, 2026-06-07)

**Operator decision:** same-feature concurrent development never happens in the
current real-world model. The lock therefore does NOT need acquire/wait/timeout/
PID-stealing/release machinery. It only needs to **throw on detected
contention** ("直接 throw 出来这个情况就行").

**Key finding — the throw is already implemented (optimistic CAS).**
`appendMany` re-reads the on-disk journal tail immediately before writing
(`src/core/journal-append.ts:150` `readJournalTail`) and validates `priorMeta`
against on-disk truth on three axes — `last_applied_seq`, `last_entry_line_hash`,
`last_entry_offset` (`journal-append.ts:172-204`). Any mismatch is a hard
`PRIOR_META_STALE` throw with the journal left untouched. Two sequential writers
where the second read a now-stale tail → the second throws. This IS the
"throw on contention" guard; `backlog.md` slice-5 (flock + PID + 30s timeout +
`LOCK_TIMEOUT` / `LOCK_HELD_BY`) is **not required** and should be closed, not
implemented.

**Residual gap (narrow TOCTOU, optional to close).** Between `readJournalTail`
and the `O_APPEND` write there is no mutual exclusion. If two processes read the
SAME tail simultaneously, both pass `PRIOR_META_STALE` validation, and both
`O_APPEND`-write, the journal gets two lines at the same `seq` (recoverable only
by `loaf doctor --check-tail`). The operator assumption (no same-feature
parallelism) means this window is never exercised today.

### 0.1 Decision: close slice-5; optionally add a thin O_EXCL throw-only guard

Priority: **P4-optional.** Do this only if you want the no-parallelism
invariant *enforced in code* rather than *assumed by operations*.

How (if taken): a create-and-throw lock — NO wait loop, NO timeout, NO PID
stealing. `O_CREAT | O_EXCL` creation is atomic on local filesystems; existence
== contention == throw.

Pseudocode:

```ts
// src/core/journal-lock.ts  (new leaf module; IO only)
export async function withWriteLock<T>(featureDir: string, body: () => Promise<T>): Promise<T> {
  const lockPath = path.join(featureDir, ".lock");
  let fh: FileHandle;
  try {
    fh = await fsp.open(lockPath, O_CREAT | O_EXCL | O_WRONLY, 0o644);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MutateLockError("LOCK_HELD",
        `another writer holds ${featureDir}/.lock; same-feature concurrent writes are unsupported`,
        { lock_path: lockPath });
    }
    throw err;
  }
  try {
    return await body();
  } finally {
    await fh.close();
    await fsp.rm(lockPath, { force: true });   // best-effort release
  }
}
```

Wire it in `mutateBatch` around Pass 2..step 9 (the disk-touching span), NOT
around the dry-run-only early return. Add `LOCK_HELD` to `MutateFailureCode` +
`ERROR_CATALOG` + i18n (see P0/P5 catalog discipline). A crashed writer leaves a
stale `.lock`; document `loaf doctor` (or `rm .loaf/<f>/.lock`) as the manual
clear, since there is no PID/timeout auto-steal by design.

Verification:

```bash
# two writers race; exactly one wins, the other throws LOCK_HELD (not corruption)
bun run test -- tests/core/journal-lock.test.ts
```

Third-party audit focus:

- Confirm the guard is throw-only (no blocking acquire, no timeout, no PID
  logic) — anything more re-introduces the rejected slice-5 machinery.
- Confirm `PRIOR_META_STALE` remains the primary correctness guard and the lock
  is a redundant explicit fence, not a replacement.

---

## Implementation conventions — the implementer MUST follow

This section governs EVERY P-item below. Naming in past implementations drifted
from both industry convention and this codebase's existing vocabulary; the rules
here are not stylistic preference — they are derived from the symbols already in
`src/` and are mandatory. Match what is already there; do not invent a parallel
dialect.

### Functional-first; classes ONLY for Error subtypes

The codebase is functional. Every `class` in `src/` is an `Error` subtype
(`AppendError`, `MigrationError`, `NoSessionError`, `SnapshotStaleError`,
`EditorTokenizeError`). **Do not introduce a domain/service class.** A unit of
behavior is a pure function (optionally with an injected `*Deps` object for IO),
not an object with methods.

- MUST NOT create `*Manager`, `*Service`, `*Helper`, `*Util(s)`, `*Handler`,
  `*Processor`, `*Controller`, `*Factory`, `*Coordinator`, `*Impl` classes. These
  are shallow-module smells (Ousterhout) and do not exist anywhere in this repo.
- MUST express the work as a function. If it needs IO, inject it:
  `function writeRegistryFile(id, file, deps: RegistryWriterDeps)`, not
  `new RegistryWriter(deps).write(...)`.
- A new `class` is allowed ONLY when it `extends Error`; it MUST be named
  `<Subject>Error` and carry a SCREAMING_SNAKE `code` field, mirroring
  `AppendError` (`journal-append.ts:95`).

### Functions: verb-first camelCase, from the established vocabulary

Functions are `verbNoun` in camelCase. Prefer an established verb over a synonym
— consistency is the point. This is a PREFERRED vocabulary plus allowed
role-specific extensions, NOT a closed universe; a new verb is allowed when none
of the established ones fits, but the implementer MUST state why in the VR/PR.

**Primary stable-core verbs** (the table below). **Also established** (presentation
/ adapter / domain): `render` / `create` / `default` (factory-defaults) / `run` /
`extract` / `choose` / `sanitize` / `tokenize` / `classify` / `shape` / `map` /
`split` / `extend` / `truncate`. **Local-only** `eval*` is allowed solely for
private gate-check helpers under a public `evaluate*` / `*Check` surface (e.g.
`evalLaneStatus`).

| Verb | Meaning in this repo | Example |
|---|---|---|
| `evaluate*` | run a gate / policy, return a structured verdict | `evaluateTaskProof`, `evaluateSpecLock` |
| `derive*` | compute a projection-local value from a snapshot | `deriveImplementers`, `deriveCheckApplicability` |
| `check*` | a single pure validation predicate returning a typed result | `checkSpecVersion`, `checkBaseAuthority` |
| `find*` | locate an item / collision in a collection | `findCollision`, `findDuplicateId` |
| `build*` / `compose*` | assemble a value object | `buildRegistryFile`, `composeProjections` |
| `resolve*` | turn ambiguous input into a concrete value via policy | `resolveHumanActor`, `resolveSpecVersionMode` |
| `read*` / `write*` | the IO boundary | `readSpecFrontmatter`, `writeProjections` |
| `load*` | read + parse + validate into a typed projection | `loadSession`, `loadProjections` |
| `parse*` / `format*` | string ⇄ structure | `parseInputSource`, `formatRow` |
| `allocate*` / `emit*` | mint an id / surface an output | `allocateEvidenceId`, `emitFailure` |

- MUST NOT name a function with a noun (`taskProof()`), a vague verb
  (`doCheck`, `processEntry`, `handleSpec`, `manageLock`), or a novel synonym
  when an established verb fits (`computeImplementers` → use `derive*`;
  `validateSpecLock` for the gate → use `evaluate*`). "It would be falsely
  flagged" examples that ARE correct and must NOT be renamed: `createI18n`,
  `renderSuccessText`, `defaultFeatureDir`, `runEditor`, `extractFeature`,
  `chooseNextAction`, `classifyDetailOutcome`, `splitFrontmatter`,
  `extendRollingChecksum`.
- Booleans/predicates MUST start `is`/`has`/`can` and return `boolean`:
  `isPassingResult`, `hasOpenFindings`, `canSatisfy`. Never a noun
  (`passingResult`) for a predicate.

### Types & interfaces: PascalCase noun + role suffix

Types are nouns. The suffix encodes role. The set below is the **closed default
for NEW stable-core protocol types**; existing repo suffixes are allowed when they
*precisely* describe the role.

Default set: `*Result` (operation outcome union) · `*Payload` (journal entry
body) · `*Input` (CLI/caller input schema) · `*State` (projection slice) ·
`*Context` (the bag a function receives) · `*Options` (optional behavior flags) ·
`*Code` (a SCREAMING_SNAKE union of failure codes) · `*Deps` (injected IO seam) ·
`*Kind` (closed enum discriminator) · `*Entry` (a journal record) · `*Json`
(on-disk projection shape).

Also established in `src/`, allowed when precise: `*Args` (a function's argument
bag, e.g. `RunEditorArgs`) · `*Envelope` (`VerifyStatusEnvelope`) · `*Policy`
(`TaskProofPolicy`) · `*Source` (`InputSource`) · `*Resolution`
(`LocaleResolution`) · `*Output` · `*Load` (`SessionLoad`) · `*Projection` ·
`*Snapshot` · `*Meta` · `*Mode` · `*Status` · `*Action` · `*Config` · `*Check` ·
`*Warning` · `*Id` · `*Key`.

- MUST NOT invent a vague synonym suffix for a NEW public/stable-core name:
  `*Info`, `*Data`, `*Wrapper`, `*Object`, generic `*Type`, or a new abstraction
  `*Manager` / `*Service`. (`Handler` already exists in legacy `SigintHandlerDeps`;
  the ban is on NEW symbols — do not rename the legacy one for a behavior-
  preserving edit.)
- MUST NOT stutter (`EvidenceEvidenceState`) or encode the module into the type
  (`PreflightPreflightResult`).
- For an expected recoverable failure at an API that ALREADY returns a `{ok}`
  union (`MutateResult`, `PreflightResult`), follow that shape:
  `{ ok: true; ... } | { ok: false; code: <X>Code; message: string; detail?: ... }`
  — do not switch such an API to bare `null`/throw. (Reader control-flow that
  throws a typed `*Error` — `loadSession` → `NoSessionError` /
  `SnapshotStaleError` — is an accepted existing pattern; keep it, don't convert.)

### Diagnostic / failure codes: SCREAMING_SNAKE, NOUN_CONDITION, registered

New codes MUST follow the existing grammar `SUBJECT_CONDITION` and be registered
in all four places in one change (CLAUDE.md): the runtime union (e.g.
`PreflightFailureCode`), `docs/schemas.ts` `DiagnosticCode` + `ERROR_CATALOG`,
and `i18n/en.json` + `i18n/zh.json`.

- Pattern: `ACTOR_AUTHORITY_VIOLATION`, `SPEC_FRONTMATTER_INVALID`,
  `TASK_DONE_NO_EVIDENCE`, `PRIOR_META_STALE` — read the verb/condition off the
  existing catalog; do NOT invent a near-synonym (`ACTOR_NOT_ALLOWED` when
  `ACTOR_AUTHORITY_VIOLATION` exists was a real drift caught in review).
- Before adding a code, `rg` the catalog for an existing one that fits.

### Files: kebab-case, named after the exported unit

`journal-mutate.ts`, `verify-accept-check.ts`, `evidence-id-allocator.ts`. A new
file is named after its **primary concept/export** (a multi-symbol module like
`command-context.ts` / `runtime-i18n-keys.ts` names the concept, not one symbol),
not a category bucket (`utils.ts`/`helpers.ts`/`misc.ts` are forbidden).

### Self-check before any commit in this plan

```
- every new class extends Error and ends in `Error`         [y/n]
- every new function is verbNoun, verb from established vocab
  or a justified new verb (reason stated in the VR)             [y/n]
- every new type is a noun with an existing role suffix      [y/n]
- every new code is SCREAMING_SNAKE + registered in 4 places [y/n]
- rg confirmed no existing symbol/code already covers it     [y/n]
```

---

## P0 — Make release gates green again

Priority: **P0** — release blockers, not architecture taste. For a project that
ships straight from git with the committed `dist/cli.mjs` as the artifact, a red
release gate means the repo cannot be honestly described as release-ready even
though typecheck (clean), tests (2234 passed), and build are green.

### P0.1 Add the missing `[0.3.0]` CHANGELOG reference link

Evidence: `package.json` is `0.3.0`; `CHANGELOG.md` reference links stop at
`[0.2.0]` (`grep -nE '^\[0\.[0-9]+\.[0-9]+\]:' CHANGELOG.md` → 0.2.0 / 0.1.2 /
0.1.1 / 0.1.0, no 0.3.0). `scripts/ga-consistency-check.sh` requires both the
`## [<version>]` header and a matching `[<version>]: ...v<version>` link line.

How: add the reference link; do NOT weaken the gate regex.

```md
[0.3.0]: https://github.com/est7/loaf/releases/tag/v0.3.0
```

Verification: `bash scripts/ga-consistency-check.sh --no-fetch` (run on a clean
worktree — it fails `WORKTREE_DIRTY` first if uncommitted files are present).

### P0.2 Stop `check-event-drift.sh` scanning generated `dist` sourcemaps

Evidence: `bash scripts/check-event-drift.sh` fails on `dist/cli.mjs.map`; the
hit is inside the sourcemap's `sourcesContent`, not a live source file. The
script excludes `.git` / `i18n` / `node_modules` but not `dist`.

How: add `dist` (and `coverage`) to the script's `EXCLUDE_DIRS`. A gate that
fails on generated output trains maintainers to distrust it.

```bash
EXCLUDE_DIRS=( ".git" "dist" "coverage" "i18n" "node_modules" )
```

Regression test: write `dist/cli.mjs.map` containing a drift term, run the
script, expect exit 0.

Third-party audit focus: confirm `dist` is excluded because it is generated, not
because the drift term is acceptable; canonical source files must still be
scanned.

---

## P1 — Cheap stable-core contract hardening (surgical, low risk)

Priority: **P1** — these are small, isolated fixes that close genuine
correctness/maintainability erosion without touching architecture. High
benefit-per-line. None is a live bug today; each is a latent trap.

### P1.1 Enforce the documented `manual ⇒ result ≠ waived` invariant

Evidence: `src/core/evidence-schema.ts:49` comment states "kind=manual implies
result≠waived" but no refine enforces it. `EvidenceFullPayload` (`:181`) already
refines `manual|waiver → actor=human:* + reason≥10`, so there is **no privilege
bypass** (a refuted earlier claim — see §Refuted). The residual is purely the
unenforced semantic invariant: a human can record `kind=manual, result=waived`,
which should be a `waiver`.

How: extend the existing refine chain.

```ts
.refine((e) => !(e.kind === "manual" && e.result === "waived"), {
  message: "evidence kind=manual must not carry result=waived; use kind=waiver",
})
```

Verification: `bun run test -- tests/core/evidence.test.ts` + a RED test that a
`manual/waived` payload is rejected with the new message.

### P1.2 Delete (or rename) the 5 stale-rename i18n diagnostic keys

Evidence: `i18n/en.json:diagnostic` carries keys that are stale renames of
live codes — `TASK_KIND_SCHEMA_INVALID` (live: `TASK_KIND_SCHEMA_VIOLATION`),
`E2E_ACCEPTANCE_UNRESOLVED` (live: `E2E_SCENARIO_UNBOUND`),
`VISUAL_CONTRACT_UNRESOLVED` (live: `VISUAL_CONTRACT_UNBOUND`),
`NO_OPEN_CLARIFICATIONS` (live: `SPEC_HAS_UNCLARIFIED`), `TASKS_VERSION_MISMATCH`
(live: `TASKS_BASED_ON_STALE`). Gate-code localization is an intentional scope
cut (the inventory gate enforces only `emit ⊆ catalog ∪ baseline`), so the
missing ~60 entries are out of scope — but the stale-rename keys actively
mislead the next person who wires gate-code i18n.

How: delete the 5 keys from `en.json` + `zh.json` (keep parity — both files are
406 keys today). If gate-code localization is later taken in-scope, add entries
under the *live* code names.

Verification: `bun run test -- tests/cli/runtime-i18n-keys.test.ts` (parity) +
`bunx vitest run tests/scripts/cli-inventory.test.ts` (drift gate still green).

### P1.3 (CLI routing layer, not stable-core) Reuse the dispatched feature dir in `tasks amend` sponsored path

Evidence: `src/cli.tsx:3287` resolves `earlyFeatureDir = await dispatchOrFail(opts)`
(which also writes `opts.featureDir`), but the sponsored branch at `:3348`
reconstructs `opts.featureDir ?? defaultFeatureDir(opts.feature)`. Correct only
by accident today (dispatch already wrote `opts.featureDir`); any future change
to dispatch precedence (e.g. `--session` resolving a dir ≠ `defaultFeatureDir`)
would write the sponsored amend to the wrong feature while trace/crash context
point at the right one. The `--policy` branch (`:3490`) correctly re-dispatches.

How: use `earlyFeatureDir` directly in the sponsored branch.

```ts
const sFeatureDir = earlyFeatureDir;   // not: opts.featureDir ?? defaultFeatureDir(...)
```

Verification: `bun run test -- tests/core/cli.test.ts` (amend coverage) +
`tests/core/sponsored-tasks-amended.test.ts`.

### P1.4 Replace the drift-check `JSON.stringify` equality

Evidence: `src/core/journal-mutate.ts:448` compares two snapshots with
`JSON.stringify(finalSnapshot) !== JSON.stringify(snapshotAcc)`. Key-order- and
`undefined`-sensitive, and O(snapshot) per batch. Both snapshots derive from
`structuredClone` of the same source mutated by the same reducer in the same
order, so today key order is stable — but the equality is fragile to any future
reducer that builds objects via spread in a different order.

How: a structural deep-equal helper (or a stable-key hash). Low urgency; the
guard is currently a documented no-op forward-compat fence.

Verification: `bun run test -- tests/core/journal-mutate.test.ts` +
`tests/core/batch-atomicity.test.ts`.

---

## P2 — Remove circular dependencies

Priority: **P2.** `bunx madge --circular --extensions ts,tsx src` reports 4:

```text
core/reducer.ts > core/reducer/preflight.ts > core/gates/task-proof.ts > core/gates/evidence-result.ts
core/reducer.ts > core/reducer/preflight.ts > core/gates/task-proof.ts
core/reducer.ts > core/reducer/preflight.ts
cli/runtime-i18n-keys.ts > cli/tui/list-model.ts > cli/sessions-list.ts
```

All are type-only (no runtime effect under `verbatimModuleSyntax`), but
tool-visible and they blur the stable-core layering: `reducer.ts` should sit
*below* preflight/gates, not be imported by them.

### P2.1 Extract shared projection types to a leaf module

How: move `Snapshot` / `SessionState` / `TaskState` / `EvidenceState` /
`FindingState` / `PendingState` out of `reducer.ts` into a true leaf
`src/core/projection-types.ts` that imports nothing from reducer/preflight/gates/
CLI/IO. `reducer.ts` keeps `apply()` / `initialSnapshot()` and re-exports the
types for compatibility; gates import the leaf.

```ts
// src/core/projection-types.ts  — leaf, zero internal imports
export interface Snapshot { /* ... */ }
// src/core/gates/task-proof.ts
import type { Snapshot, TaskState, EvidenceState } from "../projection-types.js";
```

### P2.2 Extract the TUI status-bucket type to a leaf

How: `src/cli/tui/types.ts` exports `TuiStatusBucket`; `runtime-i18n-keys.ts`
and `list-model.ts` import it instead of `runtime-i18n-keys → list-model →
sessions-list`.

Verification (both):

```bash
bun run typecheck && bun run test
bunx madge --circular --extensions ts,tsx src   # expect 0
```

Third-party audit focus: confirm each new module is a true leaf (no import back
into reducer/preflight/gates/CLI/IO), and that the fix removes the cycle rather
than hiding it behind `import type` only.

---

## P3 — Introduce a lint / format toolchain

Priority: **P3.** Evidence: no `eslint` / `biome` / `prettier` / `oxlint` config
anywhere, no `lint` script in `package.json`. A 24k-LOC, AI-assisted protocol
kernel that explicitly values long-term maintainability currently enforces style
consistency by manual discipline + strict `tsc` only — but `tsc` is not a linter
or a formatter. This is the deduction the earlier plan missed.

How: adopt `biome` (single binary, lint + format, fast, zero-config-friendly) or
`oxlint`. Add `check`-time enforcement. Do NOT bulk-reformat the whole tree in
the same commit as the config (keep the formatting churn isolated and reviewable;
Tidy First).

```jsonc
// package.json scripts
"lint": "biome check src tests",
"format": "biome format --write src tests",
// fold into the existing gate
"check": "bun run typecheck && bun run lint && bun run test && bun run build"
```

Implementation order: (1) add config + `lint`/`format` scripts; (2) one isolated
`style:` commit running `format --write`; (3) fix or `// biome-ignore` the
remaining lint findings; (4) wire `lint` into `check` only once green.

Third-party audit focus: confirm the formatter is added with an isolated
reformat commit (no behavior change mixed in), and that the rule set is not so
permissive it enforces nothing.

---

## P4 — Close the post-dedup duplication residue in `src/cli.tsx`

Priority: **P4.** The recent dedup refactor (runMutator / mctxFor / finishMutate
/ dispatchOrFail) removed the per-command envelope/ctx/routing duplication, but
two copy-paste blocks survived. P4.1/P4.2 are the genuine deductions here and
should land regardless of whether a namespace split (P5) is ever chosen — they
remove coupling, not length.

**Design principle (governs P4–P6): cohesion over length.** File size is NOT a
defect. A long file with a single responsibility and no internal duplication is
easy to understand and cheap to change; a deep module (one clean API, much logic
behind it) is *preferable* to several shallow ones (Ousterhout). The cost worth
paying down is **change amplification and coupling**, not line count. So the only
things in P4 that are genuine deductions are the **duplication** items (P4.1,
P4.2) — duplication is coupling, independent of length. The actual file-splitting
(P5) and the hook-handler extraction (P4.3) are demoted to **optional, non-scored
navigability/SRP investments**, not quality defects. This matches the project's
own `backlog.md` A1 classification: "length, not tangle."

### P4.1 Extract `resolveHumanActorOrFail()`

Evidence: the identical 5-line human-actor resolution block appears at 10 sites
(`src/cli.tsx:1710, 1885, 1969, 2029, 2115, 2215, 4079, 4589, 4711, 5898`); one
of them (`deliver`, `:1891`) routes failure via `ctx.failure` while the rest use
`emitFailure` — an undocumented divergence that looks like drift.

How: one closure over `ctx`/deps mirroring `dispatchOrFail`'s shape.

```ts
function resolveHumanActorOrFail(): string | null {
  const r = resolveHumanActor({ env: process.env, readGitConfig: readGitConfigForActor,
                                isInteractiveHuman: isInteractiveHumanForActor() });
  if (!r.ok) { emitFailure(r.code, r.message); return null; }
  return r.actor;
}
```

Collapses ~50 lines and removes the `ctx.failure`-vs-`emitFailure` inconsistency
for free.

### P4.2 Extract pre-parse selector / render-mode helpers

Evidence: the selector-detection block is repeated 4× (`:579, 618, 725, 781`)
and the `renderAsJson` detection ~8× across the pre-parse section.

```ts
function collectPresentSelectors(argv: string[], env: NodeJS.ProcessEnv): string[]
function detectRenderAsJson(argv: string[]): boolean
```

### P4.3 (optional, non-scored) Extract per-event hook handlers

NOT a length deduction. `loaf hook <event>` is a ~200-line closure
(`:4784-4984`) bundling 5 distinct event handlers (session-start / closure-check
/ scope-track / write-guard). The mild smell is SRP — five handlers that change
for different reasons share one closure — not size; the heavy policy already
lives in `src/core/write-guard.ts`, so what's in `cli.tsx` is mostly wiring.
Extract only if the SRP separation actually helps; do not count it against the
score.

How (if taken): move each handler to `src/cli/hook-<event>.ts` (`handleWriteGuard`,
`handleSessionStart`, `handleScopeTrack`, `handleClosureCheck`). Preserve the
fail-closed (write-guard) / fail-open (lifecycle) contracts exactly — the broad
`catch {}` blocks are correct by contract and must stay.

Verification per item: `bun run typecheck && bun run test -- tests/cli/` +
`tests/scripts/cli-inventory.test.ts`. Deletion test: `cli.tsx` must lose
meaningful LOC and imports; a new module must not be a pass-through wrapper.

---

## P5 — (optional, non-scored) Thin `src/cli.tsx` by command namespace

**Demoted to optional — NOT a quality deduction.** Per the P4 design principle,
once duplication is removed (P4), `src/cli.tsx` is a single-responsibility
command-wiring layer; length alone is not a defect. Splitting also has a real
cost: threading the ~12 shared helper closures into a passed
`CommandRegistrationEnv` adds an abstraction every contributor must learn — the
exact accidental complexity Ousterhout warns against. Do this ONLY as an
AI-navigability investment when full-file loads / editing `cli.tsx` are an active
pain (the `backlog.md` A1 trigger), and it must not raise the score by itself.

`src/cli.tsx` is ~6.4k LOC owning Commander setup, global option parsing, output
wiring, dispatch/actor/mutator helpers, and ~45-60 inline command actions. If
taken, do it AFTER P4 so the helpers being threaded are already deduped.

Design rule (do NOT build a generic command framework): extract real namespaces
that own a command family end-to-end — Commander registration, action-local
parsing, command-local text rendering, command-local payload construction.
Shared protocol decisions stay in stable core / existing builders.

```text
src/cli/main.ts                 # global setup + program construction
src/cli/commands/{spec,tasks,evidence,sessions,hooks,pending,finding}.ts
                                # register<Group>(program, env)
```

```ts
export function registerTasksCommands(program: Command, env: CommandRegistrationEnv): void {
  const tasks = program.command("tasks");
  tasks.command("submit").action(async (opts) => {
    const featureDir = await env.dispatchOrFail(opts);
    if (featureDir === null) return;
    // unchanged action body, local to the namespace
  });
}
```

Implementation order: read-only namespaces first (`sessions`, `verify status`,
`check`, `tui`) → hooks → smaller mutating (`pending`, `finding`, `evidence`,
`lessons`) → high-density last (`tasks`, `spec`). One namespace per commit,
audited.

Rejected shape (a shallow framework — looks smaller, forces maintainers to learn
a new registration DSL before changing one command):

```ts
registerCommand(program, { name: "tasks submit", options: TASKS_SUBMIT_OPTIONS,
  run: genericRunMutatingCommand("tasks.submit", TASKS_SUBMIT_MAPPING) });
```

Verification per slice + full: `bun run check`, `cli-inventory.test.ts`,
`bunx madge --circular`. Third-party audit focus: command modules must improve
locality, not add shallow wrappers; stable core must not import CLI presentation;
JSON/text/stderr channel contracts stay byte-compatible where tests pin them.

---

## P6 — Make preflight error-priority testable (the split is optional)

Priority: **P6** (last) — `preflight.ts` (~1.9k LOC) is a **deep module**: one
public API (`preflight`), one ordered failure surface. Its size is NOT the debt
— per the P4 design principle, a cohesive deep module beats several shallow ones.
The *real* debt is that **error precedence is encoded purely by physical
statement order** in a 1370-line function, with no priority table and no test
asserting "given an entry violating both X and Y, code X is returned." The
per-kind comment numbering (5a..5j) is non-monotonic in file order (5i precedes
5h precedes 5j; 5c.2 follows 5c.4), so precedence cannot be read off the labels.
Any edit can silently reorder it. **The fix is the test (P6.1), not the split.**

### P6.1 Pin the precedence contract with a table-driven test FIRST

This is the higher-value half and must precede any split — it makes the split
safe.

```ts
const PRECEDENCE_PAIRS: Array<{ entry: PartialEntry; ctx: PreflightContext; expect: PreflightFailureCode }> = [
  // entry that violates BOTH an envelope rule AND a per-kind rule → envelope wins
  { entry: badEnvelopeAndBadPayload, ctx, expect: "INVALID_ENVELOPE" },
  { entry: badActorAndBadTransition, ctx, expect: "ACTOR_AUTHORITY_VIOLATION" },
  // ... one row per load-bearing ordering documented only in prose today
];
test.each(PRECEDENCE_PAIRS)("preflight precedence: %#", ({ entry, ctx, expect: code }) => {
  const r = preflight(entry, ctx);
  expect(r.ok ? null : r.code).toBe(code);
});
```

### P6.2 (optional, non-scored) Split internal policy clusters behind ONE public API

**Demoted to optional — default: do NOT split.** Splitting a cohesive ordered
validator risks scattering the priority contract across 5 files, making
precedence *harder* to see — turning one deep module into several shallow ones,
a likely net negative. P6.1's test already buys the full "safe to edit priority"
benefit. Consider this ONLY if a policy cluster proves genuinely independent
(changes for a different reason) AND the ordered coordinator still owns priority.
If taken: keep `preflight(rawEntry, ctx): PreflightResult` as the sole public
surface and the owner of error priority; split only internal clusters; the
top-level function drives an explicit ordered list.

```text
src/core/reducer/preflight.ts                 # ordered coordinator (owns priority)
src/core/reducer/preflight/{task-lifecycle,spec-content,finding-policy,
                            session-policy,pending-policy}.ts
```

```ts
export function preflight(rawEntry: unknown, ctx: PreflightContext): PreflightResult {
  const parsed = parseEnvelope(rawEntry);            if (!parsed.ok) return parsed.failure;
  const base = checkBaseAuthority(parsed.entry, ctx); if (!base.ok) return base;
  for (const check of ORDERED_POLICY_CHECKS) {        // order IS the contract
    const r = check(parsed.entry, rawEntry, ctx);
    if (r && !r.ok) return r;
  }
  return checkTransition(parsed.entry, ctx) ?? { ok: true };
}
```

Verification: `bun run test -- tests/core/preflight-validation.test.ts
tests/core/reducer.test.ts tests/core/transition.test.ts
tests/core/e2e-lifecycle.test.ts`. Third-party audit focus: confirm this is
internal modularization (not a new public API), error priority is explicitly
tested, and no policy module imports CLI/presentation.

---

## P7 — Document or refactor the `reducer.apply()` half-pure contract

Priority: **P7** (fragility, not a live bug). `apply(prev, entry)` has a
pure-looking signature but half its cases mutate `prev` in place
(`prev.<array>.push(...)`, `src/core/reducer.ts:699/721/743/...`) and return a
shallow spread that *shares the mutated array reference* with the input. The only
sanctioned caller, `mutateBatch`, neutralizes this by `structuredClone`-ing
`ctx.snapshot` at both dry-run passes (`journal-mutate.ts:219, 434`), so external
callers are safe today. A second caller that trusts the signature gets an
aliasing bug. Secondary: `mode` for `checkSpecVersion` is recomputed independently
on the reducer and preflight sides (from `batch_index`) rather than shared, so
the "both layers delegate to one invariant" guarantee is thinner than the
`invariants.ts:6-8` comment claims — they agree only because `mutateBatch`
threads the bumped `spec_version` between iterations.

How (pick one):
- **Minimal:** brand the contract — rename to make in-place explicit (e.g.
  `applyInto(prev, entry)`), document "consumes `prev`; clone first if you need
  the prior state" on the signature, and unify the spec-add cases to push *last*
  (after all validation) so a future fallible refine can't leave a half-state.
- **Stronger:** clone-on-write uniformly, or pass the resolved `mode` through one
  helper both layers import instead of recomputing the head/continuation split.

Verification: `bun run test -- tests/core/reducer.test.ts tests/core/replay.test.ts`
+ a test that a caller holding the pre-`apply` snapshot does not observe later
pushes (documents the contract either way).

---

## Investigated and refuted — do NOT re-flag (audit guard)

Two findings raised during this review were verified false and must not be
re-opened as deductions:

1. **`event:phase_advanced` skipping transition validation** — REFUTED.
   `PhaseAdvancedPayload.from` is a required `SubState`
   (`src/core/journal-entry.ts:337`), not optional; `validateTransition` always
   runs. There is no `from`-absent bypass.
2. **`manual + waived` evidence "backdoor" granting a non-human/no-reason
   proof** — REFUTED as a bypass. `EvidenceFullPayload`
   (`src/core/evidence-schema.ts:181-192`) refines `manual|waiver →
   actor=human:* + reason≥10` regardless of `result`, and `EvidenceAddInput`
   re-validates through it. A `manual/waived` entry requires the same human +
   reason guarantee as a `waiver`. The only residual is the unenforced semantic
   invariant, addressed at **P1.1** (MINOR), not a privilege escalation.

---

## Recommended execution order

Scored closure work (in order):

1. **P0** release gates (cheap, restores release-ready honesty).
2. **P1** surgical contract hardening (small, isolated, high benefit/line).
3. **P2** type-cycle extraction (makes later refactors auditable).
4. **P3** lint/format toolchain (turns manual discipline into a gate).
5. **P4.1 / P4.2** CLI duplication cleanup (DRY — removes coupling, not length).
6. **P6.1** preflight precedence table-driven test.
7. **P7** reducer.apply contract (document or refactor).

Optional / non-scored — do ONLY on real navigability or change-amplification
evidence, NEVER for line count, and they must not raise the score by themselves:

- **P4.3** per-event hook handler extraction (mild SRP).
- **P5** CLI namespace split (one namespace per commit, if `cli.tsx` editing
  becomes an active cost).
- **P6.2** preflight policy-cluster split (only if a cluster proves genuinely
  independent; default off).
- **§0.1** O_EXCL throw-only lock (only if enforcing the no-parallel invariant in
  code is wanted; `PRIOR_META_STALE` already covers sequential contention).

## Score impact estimate

| Work | Expected score effect |
| --- | --- |
| P0 release gates green | 7.5 → 7.7 |
| P1 contract hardening | 7.7 → 7.9 |
| P2 cycles removed | 7.9 → 8.0 |
| P3 lint/format gate | 8.0 → 8.2 |
| P4 CLI duplication removed (DRY — not the split) | 8.2 → 8.4 |
| P6.1 preflight precedence test (not the split) | 8.4 → 8.6 |
| P7 reducer.apply contract documented/refactored | 8.6 → 8.7 |

The gains above come from removing **duplication** (P4) and adding a **precedence
test** (P6.1) — NOT from splitting files by length. The file-splitting items (P5,
P6.2) and the hook-handler extraction (P4.3) are optional navigability/SRP
investments and **must not raise the score by themselves**: per the design
principle, a cohesive long file is not a defect, and splitting a deep module into
shallow ones can lower the score. The score also must NOT rise if a change merely
moves code without improving locality, removes tests, weakens release gates, or
introduces a generic command framework callers must learn. Beyond ~8.7, see the **9 / 9.5 / 10 ladder**
below — it is grounded in this kernel's specifics (replay determinism,
projection equivalence, single-source invariants, cross-version journal
compatibility), complementing the more CLI/release-oriented ladder in the
sibling `code-quality-deduction-closure.md`.

## 9 / 9.5 / 10 ladder — beyond debt closure

P0–P7 close *today's* debt and land the repo near 8.7. The points above 8.7 are
a different class of work: not "fix a defect" but "prove the structure stays
correct and changeable under future evolution." For a single-typed-journal
protocol kernel, the load-bearing properties are: **replay is deterministic**,
**every artifact is a pure projection of the journal**, **every invariant is
defined once**, and **a journal written by version N is still readable by version
N+k**. The ladder below is organized around proving those, not around adding
volume.

Cost discipline (applies to the whole ladder): do NOT chase a higher number by
adding frameworks, generic registries, or generated abstractions before there
are multiple real consumers. Accidental complexity added speculatively LOWERS the
score. Each rung must pay for itself in regression safety, not in apparent
sophistication.

### 9.0 — clean today AND obviously changeable tomorrow

Proves: a maintainer adding a public protocol behavior has an obvious path
through docs → schema → stable core → CLI → tests → release gates, and the
release contract stays green by construction.

This rung includes the sibling doc's 9.0 items (command modules that own a real
slice of knowledge rather than a shallow framework; `ga:check` as the single
release entry point; a discoverable change-path for new protocol behavior) — not
repeated here. The kernel-specific additions:

#### 9.0.1 Replay ↔ incremental-write equivalence as a standing gate

Why: the entire truth model rests on "projections are a pure function of the
journal." Today `mutateBatch` writes projections incrementally (step 8) AND a
rebuild serializer exists (`writeProjections`, shared with `doctor --rebuild`).
Nothing continuously asserts the two agree. If they ever diverge, the journal is
still authoritative but every reader is silently wrong until a rebuild.

How: after each mutation in the e2e suite, assert the incrementally-written
projection set is byte-identical to a fresh rebuild from the journal prefix.

```ts
// tests/core/replay-equivalence.test.ts
async function assertProjectionsMatchRebuild(featureDir: string) {
  const live = await readAllProjections(featureDir);            // snapshots/*.json + spec.md + _meta.json
  const entries = await readJournal(featureDir);                // the authoritative stream
  const rebuilt = serializeProjections(replayJournal(entries)); // pure rebuild, no incremental state
  expect(normalize(live)).toEqual(normalize(rebuilt));          // written_at excluded
}
```

Verification: fold `assertProjectionsMatchRebuild` into the e2e lifecycle suite
after every `runCli` mutation; `bun run test -- tests/core/e2e-lifecycle.test.ts`.

#### 9.0.2 Single-source every paired invariant (close P7's secondary)

Why: at 9.0 the "L3 invariants — reducer + preflight both delegate" claim
(`invariants.ts:6-8`) must be *literally* true. Today the spec-version
head/continuation `mode` is recomputed independently on each side from
`batch_index`; they agree only because `mutateBatch` threads state between
iterations. Any third caller, or a refactor of batch threading, can desync them.

How: define the resolution once; both sides import the resolved value.

```ts
// src/core/reducer/invariants.ts
export function resolveSpecVersionMode(entry: JournalEntry): "head" | "continuation" {
  return entry.batch_index && entry.batch_index > 0 ? "continuation" : "head";
}
// reducer.ts AND preflight.ts both call resolveSpecVersionMode(entry) — neither recomputes
```

Audit it: `rg "batch_index" src/core/reducer.ts src/core/reducer/preflight.ts`
should show the split computed in exactly one place.

### 9.5 — the protocol can evolve with low regression risk

Proves: contract surfaces are generated or cross-checked from canonical sources,
and core invariants are mutation/property-tested — so weakening one fails a
*targeted* test, not merely an incidental e2e. Includes the sibling's contract
manifest (9.5.1) and golden CLI flow suite (9.5.2); the kernel-specific
additions:

#### 9.5.1 Property-based protocol-sequence tests

Why: the strongest part of this kernel (exhaustive reducer, ordered preflight,
all-or-nothing mutator) is currently proven by hand-written examples. The
invariants are *universal* claims ("no illegal transition is ever accepted",
"replay is idempotent", "a rejected entry leaves the journal byte-identical") and
deserve generator-driven proof.

How: `fast-check` generates random valid+invalid event sequences against a
fresh feature; assert the universal properties.

```ts
import fc from "fast-check";
test("protocol invariants hold over generated sequences", () => {
  fc.assert(fc.asyncProperty(arbitraryEventSequence(), async (events) => {
    const fixture = await freshFeature();
    for (const e of events) {
      const before = await snapshotJournalBytes(fixture);
      const r = await runMutate(e, fixture);
      if (!r.ok) expect(await snapshotJournalBytes(fixture)).toBe(before);  // atomicity
    }
    const replayed = replayJournal(await readJournal(fixture));
    expect(replayed).toEqual(replayJournal(await readJournal(fixture)));    // idempotent
    assertNoIllegalTransitionAccepted(await readJournal(fixture));          // transition legality
  }));
});
```

Verification: `bun run test -- tests/core/property-protocol.test.ts`.

#### 9.5.2 Mutation-test the stable-core invariants

Why: I flagged that preflight error-precedence has no test that fails when the
order is weakened (P6.1). The systematic version of that concern is: does the
test suite *fail* when a real invariant is silently broken? Examples breaking is
not the same as invariants being guarded.

How: run StrykerJS scoped to `src/core/reducer/`, `src/core/gates/`,
`src/core/journal-*.ts` — or, before adopting a dependency, hand-author
fault-injection probes for the highest-signal invariants (done-task evidence
must be passing AND cover the task; spec-version head/continuation; batch
atomicity before append; stale-snapshot `PRIOR_META_STALE`).

```ts
// each probe weakens ONE invariant in a test-local fork and asserts a test catches it
test("weakening 'done-task evidence must cover the task' is caught", () => {
  const proof = evaluateTaskProof(snapshotWithPassingButNonCoveringEvidence(), verifyAcceptPolicy);
  expect(proof.ok).toBe(false);   // if a refactor drops the covers[] check, this must fail
});
```

Verification: `bunx stryker run` (mutation score threshold on the stable-core
glob), or `bun run test -- tests/core/fault-injection.test.ts`.

#### 9.5.3 Contract manifest assembled from the helpers that already exist

Why: the public surface is spread across `docs/protocol.md`, `docs/schemas.ts`,
`src/cli.tsx`, `i18n/*`, `KIND_REGISTRY`. The collectors already exist
(`tests/scripts/inventory/{help-collector,protocol-parser,cli-entry}.ts`). 9.5
assembles them into ONE checked-in manifest produced from canonical sources and
diffed in CI — so a reviewer sees the entire public-contract delta in one file.

```ts
const manifest = {
  package_version: pkg.version,
  cli_commands: collectCliHelp("node dist/cli.mjs --help"),     // existing helper
  diagnostic_codes: Object.keys(ERROR_CATALOG),
  journal_entry_kinds: Object.keys(KIND_REGISTRY),
  hook_events: HOOK_EVENTS,
  entry_schema_version: ENTRY_SCHEMA_VERSION,
};
assertDeepEqual(manifest, readJson("docs/contract-manifest.json"));
```

Verification: `bun run contract:manifest && git diff --exit-code docs/contract-manifest.json`.

### 10 — reference implementation for a single-typed-journal protocol

Proves: an external implementer can build a compatible client from the docs +
generated artifacts WITHOUT reading `src/cli.tsx` or old review threads; and a
journal survives version evolution. Pursue this rung ONLY if loaf becomes a
widely consumed protocol with multiple independent clients (e.g. `loaf-skill`
plus a third party). Includes the sibling's hermetic-release and external-
consumer-smoke items; the kernel-specific additions:

#### 10.1 Cross-version journal compatibility matrix

Why: this is what separates a *protocol* from a *CLI*. `entry_schema_version=1`
today; when it becomes 2, a journal written by an old binary must still replay or
migrate deterministically. Without a matrix this is hope, not a guarantee.

How: freeze a golden journal per released version under
`tests/fixtures/journals/v<X>/`; CI replays each under HEAD and asserts
read-or-migrate with an explicit, deterministic migration expectation.

```ts
for (const v of SUPPORTED_VERSIONS) {
  test(`journal written by ${v} replays or migrates under HEAD`, () => {
    const j = loadGoldenJournal(v);
    const r = replayOrMigrate(j);
    expect(r.ok).toBe(true);
    expect(r.snapshot).toMatchSnapshot(`migrated-from-${v}`);  // deterministic target
  });
}
```

Verification: `bun run test -- tests/core/journal-compat-matrix.test.ts`.

#### 10.2 Operational observability — golden examples + privacy proof

Why: crash logs (`crash-log.ts`), trace rows (`trace-writer.ts`), and diagnostic
JSON are the operator-facing contract under failure. At 10 they need golden
fixtures AND a privacy check that no secret / absolute home path / token leaks
into any of them.

```ts
test("crash log carries no secrets or home paths", async () => {
  const log = await provokeCrashAndReadLog();
  expect(log).not.toMatch(/\/Users\/[^/]+|ghp_|AKIA|-----BEGIN/);
  expect(redactVolatile(log)).toMatchSnapshot();  // stable golden minus timestamps/pids
});
```

Verification: `bun run test -- tests/core/observability-golden.test.ts`.

#### 10.3 Generate the docs from the model, don't hand-maintain them

Why: at 10, `docs/protocol.md`'s §10.8 command table, `docs/schemas.ts`,
`i18n/*`, and `KIND_REGISTRY` are no longer independently hand-edited — the
contract manifest (9.5.3) becomes the source, and the human-readable tables are
generated or CI-checked against it. The audit test: change one canonical entry
and confirm every downstream surface fails to match until regenerated.

Verification: `bun run docs:generate && git diff --exit-code docs/`.

### What each rung deliberately does NOT prove

- **9.0** does not prove the protocol can evolve — only that today is clean and
  the change-path is discoverable.
- **9.5** does not prove cross-version compatibility — only that the *current*
  contract is generated and invariants are mutation/property-guarded.
- **10** is not "a few more cleanups"; it is reference-implementation maturity and
  is not worth pursuing without multiple real external consumers.

## Final audit checklist

```bash
git status --short --branch
bun run typecheck
bun run test
bun run build
bun audit
bash scripts/ga-consistency-check.sh --no-fetch
bash scripts/check-event-drift.sh
bunx madge --circular --extensions ts,tsx src
```

### Measured baseline (run 2026-06-08, pre-implementation)

Actual results of the checklist on a clean tree (only the two `docs/plans/*.md`
deduction plans are untracked). This is the starting state a third-party audit
should reproduce; each RED maps to the plan item that fixes it.

| Check | Result | Maps to |
|---|---|---|
| `git status` | clean except 2 untracked plan docs | — |
| `bun run typecheck` | **PASS** (exit 0) | — |
| `bun run test` | **PASS** — 2234 passed / 130 files (~85s) | — |
| `bun run build` | **PASS** — `dist/cli.mjs` 551.66 kB (gzip 132.12 kB) | — |
| `bun audit` | **PASS** — no vulnerabilities | — |
| `madge --circular` | **FAIL** — 4 circular deps | **P2** |
| `ga-consistency --no-fetch` | **FAIL** (exit 1) — `WORKTREE_DIRTY` now; `[0.3.0]` link gap is the real blocker on a clean tree | **P0.1** |
| `check-event-drift` | **FAIL** (exit 1) — `dist/cli.mjs.map` sourcemap false positive | **P0.2** |

The 4 circular deps (P2):

```text
1) core/reducer.ts > core/reducer/preflight.ts > core/gates/task-proof.ts > core/gates/evidence-result.ts
2) core/reducer.ts > core/reducer/preflight.ts > core/gates/task-proof.ts
3) core/reducer.ts > core/reducer/preflight.ts
4) cli/runtime-i18n-keys.ts > cli/tui/list-model.ts > cli/sessions-list.ts
```

Read: correctness surface is green (typecheck / 2234 tests / build / audit all
pass, no BLOCK bug); the three RED gates are exactly the P0/P2 hygiene items, not
behavior defects. `ga-consistency` currently stops at `WORKTREE_DIRTY` because the
plan docs are uncommitted — on a clean tree it surfaces the real `[0.3.0]`
changelog-link gap (P0.1).

Required audit verdict shape:

```text
Verdict: SIGN-OFF | PATCH-REQUIRED
Findings: Severity / file:line / issue / required fix
Checks: release gates / dependency graph / CLI contract preservation /
        stable-core vs presentation boundary / test coverage gaps
§0 review: confirm slice-5 flock machinery was correctly closed (not
           implemented), and PRIOR_META_STALE remains the primary write guard.
```
