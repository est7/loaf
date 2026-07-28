# Incremental construction — Tier 1 mutator design principles (rev 4.3)

> **Status**: normative reference for the rev 4.3 Tier 1 mutator
> family (`spec add-req`, `spec add-scenario`, `spec add-visual`,
> `tasks add`, `evidence add`). The former supporting context-pack proposal is
> retained as history only; it does not promise a command or wire contract.
> Persistent transfer uses `loaf handoff`, and a future context selector
> requires a fresh consumer-driven design. These principles are frozen with
> `adr/0004-moni-audit-resolution.md` (A1 / A2 / A3 / A5 / A6 /
> A8 / A10 / A11). This document explains why each principle
> exists; the wire-level contracts live in `protocol.md` §10 +
> §4 and their current runtime owners.
>
> Companion to `references/loaf-skill-helpers.md` (the three-layer
> architecture) and `references/finding-matrix-rationale.md` (the
> 6×6 finding grid this family relies on).

## 1. The pressure that produced the family

`moni-review.md` audited rev 4.2 protocol for **LLM-friendliness**
and found that one-shot generation of large structured artifacts
(spec.md frontmatter with 200+ lines of EARS, tasks.json with 10+
tasks across 6 kinds, evidence.jsonl with hand-computed sha256
hashes) had observed error rates above 30%. Each failure forced
the LLM to re-emit the entire artifact, which compounds:

- Token cost grows with re-emit count
- Cognitive load grows with each "find the one bad field in 200
  lines" cycle
- Fan-out workers competing for the same artifact under
  per-session lock (rev 4.0) magnify the cost

rev 4.3 responds by making **shape transformation incremental**:
the LLM emits one item at a time (or a small batch), the CLI does
all the structural work, errors are scoped to the smallest possible
fix unit.

## 2. Principle: shape enforcement in the CLI, content in the skill

(ADR-0004 A2; corollary of ADR-0001.)

`loaf-cli` owns all shape validation: id allocation, three-way
verifiability, the 6 × 6 finding grid, attachment hash + mime, the
20 sub_state × ContextPackProjection map. `loaf-skill` and 3rd-party
workflow skills own *content*: which REQ to draft next, which task
to claim, which finding category fits the observation.

If shape lived in the skill layer instead, every workflow skill
(Wang / GSD / openspec / ad-hoc) would re-implement the same Zod
subset. That is duplicated maintenance, a race window between the
skill writing to disk and the CLI re-validating, and a fragmented
3rd-party contract. The CLI absorbs the shape work exactly once;
all skills share it.

`protocol.md` §19.1 makes this division load-bearing for the v1
contract.

## 3. Principle: one unified input modality — `--input <-|json|path>`

(ADR-0004 A3 + A11.)

All five Tier 1 mutators take exactly one input form: `--input`
followed by one of three sources:

1. Value `-` → read JSON from stdin until EOF
2. Value matches `/^[\{\[]/` → parse the value itself as inline
   JSON
3. Otherwise → treat as a file path; read and parse the file
   (missing path emits exit 2 `INPUT_FILE_NOT_FOUND`)

The discriminator is intentionally simple: a single regex on the
first character distinguishes inline from path. Two alternatives
were considered and rejected (`protocol.md` Alt-2 / Alt-3 in the
ADR):

- **Per-field flags** (`--type X --trigger Y --response Z`)
  required either flag explosion for nested fields like
  `measurable.{metric, threshold, unit, direction}` or a custom
  mini-DSL. Array fields like Gherkin given/when/then required
  positional repetition of `--given X --given Y` and were
  order-sensitive. Worst of all, LLMs error more often on shell
  quoting than on JSON syntax (training distribution).
- **Hybrid (flag for simple, JSON for nested)** doubled the
  maintenance surface: two help schemas per command, two fixture
  sets, two error paths. The complexity at the
  worst-case-LLM-learning-the-rules axis was additive.

`--input` collapses all three call sites (LLM writing a file then
referencing it, CI piping through stdin, human running an ad-hoc
inline command) onto one resolver. Documentation × 1, fixtures
× 1, error paths × 1.

Naming note: it is `--input`, not `--format`. The latter denotes
output format direction, not input source; reusing it would
violate clig.dev §6 (one flag, one direction).

## 4. Principle: CLI allocates ids, LLM supplies namespaces

(ADR-0004 A5.)

REQ / SCEN / VIS inputs carry `id_namespace` (stem regex like
`^REQ-[A-Z][A-Z0-9]*$`), **not** the full id with serial. CLI
scans the locked spec for the max serial under that namespace and
allocates the next one inside the per-session lock, then composes
the full id (`REQ-AUTH-007`) and writes it to spec.md.

`T-N` (tasks), `EV-N` (evidence), `FND-N` (findings), `PEND-N`
(pending) carry no namespace at all — CLI auto-allocates monotonic
sequences with no LLM-visible namespace at all.

The input/output regexes are owned by `src/core/spec-schema.ts` and **must not**
be conflated:

| Direction | Regex | What it accepts |
|---|---|---|
| Input  | `^REQ-[A-Z][A-Z0-9]*$` | stem only — e.g. `REQ-AUTH` |
| Output | `^REQ-[A-Z][A-Z0-9]*-\d{3,}$` | stem + serial — e.g. `REQ-AUTH-007` |

The split makes it impossible for an LLM to "guess" a full id and
have it accepted on input (the input regex rejects strings
containing the serial separator). Under fan-out (rev 4.0) this
matters: multiple workers can call `loaf spec add-req` concurrently;
the lock ensures each gets a distinct serial without coordination.
LLMs lose id-naming freedom but gain race-freedom — a worthwhile
trade.

## 5. Principle: attachments are paths, not pre-hashed objects

(ADR-0004 A6.)

`loaf evidence add --input` accepts `attachments: [{ path }]`. CLI
does the rest:

```
1. Validate path exists + is a regular file + is readable
2. Copy to .loaf/<feature>/attachments/<EV-id>/<basename>
   (suffix -2 / -3 on basename collision)
3. Compute sha256 hex
4. Infer mime from extension + magic bytes
5. stat() bytes
6. Append the full { path, sha256, mime, bytes } entry to
   evidence.jsonl
```

Asking an LLM to call `sha256sum` from inside a shell pipeline and
then paste the resulting 64-character hex string into JSON is a
near-certain failure source. Mime inference from extension alone
is also fragile. Both are pure shape transformation — the kind of
work `loaf-cli` exists to centralize.

## 6. Principle: batch = atomic invocation, not loop of singletons

(ADR-0004 A10.)

Every Tier 1 input schema is `z.union([T, z.array(T).nonempty()])`:
the same command can accept a single item or an array of items.
The batch path is governed by three disciplines:

| Discipline | Rule | Why |
|---|---|---|
| 1a. all-or-nothing | Validate every item in memory before any append; on the first failure, reject the entire batch with `0` writes | Preserves append-only / crash-only invariants under fan-out; LLM never sees a partial batch on disk |
| 1b. `spec_version += 1` per invocation | A batch is **one** invocation = **one** atomic change; the version bumps by 1, not by N | Keeps `tasks.based_on.spec` monotonic across "I added five REQs in one call" vs "I added them one at a time"; both look like spec-version + 1 from the consumer side |
| 1c. atomic id allocation | Inside the lock, reserve N contiguous ids in one allocator step; only commit allocator state if the whole batch validates | id sequence never has gaps from half-applied batches |

The performance win is real: a medium feature with 15 REQs and 10
tasks goes from 25 CLI invocations (each acquiring the lock,
reading projection, validating, appending, releasing) to 2
invocations. The semantic preservation matters more than the
performance — without 1a, append-only is broken; without 1b,
auditors cannot match "spec_version=12" to a single coherent
change.

## 7. Principle: phase-gating mirrors existing reverse-transition rules

(ADR-0004 A4.)

Tier 1 mutators do **not** invent new transitions. They reuse the
existing rule from `protocol.md` §5.3:

- pre-lock (`SPEC.{spec,plan,design}`) — accept
- post-lock (`EXECUTE.*` / `VERIFY.*` / `SETTLE.*` / `DONE.*`)
  — reject; emit exit 2 `SPEC_LOCKED_NO_DIRECT_EDIT`; nudge
  toward `loaf finding raise --category spec-gap --action
  amend-spec`

This is exactly the rule that `loaf amend --target spec` already
followed. The new `spec add-*` surface plugs in to the same gate;
there is no new state machine edge, only a new entry point onto
the existing edge.

`tasks add` likewise mirrors the rule on the `tasks` side:
EXECUTE-phase calls reject and nudge toward `amend-tasks` finding.

## 8. Principle: self-description via `--schema --format=json`

(ADR-0004 A2 surface.)

Every command that consumes `--input` also accepts the global
modifier pair `--schema --format=json`:

```bash
loaf spec add-req --schema --format=json
```

This dumps the JSON Schema derived from the command's entry in
`INPUT_SCHEMAS` (`src/cli/input-schemas.ts`). LLMs that hit a
`SCHEMA_VALIDATION_FAILED` error get a fix template pointing them
at this command; CI fixtures use it to verify schema stability;
loaf-skill prompt templates can embed it for one-shot LLM
instruction.

`--help` for each `--input` command additionally surfaces 2–3
worked JSON examples at the top (clig.dev §5), so an LLM seeing
`--help` output gets an immediately usable shape.

## 9. Retired proposal: phase-aware context packing

(ADR-0004 A8.)

`loaf resume --fresh` was proposed to bundle genuine handoff recovery with
routine phase-switch slicing. Neither the flag nor a generic context selector
shipped. The current boundary is:

- `loaf resume` — handoff only, rare
- sanctioned read-only CLI queries — ephemeral state selection
- no live command or generic context-pack schema

The former `CONTEXT_PACK_TEMPLATES` proposal mapped each substate to an
`include` / `exclude` projection. It had no consumer and is not a live
contract. A future selector must start from a concrete consumer and its
observable requirements.

Observed token saving when LLM skills switched from "send whole
spec + whole tasks.json + whole evidence.jsonl" to phase-targeted
packs: 60–80% per phase switch (moni audit measurement).

## 10. Principle: error contract is uniform — four lines, fix in the body

(ADR-0004 A9.)

All exit 2 user-recoverable errors emit the same four-line shape:

```
error: <one-line description>
       <optional context: what state we were in / what we saw>
       fix: <concrete command(s)>
       see: <doc anchor>
```

`ERROR_CATALOG` (`src/core/error-catalog.ts`) is the single source: each
`DiagnosticCode` maps to one `ErrorEntry` with `message_template`,
optional `fix_template`, optional `doc_anchor`. i18n (`protocol.md`
§18) layers via `LOAF_LANG` bundle. The most important information
(the `fix:` line) sits at the bottom — clig.dev §5 "eye lands here
last".

exit 1 (panic / out-of-disk / kernel-level failure) is **not**
covered; it emits a crash log + report URL and nothing else.
Fix-templates would be misleading there.

## 11. How to use this document

- Implementing a new mutator? Re-read §2 (CLI vs skill) and §3
  (`--input`) before designing.
- Reviewing a PR that touches Tier 1 surface? Cross-check the
  change against §6 (batch disciplines) and §7 (phase gating)
  invariants.
- Onboarding a 3rd-party workflow skill? Pair this document with
  `references/loaf-skill-helpers.md` to set the integration
  expectations.

## 12. Cross-references

- Decision: `adr/0004-moni-audit-resolution.md` (whole ADR;
  especially A2 / A3 / A5 / A6 / A8 / A10 / A11)
- Machine bindings:
  - `src/core/finding-schema.ts` `FINDING_ACTION_GRID`
  - the retired §38 `CONTEXT_PACK_TEMPLATES` proposal
  - `src/core/error-catalog.ts` `ERROR_CATALOG`
  - `src/cli/input-schemas.ts` `INPUT_SCHEMAS` +
    `src/cli/input-ingestion.ts` `InputSourceResolver`
- Protocol surface:
  - `protocol.md` §10.5 (error contract) + §10.7 (`--input` /
    `--schema`) + §10.8 (command table)
  - `protocol.md` §4.2 (spec increment) + §4.4 (attachment) +
    §4.5 (finding grid) + §4.6 (`unusual_findings_count`)
  - `protocol.md` §5.3 (post-lock reverse transition)
  - `protocol.md` §11.2 (batch transaction disciplines)
  - `protocol.md` §15 (freeze rewording) + §18.5 (ERROR_CATALOG
    bundle) + §19.1 (CLI vs skill boundary)
- Companions:
  - `references/loaf-skill-helpers.md` (three-layer architecture)
  - `references/finding-matrix-rationale.md` (per-cell grid
    justification)
- Foundational ADRs: `adr/0001` (shape vs content), `adr/0002`
  (rev 4.0 fresh design), `adr/0003` (rev 4.1 fan-out single-
  writer)
