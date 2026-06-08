# Plan — code-quality deduction closure

> **Reconciliation note (2026-06-07).** On **file-splitting scoring** this draft
> is SUPERSEDED by `claude-code-quality-deduction-closure.md`. That doc applies
> *cohesion over length*: the CLI namespace split (this doc's P2) and the
> preflight policy split (this doc's P3) are demoted to **optional, non-scored**
> navigability investments — only the **duplication removal** (CLI) and the
> **precedence regression test** (preflight) are scored closure work. Read this
> doc's P2/P3 score-impact rows (`8.0→8.5`, split raises score) as **stale**;
> the rest of this draft (P0 gates, P1 cycles, the 9+ ladder, audit checklist)
> stands. The two docs agree on everything except split scoring.
>
> **Current-score note (2026-06-08).** This document's 7.5/10 score basis is also
> stale after current `main` closed the release-gate, event-drift, cycle, lint,
> and test-gate deductions. Use `claude-code-quality-deduction-closure.md` as the
> current score source: live score 8.6/10; closing the five refreshed remaining
> deductions correctly should reach 9.1/10, or 9.2/10 if the CLI/preflight
> locality improvements are materially deep.

**Status:** DRAFT FOR THIRD-PARTY AUDIT.
**Type:** quality / architecture closure plan.
**Scope:** follow-up work from the 2026-06-07 read-only scorecard.
**Current score basis:** 7.5/10 overall. Core protocol kernel is stronger than
the repo score; the repo is held back by red release gates, dependency cycles,
CLI duplication residue, and untested preflight precedence. (Per the top
reconciliation note, file *length* is not a deduction; the earlier "CLI surface
concentration / preflight complexity" framing is superseded.)

This document is deliberately implementation-oriented: each item states priority,
why it matters, how to change it, pseudocode, and verification. It is not an ADR
and does not authorize implementation by itself.

---

## 0. Explicit non-goal: same-feature concurrent writers

Do **not** implement the per-feature lock-window work as part of this plan.

`src/core/journal-mutate.ts` still documents deferred lock acquire/release and
TODOs for keeping projection writes inside the lock window. That remains a
valid latent constraint, but the current operating model has no scenario where
two agents mutate the same feature concurrently. Treat this as an explicit
single-writer operational assumption, not an active correctness blocker.

Audit question:

- Is the single-writer assumption stated clearly enough for future maintainers,
  or should a short note be added near the mutator TODO / protocol section?

Verification for non-goal:

```bash
rg -n "lock acquire|same-feature|single-writer|projection sync" \
  src/core/journal-mutate.ts docs/protocol.md docs/adr
```

---

## P0 — Make release gates green again

### P0.1 Fix GA changelog reference link

Priority: **P0** because this is a release blocker, not architecture taste.

Current evidence:

- `bash scripts/ga-consistency-check.sh --no-fetch` fails with
  `CHANGELOG_MISSING: CHANGELOG.md has no '[0.3.0]: ...v0.3.0' link line`.
- `scripts/ga-consistency-check.sh` requires both the `## [<version>]` header
  and a matching `[<version>]: .../<expected-tag>` link line.
- `CHANGELOG.md` has `## [0.3.0]` but no `[0.3.0]: ...v0.3.0` reference.

Why:

The GA gate is the public release contract. A red release gate means the repo
cannot be honestly described as release-ready even when typecheck, tests, and
build are green.

How:

Add missing reference-style links to `CHANGELOG.md`. Keep the existing Keep a
Changelog shape. Do not weaken `ga-consistency-check.sh`; the gate is correct.

Pseudocode:

```md
<!-- end of CHANGELOG.md -->

[0.3.0]: https://github.com/est7/loaf/releases/tag/v0.3.0
[0.2.0]: https://github.com/est7/loaf/releases/tag/v0.2.0
...
```

Verification:

```bash
bash scripts/ga-consistency-check.sh --no-fetch
```

Third-party audit focus:

- Confirm the URL base is the correct public repo/tag surface.
- Confirm the gate remains strict; do not accept a patch that merely relaxes the
  regex.

### P0.2 Fix event-drift gate scanning generated sourcemaps

Priority: **P0** because this gate is currently red after a normal build.

Current evidence:

- `bash scripts/check-event-drift.sh` fails on `dist/cli.mjs.map`.
- The hit is inside `sourcesContent`, not a live source file.
- The script already excludes `.git`, `i18n`, `node_modules`, and unrelated
  namespace directories, but it does not exclude `dist`.

Why:

Generated bundles and sourcemaps are not the canonical design-doc source. A gate
that scans generated sourcemaps can fail because it re-embeds intentionally
excluded source comments. That is a false positive that trains maintainers to
distrust the gate.

How:

Exclude generated build output from `check-event-drift.sh`. Prefer a narrow
directory exclusion over changing the drift pattern.

Pseudocode:

```bash
EXCLUDE_DIRS=(
  ".git"
  "dist"
  "coverage"
  "i18n"
  "node_modules"
  "WangSnapshots"
)
```

Regression test shape:

```ts
test("event drift gate ignores generated dist sourcemaps", async () => {
  await writeFile("dist/cli.mjs.map", "finding_" + "close");
  const result = await runScript("scripts/check-event-drift.sh");
  expect(result.exitCode).toBe(0);
});
```

Verification:

```bash
bash scripts/check-event-drift.sh
bun run build
bash scripts/check-event-drift.sh
```

Third-party audit focus:

- Confirm `dist` is excluded because it is generated, not because the drift term
  is acceptable.
- Confirm canonical source files are still scanned.

---

## P1 — Remove circular dependencies

Priority: **P1** because cycles blur stable-core boundaries and make future
refactors harder to review. They are not currently failing runtime behavior, but
they are a structural smell in a protocol kernel.

Current evidence:

`bunx madge --circular --extensions ts,tsx src` reports:

```text
core/reducer.ts > core/reducer/preflight.ts > core/gates/task-proof.ts > core/gates/evidence-result.ts
core/reducer.ts > core/reducer/preflight.ts > core/gates/task-proof.ts
core/reducer.ts > core/reducer/preflight.ts
cli/runtime-i18n-keys.ts > cli/tui/list-model.ts > cli/sessions-list.ts
```

### P1.1 Break the core reducer/preflight/gate type cycle

Why:

`reducer.ts` should be below preflight/gate evaluators in the stable-core
dependency graph. Gate helpers needing projection types is legitimate; gate
helpers depending on the reducer module is not. Even type-only imports create
tool-visible cycles and preserve the wrong mental model.

How:

Move shared projection types out of `src/core/reducer.ts` into a leaf module.
The reducer imports those types; preflight and gates import the same leaf. Keep
`apply()` and `initialSnapshot()` in `reducer.ts` unless a later refactor proves
they need to move.

Suggested file:

```text
src/core/projection-types.ts
```

Pseudocode:

```ts
// src/core/projection-types.ts
export interface SessionState { ... }
export interface TaskState { ... }
export interface EvidenceState { ... }
export interface FindingState { ... }
export interface PendingState { ... }
export interface Snapshot { ... }
```

```ts
// src/core/reducer.ts
import type {
  Snapshot,
  TaskState,
  EvidenceState,
  ...
} from "./projection-types.js";

export type {
  Snapshot,
  TaskState,
  EvidenceState,
  ...
} from "./projection-types.js"; // optional compatibility export
```

```ts
// src/core/gates/task-proof.ts
import type { Snapshot, TaskState, EvidenceState } from "../projection-types.js";
```

```ts
// src/core/gates/evidence-result.ts
import type { EvidenceState } from "../projection-types.js";
```

Verification:

```bash
bun run typecheck
bun run test
bunx madge --circular --extensions ts,tsx src
```

Third-party audit focus:

- Confirm the new module is a true leaf: it must not import reducer, preflight,
  gates, CLI, or IO.
- Confirm this is a type-boundary extraction only; no reducer behavior should
  change.

### P1.2 Break the CLI i18n / TUI / sessions cycle

Why:

`runtime-i18n-keys.ts` is a presentation dictionary. It should not depend on TUI
list-model internals. `sessions-list.ts` is read-side data collection plus one
relative-time presentation helper; it should not become the owner of TUI status
taxonomy.

How:

Move the shared TUI status bucket type to a leaf type module.

Suggested file:

```text
src/cli/tui/types.ts
```

Pseudocode:

```ts
// src/cli/tui/types.ts
export type TuiStatusBucket = "done" | "blocked" | "running" | "idle";
```

```ts
// src/cli/runtime-i18n-keys.ts
import type { TuiStatusBucket } from "./tui/types.js";
```

```ts
// src/cli/tui/list-model.ts
import type { TuiStatusBucket } from "./types.js";
import type { SessionRow } from "../sessions-list.js";
```

Verification:

```bash
bun run typecheck
bun run test -- tests/cli/tui-list-model.test.ts tests/cli/runtime-i18n-keys.test.ts
bunx madge --circular --extensions ts,tsx src
```

Third-party audit focus:

- Confirm the fix removes the cycle instead of hiding it behind `import type`
  only.
- Confirm no runtime import from stable core into presentation was introduced.

---

## P2 — Thin `src/cli.tsx` by command namespace

Priority: **P2** because the file is the largest and highest-churn source file,
but the current behavior is covered by a broad test suite. This should be a
series of refactors, not a feature rewrite.

Current evidence:

- `src/cli.tsx` is about 6.4k LOC.
- It owns Commander setup, global option parsing, output context wiring,
  dispatch helpers, actor helpers, mutator wrappers, and around 60 command
  registrations.

Why:

The problem is not that one large file is inherently wrong. The problem is
change amplification: every public CLI change requires reading unrelated command
families and shared helper closures. This raises review cost and makes unrelated
regressions easier.

Design rule:

Do not invent a generic command framework. Extract real namespaces with real
ownership. A module is justified when it owns a command family end-to-end:
Commander registration, action-local parsing, text rendering, and command-local
payload construction. Shared protocol decisions stay in stable core or existing
builder modules.

Suggested shape:

```text
src/cli/main.ts                # global setup + program construction
src/cli/commands/spec.ts       # registerSpecCommands(...)
src/cli/commands/tasks.ts      # registerTasksCommands(...)
src/cli/commands/evidence.ts   # registerEvidenceCommands(...)
src/cli/commands/sessions.ts   # registerSessionsCommands(...)
src/cli/commands/hooks.ts      # registerHookCommands(...)
```

Pseudocode:

```ts
// src/cli/commands/types.ts
export interface CommandRegistrationEnv {
  ctx: CommandContext;
  i18n: I18n;
  deps: MainDeps;
  now: () => Date;
  dispatchOrFail(opts: FeatureAddressedOptions): Promise<string | null>;
  dispatchForHookOptional(opts: FeatureAddressedOptions): Promise<HookDispatch>;
  mctxFor(featureDir: string, session: SessionLoad): MutateContext;
  finishMutate(result: MutateResult | MutateBatchResult, mode: FinishMode): FinishResult;
  emitFailure(code: string, message: string, detail?: Record<string, unknown>): void;
  emitNoSessionFailure(key: FailureSiteKey, feature: string, detail?: Record<string, unknown>): void;
  resolveHumanActorForCommand(): ActorResolution;
}
```

```ts
// src/cli/commands/sessions.ts
export function registerSessionsCommands(program: Command, env: CommandRegistrationEnv): void {
  const sessionsCmd = program.command("sessions");
  sessionsCmd.command("list").action(async (opts) => {
    // unchanged action body, but local to the namespace
  });
}
```

Implementation order:

1. Extract low-risk read-only namespaces first: `sessions`, `verify status`,
   `check`, `tui`.
2. Extract hook namespace next; preserve silent-skip behavior exactly.
3. Extract mutating but smaller namespaces: `pending`, `finding`, `evidence`,
   `lessons`.
4. Extract high-density namespaces last: `tasks`, `spec`.

Deletion test:

- After each extraction, `src/cli.tsx` should lose meaningful LOC and imports.
- A new command module should not be a pass-through wrapper around a single
  helper in `cli.tsx`.

Verification per slice:

```bash
bun run typecheck
bun run test -- tests/cli/<affected-command-tests>
bun run test -- tests/scripts/cli-inventory.test.ts
bun run build
```

Full verification after all slices:

```bash
bun run check
bash scripts/ga-consistency-check.sh --no-fetch
bash scripts/check-event-drift.sh
bunx madge --circular --extensions ts,tsx src
```

Third-party audit focus:

- Confirm command modules improve locality rather than adding shallow wrappers.
- Confirm stable-core modules do not import CLI presentation modules.
- Confirm JSON/text/stderr channel contracts remain byte-compatible where tests
  already pin them.

---

## P3 — Split preflight policy clusters without weakening error priority

Priority: **P3** because `preflight.ts` is complex but currently centralizes
important protocol ordering. Splitting it incorrectly can create more
complexity than it removes.

Current evidence:

- `src/core/reducer/preflight.ts` is about 1.9k LOC.
- It owns envelope checks, authority checks, transition checks, deliver
  preconditions, task lifecycle rules, finding back-edge rules, spec content
  version rules, pending-head rules, and session-terminal rules.

Why:

Preflight is a legitimate deep module: callers get one API and one ordered
failure surface. The debt is inside the module: multiple policy families live in
one large function, so reviewers must keep unrelated invariants in memory.

Design rule:

Preserve one public API:

```ts
preflight(rawEntry, ctx): PreflightResult
```

Do not expose a bag of checks to callers. Split internal policy clusters only,
and keep the top-level function as the owner of error priority.

Suggested shape:

```text
src/core/reducer/preflight.ts                 # ordered coordinator
src/core/reducer/preflight/task-lifecycle.ts  # task claim/start/done/abandon
src/core/reducer/preflight/spec-content.ts    # spec submit/add/version rules
src/core/reducer/preflight/finding-policy.ts  # finding action/back-edge rules
src/core/reducer/preflight/session-policy.ts  # deliver/archive/abandon/spike
src/core/reducer/preflight/pending-policy.ts  # pending head / gate decisions
```

Pseudocode:

```ts
export function preflight(rawEntry: unknown, ctx: PreflightContext): PreflightResult {
  const parsed = parseEnvelope(rawEntry);
  if (!parsed.ok) return parsed.failure;

  const base = checkBaseAuthority(parsed.entry, ctx);
  if (!base.ok) return base;

  for (const check of ORDERED_POLICY_CHECKS) {
    const result = check(parsed.entry, rawEntry, ctx);
    if (result !== null && !result.ok) return result;
  }

  const transition = checkTransition(...);
  if (transition && !transition.ok) return transition;

  return { ok: true };
}
```

Important constraint:

The order is part of the public diagnostic contract. For example, schema /
authority errors must not be masked by later policy checks, and existing
command tests should keep seeing the same diagnostic code for the same invalid
input.

Verification:

```bash
bun run typecheck
bun run test -- tests/core/preflight-validation.test.ts
bun run test -- tests/core/reducer.test.ts tests/core/transition.test.ts
bun run test -- tests/core/e2e-lifecycle.test.ts
```

Third-party audit focus:

- Confirm this is internal modularization, not a new public preflight API.
- Confirm error priority is explicitly tested where behavior matters.
- Confirm no policy module imports CLI or presentation helpers.

---

## Recommended execution order

1. P0.1 changelog link line.
2. P0.2 event-drift generated-output exclusion.
3. P1.1 core type-cycle extraction.
4. P1.2 CLI/TUI type-cycle extraction.
5. P2 CLI namespace extraction, one namespace per commit.
6. P3 preflight policy-cluster split.

Rationale:

- P0 first because green gates restore trust in the repo's release surface.
- P1 next because cycles make later refactors harder to audit.
- P2 before P3 because CLI concentration is the highest-churn pain point and is
  safer to slice by namespace.
- P3 last because preflight owns protocol error priority; it deserves focused
  review after the mechanical graph is cleaner.

## Score impact estimate

| Work | Expected score effect |
| --- | --- |
| P0 release gates green | 7.5 → 7.8 |
| P1 cycles removed | 7.8 → 8.0 |
| P2 CLI namespace extraction | 8.0 → 8.3 |
| P3 preflight split with preserved diagnostics | 8.3 → 8.5 |

The score should not rise if a change merely moves code without improving
locality, removes tests, weakens release gates, or introduces a broader command
framework that callers must understand.

## 9+ score ladder — what P0-P3 intentionally does not prove

Completing P0-P3 should raise the repo to about 8.5/10, not 9/10. A 9/10 score
requires proof that the new structure stays deep under future change, not merely
that the current deductions were closed.

### 9.0 bar — deep command structure + automatic release contract

9.0 means the repo is not just clean today; it is straightforward to change
tomorrow. A maintainer adding a public protocol behavior should have an obvious
path through docs, schema, stable core, CLI, tests, and release gates.

#### 9.0.1 CLI command modules must not become a shallow framework

P2 extracts command namespaces out of `src/cli.tsx`, but extraction alone is
not an architectural win. It is a win only if each command module owns a real
slice of knowledge and reduces the information a maintainer must load before
changing that command family.

Audit rule:

- A command module is acceptable when it owns a command family end-to-end:
  Commander registration, action-local parsing, command-local text rendering,
  and command-local payload construction.
- A command module is not acceptable when it is only a pass-through wrapper
  around a generic registration framework or a pile of callbacks still defined
  elsewhere.
- Shared helpers are acceptable only when they hide real cross-command
  complexity: dispatch, output routing, actor resolution, mutator context,
  finish/error mapping.

Rejected shape:

```ts
registerCommand(program, {
  name: "tasks submit",
  options: TASKS_SUBMIT_OPTIONS,
  run: genericRunMutatingCommand("tasks.submit", TASKS_SUBMIT_MAPPING),
});
```

This looks smaller but creates a new language maintainers must learn before
changing one command. That is a shallow framework.

Preferred shape:

```ts
export function registerTasksCommands(program: Command, env: CommandRegistrationEnv): void {
  const tasks = program.command("tasks");

  tasks.command("submit").action(async (opts) => {
    const featureDir = await env.dispatchOrFail(opts);
    if (featureDir === null) return;

    const session = await env.ctx.resolveSession(featureDir);
    const input = await readTasksSubmitInput(opts, env);
    const entries = buildTasksSubmitBatch(input, session.snapshot, env.actor());
    env.finishMutate(await mutateBatch(entries, env.mctxFor(featureDir, session)), "emit-failure");
  });
}
```

9.0 audit question:

- If a reviewer adds one new `loaf tasks ...` behavior, can they identify the
  owning command module, stable-core builder/evaluator, tests, docs, and release
  gate without reading unrelated command families?

#### 9.0.2 Public contract, docs, and release gates must stay automatically green

P0 makes today's release gates green. A 9/10 repo needs the release surface to
stay green by construction, not by maintainer memory.

Audit rule:

- Public CLI changes must be caught by `cli-inventory` when docs/protocol/help
  drift.
- Diagnostic changes must be caught by catalog/i18n gates when code/docs/i18n
  drift.
- Generated artifacts must not create false positives in source-drift gates.
- `ga:check` must be the release entry point, and a release should not rely on a
  human remembering to run several unconnected scripts.

Expected command:

```bash
bun run ga:check
```

Expected properties:

- Builds fresh `dist`.
- Runs package smoke from the packed artifact.
- Runs changelog/tag/head/worktree consistency.
- Does not require ad hoc manual checks outside the documented release flow.

If `check-event-drift.sh` remains outside `ga:check`, document why it is a
development drift gate rather than a GA gate. If it is release-significant,
include it in `ga:check` after false positives are fixed.

9.0 audit question:

- Can a contributor change a public command, diagnostic, schema, or release tag
  and rely on automated gates to reveal every required docs/catalog/i18n/dist
  update before tagging?

#### 9.0.3 New protocol behavior must have an obvious change path

P0-P3 reduce existing debt. A 9/10 score also needs a repeatable path for future
protocol behavior.

Target path for a new protocol behavior:

```text
docs/schemas.ts / docs/protocol.md
  → runtime schema / kind registry / transition or policy evaluator
  → reducer or projection writer
  → CLI command module
  → focused unit tests + CLI e2e
  → inventory/catalog/i18n/release gates
```

9.0 audit question:

- Is this path discoverable from file names and existing tests, or does the
  contributor need historical knowledge from old review threads?

### 9.5 bar — contract evolution is mechanically enforced

9.5 means the repo can evolve its public protocol with low regression risk. This
requires more than green tests: it requires the contract surfaces to be generated,
cross-checked, or mutation-tested enough that drift is hard to introduce.

The 9.5 work should be considered only after P0-P3 and the 9.0 bar are complete.

#### 9.5.1 Contract surface manifest

Why:

Today the public surface is spread across `docs/protocol.md`, `docs/schemas.ts`,
runtime schemas, `src/cli.tsx`, `i18n/*`, and script baselines. Tests catch many
drifts, but there is no single reviewable manifest that says, "this is the
public surface for release N."

How:

Create a generated or checked-in contract manifest that records command names,
diagnostic codes, schema versions, journal entry kinds, hook events, and release
gate membership. The manifest should be produced from canonical sources where
possible and compared in CI.

Suggested file:

```text
docs/contract-manifest.json
```

Pseudocode:

```ts
type ContractManifest = {
  package_version: string;
  cli_commands: string[];
  diagnostic_codes: string[];
  journal_entry_kinds: string[];
  hook_events: string[];
  schemas: Array<{ name: string; version?: number }>;
  release_gates: string[];
};

const manifest = buildManifest({
  protocol: parseProtocolCommandTable("docs/protocol.md"),
  schemas: parseDocsSchemas("docs/schemas.ts"),
  cliHelp: collectCliHelp("node dist/cli.mjs --help"),
  packageJson: readPackageJson(),
});

assertDeepEqual(manifest, readJson("docs/contract-manifest.json"));
```

Verification:

```bash
bun run build
bun run contract:manifest
git diff --exit-code docs/contract-manifest.json
```

9.5 audit question:

- Can a reviewer see the public contract delta in one file and verify it was
  produced from canonical sources?

#### 9.5.2 Golden CLI behavior suite for public flows

Why:

The repo already has strong tests, but a 9.5 CLI needs stable public-flow
fixtures that protect stdout/stderr/exit-code behavior across releases. Unit
tests prove internals; golden flows prove the user-facing contract.

How:

Add fixtures for the primary workflows:

- quick / light / standard / deep lifecycle happy paths.
- representative failure paths for invalid input, gate rejection, stale
  snapshot, missing session, dry-run misuse.
- text and JSON mode for public command families.

Pseudocode:

```ts
test.each(publicFlowFixtures)("public flow: %s", async (fixture) => {
  const sandbox = await createFixtureRepo(fixture.initialFiles);
  for (const step of fixture.steps) {
    const result = await runLoaf(step.argv, { cwd: sandbox.cwd, stdin: step.stdin });
    expect(normalize(result.stdout)).toEqual(step.stdout);
    expect(normalize(result.stderr)).toEqual(step.stderr);
    expect(result.exitCode).toBe(step.exitCode);
  }
});
```

Verification:

```bash
bun run test -- tests/cli/public-flows.test.ts
```

9.5 audit question:

- Would a user-visible output regression fail a focused golden-flow test instead
  of being noticed manually?

#### 9.5.3 Mutation / fault-injection tests for stable-core invariants

Why:

The stable core is protocol-critical. A 9.5 score needs evidence that tests fail
when important invariants are weakened, not just when current examples break.

How:

Add targeted mutation/fault probes for invariants that have caused real audit
findings:

- done task evidence must be passing and cover the task id.
- spec version head/continuation rules.
- batch atomicity before append.
- stale snapshot fast-check behavior.
- sidecar promotion / projection rebuild failure shape.

This does not require adopting a full mutation-testing dependency immediately.
Start with explicit test-only probes where they give the highest signal.

Pseudocode:

```ts
test("verify-accept rejects evidence that passes but does not cover the task", () => {
  const snapshot = snapshotWithDoneTaskAndEvidence({
    taskId: "T-001",
    evidence: { result: "passed", covers: ["REQ-A-001"] },
  });
  expect(evaluateVerifyAccept(snapshot, featureDir)).toFailWith("TASK_DONE_NO_EVIDENCE");
});

test("batch append is not reached when second entry fails preflight", async () => {
  const appendSpy = createAppendSpy();
  const result = await mutateBatch([validEntry, invalidEntry], ctxWithAppendSpy(appendSpy));
  expect(result.ok).toBe(false);
  expect(appendSpy.calls).toHaveLength(0);
});
```

Verification:

```bash
bun run test -- tests/core/gates tests/core/batch-atomicity.test.ts
```

9.5 audit question:

- If a future refactor weakens one core invariant, is there a targeted test that
  fails for the invariant, not merely an incidental e2e failure?

### 10/10 bar — intentionally not a normal backlog target

10/10 should not be treated as "do a few more cleanups." For this project, a
10/10 score would mean the CLI is not just well engineered, but close to a
reference implementation for a protocol kernel.

This is probably not worth pursuing unless `loaf-cli` becomes a widely consumed
external protocol with multiple independent clients or plugins.

10/10 requirements:

- **Formal contract generation:** public schemas, diagnostic catalog, CLI
  inventory, and protocol tables are generated from one canonical model or
  checked by a single contract compiler.
- **Compatibility matrix:** old journals / snapshots / release artifacts are
  replayed across supported versions, with explicit migration expectations.
- **Hermetic release proof:** release validation runs from a packed artifact in
  a clean temp repo with no reliance on local source imports, local user config,
  or stale generated files.
- **Property-based protocol tests:** reducer/preflight/mutator invariants are
  checked across generated valid and invalid event sequences.
- **External consumer smoke:** a separate fixture project, or sibling
  `loaf-skill` consumer, verifies the published binary through the real public
  surface only.
- **Operational observability proof:** crash logs, trace rows, diagnostic JSON,
  and recovery commands have golden examples and privacy checks.

10/10 pseudocode direction:

```ts
forAll(generateJournalSequence(), (entries) => {
  const result = replay(entries);
  assertInvariants(result.snapshot);
  assertProjectionRebuildIsIdempotent(entries);
  assertNoIllegalTransitionWasAccepted(entries);
});

for (const version of supportedVersions) {
  const artifact = installPackedRelease(version);
  for (const fixture of compatibilityFixtures) {
    assertCanReadOrMigrate(artifact, fixture);
  }
}
```

10/10 audit question:

- Could an external implementer use the protocol docs + generated contract
  artifacts to build a compatible client without reading `src/cli.tsx` or old
  review threads?

Non-goal warning:

- Do not pursue 10/10 by adding frameworks, generic registries, or generated
  abstractions before there are multiple real consumers. That would raise
  accidental complexity and can lower the score.

## Final audit checklist

> Measured baseline (run 2026-06-08) is pinned in
> `claude-code-quality-deduction-closure.md` § "Measured baseline": typecheck /
> test (2234) / build / audit PASS; `madge` (4 cycles, P2), `ga-consistency`
> (P0.1), `check-event-drift` (P0.2) RED.

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

Required audit verdict shape:

```text
Verdict: SIGN-OFF | PATCH-REQUIRED

Findings:
- Severity / file:line / issue / required fix

Checks:
- Release gates
- Dependency graph
- CLI contract preservation
- Stable-core vs presentation boundary
- Test coverage gaps

Non-goal review:
- Confirm same-feature concurrent writer lock-window work was not required by
  this plan.
```
