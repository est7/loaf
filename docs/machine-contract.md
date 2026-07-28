# Machine Contract Index

The runtime sources listed below are the machine contract. There is no executable TypeScript
contract under `docs/`: documentation explains behavior, while `src/core` and `src/cli` own the
Zod schemas, enums, tables, and refinements that the CLI executes.

Use `loaf <mutator> --schema --format=json` for mutation input schemas and
`loaf <artifact> schema --format=json` for artifact projection schemas. Both surfaces emit JSON
Schema from the runtime owners through [`src/cli/schema-emit.ts`](../src/cli/schema-emit.ts).

The “former section” column preserves anchors used by older protocol and ADR text; it does not
create a second definition.

| Former section | Contract area | Canonical runtime owner |
| --- | --- | --- |
| §0 | Schema version | [`src/core/spec-schema.ts`](../src/core/spec-schema.ts), [`src/core/snapshot.ts`](../src/core/snapshot.ts) |
| §0a | Journal envelope, entry kinds, attachments, signatures | [`src/core/journal-entry.ts`](../src/core/journal-entry.ts) |
| §0b–§0c | Entry versions, upcasters, v1-to-v2 migration boundary | [`src/core/migration.ts`](../src/core/migration.ts) |
| §1 | Phase, sub-state, state-machine graph | [`src/core/journal-entry.ts`](../src/core/journal-entry.ts), [`src/core/machine.ts`](../src/core/machine.ts) |
| §2–§4 | Ceremony, task kinds and steps, verification axes, gates | [`src/core/journal-entry.ts`](../src/core/journal-entry.ts), [`src/core/task-schema.ts`](../src/core/task-schema.ts), [`src/core/evidence-schema.ts`](../src/core/evidence-schema.ts) |
| §5 | Finding categories and actions | [`src/core/finding-schema.ts`](../src/core/finding-schema.ts) |
| §6 | Evidence kinds and results | [`src/core/evidence-schema.ts`](../src/core/evidence-schema.ts) |
| §7–§10 | Requirements, scenarios, visual contracts, spec frontmatter | [`src/core/spec-schema.ts`](../src/core/spec-schema.ts) |
| §11 | Pending identifiers, kinds, queue entries | [`src/core/journal-entry.ts`](../src/core/journal-entry.ts), [`src/core/projection-schema.ts`](../src/core/projection-schema.ts) |
| §12–§13 | State, session runtime, and registry projections | [`src/core/projection-schema.ts`](../src/core/projection-schema.ts) |
| §14 | Task schemas and task inputs | [`src/core/task-schema.ts`](../src/core/task-schema.ts) |
| §15–§16 | Evidence entries, inputs, and compatibility | [`src/core/evidence-schema.ts`](../src/core/evidence-schema.ts), [`src/core/evidence-compat.ts`](../src/core/evidence-compat.ts), [`src/core/projection-schema.ts`](../src/core/projection-schema.ts) |
| §17 | Finding events and projections | [`src/core/finding-schema.ts`](../src/core/finding-schema.ts), [`src/core/projection-schema.ts`](../src/core/projection-schema.ts) |
| §18 | Reconciliation projection and actual-scope derivation | [`src/core/reconcile-schema.ts`](../src/core/reconcile-schema.ts), [`src/core/scope-projection.ts`](../src/core/scope-projection.ts) |
| §18b | `loaf next` action and output | [`src/core/reducer/transition.ts`](../src/core/reducer/transition.ts), [`src/core/next-action.ts`](../src/core/next-action.ts) |
| §19 | Gate diagnostics | [`src/core/gates/gate-diagnostic.ts`](../src/core/gates/gate-diagnostic.ts) |
| §20 | Resume packs | [`src/core/resume-pack-schema.ts`](../src/core/resume-pack-schema.ts) |
| §21 | Project configuration | [`src/core/loaf-config.ts`](../src/core/loaf-config.ts) |
| §22 | Debug trace events | [`src/cli/trace-writer.ts`](../src/cli/trace-writer.ts) |
| §23–§24 | Ceremony shape and escalation detection | [`src/core/journal-entry.ts`](../src/core/journal-entry.ts), [`src/core/escalation-schema.ts`](../src/core/escalation-schema.ts) |
| §25 | Finding action effects and target modes | [`src/core/finding-schema.ts`](../src/core/finding-schema.ts) |
| §26 | Derived sub-state contracts | [`src/core/machine.ts`](../src/core/machine.ts), [`src/core/sub-state-contracts.ts`](../src/core/sub-state-contracts.ts) |
| §27–§27b | Step write paths and semantic categories | [`src/core/step-write-paths.ts`](../src/core/step-write-paths.ts) |
| §28 | Spec-lock checks | [`src/core/gates/spec-lock-check.ts`](../src/core/gates/spec-lock-check.ts) |
| §29 | Verify-accept checks | [`src/core/gates/verify-accept-check.ts`](../src/core/gates/verify-accept-check.ts) |
| §30 | Projection containers and changed-path schema | [`src/core/projection-schema.ts`](../src/core/projection-schema.ts), [`src/core/write-guard.ts`](../src/core/write-guard.ts) |
| §31 | Task proof and cache consistency | [`src/core/gates/task-proof.ts`](../src/core/gates/task-proof.ts) |
| §32 | Stable i18n categories | [`src/cli/i18n.ts`](../src/cli/i18n.ts) |
| §33 | v1 completion criteria | [`src/core/version-contract.ts`](../src/core/version-contract.ts) |
| §34 | Concurrency and transaction invariants | [`src/core/concurrency-contract.ts`](../src/core/concurrency-contract.ts), [`src/core/journal-mutate.ts`](../src/core/journal-mutate.ts) |
| §35 | Presentation flag exclusions | [`src/cli/flag-exclusions.ts`](../src/cli/flag-exclusions.ts) |
| §36 | Hook events | [`src/core/hook-events.ts`](../src/core/hook-events.ts) |
| §37 | Finding action risk matrix | [`src/core/finding-schema.ts`](../src/core/finding-schema.ts) |
| §38 | Context-pack projection and templates | [`src/cli/context-pack-schema.ts`](../src/cli/context-pack-schema.ts) |
| §39 | Diagnostic codes and error catalog | [`src/core/error-catalog.ts`](../src/core/error-catalog.ts) |
| §40 | Mutation input schemas and input ingestion | [`src/cli/input-schemas.ts`](../src/cli/input-schemas.ts), [`src/cli/input-ingestion.ts`](../src/cli/input-ingestion.ts) |
| §41 | Event-name registry | The owning enums and tables above; this index is the navigation surface. |

`ReconcileJson.actual_scope` is a canonical concrete-path array; `planned_scope` remains a glob
array and `based_on` remains `{spec,tasks}`. The generic projection reader rejects non-canonical
legacy reconcile leaves as rebuild-required, but no full reconcile writer exists yet:
`writeProjections` has no reconcile branch because the repository has no canonical planned-scope
source. Gates must not consume reconcile projections.
