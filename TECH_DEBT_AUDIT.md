# Tech Debt Audit — loaf-cli

Generated: 2026-06-03 · Scope: full repo (`src/` 23.8k LOC, 67 files, 190 commits)
Method: churn analysis (`git log` 6mo), `bun audit`, type/catch/TODO/env grep, dep + `loaf doctor` implementation cross-check.

> **Status update (2026-06-04):** the 9-locus deepening programme completed + codex-signed-off. **T2/T3/A3/A4/A5 fully closed** (✅ in the table below); **A1/A2 partial** — the cli.tsx / preflight god files shrank but did not vanish (remainder tracked in `backlog.md` A1 / via L2 caveat); **T4 doc-drift fixed** (CLAUDE.md updated). Still open: **T1** (the High concurrency one), O1, O2. This stays a dated baseline — rows are marked, not deleted.

## Executive summary

- This is a **high-discipline codebase**. The usual debt buckets — `any` casts, `@ts-ignore`, swallowed exceptions, blanket catches, dead deps, hardcoded secrets, stray `console.*` — are **empty or near-empty**. Do not expect a long findings table; padding it would be dishonest.
- Debt concentrates in **two places only**: (1) structural — a god CLI file + a god preflight file + duplicated invariants + per-`kind` scatter; (2) two real points — a projection-write race and two slim→full type casts. (Orthogonal hygiene: one transitive CVE, now fixed; one stale CLAUDE.md reference.)
- **Churn data independently confirms the structural priority.** `src/cli.tsx` was touched **72× in 6 months** (by far the most) *and* is the largest file (6768 LOC). The intersection of biggest × most-changed is exactly where the deepening work (L1/L2/L3) is aimed — the priority is not aesthetic, it is change-frequency-driven.
- 1 Critical (structural concentration), 1 High (concurrency), ~5 Medium, rest Low.
- A parallel architecture review produced 9 "deepening loci" (L1–L9) with a codex adversarial pass; the structural findings below cross-reference those IDs rather than re-deriving them.

## Architectural mental model

loaf-cli is a protocol kernel for a feature-lifecycle workflow (ADR-0005). The single source of truth is an append-only typed journal (`.loaf/<feature>/journal.jsonl`); every state change is one `JournalEntry`. A reducer projects derived state from the journal; everything else (`spec.md`, `snapshots/*.json`, the `~/.loaf` registry) is a derived projection, never truth.

The write path is a single deep transaction: `mutateBatch` (journal-mutate.ts) runs preflight → reducer dry-run → gate eval → sidecar promote → fsync'd append → projection writes, all-or-nothing before the syscall. This core is genuinely deep and well-guarded. The friction is at the **edges**: the CLI surface (`cli.tsx`) re-assembles the same envelope + context at ~30 call sites, and per-`kind` knowledge is smeared across 5 files so the reducer/preflight split — though deliberate (ADR-0005) — taxes every new entry kind. The model matches the README/CLAUDE.md; no contradiction found.

## Findings

| ID | Category | File:Line | Severity | Effort | Description | Recommendation |
|----|----------|-----------|----------|--------|-------------|----------------|
| T1 | Concurrency | src/core/journal-mutate.ts:501,548 | High | M | Pass 5 (spec.md) + step 8 (snapshots) write *after* journal append; TODO states they MUST run inside the per-feature lock but currently do not. Concurrent CLI invocations on one feature can race projection writes. | Move Pass 5 + step 8 inside the per-feature lock (or finish before lock release). Confirm whether concurrent same-feature invocation is a real scenario first. |
| T2 ✅ | Dependency CVE | ink › ws (GHSA-58qx-3vcg-4xpx) | Low | S | **RESOLVED 2026-06-03.** `ws` moderate (uninitialized memory disclosure), nested via `ink` (`ws ^8.20.0` → 8.20.0, < 8.20.1 patched). Fixed with `overrides: { ws: ^8.21.0 }` + clean reinstall — a bare `bun update ws` only bumped a phantom top-level copy and left ink's nested 8.20.0 on Node's resolution path. `bun audit`: no vulnerabilities; 123 files / 2113 tests green. | Done. |
| T3 ✅ | Type debt | src/cli.tsx:1524,3087 | Medium | M | `t as unknown as TaskFullProjection` — double-cast of slim `TaskState` to full projection, at the exact slim/full seam. If the slim shape diverges, TS cannot catch it. | Resolve via the L5 task-materialization module (typed full↔slim conversion); the casts disappear. **DONE 2026-06-04 (L5) — casts verified gone from `src/`.** |
| T4 ✅ | Doc drift (corrected) | CLAUDE.md (Test conventions + commands) | Low | S | **MISFINDING — corrected.** No `tests/spike` directory exists; CLAUDE.md references `tests/spike/perf.test.ts:124`, the F-005 flake, and `bunx vitest run tests/spike` that are all stale. The full suite (123 files / 2113 tests) ran **clean and stable** — no flake observed. The original T4 took CLAUDE.md on faith; source check refuted it. | Drop the tests/spike / F-005 references from CLAUDE.md (needs explicit go — global rule forbids unprompted CLAUDE.md edits). **DONE 2026-06-04 — CLAUDE.md updated: planning-doc refs → `backlog.md`; tests/spike / F-005 removed.** |
| L5/A1 | Architectural decay | src/cli.tsx (6768 LOC, 72 commits/6mo) | Critical | L | God file: largest file *and* highest churn. Houses ~45 inline command actions, each repeating envelope + MutateContext + result routing. | Deepening L1 (mutator-command envelope) + L9 (named batch builders). See architecture review. |
| A2 | Architectural decay | src/core/reducer/preflight.ts (1900 LOC) | High | L | God file: 21 per-`kind` `if`-chains inline; not table-driven. | Deepening L2 (kind registry, metadata-only first cut). |
| A3 ✅ | Consistency / duplication | preflight.ts:1771 ↔ reducer.ts:987; preflight.ts:907/1689 ↔ reducer.ts:401/695 | Medium | S | `spec_version` monotonic + `DUPLICATE_*_ID` invariants hand-written twice (intentional defense-in-depth, but the *predicate* is duplicated, not just the layer). | Deepening L3: extract shared pure predicate; each layer keeps its own error shape. **Lowest-risk first cut.** **DONE 2026-06-04 (L3 `reducer/invariants.ts`).** |
| A4 ✅ | Architectural decay | src/core/session-dispatch.ts:181-294 ↔ src/cli/sessions-list.ts:91-187 | Medium | M | Registry *read* model scattered: strict resolution (dispatch) and lenient enumeration/orphan-warnings (list) each parse registry files. | Deepening L4: one registry read module exposing strict vs lenient policies. **DONE 2026-06-04 (L4).** |
| A5 ✅ | Consistency | verify-accept-check.ts:115-120,315-345 ↔ preflight.ts:734-792 | Medium | M | Task "proof" concept (passing-result + covering-evidence + bug-RED) stuck at helper level; verify-min is kind-stricter than verify-accept check 4. | Deepening L6: `evaluateTaskProof(snapshot, policy)` with policy variants (not a single `hasProof`). **DONE 2026-06-04 (L6 `gates/task-proof.ts`).** |
| A6 | Killed candidate | src/cli/runtime-i18n-keys.ts | Low | — | i18n key surface is wide, but ADR-0006 keeps locale in presentation; callers genuinely need domain choices. Not a real seam. | Deepening L8 — **do not abstract**. Add narrow helpers only where repetition is concrete. |
| O1 | Doc / surface | src/cli.tsx:2400 | Low | S | "only --rebuild is implemented for loaf doctor in this release" — bare `loaf doctor` read-only check suite (§10.15) is unimplemented; any guidance pointing to it would be premature. | Confirm planned vs dropped; gate user-facing references accordingly. |
| O2 | Config | env LOAF_SESSION / LOAF_FEATURE | Low | S | Documented in docs/ + protocol.md but not in user-facing README. | Add an env-var section to README if these are user-settable. |

## Top 5 — if you fix nothing else

1. **T1 — projection writes inside the lock.** The only finding with a correctness consequence. Pass 5 + step 8 (`journal-mutate.ts:501,548`) currently run outside the per-feature lock. Sketch: hold the lock from before append through step 8; release after registry refresh. Gate on confirming concurrent same-feature invocation is reachable — if the single-writer-lock + manual-CLI assumption holds, this drops to Low.
2. **L3 / A3 — share the duplicated invariant predicate.** Smallest structural cut, establishes the "shared predicate, separate error surface" discipline the larger work needs. Extract `isDuplicateId` / `checkSpecVersion*` as pure predicates; preflight keeps top-level public codes, reducer keeps defensive invalid-payload messages.
3. **L1 + L9 / A1 — decompose the cli.tsx god file.** Highest churn × size. `runMutator` absorbs envelope/context/dry-run/routing; named batch builders (`buildGateApprovalBatch`, `buildStepDoneBatch`) own the protocol-significant entry ordering that `runMutator` must NOT understand.
4. **T4 — quarantine the perf flake.** `tests/spike` out of the default `check` gate. One-line CI-trust win.
5. **T2 — `bun update`.** Clears the ws CVE.

## Quick wins (low effort × medium+ severity)

- [x] T2: ws CVE cleared via `overrides.ws ^8.21.0` + clean reinstall (`bun audit`: no vulnerabilities; 2113 tests green) — done 2026-06-03
- [x] T4: investigated — no `tests/spike` exists; reclassified to doc drift (CLAUDE.md stale reference)
- [x] A3/L3: shared invariant predicates extracted (`reducer/invariants.ts`) — done 2026-06-04; A4/L4 + A5/L6 + T3/L5 also closed (9-locus programme complete)

## Resolution mapping — will the 9 deepening loci clear this debt?

Honest traceability. The 9 loci (L1–L9) are a **navigability / locality** programme, not a debt-elimination programme. They close *some* findings and leave others entirely untouched. Do not assume "finish the 9 → debt gone."

| Debt | Severity | Closed by | Outcome |
|------|----------|-----------|---------|
| A3 duplicated invariants | Medium | **L3** | ✅ Fully closed |
| A4 registry read scatter | Medium | **L4** | ✅ Fully closed |
| A5 task-proof helper-level | Medium | **L6** | ✅ Fully closed |
| T3 slim/full `as unknown` casts | Medium | **L5** | ✅ Fully closed (but L5 is 7th in order) |
| A1 cli.tsx god file | Critical | L1 + L9 | ◐ **Shrinks, does not vanish** — ~45 commands remain; will not drop under 500 LOC |
| A2 preflight god file | High | L2 | ◐ **Partial** — static facts move to the kind registry; per codex's caveat the policy-type refines stay in preflight |
| A6 i18n width | Low | L8 (killed) | — No action; adds no debt |
| **T1 projection-write race** | **High** | none | ❌ Untouched by all 9 — independent fix; the one that actually matters |
| T2 ws CVE | Low | none | ✅ Already fixed independently |
| T4 doc drift | Low | none | Independent doc fix (CLAUDE.md) |
| O1 `loaf doctor` bare suite | Low | none | Independent / open question |
| O2 env README | Low | none | Independent doc fix |

Net from the 9: **4 fully closed** (A3/A4/A5/T3), **2 partially** (A1/A2 god files only shrink), **5 untouched** (T1 is the High one). The deepening can *add* debt if a locus produces a shallow pass-through — the per-locus grilling + codex caveats (deletion test, "two adapters = real seam") are the guard against that, not a guarantee.

## Things that look bad but are actually fine

- **127 catch blocks, zero swallowed.** Every one discriminates: `ENOENT → null` (`snapshot.ts:148`, `snapshot-reader.ts:45`), best-effort dir fsync with documented reason (`snapshot.ts:137`), migration rollback (`migration.ts:285,332`). No blanket catch-and-continue. This is disciplined I/O-boundary handling, not debt.
- **`z.unknown()` payloads** (`journal-entry.ts:187`) look like a type hole but are the intentional envelope-only validation boundary — per-`kind` schemas are applied separately. By design (ADR-0005), not laziness.
- **Duplicated invariants in preflight + reducer** (A3) look like copy-paste rot but are deliberate defense-in-depth (code comments confirm). The deepening targets the *predicate*, not the two-layer guard — the guard stays.
- **`trace-writer.ts:118` `JSON.parse(...) as unknown`** is the *correct* narrowing (parse returns `any`; casting to `unknown` forces validation). Good practice.
- **No `console.*` anywhere** — for a CLI this looks suspicious until you see all output flows through the structured `{ok}/{ok:false}` emitter. Correct for a protocol kernel.
- **The full suite is stable** — 123 files / 2113 tests pass clean, no flaky gate observed. CLAUDE.md's `tests/spike` / F-005 flake note is stale (no such directory); see T4.

## Open questions for the maintainer

- **T1 concurrency model**: is concurrent same-feature CLI invocation a real scenario, or does the single-writer `.lock` + manual-operator assumption make the projection-write race unreachable? This sets T1 at High vs Low.
- **O1 `loaf doctor` bare suite**: §10.15 read-only check suite — planned-but-unimplemented, or dropped? Stale-guidance risk if any error points to it.
- **A4 registry read**: is `sessions-list`'s tolerant orphan-warning behavior intentionally separate from dispatch's strict cwd-mismatch failure, or convergent debt? (Architecture review assumes separate-by-design; confirm.)
