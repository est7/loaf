import { z } from "zod";

// §39 DiagnosticCode + ErrorEntry + ERROR_CATALOG (rev 4.3 / ADR-0004 A9)
// ─────────────────────────────────────────────────────────────────
//
// Closed enumeration of diagnostic codes for user-recoverable failures
// (exit 2 family). exit 1 panics are NOT covered here — they emit a
// crash log + report URL only, no fix template (see protocol.md §10.5).
//
// ADR labelled this §37; renumbered to §39 (see §37 note).
//
// rev 4.3 first added 9 new codes (A3/A4/A6/A7) + canonicalized a
// handful of pre-existing codes (MUTUALLY_EXCLUSIVE_FLAGS /
// INVALID_ENV_VALUE / TASK_STATUS_WITHOUT_PROOF) referenced from
// schemas.ts. The subsequent drift sweep (rev 4.3 refactor C; see
// ADR-0004 「未在本 ADR 处理的项」) migrates all remaining
// protocol.md §10.5 codes into this enum: spec-lock checks
// (MISSING_VERIFIABILITY / VAGUE_NO_SCENARIO / DRIVES_NOT_BOUND),
// mutation rights (MUTATION_OUT_OF_RIGHTS), lock contention
// (LOCK_TIMEOUT / LOCK_HELD_BY), session dispatch (4 codes), and
// the pending-head invariant family (3 codes). GateDiagnostic
// .failures[].code is now z.lazy(() => DiagnosticCode) (was
// z.string().min(3)).
//
// MISSING_MEASURABLE (the older example in the GateDiagnostic
// comment) is folded into MISSING_VERIFIABILITY: the canonical
// spec-lock check is "missing one of measurable / verified_by_
// scenarios / acceptance_na+reason", not "missing measurable" in
// isolation. Adopting MISSING_VERIFIABILITY matches the i18n
// bundle key already in protocol.md §18.2.
//
// Output contract (protocol.md §10.5):
//
//   error: <message_template rendered with vars>
//          <optional context line>
//          fix: <fix_template rendered>
//          see: <doc_anchor>
//
// i18n: render goes through LOAF_LANG bundle keyed by code (protocol.md
// §18). The templates here are the canonical English source; bundles
// translate by code.
//
// Adding a new code post-GA is a §15 freeze concern. Pre-GA additions
// are allowed under the ADR-trail rewording (rev 4.3) — submit an ADR
// extending the enum, then update ERROR_CATALOG in the same commit.

export const DiagnosticCode = z.enum([
  // ── rev 4.3 new (ADR-0004) ──
  "INPUT_FILE_NOT_FOUND",                  // A3 / A11
  "MISSING_INPUT",                         // A3
  "SCHEMA_VALIDATION_FAILED",              // A3
  "SPEC_LOCKED_NO_DIRECT_EDIT",            // A4
  "SPEC_NOT_INITIALIZED",                  // A4
  "SPEC_ALREADY_INITIALIZED",              // Slice 4 SC4 — `loaf spec init` guard
  "CONFIG_ALREADY_INITIALIZED",            // config-init — `loaf config init` guard
  "ATTACHMENT_NOT_FOUND",                  // A6
  "ATTACHMENT_NOT_FILE",                   // A6
  "FINDING_ACTION_UNUSUAL_REASON_REQUIRED",// A7
  "FINDING_ACTION_INCOHERENT",             // A7
  "FINDING_TARGET_REQUIRED",               // Slice 3 SC3 (rev 4.3 §37 target_payload preflight)
  // ── prune session GC (loaf prune restore — slice 3 core; surfaced slice 6b) ──
  "PRUNE_RESTORE_NOT_FOUND",               // restorePrune: no trash bucket for the id
  "PRUNE_RESTORE_AMBIGUOUS",               // restorePrune: id trashed multiple times (need --at)
  "PRUNE_RESTORE_INCOMPLETE",              // restorePrune: bucket missing a required artifact
  "PRUNE_PATH_OCCUPIED",                   // restorePrune: a restore destination already exists
  "PRUNE_PARTIAL_FAILURE",                 // loaf prune: some targets errored mid-execute (exit 2)
  // SPEC_LOCKED_NO_DIRECT_EDIT + SPEC_NOT_INITIALIZED were pre-registered
  // in the rev 4.3 ADR-0004 A4 block above. Slice 4 SC3 wires them
  // through preflight refines (5i); no DiagnosticCode/ERROR_CATALOG
  // additions needed here.
  // ── pre-rev-4.3 codes already referenced from schemas.ts ──
  "MUTUALLY_EXCLUSIVE_FLAGS",              // §35 FLAG_EXCLUSIONS
  "INVALID_ENV_VALUE",                     // §35 commentary
  "INVALID_FORMAT",                        // Phase 16 SC-5a — --format <text|json> validation
  "INVALID_LOCALE",                        // ADR-0006 P0 — runtime locale resolution
  "DRY_RUN_NOT_APPLICABLE",                // Phase 16 SC-6c — --dry-run on read-only / wrapping commands
  "HOOK_EVENT_NOT_IMPLEMENTED",            // Phase 16 SC-15a — known hook event recognized but handler not yet wired (SC-15b/c land the real handlers; this code becomes reserved-for-future-events at SC-15c close, similar to TASK_STATUS_WITHOUT_PROOF pattern)
  "TASK_STATUS_WITHOUT_PROOF",             // rev 4.1 evidence proof rule
  // ── rev 4.3 refactor C drift sweep — protocol.md §10.5 migration ──
  "MISSING_VERIFIABILITY",                 // spec-lock §4.2 three-way check
  "VAGUE_NO_SCENARIO",                     // spec-lock §4.2 measurable-or-scenario
  "DRIVES_NOT_BOUND",                      // spec-lock §4.3 task.drives -> REQ binding
  "MUTATION_OUT_OF_RIGHTS",                // §8.6 mutation rights matrix violation
  "LOCK_TIMEOUT",                          // §11.2 lock acquisition exceeded 30s
  "LOCK_HELD_BY",                          // §11.2 concurrent lock contention
  "FEATURE_NOT_FOUND",                     // §10.3 session dispatch — cwd has 0 features
  "FEATURE_AMBIGUOUS",                     // §10.3 session dispatch — cwd has 2+ features w/o ctx
  "SESSION_CWD_MISMATCH",                  // §10.3 session dispatch — --session UUID cwd mismatch
  "SESSION_SHORT_AMBIGUOUS",               // §10.3 session dispatch — short UUID prefix collision
  "SESSION_NOT_FOUND",                     // §10.3 session dispatch — Phase 16 SC-8 — UUID/prefix matches no registry entry
  "PENDING_BLOCKS_ADVANCE",                // §10.7 pending head ∈ {gate_decision, profile_escalation}
  "GATE_NOT_PENDING",                      // §10.7 `loaf gate decide <G>` but head isn't gate_decision(<G>)
  "ESCALATION_NOT_PENDING",                // §10.7 `loaf profile escalate --confirm --input <ceremony.json>` but head isn't profile_escalation
  // ── audit r1-r5 — runtime preflight / transition ──
  "ACTOR_AUTHORITY_VIOLATION",             // src/core/reducer/preflight.ts:101-107
  "FROM_CURSOR_MISMATCH",                  // src/core/reducer/preflight.ts:131-140
  "INVALID_ENVELOPE",                      // src/core/reducer/preflight.ts:64-71; src/core/journal-append.ts:79-85
  "INVALID_PAYLOAD",                       // src/core/reducer/preflight.ts:115-123; src/core/journal-append.ts:92-99; src/core/reducer.ts:148-153
  "SEQ_NOT_MONOTONIC",                     // src/core/reducer/preflight.ts:75-87; src/core/journal-append.ts:102-111
  "SETTLE_PHASE_BYPASS",                   // src/core/reducer/transition.ts:159-166
  "SETTLE_PHASE_DISABLED",                 // src/core/reducer/transition.ts:150-156
  "SPEC_PHASE_FORK_VIOLATION",             // src/core/reducer/transition.ts:100-119
  "SUB_STATE_AUTHORITY_VIOLATION",         // src/core/reducer/preflight.ts:90-97
  "TRANSITION_ILLEGAL",                    // src/core/reducer/transition.ts:82-94
  "VERIFY_PHASE_FORK_VIOLATION",           // src/core/reducer/transition.ts:125-144
  "EXECUTE_DONE_TASKS_NOT_FINAL",          // F-016 — preflight: EXECUTE.work→EXECUTE.done requires every task status ∈ {done, abandoned}
  // ── audit r1-r5 — reducer.apply ──
  "ALREADY_STARTED",                       // src/core/reducer.ts:109-115; src/core/reducer.ts:134-141
  "FINDING_NOT_FOUND",                     // src/core/reducer.ts:333-342
  "NO_SESSION",                            // src/core/reducer.ts:172-178
  "PENDING_NOT_FOUND",                     // src/core/reducer.ts:359-377
  "REDUCER_NOT_IMPLEMENTED",               // src/core/reducer.ts:413-424
  // ── audit r1-r5 — journal append primitive ──
  "ENTRY_OVERSIZE",                        // src/core/journal-append.ts:121-126
  "SHORT_WRITE",                           // src/core/journal-append.ts:131-137
  "TAIL_CORRUPTION",                       // src/core/journal-append.ts:29-35
  // ── audit r1-r5 — migration v0.0.x → v0.1.0 ──
  "MIGRATION_BACKUP_MISSING",              // src/core/migration.ts:204-211
  "MIGRATION_INCOMPLETE",                  // src/core/migration.ts:397-407; src/core/migration.ts:427-465; src/core/migration.ts:477-616; src/core/migration.ts:630-654
  "MIGRATION_REPLAY_ATTEMPT",              // src/core/migration.ts:187-195
  "MIGRATION_SIDECAR_MISSING",             // src/core/migration.ts:232-240; src/core/migration.ts:636-645
  // ── audit r1-r5 — actor resolver ──
  "INVALID_ACTOR_FORMAT",                  // src/core/actor-resolver.ts:35-72
  "NO_HUMAN_ACTOR",                        // src/core/actor-resolver.ts:81-101
  // ── Slice 1.B sub-cycle 1 — SPEC content reducer (codex r17) ──
  // SPEC_VERSION_NOT_MONOTONIC + SPEC_VERSION_BATCH_MISMATCH originally
  // landed here as reducer message strings. Slice E (codex r100 audit)
  // promoted them to PreflightFailureCode and registered the canonical
  // public catalog entries below alongside the other Slice E codes
  // (search for "Slice E — SPEC_VERSION_*"); duplicate rows here have
  // been removed so docs/schemas.ts represents a single source of truth.
  "DUPLICATE_REQ_ID",                      // src/core/reducer.ts spec_req_added — id already in requirements[]
  "DUPLICATE_SCEN_ID",                     // src/core/reducer.ts spec_scenario_added — id already in scenarios[]
  "DUPLICATE_VIS_ID",                      // src/core/reducer.ts spec_visual_added — id already in visual_contracts[]
  // ── Slice 1.B sub-cycle 2 — spec-lock gate (codex r20) ──
  "SPEC_FRONTMATTER_INVALID",              // src/core/spec-frontmatter.ts — disk/yaml/zod read failures collapsed under check 1 with detail.subcode (SPEC_NOT_FOUND | SPEC_YAML_INVALID | SPEC_FRONTMATTER_INVALID)
  "SPEC_HAS_UNCLARIFIED",                  // src/core/gates/spec-lock-check.ts — check 2: frontmatter.needs_clarification non-empty
  // ── Slice 1.B sub-cycle 3a — TaskState projection + F-010 fix (codex r23) ──
  "TASK_NOT_FOUND",                        // src/core/reducer.ts tasks_amended / task_step_* — referenced task id not in projection
  "TASK_STEP_NOT_FOUND",                   // src/core/reducer.ts task_step_started / _done — referenced step not seeded on task
  "DUPLICATE_TASK_ID",                     // src/core/reducer.ts tasks_planned — duplicate id within same payload
  // ── Slice 1.B sub-cycle 3b — spec-lock checks 3/4/6/7/8 (codex r26) ──
  "TASKS_NOT_PLANNED",                     // src/core/gates/spec-lock-check.ts check 3 — snapshot.tasks_based_on is null
  "TASKS_BASED_ON_STALE",                  // src/core/gates/spec-lock-check.ts check 3 — tasks_based_on.spec ≠ frontmatter.spec_version
  "REQ_NOT_DRIVEN",                        // src/core/gates/spec-lock-check.ts check 4 — REQ has no task with drives[] including its id (REQ-side coverage; distinct from legacy DRIVES_NOT_BOUND which named the inverse direction)
  "E2E_SCENARIO_UNBOUND",                  // src/core/gates/spec-lock-check.ts check 6 — e2e scenario lacks a task with requires_acceptance=true AND drives.includes(scenario.id)
  "VISUAL_CONTRACT_UNBOUND",               // src/core/gates/spec-lock-check.ts check 7 — visual_contract lacks a visual-ui task with visual_contract_refs.includes(visual.id)
  "TASK_KIND_SCHEMA_VIOLATION",            // src/core/gates/spec-lock-check.ts check 8 — projected kind-specific obligations missing (defense-in-depth for migration:snapshot_imported)
  // ── Slice 1.B sub-cycle 3c — mutateBatch spec-lock wire (codex r28) ──
  // NOTE these are MUTATE-LAYER failures (the gate evaluator decided NOT
  // to admit the batch); they are NOT spec-lock machine-check codes
  // themselves. Spec-lock checks above (2/3/4/5/6/7/8) live in detail.checks.
  "GATE_PRECONDITION_VIOLATION",           // src/core/journal-mutate.ts Pass 1.5 — evaluateSpecLock returned !ok; detail.checks: FailedCheck[]
  "MULTIPLE_GATE_DECISIONS",               // src/core/journal-mutate.ts Pass 1.5 — batch carries ≥2 approved gate:decided entries (any gate_kind); protocol §10.8 requires one gate decision per atomic operation
  // ── Slice 1.B sub-cycle 4 — CLI gate decide MVP (codex r31 Option B) ──
  "GATE_NOT_IMPLEMENTED",                  // src/cli.tsx `loaf gate decide <name>` — gate name not recognized (Slice 1.C wires spec-lock + verify-accept; protocol GateName enum is closed at these two for v0.1.0)
  // ── Slice 1.C sub-cycle 3 — verify-accept-check (codex r33 + r38 + r40) ──
  "VERIFY_LANE_NOT_PASSED",                // src/core/gates/verify-accept-check.ts check 1 — applicable lane (run/review/acceptance/visual) has no evidence with passing/approved/waived result
  "OPEN_FINDINGS_PRESENT",                 // src/core/gates/verify-accept-check.ts check 2 — snapshot.findings still has status=open entries
  "COVERAGE_NOT_SATISFIED",                // src/core/gates/verify-accept-check.ts check 3 — non-na REQ/SCEN/VIS has no evidence with covers+canSatisfy+passing result (protocol §1035 filter)
  "TASK_DONE_NO_EVIDENCE",                 // src/core/gates/verify-accept-check.ts check 4 — task.status=done has no evidence (kind ∈ {task-summary, local-check, manual, waiver})
  "SPEC_REVIEW_MISSING",                   // src/core/gates/verify-accept-check.ts check 5 — ceremony.strict_spec_review=true but no spec-review evidence with result ∈ {passed, approved}
  "SPEC_REVIEW_IMPLEMENTER_CONFLICT",      // src/core/gates/verify-accept-check.ts check 5 — every passing spec-review actor is in implementer set; no independent reviewer signed off
  "SPEC_REVIEW_IMPLEMENTER_UNKNOWN",       // src/core/gates/verify-accept-check.ts check 5 — implementer set empty (done-task evidence all from cli:* actors); fail-closed
  // ── Slice 1.D sub-cycle 1 — loaf deliver / loaf settle preflight refines (codex r49/r50/r51) ──
  "DELIVER_NOT_ACCEPTED",                  // src/core/reducer/preflight.ts step 5c — `session:delivered` at VERIFY.accept or SETTLE.lessons but snapshot.state.verify_accepted=false
  "DELIVER_SETTLE_PHASE_BYPASS",           // src/core/reducer/preflight.ts step 5c — `session:delivered` at VERIFY.accept but ceremony.settle_phase=true (deep must run `loaf settle` first)
  "DELIVER_VERIFY_MIN_UNAVAILABLE",        // src/core/reducer/preflight.ts step 5c — v0.1.0 fail-closed stub; SUPERSEDED at v0.1.1 by DELIVER_VERIFY_MIN_INCOMPLETE (verify-min landed). Reserved-for-history; no longer emitted at runtime.
  "DELIVER_VERIFY_MIN_INCOMPLETE",         // src/core/reducer/preflight.ts step 5c — v0.1.1: `session:delivered` at EXECUTE.done (quick/light) but ≥1 done task lacks the §3.2 per-kind verify-min evidence (code→local-check / visual-ui→visual-review|manual / docs→task-summary|manual / chore→local-check|manual|task-summary; waiver always satisfies)
  "DELIVER_SPIKE_TASKS",                   // src/core/reducer/preflight.ts step 5c — snapshot.tasks contains a non-abandoned spike task (protocol §703 + §1298 hard block)
  "SETTLE_NOT_ACCEPTED",                   // src/core/reducer/transition.ts — `event:phase_advanced` VERIFY.accept→SETTLE.reconcile but snapshot.state.verify_accepted=false (gate must approve before settle)
  "SPEC_LOCK_NOT_SATISFIED",               // src/core/reducer/transition.ts — `event:phase_advanced` SPEC.design→EXECUTE.plan but snapshot.state.spec_locked=false (W1: spec-lock gate must approve before advancing to EXECUTE; symmetric to SETTLE_NOT_ACCEPTED)
  // ── Slice 2 SC1 — task lifecycle preflight (codex r56/r57) ──
  "TASK_NOT_CLAIMABLE",                    // src/core/reducer/preflight.ts step 5e — event:task_claimed for task with status ∈ {done, abandoned} (terminal — cannot be reclaimed)
  "TASK_ALREADY_CLAIMED",                  // src/core/reducer/preflight.ts step 5e — event:task_claimed for task with status=in_progress
  "TASK_DEP_NOT_FOUND",                    // src/core/task-graph.ts admission-only — depends_on[i] references no task in the batch-final graph
  "TASK_DEP_SELF",                         // src/core/task-graph.ts admission-only — task depends on itself
  "TASK_DEP_DUPLICATE",                    // src/core/task-graph.ts admission-only — one depends_on array repeats a task id
  "TASK_DEP_CYCLE",                        // src/core/task-graph.ts admission-only — deterministic DFS found a closed dependency path
  "TASK_DEP_ABANDONED",                    // src/core/task-graph.ts admission-only — non-terminal task depends on an abandoned task
  "TASK_DEPS_NOT_SATISFIED",               // src/core/reducer/preflight.ts step 5e — event:task_claimed but some task in deps_on is not status=done
  "TASK_NOT_CLAIMED",                      // src/core/reducer/preflight.ts step 5e — event:task_step_started or event:task_step_done but task.status ≠ in_progress (must claim before mutating steps)
  // ── Item 1 — `loaf tasks abandon` preflight (codex r127) ──
  "TASK_NOT_ABANDONABLE",                  // src/core/reducer/preflight.ts step 5e.3 — event:task_abandoned for a task with status ∈ {done, abandoned} (already final — abandon is a no-op)
  "TASK_ABANDON_BLOCKED_DEPENDENTS",       // src/core/reducer/preflight.ts step 5e.3 — event:task_abandoned but a non-terminal task lists the target in depends_on (would strand the dependent)
  // ── Item 2 — `loaf archive` / `loaf abandon` preflight (codex r129) ──
  "SESSION_REASON_REQUIRED",               // src/core/reducer/preflight.ts step 5c.2 — session:archived or session:abandoned with no reason key (the shared SessionReasonPayload makes reason optional; archive/abandon tighten it to required)
  // ── Slice A SC-A2 — spec.md projection writer (post-appendMany Pass 5) ──
  "PROJECTION_WRITE_FAILED",               // src/core/journal-mutate.ts Pass 5 — writeDerivedSpecMd threw after journal append succeeded; journal authoritative, run `loaf doctor --rebuild` to resync
  "WRITE_CONTENTION",                       // src/core/journal-mutate.ts W3 — another writer holds the per-feature .lock (O_EXCL); retry after release, or `loaf doctor` clears a stale lock left by a crashed writer
  // ── Slice B — finding amend-spec back-edge batch (codex r94/r96) ──
  "FINDING_AMEND_SPEC_NOT_LOCKED",         // src/core/reducer/preflight.ts — `finding:raised` action=amend-spec when state.spec_locked=false; pre-lock should edit via `loaf spec submit / add-*` directly
  // ── Slice E — SPEC_VERSION_NOT_MONOTONIC / SPEC_VERSION_BATCH_MISMATCH promotion ──
  // (mirror Slice 2 SC4 DUPLICATE_TASK_ID + Slice 4 SC1 DUPLICATE_REQ_ID/SCEN/VIS).
  // Both were previously reducer message strings under INVALID_PAYLOAD wrap;
  // promoted so CLI surfaces the actionable code directly.
  "SPEC_VERSION_NOT_MONOTONIC",            // src/core/reducer/preflight.ts spec_version != current+1 at batch head (spec_submitted | spec_*_added head)
  "SPEC_VERSION_BATCH_MISMATCH",           // src/core/reducer/preflight.ts spec_submitted at batch_index>0 (structurally illegal) OR spec_*_added continuation with spec_version != current
  // ── Slice C SC-C1 — `loaf tasks complete` NO-OP confirmation ──
  "TASK_COMPLETE_PRECONDITION_VIOLATED",   // src/cli.tsx `loaf tasks complete` — task.status != done; one or more must-applicable steps not terminal-positive (passed|waived|na)
  // ── Slice C SC-C2c — `loaf tasks amend` canonical body recovery ──
  "CANONICAL_TASK_BODY_UNAVAILABLE",       // src/cli.tsx `loaf tasks amend` — task is in the projection but has no journal tasks_planned/tasks_amended body (migration-imported); a whole-task amend cannot be reconstructed
  // ── Slice C SC-C4 — bug-task RED registration (R2 invariant relocation) ──
  "BUG_TASK_REQUIRES_RED",                 // src/core/reducer/preflight.ts — behavioral bug task started/completed its implement step before `loaf tasks register-red` set red_test_registered
  "BUG_TASK_FLAG_MISUSE",                  // src/core/reducer/preflight.ts — red_test_registered=true used outside a red-step task_step_done on a behavioral bug task (passed/waived), or smuggled into a newly planned task
  "BUG_TASK_RED_NOT_REGISTERED",           // src/core/gates/verify-accept-check.ts check 4 — done behavioral bug task never registered its RED test (defense-in-depth)
  // ── Phase 12 — `loaf spike convert` (spike:converted) precondition ──
  "SPIKE_CONVERT_NO_SPIKE_TASK",           // src/core/reducer/preflight.ts step 5c.3 — `spike:converted` but snapshot.tasks holds no non-abandoned kind=spike task (`loaf spike convert` is a spike-task exit, protocol §8.3)
  // ── Phase 15 SC3 — reader fast-check goes live (projection-loader) ──
  "SNAPSHOT_STALE_REBUILD_REQUIRED",       // src/core/projection-loader.ts — 9-reason stale/corruption family (journal_missing / journal_empty / tail_offset_mismatch / tail_hash_mismatch / trailing_partial_line / meta_missing / meta_invalid / projection_missing / projection_invalid). detail.reason carries the discriminant; reason-specific detail keys mirror snapshot-reader and loader-added envelope (feature_dir, fix, plus per-reason context like meta_path / projection_kind / cause)
  // ── Phase 16 SC-1 — CLI catalog hygiene (codex r187 BLOCKER 4 closure) ──
  // The 7 codes below were emitted by src/cli.tsx but unregistered through
  // the SC-0 inventory harness shipping window; SC-1 registers them with
  // placeholder-free generic wording (cli.tsx fail* paths render literal
  // strings — structured detail rendering is SC-2 work; codex r193 PATCH 3).
  // USAGE NOT renamed (codex r193 BLOCKER 1: 17+ emit sites + tests +
  // protocol prose); rename, if ever, is a separate dedicated SC.
  "INVALID_PRESET",                        // src/cli.tsx — `loaf start` ceremony preset validation (protocol §10.5)
  "USAGE",                                 // src/cli.tsx — generic CLI usage failure across many commands (protocol §10.5)
  "DOCTOR_MODE_NOT_IMPLEMENTED",           // src/cli.tsx — `loaf doctor` invoked in a non-rebuild mode (protocol §10.15)
  "DOCTOR_FEATURE_REQUIRED",               // src/cli.tsx — `loaf doctor --rebuild` without --feature/--feature-dir (protocol §10.15)
  "DOCTOR_REBUILD_FAILED",                 // src/cli.tsx — `loaf doctor --rebuild` rebuild loop or projection write failed (protocol §10.15)
  "DOCTOR_REBUILD_MIGRATED_UNSUPPORTED",   // src/cli.tsx — `loaf doctor --rebuild` invoked on a v0.0.x-migrated journal (protocol §10.15)
  "REDUCER_ERROR",                         // src/cli.tsx + src/core/journal-mutate.ts — wraps reducer-thrown invariant failures surfaced through multiple mutator paths (protocol §10.5)
  "WRITE_PATH_VIOLATION",                   // Phase 16 SC-15c — `loaf hook write-guard`: target path outside the current sub_state/task/step allow-set (protocol §11.1)
  "PROTECTED_FILE_WRITE",                   // Phase 16 SC-15c — `loaf hook write-guard`: target path matched loaf.config.json protected_files hard-deny (protocol §11.1)
]);
export type DiagnosticCode = z.infer<typeof DiagnosticCode>;

export const ErrorEntry = z.object({
  exit_code: z.literal(2),
  // Rendered into the `error:` line. May contain {placeholder} tokens
  // resolved against caller-provided vars at emit time.
  message_template: z.string().min(3),
  // Rendered into the `fix:` line. omitted ⇒ no fix line emitted
  // (reserved for codes where no actionable fix exists; rare).
  fix_template: z.string().min(3).optional(),
  // Rendered into the `see:` line. Anchor into protocol.md or a doc URL.
  doc_anchor: z.string().min(3).optional(),
});
export type ErrorEntry = z.infer<typeof ErrorEntry>;

// protocol.md# anchors resolve from docs/protocol.md; other docs/ paths are repo-relative.
export const ERROR_CATALOG: Record<DiagnosticCode, ErrorEntry> = {
  INPUT_FILE_NOT_FOUND: {
    exit_code: 2,
    message_template: "input file does not exist: {path}",
    fix_template:
      "verify the path, or pass '-' to read from stdin / inline JSON " +
      "starting with '{' or '[' — see `loaf <cmd> --help` for examples",
    doc_anchor: "protocol.md#§10.7",
  },
  MISSING_INPUT: {
    exit_code: 2,
    // Phase 16 SC-4b (codex r224 PATCH 4): widened from "--input not
    // provided" to also cover the stdin-read-failure path. readJsonInput
    // returns MISSING_INPUT when (a) the flag was omitted upstream (no
    // current emit site post-SC-4a) OR (b) `--input -` was passed but
    // deps.readStdin threw (stdin closed / EAGAIN / etc.).
    message_template:
      "required input source missing or unreadable: --input not provided OR stdin could not be read (--input - failed)",
    fix_template:
      "pass --input with one of: a JSON file path, '-' for stdin (with " +
      "valid piped JSON), or inline JSON; for stdin failures, verify the " +
      "pipe is intact (e.g. `echo '{...}' | loaf <cmd> --input -`); when " +
      "supported by the command (Phase 16 SC-10: the 5 batch-capable mutators " +
      "spec add-req / spec add-scenario / spec add-visual / tasks add / " +
      "evidence add), run `loaf <cmd> --schema --format=json` to view the " +
      "input schema",
    doc_anchor: "protocol.md#§10.7",
  },
  SCHEMA_VALIDATION_FAILED: {
    exit_code: 2,
    message_template:
      "input does not satisfy schema for {command}: {zod_path}: {zod_message}",
    fix_template:
      "for the 5 batch-capable mutators (spec add-req / spec add-scenario / " +
      "spec add-visual / tasks add / evidence add), run `loaf {command} " +
      "--schema --format=json` to dump the input JSON Schema; for artifact " +
      "projection files, run `loaf <kind> schema --format=json` (kind ∈ " +
      "spec / tasks / evidence / finding / state). Fix the offending field " +
      "and retry",
    doc_anchor: "protocol.md#§10.5",
  },
  SPEC_LOCKED_NO_DIRECT_EDIT: {
    // Slice 4 SC3: preflight refine (5i) emits this with
    // detail.kind = journal entry kind (event:spec_submitted /
    // event:spec_req_added / event:spec_scenario_added /
    // event:spec_visual_added) and detail.spec_locked = true.
    exit_code: 2,
    message_template:
      "{kind} blocked: spec_locked=true; direct add/edit rejected post-lock",
    fix_template:
      "raise a finding with category=spec-gap (or spec-defect) and " +
      "action=amend-spec to back-edge into SPEC.spec (the finding's " +
      "resets_spec_locked effect lifts the gate); then retry the spec " +
      "add/submit",
    doc_anchor: "protocol.md#§5.3",
  },
  EXECUTE_DONE_TASKS_NOT_FINAL: {
    // F-016: preflight refine on event:phase_advanced. The EXECUTE.work →
    // EXECUTE.done edge requires every task in a final status (done |
    // abandoned) — protocol defines EXECUTE.done as "all tasks final".
    // detail.non_final = [{task_id, status}, ...]; detail.count = number
    // of offending tasks (the template interpolates count only — the
    // structured list rides detail, not the rendered message).
    exit_code: 2,
    message_template:
      "cannot advance EXECUTE.work to EXECUTE.done: {count} task(s) are not " +
      "in a final status (done or abandoned)",
    fix_template:
      "finish the remaining steps — run each task's steps via " +
      "`loaf tasks step` until it auto-promotes to status=done — OR " +
      "abandon out-of-scope tasks with " +
      "`loaf tasks abandon <T-N> --reason \"...\"`, then retry " +
      "`loaf advance EXECUTE.done`; see detail.non_final for the tasks " +
      "still pending or in progress",
    doc_anchor: "protocol.md#§10.5",
  },
  SPEC_ALREADY_INITIALIZED: {
    // Slice 4 SC4: `loaf spec init` refuses to overwrite an existing
    // spec.md. detail.spec_md_path carries the existing file path so
    // scripts can locate it. No --force flag in Slice 4 (codex r74).
    exit_code: 2,
    message_template:
      "spec.md already exists at {spec_md_path}; refusing to overwrite",
    fix_template:
      "edit the existing spec.md directly, or remove it before re-running " +
      "`loaf spec init` (no --force flag in Slice 4)",
    doc_anchor: "protocol.md#§4.2",
  },
  CONFIG_ALREADY_INITIALIZED: {
    exit_code: 2,
    message_template:
      "loaf config already exists at {config_path}; refusing to overwrite",
    fix_template:
      "edit the existing config file directly, or remove it before re-running " +
      "`loaf config init` (no --force flag)",
    doc_anchor: "protocol.md#§10.8",
  },
  SPEC_NOT_INITIALIZED: {
    // Slice 4 SC3: preflight refine (5i) emits this with detail.kind
    // (one of the 3 add-* kinds; spec_submitted is exempt as the init
    // step) and detail.spec_version = 0. Recovery path under SC3 is
    // `loaf spec submit` (whole-replacement) — `loaf spec init`
    // (scaffold-only, no journal entry) is deferred to SC4 and will
    // chain into submit there.
    exit_code: 2,
    message_template:
      "{kind} blocked: spec_version=0 (spec not yet submitted)",
    fix_template:
      "run `loaf spec submit --input <file>` first to bump spec_version " +
      "to 1, then retry the add-* command (SC4 will add `loaf spec init` " +
      "as a separate scaffold helper that chains into submit)",
    doc_anchor: "protocol.md#§4.2",
  },
  ATTACHMENT_NOT_FOUND: {
    exit_code: 2,
    message_template: "attachment path does not exist: {path}",
    fix_template:
      "verify the path is reachable from the working directory and " +
      "readable by the current user",
    doc_anchor: "protocol.md#§4.4",
  },
  ATTACHMENT_NOT_FILE: {
    exit_code: 2,
    message_template:
      "attachment path is not a regular file: {path} ({kind})",
    fix_template:
      "attachments must be regular files; directories, symlinks to " +
      "directories, sockets, and FIFOs are rejected",
    doc_anchor: "protocol.md#§4.4",
  },
  FINDING_ACTION_UNUSUAL_REASON_REQUIRED: {
    exit_code: 2,
    message_template:
      "finding category={category} × action={action} is 'unusual'; " +
      "--reason of at least {min_length} characters is required",
    fix_template:
      "rerun with --reason explaining why this non-typical combination " +
      "applies (see references/finding-matrix-rationale.md)",
    doc_anchor: "protocol.md#§4.5",
  },
  FINDING_ACTION_INCOHERENT: {
    exit_code: 2,
    message_template:
      "finding category={category} × action={action} is incoherent: " +
      "no target task exists to apply this transition to",
    fix_template:
      "amend the spec first (category=spec-gap / new-scope × " +
      "action=amend-spec) so a target task can be planned, then raise " +
      "the fix-impl / fix-test finding against that task",
    doc_anchor: "protocol.md#§4.5",
  },
  FINDING_TARGET_REQUIRED: {
    // Slice 3 SC3 (rev 4.3 §37 + ADR-0004 A7). The action-effect
    // FINDING_ACTION_EFFECTS.requires_target_payload contract is enforced
    // at preflight. detail.reason carries the specific violation:
    //   missing            — task_id_step action raised without target
    //   task_not_found     — target.task_id not in snapshot.tasks
    //   step_mismatch      — target.step != action's canonical step
    //                        (fix-impl needs "implement", fix-test needs "red")
    //   step_not_found     — target.step not in task.steps for the target task
    //   target_not_allowed — `none`-mode action raised with a target
    //                        (amend-spec / defer / backlog cannot carry one)
    exit_code: 2,
    message_template:
      "finding action={action} target validation failed ({reason}): " +
      "task_id={task_id}, step={step}",
    fix_template:
      "fix-impl/fix-test require --target-task + --target-step matching " +
      "the action's canonical step (fix-impl=implement, fix-test=red); " +
      "amend-tasks accepts an optional but valid target; " +
      "amend-spec / defer / backlog must not carry a target",
    doc_anchor: "protocol.md#§4.5",
  },
  MUTUALLY_EXCLUSIVE_FLAGS: {
    exit_code: 2,
    message_template:
      "mutually exclusive flags in the same invocation: {flags}",
    fix_template:
      "pass at most one of the flags from each exclusion set; see " +
      "`loaf <cmd> --help` for the canonical flag list",
    doc_anchor: "protocol.md#§10.7",
  },
  INVALID_ENV_VALUE: {
    exit_code: 2,
    message_template:
      "environment variable {env_name}={value} is not in the accepted " +
      "enum: {accepted}",
    fix_template:
      "unset {env_name} or set it to one of: {accepted}",
    doc_anchor: "protocol.md#§10.3",
  },
  INVALID_FORMAT: {
    // Phase 16 SC-5a — pre-parse guard rejects invalid --format <value>
    // before Commander parse / actor init / loadSession / loadProjections
    // fire (r249 RED #10). Two template placeholders, machine + human:
    //   detail.value           = raw flag value (e.g. "yaml")
    //   detail.allowed_values  = ["text", "json"]  (JS array, machine)
    //   template var value                = same as detail.value
    //   template var allowed_values_human = "text|json"  (pipe-joined; never
    //                                                     Array.toString())
    // Catalog ↔ i18n placeholder symmetry is enforced by
    // tests/scripts/sc5a-surface-gate.test.ts RED #12.
    exit_code: 2,
    message_template:
      "invalid --format value '{value}'; allowed: {allowed_values_human}",
    fix_template:
      "pass --format text or --format json (the only allowed values " +
      "for this release); --format=<value> equals form is accepted",
    doc_anchor: "protocol.md#§10.7",
  },
  INVALID_LOCALE: {
    // ADR-0006 P0 — explicit locale declarations are strict. Ambient
    // LANG/LC_* values that are unsupported fall back to en silently;
    // this diagnostic is only for explicit LOAF_LANG / user config /
    // future --lang inputs.
    exit_code: 2,
    message_template:
      "invalid locale from {source}: {value} (expected {accepted})",
    fix_template:
      "unset the locale override or set it to one of: {accepted}; user " +
      "preferences live in ~/.loaf/config.json locale.default_lang",
    doc_anchor: "docs/adr/0006-runtime-i18n-and-user-config.md",
  },
  DRY_RUN_NOT_APPLICABLE: {
    // Phase 16 SC-6c — `--dry-run` only applies to mutating commands.
    // Read-only commands (status, next, tasks list/next/complete, doctor,
    // finding list, pending list/status, ...) reject with this code.
    // Future: wrapping commands (`spec edit`, `tui`) also reject when
    // implemented. `command_type` discriminates "read-only" vs
    // "wrapping" (the wrapping variant is reserved for future use).
    exit_code: 2,
    message_template:
      "--dry-run not applicable to {command_type} command `{command}`",
    fix_template:
      "--dry-run only applies to mutating commands; re-run without " +
      "--dry-run (or -n) to invoke the {command_type} command",
    doc_anchor: "protocol.md#§10.7-dry-run",
  },
  HOOK_EVENT_NOT_IMPLEMENTED: {
    // Phase 16 SC-15a — known hook event recognized by HookEvent enum
    // but the handler hasn't been wired yet (SC-15b lands session-start
    // + closure-check; SC-15c lands write-guard + scope-track). After
    // SC-15c, no runtime path emits this code; it stays in the catalog
    // as reserved-for-future-events (mirror of TASK_STATUS_WITHOUT_PROOF
    // pattern). The dedicated code (vs. generic USAGE) lets skill /
    // CI consumers tell "event not implemented" from "unknown event".
    exit_code: 2,
    message_template:
      "hook event `{event}` is not implemented in this loaf version " +
      "(Phase 16 SC-15{sub_cycle} pending; see protocol §11)",
    fix_template:
      "upgrade to a loaf release that implements this hook event, OR " +
      "skip this hook surface for now — `loaf hook --list-events` " +
      "shows the canonical 4-event enum",
    doc_anchor: "protocol.md#§11",
  },
  WRITE_PATH_VIOLATION: {
    // Phase 16 SC-15c — `loaf hook write-guard`: the tool's target path is
    // outside the allow-set for the current sub_state + active task/step +
    // config-widened categories. Distinct from PROTECTED_FILE_WRITE (a
    // hard-deny) so skill/CI can tell "wrong phase/step/path-config" from
    // "never write here".
    exit_code: 2,
    message_template:
      "write blocked: `{normalized_path}` is outside the allowed write " +
      "paths for sub_state `{sub_state}`",
    fix_template:
      "write within the current step's contract, advance to the right " +
      "sub_state/step first, or widen the matching `paths.*` category in " +
      ".loaf/.config/loaf.config.json",
    doc_anchor: "protocol.md#§11.1",
  },
  PROTECTED_FILE_WRITE: {
    // Phase 16 SC-15c — `loaf hook write-guard`: the target path matched a
    // loaf.config.json protected_files entry (hard-deny, evaluated after
    // path normalization, regardless of sub_state/step).
    exit_code: 2,
    message_template:
      "write blocked: `{normalized_path}` matches protected_files entry " +
      "`{matched_deny}` — protected files are never writable",
    fix_template:
      "remove the entry from protected_files in " +
      ".loaf/.config/loaf.config.json if the protection is wrong, " +
      "otherwise write a different file",
    doc_anchor: "protocol.md#§11.1",
  },
  MISSING_VERIFIABILITY: {
    exit_code: 2,
    message_template:
      "requirement {req_id} declares no verifiability anchor " +
      "(measurable, verified_by_scenarios, or acceptance_na+reason)",
    fix_template:
      "add one of: measurable {metric, threshold[, unit, direction]}; " +
      "verified_by_scenarios: [SCEN-...]; or acceptance_na: true with " +
      "acceptance_na_reason of at least 10 characters",
    doc_anchor: "protocol.md#§4.2",
  },
  VAGUE_NO_SCENARIO: {
    exit_code: 2,
    message_template:
      "requirement {req_id} reads as vague but is not anchored to a " +
      "measurable threshold or to a verifying scenario",
    fix_template:
      "either add measurable with a numeric threshold and direction, " +
      "or add the verifying SCEN-id to verified_by_scenarios",
    doc_anchor: "protocol.md#§4.2",
  },
  DRIVES_NOT_BOUND: {
    exit_code: 2,
    message_template:
      "REQ {req_id} is declared in spec.md but no task drives it " +
      "(task.drives -> REQ binding is missing)",
    fix_template:
      "add a task whose drives[] contains {req_id} (loaf tasks add " +
      "--input ...), or remove the REQ if it is intentionally " +
      "out-of-scope for this feature",
    doc_anchor: "protocol.md#§4.3",
  },
  // Slice C SC-C2b + Phase 11 Item 3 SC1b — emitted by preflight for
  // event:tasks_amended §8.6 violations. detail carries task_id + mode +
  // sub_state always, plus field/from/to (frozen-field case) or reason
  // (operation-level rejection). Template uses only the always-present keys.
  // Two paths surface this code:
  //   - UNSPONSORED: frozen-field change at EXECUTE.plan / unsponsored
  //     mode=add / mode=replace outside EXECUTE.plan.
  //   - SPONSORED (SC1b, sponsored_by_finding_id present, finding already
  //     verified valid): wrong sub_state (detail.reason=
  //     sponsored_tasks_amended_wrong_sub_state — sponsored amends are
  //     EXECUTE.work-only) OR a frozen-field change that erases / rewrites
  //     execution progress (task status, a retained step's status, a new
  //     step born non-pending, or removal of a progress-bearing step).
  MUTATION_OUT_OF_RIGHTS: {
    exit_code: 2,
    message_template:
      "event:tasks_amended on task {task_id} is not permitted at " +
      "sub_state {sub_state} — §8.6 grants no mutation right for this change",
    fix_template:
      "the mutation rights matrix (protocol.md §8.6) limits EXECUTE.plan " +
      "`tasks amend` to execution[].applicability changes plus a " +
      "status pending→ready advance; graph/kind-flag fields are frozen. " +
      "To restructure the task graph, raise a `finding raise --action " +
      "amend-tasks` back-edge, then run the sponsored `tasks add --finding` " +
      "/ `tasks amend --input --finding` at EXECUTE.work — a sponsored " +
      "amend may change graph/definition fields but never erases execution " +
      "progress (task/step status is frozen)",
    doc_anchor: "protocol.md#§8.6",
  },
  LOCK_TIMEOUT: {
    exit_code: 2,
    message_template:
      "could not acquire .loaf/<feature>/.lock within {timeout_seconds}s",
    fix_template:
      "another loaf process is holding the lock (see LOCK_HELD_BY for " +
      "details); wait for it to release, or run `loaf doctor` to " +
      "unlink the lock if its PID has exited",
    doc_anchor: "protocol.md#§11.2",
  },
  LOCK_HELD_BY: {
    exit_code: 2,
    message_template:
      "lock held by PID {pid} (cmd={cmd}, acquired_at={acquired_at})",
    fix_template:
      "wait for the holder to finish, or if the PID has exited run " +
      "`loaf doctor` to clear the stale lock",
    doc_anchor: "protocol.md#§11.2",
  },
  FEATURE_NOT_FOUND: {
    exit_code: 2,
    message_template:
      "no feature found in the current working directory (.loaf/ is " +
      "empty or missing)",
    fix_template:
      "run `loaf start <description>` to create a new feature, or cd " +
      "into a directory that already has a .loaf/<feature>/ subtree",
    doc_anchor: "protocol.md#§10.3",
  },
  FEATURE_AMBIGUOUS: {
    exit_code: 2,
    message_template:
      "current working directory has {count} features and no dispatch " +
      "context: {feature_list}",
    fix_template:
      "disambiguate with --feature <name>, --session <UUID>, or set " +
      "$LOAF_FEATURE / $LOAF_SESSION in the environment",
    doc_anchor: "protocol.md#§10.3",
  },
  SESSION_CWD_MISMATCH: {
    exit_code: 2,
    message_template:
      "--session {uuid} is registered against cwd={registered_cwd}, " +
      "but the current cwd is {current_cwd}",
    fix_template:
      "cd to the registered cwd before issuing the command, or pass " +
      "a different --session, or drop --session to auto-pick a " +
      "session in the current cwd",
    doc_anchor: "protocol.md#§10.3",
  },
  SESSION_SHORT_AMBIGUOUS: {
    exit_code: 2,
    message_template:
      "--session {prefix} matches {match_count} sessions in the " +
      "registry: {candidate_list}",
    fix_template:
      "pass a longer UUID prefix (≥8 chars are required; use more " +
      "to disambiguate) or pass the full UUID",
    doc_anchor: "protocol.md#§10.3",
  },
  SESSION_NOT_FOUND: {
    // Phase 16 SC-8 (codex r285-r286): --session <UUID> or
    // $LOAF_SESSION specified a UUID/prefix that matches NO entry in
    // ~/.loaf/registry/. Distinct from SESSION_CWD_MISMATCH (entry
    // exists, cwd field differs) and SESSION_SHORT_AMBIGUOUS (prefix
    // matches 2+ entries).
    exit_code: 2,
    message_template:
      "--session {uuid_or_prefix} matches no entry in the registry",
    fix_template:
      "run `loaf sessions list --in-cwd` to see registered sessions " +
      "(future SC-9b), or run `loaf start <name>` to create one",
    doc_anchor: "protocol.md#§10.3",
  },
  // ── prune session GC — `loaf prune restore` (core slice 3; surfaced slice 6b).
  // Static messages (no placeholders): the restore CLI surface builds the
  // detailed, id-specific message at emit time via ctx.failure(code, msg, detail).
  PRUNE_RESTORE_NOT_FOUND: {
    exit_code: 2,
    message_template: "no trashed session matches the given id",
    fix_template: "run `loaf prune --history` to list trashed sessions (slice 6b)",
    doc_anchor: "protocol.md#§10.8",
  },
  PRUNE_RESTORE_AMBIGUOUS: {
    exit_code: 2,
    message_template: "the session id was trashed more than once; pass --at <ts> to pick one",
    fix_template: "re-run `loaf prune restore <id> --at <ts>` with one of the listed timestamps",
    doc_anchor: "protocol.md#§10.8",
  },
  PRUNE_RESTORE_INCOMPLETE: {
    exit_code: 2,
    message_template: "the trash bucket is incomplete (missing a required artifact); not restoring",
    fix_template: "inspect the trash bucket; a complete bucket has manifest.json + registry.json",
    doc_anchor: "protocol.md#§10.8",
  },
  PRUNE_PATH_OCCUPIED: {
    exit_code: 2,
    message_template: "a restore destination already exists; refusing to overwrite",
    fix_template: "move or remove the occupying registry entry / feature dir, then retry restore",
    doc_anchor: "protocol.md#§10.8",
  },
  PRUNE_PARTIAL_FAILURE: {
    // `loaf prune --yes` where some targets errored mid-execute. NOT a success:
    // exit 2 so scripts don't proceed as if prune fully completed. detail carries
    // pruned / skipped / failed for inspection; the audit log records failed too.
    exit_code: 2,
    message_template: "prune partially failed: one or more sessions could not be removed",
    fix_template: "inspect detail.failed; rerun prune for the failed sessions after resolving the error",
    doc_anchor: "protocol.md#§10.8",
  },
  PENDING_BLOCKS_ADVANCE: {
    exit_code: 2,
    message_template:
      "pending head {pending_id} (kind={kind}) blocks `loaf advance` " +
      "until resolved",
    fix_template:
      "resolve the head with the kind-appropriate command: " +
      "`loaf gate decide <G>` for kind=gate_decision; " +
      "`loaf profile escalate --confirm --input <ceremony.json>` for kind=profile_escalation; " +
      "`loaf pending resolve --answer <a>` for the rest",
    doc_anchor: "protocol.md#§10.7",
  },
  GATE_NOT_PENDING: {
    exit_code: 2,
    message_template:
      "`loaf gate decide {gate}` requires pending head kind=gate_decision " +
      "(gate={gate}); current head: {actual_head}",
    fix_template:
      "resolve the current head first via the kind-appropriate command, " +
      "or wait for the gate_decision pending to appear",
    doc_anchor: "protocol.md#§10.7",
  },
  ESCALATION_NOT_PENDING: {
    exit_code: 2,
    message_template:
      "`loaf profile escalate --confirm --input <ceremony.json>` requires pending head " +
      "kind=profile_escalation; current head: {actual_head}",
    fix_template:
      "resolve the current head first via the kind-appropriate command, " +
      "or wait for the profile_escalation pending to appear",
    doc_anchor: "protocol.md#§10.7",
  },
  SETTLE_PHASE_DISABLED: {
    exit_code: 2,
    message_template:
      "VERIFY.accept → SETTLE.reconcile requires ceremony.settle_phase=true " +
      "(deep profile only after rev 5.x); current settle_phase={settle_phase}",
    fix_template:
      "for non-deep profiles (quick / light / standard), advance from VERIFY.accept " +
      "to DONE.delivered via `loaf deliver`; to enter SETTLE, escalate ceremony to deep",
    doc_anchor: "protocol.md#§5.2",
  },
  SETTLE_PHASE_BYPASS: {
    exit_code: 2,
    message_template:
      "VERIFY.accept → DONE.delivered requires ceremony.settle_phase=false " +
      "(quick / light / standard); deep profile must enter SETTLE.reconcile first; " +
      "current settle_phase={settle_phase}",
    fix_template:
      "for deep profile, advance from VERIFY.accept to SETTLE.reconcile via `loaf settle`; " +
      "if SETTLE is not desired, start/continue a standard ceremony flow instead",
    doc_anchor: "protocol.md#§5.2",
  },
  TASK_STATUS_WITHOUT_PROOF: {
    exit_code: 2,
    message_template:
      "task {task_id} status change requires evidence: status={status} " +
      "has no PASSING covering evidence proof in evidence.jsonl",
    fix_template:
      "emit `loaf evidence add` covering task_id={task_id} before " +
      "advancing status (task-evidence is otherwise enforced later at " +
      "verify-min / verify-accept)",
    doc_anchor: "protocol.md#§4.4",
  },
  // ── audit r1-r5 catch-up entries ──
  ACTOR_AUTHORITY_VIOLATION: {
    exit_code: 2,
    message_template: "actor {actor} is not allowed for journal kind {kind}",
    fix_template:
      "use the command surface that owns this kind; human-only kinds require an interactive human actor resolved by LOAF_USER or git user.email",
    doc_anchor: "protocol.md#§10.8",
  },
  FROM_CURSOR_MISMATCH: {
    exit_code: 2,
    message_template:
      "entry payload.from={payload_from} does not match current sub_state={current_sub_state}",
    fix_template:
      "refresh the current session state and emit the transition from the actual cursor; do not replay a stale transition candidate",
    doc_anchor: "protocol.md#§11.2",
  },
  INVALID_ENVELOPE: {
    exit_code: 2,
    message_template: "journal entry failed envelope validation: {reason}",
    fix_template:
      "rebuild the entry through the CLI mutator so seq, entry_id, actor, kind, payload, and batch markers satisfy JournalEntry",
    doc_anchor: "protocol.md#§11.2",
  },
  INVALID_PAYLOAD: {
    exit_code: 2,
    message_template: "payload for kind {kind} failed validation: {reason}",
    fix_template:
      "fix the payload to match the PER_KIND_PAYLOAD schema for this kind and retry the mutator",
    doc_anchor: "protocol.md#§11.2",
  },
  SEQ_NOT_MONOTONIC: {
    exit_code: 2,
    message_template:
      "entry seq {got} does not extend journal tail {tail_seq}; expected {expected}",
    fix_template:
      "refresh tail_seq under the session lock and retry; if the tail is corrupt run `loaf doctor --check-tail`",
    doc_anchor: "protocol.md#§11.2",
  },
  SPEC_PHASE_FORK_VIOLATION: {
    exit_code: 2,
    message_template: "transition {from} → {to} violates ceremony.spec_phase={spec_phase}",
    fix_template:
      "follow the ceremony fork: spec_phase=true traverses SPEC.*, spec_phase=false goes directly to EXECUTE.plan",
    doc_anchor: "protocol.md#§5.2",
  },
  SUB_STATE_AUTHORITY_VIOLATION: {
    exit_code: 2,
    message_template: "kind {kind} is not allowed in sub_state {sub_state}",
    fix_template:
      "advance/back-edge to a sub_state that permits this journal kind, or use the command valid for the current state",
    doc_anchor: "protocol.md#§10.8",
  },
  TRANSITION_ILLEGAL: {
    exit_code: 2,
    message_template: "cannot transition {from} → {to}",
    fix_template:
      "choose one of the allowed forward transitions for the current sub_state, or use an explicit terminal/archive path when supported",
    doc_anchor: "protocol.md#§5.2",
  },
  VERIFY_PHASE_FORK_VIOLATION: {
    exit_code: 2,
    message_template: "transition {from} → {to} violates ceremony.verify_phase={verify_phase}",
    fix_template:
      "follow the ceremony fork: verify_phase=true enters VERIFY.plan, verify_phase=false can deliver after minimal verification",
    doc_anchor: "protocol.md#§5.2",
  },
  ALREADY_STARTED: {
    exit_code: 2,
    message_template: "session bootstrap kind {kind} cannot run after state already exists",
    fix_template:
      "resume the existing session or create a new feature directory instead of starting/migrating over initialized state",
    doc_anchor: "protocol.md#§11.2",
  },
  FINDING_NOT_FOUND: {
    exit_code: 2,
    message_template: "finding close references unknown finding id {id}",
    fix_template:
      "list open findings and close an existing id, or raise the finding before closing it",
    doc_anchor: "protocol.md#§10.8",
  },
  NO_SESSION: {
    exit_code: 2,
    message_template: "journal kind {kind} requires a started session",
    fix_template:
      "run `loaf start` or `loaf doctor --migrate-v2` before emitting non-bootstrap journal entries",
    doc_anchor: "protocol.md#§10.8",
  },
  PENDING_NOT_FOUND: {
    exit_code: 2,
    message_template: "pending resolve failed: {reason}",
    fix_template:
      "resolve the current pending head only; list pending items and retry with the head id",
    doc_anchor: "protocol.md#§10.7",
  },
  REDUCER_NOT_IMPLEMENTED: {
    exit_code: 2,
    message_template: "reducer has no handler for journal kind {kind}",
    fix_template:
      "do not append this kind until REDUCER_IMPLEMENTED_KINDS and reducer.apply both support it",
    doc_anchor: "protocol.md#§11.2",
  },
  ENTRY_OVERSIZE: {
    exit_code: 2,
    message_template: "journal entry serialized to {bytes} bytes; limit is {limit}",
    fix_template:
      "move long text into sidecar form via LongTextField instead of embedding it inline",
    doc_anchor: "protocol.md#§11.2",
  },
  SHORT_WRITE: {
    exit_code: 2,
    message_template: "journal append wrote {wrote} of {want} bytes",
    fix_template:
      "stop writing, preserve the journal, and run `loaf doctor --check-tail` before retrying",
    doc_anchor: "protocol.md#§11.2",
  },
  TAIL_CORRUPTION: {
    exit_code: 2,
    message_template: "journal tail is corrupt: {reason}",
    fix_template:
      "run `loaf doctor --check-tail`; do not append until the tail has been repaired or quarantined",
    doc_anchor: "protocol.md#§10.15",
  },
  MIGRATION_BACKUP_MISSING: {
    exit_code: 2,
    message_template: "migration backup target is unavailable: {backup_dir}",
    fix_template:
      "move or remove the existing backup target, then rerun `loaf doctor --migrate-v2`",
    doc_anchor: "protocol.md#§10.15",
  },
  MIGRATION_INCOMPLETE: {
    exit_code: 2,
    message_template: "migration cannot complete: {reason}",
    fix_template:
      "fix the legacy v0.0.x artifact or restore from backup; rerun migration only after validation passes",
    doc_anchor: "protocol.md#§10.15",
  },
  MIGRATION_REPLAY_ATTEMPT: {
    exit_code: 2,
    message_template: "journal.jsonl already has entries; migration must run on a fresh journal",
    fix_template:
      "do not rerun migration over an initialized journal; inspect the existing journal or start from the original v0.0.x backup",
    doc_anchor: "protocol.md#§10.15",
  },
  MIGRATION_SIDECAR_MISSING: {
    exit_code: 2,
    message_template: "migration sidecar is missing: {artifact}",
    fix_template:
      "restore the missing legacy artifact or sidecar, then rerun migration/doctor verification",
    doc_anchor: "protocol.md#§10.15",
  },
  INVALID_ACTOR_FORMAT: {
    exit_code: 2,
    message_template: "human actor value is invalid: {reason}",
    fix_template:
      "set LOAF_USER to the raw human identifier without a namespace prefix, or unset it to allow interactive git user.email fallback",
    doc_anchor: "protocol.md#§10.8",
  },
  NO_HUMAN_ACTOR: {
    exit_code: 2,
    message_template: "no human actor could be resolved for a human-only command",
    fix_template:
      "run interactively with git user.email configured, or set LOAF_USER explicitly",
    doc_anchor: "protocol.md#§10.8",
  },
  // SPEC_VERSION_NOT_MONOTONIC + SPEC_VERSION_BATCH_MISMATCH catalog
  // entries originally landed here under Slice 1.B sub-cycle 1 with
  // placeholders {expected}/{actual}/{index} and doc_anchor §586.
  // Slice E promoted these to PreflightFailureCode and registered
  // runtime-aligned canonical entries below (look for "Slice E:
  // promoted from reducer message strings"). The duplicate rows
  // were removed during the r100 audit cleanup so the catalog
  // represents a single source of truth that matches the runtime
  // detail keys (kind / payload_spec_version / expected_spec_version
  // / current_spec_version / batch_index).
  DUPLICATE_REQ_ID: {
    exit_code: 2,
    message_template:
      "REQ id {id} is already in the spec projection",
    fix_template:
      "allocate a fresh REQ id under the same id_namespace (the CLI scans for max serial + 1 inside the per-session lock) or `loaf finding raise --category spec-gap --action amend-spec` if you need to retire the existing REQ",
    doc_anchor: "protocol.md#§600",
  },
  DUPLICATE_SCEN_ID: {
    exit_code: 2,
    message_template:
      "SCEN id {id} is already in the spec projection",
    fix_template:
      "allocate a fresh SCEN id under the same id_namespace, or amend via finding mechanism if retiring an existing scenario",
    doc_anchor: "protocol.md#§600",
  },
  DUPLICATE_VIS_ID: {
    exit_code: 2,
    message_template:
      "VIS id {id} is already in the spec projection",
    fix_template:
      "allocate a fresh VIS id under the same id_namespace, or amend via finding mechanism if retiring an existing visual contract",
    doc_anchor: "protocol.md#§600",
  },
  SPEC_FRONTMATTER_INVALID: {
    exit_code: 2,
    // gate context lives on the parent GATE_PRECONDITION_VIOLATION envelope
    // (detail.gate). FailedCheck.detail only carries {subcode, ...read.detail}
    // — no gate or readable detail placeholder, so the template intentionally
    // avoids those vars to stay correctly substituted.
    message_template:
      "spec.md frontmatter failed gate check 1 (subcode={subcode})",
    fix_template:
      "subcode=SPEC_NOT_FOUND: run `loaf spec init` then `loaf spec submit` to seed spec.md; subcode=SPEC_YAML_INVALID: check the `---`-fenced YAML block at the top of spec.md for syntax errors; subcode=SPEC_FRONTMATTER_INVALID: run `loaf spec schema --format=json` to dump the SpecFrontmatter JSON Schema (Phase 16 SC-10) and fix the offending field. Both spec-lock and verify-accept require a valid spec.md at check 1.",
    doc_anchor: "protocol.md#§5.1",
  },
  SPEC_HAS_UNCLARIFIED: {
    exit_code: 2,
    message_template:
      "spec has {count} unresolved needs_clarification entries (ids={ids}); resolve or remove them before spec-lock can pass",
    fix_template:
      "edit spec.md to remove resolved needs_clarification entries, or run `loaf finding raise --category spec-gap --action clarify` to formalize the resolution flow; spec-lock check 2 requires needs_clarification === []",
    doc_anchor: "protocol.md#§5.1",
  },
  TASK_NOT_FOUND: {
    exit_code: 2,
    message_template:
      "task {task_id} is not in the current tasks projection",
    fix_template:
      "run `loaf tasks list` to see live ids; if you meant to add a new task, use `loaf tasks add` instead of amend/step; if you expected the id to exist, the projection may be stale — run `loaf doctor --rebuild` to rebuild from journal",
    doc_anchor: "protocol.md#§10.8",
  },
  TASK_STEP_NOT_FOUND: {
    exit_code: 2,
    message_template:
      "step {step} is not seeded on task {task_id} — seeded steps are derived from the task's kind execution schema (§14)",
    fix_template:
      "use only the per-kind step names — behavioral: red/implement/refactor; structural: implement/refactor; visual-ui: mockup/implement/screenshot-compare; docs: draft/review; spike: explore/prototype/record; chore: execute. Running an unseeded step name was a silent add bug in v0.0.x — sub-cycle 3a fails fast instead",
    doc_anchor: "protocol.md#§10.8",
  },
  DUPLICATE_TASK_ID: {
    exit_code: 2,
    message_template:
      "task id {task_id} appears more than once in tasks_planned payload",
    fix_template:
      "tasks_planned is whole-replacement — each task id must be unique within the batch. Rename one or merge them in the planning input",
    doc_anchor: "protocol.md#§10.8",
  },
  TASKS_NOT_PLANNED: {
    exit_code: 2,
    // FailedCheck.detail is empty for this code in both gate evaluators;
    // gate context lives on parent GATE_PRECONDITION_VIOLATION envelope.
    message_template:
      "gate task-graph check: tasks have not been planned (snapshot.tasks_based_on is null)",
    fix_template:
      "run `loaf tasks submit --input <plan-file>` to emit event:tasks_planned and seed the task graph; spec-lock check 3 and verify-accept check 4 both require tasks_based_on.spec to match the current spec.spec_version",
    doc_anchor: "protocol.md#§5.1",
  },
  TASKS_BASED_ON_STALE: {
    exit_code: 2,
    // FailedCheck.detail has {tasks_based_on_spec, current_spec_version} —
    // gate context lives on parent envelope, not this check detail.
    message_template:
      "gate task-graph check: tasks_based_on.spec={tasks_based_on_spec} but current spec.spec_version={current_spec_version} — the task graph was planned against an older spec",
    fix_template:
      "either re-plan tasks against the current spec via `loaf tasks submit` (whole-replacement), or amend individual tasks via `loaf tasks add/amend` + raise a `loaf finding raise --category spec-gap --action amend-spec` if a spec roll-back is needed. Surfaces for spec-lock (check 3) and verify-accept (check 4 precondition).",
    doc_anchor: "protocol.md#§5.1",
  },
  REQ_NOT_DRIVEN: {
    exit_code: 2,
    message_template:
      "spec-lock check 4: requirement {req_id} is not referenced by any task.drives[]",
    fix_template:
      "add a task whose drives[] array includes {req_id}, or remove the requirement from spec.md if it is no longer in scope. Note: this is the REQ-side coverage code (distinct from legacy DRIVES_NOT_BOUND which named the inverse direction)",
    doc_anchor: "protocol.md#§5.1",
  },
  E2E_SCENARIO_UNBOUND: {
    exit_code: 2,
    message_template:
      "spec-lock check 6: e2e scenario {scenario_id} has no binding task (requires task with requires_acceptance=true AND drives includes {scenario_id})",
    fix_template:
      "either (a) add a task with requires_acceptance=true and drives including {scenario_id}, or (b) mark the scenario with acceptance_na=<reason ≥5 chars> in spec.md if e2e acceptance is intentionally skipped for this iteration",
    doc_anchor: "protocol.md#§5.1",
  },
  VISUAL_CONTRACT_UNBOUND: {
    exit_code: 2,
    message_template:
      "spec-lock check 7: visual_contract {visual_id} has no visual-ui task whose visual_contract_refs includes it",
    fix_template:
      "either (a) add a visual-ui task with visual_contract_refs including {visual_id}, or (b) mark the visual_contract with visual_na=<reason ≥5 chars> in spec.md if visual verification is intentionally deferred",
    doc_anchor: "protocol.md#§5.1",
  },
  TASK_KIND_SCHEMA_VIOLATION: {
    exit_code: 2,
    message_template:
      "spec-lock check 8: task {task_id} (kind={kind}) violates projected kind-specific obligations: {reasons}",
    fix_template:
      "amend the task to satisfy its kind contract: structural/docs/spike/chore require no_test_rationale (string ≥10 chars); visual-ui requires visual_contract_refs[] with ≥1 entry. Most commonly surfaces after migration:snapshot_imported when legacy v0.0.x projections lack the required fields. Slice C R2: bug-task RED is execution discipline, not a spec-lock obligation — a behavioral task with labels=['bug'] is born unregistered, and RED registration is enforced at runtime by BUG_TASK_REQUIRES_RED (preflight, implement step) and BUG_TASK_RED_NOT_REGISTERED (verify-accept), never by this check",
    doc_anchor: "protocol.md#§5.1",
  },
  GATE_PRECONDITION_VIOLATION: {
    exit_code: 2,
    // detail carries {gate, failure_count, checks} from Pass 1.5
    // (src/core/journal-mutate.ts spec-lock + verify-accept branches).
    message_template:
      "gate:decided {gate} approval rejected at the mutate layer: {failure_count} check(s) failed",
    fix_template:
      "this is a mutate-layer envelope around the underlying gate checks (see detail.checks for the list). spec-lock failure codes: MISSING_VERIFIABILITY / REQ_NOT_DRIVEN / E2E_SCENARIO_UNBOUND / VISUAL_CONTRACT_UNBOUND / TASKS_NOT_PLANNED / TASKS_BASED_ON_STALE / TASK_KIND_SCHEMA_VIOLATION / SPEC_HAS_UNCLARIFIED. verify-accept failure codes: VERIFY_LANE_NOT_PASSED / OPEN_FINDINGS_PRESENT / COVERAGE_NOT_SATISFIED / TASK_DONE_NO_EVIDENCE / SPEC_REVIEW_MISSING / SPEC_REVIEW_IMPLEMENTER_CONFLICT / SPEC_REVIEW_IMPLEMENTER_UNKNOWN / TASKS_NOT_PLANNED (precondition) / TASKS_BASED_ON_STALE (precondition). Fix each listed check then retry the gate decision. Pass 1.5 runs after preflight + reducer dry-run + before sidecar promotion, so a rejected gate batch leaves no on-disk residue.",
    doc_anchor: "protocol.md#§5.1",
  },
  MULTIPLE_GATE_DECISIONS: {
    exit_code: 2,
    message_template:
      "batch contains {count} approved gate:decided entries (gate_kinds={gate_kinds}); protocol §10.8 requires one gate decision per atomic operation",
    fix_template:
      "split the batch — emit each gate decision as its own mutation. A batch carrying ≥2 gate approvals (even with different gate_kinds, e.g. spec-lock + verify-accept) is not a valid atomic operation. Rejected gate decisions are not counted; only approvals trigger this rule",
    doc_anchor: "protocol.md#§10.8",
  },
  GATE_NOT_IMPLEMENTED: {
    exit_code: 2,
    // NOTE on placeholder syntax (codex r45 catch): {curly} is mustache-style
    // placeholder syntax (docs/schemas.ts:2821-2822). Avoid literal curly
    // braces in templates; use backticks for inline code instead.
    message_template:
      "gate={gate} is not recognized; protocol GateName enum is closed at `spec-lock` or `verify-accept` for v0.1.0",
    fix_template:
      "use `loaf gate decide spec-lock` or `loaf gate decide verify-accept`. Future gates beyond v0.1.0 would extend the GateName enum in journal-entry.ts + evidence-schema.ts (lockstep) and wire here.",
    doc_anchor: "protocol.md#§10.8",
  },
  VERIFY_LANE_NOT_PASSED: {
    exit_code: 2,
    message_template:
      "verify-accept check 1: applicable VERIFY lane={lane} has no evidence with passing/approved/waived result",
    fix_template:
      "add an evidence:added entry with check={lane} (or a matching kind via the narrow fallback map: local-check/task-summary→run, verify-review/spec-review→review, acceptance→acceptance, visual-review→visual) and result one of `passed`, `approved`, or `waived`. Applicable lanes derive from spec: REQ ⇒ REVIEW, SCEN.tag=e2e ⇒ ACCEPTANCE, VIS ⇒ VISUAL, done task ⇒ RUN+REVIEW.",
    doc_anchor: "protocol.md#§5.2",
  },
  OPEN_FINDINGS_PRESENT: {
    exit_code: 2,
    // FailedCheck.detail provides {count, open_ids} after the sub-cycle 6
    // r45 fix in verify-accept-check.ts (count was previously only embedded
    // in the human message string, not in structured detail).
    message_template:
      "verify-accept check 2: {count} finding(s) still open (ids={open_ids}); resolve or close before verify-accept",
    fix_template:
      "run `loaf finding close <FND-id> --resolution <text>` for each listed finding, OR add evidence + raise a follow-up finding if the gap is real. verify-accept check 2 requires snapshot.findings to have no entries with status=open.",
    doc_anchor: "protocol.md#§5.2",
  },
  COVERAGE_NOT_SATISFIED: {
    exit_code: 2,
    message_template:
      "verify-accept check 3: {covered_id} ({covered_kind}) has no evidence passing canSatisfy() with result `passed`, `approved`, or `waived`",
    fix_template:
      "add evidence:added covering {covered_id} per protocol §5.4: REQ allows task-summary/verify-review/spec-review/manual+reason/waiver+reason; SCEN.tag=e2e allows acceptance/manual+reason/waiver+reason; VIS allows visual-review+attachment/manual+reason/waiver+reason. Result must be passed/approved/waived per §1035.",
    doc_anchor: "protocol.md#§5.2",
  },
  TASK_DONE_NO_EVIDENCE: {
    exit_code: 2,
    message_template:
      "verify-accept check 4: task {task_id} is status=done but has no evidence covering it (kind one of `task-summary`, `local-check`, `manual`, or `waiver`)",
    fix_template:
      "add evidence:added with covers including {task_id} and kind in the T-allowed set. Most commonly: a task-summary written on closing the task; alternatively local-check (test/lint/typecheck run), manual (human attest), or waiver (human waiver with reason ≥10 chars).",
    doc_anchor: "protocol.md#§5.2",
  },
  SPEC_REVIEW_MISSING: {
    exit_code: 2,
    message_template:
      "verify-accept check 5: ceremony.strict_spec_review=true requires ≥1 evidence kind=spec-review with result `passed` or `approved` from an actor ≠ implementer; none found",
    fix_template:
      "have an independent reviewer (not the implementer of done tasks; not a cli:* automation actor) run a spec review and add an evidence:added with kind=spec-review and result `passed` or `approved`. Note: result=waived does NOT count for spec-review (kind=spec-review + result=waived bypasses the human+reason refine guarantee that kind=manual or kind=waiver provides).",
    doc_anchor: "protocol.md#§5.2",
  },
  SPEC_REVIEW_IMPLEMENTER_CONFLICT: {
    exit_code: 2,
    message_template:
      "verify-accept check 5: every passing spec-review actor is in the implementer set; no independent reviewer signed off (actors={spec_review_actors}, implementers={implementers})",
    fix_template:
      "have a non-implementer (someone other than the actors on done-task task-summary/local-check evidence) submit an additional evidence with kind=spec-review and result `passed` or `approved`. One independent reviewer is sufficient — implementer self-reviews can coexist.",
    doc_anchor: "protocol.md#§5.2",
  },
  SPEC_REVIEW_IMPLEMENTER_UNKNOWN: {
    exit_code: 2,
    message_template:
      "verify-accept check 5: cannot establish implementer set (all done-task evidence actors are cli:* automation); strict_spec_review fails closed",
    fix_template:
      "ensure at least one done-task evidence (task-summary or local-check) carries a non-cli:* actor (e.g. human:dev@example.com); the strict_spec_review comparison requires a real implementer identity to compare against. Without it, the gate cannot prove the spec reviewer is independent.",
    doc_anchor: "protocol.md#§5.2",
  },
  // ── Slice 1.D sub-cycle 1 — `loaf deliver` / `loaf settle` preflight ──
  // Wording polish + cross-reference tightening lands in Slice 1.D sub-cycle 4
  // doc sync; entries here keep the typecheck contract honest (codex r50 BLOCK).
  DELIVER_NOT_ACCEPTED: {
    exit_code: 2,
    message_template:
      "deliver requires verify_accepted=true at sub_state={sub_state}; gate approval missing",
    fix_template:
      "run `loaf gate decide verify-accept --approve --reason \"...\"` first; the gate flips snapshot.state.verify_accepted before `loaf deliver` will accept the session:delivered entry",
    doc_anchor: "protocol.md#§5.2",
  },
  DELIVER_SETTLE_PHASE_BYPASS: {
    exit_code: 2,
    message_template:
      "deliver from VERIFY.accept requires ceremony.settle_phase=false (standard); deep ceremony must run `loaf settle` first",
    fix_template:
      "for ceremony.settle_phase=true (deep), run `loaf settle` to enter SETTLE.reconcile, complete reconcile + lessons, then `loaf deliver` from SETTLE.lessons; only standard ceremony delivers directly from VERIFY.accept",
    doc_anchor: "protocol.md#§5.2",
  },
  DELIVER_VERIFY_MIN_UNAVAILABLE: {
    // v0.1.0 fail-closed stub — SUPERSEDED at v0.1.1 by
    // DELIVER_VERIFY_MIN_INCOMPLETE (verify-min landed). No longer emitted
    // at runtime; retained reserved-for-history so old logs/tooling resolve.
    exit_code: 2,
    message_template:
      "verify-min was unavailable in this build (ceremony_label={ceremony_label}) — superseded at v0.1.1 by DELIVER_VERIFY_MIN_INCOMPLETE; this code is no longer emitted",
    fix_template:
      "upgrade to v0.1.1+ where quick / light deliver runs the verify-min per-task evidence check; on failure see DELIVER_VERIFY_MIN_INCOMPLETE",
    doc_anchor: "protocol.md#§3.2",
  },
  DELIVER_VERIFY_MIN_INCOMPLETE: {
    // v0.1.1 — verify-min landed. quick/light `loaf deliver` from
    // EXECUTE.done runs the §3.2 per-task evidence gate; ≥1 done task
    // lacks its required-kind evidence (code→local-check / visual-ui→
    // visual-review|manual / docs→task-summary|manual / chore→local-check|
    // manual|task-summary; waiver always satisfies). detail.tasks lists
    // each missing task + its required kinds.
    exit_code: 2,
    message_template:
      "verify-min: {count} done task(s) lack required evidence to deliver " +
      "(ceremony_label={ceremony_label}); add evidence or waive, then re-deliver",
    fix_template:
      "for each listed task add evidence covering it — code tasks need a " +
      "`local-check` (test/lint/typecheck) run, visual-ui needs " +
      "visual-review or manual, docs needs task-summary or manual — or " +
      "`loaf waive` it; then `loaf deliver` again",
    doc_anchor: "protocol.md#§3.2",
  },
  DELIVER_SPIKE_TASKS: {
    exit_code: 2,
    message_template:
      "cannot deliver: task {task_id} is kind=spike (status={status}); spike tasks block delivery for the entire session",
    fix_template:
      "abandon the spike task (`loaf tasks abandon {task_id} --reason \"...\"`) or convert it to a feature (`loaf spike convert --to-feature F-N --reason \"...\"`); spike tasks must not remain in non-abandoned status when the session delivers",
    doc_anchor: "protocol.md#§703",
  },
  SETTLE_NOT_ACCEPTED: {
    exit_code: 2,
    message_template:
      "VERIFY.accept → SETTLE.reconcile requires verify_accepted=true; gate approval missing",
    fix_template:
      "run `loaf gate decide verify-accept --approve --reason \"...\"` before `loaf settle`; the gate flips snapshot.state.verify_accepted before the transition validator will admit the SETTLE entry",
    doc_anchor: "protocol.md#§5.2",
  },
  SPEC_LOCK_NOT_SATISFIED: {
    exit_code: 2,
    message_template:
      "SPEC.design → EXECUTE.plan requires spec_locked=true; gate approval missing",
    fix_template:
      "run `loaf gate decide spec-lock --approve --reason \"...\"` before `loaf advance EXECUTE.plan`; the gate runs the 8 spec-lock checks and flips snapshot.state.spec_locked before the transition validator will admit the EXECUTE.plan entry",
    doc_anchor: "protocol.md#§5.1",
  },
  // ── Slice 2 SC1 — task lifecycle preflight (codex r56/r57) ──
  TASK_NOT_CLAIMABLE: {
    exit_code: 2,
    message_template:
      "task {task_id} cannot be claimed (status={status} — terminal state)",
    fix_template:
      "tasks with status=done are already complete; status=abandoned tasks cannot be reactivated. Run `loaf tasks list` to inspect the task graph, or `loaf tasks next` to pick a different ready task",
    doc_anchor: "protocol.md#§10.8",
  },
  TASK_ALREADY_CLAIMED: {
    exit_code: 2,
    message_template:
      "task {task_id} is already claimed (status=in_progress); claim is idempotent only for the holding worker",
    fix_template:
      "another worker may already hold this task; run `loaf tasks list` to inspect active claims. Stale-claim release is handled in a future slice (no CLI surface for abandon in v0.1.0 yet) — raise a finding with action=fix-impl if needed",
    doc_anchor: "protocol.md#§10.8",
  },
  TASK_DEP_NOT_FOUND: {
    exit_code: 2,
    message_template: "task {task_id} field {field} references missing task {ref}",
    fix_template:
      "add the referenced task in the same atomic batch, or amend the dependency to an existing task, then retry",
    doc_anchor: "protocol.md#§10.8",
  },
  TASK_DEP_SELF: {
    exit_code: 2,
    message_template: "task {task_id} cannot depend on itself",
    fix_template: "remove the self-reference from depends_on, then retry the task graph mutation",
    doc_anchor: "protocol.md#§10.8",
  },
  TASK_DEP_DUPLICATE: {
    exit_code: 2,
    message_template: "task {task_id} repeats dependency {ref} at indexes {indexes}",
    fix_template: "keep each dependency id only once in depends_on, then retry",
    doc_anchor: "protocol.md#§10.8",
  },
  TASK_DEP_CYCLE: {
    exit_code: 2,
    message_template: "task dependency graph contains cycle {cycle}",
    fix_template: "remove or redirect one dependency in the reported closed path, then retry",
    doc_anchor: "protocol.md#§10.8",
  },
  TASK_DEP_ABANDONED: {
    exit_code: 2,
    message_template: "task {task_id} field {field} references abandoned task {ref}; {hint}",
    fix_template:
      "use an amend-tasks-sponsored task amendment to replace the abandoned dependency, then retry",
    doc_anchor: "protocol.md#§10.8",
  },
  TASK_DEPS_NOT_SATISFIED: {
    exit_code: 2,
    message_template:
      "task {task_id} cannot be claimed: dependency {blocking_dep} is not done (status={blocking_status})",
    fix_template:
      "complete deps_on tasks first (run `loaf tasks list --status pending` to see what is blocking), or use `loaf tasks next` to pick a task with all deps satisfied",
    doc_anchor: "protocol.md#§10.8",
  },
  TASK_NOT_CLAIMED: {
    exit_code: 2,
    message_template:
      "task {task_id} step {step} mutation requires task.status=in_progress (got status={status}); claim the task first",
    fix_template:
      "run `loaf tasks claim {task_id}` to move the task from pending/ready to in_progress before emitting task_step_started or task_step_done; once auto-promoted to done, steps cannot be re-mutated",
    doc_anchor: "protocol.md#§10.8",
  },
  // ── Item 1 — `loaf tasks abandon` preflight (codex r127) ──
  TASK_NOT_ABANDONABLE: {
    // Item 1: preflight step 5e.3 on event:task_abandoned. A task already
    // in a final status (done | abandoned) cannot be abandoned — the
    // operation would be a no-op contract error. detail carries task_id +
    // the offending status.
    exit_code: 2,
    message_template:
      "task {task_id} cannot be abandoned (status={status} — already in a final status)",
    fix_template:
      "tasks with status=done are already complete and status=abandoned tasks are already abandoned; run `loaf tasks list` to inspect the task graph and abandon a non-terminal task instead",
    doc_anchor: "protocol.md#§10.8",
  },
  TASK_ABANDON_BLOCKED_DEPENDENTS: {
    // Item 1: preflight step 5e.3 on event:task_abandoned. Abandoning a
    // task that a non-terminal task depends on would strand the
    // dependent — task_claimed preflight requires deps status=done (not
    // abandoned). detail.blocking_dependents lists the offending task ids.
    exit_code: 2,
    message_template:
      "task {task_id} cannot be abandoned: non-terminal task(s) {blocking_dependents} depend on it",
    fix_template:
      "abandon or complete the dependent tasks first (see detail.blocking_dependents), then retry `loaf tasks abandon {task_id} --reason \"...\"`; abandoning a parent would strand a pending child",
    doc_anchor: "protocol.md#§10.8",
  },
  // ── Item 2 — `loaf archive` / `loaf abandon` preflight (codex r129) ──
  SESSION_REASON_REQUIRED: {
    // Item 2: preflight step 5c.2 on session:archived / session:abandoned.
    // Both kinds share SessionReasonPayload with session:delivered, where
    // reason is optional; archive / abandon require it (protocol §10.8).
    // An empty-string reason fails the payload parse as INVALID_PAYLOAD;
    // this code fires only when the reason key is absent. detail.kind
    // carries the offending session-terminal kind.
    exit_code: 2,
    message_template:
      "{kind}: --reason is required (the session-terminal entry must record why)",
    fix_template:
      "re-run with `--reason \"...\"`; `loaf archive` and `loaf abandon` both require a rationale on the journal entry",
    doc_anchor: "protocol.md#§10.8",
  },
  // Slice A SC-A2: PROJECTION_WRITE_FAILED is surfaced by
  // mutateBatch Pass 5 (post-appendMany) when writeDerivedSpecMd
  // throws. Journal append already succeeded — retrying the same
  // command would hit DUPLICATE_*_ID against the appended event.
  // The fix path is the doctor rebuild (Slice 5 D), NOT a retry.
  // NOTE: this entry exists for protocol/catalog consistency.
  // Today's CLI `emitFailure` (src/cli.tsx:103-123) prints the
  // mutateBatch `message` directly and does not render ERROR_CATALOG;
  // wiring catalog rendering is out of SC-A2 scope (codex r90).
  PROJECTION_WRITE_FAILED: {
    exit_code: 2,
    message_template:
      "{projection} projection write failed after journal append at last_seq={last_seq} (spec_version={spec_version}): {error}",
    fix_template:
      "the journal already records the change; do NOT retry the same command. Run `loaf doctor --rebuild` (when available) to resync derived projections from journal truth, or inspect `.loaf/<feature>/journal.jsonl` tail manually.",
    doc_anchor: "protocol.md#§10.15",
  },
  WRITE_CONTENTION: {
    exit_code: 2,
    message_template:
      "another writer holds the per-feature lock at {lock_path}; retry after it releases",
    fix_template:
      "a concurrent `loaf` invocation is mid-write on this feature — retry once it finishes. If no writer is active, a prior run crashed mid-write: remove the stale `.lock` and run `loaf doctor` to verify journal integrity.",
    doc_anchor: "protocol.md#§11.2",
  },
  // Slice B SC-B1: paired with FINDING_NOT_FOUND when back_edge
  // references a stale / nonexistent finding. cli emitFailure prints
  // mutateBatch.message directly today; catalog rendering wiring is
  // out of slice scope per Slice A SC-A2 r92 NOTE.
  FINDING_AMEND_SPEC_NOT_LOCKED: {
    exit_code: 2,
    message_template:
      "finding raise action=amend-spec requires state.spec_locked=true; spec is not locked at sub_state={current_sub_state}, edit directly via `loaf spec submit / add-*`",
    fix_template:
      "drop --action amend-spec and use `loaf spec submit` / `loaf spec add-req` / etc. directly while spec is unlocked; amend-spec is reserved for post-`gate decide spec-lock --approve` recovery.",
    doc_anchor: "protocol.md#§6.1",
  },
  // Slice E: promoted from reducer message strings under INVALID_PAYLOAD.
  // CLI surfaces these directly now; reducer keeps message-string checks
  // as defense-in-depth for raw apply paths.
  SPEC_VERSION_NOT_MONOTONIC: {
    exit_code: 2,
    message_template:
      "{kind}: spec_version must be {expected_spec_version} (current+1), got {payload_spec_version}",
    fix_template:
      "set spec_version to {expected_spec_version} in the input payload (or omit it and let `loaf spec submit` fill the current+1 default).",
    doc_anchor: "protocol.md#§4.2",
  },
  SPEC_VERSION_BATCH_MISMATCH: {
    exit_code: 2,
    message_template:
      "{kind}: spec_version must be {current_spec_version} at batch_index={batch_index} (continuation must track head), got {payload_spec_version}",
    fix_template:
      "in a multi-entry spec batch, the head (batch_index=0) bumps spec_version to current+1 and all continuation entries (batch_index≥1) must set spec_version to that same value. Check the head entry's payload.spec_version and align companions.",
    doc_anchor: "protocol.md#§4.2",
  },
  // ── Slice C SC-C1 — `loaf tasks complete` NO-OP confirmation ──
  TASK_COMPLETE_PRECONDITION_VIOLATED: {
    exit_code: 2,
    message_template:
      "task {task_id} is not complete (status={status}); must-applicable steps not terminal-positive: {blocking_steps}",
    fix_template:
      "finish each blocking step via `loaf tasks step start/done`; a task auto-promotes to status=done once every must-applicable step is passed/waived/na, and `loaf tasks complete` then confirms it. Run `loaf tasks list` to inspect step status.",
    doc_anchor: "protocol.md#§10.8",
  },
  // ── Slice C SC-C2c — `loaf tasks amend` canonical body recovery ──
  CANONICAL_TASK_BODY_UNAVAILABLE: {
    exit_code: 2,
    message_template:
      "task {task_id} is in the projection but has no canonical body in the journal (migration-imported); a whole-task amend cannot be reconstructed",
    fix_template:
      "the task was rehydrated from a v0.0.x migration snapshot, so its full body never landed as a journal tasks_planned/tasks_amended entry. Re-plan the task graph via `loaf tasks submit`, or wait for the history-aware doctor path that will reconstruct migrated task bodies.",
    doc_anchor: "protocol.md#§10.8",
  },
  // ── Slice C SC-C4 — bug-task RED registration (R2 invariant relocation) ──
  BUG_TASK_REQUIRES_RED: {
    exit_code: 2,
    message_template:
      "behavioral bug task {task_id} cannot start or complete its implement step before its RED test is registered",
    fix_template:
      "run `loaf tasks register-red {task_id}` once the failing RED test is in place; protocol §9.3 requires RED registration before the implement step of a behavioral task labelled `bug`.",
    doc_anchor: "protocol.md#§9.3",
  },
  BUG_TASK_FLAG_MISUSE: {
    exit_code: 2,
    message_template:
      "task {task_id}: red_test_registered=true is valid only on a red-step task_step_done for a behavioral bug task (passed/waived result) — not on this entry",
    fix_template:
      "do not set red_test_registered in a planned task or on a non-red step; the flag is owned by `loaf tasks register-red`, which the reducer promotes to task-level registration.",
    doc_anchor: "protocol.md#§9.3",
  },
  BUG_TASK_RED_NOT_REGISTERED: {
    exit_code: 2,
    message_template:
      "behavioral bug task {task_id} is done but never registered its RED test (red_test_registered≠true)",
    fix_template:
      "a done behavioral bug task must have registered its RED test via `loaf tasks register-red`; this is a verify-accept defense-in-depth check for migration / raw-API journals — rebuild the journal or register RED retroactively before re-running the gate.",
    doc_anchor: "protocol.md#§9.3",
  },
  SPIKE_CONVERT_NO_SPIKE_TASK: {
    exit_code: 2,
    message_template:
      "cannot convert: the session has no non-abandoned spike task; `loaf spike convert` is a spike-task exit (protocol §8.3)",
    fix_template:
      "run `loaf spike convert` only from a session that holds a kind=spike task; for a non-spike session close it with `loaf archive --reason \"...\"` or `loaf abandon --reason \"...\"`",
    doc_anchor: "protocol.md#§8.3",
  },
  // ── Phase 15 SC3 — projection-loader (reader fast-check goes live) ──
  // Single code, 9-reason family (detail.reason discriminates):
  //   journal_missing | journal_empty | tail_offset_mismatch |
  //   tail_hash_mismatch | trailing_partial_line | meta_missing |
  //   meta_invalid (cause: json_parse | schema) | projection_missing |
  //   projection_invalid (cause: json_parse | schema)
  // Loader-added envelope: detail.feature_dir, detail.fix. Reader-derived
  // detail mirrors snapshot-reader.ts (tail_offset / line_hash / etc.).
  // Loader-added per-reason context: meta_path (meta_*), projection_kind +
  // projection_path (projection_*), cause (meta_invalid + projection_invalid).
  SNAPSHOT_STALE_REBUILD_REQUIRED: {
    exit_code: 2,
    message_template: "snapshot stale (reason={reason}): {fix}",
    fix_template:
      "snapshot meta/leaves no longer agree with the journal tail; run `loaf doctor --rebuild --feature <feature>` to re-serialize from journal truth, then retry. Inspect detail.reason + reason-specific fields (meta_path / projection_kind / cause) to triage corruption source before rebuilding.",
    doc_anchor: "protocol.md#§10.15",
  },
  // ── Phase 16 SC-1 — CLI catalog hygiene (codex r187 BLOCKER 4 closure) ──
  // Generic, placeholder-free wording per codex r193 PATCH 3: src/cli.tsx
  // emits these via fail() / failRebuild() / emitFailure() with literal
  // message strings — ERROR_CATALOG is not the runtime renderer for these
  // paths yet, so introducing placeholders ({mode}, {feature}, {detail})
  // would create undefined-substitution drift. Structured detail rendering
  // is SC-2 work; keep these templates generic now and tighten later.
  INVALID_PRESET: {
    exit_code: 2,
    message_template: "invalid ceremony preset",
    fix_template: "Use one of quick, light, standard, or deep.",
    doc_anchor: "protocol.md#§10.5",
  },
  USAGE: {
    exit_code: 2,
    message_template: "invalid CLI usage",
    fix_template:
      "Run the command with --help and retry with the required flags/arguments.",
    doc_anchor: "protocol.md#§10.5",
  },
  DOCTOR_MODE_NOT_IMPLEMENTED: {
    exit_code: 2,
    message_template:
      "requested loaf doctor mode is not implemented in this release",
    fix_template:
      "Use loaf doctor --rebuild --feature <name>; other doctor modes are deferred.",
    doc_anchor: "protocol.md#§10.15",
  },
  DOCTOR_FEATURE_REQUIRED: {
    exit_code: 2,
    message_template: "loaf doctor --rebuild requires --feature <name>",
    fix_template:
      "Pass --feature <name> or --feature-dir <path> for the session to rebuild.",
    doc_anchor: "protocol.md#§10.15",
  },
  DOCTOR_REBUILD_FAILED: {
    exit_code: 2,
    message_template: "doctor --rebuild failed",
    fix_template:
      "Inspect the emitted error message; fix the journal/projection issue, then rerun doctor --rebuild.",
    doc_anchor: "protocol.md#§10.15",
  },
  DOCTOR_REBUILD_MIGRATED_UNSUPPORTED: {
    exit_code: 2,
    message_template:
      "doctor --rebuild does not support v0.0.x-migrated journals in this release",
    fix_template:
      "Use the existing migrated snapshots, or wait for migrate-v2/rebuild support.",
    doc_anchor: "protocol.md#§10.15",
  },
  REDUCER_ERROR: {
    exit_code: 2,
    message_template: "internal reducer invariant failed",
    fix_template:
      "Preserve the journal and command stderr; this indicates a loaf-cli bug or inconsistent projection state.",
    doc_anchor: "protocol.md#§10.5",
  },
} as const;
