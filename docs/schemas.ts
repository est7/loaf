// loaf-cli Protocol Schemas — v1 (rev 5.0)
//
// Single source of truth for all artifact contracts.
// JSON Schema is derived via `zod-to-json-schema`; never hand-written.
//
// Run: bun run gen-schemas.ts → dist/schemas/*.schema.json
//
// All comments in this file are normative — they document the contract,
// not the implementation. Implementation rules live in protocol.md.
//
// ──────────────────────────────────────────────────────────────────
// LAYERING (S1/S2/S3 from rev 3.1 grilling)
//
//   loaf-cli (this protocol kernel)
//     = strict schema kernel; owns state machine + gates + diff guard
//     = opinionated SDD: schemas ARE the protocol contract
//   loaf-skill (separate plugin, drives loaf-cli)
//     = owns workflow orchestration + LLM conversation + soft suggestions
//     = adapts free-form input → strict schema → loaf-cli commands
//   3rd-party skills (superpowers brainstorming, openspec, gsd, ...)
//     = produce schema-conformant artifacts; integrate via `loaf X submit`
//
// Worktree concurrency is the user's concern. Each `.loaf/` is per-cwd.
// ──────────────────────────────────────────────────────────────────
//
// Revision history (pre-v1.0):
//   rev 1 (2026-05-12)   initial draft, 6 artifact
//   rev 2 (2026-05-12)   findings.jsonl 7th, iteration first-class
//   rev 3 (2026-05-12)   6 phase (+DONE), 17 sub-state, drop state.status,
//                        VERIFY = checklist, EXECUTE = task graph,
//                        finding category+action, EARS structured,
//                        evidence covers[], session_id/cwd/pending in state
//   rev 3.1 (2026-05-12) loaf-cli vs loaf-skill layering clarified
//                        Q5  drop Applicability `should` → must/optional/na
//                        Q6  per-task-kind step enums; bug-fix folded into
//                            behavioral via labels[]; chore kind added;
//                            local_check → evidence kind; record_findings
//                            → orthogonal action (not a step)
//                        Q7  stable evidence_id "EV-000123"
//                        Q8  canSatisfy(evidence, coveredId) compatibility
//                        Q10 loaf.config.json merged config
//                            gate-diagnostic.json + resume-pack.json added
//                        Q11 risk-escalation finding category
//                        Q12 drop vague-word blacklist; require every REQ
//                            to have measurable OR verified_by_scenarios
//                            OR acceptance_na+reason (three-way verifiability)
//                        Q13 waiver evidence kind (split from manual)
//                        Q14 attachments { path, sha256, mime } objects
//                        Q15 registry is per-session file ~/.loaf/registry/<id>.json
//                            with atomic rename; 0600 permission; mtime-based stale
//                        + i18n stable IDs; bundle in i18n/{en,zh}.json
//                        + spec.md frontmatter adr_refs[]
//                        + evidence.actor free string with recommended prefix
//                        + diff-guard uses git status --porcelain full set
//                        + state.pending is single-value (not queue)
//                        + DONE.* terminal invariants enforced
//                        + tasks.execution.status is cache;
//                          evidence.jsonl is proof; `loaf check tasks` reconciles
//   rev 3.2 (2026-05-12) cleanup driven by ADR-0001 (task graph is DAG, not tree):
//                        - removed constitution.decomposition_preference
//                        - removed constitution.max_tasks_warning_threshold
//                          Both were rev 3.1 anti-over-decomposition advisory knobs.
//                          ADR-0001 establishes they are workflow content, not
//                          protocol shape (§1 principle 14: 协议管 shape, skill
//                          管 content). loaf-skill now carries the coarse-default
//                          bias in its SPEC prompt template; see
//                          references/loaf-skill-helpers.md.
//                        - verify_cadence reject rationale retained (NOTE below)
//                          so future grilling does not re-propose it.
//                        - documentation fix: protocol.md §17 and header used
//                          "v3 / v2" naming for current protocol vs legacy
//                          Python implementation; this contradicted the
//                          (rev 5.0 promoted SCHEMA_VERSION to 2; v1 done-when
//                          §15 criterion 3 now anchors at SCHEMA_VERSION=2.)
//                          Renamed: current protocol = "loaf-cli v1", legacy
//                          Python implementation = "legacy Python prototype"
//                          (no version number simpler, avoids future v2 name
//                          collision). schemas.ts §19/§20 comments updated.
//   rev 4.0 (2026-05-12) fresh-design refactor driven by ADR-0002.
//                        SPINE: Phase splits into two natures —
//                          • Worker phase   (EXECUTE)            — real side
//                            effects (code/test/files), supports sub-agent
//                            fan-out concurrency, active set lives in
//                            tasks.json.task.status="in_progress" (SSOT).
//                          • Control phase  (TRIAGE/SPEC/VERIFY/SETTLE)
//                            — planning/checking/settling, master skill
//                            serial, intent expressed via sub_state.
//                        4 candidates landed:
//                        - C1 α  : Phase remains 6, NOT merged (worker/
//                                  control are different natures).
//                        - C4    : StateJson drops current_task /
//                                  current_step / current_check (all three
//                                  conflated worker active-set vs control
//                                  cursor). RegistryFile drops same 3 and
//                                  gains active_tasks: TaskId[] (derived
//                                  projection for TUI). DONE.* terminal
//                                  invariant about active-set moves to
//                                  cross-file transitions.ts enforcement
//                                  (§1 principle 3 weakens one notch —
//                                  Zod no longer 100% of the contract).
//                        - C6    : gate-diagnostic.json and resume-pack.json
//                                  state_snapshot now carries StateJson +
//                                  tasks_active_summary: { task_id, status,
//                                  current_step (derived) }[].
//                        - C8    : SubState "VERIFY.check" splits into 4
//                                  check-specific sub_states (VERIFY.run,
//                                  VERIFY.review, VERIFY.acceptance,
//                                  VERIFY.visual). Intent now in sub_state,
//                                  not in current_check field. 17 → 20.
//                        - C9'   : RegistryFile gains `feature: string`
//                                  (kebab-case derived projection of
//                                  .loaf/<feature>/ dir name). Rationale:
//                                  RegistryFile lives at ~/.loaf/registry/
//                                  <session_id>.json — path has no feature
//                                  context — so TUI needs the field for
//                                  single-file-read display. StateJson
//                                  does NOT carry `feature` (its path
//                                  already contains the dir name; reader
//                                  derives via path.basename).
//                        - CLI hardening (protocol.md §10 整段重写): per
//                                  clig.dev audit (two-pass review),
//                                  locked down the CLI presentation
//                                  contract — stdout/stderr separation,
//                                  help contract, TTY+color+pager rules,
//                                  env var taxonomy, config precedence
//                                  (flag>env>project>user>defaults),
//                                  SIGINT cleanup (second-Ctrl-C
//                                  non-destructive), error rewriting
//                                  (with prefilled bug-report URL
//                                  context), subcommand naming (noun-verb
//                                  default + session-lifecycle single-
//                                  verb chaos deviation), state-change
//                                  output convention (per-command
//                                  stderr "<action>:<changed>" + next
//                                  hint, --quiet suppresses), long-op
//                                  progress (>1s ops show spinner/
//                                  milestone on stderr), global flags
//                                  (--no-input, -v/--verbose, --quiet,
//                                  --plain alias), exit codes
//                                  (0/1/2/130), --format json declared
//                                  a stable contract, man pages (per
//                                  subcommand group), no-telemetry +
//                                  no-auto-upload of crashlog. Renamed
//                                  `loaf check tasks` → `loaf tasks
//                                  check` and `loaf tasks status` →
//                                  `loaf tasks list` for noun-verb
//                                  consistency and to avoid `loaf
//                                  status` (session-level) vs `loaf
//                                  tasks status` ambiguity. No schema
//                                  field changes — pure CLI surface spec.
//                        Wang batch parallel mapping: subagent fan-out in
//                        EXECUTE phase (skill responsibility, see
//                        references/loaf-skill-helpers.md §4). Wang
//                        rule-candidate auto-promote: skill orchestration
//                        via existing evidence + finding lifecycle (no new
//                        protocol surface).
//                        BREAKING CHANGE vs rev 3.2 (StateJson/RegistryFile
//                        field set + SubState enum). Acceptable cost: v1
//                        has no implementation yet, Hyrum's Law exposure = 0.
//   rev 4.1 (2026-05-12) cleanup driven by ADR-0003 (codex 2-round audit
//                        on rev 4.0). 11 of 17 codex suggestions accepted,
//                        6 rejected with technical pushback. No schema
//                        version bump; no new phase / sub-state / hook /
//                        CLI command (§15 freeze intact).
//                        Real correctness gaps closed (fan-out concurrency
//                        was unspecified in rev 4):
//                        - §34 (new) Concurrency invariants:
//                          single-writer rule (only loaf-cli writes
//                          .loaf/<feature>/), per-session lock
//                          (.loaf/<feature>/.lock), transaction order
//                          (acquire → read → validate → write tmp →
//                          fsync → atomic rename → refresh registry →
//                          release). `tasks step done` must be atomic
//                          (execution.status + evidence add in same lock).
//                        - EvidenceAddInput (new) — CLI input shape that
//                          omits evidence_id (CLI-assigned, monotonic)
//                          and `at` (CLI-stamped); adds optional
//                          external_ref for caller correlation. CLI MUST
//                          reject any `--id` flag.
//                        - FindingActionEffect gains requires_target_payload
//                          enum ("task_id_step" | "none"). New
//                          FindingResolutionPayload type carries
//                          { task_id, step } for fix-impl/fix-test/
//                          amend-tasks. step is NOT a session cursor
//                          (rev 4 cut current_step) — it is mutation
//                          payload that writes
//                          tasks.<T-N>.execution.<step>.status="pending"
//                          to make the step re-run.
//                        Protocol gaps closed:
//                        - Pending queue upgrade (was §16 non-goal
//                          "v1.1 再考虑" — moved to v1.0). StateJson
//                          .pending: PendingPrompt | null →
//                          PendingPromptEntry[] (default []). FIFO
//                          strict: head element is the active blocker;
//                          resolve always pops head; queued entries
//                          auto-promote. New PendingId type +
//                          PendingPromptEntry (wraps PendingPrompt with
//                          pending_id + at + raised_by_task_id).
//                          RegistryFile mirror updated: pending = head
//                          (or null) + pending_queue_depth = full length.
//                          Rationale: rev 4.0 fan-out (EXECUTE.work
//                          sub-agent concurrency) requires multiple
//                          workers to raise independent pending without
//                          serializing on a single-valued slot. See
//                          ADR-0003 Addendum 2 + protocol.md §4.1 +
//                          §14.3.
//                        - SubStateContract gains `mutation_rights` field
//                          per sub_state, distinguishing SPEC.plan (spec
//                          risks/milestones section only) from
//                          SPEC.design (spec design + tasks.json creation)
//                          from EXECUTE.plan (tasks.execution policy
//                          derive only) from EXECUTE.work (execution
//                          status + evidence + source code). Without
//                          this, the two "plan" sub_states have
//                          indistinguishable write rights.
//                        - RegistryFile doc clarified: best-effort
//                          projection, never gate authority, rebuildable
//                          via `loaf doctor --rebuild-registry`.
//                          Cross-file transactions may leave registry
//                          stale within a crash window.
//                        Discipline / future-proofing:
//                        - protocol.md §1 Principle #15 (promotion /
//                          projection / mutation 三纪律).
//                        - protocol.md §7.0 Sub-state promotion rule —
//                          a verification concern must change ≥2 of
//                          {mutation set, write paths, evidence shape,
//                          interaction mode, recovery, TUI semantics,
//                          diagnostic class} to promote to first-class
//                          sub_state. Reverse-audit confirms current
//                          4 VERIFY lanes (run/review/acceptance/visual)
//                          all pass. Future security/perf/a11y MUST map
//                          to an existing lane unless rule satisfied.
//                        - SubState rename: EXECUTE.task → EXECUTE.work
//                          (fan-out reality is plural; singular .task
//                          name conflicted).
//                        - protocol.md §13.1 3-tier → 4-tier artifact
//                          authority: Canonical truth / Derived
//                          projection / Debug-trace / Advisory. Gate
//                          only reads Canonical truth.
//                        CLI design audit follow-up (clig.dev 2nd-round
//                        review on rev 4.1, also tracked in ADR-0003):
//                        - §34 CONCURRENCY_INVARIANTS adds
//                          `dry_run_transaction_order` + `dry_run_rejects_read_only`.
//                          --dry-run / -n is a v1.0 global flag (skill
//                          fan-out workers pre-check before committing
//                          to a mutation under contention). Validates
//                          steps 1-5 then unlinks .tmp and releases the
//                          lock; never increments EV-id counter.
//                        - protocol.md §10.11 declares build-time URL
//                          stamping (LOAF_DOCS_URL / LOAF_ISSUE_URL);
//                          §15 done-when item 5 blocks v1.0.0 release
//                          on placeholder URLs (no schema change here,
//                          but build pipeline contract).
//                        - protocol.md §10.15 scopes `loaf doctor`
//                          diagnostic surface (9 checks: stale-lock /
//                          orphan-tmp / registry-stale / registry-
//                          orphan / registry-gc / crash-log-prune /
//                          schema-drift / artifact-corruption /
//                          url-placeholder).
//                        - protocol.md §10.2 + §10.3 respect generic
//                          env vars FORCE_COLOR and DEBUG (alias of
//                          LOAF_DEBUG).
//                        quick profile direct-DONE (ADR-0003 Addendum 3):
//                        - PROFILE_POLICIES.quick.phases_run drops
//                          SETTLE: ["TRIAGE", "EXECUTE", "DONE"]
//                          (was ["TRIAGE", "EXECUTE", "SETTLE", "DONE"]).
//                        - SUB_STATE_CONTRACTS.EXECUTE.done.next gains
//                          "DONE.delivered" (quick non-spike via
//                          `loaf deliver`; verify-min runs at this
//                          boundary).
//                        - SUB_STATE_CONTRACTS.SETTLE.{reconcile,
//                          lessons}.entry conditions drop the quick
//                          branch (standard / deep only).
//                        Rationale: reconcile.json is standard+;
//                        lessons.md is quick-skip; SETTLE.* sub_states
//                        were pure pass-through for quick. Letting
//                        quick skip SETTLE matches actual artifact
//                        production. Spike still requires explicit
//                        §8.3 outcome — not part of this fast path.
//                        Session dispatch + AI client bridge (ADR-0003
//                        Addendum 4):
//                        - CLI dispatch precedence (high → low):
//                          --session <UUID> / --feature <name> flag >
//                          $LOAF_SESSION / $LOAF_FEATURE env >
//                          auto-pick cwd's .loaf/* (1 non-DONE feature).
//                        - No `.loaf/.active` pointer file (per-process
//                          ENV naturally isolates concurrent terminals
//                          / Claude Code conversations).
//                        - 4 new diagnostic codes: FEATURE_AMBIGUOUS /
//                          FEATURE_NOT_FOUND / SESSION_CWD_MISMATCH /
//                          SESSION_SHORT_AMBIGUOUS.
//                        - `loaf start` stdout last line = UUID (shell
//                          scripting); `loaf sessions list --in-cwd`
//                          recovers UUID after terminal restart.
//                        - AI assistant client bridge:
//                          ~/.loaf/<vendor>-bridge/<conv-id>.json is a
//                          client-level artifact (NOT loaf-cli artifact;
//                          loaf-cli neither reads nor writes it).
//                          Claude Code etc. write per-conversation
//                          bridge to overcome (a) Bash tool one-shot
//                          shell (`export` doesn't persist) and (b)
//                          conversation compaction losing UUID. Multi-
//                          Claude same cwd: each conversation owns its
//                          own bridge file → zero collision.
//                        - No new schema fields. Pure CLI surface
//                          additions (env vars + flags + error codes).
//                        Rejected (see ADR-0003 Rejected section):
//                        - VERIFY 4-state flatten (promotion rule
//                          validates current 4 lanes — don't reverse).
//                        - SPEC 4-state flatten (loses amend-spec
//                          back-edge precision to SPEC.spec).
//                        - finding action merge to redo-work (intent
//                          differs; merging adds indirection without
//                          simplification).
//                        - RegistryFile source.{state_version,
//                          tasks_version, ...} 4 anchor fields (YAGNI
//                          once best-effort projection is declared).
//                        - pending → interaction rename (bikeshed).
//                        - `loaf check tasks` canonical/alias relation
//                          (rev 4 chose single entry `loaf tasks check`;
//                          `loaf check <path>` is a different command
//                          that takes a path argument — not aliases).
//                        BREAKING CHANGE vs rev 4.0: SubState enum
//                        (EXECUTE.task → EXECUTE.work). Acceptable cost
//                        as in rev 4.0: no impl yet, Hyrum's Law
//                        exposure = 0.
//   rev 4.2 (2026-05-12) Profile enum 砍,改 Ceremony hybrid B+label
//                        (ADR-0003 Addendum 6)。
//                        - Profile enum (quick/standard/deep) 整个砍掉。
//                          替代:Ceremony schema (6 bool/enum field) +
//                          ceremony_label string (cosmetic display only)。
//                        - StateJson.profile → StateJson.ceremony +
//                          StateJson.ceremony_label。
//                        - RegistryFile.profile → RegistryFile.ceremony_label
//                          (TUI display 用;详细 ceremony flag 走
//                          canonical state.json)。
//                        - PROFILE_POLICIES 表整个砍,移到 skill PRESETS
//                          表(loaf-skill / cursor-loaf-skill 各自维护
//                          preset 名 → Ceremony object 映射)。
//                        - ESCALATION_RULES 改 ESCALATION_DETECTIONS
//                          (CLI 检测 trigger 后 raise pending,skill 决定
//                          新 ceremony,跟 profile from/to 解耦)。
//                        - LoafConfig.constitution.default_profile →
//                          default_ceremony_label + optional default_ceremony。
//                        - SUB_STATE_CONTRACTS entry 条件 `profile != quick`
//                          → `ceremony.{spec,verify,settle}_phase=true`。
//                        Rationale: §1 原则 14 (协议管 shape,skill 管
//                        content)。Profile 是 content (preset 选哪个),
//                        不是 shape (state machine 长什么样)。砍下 5 件
//                        content→skill 决策之最后一件(前 4 件 vague-word /
//                        should / decomposition_preference / verify_cadence)。
//                        CLI state machine 严谨性 0 损失 — 同样用
//                        ceremony.* 6 flag 强制 phase 跑哪些,跟之前 PROFILE_
//                        POLICIES 查表逻辑等价。Cosmetic label 保住品牌名
//                        readability。详见 ADR-0003 Addendum 6。
//   rev 4.2 polish      clig.dev 三轮 review 顶 4 fix(no schema_version
//   (2026-05-12)         bump,§15 freeze 未破):
//                        - `loaf tasks done` → `loaf tasks complete`
//                          rename (消 `tasks step done` 同名异级歧义,
//                          clig.dev §8)。impl 阶段 command enum 用 complete。
//                        - 新 §35 FLAG_EXCLUSIONS const (output_format
//                          mutually exclusive set + 未来扩展槽):
//                          `--json`/`--plain`/`--format=<v>` 归一化 +
//                          冲突值 exit 2 MUTUALLY_EXCLUSIVE_FLAGS。
//                        - stderr color TTY gate 独立 isatty (protocol.md
//                          §10.2;clig.dev §4)。
//                        - Help footer 加 LOAF_ISSUE_URL (protocol.md
//                          §10.1;clig.dev §2 support path)。
//                        - `-h` 任意位置 short-circuit (protocol.md §10.1;
//                          clig.dev §2)。
//                        - `loaf hook <event>` enum 限定 4 值,bare
//                          调用 exit 2 列 enum + did-you-mean (§10.8)。
//   rev 5.0 (2026-05-14) Truth model = single typed journal (γ),driven by
//                        ADR-0005。Breaking storage shape;v1 unfrozen,
//                        Hyrum's Law exposure = 0(impl 未到 GA)。
//                        SCHEMA_VERSION 1 → 2(envelope shape 级常量)。
//                        - 新 §0a JournalEntry envelope + EntryKind +
//                          AttachmentRef + LongTextField + SignatureEnvelope
//                          + SnapshotMeta。canonical truth 移至
//                          `.loaf/<feature>/journal.jsonl` + `attachments/`,
//                          ADR-0005 §3.1 / §3.2 / §3.6。
//                        - 新 §0b ENTRY_SCHEMA_VERSIONS(per-kind version
//                          table,rev 5.0 全部 = 1)+ UPCASTER_REGISTRY
//                          (keyed by (kind, entry_schema_version);rev 5.0
//                          shape-only,registrar 待 per-kind upcaster 落地)。
//                        - 新 §0c MIGRATION_V1_TO_V2_BOUNDARY(v0.0.x N-file
//                          → v0.1.0 lossy snapshot sidecar import 映射表;
//                          ADR-0005 §5.2)。
//                        - §34 CONCURRENCY_INVARIANTS 大幅重写:
//                          • transaction_order 8 → 10 步(加 step 3
//                            preflight、step 5 final validate、step 6
//                            final-entry-only append)
//                          • batch_transaction_order 9 → 10 步同步对齐
//                          • dry_run_transaction_order 同步扩
//                          • 加 entry_byte_limit_kb / sidecar_threshold_kb /
//                            monotonic_invariants / batch_aware_tail_recovery
//                            / orphan_attachment_gc / checksum_levels /
//                            step_5_final_validate / 5 个 doctor sub-flags
//                          • atomic_multi_artifact_commands 改写为 journal
//                            kind emission(写多 artifact 改为 emit 多 kind
//                            in 同一 lock window 同一 batch)
//                        - §15 done-when 条款延伸(protocol.md §15 第 6 / 第
//                          7 项):v0.0.x → v0.1.0 upcaster e2e + 10K/100K
//                          rebuild perf benchmark。
//                        - §16 退场 state.json event sourcing 非目标。
//                        Non-changes:Phase / SubState / Hook surface / 5
//                        Tier 1 mutator command surface 全部保留;rev 5.0
//                        是「持久化形态 + envelope shape」级 breaking,
//                        非「state machine」级 breaking。详 ADR-0005 §2.1。

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────
// 0. Schema version
// ─────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 2;
export const SchemaVersion = z.literal(SCHEMA_VERSION);

// ─────────────────────────────────────────────────────────────────
// §0a. Journal envelope + EntryKind + sidecar shapes (rev 5.0, ADR-0005 §3.2)
// ─────────────────────────────────────────────────────────────────
//
// Canonical truth in rev 5.0 is `.loaf/<feature>/journal.jsonl` (append-only,
// typed envelope) + `.loaf/<feature>/attachments/<entry_id>/**` (per-entry
// sidecar). All artifacts described in §1-§33 of this file are reducer-
// derived projections that land under `.loaf/<feature>/snapshots/` or as
// markdown (spec.md / lessons.md). Their schemas remain authoritative for
// reader / TUI / CI consumption, but mutation goes through journal entries.
//
// Runtime registry cross-reference (audit r1-r5 catch-up): per-kind payload
// schemas are executable runtime policy, not duplicated here. The canonical
// tables live in `src/core/journal-entry.ts`:
//   - PER_KIND_PAYLOAD (`src/core/journal-entry.ts:330`) maps every EntryKind to
//     the strict Zod payload schema used by preflight and final append validate.
//   - REDUCER_IMPLEMENTED_KINDS (`src/core/journal-entry.ts:372`) is the allowlist
//     journal-mutate checks before append so payload-valid but reducer-unknown
//     kinds cannot orphan journal entries.
// JournalEntry.payload stays z.unknown() here; runtime narrows by (kind, payload)
// in `src/core/journal-entry.ts` and applies/refines in `src/core/reducer.ts`.
// See ADR-0005 §3.3 for the kind namespace and §3.6 for per-kind invariants.
//
// Byte limit per entry: 64KB (entry_byte_limit_kb, §34). LongTextField over
// `sidecar_threshold_kb` (8KB) MUST be externalized to attachments/<entry_id>/
// and replaced in payload by an AttachmentRef.

export const EntryId = z
  .string()
  .regex(/^JE-\d{6,}$/, {
    message: "entry_id must match /^JE-\\d{6,}$/ (e.g. JE-000123)",
  });
export type EntryId = z.infer<typeof EntryId>;

export const BatchId = z.string().uuid();
export type BatchId = z.infer<typeof BatchId>;

// Actor namespace (ADR-0005 §3.4). CLI auto-injects; never accepted as
// `--actor` flag. The trailing free-form segment after the colon identifies
// the actor instance (e.g. `human:est9`, `skill:loaf-cli/sdd-execute`,
// `cli:loaf`, `ci:github-actions`, `migration:v0.0.x→v2`).
export const ActorString = z
  .string()
  .regex(/^(human|skill|ci|cli|migration):[^\s].*$/, {
    message:
      "actor must be of form '<prefix>:<id>' where prefix ∈ {human, skill, ci, cli, migration}",
  });
export type ActorString = z.infer<typeof ActorString>;

// AttachmentRef — per-entry sidecar pointer. The `path` is relative to
// `.loaf/<feature>/` (e.g. "attachments/JE-000123/summary.txt"). The reducer
// verifies `sha256` matches the on-disk file when applying the entry.
export const AttachmentRef = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/, {
      message: "sha256 must be 64 lowercase hex chars",
    }),
    size: z.number().int().nonnegative(),
  })
  .strict();
export type AttachmentRef = z.infer<typeof AttachmentRef>;

// LongTextField — discriminated by `mode`. Inline values must stay below the
// sidecar threshold; oversized values MUST be promoted to sidecar form
// during §11.2 step 4 (sidecar finalize) and emitted as
// `{ mode: "sidecar", ref: AttachmentRef }`.
export const LongTextField = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inline"), text: z.string() }).strict(),
  z.object({ mode: z.literal("sidecar"), ref: AttachmentRef }).strict(),
]);
export type LongTextField = z.infer<typeof LongTextField>;

// SignatureEnvelope — v0.1.0 reserve slot. No enforcement in rev 5.0; the
// field is structurally typed so future ADR-0006 (signature scheme) can land
// without an envelope shape bump. Today the only contract is "if present,
// MUST conform to this shape"; the reducer ignores it.
export const SignatureEnvelope = z
  .object({
    alg: z.string().min(1),
    key_id: z.string().min(1),
    sig: z.string().min(1),
    signed_at: z.string().datetime(),
  })
  .strict();
export type SignatureEnvelope = z.infer<typeof SignatureEnvelope>;

// EntryKind namespace — closed set per ADR-0005 §3.3. Per-kind reducer
// invariants live in `src/core/reducer.ts` (per-kind apply table). New kinds
// require an ADR + §15 freeze review (rev 5.0 GA tag freezes this enum).
export const EntryKind = z.enum([
  // ── State machine transitions ──
  "event:phase_advanced",
  "event:ceremony_set",
  "event:tasks_planned",
  "event:tasks_amended",
  "event:task_claimed",
  "event:task_step_started",
  "event:task_step_done",
  // event:task_step_reset (Phase 11 Item 3 SC2/SC3) — co-emitted by
  // `loaf finding raise --action fix-impl|fix-test` inside the 3-entry
  // back-edge batch; resets a task's repair step to `pending` (fix-impl →
  // "implement", fix-test → "red").
  "event:task_step_reset",
  "event:task_abandoned",
  "event:spec_req_added",
  "event:spec_scenario_added",
  "event:spec_visual_added",
  "event:spec_submitted",

  // ── Domain ledger entries ──
  "evidence:added",
  "finding:raised",
  "finding:closed",
  "pending:added",
  "pending:resolved",

  // ── Human gates (REQUIRE human: actor) ──
  // gate:decided records an approval flag (spec_locked / verify_accepted)
  // ONLY — it does NOT drive a state transition (Slice 1.A normalization).
  // Cursor movement rides on a separate `event:phase_advanced` in the same
  // batch. Source-state pairing is enforced at preflight step 5a:
  // gate_kind=spec-lock @ SPEC.design only; verify-accept @ VERIFY.accept only.
  "gate:decided",

  // ── Session lifecycle ──
  "session:started",
  "session:resumed",
  "session:delivered",
  "session:archived",
  "session:abandoned",

  // ── Spike branch closure ──
  "spike:converted",

  // ── Migration (v0.0.x → v0.1.0 lossy snapshot import; §0c) ──
  "migration:snapshot_imported",
]);
export type EntryKind = z.infer<typeof EntryKind>;

// JournalEntry — the SSoT envelope. Every line in `journal.jsonl` is one
// JournalEntry. Batch markers appear only when a single mutator emits ≥2
// entries inside one §11.2 transaction (ADR-0005 §3.2 / §4.16).
//
// payload is typed as z.unknown() here; per-kind payload Zod schemas land
// progressively in src/core (Stage 1-5). At runtime the reducer narrows on
// `kind` and validates `payload` against the per-kind schema; preflight
// (§11.2 step 3) and final validate (§11.2 step 5) both apply this narrowing.
export const JournalEntry = z
  .object({
    // Identity & ordering
    seq: z.number().int().nonnegative(),
    entry_id: EntryId,
    at: z.string().datetime(),
    actor: ActorString,
    entry_schema_version: z.number().int().positive(),

    // Domain
    kind: EntryKind,
    payload: z.unknown(),

    // Batch markers (only present in multi-entry batches; ADR-0005 §3.2)
    batch_id: BatchId.optional(),
    batch_index: z.number().int().nonnegative().optional(),
    batch_count: z.number().int().positive().optional(),

    // Optional crypto (v0.1.0 reserve)
    signature: SignatureEnvelope.optional(),
  })
  .strict()
  .refine(
    (e) => {
      // Batch markers travel as a triple or none at all.
      const present = [e.batch_id, e.batch_index, e.batch_count].filter(
        (v) => v !== undefined,
      ).length;
      return present === 0 || present === 3;
    },
    {
      message:
        "batch_id, batch_index, batch_count must be all-present or all-absent",
    },
  )
  .refine(
    (e) =>
      e.batch_index === undefined ||
      e.batch_count === undefined ||
      e.batch_index < e.batch_count,
    { message: "batch_index must be < batch_count" },
  );
export type JournalEntry = z.infer<typeof JournalEntry>;

// SnapshotMeta — sits at `.loaf/<feature>/snapshots/_meta.json`. Readers
// (CLI commands that consume snapshots/*.json) MUST check `last_entry_offset`
// + `last_entry_line_hash` (Gate #5 fast check, ADR-0005 §3.6); mismatch
// exits 2 SNAPSHOT_STALE_REBUILD_REQUIRED with no silent fallback. The
// rolling_checksum chain enables `loaf doctor --verify-checksum` full audit
// (O(N), §34 checksum_levels).
//
// Empty sentinel (Phase 15 SC3, codex r175): `last_applied_seq = -1` is
// the documented empty-journal sentinel. When the sentinel is set, the
// other structural fields MUST also be empty (`last_entry_offset = 0`,
// `last_entry_line_hash = ZERO_HASH`, `rolling_checksum = ZERO_HASH`).
// A corrupt meta claiming seq=-1 but carrying non-empty offset/hash/
// checksum would otherwise be silently translated to NO_SESSION by the
// seq-only freshness test in checkSnapshotFresh — exactly the silent-
// fallback shape SC3 is meant to eliminate. The refine ensures the
// projection-loader classifies such cases as `meta_invalid cause=schema`
// upstream of any freshness check.
export const SnapshotMeta = z
  .object({
    // -1 sentinel allowed (empty journal); all real entries are >= 0.
    last_applied_seq: z.number().int().gte(-1),
    last_entry_offset: z.number().int().nonnegative(),
    last_entry_line_hash: z.string().regex(/^[a-f0-9]{64}$/, {
      message: "last_entry_line_hash must be 64 lowercase hex chars",
    }),
    rolling_checksum: z.string().regex(/^[a-f0-9]{64}$/, {
      message: "rolling_checksum must be 64 lowercase hex chars",
    }),
    feature_schema_version: z.number().int().positive(),
    written_at: z.string().datetime(),
  })
  .strict()
  .refine(
    (m) =>
      m.last_applied_seq !== -1 ||
      (m.last_entry_offset === 0 &&
        m.last_entry_line_hash === "0".repeat(64) &&
        m.rolling_checksum === "0".repeat(64) &&
        m.feature_schema_version === SCHEMA_VERSION),
    {
      message:
        "last_applied_seq=-1 (empty sentinel) requires last_entry_offset=0 + line_hash/rolling_checksum=ZERO_HASH + feature_schema_version=current (mirrors runtime isEmptyMeta — codex r176 BLOCK 2)",
    },
  );
export type SnapshotMeta = z.infer<typeof SnapshotMeta>;

// ─────────────────────────────────────────────────────────────────
// §0b. Per-entry schema versioning + upcaster registry (rev 5.0, ADR-0005 §4.17)
// ─────────────────────────────────────────────────────────────────
//
// `JournalEntry.entry_schema_version` is per-kind. When a kind's payload
// shape evolves (post-GA), the kind's version increments and an upcaster is
// registered in UPCASTER_REGISTRY at (kind, prev_version). Reducer apply
// reads `entry_schema_version` and runs the chain of upcasters up to the
// current kind version before validating against the current payload schema.
//
// In rev 5.0 every kind is at version 1; UPCASTER_REGISTRY is structurally
// declared but empty. Upcasters must be kept in sync with the runtime
// PER_KIND_PAYLOAD registry in `src/core/journal-entry.ts:330`; when a kind's
// payload shape evolves, add the upcaster and payload schema in the same runtime
// change, then update this docs registry in the same docs-sync commit.

export const ENTRY_SCHEMA_VERSIONS = {
  "event:phase_advanced": 1,
  "event:ceremony_set": 1,
  "event:tasks_planned": 1,
  "event:tasks_amended": 1,
  "event:task_claimed": 1,
  "event:task_step_started": 1,
  "event:task_step_done": 1,
  "event:task_step_reset": 1,
  "event:task_abandoned": 1,
  "event:spec_req_added": 1,
  "event:spec_scenario_added": 1,
  "event:spec_visual_added": 1,
  "event:spec_submitted": 1,
  "evidence:added": 1,
  "finding:raised": 1,
  "finding:closed": 1,
  "pending:added": 1,
  "pending:resolved": 1,
  "gate:decided": 1,
  "session:started": 1,
  "session:resumed": 1,
  "session:delivered": 1,
  "session:archived": 1,
  "session:abandoned": 1,
  "spike:converted": 1,
  "migration:snapshot_imported": 1,
} as const satisfies Record<z.infer<typeof EntryKind>, number>;

// Upcaster registry shape. Each entry maps (kind, prev_version) to a pure
// function that produces the next-version payload. The function signature
// stays generic in schemas.ts; src/core/reducer narrows it per kind.
export type Upcaster = (prevPayload: unknown) => unknown;
export const UPCASTER_REGISTRY: Record<
  `${z.infer<typeof EntryKind>}@${number}`,
  Upcaster
> = {};

// ─────────────────────────────────────────────────────────────────
// §0c. Migration boundary (v0.0.x → v0.1.0; rev 5.0, ADR-0005 §5.2)
// ─────────────────────────────────────────────────────────────────
//
// MIGRATION_V1_TO_V2_BOUNDARY documents the lossy snapshot import that
// `loaf doctor --migrate-v2` performs. The legacy N-file artifacts are NOT
// re-synthesized as fresh journal entries; instead they land as sidecars
// under `attachments/JE-000000/migration/` and are referenced from a single
// `migration:snapshot_imported` journal entry at seq=0. The reducer projects
// the sidecar contents into snapshots/*.json. Legacy gate-decision evidence
// entries DO project into the derived gate view but DO NOT fabricate
// `gate:decided` history entries (ADR-0005 §5.2 rev 3 H fix). The migration
// payload itself is constrained to the manifest shape (Gate #3,
// `.strict()` enforced in src/core/reducer when the per-kind payload schema
// for `migration:snapshot_imported` lands).
//
// Crash table during migration: see ADR-0005 §5.2 (7 rows). Each error code
// (SCHEMA_VERSION_MISMATCH / MIGRATION_INCOMPLETE / MIGRATION_BACKUP_MISSING
// / MIGRATION_REPLAY_ATTEMPT / MIGRATION_SIDECAR_MISSING) is defined in §39
// ERROR_CATALOG when the diagnostic code addition lands (Stage 5).

export const MIGRATION_V1_TO_V2_BOUNDARY = {
  source_schema_version: 1,
  target_schema_version: 2,

  // v0.0.x file → migration sidecar path (relative to `.loaf/<feature>/`).
  // The doctor copies each file to its sidecar path with tmp+rename, fsyncs
  // file + parent dir, then computes sha256.
  sidecar_layout: {
    "state.json": "attachments/JE-000000/migration/state.json",
    "tasks.json": "attachments/JE-000000/migration/tasks.json",
    "spec.md": "attachments/JE-000000/migration/spec.md",
    "evidence.jsonl": "attachments/JE-000000/migration/evidence.jsonl",
    "findings.jsonl": "attachments/JE-000000/migration/findings.jsonl",
    "pending.json": "attachments/JE-000000/migration/pending.json",
  },

  // Backup location for the original v0.0.x files. The doctor refuses to
  // run unless this directory can be created adjacent to `.loaf/<feature>/`
  // (MIGRATION_BACKUP_MISSING exit 2 if it cannot be made).
  backup_path: "../<feature>.backup-v1/",

  // The lone journal entry emitted at migration completion. Payload manifest
  // shape is enforced by `.strict()` Zod in src/core/reducer (Gate #3).
  journal_entry: {
    seq: 0,
    entry_id: "JE-000000",
    actor_prefix: "migration:",
    kind: "migration:snapshot_imported" as const,
    payload_manifest_keys: [
      "state",
      "tasks",
      "spec_md",
      "evidence",
      "findings",
      "pending",
    ],
  },

  // Legacy enum mapping: where each v0.0.x enum value lands after migration.
  // The reducer DOES project legacy gate-decision evidence into a derived
  // gate view, but DOES NOT fabricate new `gate:decided` history entries —
  // this avoids the rev 2 "dual truth source" problem (ADR-0005 §5.2).
  legacy_enum_routing: {
    "evidence.jsonl.kind=gate-decision":
      "migration sidecar → projected to evidence view + derived gate view (no new gate:decided)",
    "evidence.jsonl.kind=test|review|visual|manual|waiver":
      "migration sidecar → projected to evidence view",
    "findings.jsonl.event=raised|closed":
      "migration sidecar → projected to findings view",
    "pending.json.kind=ask_user_question|gate_decision|spec_clarification|finding_decision|profile_escalation":
      "migration sidecar → projected to pending view",
    "state.json.*":
      "migration sidecar → copied verbatim to in-memory state, then projected",
    "tasks.json.tasks[]":
      "migration sidecar → copied to tasks projection",
    "spec.md":
      "migration sidecar → copied to spec.md projection (post-submit shape)",
  },
} as const;

// ─────────────────────────────────────────────────────────────────
// 1. Phase / SubState
// ─────────────────────────────────────────────────────────────────
//
// 6 macro phases × 17 sub-states. First-class state machine.
// SubState format: `<Phase>.<step>` so hooks can parse via split(".").
// Invariant (enforced by StateProjection.refine): sub_state.startsWith(phase + ".")

export const Phase = z.enum([
  "TRIAGE",
  "SPEC",
  "EXECUTE",
  "VERIFY",
  "SETTLE",
  "DONE",
]);
export type Phase = z.infer<typeof Phase>;

// rev 4.0: VERIFY.check split into 4 check-specific sub_states (C8).
//   Intent ("which check is running") now lives in sub_state, not in a
//   state.current_check field. Aligns with worker/control phase typology:
//   VERIFY is a control phase, master skill runs 4 checks serially,
//   sub_state carries the cursor. 17 → 20 sub_states.
export const SubState = z.enum([
  "TRIAGE.score",
  "TRIAGE.confirm",
  "SPEC.proposal",
  "SPEC.spec",
  "SPEC.plan",
  "SPEC.design",
  "EXECUTE.plan",         // derive per-task execution policy
  "EXECUTE.work",         // worker active set lives in tasks.json (filter status="in_progress")
  "EXECUTE.done",         // all tasks reached final status
  "VERIFY.plan",          // compute applicable verify checks
  "VERIFY.run",           // rev 4.0: running `run` check (test + lint + typecheck)
  "VERIFY.review",        // rev 4.0: running `review` check (quality reviewer)
  "VERIFY.acceptance",    // rev 4.0: running `acceptance` check (Gherkin E2E)
  "VERIFY.visual",        // rev 4.0: running `visual` check (visual contract)
  "VERIFY.accept",        // machine + human gate
  "SETTLE.reconcile",
  "SETTLE.lessons",
  "DONE.delivered",       // terminal: after `loaf deliver`
  "DONE.archived",        // terminal: after `loaf archive`
  "DONE.abandoned",       // terminal: after `loaf abandon`
]);
export type SubState = z.infer<typeof SubState>;

// ─────────────────────────────────────────────────────────────────
// 2. Ceremony / TaskKind
// ─────────────────────────────────────────────────────────────────
//
// rev 4.2: `Profile` enum 砍掉(was: "quick" | "standard" | "deep")。
// Profile 是 content/policy 不是 protocol shape(§1 原则 14)— 跟之前
// 砍 vague-word / `should` / decomposition_preference / verify_cadence
// 同纪律,Profile 砍下 5 件 content 之最后一件。
//
// 替代:`Ceremony` 6 flag schema(机器接口),`ceremony_label` 字符串
// (cosmetic display)。skill 提供 PRESETS 表(`quick / standard /
// deep / 任意自定义名`)映射 preset 名到 Ceremony object,写 state.json
// 时同时塞 ceremony + ceremony_label 两字段。CLI 用 ceremony.* 6 个
// bool/enum 决定 phase 跑哪些 / gate 严不严;**完全不解析** label,
// 仅在错误信息 / TUI / state-change line 透传显示。
//
// 这样 protocol 中立 — 1st-cc-plugin 的 loaf-skill 可叫 quick/standard/
// deep,cursor-loaf-skill 可叫 prototype/feature/release,公司自定义
// skill 可叫 fast-fix/full-feature/regulatory,各自 PRESETS 表内部映射,
// 不动协议。

export const Ceremony = z.object({
  // 跑 SPEC.* sub_states 吗?(false → TRIAGE.confirm 直接进 EXECUTE.plan,
  // 跟 rev 4.1 quick 行为一致)
  spec_phase: z.boolean().default(false),

  // 跑 VERIFY.* sub_states 吗?(false → EXECUTE.done 跳过 VERIFY,
  // verify-min 在 `loaf deliver` 入口跑,跟 rev 4.1 quick 行为一致)
  verify_phase: z.boolean().default(false),

  // 跑 SETTLE.* sub_states 吗?(false → 不产 reconcile.json,
  // 跟 rev 4.1 quick 行为一致)。invariant: settle_phase=true 蕴含
  // verify_phase=true(SETTLE.reconcile 入口要求 verify-accept passed)
  settle_phase: z.boolean().default(false),

  // spec-lock gate 时额外校验存在 `kind=spec-review` evidence 且
  // `actor ≠ implementer`?(rev 4.1 deep 行为)。要求 spec_phase=true
  strict_spec_review: z.boolean().default(false),

  // SETTLE.lessons 强制 append?(rev 5.x: deep MUST = "must";
  // quick / light / standard skip = "skip" — standard 不再走 SETTLE,
  // 故 "may" 在内置 PRESETS 里不再被使用,但 enum 保留以便 3rd-party
  // skill 自定义 preset 选择)。要求 settle_phase=true 当值非 "skip"
  lessons_required: z.enum(["must", "may", "skip"]).default("skip"),

  // SETTLE.reconcile 严格 drift?(rev 4.1 deep 行为)。
  // 要求 settle_phase=true
  strict_drift_check: z.boolean().default(false),
})
  .refine((c) => !c.settle_phase || c.verify_phase, {
    message: "ceremony.settle_phase=true requires verify_phase=true (SETTLE.reconcile entry 需要 verify-accept passed)",
  })
  .refine((c) => !c.strict_spec_review || c.spec_phase, {
    message: "ceremony.strict_spec_review=true requires spec_phase=true (no spec, no reviewer)",
  })
  .refine((c) => c.lessons_required === "skip" || c.settle_phase, {
    message: "ceremony.lessons_required ≠ 'skip' requires settle_phase=true (SETTLE.lessons 才能 append)",
  })
  .refine((c) => !c.strict_drift_check || c.settle_phase, {
    message: "ceremony.strict_drift_check=true requires settle_phase=true (SETTLE.reconcile 才能 drift check)",
  });
export type Ceremony = z.infer<typeof Ceremony>;

// ceremony_label is COSMETIC ONLY — CLI does not parse it.
// Skill writes whatever name its PRESETS uses ("quick" / "standard" /
// "deep" / "rapid-fix" / "release-candidate" / etc.). CLI passes it
// through to TUI / state-change line / stderr error messages for
// human readability. Empty string allowed (skill chose no label).
export const CeremonyLabel = z.string();
export type CeremonyLabel = z.infer<typeof CeremonyLabel>;

// 6 task kinds. Each kind has its OWN step enum (see §3).
// rev 3.1: bug-fix folded into behavioral (use task.labels: ["bug"]).
// rev 3.1: chore added for low-ceremony tasks (version bump / config edit).
export const TaskKind = z.enum([
  "behavioral",   // new feature OR bug-fix (use labels[]) — TDD red→implement→refactor
  "structural",   // refactor/rename — implement+refactor (no red)
  "visual-ui",    // UI change — mockup → implement → screenshot-compare
  "docs",         // documentation only — draft → review
  "spike",        // exploration — explore → prototype → record; FORBIDDEN to deliver
  "chore",        // version bump / config edit / single-shot — one-step execute
]);
export type TaskKind = z.infer<typeof TaskKind>;

// Recommended orthogonal labels (informational, not gate-bearing).
// Skills SHOULD use these for cross-cutting categorization.
export const RECOMMENDED_TASK_LABELS = [
  "bug",
  "feature",
  "tech-debt",
  "security",
  "performance",
  "migration",
  "integration",
] as const;

// ─────────────────────────────────────────────────────────────────
// 3. Per-task-kind Step enums (Q6 — A1 / K1 decision)
// ─────────────────────────────────────────────────────────────────
//
// Each task kind has its own state machine. Per-step status lives in
// task.execution.<step>.status (StepStatus enum: na/pending/running/
// passed/failed/waived). "Currently running step" is derivable by
// filtering task.execution for status="running" — no first-class
// state-level cursor field (rev 4.0 ADR-0002).
// AnyStep (union of all step values) is used by snapshots and
// transitions; STEP_TO_KIND below validates kind/step compatibility.

export const BehavioralStep = z.enum([
  "red",          // write failing test (TDD red)
  "implement",    // write impl to make test pass (TDD green)
  "refactor",     // improve without changing behavior
]);
export type BehavioralStep = z.infer<typeof BehavioralStep>;

export const StructuralStep = z.enum([
  "implement",    // perform the refactor
  "refactor",     // polish
]);
export type StructuralStep = z.infer<typeof StructuralStep>;

export const VisualUiStep = z.enum([
  "mockup",              // capture target visual contract / reference
  "implement",           // build/wire UI
  "screenshot-compare",  // capture screenshot, compare to contract
]);
export type VisualUiStep = z.infer<typeof VisualUiStep>;

export const DocsStep = z.enum([
  "draft",        // write docs
  "review",       // peer review
]);
export type DocsStep = z.infer<typeof DocsStep>;

export const SpikeStep = z.enum([
  "explore",      // research / read code
  "prototype",    // throwaway exploratory code
  "record",       // capture spike-finding evidence
]);
export type SpikeStep = z.infer<typeof SpikeStep>;

export const ChoreStep = z.enum([
  "execute",      // one-shot operation (bump version / edit config)
]);
export type ChoreStep = z.infer<typeof ChoreStep>;

// Union of all step values across kinds. Used by snapshots
// (tasks_active_summary.current_step in gate-diagnostic/resume-pack) and
// by transitions to validate step transitions per task kind. There is no
// state-level current_step field (rev 4.0): per-step status lives in
// task.execution.<step>.status. Per-kind validity enforced at runtime
// via STEP_TO_KIND lookup.
export const AnyStep = z.union([
  BehavioralStep,
  StructuralStep,
  VisualUiStep,
  DocsStep,
  SpikeStep,
  ChoreStep,
]);
export type AnyStep = z.infer<typeof AnyStep>;

// Reverse map: which kinds is a step name valid in?
// Used by canTransitionStep + diff-guard for runtime validation.
export const STEP_TO_KIND: Record<string, TaskKind[]> = {
  red: ["behavioral"],
  implement: ["behavioral", "structural", "visual-ui"],
  refactor: ["behavioral", "structural"],
  mockup: ["visual-ui"],
  "screenshot-compare": ["visual-ui"],
  draft: ["docs"],
  review: ["docs"],
  explore: ["spike"],
  prototype: ["spike"],
  record: ["spike"],
  execute: ["chore"],
};

// ─────────────────────────────────────────────────────────────────
// 4. VerifyCheckKind / Applicability / StepStatus / GateName
// ─────────────────────────────────────────────────────────────────

// VERIFY check kinds — data, not sub-state. Extensible without protocol bumps.
export const VerifyCheckKind = z.enum([
  "run",          // test + lint + type-check
  "review",       // quality reviewer (spec_fit + quality_fit)
  "acceptance",   // selected Gherkin E2E scenarios
  "visual",       // visual contract verification
  // future v1.x: "security" | "performance" | "accessibility"
]);
export type VerifyCheckKind = z.infer<typeof VerifyCheckKind>;

// Applicability — 3-tier (Q5 dropped `should`).
// Soft-suggestion semantics live in loaf-skill, not protocol.
export const Applicability = z.enum([
  "must",         // required; blocks gate when not passed/waived
  "optional",     // user choice; never blocks gate
  "na",           // computed: not applicable to this task/profile/scope
]);
export type Applicability = z.infer<typeof Applicability>;

// Step / check execution status.
// Q5: MUST obligations can only be `passed` or `waived`, never silently `skipped`.
// `skipped` removed entirely from protocol.
export const StepStatus = z.enum([
  "na",           // applicability=na (computed)
  "pending",      // applicable but not started
  "running",      // in-flight
  "passed",       // satisfied
  "failed",       // attempted, did not satisfy
  "waived",       // explicit human waiver via `loaf waive` (requires reason)
]);
export type StepStatus = z.infer<typeof StepStatus>;

export const GateName = z.enum(["spec-lock", "verify-accept"]);
export type GateName = z.infer<typeof GateName>;

// ─────────────────────────────────────────────────────────────────
// 5. FindingCategory (6) / FindingAction (6)
// ─────────────────────────────────────────────────────────────────

// Q11: 6 categories. risk-escalation split from new-scope.
export const FindingCategory = z.enum([
  "spec-gap",          // spec silent on this aspect
  "spec-defect",       // spec wrong (covers design-gap)
  "impl-defect",       // implementation wrong (covers visual-defect)
  "test-defect",       // test or test-env wrong (env detail goes in cause)
  "new-scope",         // out of current scope, needs new task
  "risk-escalation",   // task complexity exceeds current profile; triggers profile escalation
]);
export type FindingCategory = z.infer<typeof FindingCategory>;

// 6 finding actions.
export const FindingAction = z.enum([
  "amend-spec",   // → SPEC.spec, spec_version+1, re-pass spec-lock, iter+1
  "amend-tasks",  // → EXECUTE.work, tasks.version+1; auto re-lock if scope/risk escalates
  "fix-impl",     // → EXECUTE.work; event:task_step_reset sets execution.implement.status=pending, iter+1, no version change
  "fix-test",     // → EXECUTE.work; event:task_step_reset sets execution.red.status=pending, iter+1
  "defer",        // close finding, drift recorded in reconcile (current run)
  "backlog",      // close finding, candidate for next feature/lessons.md
]);
export type FindingAction = z.infer<typeof FindingAction>;

// ─────────────────────────────────────────────────────────────────
// 6. EvidenceKind / EvidenceResult
// ─────────────────────────────────────────────────────────────────

// Q13: `manual` + `waiver` are TWO independent kinds.
//   manual:  human-attested verification (I checked it, it works)
//   waiver:  human-attested risk acceptance (I will NOT verify; reason required)
// Both can satisfy obligations (subject to canSatisfy compatibility — §17).
export const EvidenceKind = z.enum([
  "task-summary",   // per-task closing summary
  "verify-review",  // emitted during VERIFY.review (rev 4.0)
  "spec-review",    // deep profile: independent spec reviewer
  "acceptance",     // emitted during VERIFY.acceptance (rev 4.0; Gherkin E2E)
  "visual-review",  // emitted during VERIFY.visual (rev 4.0)
  "gate-decision",  // human gate approval/rejection
  "local-check",    // local test/lint/typecheck run (Q6: was a step, now an evidence kind)
  "manual",         // human verification (kind=manual implies result≠waived)
  "waiver",         // human waiver; actor MUST start with "human:"; reason required
  "spike-finding",  // spike task: explore/prototype output
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

// Q5: waived joins as a first-class result. skipped removed.
export const EvidenceResult = z.enum([
  "passed",
  "failed",
  "approved",
  "rejected",
  "waived",
]);
export type EvidenceResult = z.infer<typeof EvidenceResult>;

// ─────────────────────────────────────────────────────────────────
// 7. EARS Requirement — structured + three-way verifiability (Q12)
// ─────────────────────────────────────────────────────────────────
//
// Q12 (翻牌): drop vague-word blacklist. Replace with structural
// requirement that every REQ must have at least ONE of:
//   (1) measurable: { metric, threshold, unit }
//   (2) verified_by_scenarios: ["SCEN-..."]
//   (3) acceptance_na: true with acceptance_na_reason: string
// Enforced at spec-lock (see SPEC_LOCK_CHECKS).
//
// Linguistic style (vague words) is loaf-skill's concern, not protocol's.

const ReqId = z.string().regex(/^REQ-[A-Z][A-Z0-9]*-\d{3,}$/);
const ScenId = z.string().regex(/^SCEN-[A-Z][A-Z0-9-]*-\d{3,}$/);
const VisId  = z.string().regex(/^VIS-[A-Z][A-Z0-9-]*-\d{3,}$/);

export const Measurable = z.object({
  metric: z.string().min(3),       // e.g. "time_to_dashboard_visible"
  threshold: z.union([z.string(), z.number()]),
  unit: z.string().optional(),     // "ms", "MB", "rps", ...
  direction: z.enum(["lte", "gte", "eq"]).default("lte"),
});

// Three-way verifiability tagged onto every requirement.
const VerifiabilityFields = z.object({
  measurable: Measurable.optional(),
  verified_by_scenarios: z.array(ScenId).optional(),
  acceptance_na: z.literal(true).optional(),
  acceptance_na_reason: z.string().min(10).optional(),
}).refine(
  (v) => {
    const hasMeasurable = v.measurable !== undefined;
    const hasScenarios  = v.verified_by_scenarios && v.verified_by_scenarios.length > 0;
    const hasNa         = v.acceptance_na === true && (v.acceptance_na_reason?.length ?? 0) >= 10;
    return hasMeasurable || hasScenarios || hasNa;
  },
  { message: "every REQ must declare measurable, verified_by_scenarios[], or acceptance_na+reason" },
);

const ReqBase = z.object({
  id: ReqId,
});

export const RequirementUbiquitous = ReqBase.extend({
  type: z.literal("ubiquitous"),
  response: z.string().min(10),
}).and(VerifiabilityFields);

export const RequirementEventDriven = ReqBase.extend({
  type: z.literal("event-driven"),
  trigger: z.string().min(5),
  response: z.string().min(10),
}).and(VerifiabilityFields);

export const RequirementStateDriven = ReqBase.extend({
  type: z.literal("state-driven"),
  while_: z.string().min(5),       // `while` reserved
  behavior: z.string().min(10),
}).and(VerifiabilityFields);

export const RequirementOptional = ReqBase.extend({
  type: z.literal("optional"),
  feature: z.string().min(5),
  response: z.string().min(10),
}).and(VerifiabilityFields);

export const RequirementUnwanted = ReqBase.extend({
  type: z.literal("unwanted"),
  condition: z.string().min(5),
  response: z.string().min(10),
}).and(VerifiabilityFields);

// EARS — 5 canonical types (Mavin/Wilkinson 2009).
export const EarsType = z.enum([
  "ubiquitous",
  "event-driven",
  "state-driven",
  "optional",
  "unwanted",
]);
export type EarsType = z.infer<typeof EarsType>;

// Note: zod discriminatedUnion does not combine with .and(); we use union for runtime.
export const RequirementEars = z.union([
  RequirementUbiquitous,
  RequirementEventDriven,
  RequirementStateDriven,
  RequirementOptional,
  RequirementUnwanted,
]);
export type RequirementEars = z.infer<typeof RequirementEars>;

// ─────────────────────────────────────────────────────────────────
// 8. Gherkin Scenario
// ─────────────────────────────────────────────────────────────────

export const ScenarioGherkin = z
  .object({
    id: ScenId,
    name: z.string().min(3),
    tag: z.enum(["happy", "edge", "error", "e2e"]).optional(),
    requires_acceptance: z.boolean().optional(),
    acceptance_na: z.string().min(5).optional(),
    given: z.array(z.string().min(3)).min(1),
    when: z.array(z.string().min(3)).min(1),
    then: z.array(z.string().min(3)).min(1),
  })
  .refine(
    (s) => !(s.tag === "e2e" && s.acceptance_na && s.requires_acceptance),
    { message: "cannot set both requires_acceptance and acceptance_na" },
  );
export type ScenarioGherkin = z.infer<typeof ScenarioGherkin>;

// ─────────────────────────────────────────────────────────────────
// 9. Visual Contract
// ─────────────────────────────────────────────────────────────────

export const VisualContract = z.object({
  id: VisId,
  target: z.string().min(3),
  checks: z.array(z.string().min(3)).min(1),
  requires_visual: z.boolean().optional(),
  visual_na: z.string().min(5).optional(),
});
export type VisualContract = z.infer<typeof VisualContract>;

// ─────────────────────────────────────────────────────────────────
// 10. SpecFrontmatter (rev 3.1 batch: adr_refs[])
// ─────────────────────────────────────────────────────────────────

export const NeedsClarification = z.object({
  id: z.string().regex(/^NC-\d{3,}$/),
  question: z.string().min(5),
  context: z.string().optional(),
  options: z.array(z.string()).optional(),
});

export const SpecFrontmatter = z.object({
  schema_version: SchemaVersion,
  spec_version: z.number().int().positive(),
  feature: z.object({
    id: z.string().regex(/^F-\d{3,}$/),
    name: z.string().min(3),
  }),
  intent: z.string().min(20),
  // rev 3.1: external ADR references; loaf does not track architecture, only references it.
  adr_refs: z.array(z.string()).default([]),
  requirements: z.array(RequirementEars),
  scenarios: z.array(ScenarioGherkin),
  visual_contracts: z.array(VisualContract).optional(),
  needs_clarification: z.array(NeedsClarification),
});
export type SpecFrontmatter = z.infer<typeof SpecFrontmatter>;

// ─────────────────────────────────────────────────────────────────
// 11. PendingPrompt — TUI signal for "session blocked on user input"
// ─────────────────────────────────────────────────────────────────
//
// rev 4.1: pending is a FIFO QUEUE (was single-valued in rev 3.x / 4.0).
//   - state.json.pending is PendingPromptEntry[] (default []; see §12)
//   - head element (pending[0]) is the active blocker
//   - Protocol-level enforcement is MINIMAL (rev 4.1 Q3, protocol.md §10.7):
//     `loaf advance` exits 2 PENDING_BLOCKS_ADVANCE iff
//     head.kind ∈ {gate_decision, profile_escalation}. All other
//     commands are NOT blocked by pending; skill workflow consults
//     `loaf pending list` for fan-out scheduling. The blocks field on
//     PendingPromptEntry is descriptive metadata, not enforcement input.
//   - resolve always pops head; FIFO discipline strict in v1.0
//   - queued entries auto-promote when head resolves
//
// Why the queue: rev 4.0 introduced EXECUTE.work sub-agent fan-out
// (multiple workers concurrently in_progress). Single-valued pending
// forced serialization — one worker hitting profile_escalation blocked
// all workers. Queue allows fan-out workers to each raise their own
// pending and continue independently; user services queue head-first.
//
// Upgrade from §16 non-goal "多 pending 队列 v1.1 再考虑" → v1.0
// (see ADR-0003 Addendum 2; protocol.md §4.1 + §14.3).

// rev 4.1: pending-id allocated by CLI, monotonic per feature, under
// per-session .lock (same discipline as EvidenceId). Callers MUST NOT
// supply --id flag; CLI rejects with exit 2.
export const PendingId = z.string().regex(/^PEND-\d{4,}$/);

export const PendingPromptKind = z.enum([
  "ask_user_question",
  "gate_decision",
  "spec_clarification",
  "finding_decision",
  "profile_escalation",
]);

// PendingPrompt is the shape callers (hooks / sub-agents / CLI) build
// when they need to raise a blocker. CLI wraps it into a
// PendingPromptEntry by adding pending_id + at on append.
export const PendingPrompt = z.object({
  kind: PendingPromptKind,
  question: z.string().min(3),
  options: z.array(z.string()).optional(),
  blocks: z.enum(["advance", "gate", "deliver", "all"]).default("advance"),
  raised_at: z.string().datetime(),
  raised_by: z.string().min(1),
});
export type PendingPrompt = z.infer<typeof PendingPrompt>;

// rev 4.1: persisted form. Each entry in state.pending[] is wrapped
// with a CLI-allocated id and (optional) fan-out provenance.
export const PendingPromptEntry = PendingPrompt.extend({
  pending_id: PendingId,
  // CLI stamps `at` when the entry is appended to the queue. Distinct
  // from raised_at (caller stamps raised_at when the prompt is built;
  // these may differ if the caller is queued waiting on the lock).
  at: z.string().datetime(),
  // Fan-out provenance: which worker task raised this. Optional because
  // some pending (e.g. spec_clarification at SPEC.spec) are session-
  // level, not task-level.
  raised_by_task_id: z.string().regex(/^T-\d{3,}$/).optional(),
});
export type PendingPromptEntry = z.infer<typeof PendingPromptEntry>;

// ─────────────────────────────────────────────────────────────────
// 12. state.json — StateProjection (rev 5.0 / Phase 15 SC1; journal-derived)
// ─────────────────────────────────────────────────────────────────
//
// rev 5.0 (ADR-0005 §3.1): state.json is no longer the canonical truth source —
// it is a derived projection at `.loaf/<feature>/snapshots/state.json`, rebuilt
// by the reducer from `event:phase_advanced` / `event:ceremony_set` /
// `pending:added|resolved` / `gate:decided` / `session:*` journal entries.
// Mutation is never direct; every change goes through `loaf <subcommand>` →
// journal append (§11.2) → reducer apply → snapshot rebuild. Readers MUST run
// the §10.15 / Gate #5 fast-check against `snapshots/_meta.json` before parsing
// this projection; mismatch → exit 2 SNAPSHOT_STALE_REBUILD_REQUIRED, no silent
// cached-snapshot fallback.
//
// Phase 15 SC1 (F-019) split the old monolithic `StateJson` into
// `StateProjection` (the FULLY journal-derived half — below) and
// `SessionRuntimeFile` (§12b — machine-local `cwd` / `debug` /
// `heartbeat_at`, never replay-derived, never written by `--rebuild`).
// `complexity_score` has no journal source and is `null` until a future
// TRIAGE-scoring slice; `session_label` / `loaf_version_required` are
// nullable so a pre-SC1 (legacy) `session:started` entry still projects.
//
// rev 4.0: StateProjection carries session-level state ONLY (state machine
// position + identity + control). Active-set detail is NOT
// stored here — it lives in `snapshots/tasks.json` (rev 5.0 reader path;
// worker active set via task.status="in_progress") and is expressed via
// sub_state for control phase intent (e.g. VERIFY.review when running the
// review check). See ADR-0002 for the worker/control phase typology.
//
// workspace is reserved for multi-worktree/team display. v1 does NOT
// wire any gate or path logic to it; pure display field.

export const StateProjection = z
  .object({
    schema_version: SchemaVersion,
    // nullable: a pre-SC1 `session:started` entry carries no version pin.
    // Widened (codex r181 → r182) to accept semver prerelease + build
    // metadata, so CLI-derived `^${packageJson.version}` round-trips
    // even when the package is `0.1.0-rc.1` / `0.2.0-alpha.1` / etc.
    // Backward-compatible — old `^0.1.0` / `~1.0` pins still parse.
    loaf_version_required: z
      .string()
      .regex(/^[\^~]?\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/)
      .nullable(),

    // ── Identity ──
    // session_id mirrors the journal `SessionStartedPayload` (min 1) — the
    // CLI-generated value is always a UUID in practice.
    session_id: z.string().min(1),
    // nullable: a pre-SC1 `session:started` entry carries no label.
    session_label: z.string().min(3).nullable(),
    workspace: z.string().default("default"),  // v1: display only; legacy → "default"

    // ── State machine ──
    // rev 4.0: sub_state precisely identifies control-phase intent
    // (e.g. VERIFY.run vs VERIFY.review). Worker phase EXECUTE.work does
    // NOT identify "which task" — that comes from tasks.json filter.
    phase: Phase,
    sub_state: SubState,

    // rev 4.0 NOTE: current_task / current_step / current_check fields
    // REMOVED. Their information sources:
    //   • "which tasks are active"  → tasks.json.tasks.filter(t => t.status === "in_progress")
    //   • "current step of task T"  → task.execution.<step>.status === "running"
    //   • "which verify check"      → sub_state ∈ {VERIFY.run, VERIFY.review,
    //                                  VERIFY.acceptance, VERIFY.visual}
    // DONE.* terminal invariant about active-set is enforced by
    // transitions.ts (cross-file: tasks.json + state.json), not by
    // single-file Zod refine. See ADR-0002 "consequences" section.

    // ── Iteration ──
    iteration: z.number().int().positive(),

    // ── Gate approval flags ──
    // spec_locked: flipped by `gate:decided gate_kind=spec-lock decision=approved`.
    //   The gate itself does NOT move the cursor (Slice 1.A normalization);
    //   `event:phase_advanced` SPEC.design → EXECUTE.plan is emitted in the
    //   same batch to advance.
    // verify_accepted: parallel flag for `gate:decided verify-accept approved`.
    //   Cursor moves to DONE.delivered (standard) / SETTLE.reconcile (deep)
    //   via subsequent `loaf deliver` / `loaf settle` command, NOT the gate.
    spec_locked: z.boolean(),
    verify_accepted: z.boolean(),

    // ── Pending user interactions (FIFO queue, rev 4.1) ──
    // pending[0] is the active blocker; queued entries auto-promote
    // when head resolves. Empty array = no blocker.
    // Protocol enforcement is minimal (rev 4.1 Q3): only `loaf advance`
    // is blocked, and only when head.kind ∈ {gate_decision,
    // profile_escalation}. All other commands run regardless of queue
    // depth — see protocol.md §10.7. FIFO strict in v1.0.
    pending: z.array(PendingPromptEntry).default([]),

    // ── Ceremony & scoring(rev 4.2:Profile enum 砍,ceremony hybrid B+label)──
    // CLI logic 走 ceremony.* 6 flag;ceremony_label 仅 cosmetic display(skill 写入)
    ceremony: Ceremony,
    ceremony_label: CeremonyLabel.default(""),
    // No journal source yet — `null` until a TRIAGE-scoring slice (F-019).
    complexity_score: z.number().int().min(0).max(100).nullable(),

    // ── Version refs ──
    based_on: z.object({
      spec: z.number().int().nonnegative(),
      tasks: z.number().int().nonnegative(),
    }),

    // Slice 1.B sub-cycle 3c (codex r19 watch point #1): public mapping
    // of the runtime `SessionState.spec_version` live counter. Mirrors
    // the spec.md projection live counter, distinct from `based_on.spec`
    // (which is the frozen tasks-graph anchor). `default(0)` is
    // backward-compat only — the future state-snapshot writer MUST
    // serialize `spec_version` explicitly; relying on the default would
    // hide a projection-writer bug.
    spec_version: z.number().int().nonnegative().default(0),

    // ── Timestamps ──
    // created_at = `session:started` envelope; updated_at = last entry.
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .refine((s) => s.sub_state.startsWith(s.phase + "."), {
    message: "sub_state must start with phase + '.'",
  })
  // rev 4.0: DONE.* terminal invariant (single-file part).
  // The active-set part of the invariant — "no task is in_progress" — is
  // cross-file (state.json × tasks.json) and is enforced by
  // transitions.ts at `loaf advance` / `loaf tasks check` time, since Zod
  // refines cannot inspect tasks.json. See ADR-0002.
  .refine(
    (s) => {
      if (!s.phase.startsWith("DONE")) return true;
      // rev 4.1: empty queue invariant at DONE.* terminal states.
      // The active-set part of the invariant — "no task is in_progress"
      // — is cross-file (state.json × tasks.json) and stays in
      // transitions.ts.
      return s.pending.length === 0;
    },
    { message: "DONE.* requires pending = [] (active-set invariant enforced cross-file by transitions.ts)" },
  );
export type StateProjection = z.infer<typeof StateProjection>;

// ─────────────────────────────────────────────────────────────────
// 12b. SessionRuntimeFile — machine-local / liveness (Phase 15 SC1)
// ─────────────────────────────────────────────────────────────────
//
// The non-journal half of the old `StateJson` monolith. These fields have
// no journal source and cannot be replay-derived: `cwd` is a machine path,
// `debug` a per-invocation runtime flag, `heartbeat_at` a liveness ping.
// `loaf doctor --rebuild` NEVER reads or writes this file — it is owned by
// the live CLI, outside the snapshot-projection / replay-proof contract.
// `session_id` correlates the file with its session.
//
// The on-disk location + the live writer are a later Phase 15 slice; SC1
// defines the contract so the StateProjection split is complete.
export const SessionRuntimeFile = z
  .object({
    schema_version: SchemaVersion,
    session_id: z.string().min(1),
    cwd: z.string(),
    debug: z.boolean(),
    heartbeat_at: z.string().datetime(),
  })
  .strict();
export type SessionRuntimeFile = z.infer<typeof SessionRuntimeFile>;

// ─────────────────────────────────────────────────────────────────
// 13. Registry — per-session file (Q15 翻牌)
// ─────────────────────────────────────────────────────────────────
//
// Q15: ~/.loaf/registry.jsonl is replaced by ~/.loaf/registry/<session_id>.json
//
//   - One file per session (no shared JSONL = no concurrent-write race)
//   - Write via atomic temp+rename (POSIX guaranteed)
//   - File permission: 0600 (owner only)
//   - Stale detection: fs.stat().mtime > 30 days → eligible for GC
//   - TUI startup: readdir(~/.loaf/registry/) + parallel reads
//   - Compaction: delete files (POSIX unlink atomic)
//
// The per-file shape (whole-file overwrite, not append):

// rev 4.0: RegistryFile is TUI metadata (~/.loaf/registry/<id>.json,
// not a top-level protocol artifact in .loaf/<feature>/). It mirrors
// state.json control fields + carries derived projections so TUI can
// render session info with one file read (§14 microsecond startup goal).
//
// rev 4.0 changes:
//   - Drops 3 fields vs rev 3.2 (current_task / current_step / current_check)
//     to match StateJson; active set lives in tasks.json (worker phase).
//   - Gains `active_tasks` (derived from tasks.json filter).
//   - Gains `feature` (C9' — derived projection of .loaf/<feature>/ dir
//     name). Rationale: TUI startup readdir(~/.loaf/registry/) cannot
//     parse feature name from this file path (path only has session_id
//     UUID); without this field TUI must do N additional readdir+parse
//     per session, breaking §14 microsecond startup goal. StateJson does
//     NOT carry `feature` because its path already contains the dir name
//     (reader can derive via path.basename — see ADR-0002 alternatives).
//
// rev 4.1: best-effort projection semantics — RegistryFile is NEVER
// canonical truth. atomic rename protects single-file integrity, but
// cross-file transactions (state.json + tasks.json + registry rewrite)
// have a crash window where the registry may lag the canonical
// artifacts. TUI MUST tolerate stale data and mark sessions as
// `⚠ stale` when registry `at` is older than the corresponding
// snapshots/state.json heartbeat_at by more than threshold. Gate /
// blocking decisions NEVER read registry — they recompute from
// canonical truth (rev 5.0: journal.jsonl + attachments/<entry_id>/;
// see §5 lead paragraph + ADR-0005 §3.1 / §3.6). Use `loaf doctor
// --rebuild-registry` to fully rebuild registry from canonical truth
// (full journal replay → snapshot rebuild → registry refresh; see
// CONCURRENCY_INVARIANTS.transaction_order steps 8-9). See protocol.md
// §4.12 + §13.1 (Derived projection tier).
//
// See ADR-0002 (C4 + C6 + C9') and ADR-0003 (rev 4.1 best-effort
// projection declaration).
export const RegistryFile = z.object({
  schema_version: SchemaVersion,
  at: z.string().datetime(),               // = last update mtime
  session_id: z.string().uuid(),
  session_label: z.string(),               // human display (e.g. "popposhell · 添加登录方式")
  // rev 4.0 C9': feature scope machine identifier. Derived projection
  // of basename(.loaf/<feature>/) dir at write time. Used by TUI for
  // single-file-read display of "which feature is this session doing".
  // Invariant (cross-file, enforced by transitions.ts): equals
  // path.basename(dirname(corresponding state.json file)).
  feature: z.string().regex(/^[a-z][a-z0-9-]+$/).min(2),
  cwd: z.string(),
  workspace: z.string(),
  phase: Phase,
  sub_state: SubState,
  iteration: z.number().int().positive(),

  // rev 4.0: derived projection from tasks.json filter
  //   tasks.filter(t => t.status === "in_progress").map(t => t.id)
  // Empty array when no task is active (e.g. control phases or DONE.*).
  // Written by loaf-cli at every advance/transition; readers (TUI / hook
  // / status) treat as cache, never single source of truth.
  active_tasks: z.array(z.string().regex(/^T-\d{3,}$/)).default([]),

  // rev 4.1: derived projection of state.pending FIFO queue.
  //   pending          = state.pending[0] (head) OR null when queue empty
  //   pending_queue_depth = state.pending.length (total including head)
  // TUI uses this pair to render "⏸ ask [×N]" badge — N = depth, single
  // file read suffices. Like other RegistryFile fields, this is a
  // best-effort projection (see §13 doc) — never gate authority.
  pending: PendingPromptEntry.nullable(),
  pending_queue_depth: z.number().int().nonnegative().default(0),

  // rev 4.2: 跟 StateJson 一致换 Ceremony hybrid B+label。
  // TUI 显示用 ceremony_label(human-readable preset name);
  // 若需详细 ceremony flag 状态(deep / strict etc.),TUI fall back
  // 到 canonical .loaf/<feature>/state.json 直接读 ceremony object。
  // RegistryFile 投影里只放 label 节省 deserialize 成本。
  ceremony_label: CeremonyLabel.default(""),
});
export type RegistryFile = z.infer<typeof RegistryFile>;

// ─────────────────────────────────────────────────────────────────
// 14. Task — discriminated union by kind; orthogonal labels[]
// ─────────────────────────────────────────────────────────────────
//
// rev 3.1:
//   - bug-fix removed; tag bug tasks with labels: ["bug"] on a behavioral task
//   - chore kind added (single-step `execute`)
//   - per-kind execution shape (steps depend on kind)
//   - tasks.execution.status is CACHE; evidence.jsonl is proof source.
//     `loaf tasks check` reconciles them. Don't trust execution.status alone.

export const TaskExecutionStep = z.object({
  applicability: Applicability,
  status: StepStatus,
  reason: z.string().optional(),
  evidence_refs: z.array(z.string().regex(/^EV-\d{6,}$/)).default([]),  // Q7: stable IDs
  // rev 4.1: worker fan-out 时记录 step 开始时间;`loaf doctor`
  // stale-claim check 用(started_at > 30 min + 无 evidence 新增 =
  // worker 死了或卡住,可 --fix 回 ready 让其它 worker 重 claim)
  // CLI 在 `loaf tasks step start` 时写入;status 离开 "running" 时清空
  started_at: z.string().datetime().optional(),
});
export type TaskExecutionStep = z.infer<typeof TaskExecutionStep>;

export const BehavioralExecution = z.object({
  red: TaskExecutionStep,
  implement: TaskExecutionStep,
  refactor: TaskExecutionStep,
});

export const StructuralExecution = z.object({
  implement: TaskExecutionStep,
  refactor: TaskExecutionStep,
});

export const VisualUiExecution = z.object({
  mockup: TaskExecutionStep,
  implement: TaskExecutionStep,
  "screenshot-compare": TaskExecutionStep,
});

export const DocsExecution = z.object({
  draft: TaskExecutionStep,
  review: TaskExecutionStep,
});

export const SpikeExecution = z.object({
  explore: TaskExecutionStep,
  prototype: TaskExecutionStep,
  record: TaskExecutionStep,
});

export const ChoreExecution = z.object({
  execute: TaskExecutionStep,
});

const TaskId = z.string().regex(/^T-\d{3,}$/);
const DrivesRef = z
  .string()
  .regex(/^(REQ|SCEN|VIS)-[A-Z][A-Z0-9-]*-\d{3,}$/);

const TaskBase = z.object({
  id: TaskId,
  drives: z.array(DrivesRef).optional(),
  depends_on: z.array(TaskId).default([]),
  labels: z.array(z.string()).default([]),       // rev 3.1: orthogonal labels
  // pending = initial (after spec freeze)
  // ready   = EXECUTE.plan finished allocating per-task execution policy;
  //           claimable by a worker (protocol.md §6 EXECUTE.plan, §10.8 `loaf tasks claim`)
  // in_progress = a worker has claimed it and is running steps
  // done | abandoned = terminal
  status: z.enum(["pending", "ready", "in_progress", "done", "abandoned"]),
});

// Slice C SC-C4 (R2): the creation-time `labels=['bug'] => red_test_registered`
// refine is removed. red_test_registered is runtime state set by
// `loaf tasks register-red`; a bug task is born unregistered. The bug-RED
// rule moved to runtime preflight (BUG_TASK_REQUIRES_RED at the implement
// step) + verify-accept (BUG_TASK_RED_NOT_REGISTERED). The field stays
// optional on the full payload so the reducer can set it and it round-trips
// on replay. See protocol.md §9.3 + src/core/reducer/preflight.ts.
export const TaskBehavioral = TaskBase.extend({
  kind: z.literal("behavioral"),
  drives: z.array(DrivesRef).min(1),
  tests: z.array(z.string().min(3)).min(1),
  test_layer: z.enum(["unit", "integration", "e2e"]).optional(),
  red_test_registered: z.boolean().optional(),
  execution: BehavioralExecution,
  requires_acceptance: z.boolean().optional(),
  requires_visual: z.boolean().optional(),
});

export const TaskStructural = TaskBase.extend({
  kind: z.literal("structural"),
  no_test_rationale: z.string().min(10),
  execution: StructuralExecution,
});

export const TaskVisualUi = TaskBase.extend({
  kind: z.literal("visual-ui"),
  visual_contract_refs: z.array(VisId).min(1),
  no_test_rationale: z.string().min(10).optional(),
  execution: VisualUiExecution,
});

export const TaskDocs = TaskBase.extend({
  kind: z.literal("docs"),
  no_test_rationale: z.string().min(10),
  execution: DocsExecution,
});

export const TaskSpike = TaskBase.extend({
  kind: z.literal("spike"),
  no_test_rationale: z.string().min(10),
  execution: SpikeExecution,
  // Note: spike tasks may NOT result in DONE.delivered.
  // Exits: DONE.archived, or `loaf spike convert` (records to_feature +
  // archives the spike session; the new feature is opened separately).
});

export const TaskChore = TaskBase.extend({
  kind: z.literal("chore"),
  no_test_rationale: z.string().min(10),
  execution: ChoreExecution,
});

// Zod 4: `.refine()` returns a ZodObject, so discriminatedUnion accepts the
// schema directly — no `.sourceType()` unwrap (a removed Zod 3 ZodEffects
// method). TaskBehavioral no longer carries a refine post-R2 either.
export const Task = z.discriminatedUnion("kind", [
  TaskBehavioral,
  TaskStructural,
  TaskVisualUi,
  TaskDocs,
  TaskSpike,
  TaskChore,
]);
export type Task = z.infer<typeof Task>;

export const TasksJson = z.object({
  schema_version: SchemaVersion,
  version: z.number().int().positive(),
  based_on: z.object({ spec: z.number().int().positive() }),
  tasks: z.array(Task),
});
export type TasksJson = z.infer<typeof TasksJson>;

// ─────────────────────────────────────────────────────────────────
// 15. evidence.jsonl — stable evidence_id (Q7) + hashed attachments (Q14)
// ─────────────────────────────────────────────────────────────────
//
// Append-only. Each line has a stable evidence_id never derived from
// line number. All cross-references (tasks/findings/reconcile) use ID.
//
// actor: free string with recommended prefix:
//   human:<identifier>             e.g. "human:est9"
//   skill:<plugin>/<skill>         e.g. "skill:loaf-cli/sdd-spec"
//   cli:loaf                       (the CLI itself, for system events)
//   ci:<job>                       (for CI runners)

// FeatureId is referenced by FindingsEvent.refs below. ReqId / ScenId /
// VisId are declared at the spec-items section above (search "const ReqId");
// TaskId is declared at the TaskBase section above.
const FeatureId = z.string().regex(/^F-\d{3,}$/);

// evidence.covers: anything a piece of evidence is grounding. REQ/SCEN/VIS
// (spec items) + T-NNN (task completion proof). Feature-level refs go on
// FindingsEvent.refs, not evidence.covers, since evidence is always task-
// or spec-item-scoped (protocol.md §4.4).
//
// rev 4.3 fix: previous single regex `^(REQ|SCEN|VIS|T)-[A-Z][A-Z0-9-]*-\d{3,}$`
// silently rejected T-NNN (TaskId has no middle namespace segment), making
// the documented evidence.covers:["T-001"] path schema-invalid.
const CoversRef = z.union([ReqId, ScenId, VisId, TaskId]);

// Q14: attachment is now an object with hash + mime, not just a path.
export const Attachment = z.object({
  path: z.string().min(3),                              // relative to feature dir
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mime: z.string().min(3),
  bytes: z.number().int().positive().optional(),
});

export const EvidenceEntry = z.object({
  schema_version: SchemaVersion,
  evidence_id: z.string().regex(/^EV-\d{6,}$/),         // Q7: stable monotonic ID
  at: z.string().datetime(),
  kind: EvidenceKind,
  iteration: z.number().int().positive(),

  // ── Identity ──
  actor: z.string().min(1),
  result: EvidenceResult,
  summary: z.string().min(3),

  // ── Coverage assertion (truth source for AC coverage) ──
  covers: z.array(CoversRef).default([]),

  // ── Task linkage ──
  task_id: z.string().regex(/^T-\d{3,}$/).optional(),

  // ── Verify-check linkage ──
  check: VerifyCheckKind.optional(),

  // ── Command details ──
  cmd: z.string().optional(),
  exit: z.number().int().optional(),
  wall_ms: z.number().int().optional(),

  // ── Gate-decision specifics ──
  gate: GateName.optional(),
  decided_by: z.string().optional(),
  reason: z.string().optional(),
  based_on: z
    .object({
      spec: z.number().int().nonnegative(),
      tasks: z.number().int().nonnegative(),
    })
    .optional(),

  // ── Visual-review attachments (Q14: object form) ──
  attachments: z.array(Attachment).optional(),

  // ── Waiver-specifics (Q13) ──
  // kind=waiver requires: actor starts with "human:", reason >= 10 chars
  waiver_obligation_id: z.string().optional(),          // ID of waived obligation

  // ── Caller correlation (rev 4.1) ──
  // Optional free-form ID for callers to correlate this evidence with
  // their own logging (e.g. agent run id, CI job id). CLI never uses
  // it for protocol logic.
  external_ref: z.string().optional(),
});
export type EvidenceEntry = z.infer<typeof EvidenceEntry>;

// rev 4.1: EvidenceAddInput — the shape accepted by `loaf evidence add`.
// CLI assigns `evidence_id` (monotonic per feature) and stamps `at`
// during the per-session-lock transaction. Callers MUST NOT supply
// either field; CLI MUST reject any `--id` flag with exit 2. This
// prevents EV-id collision under sub-agent fan-out and keeps the
// monotonic ordering invariant. See protocol.md §10.8 + §11.2.
//
// rev 4.3 (ADR-0004 A6): `attachments` collapses to the input shape
// `Array<{ path }>`. CLI computes sha256, infers mime, stat()s bytes,
// canonicalizes the path under `.loaf/<feature>/attachments/<entry_id>/`
// (rev 5.0, ADR-0005 §3.1: directory key is the journal entry_id
// JE-NNNNNN of the emitted `evidence:added` entry, NOT the EV-id; EV-id
// remains in the evidence payload as the projection's stable identifier),
// and materializes the full Attachment object before append. LLM never
// hashes or guesses mime — that is shape transformation owned by CLI.
export const EvidenceAddInput = EvidenceEntry.omit({
  evidence_id: true,
  at: true,
  attachments: true,
}).extend({
  attachments: z
    .array(z.object({ path: z.string().min(1) }))
    .optional(),
});
export type EvidenceAddInput = z.infer<typeof EvidenceAddInput>;

// ─────────────────────────────────────────────────────────────────
// 16. Evidence compatibility (Q8) — canSatisfy(evidence, coveredId)
// ─────────────────────────────────────────────────────────────────
//
// Q8: lightweight compatibility rules. Each rule maps (id-kind → allowed
// evidence kinds). manual + waiver MUST carry override metadata.
//
// Pseudocode (loaf-cli/lib/evidence.ts at impl time):
//
//   function canSatisfy(evidence: EvidenceEntry, coveredId: string): boolean {
//     const idKind = parseIdKind(coveredId);   // REQ | SCEN | VIS | T
//     const rule = EVIDENCE_COMPAT[idKind];
//     if (!rule.allowed.includes(evidence.kind)) return false;
//     if (evidence.kind === "manual" || evidence.kind === "waiver") {
//       if (!evidence.actor.startsWith("human:")) return false;
//       if (!evidence.reason || evidence.reason.length < 10) return false;
//     }
//     return true;
//   }

export const EVIDENCE_COMPAT = {
  REQ: {
    allowed: ["task-summary", "verify-review", "spec-review", "manual", "waiver"] as const,
    manual_requires_reason: true,
  },
  SCEN: {
    allowed: ["acceptance", "manual", "waiver"] as const,
    manual_requires_reason: true,
    note: "SCEN with tag=e2e prefers automated acceptance evidence; manual is allowed with reason",
  },
  VIS: {
    allowed: ["visual-review", "manual", "waiver"] as const,
    manual_requires_reason: true,
    requires_attachment_for_visual_review: true,
  },
  T: {
    allowed: ["task-summary", "local-check", "manual", "waiver"] as const,
    manual_requires_reason: false,
  },
  // Gates are special — only gate-decision evidence satisfies them.
  GATE: {
    allowed: ["gate-decision"] as const,
    manual_requires_reason: false,
  },
} as const;

// ─────────────────────────────────────────────────────────────────
// 17. findings.jsonl — category + action, 2-event lifecycle
// ─────────────────────────────────────────────────────────────────
//
// May be raised in VERIFY.* (always) or EXECUTE.* (only after spec_locked).
//
// NOTE (Phase 14 SC1): `FindingsEvent` below is the LEGACY journal/jsonl
// EVENT schema — the per-event (opened / closed) line form. It is NOT the
// `snapshots/findings.json` projection contract. The `loaf doctor
// --rebuild` projection is the new `FindingsJson` (§30 below): a
// finding-STATE list, not an event log. `FindingsEvent` is retained for
// historical / migration reference; the projection writer never emits it.

export const FindingsEvent = z.discriminatedUnion("event", [
  z
    .object({
      schema_version: SchemaVersion,
      id: z.string().regex(/^FND-\d{3,}$/),
      event: z.literal("opened"),
      at: z.string().datetime(),
      raised_in: SubState,
      raised_by: z.string(),
      iteration: z.number().int().positive(),
      category: FindingCategory,
      action: FindingAction,
      summary: z.string().min(5),
      // findings can point at REQ/SCEN/VIS (spec items), T-NNN (task that
      // surfaced the finding), or F-NNN (feature-scope finding).
      refs: z
        .array(z.union([ReqId, ScenId, VisId, TaskId, FeatureId]))
        .default([]),
      evidence_refs: z.array(z.string().regex(/^EV-\d{6,}$/)).default([]),
      cause: z.string().optional(),                  // for test-defect: "env" | "assertion" | ...
    })
    .refine(
      (f) =>
        f.raised_in.startsWith("VERIFY.") ||
        f.raised_in.startsWith("EXECUTE."),
      { message: "findings only in VERIFY.* or post-lock EXECUTE.*" },
    ),
  z.object({
    schema_version: SchemaVersion,
    id: z.string().regex(/^FND-\d{3,}$/),
    event: z.literal("closed"),
    at: z.string().datetime(),
    iteration: z.number().int().positive(),
    resolution: z.string().min(3),
    drift_index: z.number().int().nonnegative().optional(),
    evidence_refs: z.array(z.string().regex(/^EV-\d{6,}$/)).default([]),
  }),
]);
export type FindingsEvent = z.infer<typeof FindingsEvent>;

// ─────────────────────────────────────────────────────────────────
// 30. snapshots/*.json — `loaf doctor --rebuild` projection containers
//     (Phase 14 SC1 / ADR-0005 §3.6 — findings.md F-018, codex r155+r156)
// ─────────────────────────────────────────────────────────────────
//
// `loaf doctor --rebuild` replays the journal seq=0 and re-serializes the
// fully-journal-derived projection files under `.loaf/<feature>/snapshots/`.
// The runtime mirror of these schemas lives in
// `src/core/projection-schema.ts`; the serializer is
// `src/core/projection-writer.ts`.
//
// `--rebuild` rebuilds the FIVE fully journal-derived files — state.json
// (§12 `StateProjection`) + tasks.json (§14 `TasksJson` above) +
// evidence.json / findings.json / pending.json (the three new containers
// below) — plus `_meta.json`. Phase 15 SC1 (F-019) closed the former
// `state.json` deferral by splitting the old `StateJson` monolith into the
// journal-derived `StateProjection` (§12) and the machine-local
// `SessionRuntimeFile` (§12b), which `--rebuild` never touches.
//
// Container shape (codex r156 Q2): minimal `{schema_version, <items>:[...]}`.
// NO `version` field on Evidence/Findings/Pending — only `TasksJson.version`
// is justified (whole-replacement task-plan contract counts plan + amend
// entries); the other three are append-only ledgers with no equivalent
// counter.

// evidence.json — each item is the journal `evidence:added` payload
// (= §16 `EvidenceEntry` minus the two envelope-owned fields) with
// `schema_version` + `at` re-attached. So the projection item IS the full
// §16 `EvidenceEntry`; the container just wraps the array.
export const EvidenceJson = z.object({
  schema_version: SchemaVersion,
  evidence: z.array(EvidenceEntry),
});
export type EvidenceJson = z.infer<typeof EvidenceJson>;

// findings.json — a finding-STATE list. Each item is the reducer's slim
// finding projection (id / category / action / status + payload-derived
// summary / reason / target). This is NOT the §17 `FindingsEvent` jsonl
// event schema — see the §17 NOTE.
const FindingStateProjection = z.object({
  id: z.string().regex(/^FND-\d{3,}$/),
  category: FindingCategory,
  action: FindingAction,
  status: z.enum(["open", "closed"]),
  summary: z.string().optional(),
  reason: z.string().optional(),
  target: z
    .object({ task_id: z.string().regex(/^T-\d{3,}$/), step: z.string().min(1) })
    .optional(),
});

export const FindingsJson = z.object({
  schema_version: SchemaVersion,
  findings: z.array(FindingStateProjection),
});
export type FindingsJson = z.infer<typeof FindingsJson>;

// pending.json — `PendingProjectionEntry` is the documented §11
// `PendingPromptEntry` fields PLUS `resolved: boolean`. The journal
// `pending:added` payload carries only id / kind / question (+ optional
// options / task_id) and ONE envelope timestamp + actor; the rich
// `PendingPromptEntry` fields are collapsed onto journal truth:
//   raised_at + at ← the single envelope timestamp
//   raised_by      ← the envelope actor
//   blocks         ← the constant "advance" (never carried on payload)
//   resolved       ← true iff a matching `pending:resolved` entry exists
export const PendingProjectionEntry = PendingPromptEntry.extend({
  resolved: z.boolean(),
});
export type PendingProjectionEntry = z.infer<typeof PendingProjectionEntry>;

export const PendingJson = z.object({
  schema_version: SchemaVersion,
  pending: z.array(PendingProjectionEntry),
});
export type PendingJson = z.infer<typeof PendingJson>;

// ─────────────────────────────────────────────────────────────────
// 18. reconcile.json — planned vs actual + verify snapshot
// ─────────────────────────────────────────────────────────────────
//
// SETTLE.reconcile produces this. settle_phase=true (deep) only after
// rev 5.x; quick / light / standard skip SETTLE and do not produce
// reconcile.json. Reducer can rebuild on-demand via `loaf doctor
// --rebuild` from journal entries.
// verify_checks_status here is SNAPSHOT — NOT the gate source.

export const VerifyCheckSnapshot = z.object({
  applicability: Applicability,
  status: StepStatus,
  reason: z.string().optional(),
  evidence_refs: z.array(z.string().regex(/^EV-\d{6,}$/)).default([]),
});

export const IterationStats = z.object({
  total: z.number().int().positive(),
  findings_total: z.number().int().nonnegative(),
  findings_by_action: z.record(FindingAction, z.number().int().nonnegative()),
  findings_by_category: z.record(
    FindingCategory,
    z.number().int().nonnegative(),
  ),
});

export const Drift = z.object({
  path: z.string(),
  category: z.enum(["out_of_planned", "planned_not_touched"]),
  reason: z.string().min(5),
  resolution: z.enum([
    "spec_amended",
    "carried_forward",
    "abandoned",
    "deferred",
  ]),
  finding_id: z.string().regex(/^FND-\d{3,}$/).optional(),
});

export const AcCoverage = z.object({
  ac_id: z.string().regex(/^(REQ|SCEN|VIS)-[A-Z][A-Z0-9-]*-\d{3,}$/),
  evidence_refs: z.array(z.string().regex(/^EV-\d{6,}$/)),
  status: z.enum(["passed", "failed", "waived", "na"]),
});

export const ReconcileJson = z.object({
  schema_version: SchemaVersion,
  based_on: z.object({
    spec: z.number().int().positive(),
    tasks: z.number().int().positive(),
  }),
  planned_scope: z.array(z.string()),
  actual_scope: z.array(z.string()),
  drift: z.array(Drift),
  ac_coverage: z.array(AcCoverage),
  verify_checks_status: z.record(VerifyCheckKind, VerifyCheckSnapshot),
  iteration_stats: IterationStats,
  // rev 4.3 (ADR-0004 A7): finding raise events tagged ActionRisk="unusual"
  // are counted here so reviewers see at a glance how many findings sit in
  // the non-typical band of FINDING_ACTION_GRID. Does not include incoherent
  // attempts (those are blocked at raise time, never landed). Default 0
  // when no unusual findings were raised in this reconcile window.
  unusual_findings_count: z.number().int().nonnegative().default(0),
});
export type ReconcileJson = z.infer<typeof ReconcileJson>;

// ─────────────────────────────────────────────────────────────────
// 19. gate-diagnostic.json (Q10b: borrowed from legacy Python prototype)
// ─────────────────────────────────────────────────────────────────
//
// Written on EVERY gate failure (overwrites previous). loaf-skill reads it,
// feeds diagnostic.code+vars to LLM as repair signal, retries submit.
// Diagnostic message templates live in i18n bundle (loaf-cli/i18n/<lang>.json
// under diagnostic.<code>); CLI renders by LOAF_LANG.

// GateDiagnostic.failures[].code is the canonical DiagnosticCode (§39)
// once §10.5 migration is complete (rev 4.3). Adding new gate-failure
// codes is an ADR-trail addition per §15 freeze rewording. If a
// downstream tool needs to emit a code not yet enumerated, treat it
// as ADR-trail-pending and add to DiagnosticCode in the same change.
export const GateDiagnostic = z.object({
  schema_version: SchemaVersion,
  at: z.string().datetime(),
  gate: z.union([
    GateName,
    z.literal("submit"),         // schema validation failure on `loaf X submit`
    z.literal("transition"),     // illegal state transition
    z.literal("diff-guard"),     // write-guard violation
  ]),
  failures: z.array(
    z.object({
      // rev 4.3: tightened from z.string().min(3) to DiagnosticCode.
      // All known protocol.md §10.5 codes are now registered in §39.
      code: z.lazy(() => DiagnosticCode),
      severity: z.enum(["block", "warn"]),
      ref: z.string().optional(),                    // file path or ID
      line: z.number().int().optional(),             // for spec.md lint
      vars: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
      suggestion: z.string().optional(),             // English fallback when no bundle
    }),
  ),
});
export type GateDiagnostic = z.infer<typeof GateDiagnostic>;

// ─────────────────────────────────────────────────────────────────
// 20. resume-pack.json (Q10b: borrowed from legacy Python prototype)
// ─────────────────────────────────────────────────────────────────
//
// Written by explicit `loaf handoff` only (Q4 batch decision). Context
// overflow detection is loaf-skill's job; loaf-cli only persists the pack.
//
// rev 4.0: state_snapshot is StateProjection (no longer carries current_*).
// To preserve "what was running" information at handoff time, the pack
// also carries tasks_active_summary — a derived snapshot of in-progress
// tasks plus each one's currently running step. Without this, a fresh
// session resuming from the pack cannot tell which tasks were mid-flight.
// See ADR-0002 C6.

export const TasksActiveSummary = z.object({
  task_id: z.string().regex(/^T-\d{3,}$/),
  // Mirrors TaskBase.status. Resume packs surface ready and in_progress
  // tasks so a fresh session knows which tasks are claimable vs mid-flight.
  status: z.enum(["pending", "ready", "in_progress", "done", "abandoned"]),
  // Derived from task.execution.<step>.status === "running".
  // null when no step is currently running (e.g. between steps or paused).
  current_step: z.string().nullable(),
});
export type TasksActiveSummary = z.infer<typeof TasksActiveSummary>;

export const ResumePack = z.object({
  schema_version: SchemaVersion,
  at: z.string().datetime(),
  session_id: z.string().uuid(),
  reason: z.string().min(5),
  state_snapshot: StateProjection,
  // rev 4.0: active-set snapshot, since state_snapshot no longer carries
  // current_task/current_step. Empty array when no task is in_progress.
  tasks_active_summary: z.array(TasksActiveSummary).default([]),
  recent_evidence: z.array(z.string().regex(/^EV-\d{6,}$/)),  // last N evidence_ids
  recent_findings: z.array(z.string().regex(/^FND-\d{3,}$/)),
  open_pending: PendingPrompt.nullable(),
  notes: z.string().optional(),
});
export type ResumePack = z.infer<typeof ResumePack>;

// ─────────────────────────────────────────────────────────────────
// 21. loaf.config.json (Q10a (ii): MERGED project-level config)
// ─────────────────────────────────────────────────────────────────
//
// Single config file at project root. Replaces rev 3's 3 separate files
// (protected-files / stable-core-manifest / constitution).
// All sections are optional; loaf-cli ships sane defaults.

export const LoafConfig = z.object({
  schema_version: SchemaVersion,

  // ── Diff guard / write protection ──
  protected_files: z.array(z.string()).default([]),    // never writable

  // ── Stable core boundary ──
  stable_core: z.array(z.string()).default([]),        // refactor gate guards these

  // ── Path classification ──
  paths: z
    .object({
      source: z.array(z.string()).default(["src/**"]),
      tests: z.array(z.string()).default(["**/test/**", "tests/**"]),
      docs: z.array(z.string()).default(["docs/**", "**/*.md"]),
      ui: z.array(z.string()).default([]),
      public_api: z.array(z.string()).default([]),
      schema: z.array(z.string()).default([]),
      security: z.array(z.string()).default([]),
    })
    .prefault({}),

  // ── Commands (skills + loaf-cli invoke these) ──
  commands: z
    .object({
      run: z.array(z.string()).default([]),            // unit/integration tests
      lint: z.array(z.string()).default([]),
      typecheck: z.array(z.string()).default([]),
      visual: z.array(z.string()).default([]),
      acceptance: z.array(z.string()).default([]),
      build: z.array(z.string()).default([]),
    })
    .prefault({}),

  // ── Constitution (SDD defaults; loaf-skill reads these to tune prompts) ──
  constitution: z
    .object({
      tdd_strictness: z.enum(["strict", "preferred", "advisory"]).default("preferred"),
      // rev 4.2: 原 default_profile: Profile 砍。改用 default_ceremony_label
      // (CLI 不解析,仅 skill 用作默认 preset key)+ default_ceremony
      // (Ceremony object;若 skill PRESETS 表缺 label 时 fallback)
      default_ceremony_label: z.string().default("standard"),
      default_ceremony: Ceremony.optional(),  // 可选;skill 通常用 label 查 PRESETS 表
      require_red_for_behavioral: z.boolean().default(true),
      allow_manual_for_requirement: z.boolean().default(true),
      require_attachment_for_visual: z.boolean().default(true),
      // NOTE: rev 3.2 removed decomposition_preference and
      // max_tasks_warning_threshold (rev 3.1 anti-over-decomposition
      // knobs). ADR-0001 establishes both are workflow content, not
      // protocol shape — the coarse-default bias now lives in
      // loaf-skill's SPEC prompt template, not loaf.config.json.
      // See references/loaf-skill-helpers.md §3.
      //
      // NOTE: verify_cadence was considered and REJECTED — it would
      // require a parallel state machine for per-task vs per-phase
      // verify loops. v1 cadence is fixed at per-phase. Do NOT
      // re-propose; this rejection is preserved across grilling passes.
    })
    .prefault({}),

  // ── Locale (rev 3.1 i18n) ──
  locale: z.object({
    default_lang: z.enum(["en", "zh"]).default("en"),
  }).prefault({}),
});
export type LoafConfig = z.infer<typeof LoafConfig>;

// ─────────────────────────────────────────────────────────────────
// 22. trace.jsonl — observability, --debug only
// ─────────────────────────────────────────────────────────────────

export const TraceEvent = z.object({
  schema_version: SchemaVersion,
  at: z.string().datetime(),
  session_id: z.string().uuid(),
  iteration: z.number().int().positive(),
  sub_state: SubState,
  cmd: z.string(),
  argv: z.array(z.string()),
  exit: z.number().int(),
  wall_ms: z.number().int().nonnegative(),
  stdout_summary: z.string().optional(),
  stderr_summary: z.string().optional(),
});
export type TraceEvent = z.infer<typeof TraceEvent>;

// ─────────────────────────────────────────────────────────────────
// 23. Ceremony presets — SKILL responsibility(rev 4.2)
// ─────────────────────────────────────────────────────────────────
//
// rev 4.2: `ProfilePolicy` + `PROFILE_POLICIES` 表整个砍。
// "quick / standard / deep" 4-tier preset 不再是协议级 enum,而是 skill
// 内部的 PRESETS 表(loaf-skill 提供 4 个默认 preset,3rd-party skill
// 可以提供别的)。CLI 接受任意 Ceremony object,完全不解析 preset 名字。
//
// 这条 ADR-0003 Addendum 6 详述。skill 应该维护一张如下结构的表:
//
//   const PRESETS: Record<string, Ceremony> = {
//     quick:    { spec_phase: false, verify_phase: false, settle_phase: false, ... },
//     light:    { spec_phase: true,  verify_phase: false, settle_phase: false, ... },
//     standard: { spec_phase: true,  verify_phase: true,  settle_phase: false, ... },
//     deep:     { spec_phase: true,  verify_phase: true,  settle_phase: true,
//                 strict_spec_review: true, lessons_required: "must", strict_drift_check: true },
//     // skill 想加 rapid-fix / release-candidate / company-specific 都行
//   };
//
// rev 5.x 决策:standard 不再跑 SETTLE(reconcile snapshot + lessons 都
// 留给 deep 作差异化)。reconcile 数据在 journal 里 reducer 可重算,
// standard 用户需要 audit 走 `loaf doctor --rebuild`。这样 4 档单调
// 递增 ceremony:quick(EXECUTE 直跳 DONE) → light(+SPEC) → standard
// (+VERIFY) → deep(+SETTLE + strict 三件套)。
//
// skill 在 `loaf start` 时:
//   1. 看 complexity_score 推荐 preset 名(skill 自己决定 score → label 映射)
//   2. user 接受或 override preset
//   3. skill 把 PRESETS[label] 这个 Ceremony object + label 字符串 一起
//      传给 CLI(`loaf start --ceremony-json '...' --ceremony-label 'standard'`)
//   4. CLI 写 state.json.ceremony + state.json.ceremony_label,后续所有
//      enforcement 走 ceremony.* 6 flag(label 只 display)
//
// 协议中立:CLI 不绑死任何 preset 名字,任何 skill 可以有自己的命名。

// ─────────────────────────────────────────────────────────────────
// 24. Ceremony escalation triggers — protocol-level conditions
// ─────────────────────────────────────────────────────────────────
//
// rev 4.2: 原 `ESCALATION_RULES` (from/to profile) 砍掉。
// 升档语义改成:CLI 检测到 EscalationTrigger 时 raise
// pending(kind=profile_escalation,保留旧名为了 PendingPromptKind enum
// 不破 §15 freeze;语义改为 "ceremony 升档建议")。
// 当 user 确认后,skill 重新选 preset(可能从 PRESETS.quick 切到
// PRESETS.standard),把新 Ceremony object 写进 state.json。
//
// 具体升档逻辑(quick → standard / standard → deep 等)是 skill 的事;
// CLI 只负责检测 trigger + raise pending。

export const EscalationTrigger = z.enum([
  "scope_expansion",
  "public_api_touched",
  "schema_change",
  "concurrency_touched",
  "security_touched",
]);

// rev 4.2: which Ceremony field changes are "an escalation"?
// (CLI uses this to detect "current ceremony too light for the work")
export const EscalationDetection = z.object({
  // CLI checks: if any of these triggers fires, raise
  // pending(kind=profile_escalation) + skill maps to new preset.
  triggers: z.array(EscalationTrigger).min(1),
  // What ceremony fields SHOULD turn on after escalation:
  // (skill consults this when building new Ceremony object after
  // user confirms; CLI does not enforce specific values, just the
  // pending raise.)
  recommend_enable: z.array(z.enum([
    "spec_phase",
    "verify_phase",
    "settle_phase",
    "strict_spec_review",
    "strict_drift_check",
  ])).default([]),
});

// rev 4.2: which triggers map to which recommendations.
// skill consults this table when responding to profile_escalation
// pending. CLI raises pending; skill picks the new ceremony.
export const ESCALATION_DETECTIONS: Array<z.infer<typeof EscalationDetection>> = [
  // scope_expansion / public_api_touched: light → spec_phase
  {
    triggers: ["scope_expansion"],
    recommend_enable: ["spec_phase"],
  },
  // public_api_touched / schema_change / concurrency_touched / security_touched:
  // → spec_phase + verify_phase + settle_phase (full ceremony)
  {
    triggers: ["public_api_touched", "schema_change", "concurrency_touched", "security_touched"],
    recommend_enable: ["spec_phase", "verify_phase", "settle_phase"],
  },
];

// ─────────────────────────────────────────────────────────────────
// 25. Finding action effects — back-edge transitions
// ─────────────────────────────────────────────────────────────────
//
// rev 4.1: `requires_target_payload` was added because rev 4 cut
// `current_step` from StateJson. Before rev 4.1 the protocol.md table
// expressed fix-impl/fix-test back-edge as `EXECUTE.task(step=implement)`,
// which visually re-introduced the cut `current_step` field as a
// pseudo-cursor. The correct expression is: state transitions to
// EXECUTE.work, and the *step* travels in a FindingResolutionPayload
// that the resolution writes to tasks.<T-N>.execution.<step>.status =
// "pending" to make that step re-run. step is mutation payload, not
// session state.

// FindingResolutionPayload — payload carried by `loaf finding close
// <FND-id>` (or `loaf finding raise --action <X>`) when the action's
// `requires_target_payload` field is "task_id_step". loaf-cli applies
// it as a mutation on tasks.json before/together with the state
// transition (inside the per-session lock; see §34).
export const FindingResolutionPayload = z.object({
  task_id: z.string().regex(/^T-\d{3,}$/),
  step: z.string().min(1),   // valid step set is enforced per task.kind by transitions.ts
});
export type FindingResolutionPayload = z.infer<typeof FindingResolutionPayload>;

export const FindingActionEffect = z.object({
  action: FindingAction,
  next_sub_state: SubState.nullable(),
  iteration_delta: z.union([z.literal(0), z.literal(1)]),
  spec_version_delta: z.union([z.literal(0), z.literal(1)]),
  tasks_version_delta: z.union([z.literal(0), z.literal(1)]),
  resets_spec_locked: z.boolean(),
  may_trigger_relock: z.boolean(),
  // rev 4.1: when set to "task_id_step", `loaf finding raise/close`
  // requires a FindingResolutionPayload. fix-impl/fix-test target a
  // specific task step; amend-tasks may target a task (optional
  // narrowing). Other actions take no payload.
  requires_target_payload: z.enum(["task_id_step", "task_id_optional", "none"]),
});

export const FINDING_ACTION_EFFECTS: Array<
  z.infer<typeof FindingActionEffect>
> = [
  {
    action: "amend-spec",
    next_sub_state: "SPEC.spec",
    iteration_delta: 1,
    spec_version_delta: 1,
    tasks_version_delta: 1,
    resets_spec_locked: true,                 // rev 3.1 batch: enforced invariant
    may_trigger_relock: false,
    requires_target_payload: "none",
  },
  {
    action: "amend-tasks",
    next_sub_state: "EXECUTE.work",
    iteration_delta: 1,
    spec_version_delta: 0,
    tasks_version_delta: 1,
    resets_spec_locked: false,
    may_trigger_relock: true,
    requires_target_payload: "task_id_optional",
  },
  {
    action: "fix-impl",
    next_sub_state: "EXECUTE.work",
    iteration_delta: 1,
    spec_version_delta: 0,
    tasks_version_delta: 0,
    resets_spec_locked: false,
    may_trigger_relock: false,
    requires_target_payload: "task_id_step",   // step must be "implement"
  },
  {
    action: "fix-test",
    next_sub_state: "EXECUTE.work",
    iteration_delta: 1,
    spec_version_delta: 0,
    tasks_version_delta: 0,
    resets_spec_locked: false,
    may_trigger_relock: false,
    requires_target_payload: "task_id_step",   // step must be "red"
  },
  {
    action: "defer",
    next_sub_state: null,
    iteration_delta: 0,
    spec_version_delta: 0,
    tasks_version_delta: 0,
    resets_spec_locked: false,
    may_trigger_relock: false,
    requires_target_payload: "none",
  },
  {
    action: "backlog",
    next_sub_state: null,
    iteration_delta: 0,
    spec_version_delta: 0,
    tasks_version_delta: 0,
    resets_spec_locked: false,
    may_trigger_relock: false,
    requires_target_payload: "none",
  },
];

// ─────────────────────────────────────────────────────────────────
// 26. SubState contracts — entry / exit / write_paths / mutation_rights / prompt_inject
// ─────────────────────────────────────────────────────────────────
//
// Source of truth for hook write-guard and SessionStart prompt-inject.
// EXECUTE.work write_paths are AUGMENTED at runtime by the per-kind step
// table below (STEP_WRITE_PATHS_BY_KIND).
//
// rev 4.1: `mutation_rights` adds field-level granularity beyond
// write_paths glob. write_paths protects WHICH FILES may be touched;
// mutation_rights protects WHICH FIELDS WITHIN those files may be
// changed under the current sub_state. Required for SPEC.plan /
// SPEC.design / EXECUTE.plan / EXECUTE.work where two sub_states
// share the same files (e.g. both EXECUTE.plan and EXECUTE.work can
// write tasks.json, but EXECUTE.plan must NOT change task.drives /
// task.depends_on / task.kind). See protocol.md §8.6.
//
// ───────────────── rev 5.0 semantic shift (ADR-0005) ─────────────────
//
// Mutation authority moved from "file write paths" to "journal entry kind
// emission + per-kind reducer invariants" (ADR-0005 §3.3 / §3.6). The
// `write_paths` and `mutation_rights` arrays below are PRESERVED as a
// **legacy hook-side artifact** for two narrow purposes:
//
//   1. PreToolUse hook glob enforcement of $EDITOR-driven `spec.md` work-
//      draft writes in SPEC.* sub_states (the only user-touchable .loaf/
//      file post-rev-5.0). Source-code writes in EXECUTE.work continue to
//      be globbed via STEP_WRITE_PATHS_BY_KIND.
//   2. diff-guard at `loaf advance` (§11.1): defensive baseline that
//      flags any out-of-allowlist mutation observed in `git status` —
//      since all `.loaf/<feature>/{journal,snapshots,attachments}/*` paths
//      are CLI-only, the legacy `.loaf/<feature>/{state,evidence,findings,
//      reconcile,lessons,tasks}.{json,jsonl,md}` entries below act as a
//      defense-in-depth allowlist for the rev-4 N-file → rev-5 journal
//      transition window. A diff-guard implementation reading these arrays
//      at face value still rejects unauthorized writes; it just needs to
//      also know that rev 5.0 reducer-derived projections live under
//      `snapshots/*.json` (see schema-drift / migration-v0.0.x checks in
//      protocol.md §10.15).
//
// **Authoritative mutation control** in rev 5.0 is the per-kind reducer
// invariants table (ADR-0005 §3.6 + EntryKind enum). Each mutator command
// emits one or more journal entries; preflight (§11.2 step 3) refines
// (kind, payload, actor, sub_state, mutation_rights) and aborts before any
// I/O on violation. The fields below are NOT consulted by reducer apply.
//
// Future work (post-Stage-6, possibly ADR-0007): replace `write_paths`
// arrays with `emitted_kinds: EntryKind[]` (logical mutation surface) and
// migrate `mutation_rights.writable_fields` from `<file>:<path>` syntax to
// `<EntryKind>.payload.<path>` syntax. Out of v0.1.0 scope.

// MutationRights — per-file allowlist/denylist on top-level frontmatter
// or JSON keys. Each key is "<artifact-file>:<jsonpath-or-dot-path>".
// Glob is allowed in the jsonpath. Empty `writable_fields` means "all
// fields in any allowed write_paths file may be written" (default
// — falls back to write_paths glob). Empty `forbidden_fields` means
// "no further restriction beyond writable_fields". If both arrays are
// set, writable_fields wins as a positive allowlist.
export const MutationRights = z.object({
  writable_fields: z.array(z.string()).default([]),
  forbidden_fields: z.array(z.string()).default([]),
});
export type MutationRights = z.infer<typeof MutationRights>;

export const SubStateContract = z.object({
  sub_state: SubState,
  entry: z.string(),
  exit: z.string(),
  write_paths: z.array(z.string()),
  // rev 4.1: optional field-level mutation rights. Defined for sub_states
  // where files alone do not disambiguate (e.g. SPEC.plan vs SPEC.design
  // both touch spec.md). Undefined = no field-level restriction beyond
  // write_paths.
  mutation_rights: MutationRights.optional(),
  next: z.array(SubState),
  prompt_inject: z.string(),
});

export const SUB_STATE_CONTRACTS: Array<z.infer<typeof SubStateContract>> = [
  // ─── TRIAGE ───
  {
    sub_state: "TRIAGE.score",
    entry: "loaf start <desc> invoked",
    exit: "complexity_score computed (0-100)",
    write_paths: [".loaf/<feature>/state.json"],
    next: ["TRIAGE.confirm"],
    prompt_inject:
      "Score 0-100 across files/api/schema/concurrency/security. Suggest profile.",
  },
  {
    sub_state: "TRIAGE.confirm",
    entry: "score computed",
    exit: "user accepts or overrides profile",
    write_paths: [".loaf/<feature>/state.json"],
    next: ["SPEC.proposal", "EXECUTE.plan"],
    prompt_inject:
      "Confirm proposed profile (quick/light/standard/deep — see skill PRESETS) or override.",
  },

  // ─── SPEC ───
  {
    sub_state: "SPEC.proposal",
    entry: "ceremony.spec_phase=true && TRIAGE.confirm done; OR Q9 escalation backfill (ceremony.spec_phase 由 false 改 true)",
    exit: "spec.md body has Proposal section",
    write_paths: [".loaf/<feature>/spec.md", ".loaf/<feature>/spec-draft-context.md"],
    next: ["SPEC.spec"],
    prompt_inject:
      "Write Proposal: why / scope / anti-scope. If backfill, read spec-draft-context.md.",
  },
  {
    sub_state: "SPEC.spec",
    entry: "proposal section exists OR amend-spec back-edge",
    exit:
      "frontmatter has requirements (each with three-way verifiability) + scenarios (+visual_contracts if UI); needs_clarification empty",
    write_paths: [".loaf/<feature>/spec.md"],
    next: ["SPEC.plan"],
    prompt_inject:
      "Author EARS REQ-* with measurable / verified_by_scenarios / acceptance_na+reason. Add Gherkin SCEN-* and VIS-* as needed.",
  },
  {
    sub_state: "SPEC.plan",
    entry: "spec section complete && needs_clarification empty",
    exit: "spec.md body has Plan section",
    write_paths: [".loaf/<feature>/spec.md"],
    // rev 4.1: SPEC.plan writes only the body Plan section (risks /
    // dependencies / milestones prose). Frontmatter REQ/SCEN/VIS
    // structures are locked at this point (SPEC.spec produced them);
    // tasks.json must not exist yet — it is created in SPEC.design.
    mutation_rights: {
      writable_fields: [
        "spec.md:body.plan",
      ],
      forbidden_fields: [
        "spec.md:frontmatter.requirements",
        "spec.md:frontmatter.scenarios",
        "spec.md:frontmatter.visual_contracts",
        "tasks.json:*",
      ],
    },
    next: ["SPEC.design"],
    prompt_inject: "Plan: risks / dependencies / milestones.",
  },
  {
    sub_state: "SPEC.design",
    entry: "plan section complete",
    exit:
      "design section + tasks.json generated; every REQ/SCEN/VIS bound to ≥1 task",
    write_paths: [".loaf/<feature>/spec.md", ".loaf/<feature>/tasks.json"],
    // rev 4.1: SPEC.design writes the body Design section AND creates
    // tasks.json from scratch (full task graph). Frontmatter REQ/SCEN/VIS
    // remain locked (use amend-spec finding to revise).
    mutation_rights: {
      writable_fields: [
        "spec.md:body.design",
        "tasks.json:*",
      ],
      forbidden_fields: [
        "spec.md:frontmatter.requirements",
        "spec.md:frontmatter.scenarios",
        "spec.md:frontmatter.visual_contracts",
      ],
    },
    next: ["EXECUTE.plan"],
    prompt_inject:
      "Design + decompose into tasks bound to REQ/SCEN/VIS via task.drives[]. Use labels[] for bug/security/etc.",
  },

  // ─── EXECUTE ───
  {
    sub_state: "EXECUTE.plan",
    entry: "spec-lock passed (or quick: TRIAGE.confirm done)",
    exit: "every task has execution policy populated per its kind",
    write_paths: [".loaf/<feature>/tasks.json"],
    // rev 4.1: EXECUTE.plan derives per-task execution policy
    // (applicability per step) and advances status pending → ready.
    // Task contract (id / kind / drives / depends_on) must NOT change
    // here — those mutations belong to SPEC.design or amend-tasks
    // finding back-edge.
    mutation_rights: {
      writable_fields: [
        "tasks.json:tasks[].execution[].applicability",
        "tasks.json:tasks[].status",          // pending → ready only (enforced by transitions.ts)
      ],
      forbidden_fields: [
        "tasks.json:tasks[].id",
        "tasks.json:tasks[].kind",
        "tasks.json:tasks[].drives",
        "tasks.json:tasks[].depends_on",
        "tasks.json:tasks[].labels",
        "spec.md:*",
      ],
    },
    next: ["EXECUTE.work"],
    prompt_inject:
      "Derive execution policy for each task from kind × profile. Set step.applicability accordingly.",
  },
  {
    sub_state: "EXECUTE.work",
    entry: "EXECUTE.plan done OR fix-impl/fix-test/amend-tasks back-edge",
    exit:
      "every task.status = done OR abandoned, with all required steps passed/waived/na",
    write_paths: [
      ".loaf/<feature>/tasks.json",
      ".loaf/<feature>/evidence.jsonl",
      ".loaf/<feature>/findings.jsonl",
      // Augmented at runtime by STEP_WRITE_PATHS_BY_KIND[task_kind][step]
      // for each task in tasks.json with status="in_progress" (worker
      // active set; rev 4.0 supports sub-agent fan-out so multiple
      // tasks may be concurrently in_progress).
    ],
    // rev 4.1: EXECUTE.work writes execution status + evidence ledger
    // + post-lock findings. Task contract fields are still off-limits
    // (use amend-tasks finding to re-enter SPEC.design). Source code
    // mutations are governed separately by STEP_WRITE_PATHS_BY_KIND.
    mutation_rights: {
      writable_fields: [
        "tasks.json:tasks[].execution[].status",
        "tasks.json:tasks[].execution[].evidence_refs",
        "tasks.json:tasks[].status",          // ready → in_progress → done / abandoned
        "evidence.jsonl:*",                   // append-only (enforced by mutator)
        "findings.jsonl:*",                   // append-only; post-lock only (§6.1)
      ],
      forbidden_fields: [
        "tasks.json:tasks[].id",
        "tasks.json:tasks[].kind",
        "tasks.json:tasks[].drives",
        "tasks.json:tasks[].depends_on",
        "tasks.json:tasks[].labels",
        "spec.md:*",
      ],
    },
    next: ["EXECUTE.work", "EXECUTE.done"],
    prompt_inject:
      "Execute each in-progress task at its currently-running step. Append evidence with covers[].",
  },
  {
    sub_state: "EXECUTE.done",
    entry: "all tasks status ∈ {done, abandoned}",
    exit:
      "advance to VERIFY.plan (verify_phase=true);" +
      " OR DONE.delivered (verify_phase=false: quick / light non-spike via `loaf deliver`: verify-min runs at this boundary, on pass transition direct to DONE.delivered, on fail exit 2 — see protocol.md §3.2 + §10.14)",
    write_paths: [],
    // rev 4.1 + 5.x: profiles with verify_phase=false skip VERIFY entirely.
    // `loaf deliver` from EXECUTE.done triggers verify-min and (on pass)
    // transitions directly to DONE.delivered. verify_phase=true (standard
    // / deep) still advances to VERIFY.plan as before.
    //
    // Slice 1.D (sub-cycle 1): the `event:phase_advanced` edge from
    // EXECUTE.done to DONE.delivered has been removed from LEGAL_TRANSITIONS
    // (transition.ts:31). DONE.delivered is reached only via
    // `session:delivered`, owned by `loaf deliver`. Until verify-min check
    // infrastructure lands (protocol §3 / §3.2), the EXECUTE.done deliver
    // path is fail-closed by preflight step 5c with
    // DELIVER_VERIFY_MIN_UNAVAILABLE. `next` below still lists
    // DONE.delivered because this table documents prompt / hook flow
    // (the user-action chain skills should suggest), NOT
    // `event:phase_advanced` edge legality (that lives in
    // transition.ts:LEGAL_TRANSITIONS).
    //
    // Spike: regardless of profile, `loaf deliver` is hard-blocked
    // (§10.8 + Slice 1.D DELIVER_SPIKE_TASKS at preflight step 5c).
    // The user must invoke one of the §8.3 outcomes (`loaf archive` /
    // `loaf spike convert` / `loaf abandon`); these are session-terminal
    // commands callable from any sub-state, not state-machine forward
    // edges, so they are NOT in `next` here.
    next: ["VERIFY.plan", "DONE.delivered"],
    prompt_inject:
      "All tasks complete. verify_phase=true → advance to VERIFY.plan." +
      " verify_phase=false non-spike → run `loaf deliver` (verify-min then DONE.delivered)." +
      " spike (any profile) → deliver blocked; pick archive / spike convert / abandon per §8.3.",
  },

  // ─── VERIFY ───
  // rev 4.0: VERIFY.check split into 4 check-specific sub_states. Each
  // applicable check has its own sub_state; transitions move through
  // them in order driven by applicability (skip na, run must, run
  // optional if user opts in). After all applicable checks are
  // passed/waived, advance to VERIFY.accept.
  {
    sub_state: "VERIFY.plan",
    entry: "EXECUTE.done && ceremony.verify_phase=true",
    exit:
      "applicability computed for each VerifyCheckKind (must/optional/na with reasons)",
    write_paths: [".loaf/<feature>/state.json"],
    next: ["VERIFY.run", "VERIFY.review", "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept"],
    prompt_inject:
      "Compute which verify checks apply: run/review/acceptance/visual. Output reasoning + N/A justifications.",
  },
  {
    sub_state: "VERIFY.run",
    entry: "VERIFY.plan done with run applicability ∈ {must, optional-elected}; OR amend back-edge",
    exit: "run check passed or explicitly waived",
    write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
    next: ["VERIFY.review", "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept"],
    prompt_inject:
      "Run the `run` check (test + lint + typecheck). Append evidence with kind=local-check or task-summary. Raise findings as needed.",
  },
  {
    sub_state: "VERIFY.review",
    entry: "VERIFY.plan or prior check done with review applicability ∈ {must, optional-elected}",
    exit: "review check passed or explicitly waived",
    write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
    next: ["VERIFY.run", "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept"],
    prompt_inject:
      "Run quality review (spec_fit + quality_fit). Append evidence with kind=verify-review. Raise findings as needed.",
  },
  {
    sub_state: "VERIFY.acceptance",
    entry: "VERIFY.plan or prior check done with acceptance applicability ∈ {must, optional-elected}",
    exit: "acceptance check passed or explicitly waived",
    write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
    next: ["VERIFY.run", "VERIFY.review", "VERIFY.visual", "VERIFY.accept"],
    prompt_inject:
      "Run selected Gherkin acceptance scenarios. Append evidence with kind=acceptance. Raise findings as needed.",
  },
  {
    sub_state: "VERIFY.visual",
    entry: "VERIFY.plan or prior check done with visual applicability ∈ {must, optional-elected}",
    exit: "visual check passed or explicitly waived",
    write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
    next: ["VERIFY.run", "VERIFY.review", "VERIFY.acceptance", "VERIFY.accept"],
    prompt_inject:
      "Run visual contract verification. Append evidence with kind=visual-review (attachments required). Raise findings as needed.",
  },
  {
    sub_state: "VERIFY.accept",
    entry: "all applicable checks passed/waived + no open findings",
    exit:
      "verify-accept gate approved." +
      " settle_phase=true (deep) → SETTLE.reconcile via `loaf settle`;" +
      " settle_phase=false (standard) → DONE.delivered via `loaf deliver`",
    write_paths: [".loaf/<feature>/evidence.jsonl"],
    // Slice 1.D (sub-cycle 1): event:phase_advanced VERIFY.accept→DONE.delivered
    // edge was removed from LEGAL_TRANSITIONS. The only event:phase_advanced
    // edge from VERIFY.accept is now SETTLE.reconcile (gated by
    // ceremony.settle_phase=true + verify_accepted=true; codes
    // SETTLE_PHASE_DISABLED / SETTLE_NOT_ACCEPTED). DONE.delivered is
    // reached by `loaf deliver` (session:delivered direct cursor flip).
    // `next` keeps both entries because this is the prompt / hook flow
    // suggestion list, not the event:phase_advanced edge table.
    next: ["SETTLE.reconcile", "DONE.delivered"],
    prompt_inject:
      "Verify-accept gate. Review check status + open findings. Approve or reject." +
      " On approve: settle_phase=true → `loaf settle` enters SETTLE.reconcile;" +
      " settle_phase=false → `loaf deliver` enters DONE.delivered.",
  },

  // ─── SETTLE ───
  // rev 4.1 + 5.x: profiles with settle_phase=false skip SETTLE entirely.
  // - quick: `loaf deliver` from EXECUTE.done → DONE.delivered (verify-min)
  // - light: `loaf deliver` from EXECUTE.done → DONE.delivered (verify-min)
  // - standard: `loaf deliver` from VERIFY.accept → DONE.delivered (no verify-min, VERIFY already covers)
  // - deep: VERIFY.accept → SETTLE.reconcile → SETTLE.lessons → DONE.*
  // SETTLE.* is deep-only after rev 5.x. reconcile/lessons data still
  // available via reducer rebuild (`loaf doctor --rebuild`) for non-deep.
  {
    sub_state: "SETTLE.reconcile",
    entry: "verify-accept passed && ceremony.settle_phase=true (deep only after rev 5.x; quick/light/standard skip SETTLE)",
    exit: "reconcile.json valid",
    write_paths: [".loaf/<feature>/reconcile.json"],
    next: ["SETTLE.lessons"],
    prompt_inject:
      "Compare planned_scope vs actual_scope. Resolve every drift. Snapshot verify_checks_status.",
  },
  {
    sub_state: "SETTLE.lessons",
    entry: "reconcile valid (deep only after rev 5.x; quick/light/standard skip SETTLE)",
    exit: "lessons.md appended (deep: lessons_required=must)",
    write_paths: [".loaf/<feature>/lessons.md"],
    // Slice 1.D (sub-cycle 1): event:phase_advanced SETTLE.lessons→DONE.delivered
    // edge was removed. DONE.delivered is reached via `loaf deliver` only.
    // Item 2: the SETTLE.lessons→DONE.archived/abandoned edges were likewise
    // removed — DONE.archived / DONE.abandoned are reached only via
    // `loaf archive --reason` / `loaf abandon --reason` (session:archived /
    // session:abandoned reducer cursor flip). No DONE.* terminal is an
    // event:phase_advanced target. The `next` list below is the documented
    // operator path, not the event:phase_advanced edge graph.
    next: ["DONE.delivered", "DONE.archived", "DONE.abandoned"],
    prompt_inject:
      "Append lessons (deep: MUST). User then runs `loaf deliver` / `loaf archive` / `loaf abandon`.",
  },

  // ─── DONE (terminal) ───
  {
    sub_state: "DONE.delivered",
    entry: "loaf deliver succeeded (Q4: advisory only — no git/gh side effects)",
    exit: "terminal",
    write_paths: [],
    next: [],
    prompt_inject: "",
  },
  {
    sub_state: "DONE.archived",
    entry: "loaf archive --reason '...'",
    exit: "terminal",
    write_paths: [],
    next: [],
    prompt_inject: "",
  },
  {
    sub_state: "DONE.abandoned",
    entry: "loaf abandon --reason '...' (reason required)",
    exit: "terminal",
    write_paths: [],
    next: [],
    prompt_inject: "",
  },
];

// ─────────────────────────────────────────────────────────────────
// 27. Step write paths — per (task_kind, step)
// ─────────────────────────────────────────────────────────────────
//
// Runtime augmentation: hook resolves the (task.kind, step) pair for
// each task with status="in_progress" (worker active set; rev 4.0 may
// be multiple under sub-agent fan-out), looks up allowed write paths
// here, AND-merges with paths.* from loaf.config.json, and unions
// across active tasks. Diff-guard rejects writes outside the merged set.

export const STEP_WRITE_PATHS_BY_KIND = {
  behavioral: {
    red: ["**/test/**", "tests/**", "src/**/__tests__/**"],
    implement: ["src/**", "lib/**"],
    refactor: ["src/**", "lib/**", "**/test/**"],
  },
  structural: {
    implement: ["src/**", "lib/**"],
    refactor: ["src/**", "lib/**"],
  },
  "visual-ui": {
    mockup: ["docs/mockups/**", ".loaf/<feature>/attachments/**"],
    implement: ["src/**", "res/**", "**/ui/**"],
    "screenshot-compare": [".loaf/<feature>/attachments/**"],
  },
  docs: {
    draft: ["docs/**", "**/*.md", "README*"],
    review: [],
  },
  spike: {
    explore: [],                            // exploration writes nothing protocol-tracked
    prototype: ["**/*"],                    // spike worktree: wide latitude
    record: [".loaf/<feature>/evidence.jsonl"],
  },
  chore: {
    execute: ["**/*"],                      // chore by definition is single-shot
  },
} as const;

export const VERIFY_CHECK_WRITE_PATHS: Record<VerifyCheckKind, string[]> = {
  run: [],                                  // only runs commands
  review: [],                               // only writes evidence (already in base)
  acceptance: [],                           // only runs E2E commands
  visual: [".loaf/<feature>/attachments/**"], // visual-review captures screenshots
};

// ─────────────────────────────────────────────────────────────────
// 28. Spec-lock machine checks (Q12 update)
// ─────────────────────────────────────────────────────────────────
//
// rev 3.1 changes:
//   - Removed: ears_no_vague_words (Q12: blacklist dropped)
//   - Added:   every_req_has_verifiability (Q12: three-way verifiability)

export const SPEC_LOCK_CHECKS = [
  "frontmatter_schema_valid",
  "no_open_clarifications",
  "tasks_based_on_current_spec",
  "every_req_has_task",
  "every_req_has_verifiability",            // Q12 new: measurable|scenarios|na+reason
  "every_e2e_scenario_acceptance_resolved",
  "every_visual_contract_resolved",
  "task_kind_schema_valid",
] as const;

// ─────────────────────────────────────────────────────────────────
// 29. Verify-accept machine checks
// ─────────────────────────────────────────────────────────────────
//
// rev 3.1: "passed" semantics now include explicit waivers (with reason).
// `skipped` is GONE (Q5). canSatisfy enforced per-coverage (Q8).

export const VERIFY_ACCEPT_CHECKS = [
  "all_applicable_checks_passed_or_waived",
  "no_open_findings",
  "all_required_coverage_satisfied",        // uses canSatisfy(evidence, coveredId)
  "all_done_tasks_have_evidence",
  "spec_reviewer_independence_if_deep",
] as const;

// ─────────────────────────────────────────────────────────────────
// 30. Diff-guard (rev 3.1 batch: git status full set)
// ─────────────────────────────────────────────────────────────────
//
// On `loaf advance`, diff-guard collects all changed paths via:
//
//   git diff --name-only --diff-filter=ACMRTUXB
//   git diff --cached --name-only --diff-filter=ACMRTUXB
//   git ls-files --others --exclude-standard         # untracked
//
// All paths normalized to repo root, then checked against the merged
// allowed set (SUB_STATE_CONTRACTS.write_paths ∪ STEP_WRITE_PATHS_BY_KIND
// ∪ loaf.config.json paths.*). Any path outside = hard block.
//
// Pseudocode in ChangedPath shape:

export const ChangedPath = z.object({
  path: z.string(),
  status: z.enum([
    "added",
    "modified",
    "deleted",
    "renamed",
    "untracked",
    "submodule",
  ]),
  source: z.enum(["worktree", "index", "untracked"]),
});
export type ChangedPath = z.infer<typeof ChangedPath>;

// ─────────────────────────────────────────────────────────────────
// 31. tasks.json execution status — cache (rev 3.1 batch)
// ─────────────────────────────────────────────────────────────────
//
// tasks.execution.<step>.status is CACHE for fast TUI display.
// evidence.jsonl is the proof source. `loaf tasks check` reconciles
// cache vs proof; mismatch → exit 1 with gate-diagnostic.

export const TASK_CACHE_CONSISTENCY_CHECKS = [
  "every_passed_step_has_at_least_one_passed_evidence",
  "every_waived_step_has_at_least_one_waiver_evidence_with_reason",
  "every_failed_step_has_at_least_one_failed_or_no_evidence",
  "no_evidence_for_na_step",
] as const;

// ─────────────────────────────────────────────────────────────────
// 32. i18n stable IDs (rev 3.1 i18n bundle contract)
// ─────────────────────────────────────────────────────────────────
//
// loaf-cli ships i18n/en.json and i18n/zh.json with the same top-level
// shape. Bundle keys mirror enum members above. Diagnostic message
// templates use mustache-style `{var}` placeholders matched to
// gate-diagnostic.failures[].vars.
//
// Lookup precedence:
//   1. ~/.loaf/i18n/<lang>.local.json (user override)
//   2. loaf-cli/i18n/<lang>.json (built-in)
//   3. loaf-cli/i18n/en.json (fallback)
//
// Lang resolution: LOAF_LANG env > loaf.config.json locale.default_lang
//                  > $LANG > "en"
//
// JSON output (`--json`) NEVER renders i18n. Stable IDs only.

export const I18N_BUNDLE_CATEGORIES = [
  "evidence_kind",
  "phase",
  "sub_state",
  "task_kind",
  "step",
  "verify_check_kind",
  "finding_category",
  "finding_action",
  "gate",
  "applicability",
  "diagnostic",
  "help",
] as const;

// ─────────────────────────────────────────────────────────────────
// 33. v1 done-when freeze (HARD criteria for v1.0.0 tag)
// ─────────────────────────────────────────────────────────────────

export const V1_DONE_CRITERIA = {
  standard_features_completed: 3,
  deep_features_completed: 1,
  forbidden_during_v1: [
    "schema_version bump",
    "new phase",
    "new sub_state",
    "new top-level artifact type",
    "new hook surface",
    "new top-level CLI subcommand",
  ],
  release_action: "tag v1.0.0",
  on_violation: "downgrade to v0.x; no RC iteration allowed",
} as const;

// ─────────────────────────────────────────────────────────────────
// 34. Concurrency invariants (rev 4.1 base; rev 4.3 batch; rev 5.0 journal SSoT)
// ─────────────────────────────────────────────────────────────────
//
// Closes the fan-out concurrency gap left by rev 4.0 and the storage-shape
// gap left by rev 4.3. Without these invariants, sub-agent fan-out in
// EXECUTE.work would corrupt `journal.jsonl` (half-line append), produce
// orphan sidecar files, or break snapshot/journal consistency. See ADR-0005
// §3.5 (10-step mutation transaction) + protocol.md §11.2 + §10.15 doctor
// recovery checks.
//
// rev 5.0 (ADR-0005) restructures the transaction:
//   - 8-step → 10-step path (adds step 3 preflight, step 5 final validate,
//     step 6 final-entry-only append, step 7 corruption-only post-apply
//     assert, step 8 snapshot rebuild).
//   - `atomic_multi_artifact_commands` reframed: multi-artifact writes are
//     now multi-entry journal batches inside one lock window; the rebuilt
//     `snapshots/*.json` are derived projections (protocol.md §13.1).
//   - Adds entry_byte_limit_kb, sidecar_threshold_kb, monotonic_invariants,
//     batch_aware_tail_recovery, orphan_attachment_gc, checksum_levels,
//     step_5_final_validate, final_entry_only_append, migration_sidecar_only,
//     snapshot_read_fail_fast, validate_transition_helper, and the 5 doctor
//     sub-flags (Gates #1-#5 + ADR-0005 §10.15).
//
// rev 4.3 (ADR-0004 A10) introduced the batch transaction order (single or
// array input under one lock window). rev 5.0 keeps this; the 10-step path
// IS the batch path (single entry = batch of 1 = `batch_*` markers absent).

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
  //    Exception: spec.md MAY be edited by $EDITOR or human between
  //    `loaf spec edit` and `loaf spec submit` (SPEC.* sub_states
  //    only); diff-guard catches out-of-window writes. Note that
  //    rev 4.3 `spec add-*` commands replace this $EDITOR loop for
  //    incremental writes — they go through loaf-cli under lock and
  //    emit `event:spec_*_added` journal entries.
  single_writer: true,

  // 2. Lock file path
  //    Per-feature, NOT per-artifact. One feature, one writer at
  //    a time. Implements POSIX flock (or equivalent).
  lock_path: ".loaf/<feature>/.lock",

  // 3. Journal mutation transaction order (rev 5.0, 10-step;
  //    mirror ADR-0005 §3.5 + protocol.md §11.2)
  //    Every loaf-cli mutator command runs these 10 steps in order
  //    under the lock. Failure at any step releases the lock and
  //    exits non-zero; no partial state is observable to readers
  //    because step 6 is the only externally-visible write.
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
    "2. read journal tail + _meta fast-check (same as live run)",
    "3. preflight validate (same as live run)",
    "4. prepare sidecar files into short-lived .tmp-* (NOT renamed; cleaned on step 10)",
    "5. final validate against embedded refs (same as live run)",
    "6. SKIPPED — no journal append",
    "7. SKIPPED — no post-apply assert",
    "8. SKIPPED — no snapshot rebuild",
    "9. SKIPPED — no registry refresh",
    "10. unlink sidecar .tmp-* (if any) + release .lock",
  ],

  // 3b. Dry-run applicability
  //     Read-only commands MUST reject --dry-run with exit 2
  //     (--dry-run not applicable). Wrapping commands ($EDITOR /
  //     fullscreen TUI) MUST reject. See protocol.md §10.7
  //     "--dry-run 契约" table for the complete partition.
  dry_run_rejects_read_only: true,

  // 3c. Batch transaction order (rev 5.0; alias of transaction_order)
  //     In rev 5.0 the 10-step path IS the batch path. A single mutator
  //     emits 1..N entries inside one lock window; the batch markers
  //     (batch_id / batch_index / batch_count) appear when N ≥ 2 and are
  //     absent when N = 1. There is no separate single-entry path.
  batch_transaction_order: "see transaction_order; rev 5.0 unifies single-entry and batch paths under the 10-step transaction (batch markers present when ≥2 entries)",

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
    "1a_all_or_nothing": "preflight (step 3) AND final validate (step 5) both run on full batch; first failure aborts with 0 journal change",
    "1b_one_append_one_bump": "one transaction = one journal append = one spec_version bump (for spec_*_added kinds)",
    "1c_atomic_id_allocation": "EV / PEND / T / REQ / SCEN / VIS serial ranges reserved in one allocator step (step 3e) inside the lock",
  },

  // 4. Lock acquisition timeout (seconds)
  lock_timeout_seconds: 30,

  // 5. Stale lock detection
  //    If lock file PID is not running, `loaf doctor` (or any
  //    `loaf <cmd>` startup) removes the stale lock.
  stale_lock_recovery: "loaf doctor unlinks lock whose PID has exited",

  // 6. SIGINT (Ctrl-C) policy
  //    First Ctrl-C: cleanup hook runs, releases lock, exits 130.
  //    Second Ctrl-C: skip cleanup, exit 130 immediately. Stale
  //    .tmp-* sidecar and possibly .lock left behind; cleaned at
  //    next `loaf doctor` invocation (stale-lock / stale-tmp / orphan-attachment).
  sigint_policy: "first-ctrl-c=cleanup; second-ctrl-c=skip; recovery=loaf doctor",

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
      why: "status change without evidence proof produces TASK_STATUS_WITHOUT_PROOF (§10);" +
           " both entries land in the same batch so readers never see status=passed without proof",
    },
    {
      cmd: "loaf finding raise --action <X>",
      emits: ["finding:raised", "event:task_step_reset (fix-impl/fix-test — resets the repair step)", "event:phase_advanced (if back-edge transition + iteration bump)"],
      why: "back-edge transition + step reset must land atomically (otherwise iteration count and execution state diverge across the batch boundary)",
    },
    {
      cmd: "loaf gate decide <G>",
      emits: ["gate:decided", "pending:resolved (head)"],
      why: "gate approval pops the pending head + records the gate decision; both entries land in one batch so readers never see a half-resolved gate",
    },
    {
      cmd: "loaf spec submit <file>",
      emits: [
        "event:spec_submitted (batch_index=0)",
        "event:spec_req_added × N (batch_index=1..)",
        "event:spec_scenario_added × M",
        "event:spec_visual_added × K",
      ],
      why: "Slice 1.B sub-cycle 1: whole-replacement submit emits ONE atomic batch sharing batch_id + spec_version. spec_submitted at batch_index=0 carries header (feature/intent/adr_refs/needs_clarification) AND resets reducer projection arrays; companion add-* entries repopulate within the same batch so journal is replay-complete (codex r17 canonical-truth invariant)",
    },
    {
      cmd: "loaf pending raise (skill / hook / sub-agent path)",
      emits: ["pending:added"],
      why: "single-entry mutator; registry projection refresh runs in step 9 of the same transaction so TUI reflects the new head atomically",
    },
    {
      cmd: "loaf pending resolve",
      emits: ["pending:resolved", "evidence:added (if resolution carries proof; e.g. gate_decision via `loaf gate decide` co-emits gate:decided in same batch)"],
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
      emits: ["event:tasks_amended mode=add + sponsored_by_finding_id (EXECUTE.work, via --finding) OR event:tasks_planned whole-graph (SPEC.design)"],
      why: "ADR-0004 A5+A10: T-id range allocation + tasks projection rebuild + state pointer agreement must land together in one batch. Phase 11 Item 3 SC1b: the EXECUTE.work add is the sponsored path — each added task is one event:tasks_amended mode=add carrying sponsored_by_finding_id (the amend-tasks finding that authorizes the post-back-edge graph mutation)",
    },
    {
      cmd: "loaf evidence add --input (single or batch)",
      emits: ["evidence:added (one per input item; batch markers when ≥2; each entry carries AttachmentRef for attachments)"],
      why: "ADR-0004 A6 + ADR-0005 §3.5 step 4-5: attachment sidecar finalize + final validate ensure no entry references an attachment that did not land on disk (no orphan attachments)",
    },
    {
      cmd: "loaf doctor --migrate-v2",
      emits: ["migration:snapshot_imported (single entry at seq=0; payload is .strict() manifest with AttachmentRef ONLY — Gate #3)"],
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
    single_partial: "truncate the partial line to the last good newline; reapply step 8 snapshot rebuild from last_applied_seq",
    batch_incomplete: "truncate the entire batch to its pre-batch byte offset; reapply step 8 snapshot rebuild from last_applied_seq",
    rule: "scan last batch_id backward; if last batch_index < batch_count - 1 OR last entry parse-fails → batch_incomplete branch",
  },

  // 7e. Orphan-attachment GC (rev 5.0, ADR-0005 §3.5 step 4d/5 crash window)
  //     `loaf doctor --fix` scans `attachments/<entry_id>/**` and deletes
  //     any directory with no matching journal entry_id, OR any file whose
  //     path is not referenced by an AttachmentRef in the matching entry's
  //     payload. Writes a `local-check` evidence row (audit trail).
  orphan_attachment_gc: "scan attachments/ vs journal AttachmentRef set; delete orphans; log via local-check evidence",

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
    compare_scope: "reducer-visible state transition result + emitted projections (NOT byte-for-byte payload — sidecar ref injection produces a legitimate payload diff)",
    failure_label: "SIDECAR_VALIDATION_DRIFT (implementation bug indicator; abort transaction, clean sidecar tmp, no journal change)",
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
  migration_sidecar_only: "migration:snapshot_imported payload is .strict() Zod with AttachmentRef-only fields; inline artifact content rejected at Zod parse",

  // 7j. Snapshot read fail-fast (Gate #5, ADR-0005 §3.6)
  //     CLI read commands that consume snapshots/*.json MUST verify
  //     snapshots/_meta.json fast-check before parsing the snapshot.
  //     Mismatch → exit 2 SNAPSHOT_STALE_REBUILD_REQUIRED, stderr names
  //     `loaf doctor --rebuild`. No silent fallback to cached snapshot.
  //     **Implementation status (Phase 15 SC3)**: this is the eventual
  //     contract for every read command, but the current binary only wires
  //     four — `loaf status` / `tasks list` / `pending list` / `finding
  //     list` — through `src/core/projection-loader.ts` (M0-anchored
  //     double fast-check). Other read commands (`tasks check` / `tasks
  //     next` / `verify status` / `pending status` / `sessions list` /
  //     `<artifact> schema` / etc.) still run on `loadSession` full
  //     journal replay and will migrate in subsequent slices.
  snapshot_read_fail_fast: "Phase 15 SC3 — 4 commands (status / tasks list / pending list / finding list) verify _meta fast-check via projection-loader (M0-anchored double check); mismatch → exit 2 SNAPSHOT_STALE_REBUILD_REQUIRED + structured stderr; no silent cached-snapshot output. Other read commands still on loadSession replay.",

  // 7k. validateTransition shared helper (Gate #1, ADR-0005 §10)
  //     `event:phase_advanced` and `gate:decided` MUST call the same
  //     transition validator in src/core/reducer/transition.ts. No per-kind
  //     if/else fork outside this helper. The helper signature is:
  //       validateTransition(prevSubState, targetSubState,
  //                          { ceremony, gate_kind?, actor }) → Result<void, TransitionError>
  validate_transition_helper: "event:phase_advanced and gate:decided share src/core/reducer/transition.ts; no per-kind transition fork",

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
    "--check-tail": "run batch-aware tail recovery only; no snapshot rebuild unless tail truncated past last_applied_seq",
    "--migrate-v2": "v0.0.x N-file → v0.1.0 sidecar import per MIGRATION_V1_TO_V2_BOUNDARY (§0c)",
    "--scope cwd": "iterate all .loaf/<feature>/ under cwd; enforces mixed-version-cwd refusal (refuse if any feature is at schema_version != current)",
    "--verify-checksum": "full chain rolling_checksum recompute (O(N)); reports mid-stream corruption",
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
  //    registry lags; `loaf doctor --rebuild-registry` rebuilds from
  //    canonical (journal.jsonl + snapshots/*.json).
  //    TUI MUST tolerate registry stale; never block on registry.
  registry_authority: "best-effort projection; never gate authority",
} as const;

// §35 FLAG_EXCLUSIONS (rev 4.2)
// ─────────────────────────────────────────────────────────────────
//
// Mutually exclusive flag pairs/sets. Parser MUST detect conflicts
// before dispatch and exit 2 with MUTUALLY_EXCLUSIVE_FLAGS, listing
// the conflicting flag names in the error body for scripting.
//
// Format flags are normalized to a single `format` value:
//   --json  ⇒ format=json
//   --plain ⇒ format=text
//   --format=<fmt> ⇒ explicit
// Same-value combinations are NOT conflicts (--json --format=json
// is fine). Cross-value combinations exit 2.
//
// Precedence inside one invocation (after exclusion check):
//   explicit flag > $LOAF_FORMAT env (v1.0; protocol.md §10.3) >
//   TTY default
//
// LOAF_FORMAT value MUST be in the same enum as --format=<v>
// ("json" | "text"). Out-of-enum value → exit 2 INVALID_ENV_VALUE
// at startup with the offending env var name + accepted enum.
//
// See protocol.md §10.5 + §10.7 "Format flag 归一化与互斥".

export const FLAG_EXCLUSIONS = {
  error_code: "MUTUALLY_EXCLUSIVE_FLAGS",
  exit_code: 2,

  // Each entry describes one mutually exclusive set. Parser MUST
  // reject any invocation that selects more than one option within
  // the same set with a non-equivalent value.
  sets: [
    {
      name: "output_format",
      // Normalization map: flag spelling → canonical value.
      // Multiple flags MAY map to the same canonical value (no
      // conflict); conflict arises only when they map to different
      // canonical values.
      normalization: {
        "--json": "json",
        "--plain": "text",
        "--format=json": "json",
        "--format=text": "text",
      } as Record<string, "json" | "text">,
      // Examples of conflicting combinations (exit 2):
      conflict_examples: [
        ["--json", "--plain"],            // json vs text
        ["--json", "--format=text"],      // json vs text
        ["--plain", "--format=json"],     // text vs json
      ],
      // Examples that are NOT conflicts (same canonical value):
      ok_examples: [
        ["--json", "--format=json"],
        ["--plain", "--format=text"],
      ],
    },
    {
      // Reserved entry for future verbosity exclusion (e.g., --quiet
      // and --verbose both passed in same invocation). Listed as
      // example of how this table extends; v1.0 enforcement TBD.
      name: "verbosity_reserved",
      normalization: {} as Record<string, never>,
      conflict_examples: [],
      ok_examples: [],
    },
  ],
} as const;

// §36 HookEvent enum (rev 4.2 polish)
// ─────────────────────────────────────────────────────────────────
//
// Closed set of Claude Code hook event names accepted by
// `loaf hook <event>`. CLI parser MUST reject any other value
// with exit 2 + did-you-mean (clig.dev §2 + §8).
//
// Mapping to Claude Code hook event names (protocol.md §11):
//   session-start  ← SessionStart hook
//   write-guard    ← PreToolUse(Write,Edit) hook
//   scope-track    ← PostToolUse(Write,Edit) hook
//   closure-check  ← Stop hook
//
// Naming style: kebab-case (matches `loaf hook <event>` shell
// surface). The internal mapping table to Claude Code's PascalCase
// event names lives in the loaf-cli CLI dispatch layer, not here —
// schemas.ts is the wire/disk contract, not the CLI wiring.
//
// Adding a new event is a §15 done-when freeze concern post v1.0
// (hook surface is part of the freeze boundary). v1.0 enumeration
// is final; future events go through ADR + minor version bump.

export const HookEvent = z.enum([
  "session-start",
  "write-guard",
  "scope-track",
  "closure-check",
]);

export const HOOK_EVENT_TO_CLAUDE_CODE = {
  "session-start": "SessionStart",
  "write-guard": "PreToolUse(Write,Edit)",
  "scope-track": "PostToolUse(Write,Edit)",
  "closure-check": "Stop",
} as const;

// §37 FindingActionRisk + FINDING_ACTION_GRID (rev 4.3 / ADR-0004 A7)
// ─────────────────────────────────────────────────────────────────
//
// Cell-level enforcement for `loaf finding raise --category X --action Y`.
// Three tiers replace the original 2-tier legal/illegal split — `unusual`
// preserves LLM expressivity (out-of-band actions allowed with reason),
// `incoherent` blocks the 4 target-determinacy-unsolvable cells (spec-gap
// or new-scope crossed with fix-impl or fix-test) where there is no task
// to apply the transition to. See ADR-0004 A7 for the full grid rationale
// and `references/finding-matrix-rationale.md` for per-cell justifications.
//
// ADR labelled this §35 in schemas.ts; it lands at §37 because rev 4.2
// already occupied §35 (FLAG_EXCLUSIONS) and §36 (HookEvent).
//
// Enforcement at `loaf finding raise`:
//   typical    → accept; reason optional
//   unusual    → require --reason length ≥ 20; else exit 2
//                FINDING_ACTION_UNUSUAL_REASON_REQUIRED
//   incoherent → block; exit 2 FINDING_ACTION_INCOHERENT
//
// reconcile.json carries unusual_findings_count so reviewers see the
// non-typical band without scanning findings.jsonl line by line.

export const FindingActionRisk = z.enum(["typical", "unusual", "incoherent"]);
export type FindingActionRisk = z.infer<typeof FindingActionRisk>;

export const FINDING_ACTION_GRID: Record<
  z.infer<typeof FindingCategory>,
  Record<z.infer<typeof FindingAction>, FindingActionRisk>
> = {
  "spec-gap": {
    "amend-spec":  "typical",
    "amend-tasks": "unusual",
    "fix-impl":    "incoherent",
    "fix-test":    "incoherent",
    "defer":       "typical",
    "backlog":     "typical",
  },
  "spec-defect": {
    "amend-spec":  "typical",
    "amend-tasks": "unusual",
    "fix-impl":    "unusual",
    "fix-test":    "unusual",
    "defer":       "typical",
    "backlog":     "typical",
  },
  "impl-defect": {
    "amend-spec":  "unusual",
    "amend-tasks": "typical",
    "fix-impl":    "typical",
    "fix-test":    "unusual",
    "defer":       "typical",
    "backlog":     "typical",
  },
  "test-defect": {
    "amend-spec":  "unusual",
    "amend-tasks": "typical",
    "fix-impl":    "unusual",
    "fix-test":    "typical",
    "defer":       "typical",
    "backlog":     "typical",
  },
  "new-scope": {
    "amend-spec":  "typical",
    "amend-tasks": "typical",
    "fix-impl":    "incoherent",
    "fix-test":    "incoherent",
    "defer":       "typical",
    "backlog":     "typical",
  },
  "risk-escalation": {
    "amend-spec":  "unusual",
    "amend-tasks": "typical",
    "fix-impl":    "unusual",
    "fix-test":    "unusual",
    "defer":       "typical",
    "backlog":     "typical",
  },
} as const;

// Minimum --reason length when ActionRisk = unusual.
export const FINDING_UNUSUAL_REASON_MIN_LENGTH = 20;

// §38 ContextPackProjection + CONTEXT_PACK_TEMPLATES (rev 4.3 / ADR-0004 A8)
// ─────────────────────────────────────────────────────────────────
//
// Phase-aware context slice output by `loaf context pack [--phase]`. Each
// SubState declares what artifact fields the pack MUST include and which
// it MUST exclude. Skills consume the projection to feed the LLM the
// minimum context for the current phase instead of dragging the whole
// spec / tasks / evidence corpus around.
//
// ADR labelled this §36 in schemas.ts; renumbered to §38 (see §37 note).
//
// `include` / `exclude` are semantic field tags (free-form strings the
// CLI maps to projection logic). They are not Zod selectors — they are
// the contract between this table and the projection implementation in
// the CLI's context-pack code path. Adding a tag here means the CLI must
// support projecting it; removing one is a breaking change pre-GA only.
//
// `loaf resume` no longer accepts --fresh (rev 4.3). Use `loaf context
// pack` for routine phase-switch context; reserve `loaf resume` for true
// handoff recovery from a resume-pack.json snapshot.
//
// ── Lockstep contract with the CLI projection implementation ────
//
// The include/exclude string set is the **wire contract** between
// this table and the CLI's projection code path. Pre-GA additions
// of a new tag MUST land in the same commit as the projection-code
// support for that tag (no half-projected fields exposed to the
// LLM). Removing a tag pre-GA is a breaking change to any skill
// that consumes the projection — coordinate via ADR-trail (rev 4.3
// freeze rewording, §15) and update consumers in lockstep. Post-GA
// the set is frozen.
//
// Tag taxonomy guidance: tags name the **semantic field the LLM
// should see**, not the artifact's raw key path. e.g. "req_count"
// (semantic) vs "spec.requirements.length" (key path). The CLI
// resolves semantic tags into the raw fields; multiple
// implementation paths may serve one semantic tag.

export const ContextPackProjection = z.object({
  description: z.string().min(3),
  include: z.array(z.string().min(1)),
  exclude: z.array(z.string().min(1)).default([]),
});
export type ContextPackProjection = z.infer<typeof ContextPackProjection>;

export const CONTEXT_PACK_TEMPLATES: Record<
  z.infer<typeof SubState>,
  ContextPackProjection
> = {
  "TRIAGE.score": {
    description: "Feature intent + scoring inputs + ceremony presets",
    include: ["feature.intent", "scoring_axes", "ceremony_presets"],
    exclude: ["spec", "tasks", "evidence"],
  },
  "TRIAGE.confirm": {
    description: "Triage outcome + ceremony to confirm",
    include: ["feature.intent", "ceremony", "ceremony_label", "scoring_summary"],
    exclude: ["spec", "tasks", "evidence"],
  },
  "SPEC.proposal": {
    description: "Feature meta + proposal draft state",
    include: ["feature.intent", "spec_version", "proposal_draft", "needs_clarification"],
    exclude: ["tasks", "evidence", "verify_checks"],
  },
  "SPEC.spec": {
    description: "EARS / scenario / visual contract building",
    include: [
      "feature.intent",
      "spec_version",
      "req_count",
      "scen_count",
      "vis_count",
      "verifiability_gaps",
      "needs_clarification",
      "pending_head",
    ],
    exclude: ["tasks", "evidence", "verify_checks"],
  },
  "SPEC.plan": {
    description: "Spec-locked summary + task plan inputs",
    include: ["spec_summary", "spec_version", "ceremony", "task_kinds_planned"],
    exclude: ["evidence", "verify_checks"],
  },
  "SPEC.design": {
    description: "Design notes + cross-cutting concerns",
    include: ["spec_summary", "design_notes", "adr_refs"],
    exclude: ["tasks_detail", "evidence"],
  },
  "EXECUTE.plan": {
    description: "Derive per-task execution policy",
    include: ["ceremony", "tasks_summary", "tasks_dag", "open_findings"],
    exclude: ["spec_ears_detail", "evidence"],
  },
  "EXECUTE.work": {
    description: "Worker active set + ready leaves + open findings",
    include: [
      "ceremony",
      "tasks_status_summary",
      "in_progress_step",
      "ready_leaves_top_5",
      "open_findings",
      "pending",
      "write_scope",
    ],
    exclude: ["spec_ears_detail", "verify_checks_detail"],
  },
  "EXECUTE.done": {
    description: "Final task statuses pre-VERIFY",
    include: ["tasks_status_summary", "task_summary_evidence", "open_findings"],
    exclude: ["spec_ears_detail"],
  },
  "VERIFY.plan": {
    description: "Compute applicable verify checks",
    include: ["spec_summary", "verify_checks_applicable", "ceremony"],
    exclude: ["tasks_dag"],
  },
  "VERIFY.run": {
    description: "Running run check (test + lint + typecheck)",
    include: ["verify_check_status.run", "ac_coverage_run", "open_findings", "pending"],
    exclude: ["tasks_dag"],
  },
  "VERIFY.review": {
    description: "Running review check (quality reviewer)",
    include: ["verify_check_status.review", "spec_summary", "open_findings", "pending"],
    exclude: ["tasks_dag"],
  },
  "VERIFY.acceptance": {
    description: "Running acceptance check (Gherkin E2E)",
    include: ["verify_check_status.acceptance", "scen_coverage", "open_findings", "pending"],
    exclude: ["tasks_dag"],
  },
  "VERIFY.visual": {
    description: "Running visual check (visual contract)",
    include: ["verify_check_status.visual", "vis_coverage", "open_findings", "pending"],
    exclude: ["tasks_dag"],
  },
  "VERIFY.accept": {
    description: "Machine + human gate snapshot",
    include: [
      "verify_checks_status_all",
      "ac_coverage",
      "open_findings",
      "pending",
      "gate_diagnostic",
    ],
    exclude: ["tasks_dag"],
  },
  "SETTLE.reconcile": {
    description: "Drift + AC coverage + findings reconciliation",
    include: ["iteration_stats", "drift", "ac_coverage", "findings_by_category_action"],
    exclude: ["tasks_dag", "spec_ears_detail"],
  },
  "SETTLE.lessons": {
    description: "Iteration totals + lessons.md inputs",
    include: ["iteration_stats", "findings_by_category_action", "drift_summary"],
    exclude: ["tasks_detail", "spec_ears_detail"],
  },
  "DONE.delivered": {
    description: "Terminal delivered snapshot",
    include: ["feature.intent", "iteration_stats", "delivery_record"],
    exclude: ["tasks_dag", "pending"],
  },
  "DONE.archived": {
    description: "Terminal archived snapshot",
    include: ["feature.intent", "archive_reason", "iteration_stats"],
    exclude: ["tasks_dag", "pending"],
  },
  "DONE.abandoned": {
    description: "Terminal abandoned snapshot",
    include: ["feature.intent", "abandon_reason", "iteration_stats"],
    exclude: ["tasks_dag", "pending"],
  },
} as const;

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
  "ATTACHMENT_NOT_FOUND",                  // A6
  "ATTACHMENT_NOT_FILE",                   // A6
  "FINDING_ACTION_UNUSUAL_REASON_REQUIRED",// A7
  "FINDING_ACTION_INCOHERENT",             // A7
  "FINDING_TARGET_REQUIRED",               // Slice 3 SC3 (rev 4.3 §37 target_payload preflight)
  // SPEC_LOCKED_NO_DIRECT_EDIT + SPEC_NOT_INITIALIZED were pre-registered
  // in the rev 4.3 ADR-0004 A4 block above. Slice 4 SC3 wires them
  // through preflight refines (5i); no DiagnosticCode/ERROR_CATALOG
  // additions needed here.
  // ── pre-rev-4.3 codes already referenced from schemas.ts ──
  "MUTUALLY_EXCLUSIVE_FLAGS",              // §35 FLAG_EXCLUSIONS
  "INVALID_ENV_VALUE",                     // §35 commentary
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
  "DELIVER_VERIFY_MIN_UNAVAILABLE",        // src/core/reducer/preflight.ts step 5c — `session:delivered` at EXECUTE.done; quick/light path requires verify-min (§3) which is not yet implemented in v0.1.0
  "DELIVER_SPIKE_TASKS",                   // src/core/reducer/preflight.ts step 5c — snapshot.tasks contains a non-abandoned spike task (protocol §703 + §1298 hard block)
  "SETTLE_NOT_ACCEPTED",                   // src/core/reducer/transition.ts — `event:phase_advanced` VERIFY.accept→SETTLE.reconcile but snapshot.state.verify_accepted=false (gate must approve before settle)
  // ── Slice 2 SC1 — task lifecycle preflight (codex r56/r57) ──
  "TASK_NOT_CLAIMABLE",                    // src/core/reducer/preflight.ts step 5e — event:task_claimed for task with status ∈ {done, abandoned} (terminal — cannot be reclaimed)
  "TASK_ALREADY_CLAIMED",                  // src/core/reducer/preflight.ts step 5e — event:task_claimed for task with status=in_progress
  "TASK_DEPS_NOT_SATISFIED",               // src/core/reducer/preflight.ts step 5e — event:task_claimed but some task in deps_on is not status=done
  "TASK_NOT_CLAIMED",                      // src/core/reducer/preflight.ts step 5e — event:task_step_started or event:task_step_done but task.status ≠ in_progress (must claim before mutating steps)
  // ── Item 1 — `loaf tasks abandon` preflight (codex r127) ──
  "TASK_NOT_ABANDONABLE",                  // src/core/reducer/preflight.ts step 5e.3 — event:task_abandoned for a task with status ∈ {done, abandoned} (already final — abandon is a no-op)
  "TASK_ABANDON_BLOCKED_DEPENDENTS",       // src/core/reducer/preflight.ts step 5e.3 — event:task_abandoned but a non-terminal task lists the target in depends_on (would strand the dependent)
  // ── Item 2 — `loaf archive` / `loaf abandon` preflight (codex r129) ──
  "SESSION_REASON_REQUIRED",               // src/core/reducer/preflight.ts step 5c.2 — session:archived or session:abandoned with no reason key (the shared SessionReasonPayload makes reason optional; archive/abandon tighten it to required)
  // ── Slice A SC-A2 — spec.md projection writer (post-appendMany Pass 5) ──
  "PROJECTION_WRITE_FAILED",               // src/core/journal-mutate.ts Pass 5 — writeDerivedSpecMd threw after journal append succeeded; journal authoritative, run `loaf doctor --rebuild` to resync
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
    message_template: "command requires --input (file path, '-', or inline JSON)",
    fix_template:
      "pass --input with one of: a JSON file path, '-' for stdin, or " +
      "inline JSON; run `loaf <cmd> --schema --json` to view the schema",
    doc_anchor: "protocol.md#§10.7",
  },
  SCHEMA_VALIDATION_FAILED: {
    exit_code: 2,
    message_template:
      "input does not satisfy schema for {command}: {zod_path}: {zod_message}",
    fix_template:
      "run `loaf {command} --schema --json` to dump the JSON Schema, " +
      "fix the offending field, and retry",
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
      "has no covering evidence entry in evidence.jsonl",
    fix_template:
      "emit `loaf evidence add` covering task_id={task_id} before " +
      "advancing status, or roll back the status with `loaf tasks set`",
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
      "subcode=SPEC_NOT_FOUND: run `loaf spec init` then `loaf spec submit` to seed spec.md; subcode=SPEC_YAML_INVALID: check the `---`-fenced YAML block at the top of spec.md for syntax errors; subcode=SPEC_FRONTMATTER_INVALID: run `loaf spec submit --schema` to dump the SpecFrontmatter schema and fix the offending field. Both spec-lock and verify-accept require a valid spec.md at check 1.",
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
      "run `loaf tasks submit <plan-file>` to emit event:tasks_planned and seed the task graph; spec-lock check 3 and verify-accept check 4 both require tasks_based_on.spec to match the current spec.spec_version",
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
    exit_code: 2,
    message_template:
      "quick / light deliver from EXECUTE.done requires verify-min, which is not yet implemented in this build (ceremony_label={ceremony_label})",
    fix_template:
      "use ceremony=standard or deep to traverse VERIFY.* before delivery; quick / light direct-delivery via verify-min is a follow-up slice (verify-min check infrastructure pending)",
    doc_anchor: "protocol.md#§3",
  },
  DELIVER_SPIKE_TASKS: {
    exit_code: 2,
    message_template:
      "cannot deliver: task {task_id} is kind=spike (status={status}); spike tasks block delivery for the entire session",
    fix_template:
      "abandon the spike task (`loaf tasks step done --task {task_id} --step ... --result abandoned`) or convert it to a feature (`loaf spike convert --to-feature F-N --reason \"...\"`); spike tasks must not remain in non-abandoned status when the session delivers",
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

// §40 Input schemas + INPUT_SCHEMAS + InputSourceResolver (rev 4.3 / ADR-0004 A2/A3/A5/A10/A11)
// ─────────────────────────────────────────────────────────────────
//
// Tier 1 structured mutator input schemas. Five commands consume JSON
// via the unified `--input <-|inline|path>` flag (A3, A11). Each accepts
// either a single object or a non-empty array (A10 batch).
//
// Identity discipline (A5):
//   REQ / SCEN / VIS: input carries `id_namespace` (a stem regex with no
//     -NNN serial). CLI scans the locked spec for max serial under that
//     namespace and allocates the next, then writes the full `id` (output
//     regex with serial) into spec.md. Two regex are intentionally
//     distinct — input MUST NOT match output, and vice versa.
//   T / EV: CLI allocates the full id; input carries no id field.
//
// ADR labelled this §38; renumbered to §40 (see §37 note).

// Namespace regex (stem only; no -NNN serial). The CLI's allocator
// composes a full id by appending '-' + zero-padded next-serial; the
// composed id matches the existing output regex (ReqId / ScenId / VisId
// defined earlier).
const ReqIdNamespace  = z.string().regex(/^REQ-[A-Z][A-Z0-9]*$/);
const ScenIdNamespace = z.string().regex(/^SCEN-[A-Z][A-Z0-9-]*$/);
const VisIdNamespace  = z.string().regex(/^VIS-[A-Z][A-Z0-9-]*$/);

// ── SpecReqInput (5 EARS variants, mirrors RequirementEars but with
// id_namespace in place of id, dropped at output time when CLI composes
// the full id). VerifiabilityFields is shared with the entry schema.

const SpecReqInputUbiquitous = z.object({
  id_namespace: ReqIdNamespace,
  type: z.literal("ubiquitous"),
  response: z.string().min(10),
}).and(VerifiabilityFields);

const SpecReqInputEventDriven = z.object({
  id_namespace: ReqIdNamespace,
  type: z.literal("event-driven"),
  trigger: z.string().min(5),
  response: z.string().min(10),
}).and(VerifiabilityFields);

const SpecReqInputStateDriven = z.object({
  id_namespace: ReqIdNamespace,
  type: z.literal("state-driven"),
  while_: z.string().min(5),
  behavior: z.string().min(10),
}).and(VerifiabilityFields);

const SpecReqInputOptional = z.object({
  id_namespace: ReqIdNamespace,
  type: z.literal("optional"),
  feature: z.string().min(5),
  response: z.string().min(10),
}).and(VerifiabilityFields);

const SpecReqInputUnwanted = z.object({
  id_namespace: ReqIdNamespace,
  type: z.literal("unwanted"),
  condition: z.string().min(5),
  response: z.string().min(10),
}).and(VerifiabilityFields);

export const SpecReqInput = z.union([
  SpecReqInputUbiquitous,
  SpecReqInputEventDriven,
  SpecReqInputStateDriven,
  SpecReqInputOptional,
  SpecReqInputUnwanted,
]);
export type SpecReqInput = z.infer<typeof SpecReqInput>;

// ── SpecScenarioInput / SpecVisualInput: mirror existing entry shapes
// with id replaced by id_namespace.

export const SpecScenarioInput = z
  .object({
    id_namespace: ScenIdNamespace,
    name: z.string().min(3),
    tag: z.enum(["happy", "edge", "error", "e2e"]).optional(),
    requires_acceptance: z.boolean().optional(),
    acceptance_na: z.string().min(5).optional(),
    given: z.array(z.string().min(3)).min(1),
    when: z.array(z.string().min(3)).min(1),
    then: z.array(z.string().min(3)).min(1),
  })
  .refine(
    (s) => !(s.tag === "e2e" && s.acceptance_na && s.requires_acceptance),
    { message: "cannot set both requires_acceptance and acceptance_na" },
  );
export type SpecScenarioInput = z.infer<typeof SpecScenarioInput>;

export const SpecVisualInput = z.object({
  id_namespace: VisIdNamespace,
  target: z.string().min(3),
  checks: z.array(z.string().min(3)).min(1),
  requires_visual: z.boolean().optional(),
  visual_na: z.string().min(5).optional(),
});
export type SpecVisualInput = z.infer<typeof SpecVisualInput>;

// ── TaskInput: mirrors Task discriminated union but omits id (CLI
// allocates), execution (CLI initializes all steps to status=pending,
// applicability=must), and status (CLI sets to "pending" on create).
// Slice C SC-C4 (R2): no red_test_registered — it is runtime state set by
// `loaf tasks register-red` after the task exists, never a creation-time
// input. Every variant is `.strict()`: a caller supplying id / status /
// execution / red_test_registered / any unknown key is rejected, not
// silently stripped (ADR-0004 shape enforcement).

const TaskInputBase = z.object({
  drives: z.array(DrivesRef).optional(),
  depends_on: z.array(TaskId).default([]),
  labels: z.array(z.string()).default([]),
});

const TaskBehavioralInput = TaskInputBase.extend({
  kind: z.literal("behavioral"),
  drives: z.array(DrivesRef).min(1),
  tests: z.array(z.string().min(3)).min(1),
  test_layer: z.enum(["unit", "integration", "e2e"]).optional(),
  requires_acceptance: z.boolean().optional(),
  requires_visual: z.boolean().optional(),
}).strict();

const TaskStructuralInput = TaskInputBase.extend({
  kind: z.literal("structural"),
  no_test_rationale: z.string().min(10),
}).strict();

const TaskVisualUiInput = TaskInputBase.extend({
  kind: z.literal("visual-ui"),
  visual_contract_refs: z.array(VisId).min(1),
  no_test_rationale: z.string().min(10).optional(),
}).strict();

const TaskDocsInput = TaskInputBase.extend({
  kind: z.literal("docs"),
  no_test_rationale: z.string().min(10),
}).strict();

const TaskSpikeInput = TaskInputBase.extend({
  kind: z.literal("spike"),
  no_test_rationale: z.string().min(10),
}).strict();

const TaskChoreInput = TaskInputBase.extend({
  kind: z.literal("chore"),
  no_test_rationale: z.string().min(10),
}).strict();

// Zod 4: discriminatedUnion accepts each `.strict()` ZodObject directly —
// `.sourceType()` (a removed Zod 3 ZodEffects method) is no longer needed
// now that the R2 bug-RED refine is gone.
export const TaskInput = z.discriminatedUnion("kind", [
  TaskBehavioralInput,
  TaskStructuralInput,
  TaskVisualUiInput,
  TaskDocsInput,
  TaskSpikeInput,
  TaskChoreInput,
]);
export type TaskInput = z.infer<typeof TaskInput>;

// ── Batch helper: each Tier 1 input accepts a single object OR a
// non-empty array. Atomicity discipline (A10):
//   1a — validate-all-or-reject-all in memory before any append
//   1b — spec_version += 1 per invocation (not per item)
//   1c — atomic id allocation under the per-session lock
// CLI normalizes single vs array internally; both forms surface here.

const batchOrSingle = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([schema, z.array(schema).nonempty()]);

export const SpecReqInputBatched      = batchOrSingle(SpecReqInput);
export const SpecScenarioInputBatched = batchOrSingle(SpecScenarioInput);
export const SpecVisualInputBatched   = batchOrSingle(SpecVisualInput);
export const TaskInputBatched         = batchOrSingle(TaskInput);
export const EvidenceAddInputBatched  = batchOrSingle(EvidenceAddInput);

// ── MutatorCommand: the closed set of CLI commands that consume
// structured JSON via --input. Keys for INPUT_SCHEMAS.
export const MutatorCommand = z.enum([
  "spec:add-req",
  "spec:add-scenario",
  "spec:add-visual",
  "tasks:add",
  "evidence:add",
]);
export type MutatorCommand = z.infer<typeof MutatorCommand>;

// ── INPUT_SCHEMAS: command → batched input Zod schema. CLI looks up
// the schema for the invoked command, parses --input (after resolving
// stdin / inline / path via InputSourceResolver), and either accepts a
// single record or a non-empty array. `loaf <cmd> --schema --json`
// dumps the JSON Schema derived from this entry (clig.dev §5).
export const INPUT_SCHEMAS: Record<MutatorCommand, z.ZodTypeAny> = {
  "spec:add-req":      SpecReqInputBatched,
  "spec:add-scenario": SpecScenarioInputBatched,
  "spec:add-visual":   SpecVisualInputBatched,
  "tasks:add":         TaskInputBatched,
  "evidence:add":      EvidenceAddInputBatched,
} as const;

// ── InputSourceResolver: the discriminated shape the CLI uses internally
// to represent how a --input value was sourced. Pure data; the actual
// resolution logic lives in the CLI input-source code path.
//
// Resolution order (A11):
//   1. value === "-"          → InputSource = { source: "stdin" }
//   2. value matches /^[\{\[]/ → InputSource = { source: "inline", raw }
//   3. otherwise              → InputSource = { source: "path", path }
//                                CLI validates existence; missing path
//                                emits INPUT_FILE_NOT_FOUND (exit 2).

export const InputSourceResolver = z.discriminatedUnion("source", [
  z.object({ source: z.literal("stdin") }),
  z.object({ source: z.literal("inline"), raw: z.string().min(1) }),
  z.object({ source: z.literal("path"),   path: z.string().min(1) }),
]);
export type InputSourceResolver = z.infer<typeof InputSourceResolver>;

// §41 Event-name registry — canonical homes (rev 4.3 drift sweep)
// ─────────────────────────────────────────────────────────────────
//
// Pre-rev-4.3 schemas.ts had no consolidated event-name index, so
// external docs (plan.md M1 / design.html) drifted to spellings
// that do not exist anywhere in the protocol surface:
//   `finding_close` (missing 'd'), unfounded `spec_init`,
//   `StepStarted` mismatched in casing/composition.
//
// moni-review.md (2026-05-13) audit recommendation: maintain ONE
// event clearinghouse so plan.md / design.html / future tooling
// consume canonical names instead of reinventing them.
//
// This block is the index. It points to the existing canonical
// homes (other sections of this file or protocol.md §10.12) rather
// than redeclaring them — re-declaration would itself create a
// second source of truth and a new drift surface. Future CI lint
// can grep this index to flag any external doc that uses a name
// outside the canonical set.
//
// ── Canonical event-name homes ──────────────────────────────────
//
//   Domain                  Canonical home
//   ─────────────────────   ──────────────────────────────────────
//   Finding events          §16 FindingsEvent.event
//                           Members:  "opened" | "closed"
//                           (Zod literals inside discriminated
//                           union; not a free-standing enum.)
//
//   Hook events             §36 HookEvent (z.enum)
//                           Members:  HookEvent.options
//                                     = ["session-start",
//                                        "write-guard",
//                                        "scope-track",
//                                        "closure-check"]
//
//   Evidence kinds          §6 EvidenceKind (z.enum)
//                           Members:  EvidenceKind.options
//
//   Pending kinds           §11 PendingPromptKind (z.enum)
//                           Members:  PendingPromptKind.options
//
//   Drift resolutions       §18 Drift.resolution (z.enum)
//                           Members:  "spec_amended" |
//                                     "carried_forward" |
//                                     "abandoned" |
//                                     "deferred"
//
//   Finding categories      §5 FindingCategory (z.enum)
//   Finding actions         §5 FindingAction   (z.enum)
//
//   Sub-states              §1 SubState (z.enum, 20 members)
//
//   State-change verbs      protocol.md §10.12 (prose table; verb
//                           column).  Not Zod-typed because each
//                           verb is the success surface of a CLI
//                           command, not a wire-level enum. The
//                           verb set is the union of mutator
//                           commands listed in §10.8.
//
//   Mutator commands        §40 MutatorCommand (z.enum, the 5
//                           Tier 1 mutators with --input).
//
//   Diagnostic codes        §39 DiagnosticCode (z.enum)
//
// ── Known drift names — DO NOT USE ──────────────────────────────
//
// External docs sometimes reach for these; none of them exist as
// canonical names in any of the homes above.
//
//   Drift spelling    Why it is wrong / what was probably meant
//   ────────────────  ─────────────────────────────────────────────
//   finding_close     Missing trailing 'd'.  Use FindingsEvent
//                     .event = "closed" (rev 4.0+ canonical).
//   spec_init         No canonical event of this name.  Writers
//                     usually mean either the state-change verb
//                     "spec submit" (§10.12) or the hook event
//                     "session-start" (HookEvent).
//   StepStarted       No canonical event of this name.  The
//                     closest analogs are the state-change verb
//                     "step start" (§10.12) plus the
//                     TaskExecutionStep.started_at field (§14)
//                     that records the actual start timestamp.
//
// Adding a new event of any kind to the protocol surface is a
// §15 done-when-freeze concern: pre-GA additions are allowed via
// ADR-trail (rev 4.3 added 5 mutator commands this way); post-GA
// the surface is frozen.
