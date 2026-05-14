// loaf-cli Protocol Schemas — v1 (rev 4.3)
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
//                          SCHEMA_VERSION=1 + §15-16 v1 done-when criteria.
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

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────
// 0. Schema version
// ─────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;
export const SchemaVersion = z.literal(SCHEMA_VERSION);

// ─────────────────────────────────────────────────────────────────
// 1. Phase / SubState
// ─────────────────────────────────────────────────────────────────
//
// 6 macro phases × 17 sub-states. First-class state machine.
// SubState format: `<Phase>.<step>` so hooks can parse via split(".").
// Invariant (enforced by StateJson.refine): sub_state.startsWith(phase + ".")

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

  // SETTLE.lessons 强制 append?(rev 4.1 deep MUST = "must";
  // standard MAY = "may";quick / light skip = "skip")。
  // 要求 settle_phase=true 当值非 "skip"
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
  "fix-impl",     // → EXECUTE.work, transitions.ts sets task.execution.implement.status=running, iter+1, no version change
  "fix-test",     // → EXECUTE.work, transitions.ts sets task.execution.red.status=running, iter+1
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
// 12. state.json — single source of session truth
// ─────────────────────────────────────────────────────────────────
//
// loaf CLI is the only writer. Hooks/skills/TUI read-only.
// rev 4.0: StateJson carries session-level state ONLY (state machine
// position + identity + control + liveness). Active-set detail is NOT
// stored here — it lives in tasks.json (worker active set via
// task.status="in_progress") and is expressed via sub_state for control
// phase intent (e.g. VERIFY.review when running the review check).
// See ADR-0002 for the worker/control phase typology.
//
// workspace is reserved for multi-worktree/team display. v1 does NOT
// wire any gate or path logic to it; pure display field.

export const StateJson = z
  .object({
    schema_version: SchemaVersion,
    loaf_version_required: z
      .string()
      .regex(/^[\^~]?\d+\.\d+(\.\d+)?$/),

    // ── Identity ──
    session_id: z.string().uuid(),
    session_label: z.string().min(3),
    cwd: z.string(),
    workspace: z.string().default("default"),  // v1: display only

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

    // ── Lock state ──
    spec_locked: z.boolean(),

    // ── Pending user interactions (FIFO queue, rev 4.1) ──
    // pending[0] is the active blocker; queued entries auto-promote
    // when head resolves. Empty array = no blocker.
    // Protocol enforcement is minimal (rev 4.1 Q3): only `loaf advance`
    // is blocked, and only when head.kind ∈ {gate_decision,
    // profile_escalation}. All other commands run regardless of queue
    // depth — see protocol.md §10.7. FIFO strict in v1.0.
    pending: z.array(PendingPromptEntry).default([]),

    // ── Debug flag ──
    debug: z.boolean(),

    // ── Ceremony & scoring(rev 4.2:Profile enum 砍,ceremony hybrid B+label)──
    // CLI logic 走 ceremony.* 6 flag;ceremony_label 仅 cosmetic display(skill 写入)
    ceremony: Ceremony,
    ceremony_label: CeremonyLabel.default(""),
    complexity_score: z.number().int().min(0).max(100),

    // ── Version refs ──
    based_on: z.object({
      spec: z.number().int().nonnegative(),
      tasks: z.number().int().nonnegative(),
    }),

    // ── Heartbeat ──
    heartbeat_at: z.string().datetime(),

    // ── Timestamps ──
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
export type StateJson = z.infer<typeof StateJson>;

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
// state.json heartbeat_at by more than threshold. Gate / blocking
// decisions NEVER read registry — they recompute from canonical
// truth (§5 lead paragraph). Use `loaf doctor --rebuild-registry`
// to fully rebuild registry from canonical artifacts (e.g. after
// crash, or after manual edit of .loaf/<feature>/). See protocol.md
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

export const TaskBehavioral = TaskBase.extend({
  kind: z.literal("behavioral"),
  drives: z.array(DrivesRef).min(1),
  tests: z.array(z.string().min(3)).min(1),
  test_layer: z.enum(["unit", "integration", "e2e"]).optional(),
  red_test_registered: z.boolean().optional(),
  execution: BehavioralExecution,
  requires_acceptance: z.boolean().optional(),
  requires_visual: z.boolean().optional(),
}).refine(
  (t) => !t.labels.includes("bug") || t.red_test_registered === true,
  { message: "behavioral tasks with label=bug require red_test_registered=true" },
);

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
  // Exits: DONE.archived, or convert (archives spike + opens new feature).
});

export const TaskChore = TaskBase.extend({
  kind: z.literal("chore"),
  no_test_rationale: z.string().min(10),
  execution: ChoreExecution,
});

export const Task = z.discriminatedUnion("kind", [
  TaskBehavioral.sourceType(),
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
// canonicalizes the path under `.loaf/<feature>/attachments/<EV-id>/`,
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
// 18. reconcile.json — planned vs actual + verify snapshot
// ─────────────────────────────────────────────────────────────────
//
// SETTLE.reconcile produces this. Standard+ only; quick skips.
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
// rev 4.0: state_snapshot is StateJson (no longer carries current_*).
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
  state_snapshot: StateJson,
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
    .default({}),

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
    .default({}),

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
    .default({}),

  // ── Locale (rev 3.1 i18n) ──
  locale: z.object({
    default_lang: z.enum(["en", "zh"]).default("en"),
  }).default({}),
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
//     standard: { spec_phase: true,  verify_phase: true,  settle_phase: true,  ... },
//     deep:     { ...standard, strict_spec_review: true, lessons_required: "must", strict_drift_check: true },
//     // skill 想加 rapid-fix / release-candidate / company-specific 都行
//   };
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
      "Confirm proposed profile (quick/standard/deep) or override.",
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
      "advance to VERIFY.plan (standard / deep);" +
      " OR DONE.delivered (quick non-spike via `loaf deliver`: verify-min runs at this boundary, on pass transition direct to DONE.delivered, on fail exit 2 — see protocol.md §3.2 + ADR-0003 Addendum 3)",
    write_paths: [],
    // rev 4.1: quick profile skips SETTLE entirely. `loaf deliver` from
    // EXECUTE.done in a quick session triggers verify-min and (on pass)
    // transitions directly to DONE.delivered. Standard / deep still
    // advance to VERIFY.plan as before.
    //
    // Spike: regardless of profile, `loaf deliver` is hard-blocked
    // (§10.8). The user must invoke one of the §8.3 outcomes
    // (`loaf archive` / `loaf spike convert` / `loaf abandon`); these
    // are session-terminal commands callable from any sub-state, not
    // state-machine forward edges, so they are NOT in `next` here.
    next: ["VERIFY.plan", "DONE.delivered"],
    prompt_inject:
      "All tasks complete. standard/deep → advance to VERIFY.plan." +
      " quick non-spike → run `loaf deliver` (verify-min then DONE.delivered)." +
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
    exit: "verify-accept gate approved",
    write_paths: [".loaf/<feature>/evidence.jsonl"],
    next: ["SETTLE.reconcile"],
    prompt_inject:
      "Verify-accept gate. Review check status + open findings. Approve or reject.",
  },

  // ─── SETTLE ───
  // rev 4.1: quick profile skips SETTLE entirely (`loaf deliver` from
  // EXECUTE.done goes direct to DONE.delivered). SETTLE.* is now
  // standard / deep only.
  {
    sub_state: "SETTLE.reconcile",
    entry: "verify-accept passed (standard / deep only — quick skips SETTLE)",
    exit: "reconcile.json valid",
    write_paths: [".loaf/<feature>/reconcile.json"],
    next: ["SETTLE.lessons"],
    prompt_inject:
      "Compare planned_scope vs actual_scope. Resolve every drift. Snapshot verify_checks_status.",
  },
  {
    sub_state: "SETTLE.lessons",
    entry: "reconcile valid (standard / deep only — quick skips SETTLE)",
    exit: "lessons.md appended (deep: required, std: optional)",
    write_paths: [".loaf/<feature>/lessons.md"],
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
// 34. Concurrency invariants (rev 4.1 base; rev 4.3 batch additions)
// ─────────────────────────────────────────────────────────────────
//
// Closes the fan-out concurrency gap left by rev 4.0. Without these
// invariants, sub-agent fan-out in EXECUTE.work would corrupt
// evidence.jsonl (half-line append), collide EV-ids, and produce
// execution.status / evidence proof disagreement. See ADR-0003 P0
// section + protocol.md §11.2.
//
// rev 4.3 (ADR-0004 A10) adds the batch transaction order (single or
// array input under one lock window) and registers the 5 Tier 1
// mutator entries in atomic_multi_artifact_commands. No invariant is
// weakened; the batch path is a refinement of the existing 8-step
// transaction with an explicit id-range allocation step.

export const CONCURRENCY_INVARIANTS = {
  // 1. Single writer rule
  //    Every artifact under .loaf/<feature>/ AND under
  //    ~/.loaf/registry/<id>.json is written ONLY by loaf-cli.
  //    skill / sub-agent / $EDITOR / external script MUST NOT
  //    directly write either canonical-truth or derived-projection
  //    files. The four authority layers (protocol.md §13.1):
  //      Canonical truth     state.json / spec.md / tasks.json /
  //                          evidence.jsonl / findings.jsonl /
  //                          loaf.config.json
  //      Derived projection  reconcile.json / registry/<id>.json /
  //                          gate-diagnostic.json /
  //                          resume-pack.json /
  //                          spec-draft-context.md
  //      Debug-trace         trace.jsonl / ~/.loaf/crashes/*.log /
  //                          attachments/<EV-id>/*
  //      Advisory            lessons.md / `loaf deliver` stdout
  //    single_writer applies to all four layers; gate authority
  //    distinction is §13.1's concern, not this rule's.
  //    Exception: spec.md MAY be edited by $EDITOR or human between
  //    `loaf spec edit` and `loaf spec submit` (SPEC.* sub_states
  //    only); diff-guard catches out-of-window writes. Note that
  //    rev 4.3 `spec add-*` commands replace this $EDITOR loop for
  //    incremental writes — they go through loaf-cli under lock and
  //    do not need the editor exception.
  single_writer: true,

  // 2. Lock file path
  //    Per-feature, NOT per-artifact. One feature, one writer at
  //    a time. Implements POSIX flock (or equivalent).
  lock_path: ".loaf/<feature>/.lock",

  // 3. Mutation transaction order
  //    Every loaf-cli mutator command runs these steps in order
  //    under the lock. Failure at any step releases the lock and
  //    exits non-zero; no partial state is observable to readers
  //    because step 6 is the only externally-visible write.
  transaction_order: [
    "1. acquire .lock (blocking, ≤30s; on timeout exit 2 with LOCK_TIMEOUT)",
    "2. read canonical artifact(s) at latest mtime",
    "3. validate mutation against latest state (Zod + cross-file transitions.ts)",
    "4. write <artifact>.tmp-<random>",
    "5. fsync (if platform supports)",
    "6. rename <tmp> → <final> (POSIX atomic)",
    "7. refresh registry projection (same tmp+rename pattern at ~/.loaf/registry/<id>.json)",
    "8. release .lock",
  ],

  // 3a. Dry-run transaction order (rev 4.1, --dry-run / -n flag)
  //     Runs steps 1-5 to fully validate the mutation, then aborts:
  //     unlink the .tmp-* file (step 4 byproduct) and release the
  //     lock. No artifact is renamed into place; no registry
  //     projection is touched; EV-id monotonic counter is NOT
  //     incremented. stdout prints a "would do" summary (JSON or
  //     text per --format), including would-be EV-id range and the
  //     set of validation diagnostics that would have applied. exit
  //     0 = mutation would succeed; exit 2 = would fail (with the
  //     same diagnostic file as the real run, written to a tmp
  //     diagnostic path that is NOT promoted to gate-diagnostic.json).
  dry_run_transaction_order: [
    "1. acquire .lock (same as live run)",
    "2. read canonical artifact(s) at latest mtime",
    "3. validate mutation against latest state",
    "4. write <artifact>.tmp-<random> (in-memory or short-lived tmp; allowed for diff snapshot)",
    "5. fsync (skipped — tmp not persisted)",
    "6. SKIPPED — no rename",
    "7. SKIPPED — no registry refresh",
    "8. unlink .tmp-* if created + release .lock",
  ],

  // 3b. Dry-run applicability
  //     Read-only commands MUST reject --dry-run with exit 2
  //     (--dry-run not applicable). Wrapping commands ($EDITOR /
  //     fullscreen TUI) MUST reject. See protocol.md §10.7
  //     "--dry-run 契约" table for the complete partition.
  dry_run_rejects_read_only: true,

  // 3c. Batch transaction order (rev 4.3, ADR-0004 A10)
  //     When a Tier 1 mutator (spec add-req / spec add-scenario /
  //     spec add-visual / tasks add / evidence add) receives an
  //     array input under --input, validation and append are
  //     refined into a 9-step path that preserves the single-writer
  //     and append-only invariants:
  batch_transaction_order: [
    "1. acquire .lock (blocking, ≤30s; on timeout exit 2 LOCK_TIMEOUT)",
    "2. read canonical artifact(s) at latest mtime",
    "3. Zod validate the entire batch (z.union([T, z.array(T).nonempty()]) form)",
    "4. cross-item invariant check (within each id_namespace, allocated serials are unique — i.e. full ids are unique; multiple items sharing the same id_namespace ARE allowed and get a contiguous serial range in step 5; drives/depends_on point to existing or batch-internal ids; etc)",
    "5. atomic id range allocation (reserve N contiguous ids in one allocator step; rollback on later failure leaves allocator untouched)",
    "6. write <artifact>.tmp-<random> with batch append in one go",
    "7. fsync + atomic rename → final path",
    "8. refresh registry projection (single tmp+rename)",
    "9. release .lock",
  ],

  // 3d. Batch disciplines (rev 4.3, ADR-0004 A10)
  //     Three rules the batch path MUST honor:
  //       1a. all-or-nothing — validate every item in memory before
  //           any append; first failure aborts the whole batch with
  //           zero writes (preserves append-only / crash-only).
  //       1b. spec_version += 1 per invocation — a batch is ONE
  //           atomic change = ONE spec_version bump, not +N.
  //       1c. atomic id allocation — id range reserved in one step
  //           inside the lock; allocator commits only if the whole
  //           batch validates.
  //     See protocol.md §11.2 "Batch transaction 三纪律" + Tier 1
  //     mutator family discussion in §10.8.
  batch_disciplines: {
    "1a_all_or_nothing": "validate-all in memory; first failure rejects the whole batch with 0 writes",
    "1b_spec_version_per_invocation": "spec_version += 1 per call regardless of batch size",
    "1c_atomic_id_allocation": "reserve N contiguous ids in one allocator step inside the lock",
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
  //    .tmp-* and possibly .lock left behind; cleaned at next
  //    `loaf doctor` invocation.
  sigint_policy: "first-ctrl-c=cleanup; second-ctrl-c=skip; recovery=loaf doctor",

  // 7. Atomic multi-artifact mutations
  //    Some commands MUST mutate multiple artifacts in one
  //    transaction. Each appears as a single lock window.
  atomic_multi_artifact_commands: [
    // (cmd, artifacts written, why atomic)
    {
      cmd: "loaf tasks step done",
      writes: ["tasks.json:execution.status", "evidence.jsonl:append"],
      why: "rev 4.1: status change without evidence proof produces TASK_STATUS_WITHOUT_PROOF (§10);" +
           " they MUST land in the same lock window so readers never see status=passed without proof",
    },
    {
      cmd: "loaf finding raise --action <X>",
      writes: ["findings.jsonl:append", "tasks.json:execution.<step>.status (if requires_target_payload)", "state.json:sub_state + iteration"],
      why: "back-edge transition + payload application must be atomic (otherwise iteration count and execution state diverge)",
    },
    {
      cmd: "loaf gate decide <G>",
      writes: ["evidence.jsonl:append kind=gate-decision", "state.json:phase+sub_state"],
      why: "gate approval and phase advance are conceptually one step",
    },
    {
      cmd: "loaf spec submit",
      writes: ["spec.md (atomic replace)", "state.json:based_on.spec + heartbeat"],
      why: "spec version + state pointer must agree at all times",
    },
    {
      cmd: "loaf pending raise (internal — hook/sub-agent path)",
      writes: ["state.json:pending append", "registry projection:pending + pending_queue_depth"],
      why: "rev 4.1: queue append + TUI projection must be visible together; otherwise reader sees blocker existing in state but not reflected in TUI",
    },
    {
      cmd: "loaf pending resolve",
      writes: ["state.json:pending shift (pop head)", "registry projection:pending + pending_queue_depth", "evidence.jsonl (if resolution carries proof; e.g. gate_decision resolution writes kind=gate-decision evidence in same lock)"],
      why: "FIFO pop + projection refresh in same transaction so the new head (or empty queue) is immediately observable; gate_decision resolution co-writes the gate-decision evidence atomically (no half-resolved state)",
    },
    {
      cmd: "loaf spec add-req --input (single or batch) — rev 4.3",
      writes: ["spec.md (atomic rewrite with composed full REQ ids)", "state.json:spec_version + heartbeat"],
      why: "ADR-0004 A5+A10: id_namespace → full id composition + spec.md replace + spec_version bump must land together so readers never see a spec_version pointing at unallocated ids",
    },
    {
      cmd: "loaf spec add-scenario --input (single or batch) — rev 4.3",
      writes: ["spec.md (atomic rewrite with composed full SCEN ids)", "state.json:spec_version + heartbeat"],
      why: "Same family as spec add-req; SCEN namespace allocator + spec.md edit + state pointer agree atomically",
    },
    {
      cmd: "loaf spec add-visual --input (single or batch) — rev 4.3",
      writes: ["spec.md (atomic rewrite with composed full VIS ids)", "state.json:spec_version + heartbeat"],
      why: "Same family as spec add-req; VIS namespace allocator + spec.md edit + state pointer agree atomically",
    },
    {
      cmd: "loaf tasks add --input (single or batch) — rev 4.3",
      writes: ["tasks.json:append batch with allocated T-ids and CLI-initialized execution blocks", "state.json:based_on.tasks (if pointer changes) + heartbeat"],
      why: "ADR-0004 A5+A10: T-id range allocation + tasks.json append + state pointer must agree; partial batch would leave T-ids gapped or execution blocks orphan",
    },
    {
      cmd: "loaf evidence add --input (single or batch) — rev 4.3",
      writes: [
        "evidence.jsonl:append batch with EV-id range",
        "attachments/<EV-id>/* (path → sha256 + mime + canonical copy)",
        "state.json:heartbeat",
      ],
      why: "ADR-0004 A6+A10: attachment shape transformation (path → hashed object) + jsonl append + EV-id range allocation must all land or none; partial batch could persist attachments without an evidence row referencing them (orphan files)",
    },
  ],

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
  //       - `loaf profile escalate --confirm`: head must be
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

  // 9. Registry as cache
  //    Registry rewrite (step 7 of transaction) is best-effort.
  //    If process dies between step 6 and step 7, registry lags;
  //    `loaf doctor --rebuild-registry` rebuilds from canonical.
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
  "ATTACHMENT_NOT_FOUND",                  // A6
  "ATTACHMENT_NOT_FILE",                   // A6
  "FINDING_ACTION_UNUSUAL_REASON_REQUIRED",// A7
  "FINDING_ACTION_INCOHERENT",             // A7
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
  "ESCALATION_NOT_PENDING",                // §10.7 `loaf profile escalate --confirm` but head isn't profile_escalation
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
    exit_code: 2,
    message_template:
      "spec is locked at phase {phase}; direct add/edit is rejected",
    fix_template:
      "raise a finding with category=spec-gap (or spec-defect) and " +
      "action=amend-spec to roll back to SPEC.spec and amend",
    doc_anchor: "protocol.md#§5.3",
  },
  SPEC_NOT_INITIALIZED: {
    exit_code: 2,
    message_template:
      "spec has not been initialized for feature {feature_id}",
    fix_template:
      "run `loaf spec init` first, then retry the add command",
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
  MUTATION_OUT_OF_RIGHTS: {
    exit_code: 2,
    message_template:
      "command {command} attempted to write {target} but the current " +
      "sub_state {sub_state} grants no mutation right for that field",
    fix_template:
      "see the mutation rights matrix (protocol.md §8.6) for which " +
      "sub_state may mutate which field; advance to the correct " +
      "sub_state or raise a finding to back-edge through the legal " +
      "transition",
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
      "`loaf profile escalate --confirm` for kind=profile_escalation; " +
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
      "`loaf profile escalate --confirm` requires pending head " +
      "kind=profile_escalation; current head: {actual_head}",
    fix_template:
      "resolve the current head first via the kind-appropriate command, " +
      "or wait for the profile_escalation pending to appear",
    doc_anchor: "protocol.md#§10.7",
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
  red_test_registered: z.boolean().optional(),
  requires_acceptance: z.boolean().optional(),
  requires_visual: z.boolean().optional(),
}).refine(
  (t) => !t.labels.includes("bug") || t.red_test_registered === true,
  { message: "behavioral tasks with label=bug require red_test_registered=true" },
);

const TaskStructuralInput = TaskInputBase.extend({
  kind: z.literal("structural"),
  no_test_rationale: z.string().min(10),
});

const TaskVisualUiInput = TaskInputBase.extend({
  kind: z.literal("visual-ui"),
  visual_contract_refs: z.array(VisId).min(1),
  no_test_rationale: z.string().min(10).optional(),
});

const TaskDocsInput = TaskInputBase.extend({
  kind: z.literal("docs"),
  no_test_rationale: z.string().min(10),
});

const TaskSpikeInput = TaskInputBase.extend({
  kind: z.literal("spike"),
  no_test_rationale: z.string().min(10),
});

const TaskChoreInput = TaskInputBase.extend({
  kind: z.literal("chore"),
  no_test_rationale: z.string().min(10),
});

export const TaskInput = z.discriminatedUnion("kind", [
  TaskBehavioralInput.sourceType(),
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
