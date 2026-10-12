# Architecture Freshness Ledger

Status: current repository guidance.

This ledger closes dated debt claims without turning local audit artifacts into
project truth. Current claims require a tracked owner plus executable evidence
or git history.

## Landed decisions

| Claim | Current disposition | Evidence |
| --- | --- | --- |
| CLI command-family split | Landed. `src/cli.tsx` composes family registrars from `src/cli/commands/`; task authoring, execution, query, presentation, and types have narrower submodules. This is the former W8 command-surface work, not W9. | `src/cli.tsx`, `src/cli/commands/`, commits `eda483e` and the later command-family commits |
| W9 preflight work | Separate concern. Admission remains owned by `src/core/reducer/preflight.ts` and its `preflight/` policy modules. Do not reopen the landed CLI split under the W9 label. | `src/core/reducer/preflight.ts`, `src/core/reducer/preflight/` |
| Replay sequence monotonicity | Landed. Replay rejects duplicate, decreasing, and gapped sequence numbers. | `tests/core/replay.test.ts`, commit `8c5df91` |
| Spec-lock transition enforcement | Landed. `SPEC.design → EXECUTE.plan` rejects when `spec_locked` is false and admits the approved case. | `tests/core/transition.test.ts`, commit `a261f41` |
| Generic context pack | Retired. Handoff/resume and supported read-only queries are the current boundaries; there is no live context-pack schema or command. | `docs/references/incremental-construction.md` §9, architecture program A13 |
| TUI F-026 | Superseded. Enter detail, active/all, explicit reload, and read-only pending classification are current. The `d` alias, pending popup, archive hotkey, automatic polling, and heartbeat freshness scanner are retired. | `docs/protocol.md` §10.8/§14.4, architecture program A16 |

## Later dispositions

These decisions landed after the 2026-07-27 architecture program. Commit
evidence is separate from release identity: `64a304f` is committed, but the
planned 0.12.0 breaking release remains the release driver's responsibility.
Do not reopen these boundaries from the program's earlier debt descriptions.

| Claim | Current disposition | Owning boundary and evidence |
| --- | --- | --- |
| Entry admission and duplicate reducer guards | Landed. `admitEntry` orchestrates preflight before `applyValidated` on mutation and replay. Preflight owns ordered authority/payload/semantic checks; replay separately owns envelope parsing and sequence continuity. The reducer applies admitted entries rather than duplicating admission. | `src/core/entry-admission.ts`, `src/core/reducer/preflight.ts`, `src/core/journal-bootstrap.ts`; `75fb29e`, `30b4e3e`, `58fab98`; `tests/core/entry-admission-boundary.test.ts`, `tests/core/entry-admission-characterization.test.ts`, `tests/core/reducer-duplicate-guards.test.ts` |
| Kind-typed payload consumption | Landed. The schema parse owner constructs the kind-correlated `AdmittedEntry`; reducer and semantic checks consume parsed payloads. Parsed defaults affect projections, while persistence retains accepted raw payload representation. | `src/core/admitted-entry.ts`, `src/core/reducer/preflight/checks-common.ts`; `ad3e12e`, `ad7c5e1`; `tests/core/admitted-entry.typecheck.ts`, `tests/core/typed-entry-admission.test.ts` |
| KIND_REGISTRY ownership | Landed and scoped. The registry owns static per-kind payload schema, current entry version, sub-state/actor guard metadata and spec-emission metadata. Stateful refinements, transition policy, admission ordering and reducer application remain with their domain owners; this is not a new runtime dispatcher. | `src/core/kind-registry.ts`, `src/core/kind-guards.ts`; `47e558a`, `2cc451b`, `dfebfd7`, `9a91e44`, `9d03765`; `tests/core/kind-registry.test.ts` |
| Packet F historical-format compatibility | Retired by explicit decision. There is no per-entry upcaster registry, v0.0.x snapshot-import kind or live SETTLE.reconcile state. Replay admits every entry under the current contract. Current session identity, explicit task amendment mode and closed execution shapes are required; historical fallback must not be reintroduced as incidental repair. | `docs/plans/entry-admission-deep-module.md`, `src/core/journal-entry.ts`, `src/core/journal-bootstrap.ts`; `f986745`, `91fa660`, `26aacc7`, `58fab98`, `40b627e`, `9b078fd`, `f2487ca`; `tests/core/replay.test.ts`, `tests/core/entry-admission-characterization.test.ts` |
| Pending-scope accumulation and closure | Landed. Core owns accumulation, normalization and owner-locked closure consumption; CLI hooks are adapters. Execute closure records canonical scope before its transition and retains uncovered paths across iteration rollover. | `src/core/pending-scope.ts`, `src/core/execute-closure.ts`; `27fb61c`, `8936d8d`, `540ceb6`; `tests/core/pending-scope.test.ts`, `tests/core/pending-scope-closure.test.ts`, `tests/core/execute-closure-transaction.test.ts` |
| Catalog-owned failure outlet | Landed. Domain producers return message-free structured diagnostics; `CommandContext.failure` is the recoverable CLI failure API and renders through the catalog. Commander parse failures join that outlet; unexpected/crash reporting retains its distinct failure domain. | `src/core/error-catalog.ts`, `src/cli/command-context.ts`; `952038b`, `0283cc0`, `9000813`, `a8344a8`, `f866979`; `tests/core/diagnostic-producer-audit.test.ts`, `tests/cli/failure-outlet-source-gate.test.ts`, `tests/cli/commander-failure-outlet.test.ts` |
| Pending/finding intervention policy | Landed. One core owner supplies pending FIFO/head/blocking, finding action/grid/target/reset and sponsor/closure decisions. Transition source/target policy and task progress/freshness remain separate owners; TUI and Board keep separate presentation adapters. | `src/core/intervention-policy.ts`, `docs/references/intervention-policy.md`; `a44f776`, `d13eb02`, `5c32e55`, `9224ba7`; `tests/core/intervention-policy-ownership.test.ts`, `tests/core/pending.test.ts` |
| Snapshot-only gate and VERIFY routing inputs | Landed. Spec-lock, verify-accept, verify status and VERIFY next derive structured spec data from the journal snapshot. Editing, deleting or corrupting derived spec.md cannot change a gate decision. Authored Markdown body editing remains a separate CLI surface. | `src/core/spec-snapshot.ts`, `src/core/gates/`, `src/cli/verify-status.ts`; `116452a`, `fcb2e22`, `9c0af13`; `tests/cli/spec-lock-snapshot-admission.test.ts`, `tests/cli/verify-snapshot-admission.test.ts`, `tests/cli/verify-next-snapshot.test.ts` |
| Declared command policy and argv scanning | Landed. Registered commands declare selector, dry-run and schema behavior, enforced by the common action hook. One core scanner supplies bootstrap/presentation/selector token interpretation; tokens after `--` are positional data. Spec init rejects dry-run rather than promising a non-writing execution it cannot provide. | `src/cli/command-policy.ts`, `src/core/argv-scanner.ts`; `4098ede`, `b50b9c0`, `a85b141`, `4a589cc`, `b5a56b9`, `4ee2b1f`; `tests/cli/command-policy.test.ts`, `tests/core/argv-scanner.test.ts`, `tests/cli/argv-terminator.test.ts`, `tests/scripts/command-policy-ownership.test.ts` |
| Trash bucket layout and transfers | Landed. Core owns bucket manifests/layout and prune, restore and GC transfers. Restore compensates a failed second transfer; malformed manifests fail closed, and incomplete recovery preserves remaining copies and reports the failure. CLI retains command selection and rendering. | `src/core/trash-bucket.ts`, `src/cli/prune/trash-gc.ts`; `08f071f`, `11a7a01`, `a507a34`, `528ad23`; `tests/cli/trash-bucket-characterization.test.ts`, `tests/cli/trash-bucket-cli.test.ts`, `tests/scripts/trash-bucket-ownership.test.ts` |
| Journal unknown-key policy | Landed, breaking. All journal payload objects are closed, including VIS content. EARS bodies include verifiability before closure; pending options/task linkage/answer are declared optional fields. Spec add-* wrappers forward authored content to admission. Unknown keys fail instead of being stripped or retained; old lines with extras fail replay without historical fallback. | `src/core/journal-entry.ts`, `src/core/spec-schema.ts`, `src/core/task-schema.ts`; `64a304f`; `tests/core/journal-payload-unknown-keys.test.ts` (60-node walker), `tests/core/spec-submit.test.ts`, `tests/core/typed-entry-admission.test.ts` |

## Open findings

These observations are not completed fixes or authorization to remove a guard.
They need separate scope before implementation.

| Finding | Observed boundary and consequence | Evidence / next review question |
| --- | --- | --- |
| Post-commit TasksJson artifact validation | Open. Admission and final append are the two pre-commit payload gates, but projection serialization also validates canonical task bodies through `TasksJson.parse`. With both pre-commit payload parses deliberately bypassed, an extra nested task key enters the journal and the operation then returns `PROJECTION_WRITE_FAILED` with `commit_state: committed`. This layer does not prevent the append and must not be described as another pre-append rejection or as absent. | `src/core/projection-writer.ts::composeTasksJson`, `src/core/task-history.ts::materializeTaskForAmend`, `src/core/journal-mutate.ts` post-append projection failure outlet; C E2b: 3/3 journal writes, 2/3 completed operations, 1/3 committed task projection failure. Preserve the distinction between authoring acceptance and artifact serialization when evaluating whether repeated validation is necessary. |
| Release-identity gate rejects linked worktrees | Open. `public-contract-version-check.sh` requires `.git` to be a directory. A linked worktree has a `.git` file, so its otherwise-valid invocation fails `USAGE: not a git repository` before validating release identity. The primary checkout passes; this is a checkout-shape limitation, not a payload-schema defect. | `scripts/public-contract-version-check.sh` repository precondition (`[ -d "$repo/.git" ]`), `tests/scripts/public-contract-version-check.test.ts`; C E4 reproduced the failure in a detached worktree at `aed03ca`. A separately scoped fix should use Git's repository discovery and retain the release identity checks. |

## Local artifacts are not repository truth

The ignored planning files `backlog.md`, `task_plan.md`, `progress.md`, and
`findings.md`, and any local audit output (a `.audit/` tree or root
audit-report files), are operator-owned scratch or dated inputs. They are not
a current acceptance ledger, implementation registry, or architecture
authority. Do not edit, delete, stage, or infer live debt from them during
repository work. The 2026-07-15 audit inputs were removed by the maintainer on
2026-10-12 after their findings were dispositioned through the architecture
program and this ledger.

Use tracked source, current protocol/reference docs, executable tests, the
architecture deepening program, and git history for present-tense claims.
Historical plans and audit reports may explain why a decision was made, but
their open checkboxes and scores do not override live evidence.

## Abstraction trigger for TUI and Board

TUI and Board share exactly one policy today:
`done > blocked > running > idle` session classification. They also consume the
same additive pending-head display identity, but Ink and HTTP/HTML remain
separate presentation adapters.

Do not extract a broad shared read/view model merely to close an audit item.
Reconsider one only after at least two independently changing consumers repeat
another non-trivial stale, detail, or pending policy and the extraction removes
duplicated decisions rather than presentation-specific code.

## Refresh rule

A future audit may change a disposition only with current tracked evidence:
an owning source boundary, a failing executable check, a known downstream
consumer, or repeated change pressure in git history. A local ledger entry or
dated line-count observation alone is insufficient.
