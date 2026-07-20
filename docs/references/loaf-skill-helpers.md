# loaf-skill helper compatibility index

> The current loaf-cli ↔ loaf-skill contract is
> [`skills/CONTRACT.md`](../../skills/CONTRACT.md). This file keeps the legacy
> section anchors referenced by older ADRs and protocol history; it no longer
> duplicates their evolving operational details.

## 1. `flatten`

The thinker authors a DAG and the kernel performs admission-only validation.
See [`skills/CONTRACT.md` §1](../../skills/CONTRACT.md#1-flatten--hierarchical-intent--dag-tasksjson)
for graph ownership, batch-final validation, diagnostics, and runtime split.

## 2. `warn`

Soft suggestions remain orchestration-only and never change exit codes or
gates. See [`skills/CONTRACT.md` §2](../../skills/CONTRACT.md#2-warn--soft-suggestion-advisory-only-no-block).

## 3. `decomposition-default`

Coarse-vs-fine decomposition is prompt policy, not protocol shape. See
[`skills/CONTRACT.md` §3](../../skills/CONTRACT.md#3-decomposition-default--coarse-over-fine-bias).

## 4. `fan-out`

Fan-out is restricted to EXECUTE side effects; all canonical loaf mutations
remain serial. Query current state through `loaf tasks list`, `loaf evidence
list`, `loaf spec status`, and `loaf journal list` rather than parsing a
projection when a command owns that view.

PostToolUse `scope-track` is live. Concurrent hooks merge canonical paths into
`~/.loaf/runtime/<session_id>.json` under an owner-fenced lock. The serial
`loaf advance EXECUTE.done` closure emits `scope:recorded` immediately before
the phase transition in one journal batch and clears pending scope only after
the append commit point. Skills never edit the runtime estate directly. The
full contract, including failure handling and late-hook behavior, lives in
[`skills/CONTRACT.md` §4](../../skills/CONTRACT.md#4-fan-out--execute-phase-concurrent-orchestration).

## 5. PRESETS

The runtime Ceremony schema and presets are owned by the sources indexed from
[`docs/machine-contract.md`](../machine-contract.md). Agent-facing ceremony
selection guidance lives in
[`skills/start/references/ceremony-presets.md`](../../skills/start/references/ceremony-presets.md).

Do not infer reconcile availability from a ceremony flag: the current release
has no full reconcile writer or canonical `planned_scope` owner, and
`loaf doctor --rebuild` does not produce `reconcile.json`.
