// Canonical CONCURRENCY_INVARIANTS contract owner.

import { DEFAULT_FEATURE_WRITE_LEASE_TIMEOUT_MS } from "./feature-write-lease.js";
import {
  MUTATION_COMMIT_STATES,
  POST_APPEND_COMMIT_FAILURE_CODES,
} from "./journal-mutate.js";

export const CONCURRENCY_INVARIANTS = {
  // 1. Single writer rule (rev 5.0 reanchored)
  //    Every artifact under .loaf/<feature>/ AND under
  //    ~/.loaf/registry/<id>.json is written ONLY by loaf-cli.
  //    skill / sub-agent / $EDITOR / external script MUST NOT
  //    directly write either canonical-truth or derived-projection
  //    files. The four authority layers (protocol.md §13.1, rev 5.0):
  //      Canonical truth     journal.jsonl + attachments/<entry_id>/** +
  //                          loaf.config.json (project-level config;
  //                          non-journal but same single-writer rule)
  //      Derived projection  snapshots/*.json (state / tasks / evidence /
  //                          findings / pending / reconcile /
  //                          gate-diagnostic / resume-pack / _meta) +
  //                          spec.md (post-submit) + lessons.md +
  //                          ~/.loaf/registry/<id>.json + spec-draft-context.md
  //      Debug-trace         trace.jsonl / ~/.loaf/crashes/*.json
  //      Advisory            `loaf deliver` stdout / `loaf status` stdout
  //    single_writer applies to all four layers; gate authority
  //    distinction is §13.1's concern, not this rule's.
  //    Exception: spec.md MAY be edited by the CLI-owned `spec edit --input`
  //    body replacement, by $EDITOR, or by a human between `loaf spec edit`
  //    and `loaf spec submit` (SPEC.* sub_states
  //    only); diff-guard catches out-of-window writes. Note that
  //    rev 4.3 `spec add-*` commands replace this $EDITOR loop for
  //    incremental writes — they go through loaf-cli under lock and
  //    emit `event:spec_*_added` journal entries.
  single_writer: true,

  // 2. Lock file path
  //    Per-feature, NOT per-artifact. One feature, one writer at
  //    a time. Implements POSIX flock (or equivalent).
  lock_path: ".loaf/<feature>/.lock",
  lock_payload: "strict {pid, acquired_at, operation, owner}; mode 0600",
  lock_recovery:
    "bounded wait; live PID never stolen; dead PID reclaimed only after generation revalidation; malformed state fails closed; release unlinks only its owner token",
  lock_order:
    "when EXECUTE closure needs both locks: session-runtime lock first, feature write lease second; no feature-then-runtime edge",
  feature_write_lease: {
    timeout_ms: DEFAULT_FEATURE_WRITE_LEASE_TIMEOUT_MS,
    malformed_owner: "fail-closed",
    release_fence: "owner-token",
  },
  mutation_outcomes: {
    states: MUTATION_COMMIT_STATES,
    pre_append_failure: "not-committed",
    dry_run_success: "not-committed",
    post_append_failure: "committed",
    post_append_failure_codes: POST_APPEND_COMMIT_FAILURE_CODES,
  },

  // 3. Journal mutation transaction order (rev 5.0, 10-step;
  //    mirror ADR-0005 §3.5 + protocol.md §11.2)
  //    Every loaf-cli mutator command runs these 10 steps in order
  //    under the lock. Failure before step 6 is not committed. Once step 6
  //    appends, the journal is the durable fact: a later projection failure
  //    returns commit_state=committed and requires rebuild/reload recovery.
  //    Step 4 can leave an orphan sidecar on operational failure; the journal
  //    still remains uncommitted and the orphan is recoverable garbage.
  transaction_order: [
    "1. acquire .lock (blocking, ≤30s; on timeout exit 2 LOCK_TIMEOUT)",
    "2. read journal.jsonl tail + snapshots/_meta.json; verify _meta fast-check (last_applied_seq + last_entry_offset + last_entry_line_hash); on mismatch release lock + exit 2 SNAPSHOT_STALE_REBUILD_REQUIRED",
    "3. preflight validate (candidate entries WITHOUT final sidecar refs): CLI inject actor; Zod parse; cross-kind / sub_state / mutation_rights / actor refine; dry-run reducer apply on in-memory state copy; assign batch_id + batch_index / batch_count if batch; abort with exit 2 + error code on any candidate failure (no step 4+ I/O)",
    "4. prepare sidecar files (if LongTextField > sidecar_threshold_kb, or migration:* manifest refs): write attachments/<entry_id>/<field>.<ext>.tmp-<random>; fsync file + parent dir; atomic rename → final path; compute sha256; write entry payload AttachmentRef.{path,sha256,size}",
    "5. final validate (Gate #2; append guard): re-Zod-parse entries with embedded final AttachmentRef; byte-size check (each entry ≤ entry_byte_limit_kb; batch total ≤ entry_byte_limit_kb); final dry-run reducer apply; compare reducer-visible state transition result + emitted projections vs step 3d outcome (NOT byte-for-byte payload); diff → abort + log SIDECAR_VALIDATION_DRIFT + clean sidecar tmp; batch failure aborts whole batch with zero journal change",
    "6. append journal entry/batch (Gate #2 invariant: ONLY the step-5 validated final-form entry may be appended; no re-serialization, no recompute of AttachmentRef, no edit to validated fields): single write() with all entries newline-separated, total size ≤ entry_byte_limit_kb; fsync journal.jsonl",
    "7. post-apply assert (corruption check, NOT a rollback point): reducer apply final entries to in-memory state; on apply throw → log + flag corruption in `loaf doctor` (sidecar-validation-drift); journal is the fact, no rollback",
    "8. rebuild affected snapshots (tmp+atomic rename per file): write snapshots/<file>.json.tmp-<random>; fsync + atomic rename; update snapshots/_meta.json (last_applied_seq, last_entry_offset, last_entry_line_hash, rolling_checksum extend)",
    "9. refresh registry projection (~/.loaf/registry/<id>.json, tmp+rename)",
    "10. release .lock (unlink + close)",
  ],

  // 3a. Dry-run transaction order (rev 5.0; 10-step mirror with append + projection skipped)
  //     Runs steps 1-5 to fully validate the mutation, then aborts:
  //     unlink any .tmp-* sidecar (step 4 byproduct) and release the
  //     lock. No journal entry is appended; no snapshot is touched;
  //     EV-id / PEND-id monotonic counters are NOT incremented. stdout
  //     prints a "would do" summary (JSON or text per --format),
  //     including would-be EV-id / PEND-id ranges and the set of
  //     validation diagnostics that would have applied. exit 0 =
  //     mutation would succeed; exit 2 = would fail.
  dry_run_transaction_order: [
    "1. acquire .lock (same as live run)",
    "2. verify the loaded meta still matches the journal tail under the lease",
    "3. preflight validate (same as live run)",
    "4. SKIPPED — no sidecar materialization",
    "5. SKIPPED — no promoted-form validation",
    "6. SKIPPED — no journal append",
    "7. SKIPPED — no post-apply assert",
    "8. SKIPPED — no snapshot rebuild",
    "9. SKIPPED — no registry refresh",
    "10. release the owner-fenced lease",
  ],

  // 3b. Dry-run applicability
  //     Read-only commands MUST reject --dry-run with exit 2
  //     (--dry-run not applicable). The deterministic `spec edit --input`
  //     lane is a normal mutator and supports dry-run. Wrapping commands ($EDITOR /
  //     fullscreen TUI) MUST reject. See protocol.md §10.7
  //     "--dry-run 契约" table for the complete partition.
  dry_run_rejects_read_only: true,

  // 3c. Batch transaction order (rev 5.0; alias of transaction_order)
  //     In rev 5.0 the 10-step path IS the batch path. A single mutator
  //     emits 1..N entries inside one lock window; the batch markers
  //     (batch_id / batch_index / batch_count) appear when N ≥ 2 and are
  //     absent when N = 1. There is no separate single-entry path.
  batch_transaction_order:
    "see transaction_order; rev 5.0 unifies single-entry and batch paths under the 10-step transaction (batch markers present when ≥2 entries)",

  // 3d. Batch disciplines (rev 4.3 + rev 5.0 entry semantics)
  //     Three rules the batch path MUST honor:
  //       1a. all-or-nothing — Zod-validate every entry in memory at step 3
  //           (preflight) AND step 5 (final validate); first failure aborts
  //           the whole batch with zero journal append.
  //       1b. one journal append = one transaction = one spec_version bump
  //           (for spec_*_added kinds) — readers never see a spec_version
  //           pointing at half-allocated ids.
  //       1c. atomic id allocation — id range (EV / PEND / T / REQ / SCEN /
  //           VIS serial) reserved at step 3e inside the lock; allocator
  //           commits only after step 6 journal append succeeds.
  //     See protocol.md §11.2 "Batch transaction 三纪律" + Tier 1 mutator
  //     family discussion in §10.8.
  batch_disciplines: {
    "1a_all_or_nothing":
      "preflight (step 3) AND final validate (step 5) both run on full batch; first failure aborts with 0 journal change",
    "1b_one_append_one_bump":
      "one transaction = one journal append = one spec_version bump (for spec_*_added kinds)",
    "1c_atomic_id_allocation":
      "EV / PEND / T / REQ / SCEN / VIS serial ranges reserved in one allocator step (step 3e) inside the lock",
  },

  // 4. Lock acquisition timeout (seconds)
  lock_timeout_seconds: DEFAULT_FEATURE_WRITE_LEASE_TIMEOUT_MS / 1_000,

  // 5. Stale lock detection
  //    A contending writer reclaims a dead owner only after revalidating the
  //    observed generation. A live owner is never stolen.
  stale_lock_recovery: "next writer revalidates and reclaims a dead owner generation",

  // 6. SIGINT (Ctrl-C) policy
  //    First Ctrl-C: cleanup hook runs, releases lock, exits 130.
  //    Second Ctrl-C: skip cleanup, exit 130 immediately. Stale
  //    .tmp-* sidecar and possibly .lock left behind. The next writer can
  //    reclaim a dead lease generation; sidecar cleanup remains separate.
  sigint_policy: "first-ctrl-c=cleanup; second-ctrl-c=skip; dead lease reclaimed by next writer",

  // 7. Atomic multi-entry batches (rev 5.0; reframed from
  //    atomic_multi_artifact_commands)
  //    Some commands MUST emit multiple journal entries in one
  //    transaction. The 10-step path makes this a multi-entry batch
  //    in one lock window, NOT a multi-file write. Snapshot rebuild
  //    (step 8) produces the consistent derived-projection set.
  atomic_multi_entry_batches: [
    // (cmd, journal entry kinds emitted, why atomic)
    {
      cmd: "loaf tasks step done",
      emits: ["event:task_step_done", "evidence:added (if --evidence-* flag)"],
      why:
        "optional task evidence co-emits atomically when --evidence-* is supplied;" +
        " plain step-done may remain single-entry, passing task evidence is enforced later at verify-min / verify-accept, and future loaf tasks check (F-023) owns TASK_STATUS_WITHOUT_PROOF consistency diagnostics",
    },
    {
      cmd: "loaf finding raise --action <X>",
      emits: [
        "finding:raised",
        "event:task_step_reset (fix-impl/fix-test — resets the repair step)",
        "event:phase_advanced (if back-edge transition + iteration bump)",
      ],
      why: "back-edge transition + step reset must land atomically (otherwise iteration count and execution state diverge across the batch boundary)",
    },
    {
      cmd: "loaf gate decide <G>",
      emits: ["gate:decided", "pending:resolved (head)"],
      why: "gate approval pops the pending head + records the gate decision; both entries land in one batch so readers never see a half-resolved gate",
    },
    {
      cmd: "loaf spec submit --input <src>",
      emits: [
        "event:spec_submitted (batch_index=0)",
        "event:spec_req_added × N (batch_index=1..)",
        "event:spec_scenario_added × M",
        "event:spec_visual_added × K",
      ],
      why: "Slice 1.B sub-cycle 1: whole-replacement submit emits ONE atomic batch sharing batch_id + spec_version. spec_submitted at batch_index=0 carries header (feature/intent/adr_refs/needs_clarification) AND resets reducer projection arrays; companion add-* entries repopulate within the same batch so journal is replay-complete (codex r17 canonical-truth invariant). Phase 16 SC-4a: --input <src> source-discriminator (stdin/-, inline JSON, file path; §10.7); payload is whole-replacement single object only (NOT batch-capable — that's why this row's atomic batch is INTERNAL to one submit invocation, not caller-supplied array)",
    },
    {
      cmd: "loaf pending raise (skill / hook / sub-agent path)",
      emits: ["pending:added"],
      why: "single-entry mutator; registry projection refresh runs in step 9 of the same transaction so TUI reflects the new head atomically",
    },
    {
      cmd: "loaf pending resolve",
      emits: [
        "pending:resolved",
        "evidence:added (if resolution carries proof; e.g. gate_decision via `loaf gate decide` co-emits gate:decided in same batch)",
      ],
      why: "FIFO pop is one entry; gate-resolution co-emits its evidence inside the same batch — no half-resolved state observable",
    },
    {
      cmd: "loaf spec add-req --input (single or batch)",
      emits: ["event:spec_req_added (one per input item; batch markers when ≥2)"],
      why: "ADR-0004 A5+A10 + ADR-0005 §3.2 batch markers: id_namespace → full REQ id composition + per-entry final validate land together so readers never see a spec_version pointing at unallocated ids",
    },
    {
      cmd: "loaf spec add-scenario --input (single or batch)",
      emits: ["event:spec_scenario_added (one per input item; batch markers when ≥2)"],
      why: "same family as spec add-req; SCEN namespace allocator + per-entry validate atomically",
    },
    {
      cmd: "loaf spec add-visual --input (single or batch)",
      emits: ["event:spec_visual_added (one per input item; batch markers when ≥2)"],
      why: "same family as spec add-req; VIS namespace allocator + per-entry validate atomically",
    },
    {
      cmd: "loaf tasks add --input (single or batch)",
      emits: [
        "event:tasks_amended mode=add + sponsored_by_finding_id (EXECUTE.work, via --finding) OR event:tasks_planned whole-graph (SPEC.design)",
      ],
      why: "ADR-0004 A5+A10: T-id range allocation + tasks projection rebuild + state pointer agreement must land together in one batch. Phase 11 Item 3 SC1b: the EXECUTE.work add is the sponsored path — each added task is one event:tasks_amended mode=add carrying sponsored_by_finding_id (the amend-tasks finding that authorizes the post-back-edge graph mutation)",
    },
    {
      cmd: "loaf evidence add --input (single or batch)",
      emits: [
        "evidence:added (one per input item; batch markers when ≥2; each entry carries AttachmentRef for attachments)",
      ],
      why: "ADR-0004 A6 + ADR-0005 §3.5 step 4-5: attachment sidecar finalize + final validate ensure no entry references an attachment that did not land on disk (no orphan attachments)",
    },
    {
      cmd: "loaf doctor --migrate-v2",
      emits: [
        "migration:snapshot_imported (single entry at seq=0; payload is .strict() manifest with AttachmentRef ONLY — Gate #3)",
      ],
      why: "ADR-0005 §5.2 + Gate #3: legacy v0.0.x N-file artifacts are externalized as sidecars under attachments/JE-000000/migration/; the journal entry payload itself rejects inline artifact content via .strict() Zod refine",
    },
  ],

  // 7a. Entry byte limit
  //     Hard ceiling per journal entry. LongTextField over
  //     sidecar_threshold_kb MUST be promoted to sidecar form at step 4.
  //     Batch total also bounded — the wire-format constraint is on the
  //     single newline-separated write() call.
  entry_byte_limit_kb: 64,

  // 7b. Sidecar threshold
  //     LongTextField with serialized text length over this threshold
  //     MUST be externalized to `attachments/<entry_id>/<field>.<ext>`
  //     during step 4 of the transaction. Below this, the field stays
  //     inline (`{ mode: "inline", text: ... }`).
  sidecar_threshold_kb: 8,

  // 7c. Monotonic invariants (rev 5.0, ADR-0005 §4.11)
  //     `seq` increments strictly by 1 per entry. `at` is wall-clock
  //     ISO 8601 and monotonic non-decreasing (`at[n] >= at[n-1]`); a
  //     clock-skew event that would write at[n] < at[n-1] is clamped
  //     to at[n-1] (NOT rewritten — reducer accepts equal timestamps).
  //     `batch_index` runs 0..batch_count-1 contiguously per batch_id.
  monotonic_invariants: {
    seq: "strictly +1 per entry; no gaps",
    at: "monotonic non-decreasing; clock-skew clamped to prev `at`, not rewritten",
    batch_index: "0..batch_count-1 contiguous per batch_id",
  },

  // 7d. Batch-aware tail recovery (Gate #4, ADR-0005 §4.13)
  //     Doctor startup tail recovery MUST operate on batch boundaries.
  //     A single-entry partial truncates that one line. A batch with
  //     `batch_index < batch_count - 1` at the tail (or last batch entry
  //     partial) truncates the ENTIRE batch back to the pre-batch offset.
  //     Never partial-commit a batch.
  batch_aware_tail_recovery: {
    single_partial:
      "truncate the partial line to the last good newline; reapply step 8 snapshot rebuild from last_applied_seq",
    batch_incomplete:
      "truncate the entire batch to its pre-batch byte offset; reapply step 8 snapshot rebuild from last_applied_seq",
    rule: "scan last batch_id backward; if last batch_index < batch_count - 1 OR last entry parse-fails → batch_incomplete branch",
  },

  // 7e. Orphan-attachment GC (rev 5.0, ADR-0005 §3.5 step 4d/5 crash window)
  //     `loaf doctor --fix` scans `attachments/<entry_id>/**` and deletes
  //     any directory with no matching journal entry_id, OR any file whose
  //     path is not referenced by an AttachmentRef in the matching entry's
  //     payload. Writes a `local-check` evidence row (audit trail).
  orphan_attachment_gc:
    "scan attachments/ vs journal AttachmentRef set; delete orphans; log via local-check evidence",

  // 7f. Checksum levels (rev 5.0, ADR-0005 §3.1 / §4.15)
  //     Two-tier integrity. Fast check is reader contract (Gate #5);
  //     full chain is explicit `loaf doctor --verify-checksum` operation.
  checksum_levels: {
    fast: "O(1); reader verifies last_entry_offset + last_entry_line_hash on every snapshot read; mismatch → exit 2 SNAPSHOT_STALE_REBUILD_REQUIRED (no silent fallback)",
    full: "O(N); `loaf doctor --verify-checksum` recomputes rolling_checksum chain from seq=0 and compares against snapshots/_meta.json — detects mid-stream corruption that fast check cannot catch",
  },

  // 7g. Step 5 final-validate contract (Gate #2 reinforced, ADR-0005 §4.21)
  //     Step 5 is the LAST chance to abort before the journal becomes a
  //     permanent fact. It re-runs Zod parse + reducer dry-run with the
  //     embedded final AttachmentRef. Step 3 preflight ran with placeholder
  //     refs, so step 5 is not redundant — it catches sidecar-pipeline
  //     bugs that would otherwise leak past preflight.
  step_5_final_validate: {
    compare_scope:
      "reducer-visible state transition result + emitted projections (NOT byte-for-byte payload — sidecar ref injection produces a legitimate payload diff)",
    failure_label:
      "SIDECAR_VALIDATION_DRIFT (implementation bug indicator; abort transaction, clean sidecar tmp, no journal change)",
    batch_behavior: "any one entry failing aborts the WHOLE batch",
  },

  // 7h. Final-entry-only append (Gate #2 primary, ADR-0005 §10)
  //     Step 6 must write the SAME entry object that step 5 validated.
  //     No re-serialization, no recompute of AttachmentRef, no edit to
  //     validated fields. The append layer is intentionally dumb — all
  //     intelligence lives in steps 3-5.
  final_entry_only_append: "step 6 must write the step-5-validated entry object verbatim",

  // 7i. Migration sidecar manifest-only (Gate #3, ADR-0005 §10)
  //     The `migration:snapshot_imported` payload Zod schema MUST be
  //     `.strict()` and accept ONLY AttachmentRef manifest fields. Any
  //     inline artifact content (e.g. inline state.json body) is rejected
  //     at schema layer, not at reducer.
  migration_sidecar_only:
    "migration:snapshot_imported payload is .strict() Zod with AttachmentRef-only fields; inline artifact content rejected at Zod parse",

  // 7j. Snapshot read fail-fast (Gate #5, ADR-0005 §3.6)
  //     CLI read commands that consume snapshots/*.json MUST verify
  //     snapshots/_meta.json fast-check before parsing the snapshot.
  //     Mismatch → exit 2 SNAPSHOT_STALE_REBUILD_REQUIRED, stderr names
  //     `loaf doctor --rebuild`. No silent fallback to cached snapshot.
  //     **Implementation status (Phase 15 SC3)**: this is the eventual
  //     contract for every read command, but the current binary only wires
  //     five — `loaf status` / `loaf next` / `tasks list` /
  //     `pending list` / `finding list` — through
  //     `src/core/projection-loader.ts` (M0-anchored double fast-check).
  //     Other read commands (`tasks check` / `tasks next` /
  //     `verify status` / `pending status` / `sessions list` /
  //     `<artifact> schema` / etc.) still run on `loadSession` full
  //     journal replay and will migrate in subsequent slices.
  snapshot_read_fail_fast:
    "Phase 15 SC3 — 5 commands (status / next / tasks list / pending list / finding list) verify _meta fast-check via projection-loader (M0-anchored double check); mismatch → exit 2 SNAPSHOT_STALE_REBUILD_REQUIRED + structured stderr; no silent cached-snapshot output. Other read commands still on loadSession replay.",

  // 7k. validateTransition shared helper (Gate #1, ADR-0005 §10)
  //     `event:phase_advanced` and `gate:decided` MUST call the same
  //     transition validator in src/core/reducer/transition.ts. No per-kind
  //     if/else fork outside this helper. The helper signature is:
  //       validateTransition(prevSubState, targetSubState,
  //                          { ceremony, gate_kind?, actor }) → Result<void, TransitionError>
  validate_transition_helper:
    "event:phase_advanced and gate:decided share src/core/reducer/transition.ts; no per-kind transition fork",

  // 7l. Doctor sub-flags (rev 5.0, ADR-0005 §5.4 / protocol.md §10.15)
  //     The 5 surface flags that gate the rev 5.0 recovery operations.
  //     CLI parser MUST accept these on `loaf doctor` only; combining
  //     with --fix is allowed where applicable.
  //     Implementation status (Phase 14 / 1d6e1d1): the shipped CLI
  //     accepts only `--rebuild` (+ `--feature` / `--feature-dir`);
  //     `--check-tail` / `--migrate-v2` / `--scope cwd` /
  //     `--verify-checksum` are deferred. The map below stays the design
  //     target.
  doctor_sub_flags: {
    "--rebuild": "full replay from seq=0; rewrites snapshots/* and snapshots/_meta.json",
    "--check-tail":
      "run batch-aware tail recovery only; no snapshot rebuild unless tail truncated past last_applied_seq",
    "--migrate-v2": "v0.0.x N-file → v0.1.0 sidecar import per MIGRATION_V1_TO_V2_BOUNDARY (§0c)",
    "--scope cwd":
      "iterate all .loaf/<feature>/ under cwd; enforces mixed-version-cwd refusal (refuse if any feature is at schema_version != current)",
    "--verify-checksum":
      "full chain rolling_checksum recompute (O(N)); reports mid-stream corruption",
  },

  // 8. EV-id allocation
  //    CLI assigns evidence_id (monotonic per feature) inside the
  //    lock window. `loaf evidence add` MUST reject `--id` flag.
  //    See EvidenceAddInput.
  evidence_id_allocation: "cli-only, monotonic per feature, allocated under lock",

  // 8a. PEND-id allocation (rev 4.1)
  //     Same discipline as EV-id. CLI assigns PendingId (monotonic per
  //     feature) when appending to state.pending[] queue. `loaf pending
  //     raise` and internal hook paths MUST NOT accept --id; the
  //     allocator runs inside the same lock window as the queue append.
  pending_id_allocation: "cli-only, monotonic per feature, allocated under lock",

  // 8b. Pending FIFO discipline (rev 4.1)
  //     `loaf pending resolve` always pops state.pending[0]. v1.0 does
  //     NOT support --id PEND-N skip; the head is the only resolvable
  //     position. Out-of-order resolve is a v1.x consideration; the
  //     current use cases (gate_decision / profile_escalation /
  //     spec_clarification / finding_decision / ask_user_question) all
  //     have either "no" or "yes" semantics that compose with FIFO.
  pending_fifo_discipline: "strict; resolve pops head; no --id skip in v1.0",

  // 8c. Protocol-level pending-blocking invariant (rev 4.1 Q3 minimal)
  //     CLI enforces EXACTLY ONE pending-blocking rule:
  //
  //       `loaf advance` exits 2 PENDING_BLOCKS_ADVANCE if
  //       state.pending[0].kind ∈ advance_blocks_when_pending_head_kind
  //
  //     This is state-machine integrity (cannot advance past unresolved
  //     gate or escalation). Corollaries (same invariant, different
  //     commands):
  //       - `loaf gate decide <G>`: head must be gate_decision(<G>),
  //         else GATE_NOT_PENDING. The command itself resolves the
  //         head; CLI pops pending + writes gate-decision evidence +
  //         advances state atomically in one lock window.
  //       - `loaf profile escalate --confirm --input <ceremony.json>`: head must be
  //         profile_escalation, else ESCALATION_NOT_PENDING. Same
  //         atomic semantics.
  //
  //     All OTHER commands in the surface have NO protocol-level
  //     pending blocking. Append-only mutators (evidence add / tasks
  //     step done / tasks claim / lessons add / pending raise / the
  //     rev 4.3 Tier 1 mutators spec add-* / tasks add / evidence add)
  //     proceed regardless — required for rev 4.0 fan-out (worker A
  //     blocked on its pending must NOT block worker B's evidence
  //     append).
  //     Read-only commands proceed regardless.
  //     User-explicit terminal (abandon / archive / deliver / spike
  //     convert) proceed regardless (user explicit override).
  //
  //     Skill (loaf-skill / sub-agents) orchestrates workflow-level
  //     blocking via `loaf pending list` queries. See protocol.md §10.7
  //     + §14.3 + ADR-0003 Addendum 5.
  advance_blocks_when_pending_head_kind: ["gate_decision", "profile_escalation"],

  // 9. Registry as cache (rev 5.0 step numbers updated for 10-step path)
  //    Registry rewrite (step 9 of transaction) is best-effort.
  //    If process dies between step 8 (snapshot rebuild) and step 9,
  //    registry lags. TUI/Board reload it explicitly and never use it as gate
  //    or liveness authority.
  registry_authority: "best-effort projection; never gate authority",
} as const;
