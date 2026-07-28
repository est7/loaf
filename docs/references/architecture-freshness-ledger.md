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

## Local artifacts are not repository truth

The ignored planning files `backlog.md`, `task_plan.md`, `progress.md`, and
`findings.md`, the local `.audit/` tree, and root audit-report files are
operator-owned scratch or dated inputs. They are not a current acceptance
ledger, implementation registry, or architecture authority. Do not edit,
delete, stage, or infer live debt from them during repository work.

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
