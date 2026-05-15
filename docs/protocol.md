# loaf-cli Protocol — v1 Draft (rev 5.x)

> 2026-05-15 · prose source of truth。机器契约见 `schemas.ts`,可视化伴侣见 `protocol.html`。
>
> loaf-cli v1 是 legacy Python 原型(early-draft 内部称 "v2")的 successor,from scratch。把 legacy 当老师,不当父亲。v1 GA 之后 legacy 原型进 archive。
>
> **rev 5.x — 4-profile 单调递增 + standard 砍 SETTLE + TDD 边界声明**(2026-05-15,driven by 4-profile design grilling w/ codex):
> - **PRESETS 4 档对齐**:`quick`(EXECUTE 直跳 DONE)→ `light`(+SPEC,跳 VERIFY/SETTLE,verify-min @ deliver 兜底)→ `standard`(+VERIFY,跳 SETTLE)→ `deep`(+SETTLE + strict 三件套)。每档加一件事,清晰度优先于 standard 的隐式 audit 仪式。`light` 之前协议已"承诺"过(rev 4.2 PRESETS 注释 + §3 escalation 表),本 rev 显式落到 §3 表格 + 流程图 + verify-min 段。
> - **standard 砍 SETTLE**:`PRESETS.standard.settle_phase: true → false`。reconcile snapshot + lessons.md 留给 deep 作差异化卖点。理由:standard 默认 `strict_drift_check=false` + `lessons_required=skip`,reconcile.json 在 standard 仅 audit view,不被 enforce;rev 5.0 起 reducer auto-derive,需要 audit 可走 `loaf doctor --rebuild` on-demand 触发。改动:§3 PRESETS 表 + §4.6 Authority + §5.2 transition target + §10.8 `loaf deliver` 行 + 流程图。
> - **light spec 语义提示**:light(`spec_phase=true && verify_phase=false`)走完 verify-min 后,`loaf deliver` **按 `--format` 分流**:`--format text`(TTY 默认)写 stdout advisory note 段;`--format json` 在 stdout JSON 主体 `warnings[]` 数组追加 `{ code: "REQ_COVERAGE_NOT_CLOSED_LIGHT", message, remediation }`;stderr 不写(避免 `2>/dev/null` 时丢)。明确 light 的 spec 是 intent anchor,不是 contract closed;要正式 close 升 standard。改动:§3 verify-min 段(stream-aware 三栏)。
> - **TDD CLI 强制边界显式声明**:CLI 只硬 enforce `behavioral + labels=["bug"]` → register-red(已现状);non-bug behavioral 的 RED-first 是 skill policy,不是协议保证。`constitution.tdd_strictness` / `require_red_for_behavioral` 仍是 skill 软配置,**CLI 不读、不 enforce**。Ceremony schema **不加** `tdd_strict` 字段(避免把 policy choice 混进 protocol shape)。理由:TDD 严格度是工程方法偏好,legacy migration / generated code / SDK integration / UI glue 这类 standard ceremony 场景天然不适合 red-first,绑死会卡。改动:§9.3 加边界声明表。
> - **不破 §15 freeze**:本 rev 改动均落在 schema enum / refine / sub_state contract `next[]` 调整 + 文档同步,**零新 phase / 零新 sub_state / 零新 top-level CLI 子命令 / 零新 hook surface**;`SCHEMA_VERSION` 不动。
>
> **rev 5.0 — Truth model: single typed journal (γ)** (2026-05-14, driven by [`adr/0005-truth-model-single-typed-journal.md`](adr/0005-truth-model-single-typed-journal.md)):
> - **Canonical truth shifted**: `.loaf/<feature>/journal.jsonl` + `attachments/` 是协议唯一 SSoT;`state.json` / `tasks.json` / `evidence.jsonl` / `findings.jsonl` / `pending.json` / `reconcile.json` / `spec.md` / `lessons.md` 全部降为 **派生投影**(`snapshots/*.json` 或 reducer-derived markdown),允许 stale,gate 永远不读。详 §3.1(ADR-0005)+ §13.1(rewritten)+ §4.1-4.12(per-section authority annotations)。
> - **`SCHEMA_VERSION` 1 → 2**:envelope shape 级常量 bump;配合 per-entry `entry_schema_version`(envelope 字段)+ `UPCASTER_REGISTRY`(keyed by (kind, entry_schema_version))做 per-kind upcast。机器表达见 `schemas.ts` rev 5.0。
> - **§11.2 重写为 10-step crash contract**:原 8-step transaction 扩为 10 步(含 step 3 preflight、step 5 final validate、step 6 final-entry-only append、batch-aware tail recovery)。Crash window analysis 见 ADR-0005 §3.5 表。
> - **新增 doctor 5 sub-flags**:`loaf doctor --rebuild` / `--check-tail` / `--migrate-v2` / `--scope cwd` / `--verify-checksum`(§10.15);doctor checklist 加 7 项 check(orphan-attachment / tail-corruption / stale-tmp / snapshot-seq-mismatch / migration-v0.0.x / rolling-checksum-mismatch / sidecar-validation-drift)。
> - **§10.8 加 `kind emitted` 映射**:每个 Tier 1 mutator 显式映射到 ADR-0005 §3.3 kind namespace 中的 entry kind;`--actor` 永久 non-flag(actor 由 CLI 注入,见 ADR-0005 §3.4)。
> - **§1 新增 Principle 15a**:`Truth model = single typed journal + reducer-derived projection`。Principle 15 ③(per-session lock)语义未变,只是落点从「artifact mutation」改为「journal append」。
> - **§15 done-when**:加 schema_version 1→2 transition 完成 + §5.2 v0.0.x upcaster end-to-end 通过 两项 release blocker。
> - **§16 非目标退场**:`state.json event sourcing` 从「v1 显式非目标」退场(rev 5.0 落地);`work.json compile step` 保留为非目标。
> - **§17 legacy 对照**:加 `Truth model` 演化栏(legacy = N-file mutable;v1 rev ≤4.3 = N-file mutable + per-session lock;v1 rev 5.0 = single typed journal + sidecar)。
> - **Stage / gate milestone** 见 `docs/plan.md` + ADR-0005 §10;**不破 §15 freeze**(GA 未达,ADR-trail additive 路径,SCHEMA_VERSION bump 在 v1 unfrozen 期间合法,Hyrum's Law=0)。
>
> **rev 4.2 — clig.dev 三轮 review polish**(2026-05-12,Profile/Ceremony refactor 之上叠加):
> - `loaf tasks done` → **`loaf tasks complete`** rename(消 `tasks step done` 同名异级歧义,clig.dev §8)。改动:§10.8 命令表 + §10.12 state-change line + protocol.html 命令表
> - **`--json` / `--plain` / `--format` 互斥契约**:同值无冲突(`--json --format=json` OK),不同值 exit 2 `MUTUALLY_EXCLUSIVE_FLAGS`。§10.7 加归一化段 + §10.5 错误表加行 + schemas.ts 新 `FLAG_EXCLUSIONS` 常量
> - **stderr color TTY gate** 独立 `isatty()`(§10.2):`loaf x 2>err.log` 时 stderr 走文件不染色,stdout TTY 仍染色
> - Help 文案 footer 加 **`$LOAF_ISSUE_URL`**(§10.1;clig.dev §2 support path);build-time stamping 已在 §10.11
> - **`-h` / `--help` 任意位置工作**(§10.1;clig.dev §2):parser 必须 short-circuit `-h` 在 subcommand context resolved 后
> - **`loaf hook <event>` enum 可发现性**(§10.8):enum 限定 4 值(`session-start` / `write-guard` / `scope-track` / `closure-check`),bare 调用 exit 2 列 enum,`--list-events` 显式 dump
>
> **rev 4.2 — Profile enum 砍,改 Ceremony hybrid B+label**(2026-05-12,driven by `adr/0003-codex-rev4-audit-resolution.md` Addendum 6):
> - `schemas.ts::Profile` enum(`"quick" | "standard" | "deep"`)整个砍。
> - 替代:`Ceremony` 6 字段 schema(`spec_phase` / `verify_phase` / `settle_phase` / `strict_spec_review` / `lessons_required` / `strict_drift_check`)+ `ceremony_label` cosmetic 字符串。CLI 全部 enforcement 走 ceremony.* 6 flag,label 仅显示。
> - `StateJson.profile` → `StateJson.ceremony` + `StateJson.ceremony_label`;`RegistryFile.profile` → `RegistryFile.ceremony_label`。
> - `PROFILE_POLICIES` 表整个砍,移到 **skill PRESETS 表**(loaf-skill 维护 quick/light/standard/deep 4 个默认 preset;3rd-party skill 可自定义)。
> - `ESCALATION_RULES` 改 `ESCALATION_DETECTIONS`(CLI 检测 trigger + raise pending;skill 决定升档后的新 ceremony)。
> - `LoafConfig.constitution.default_profile` → `default_ceremony_label` + optional `default_ceremony`。
> - `SUB_STATE_CONTRACTS.entry` 条件 `profile != quick` → `ceremony.{spec,verify,settle}_phase=true`。
> - **Rationale**:§1 原则 14(协议管 shape,skill 管 content)。Profile 是 content(preset 选哪个),不是 shape(state machine 长什么样)。砍下 5 件 content→skill 决策之最后一件(前 4 件 vague-word / `should` / `decomposition_preference` / `verify_cadence`)。CLI 严谨性 0 损失 — 同样用 ceremony.* 6 flag 强制 phase 跑哪些,跟 PROFILE_POLICIES 查表逻辑等价;cosmetic label 保住品牌名 readability。
> - **Skill 责任**:loaf-skill 维护 PRESETS 表(`references/loaf-skill-helpers.md`),`loaf start` 时算 score → 推 label → 用户接受 → skill 调 CLI 传 `--ceremony-json '...' --ceremony-label '...'`。3rd-party skill 可起任意 preset 名(cursor 起 `prototype/feature/release`,公司起 `fast-fix/regulatory` 都行)。
> - **不破 §15 freeze**(v1 impl 未动,Hyrum's Law=0;字段类型变化在 v1 unfrozen 期间允许,跟 rev 4.0 砍 current_* 3 字段 / rev 4.1 加 pending array 同等纪律)。
>
> **rev 4.1 cleanup**(2026-05-12,driven by `adr/0003-codex-rev4-audit-resolution.md`):codex 第二轮深度审计,17 条建议达成共识 11 接受 / 6 拒绝。无 schema_version bump、无新 phase / sub-state / hook / CLI(§15 freeze 未破)。本轮交付:
> - **3 条真实 correctness 缺口**(fan-out 上线前必修):
>   - §1 + §11.2 + schemas §34 加 **single-writer + per-session lock** invariant — 协议级声明 skill / sub-agent 不得直写 `.loaf/<feature>/`,所有 mutation 经 `loaf <cmd>` 在 `.loaf/<feature>/.lock` 保护下走 atomic transaction
>   - §10.8 + schemas `EvidenceAddInput` — `loaf evidence add` **不接受 `--id` flag**,CLI 单调分配 EV-id 并 stdout 回打;支持 `--external-ref` 留调用方 correlation
>   - §10.8 + §8 + schemas — `loaf tasks step done` 是**单 transaction**(execution.status 改 + evidence 追加同 lock 内,不能分两次调用);`loaf tasks check` 发现 status 无 evidence proof → 报 `TASK_STATUS_WITHOUT_PROOF`,evidence 是 ground truth status 必须回滚
> - **2 条真协议缺口**:
>   - §8.6 新加 **mutation rights matrix**(SPEC.plan / SPEC.design / EXECUTE.plan / EXECUTE.work 四行):per-sub_state 可写 artifact + 不可写,光靠 sub_state 名字两个"plan"后面 skill prompt 一定混
>   - §4.1 加 **`pending` 反向定义**:single blocking interaction,**不是** unfinished work / queue / derived obligation list,防 contributor 当 todo list 用
> - **6 条文档纪律 + 防腐**:
>   - §1 加 **Principle #15**:protocol state is promoted only when it changes machine behavior, not merely prompt wording. Derived projections may be stale and are never gate authority. All artifact mutations go through loaf-cli under a per-session lock.
>   - §7.0 新加 **Sub-state promotion rule** + 当前 4 VERIFY lane 反向 audit(每 lane 钩中 promotion rule 哪 2+ 项,未来 security/perf/a11y MUST 先 map 到既有 lane)
>   - §6.2 finding action 表 **重画表头加 `target payload` 列**:`fix-impl` / `fix-test` / `amend-tasks` 的 `(step=X)` 拆出 sub_state 括号,变成 finding resolution payload;rev 4 砍 `current_step` 后这条表达污染必修
>   - §4.12 RegistryFile **声明 best-effort projection**:允许 crash window stale,`loaf doctor --rebuild-registry` 重建,gate 永远不读 registry
>   - `EXECUTE.task` → **`EXECUTE.work`** rename(fan-out 多元命名,worker active set 不再单数)
>   - §13.1 三层 artifact 表升级为 **四层**:Canonical truth / Derived projection / Debug-trace / Advisory
> - **拒绝(6 条,见 ADR-0003 Rejected 段)**:VERIFY flatten / SPEC flatten / pending 改名 interaction / finding action 合并 redo-work / RegistryFile 加 4 个 version anchor 字段 / `loaf check tasks` canonical-alias 关系
> - **CLI design audit follow-up**(rev 4.1,clig.dev 二轮 review):
>   - §10.7 加 **`--dry-run` / `-n` global flag**(v1.0;fan-out worker pre-check 必备)+ §10.7 dry-run 契约 + schemas.ts §34 `dry_run_transaction_order`
>   - §10.11 加 **build-time URL stamping**(`LOAF_DOCS_URL` / `LOAF_ISSUE_URL`);§15 done-when 第 5 条强制 release 前 grep placeholder 阻断
>   - 新 §10.15 **`loaf doctor` 诊断清单**(9 个 check 显式分类:stale-lock / orphan-tmp / registry-stale / registry-orphan / registry-gc / crash-log-prune / schema-drift / artifact-corruption / url-placeholder)
>   - §10.2 + §10.3 respect 通用 env vars **`FORCE_COLOR`**(CI pipe 仍要色) + **`DEBUG`**(等价 `LOAF_DEBUG`)
>   - 命名清理:§10.6 chaos deviation 列表补 `loaf settle`;§10.8 `loaf tasks <op>` 一行展开为 6 行(add / claim / done / register-red / amend / submit 各自语义);§10.0 自夸 microcopy 修剪
> - **多 pending 队列升级 v1.0**(rev 4.1,原 §16 deferred):
>   - schemas.ts §11 新加 `PendingId` + `PendingPromptEntry`(wraps `PendingPrompt`)+ §12 `StateJson.pending: PendingPrompt | null` → `PendingPromptEntry[]`(default `[]`)+ §13 RegistryFile mirror 加 `pending_queue_depth` 派生字段
>   - 语义:FIFO 队列,`pending[0]` 是 active blocker,resolve 永远 pop head(v1.0 严格 FIFO);其它 entry 在 head resolve 后自动 promote。**worker raise pending 不阻塞其它 worker**(只阻塞 user-facing 命令)
>   - 动机:rev 4.0 EXECUTE.work fan-out 多 worker 各自 raise pending,single-valued 强制 serialize 失败 — 队列是 fan-out 必要语义
>   - §4.1 invariant + §10.7 prompt 行为 + §10.8 命令表(`pending list / status / resolve`)+ §14.3 整段重写为 FIFO + §14.4 TUI 队列徽章 `[×N]` + schemas.ts §34 atomic mutation list 加 `pending raise/resolve` + PEND-id allocation 规则
>   - ADR-0003 Addendum 2 记录决策;§16 删 "多 pending 队列 v1.1 再考虑" 行;`--id PEND-N` 跳序保留为新 §16 non-goal(v1.x 再加)
> - **v1.1 措辞统一清理**:协议正文不再用 "v1.1 推迟" 模糊承诺。§10.14 "自动 commit/PR/CI" 改 "永久 non-goal"(rev 3.1 锁定);§12.2 "lessons promote/list" 改 "v1 显式不做"(scope discipline,需要单独 ADR 才考虑);唯一 "v1.1" 残留是 ADR-0003 Open Question 段(历史 reasoning 记录,正确)
> - **quick 跳过 SETTLE 直跳 DONE**(rev 4.1,ADR-0003 Addendum 3):reconcile.json 是 standard+ / lessons.md quick skip,SETTLE 对 quick 本来就是纯 pass-through。本 rev 让 quick **完全跳过 SETTLE phase**,`loaf deliver` 从 `EXECUTE.done` 直接转到 `DONE.delivered`;verify-min 边界从 "EXECUTE.done → SETTLE.reconcile" 迁移到 "EXECUTE.done → DONE.delivered"(`loaf deliver` 入口)。`PROFILE_POLICIES.quick.phases_run` 从 `["TRIAGE","EXECUTE","SETTLE","DONE"]` 改成 `["TRIAGE","EXECUTE","DONE"]`;`SUB_STATE_CONTRACTS.EXECUTE.done.next` 加 `"DONE.delivered"`(quick 条件)。**spike 仍走 §8.3 三出口**(用户显式),不在本路径。典型 use case:"button → 16.dp" 类单文件改动,3 个命令完事(`advance` / `loaf deliver` /…)
> - **Session dispatch + AI client bridge**(rev 4.1,ADR-0003 Addendum 4):支持单 cwd 多 active feature 并行开发(unrelated module 同 repo)。CLI dispatch 走 5 级 fallback:`--session <UUID>` / `--feature <name>` flag > `$LOAF_SESSION` / `$LOAF_FEATURE` env > auto-pick(1 个 non-DONE feature 时)。**无 `.loaf/.active` 文件**(per-process ENV 自然隔离,避免文件 race)。`loaf start` stdout 最后一行 = UUID(预测式,shell scripting `UUID=$(loaf start ... \| tail -1)`);`loaf sessions list --in-cwd` 拾回。AI assistant client(Claude Code / Cursor / Windsurf)的 conversation runtime 跟 shell 不同(Bash one-shot + 可能 compaction 忘 UUID)→ client 自己 bridge 到 `~/.loaf/<vendor>-bridge/<conv-id>.json`(skill-level,不是 loaf-cli artifact);loaf-cli 只承诺 `--session` / `$LOAF_SESSION` 接口。多 Claude Code 同 cwd → 各自 conversation_id → 各自 bridge file → 零冲突。详见 §10.3 + §19.5 + ADR-0003 Addendum 4
>
> **rev 4.0 fresh-design refactor**(2026-05-12,driven by `adr/0002-fresh-design-rev4-candidates.md`):
> - **Spine**:Phase 按工作性质分两类。**Worker phase**(EXECUTE)承载实际副作用(写代码 / 跑测试 / 改文件),支持 sub-agent fan-out 并发,active 集合由 `tasks.json.task.status="in_progress"` 表达(SSOT);**Control phase**(TRIAGE / SPEC / VERIFY / SETTLE)承载 planning / checking / settling,主 skill serial 跑,intent 由 `sub_state` 精确表达
> - **C4**:`StateJson` 砍 3 字段 `current_task / current_step / current_check`(混淆了 worker active-set vs control cursor 两类语义);`RegistryFile` 同砍 3 字段并加 `active_tasks: TaskId[]`(derived projection,TUI 用);DONE.* 终态 invariant 中关于 active-set 的部分改由 `transitions.ts` cross-file 强制(§1 原则 3 让一档,Zod 不再 100% 契约)
> - **C8**:`SubState` 砍 `"VERIFY.check"`,加 4 个 check-specific sub_states `"VERIFY.run"` / `"VERIFY.review"` / `"VERIFY.acceptance"` / `"VERIFY.visual"`;intent 走 sub_state(17 → 20)
> - **C9'**:`RegistryFile` 加 `feature: string`(derived projection of `.loaf/<feature>/` dir basename)。RegistryFile 在 `~/.loaf/registry/<session_id>.json`,path **不**带 feature 上下文,TUI 启动单文件读需要这字段;StateJson **不** carry 同字段(其 path 已 carry feature dir,reader 可一行 derive — 避免 SSOT 冗余)
> - **CLI hardening**(§10 整段重写,经 clig.dev **two-pass audit**):
>   - stdout/stderr 分工(stdout = JSON/artifact,stderr = log/progress/error)
>   - help contract(`-h`/`--help`/`loaf help <cmd>`/did-you-mean/TTY-aware)
>   - TTY+color+pager(`NO_COLOR`/`LOAF_NO_COLOR`/`TERM=dumb`/`$PAGER`)
>   - env vars(`LOAF_*` UPPER_SNAKE + respect 通用 env)
>   - **config precedence**(high → low:flag > env > project > user > defaults)
>   - SIGINT cleanup(130 + 3s 硬超时,second-Ctrl-C 非破坏,wrap 命令 Ctrl-C 由内层接管)
>   - **state-change output convention**(每个 mutating 命令 stderr 一行 `<action>: <changed>` + 可选 `next:` hint,`--quiet` 抑制)
>   - **long-op progress**(>1s 命令 stderr spinner / milestone,非 TTY 时 newline-terminated)
>   - error rewriting(expected → exit 2 + diagnostic file;unexpected → exit 1 + crash log + **prefilled bug-report URL**:version / phase / sub_state / last command)
>   - subcommand 命名 noun-verb 默认 + 单 verb chaos deviation(`start`/`status`/`advance`/`deliver`/...)
>   - global flags 补齐(`--no-input` / `-v/--verbose` / `--quiet` / `--plain` alias / `--json` alias)
>   - exit codes 三档明确(0/1/2/130);`--format json` 声明 stable contract
>   - **man pages** per subcommand group(`man loaf-spec` / `man loaf-tasks` / etc)
>   - **no telemetry** + crash log 永不自动上传
>   - 命名修正:`loaf check tasks` → `loaf tasks check`;`loaf tasks status` → `loaf tasks list`(避免跟 session-level `loaf status` 歧义)
> - **C6**:`resume-pack.json` 加 `tasks_active_summary: Array<{ task_id, status, current_step }>`(snapshot derived from tasks.json),弥补 state_snapshot 不再 carry active detail 的信息缺
> - **C1 α**:Phase 不合并(6 phase 不变);worker / control 性质不同,合并会破坏边界
> - **Wang batch parallel** = skill 层 subagent fan-out(EXECUTE phase,见 `references/loaf-skill-helpers.md` §4);**rule-candidate auto-promote** = skill 编排(走 evidence + finding 现有 lifecycle,协议零变更)
> - **Breaking**:v1 还未 implement,Hyrum's Law 暴露 = 0,unfreeze 成本最低
>
> **rev 3.2 cleanup**(2026-05-12,driven by `adr/0001-task-graph-is-dag-not-tree.md`):
> - 砍 `constitution.decomposition_preference` + `constitution.max_tasks_warning_threshold`(rev 3.1 anti-over-decomposition 字段);两者属 workflow content 不属协议 shape(§1 原则 14)。coarse-default 偏好下沉到 loaf-skill 的 SPEC prompt 模板,见 `references/loaf-skill-helpers.md` §3
> - Wang 类 hierarchical workflow 评审收口:task graph 永远是 DAG 不是 tree;`parent_task_id` / `leaf_id` / 树字段均不进协议;hierarchical → DAG flatten 是 loaf-skill 中间层职责;`labels[]` namespace registry(`group:*` / `integration`)由 loaf-skill 维护
> - **§17 命名修正**:文档残留把当前协议称"v3"、把历史 Python 实现称"v2",与 `schemas.ts` L1 + §15-16 + `SCHEMA_VERSION=1` 直接矛盾。统一为「当前 = loaf-cli v1」+「历史 = legacy Python 原型」,去掉 "v2" 简写,避免未来真出 v2 时撞名
>
> **rev 3.1 主要变更**(rev 3 grilling 通关后内化):
> - **架构定位**:loaf-cli = 协议内核(opinionated SDD,schemas 即契约);loaf-skill = 工作流编排;3rd-party skill = schema 适配器
> - Q5 Applicability 三档 `must / optional / na`;**砍 `should`**;MUST 只能 passed/waived,**砍 `skipped`**
> - Q6 step enum 按 task_kind 拆分;`bug-fix` 折叠回 behavioral(用 `labels[]`);新增 `chore` kind;`local-check` 变 evidence kind;`record-findings` 变正交动作
> - Q7 evidence 加稳定 ID `EV-000123`,所有 refs 用 ID,不再用行号
> - Q8 evidence coverage 兼容性 `canSatisfy(evidence, coveredId)` 模块化
> - Q9 quick→standard escalation backfill,复用 SPEC.proposal
> - Q10 合并 `loaf.config.json`(替代 3 个独立 config);新增 `gate-diagnostic.json` + `resume-pack.json`
> - Q11 finding category 6 类,**新增 `risk-escalation`**
> - Q12 **砍 vague-word blacklist**;改为每 REQ 必须有 `measurable` / `verified_by_scenarios` / `acceptance_na+reason` 三选一
> - Q13 `manual` + `waiver` 拆成两个独立 evidence kind
> - Q14 attachments 改对象形态 `{ path, sha256, mime }`,protocol 强制 hash
> - Q15 registry 从单 jsonl 改成**每 session 一文件** `~/.loaf/registry/<id>.json`,atomic rename + 0600
> - 新章节 §18 i18n(8 类 stable IDs + diagnostic 模板,en/zh bundle)
> - 新章节 §19 三层架构(loaf-cli / loaf-skill / 3rd-party)
> - 批量:amend-spec 清 spec_locked、diff-guard 改 git status 全口径、pending 单值、DONE 终态 invariant、state 7 字段、tasks.execution.status 是 cache、workspace 显示用、spec.md frontmatter 加 `adr_refs[]`、evidence.actor 自由字符串带前缀

---

## 0. North Star

```
人想清楚 → agent 可靠执行 → 每一步都有据可追
```

三段对应三条工程纪律:
- **人想清楚**:SPEC phase 的子流程(proposal → spec → plan → design)是给人(和 LLM 当人用)的脚手架。**每条 REQ 必须有可验证路径**(三选一,见 §9)
- **agent 可靠执行**:6 phase × 17 sub-state 是 first-class 状态机;hook 在 sub-state 边界 enforce;EXECUTE/VERIFY 内部用 task graph + checklist 数据驱动
- **每一步都有据可追**:9 个 per-feature artifact + 1 项目 config + 1 用户级 registry,所有写入通过稳定 ID 单向引用(REQ/SCEN/VIS → task → step → evidence.covers[] → reconcile)

---

## 1. 设计原则

| # | 原则 | 落实 |
|---|---|---|
| 1 | Protocol over implementation | 本文档 + `schemas.ts` 是协议;bun 实现只是协议的一个 binding |
| 2 | Single source of truth = Zod | `schemas.ts` 定义一次,JSON Schema auto-derive;`loaf <artifact> schema --json` 自描述;**禁止手维护 .schema.json** |
| 3 | Schema IS the contract | schemas.ts 里的 enum / 形状 / refine 就是契约;skills 必须产出符合 schema 的 artifact;loaf-cli 严格 reject 非合规输入 |
| 4 | Stable Core vs Observability 分层 | 协议正确性硬依赖默认产出;观测细节走 `--debug` |
| 5 | 2 human gate | spec-lock + verify-accept;其余全 machine |
| 6 | EARS / Gherkin 是 LLM lint shape | 不是协作语言;不引入 Cucumber;EARS 结构化字段;Gherkin 仅命名锚点 |
| 7 | first-class sub-state | `state.json.sub_state = "EXECUTE.work"` 是合法协议值 |
| 8 | machine-verifiable first | 不再用语言黑名单做"verifiable";改成 **三选一可验证性**(每条 REQ 必须有 measurable / verified_by_scenarios / acceptance_na+reason) |
| 9 | iteration first-class | `state.iteration` 字段;循环不是异常 |
| 10 | VERIFY = checklist | 4 个 check kind 是数据,不是 sub-state;applicability 由 spec/tasks/profile/changed-paths 派生 |
| 11 | EXECUTE = task graph | task 之间用 depends_on 排序;**task 内部 step 跟随 task kind**(6 套小 enum,非通用) |
| 12 | N/A ≠ skipped(已 deprecated) | rev 3.1 砍掉 skipped。`waived`(显式带 reason)替代 |
| 13 | post-lock 必须经 finding | spec_locked=true 后,任何 spec/tasks/scope 变化必须 raise finding |
| 14 | 协议管 shape,skill 管 content | vague-word 这种语言风格 lint 是 loaf-skill 的事;协议层只校验结构(可验证性、ID 引用、写权限) |
| 15 | **Protocol state promotion / projection / mutation 三纪律**(rev 4.1)| ① Protocol state 只有在改变机器行为(allowed mutation / write_paths / evidence shape / interaction mode / recovery / TUI semantics / diagnostic class 至少 2 项)时才能 promote 成 first-class sub_state — 仅"prompt 文案更精确"不构成依据;② Derived projection(reconcile / registry / gate-diagnostic / resume-pack)允许 stale,**永远不是 gate authority**;③ 所有 artifact mutation 必须经 loaf-cli 在 per-session lock 下 atomic 完成,skill / sub-agent / 外部进程不得直写 `.loaf/<feature>/`。三纪律落地:§7.0 / §4.12 / §11.2 |
| 15a | **Truth model = single typed journal + reducer-derived projection**(rev 5.0)| Canonical truth 是 `.loaf/<feature>/journal.jsonl`(append-only,typed envelope 见 ADR-0005 §3.2) + `attachments/`(per-entry sidecar)。`state.json` / `tasks.json` / `evidence.jsonl` / `findings.jsonl` / `pending.json` / `reconcile.json` / `spec.md` / `lessons.md` 全是 **派生投影**(reducer 从 journal entries 重建,落 `snapshots/*.json` 与 markdown)。Mutation = `loaf <subcommand>` → preflight validate → sidecar finalize → final validate → journal append → reducer apply → snapshot rebuild,全在 §11.2 10-step transaction 内完成。Principle 15 ③(per-session lock)同时保留;15a 是其 truth model 落点。详 ADR-0005 §3 + §13.1 |

---

## 2. Phase 模型 + Iteration 循环

6 phase 是 macro state,**按工作性质分两类**:
- **Worker phase**(EXECUTE)— 承载实际副作用(写代码 / 跑测试 / 改文件),支持 sub-agent fan-out 并发。Active 集合 = `tasks.json.task.status="in_progress"` filter(rev 4.0 砍掉 `state.current_task` 字段,改 derive)
- **Control phase**(TRIAGE / SPEC / VERIFY / SETTLE)— 承载 planning / checking / settling,主 skill serial 跑。Intent 由 sub_state 精确表达(VERIFY phase 4 个 check 各自一个 sub_state)

**deep**:SPEC → EXECUTE → VERIFY → SETTLE 是完整链,strict 三件套全开。
**standard**(rev 5.x):SPEC → EXECUTE → VERIFY → DONE,跳过 SETTLE(reconcile/lessons 留给 deep)。
**light**(rev 5.x):SPEC → EXECUTE → DONE,跳过 VERIFY + SETTLE(verify-min @ deliver 兜底)。
**quick**(rev 4.1):TRIAGE → EXECUTE → DONE 直跳,跳过 SPEC / VERIFY / SETTLE 三 phase。

```
                          ┌─[amend-spec]──────────────────┐  (spec_phase=true)
                          │                               │
                          │   ┌─[amend-tasks]─────────┐   │
                          │   │                       │   │
                          │   │  ┌─[fix-impl / fix-test]─┤  │
                          │   │  │                       │  │
                          ↓   ↓  ↓                       │  │
TRIAGE → SPEC.* → EXECUTE.work ─→ VERIFY.* ──[verify-accept]──┬─→ SETTLE.* → DONE.*    (deep)
   │        │       ┌──fan-out──┐      │                      │                  ↑
   │        │       │ worker A  │      │                      └─→ DONE.delivered │     (standard, rev 5.x)
   │        │       │ worker B  │      │                                         │
   │        │       │ worker C  │      │   iteration++(每次回退)                │
   │        │       └───────────┘      │                                         │
   │        ↓                          ↓                                         │
   │        └─[pending queue]──────────┘     ← 任何 phase 都可能 raise pending  │
   │              (FIFO,head blocks)        ← head resolved 才放后续命令通行    │
   │                                                                              │
   ├─[light bypass,rev 5.x]──────────────[verify-min ok]→ DONE.delivered         │
   │      TRIAGE → SPEC.* → spec-lock → EXECUTE.* ───────────────┘                │
   │      (skip VERIFY + SETTLE;verify-min @ deliver;                            │
   │       deliver 打 "REQ coverage not closed" 提示)                            │
   │                                                                              │
   └─[quick bypass,rev 4.1]──────────────[verify-min ok]→ DONE.delivered ────────┘
      TRIAGE.confirm → EXECUTE.plan → EXECUTE.work → EXECUTE.done
      (skip SPEC + VERIFY + SETTLE;verify-min 在 deliver 边界跑;
       spike 仍走 §8.3 三出口,non-spike 直跳 DONE.delivered)
```

**两条**正交于 state machine 主轴**的 v1.0 语义**:

1. **Worker fan-out**(rev 4.0):`EXECUTE.work` sub_state 是 worker phase,允许 sub-agent fan-out 并发。Active set = `tasks.json.tasks.status="in_progress"` filter(多元集合);其它 sub_state(包括 TRIAGE / SPEC / VERIFY / SETTLE)是 control phase,主 skill serial 跑。Fan-out 是 EXECUTE.work 独占特权,**不影响 state machine 主轴**(state 仍单 cursor)。
2. **Pending FIFO 队列**(rev 4.1):任何 phase 都可能 raise pending(`gate_decision` 在 SPEC.lock / VERIFY.accept;`finding_decision` 在 EXECUTE.work post-lock;`profile_escalation` 在 EXECUTE.* / SPEC.*;`ask_user_question` 任何 phase)。Pending 是 **side-effect queue**;**protocol 层 enforcement 极简**(rev 4.1 Q3):**`loaf advance` 仅在 head kind ∈ {`gate_decision`, `profile_escalation`} 时拒**,其它命令一律放行,更广的工作流调度由 skill 自己看 `loaf pending list` 决定。Worker 不被自己/他人的 pending 阻塞,各自跑到自己撞 pending 为止。详见 §10.7 + §14.3。

**iteration 字段**:
- 进入 SPEC.proposal 第一次时 iteration = 1
- 每次 finding 触发回退(amend-spec / amend-tasks / fix-impl / fix-test),iteration += 1
- `defer` / `backlog` 不增 iteration(没回退)
- SETTLE.reconcile 时 iteration_stats 统计

### 20 sub-state 清单(rev 4.0:VERIFY.check 拆 4)

```
TRIAGE                                          control phase
  ├─ TRIAGE.score          complexity 打分
  └─ TRIAGE.confirm        profile 确认 / override

SPEC                                                ┐ control phase
  ├─ SPEC.proposal         why / scope / anti-scope │
  ├─ SPEC.spec             EARS + Gherkin + Visual  │
  ├─ SPEC.plan             risks / milestones       │
  └─ SPEC.design           设计 + tasks 生成         │  ─[spec-lock]
EXECUTE                                             │ WORKER phase
  ├─ EXECUTE.plan          derive per-task policy   │ (fan-out 允许)
  ├─ EXECUTE.work          active set in tasks.json │ (worker active set
  │                        (filter status=in_progress) — 单数 EXECUTE.task
  │                                                   rev 4.1 rename 为 .work
  │                                                   反映多元 fan-out 现实)
  └─ EXECUTE.done          all tasks final          │
VERIFY                                              │ control phase
  ├─ VERIFY.plan           compute applicable checks│
  ├─ VERIFY.run            test + lint + typecheck  │  ┐
  ├─ VERIFY.review         quality reviewer         │  │ rev 4.0
  ├─ VERIFY.acceptance     Gherkin E2E              │  │ 拆 4
  ├─ VERIFY.visual         visual contract          │  ┘
  └─ VERIFY.accept         machine + human gate     │  ─[verify-accept]
SETTLE                                                control phase
  ├─ SETTLE.reconcile      planned vs actual + drift
  └─ SETTLE.lessons        compound 候选

DONE                                                 terminal
  ├─ DONE.delivered        after `loaf deliver`
  ├─ DONE.archived         after `loaf archive`
  └─ DONE.abandoned        after `loaf abandon` (reason required)
```

**rev 4.0 终态 invariant**:任意 `DONE.*` 子状态下:
- `state.pending.length === 0`(rev 4.1 起 `pending` 为 FIFO 数组,空形态是 `[]`,**不**是 `null`;StateJson 内嵌 refine 强制)
- `tasks.json` 中无 `status="in_progress"` 的 task(active-set 部分,cross-file invariant 由 `transitions.ts` 在 `loaf advance` / `loaf tasks check` 时强制 —— Zod 单文件 refine 无法表达跨文件约束,这是 rev 4.0 fresh design 对 §1 原则 3「Schema IS the contract」的一档让步)
- `DONE.abandoned` 必有 reason(写入 `loaf abandon --reason`)

> **rev 3.x 的旧 invariant**(`current_task / current_step / current_check` 必为 null)在 rev 4.0 已无意义 —— 这三个字段被砍,信息源迁移到 tasks.json + sub_state。

---

## 3. Ceremony — 6 flag 字段 + skill PRESETS(rev 4.2)

### Ceremony schema(CLI 唯一逻辑来源)

`state.ceremony` 6 字段决定本 session 的 ceremony 配置(`schemas.ts::Ceremony`):

| 字段 | 类型 | 默认 | 控制什么 |
|---|---|---|---|
| `spec_phase` | bool | `false` | 跑 SPEC.* sub_states 吗?(false → TRIAGE.confirm 直接进 EXECUTE.plan)|
| `verify_phase` | bool | `false` | 跑 VERIFY.* sub_states 吗?(false → EXECUTE.done 跳 VERIFY;verify-min 在 `loaf deliver` 入口跑)|
| `settle_phase` | bool | `false` | 跑 SETTLE.* sub_states 吗?(false → 不产 reconcile.json)|
| `strict_spec_review` | bool | `false` | spec-lock gate 额外校验 `kind=spec-review` evidence 且 `actor ≠ implementer`?|
| `lessons_required` | enum | `"skip"` | SETTLE.lessons:`"must"` / `"may"` / `"skip"` |
| `strict_drift_check` | bool | `false` | SETTLE.reconcile 严格 drift?(无 carried_forward)|

**Cross-field invariants**(Zod refine):
- `settle_phase=true` 要求 `verify_phase=true`
- `strict_spec_review=true` 要求 `spec_phase=true`
- `lessons_required ≠ "skip"` 要求 `settle_phase=true`
- `strict_drift_check=true` 要求 `settle_phase=true`

### Ceremony label — cosmetic only

`state.ceremony_label` 字符串,**仅显示用**(error / TUI / state-change line)。CLI **不解析** label。Skill 写什么 CLI 透传。

### Skill 提供 PRESETS 表(协议中立)

CLI 不内置 preset 名。**Skill 维护 PRESETS 表**;loaf-skill v1 默认 4 个:

| label | spec_phase | verify_phase | settle_phase | strict_spec_review | lessons_required | strict_drift_check | 典型 use case |
|---|---|---|---|---|---|---|---|
| `quick` | ❌ | ❌ | ❌ | ❌ | skip | ❌ | 单文件 / 文案 / spike(score < 20)|
| `light` | ✓ | ❌ | ❌ | ❌ | skip | ❌ | 有 spec 但跳 verify(score 20-40)|
| `standard` | ✓ | ✓ | ❌ | ❌ | skip | ❌ | 典型 feature(score 40-70)|
| `deep` | ✓ | ✓ | ✓ | ✓ | must | ✓ | 跨模块 / public API / schema(score ≥ 70)|

**rev 5.x 决策**:standard 不再跑 SETTLE(reconcile snapshot + lessons 留给 deep 作差异化)。reconcile 数据全在 journal 里 reducer 可重算,standard 用户需要 audit 走 `loaf doctor --rebuild` on-demand 触发。4 档单调递增 ceremony 由此对齐:**quick(EXECUTE 直跳 DONE)→ light(+SPEC)→ standard(+VERIFY)→ deep(+SETTLE + strict 三件套)**。每档加一件事,清晰度优先于 standard 的隐式 audit 收口仪式。

skill `loaf start` 流程:算 complexity_score → 推 preset label → user 接受或 override → `loaf start --ceremony-json '<PRESETS[label]>' --ceremony-label '<label>'` → CLI 写 `state.ceremony` + `state.ceremony_label`。

3rd-party skill(cursor-loaf / windsurf-loaf / 自定义)可起任意 preset 名,**协议层中立**。详见 `references/loaf-skill-helpers.md` + ADR-0003 Addendum 6。

`findings.jsonl` 在 `ceremony.spec_phase=true` 时允许;`spec_phase=false` 拒。`trace.jsonl` 仅 `--debug`。

### verify-min(防偷渡,rev 4.2)

当 `ceremony.verify_phase=false` 时跳过完整 VERIFY;verify-min 机器检查在 `loaf deliver` 入口跑(`EXECUTE.done → DONE.delivered` 边界):
- 若 task 触代码 → 必须有 build/test 类 evidence 至少一条
- 若 task 是 visual-ui → 必须有 manual/visual-review evidence 至少一条
- 若任一 task 是 spike → **deliver hard block**(同 §10.8);stderr 提示用户**显式**走 §8.3 三出口之一:`loaf archive --reason "..."` / `loaf spike convert --to-feature F-N` / `loaf abandon --reason "..."`。**不 auto-archive**(§8.3 三出口全部要求用户显式动作 + 都需 `--reason`,protocol 不替用户编造 reason)
- **混跑 spike + 非 spike task**(rev 4.1 显式):session 内同时有 spike 和 deliverable task 是边缘 case — spike block 是 **session-level**,任一 spike 触发整 session deliver hard block。**默认推荐**:`loaf advance` 进 `EXECUTE.plan` 时检测到混跑 → stderr warning,建议拆(spike 独立起一个 quick session)。**用户坚持混跑**:只能整 session 走 §8.3 三出口(non-spike 工作通过 `loaf spike convert --to-feature F-N` 在新 feature 里继承,旧 session DONE.archived)
- 若都没有 → 阻塞,要求显式 `loaf evidence add --kind manual --reason "..."`

**verify-min 通过 → `loaf deliver` 一步转移到 `DONE.delivered`**(stdout 仍打印 advisory commit/PR 建议,见 §10.14);失败 → exit 2 + stderr 列出缺什么 evidence。

**rev 5.x:light profile spec 语义提示**。`ceremony.spec_phase=true && ceremony.verify_phase=false`(light)时,verify-min 通过后 `loaf deliver` **按输出格式分流**该提示(遵守 §10.0 stdout/stderr 分工与 §10.3 `--format` 契约):

| 输出 format | 位置 | 形态 |
|---|---|---|
| `--format text`(TTY 默认)| stdout 主输出末尾 | 单段 advisory note,与 deliver suggested-commands 同段(人类可读) |
| `--format json`(pipe / `-format=json`)| stdout JSON 主体 | `warnings[]` 数组追加一条 `{ code: "REQ_COVERAGE_NOT_CLOSED_LIGHT", message: "...", remediation: "..." }`(机器可消费) |
| 纯 log channel | stderr | **不**写;stderr 保持「错误 / progress / 引用文件路径」用途,不放 advisory(避免 `loaf deliver --format=json 2>/dev/null` 时丢提示)|

提示原文(text 格式 / json `message` 字段共用):

```
note: spec_phase=true but verify_phase=false — REQ coverage not closed at deliver
      (spec.md acts as intent anchor only; canSatisfy() not enforced for REQ/SCEN/VIS).
      To close REQ coverage formally, escalate ceremony to standard via
      `loaf profile escalate` + `loaf finding raise --action amend-spec`.
```

理由:light 写了 spec 但不跑 verify-accept gate #3(canSatisfy()),用户容易误以为"既然写了 spec,REQ 就应该自动 close"。这条提示明确边界:**light 的 spec 是 intent anchor,不是 contract closed**;要正式 close 升 standard。Quick(spec_phase=false)无此提示。**机器可消费版本**(json `warnings[]`)让 CI / wrapper 工具能在 `--format=json` 下检测并 surface 给上游 review tool,不依赖人 parse stdout 文本。

### Ceremony auto-escalation(rev 4.2,原 Q9 backfill 路径)

EXECUTE 阶段 CLI 自动检测 trigger 条件,**raise `PendingPrompt(kind=profile_escalation)`**(命名沿用 — 跟 PendingPromptKind enum 一致,不破 §15 freeze;语义是 "ceremony 升档建议"):

| trigger | 建议 ceremony 升级 |
|---|---|
| `scope_expansion` | `spec_phase=false` → `true`(quick → light)|
| `public_api_touched` / `schema_change` / `concurrency_touched` / `security_touched` | `spec_phase` / `verify_phase` / `settle_phase` 全 → `true`(quick / light → standard)|

CLI 只负责检测 trigger + raise pending;**skill 决定**新 ceremony object(skill PRESETS 表里映射 trigger → 推荐 preset label),user 确认后 skill 调 `loaf advance` 同时传新 `--ceremony-json` 覆盖。详见 schemas.ts §24 `ESCALATION_DETECTIONS`。

**不允许自动降级**。

#### Q9 quick → standard backfill 路径

quick 升级到 standard 时,SPEC 必须补齐。**不新增 sub-state**,复用 `SPEC.proposal`:

```
1. user confirm escalation prompt → loaf 写 state:
     state.phase = "SPEC"
     state.sub_state = "SPEC.proposal"
     state.spec_locked = false
     state.based_on.spec += 1
     (iteration 不变)

2. loaf-cli 把 backfill 上下文写到:
     .loaf/<feature>/spec-draft-context.md
        ├─ 原 prompt
        ├─ 当前 git diff 摘要
        └─ 已有 evidence 列表(EV-id + summary)

3. loaf-skill 读 spec-draft-context.md,驱动 LLM 反向归纳 spec.md

4. 正常 SPEC.spec → SPEC.design → spec-lock → 重入 EXECUTE
```

EXECUTE 之前的 evidence 不浪费;`based_on.spec` 跳号让审计能识别"这次 SPEC 来自 escalation"。

### 自动判分(TRIAGE.score)

6 维度各 0-20:`files_touched / new_module / public_api_change / schema_change / concurrency / security`。用户可 override,写入 state.json 留痕。

---

## 4. Artifact 契约(9 per-feature + 1 config + 1 user-level)

> **rev 5.0 authority bridge**(ADR-0005 §3.1 落点):
>
> 自 rev 5.0,**canonical truth** 是 `.loaf/<feature>/journal.jsonl`(append-only,typed envelope)+ `attachments/<entry_id>/` 目录(per-entry sidecar)。本节描述的所有 9 个 per-feature artifact (`state.json` / `spec.md` / `tasks.json` / `evidence.jsonl` / `findings.jsonl` / `reconcile.json` / `lessons.md` / `gate-diagnostic.json` / `resume-pack.json`)均为 reducer 从 journal entries 重建的 **派生投影**(落 `snapshots/*.json` 或 markdown)。本节 schema 文档保留用于 reader / TUI / CI 消费;**mutation 永远经 `loaf <subcommand>` → journal entry,从不直写 artifact**(§11.2 + Principle 15a)。每节标题下的 `> **Authority**:` 注释明示该 artifact 的 layer(详 §13.1)。

```
.loaf/                              repo-level,git-tracked
  ├─ <feature>/                                            一 feature 一目录
  │   ├─ journal.jsonl       canonical truth              append-only,typed envelope(ADR §3.2)
  │   ├─ attachments/<entry_id>/...                       per-entry sidecar(LongTextField / migration)
  │   ├─ snapshots/          派生投影(reducer-derived,reader-only;§13.1)
  │   │   ├─ state.json                                   phase + sub_state + ceremony + iteration
  │   │   ├─ tasks.json                                   task graph snapshot
  │   │   ├─ evidence.json                                evidence ledger view + 派生 gate-decision view
  │   │   ├─ findings.json                                findings list view
  │   │   ├─ pending.json                                 pending queue + resolved_log slice
  │   │   ├─ reconcile.json                               drift snapshot(SETTLE 阶段产)
  │   │   ├─ gate-diagnostic.json                         on gate fail(结构化诊断快照)
  │   │   ├─ resume-pack.json                             on `loaf handoff`
  │   │   └─ _meta.json                                   last_applied_seq + last_entry_offset
  │   │                                                   + last_entry_line_hash + rolling_checksum
  │   ├─ spec.md             派生投影                     reducer 从 event:spec_* entries 重建
  │   ├─ lessons.md          派生投影 / Advisory          SETTLE 最终态(deep:MUST;quick/light/standard:skip,rev 5.x)
  │   ├─ spec-draft-context.md  escalation only          Q9 backfill 输入(per-skill,非 journal)
  │   ├─ trace.jsonl         --debug only                 per-cmd verbose log(NOT a journal entry)
  │   └─ .lock                                            per-feature flock(§11.2)
  └─ .config/loaf.config.json   optional                  项目级合并配置(canonical,non-journal)

../<feature>.backup-v1/      v0.0.x → v0.1.0 migration only(旧 N-file artifacts 备份,ADR §5.2)

~/.loaf/                            user-level,NOT in repo
  └─ registry/<session_id>.json     一 session 一文件(派生投影,atomic rename + 0600)
```

**rev 5.0 layout 关键变化**(ADR-0005 §3.1):
- `state.json` / `tasks.json` / `evidence.jsonl` / `findings.jsonl` / `reconcile.json` / `gate-diagnostic.json` / `resume-pack.json` 全部下移到 `snapshots/`,前缀 `*.json`(jsonl → json),从 "always written by mutator" 变为 "reducer-rebuilt from journal"
- `journal.jsonl` 是新 canonical truth
- `attachments/` 目录键从 `<EV-id>` 改为 `<entry_id>`(JE-NNNNNN),per-entry-sidecar 模型
- `snapshots/_meta.json` 是 reader fast-check 入口(Gate #5)
- `spec.md` / `lessons.md` 形态保留,但 mutation 永远经 journal entry 由 reducer 重写

完整 Zod schema 在 `schemas.ts`。下面只示例 + 关键约束。

### 4.1 state.json(派生投影 — reducer-derived,session level only)

> **Authority**: 派生投影(`snapshots/state.json`),reducer 从 `event:phase_advanced` / `event:ceremony_set` / `pending:added|resolved` / `gate:decided` / `session:*` entries 重建。允许 ≤1 mutator 周期 stale。Gate 永远不读;读时走 §10.15 fast check + 失败 exit 2 `SNAPSHOT_STALE_REBUILD_REQUIRED`(ADR-0005 §3.6 reader contract)。

> **rev 5.0 note**: 本节字段语义未变;变的是 layer——`state.json` 不再是 mutation 入口,任何 phase / sub_state / ceremony / pending / iteration 推进都通过 journal entry 由 reducer derive。原"单源真理"标题在 rev 5.0 退场,canonical truth 移至 `journal.jsonl`(§4 intro + §13.1)。

rev 4.0 后字段分三组(active-set detail 不再 store 在 state):
- **identity**:`session_id` / `session_label` / `cwd` / `workspace`
- **control**:`pending` / `spec_locked` / `verify_accepted` / `phase` / `sub_state`
- **liveness**:`heartbeat_at`

> **Slice 1.A note**:`spec_locked` 和 `verify_accepted` 是 gate 批准 flag,**gate 不再移 cursor**(以前 `gate:decided spec-lock` 同时翻 flag + 移 cursor 到 EXECUTE.plan,现在只翻 flag)。Cursor 推进由同一 batch 内的 `event:phase_advanced`(spec-lock 配 SPEC.design→EXECUTE.plan)或 `loaf deliver`/`loaf settle`(verify-accept 后)负责。

```json
{
  "schema_version": 2,
  "loaf_version_required": "^1.0",
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "session_label": "popposhell · auth refresh",
  "cwd": "/Users/est9/popposhell",
  "workspace": "default",
  "phase": "VERIFY",
  "sub_state": "VERIFY.visual",
  "iteration": 2,
  "spec_locked": true,
  "verify_accepted": false,
  "pending": [],
  "debug": false,
  "ceremony": {
    "spec_phase": true,
    "verify_phase": true,
    "settle_phase": false,
    "strict_spec_review": false,
    "lessons_required": "skip",
    "strict_drift_check": false
  },
  "ceremony_label": "standard",
  "complexity_score": 38,
  "based_on": { "spec": 3, "tasks": 5 },
  "heartbeat_at": "2026-05-12T10:30:45Z",
  "created_at": "2026-05-12T08:00Z",
  "updated_at": "2026-05-12T10:30:45Z"
}
```

**非空 pending 队列示例**(fan-out 中 worker A 撞 profile_escalation,worker B 撞 finding_decision,user 还没答 head):

```json
"pending": [
  {
    "pending_id": "PEND-0007",
    "kind": "profile_escalation",
    "question": "T-005 触 PublicAPI,从 standard → deep?",
    "options": ["confirm", "decline"],
    "blocks": "advance",
    "raised_at": "2026-05-12T10:18:00Z",
    "raised_by": "skill:loaf-cli/sdd-execute",
    "raised_by_task_id": "T-005",
    "at": "2026-05-12T10:18:01Z"
  },
  {
    "pending_id": "PEND-0008",
    "kind": "finding_decision",
    "question": "FND-003 spec-gap action? (amend-spec / defer / backlog)",
    "options": ["amend-spec", "defer", "backlog"],
    "blocks": "advance",
    "raised_at": "2026-05-12T10:21:30Z",
    "raised_by": "skill:loaf-cli/sdd-execute",
    "raised_by_task_id": "T-012",
    "at": "2026-05-12T10:21:31Z"
  }
]
```

`PEND-0007` 是 head;因 kind=`profile_escalation` ∈ {`gate_decision`, `profile_escalation`},protocol 拒 `loaf advance`(见 §10.7「Pending head 阻塞」)。user 答完后 `loaf pending resolve --answer confirm` → 弹出 head → `PEND-0008` 自动 promote 为新 head;`finding_decision` **不在** protocol 阻塞集,`advance` 此时**不**被 CLI 拦——但 skill 通常会自己查 `loaf pending list` 决定先 resolve 完再 advance。条目里的 `blocks` 字段是描述性 metadata,enforcement 走 `kind`。

> rev 4.0:`current_task` / `current_step` / `current_check` 字段已**全砍**。「正在跑哪些 task」走 `tasks.json` filter `status="in_progress"`(worker active set);「当前 step」走 `task.execution.<step>.status === "running"` derive;「正在跑哪个 verify check」由 sub_state 表达(`VERIFY.run` / `VERIFY.review` / `VERIFY.acceptance` / `VERIFY.visual`)。

**Invariant**:
- `sub_state.startsWith(phase + ".")` (StateJson 内嵌 refine)
- `phase = "DONE"` 时 `tasks.json` 中无 `status="in_progress"`(**cross-file invariant**,由 `transitions.ts` 强制 — Zod 单文件 refine 无法表达;rev 4.0 fresh design 对 §1 原则 3 的一档让步)
- `pending` 是 **FIFO 队列**(rev 4.1:数组,default `[]`);**head 元素 `pending[0]` 是 active blocker**。Protocol 层阻塞规则极简(rev 4.1 Q3,见 §10.7 / §14.3 L2019):**`loaf advance` 在 head kind ∈ {`gate_decision`, `profile_escalation`} 时 exit 2**。其它 35+ 命令 protocol 不做 pending 阻塞 — fan-out 调度由 skill 通过 `loaf pending list` 决策。resolve 永远 pop head(v1.0 严格 FIFO,无 `--id` 跳序)
- **`pending` 反向定义**(rev 4.1):每个 entry 是一次 **single blocking interaction**(等用户回答 / human gate 批准 / finding decision / profile escalation 等);**不是** unfinished work 集合,**不是** derived obligation list。所有其它"待处理事项"(未跑完的 check / 未关的 finding / 未做的 task)由 tasks / spec / evidence / findings 派生计算,**不进** state.pending。队列存在的唯一原因:rev 4.0 fan-out(EXECUTE.work)多 worker 各自 raise 不同 pending,FIFO 排队避免互相阻塞。详见 §14.3
- **DONE.* 终态**:`pending.length === 0`(StateJson 内嵌 refine 强制 — `pending` 是数组,空形态是 `[]` 不是 `null`);active-set cross-file invariant 见 §2(`tasks.json` 中无 `in_progress`)
- `workspace` 字段 v1 仅 display 用,不接入任何 gate / 路径逻辑

### 4.2 spec.md(EARS 三选一可验证 + Gherkin + Visual Contracts + adr_refs)

> **Authority**: 派生投影(reducer 从 `event:spec_req_added` / `event:spec_scenario_added` / `event:spec_visual_added` / `event:spec_submitted` entries 重建)。`SPEC.*` pre-lock 阶段允许 `$EDITOR` 编辑工作副本,但提交必须经 `loaf spec submit` → journal entry(§11.2);post-lock 直写由 diff-guard 拦截(§11.1)。

```markdown
---
schema_version: 2
spec_version: 2
feature: { id: F-001, name: "OAuth access token refresh" }
intent: |
  用户在 access token 过期但 refresh token 仍有效时,
  不应感知登录态恢复过程。
adr_refs:
  - docs/adr/0023-auth-refresh-strategy.md     # 外部架构决策引用,loaf 不解析内容
requirements:
  - id: REQ-AUTH-001
    type: event-driven
    trigger: "an API request receives HTTP 401"
    response: "the system shall attempt to refresh the access token before surfacing an authentication failure"
    verified_by_scenarios: [SCEN-AUTH-E2E-001]                 # ① 通过 scenario 验证
  - id: REQ-AUTH-002
    type: event-driven
    trigger: "multiple API requests receive HTTP 401 concurrently"
    response: "the system shall perform at most one token refresh request within a 500ms window"
    measurable:                                                # ② 可测度量
      metric: refresh_requests_within_500ms
      threshold: 1
      unit: count
      direction: lte
  - id: REQ-AUTH-005
    type: ubiquitous
    response: "the login UI shall feel intuitive"
    acceptance_na: true                                        # ③ 显式不可测,带 reason
    acceptance_na_reason: "subjective UX quality validated via user testing outside protocol scope"
scenarios:
  - id: SCEN-AUTH-E2E-001
    name: "Expired token recovered by refresh"
    tag: e2e
    requires_acceptance: true
    given: ["user has valid refresh token", "access token is expired"]
    when: ["user opens the order list"]
    then:
      - "system refreshes the access token"
      - "order list is displayed"
      - "user not redirected to login"
visual_contracts:
  - id: VIS-AUTH-001
    target: "Login primary button during refresh in-flight"
    checks:
      - "shows loading spinner inside button"
      - "button is disabled to prevent repeated taps"
    requires_visual: true
needs_clarification: []
---

## Why
（prose body — body 段落也要带 REQ-* / SCEN-* / VIS-* 锚点）
```

**机器校验**(`loaf check spec`):
- frontmatter 通过 `SpecFrontmatter` schema
- 每个 REQ-* / SCEN-* / VIS-* ID 必须在 body 出现 ≥1 次(防 frontmatter ↔ body 漂移)
- **每个 REQ 必须三选一可验证**:`measurable` / `verified_by_scenarios[]` / (`acceptance_na: true` + `acceptance_na_reason ≥ 10 chars`)
- `needs_clarification` 非空时 spec-lock 阻断
- `adr_refs[]` 只校验路径字符串非空,不解析文件内容(loaf 不感知架构)

**rev 3.1 砍掉**:vague-word blacklist 完全不存在。"fast / smooth / quickly" 这种词的判断是 loaf-skill 的 prompt 责任(soft suggestion),不进协议。

#### 增量构造 + spec_version bump 策略(rev 4.3,ADR-0004 A4)

`loaf spec submit <file>` 是 spec.md 的**整体替换**入口(SPEC.proposal → SPEC.spec 首次提交);rev 4.3 之后**不再**强制 LLM 一次手搓全部 EARS / scenario / visual contract。增量路径由三条 `add-*` 命令承担:

- `loaf spec add-req --input <src>` — 增量加 EARS REQ
- `loaf spec add-scenario --input <src>` — 增量加 Gherkin scenario
- `loaf spec add-visual --input <src>` — 增量加 visual contract

`spec_version` bump 规则:

- 每次调用 = 一次 atomic invocation → `spec_version += 1`(**不**按 item +N;batch 输入 N 条仍只 +1,见 §11.2 batch 三纪律)
- `tasks.based_on.spec` 在 spec-lock 时记录当时的 `spec_version`,保证「spec 内容变了 → version 必然变」的 monotonic 锚
- 30+ 次 add-\* 是内部 audit 计数,不面向终端用户

phase gating(镜像 `loaf tasks add` 的 EXECUTE post-lock 规则):

| 当前 phase / sub_state | `spec add-*` 行为 |
|---|---|
| `SPEC.spec` / `SPEC.plan` / `SPEC.design`(pre-lock)| 接受,落 spec.md,bump `spec_version` |
| `EXECUTE.*` / `VERIFY.*` / `SETTLE.*` / `DONE.*`(post-lock)| 拒,`SPEC_LOCKED_NO_DIRECT_EDIT` exit 2,stderr 引导走 `loaf finding raise --category spec-gap --action amend-spec` 回到 SPEC.spec |
| feature 尚无 spec.md | 拒,`SPEC_NOT_INITIALIZED` exit 2,stderr 引导 `loaf spec init` |

post-lock 行为与 `loaf amend --target spec` 一致(§5.3 反向 transition):**唯一**合法回退路径是 finding。

#### ID 分配 — `id_namespace` 输入 vs 完整 `id` 输出(rev 4.3,ADR-0004 A5)

REQ / SCEN / VIS 的 input JSON **必填 `id_namespace`** 字段(语义 = stem,不含序号),CLI 在 per-session lock 内拼成完整 `id` 落到 spec.md。两个独立 regex,**不可混用**:

| 维度 | Regex | 例 |
|---|---|---|
| **Input**(LLM 出的 namespace)| `^REQ-[A-Z][A-Z0-9]*$` / `^SCEN-[A-Z][A-Z0-9-]*$` / `^VIS-[A-Z][A-Z0-9-]*$` | `REQ-AUTH`、`SCEN-LOGIN`、`VIS-DASH` |
| **Output**(CLI 拼完整 id 落 spec.md)| `^REQ-[A-Z][A-Z0-9]*-\d{3,}$` / `^SCEN-[A-Z][A-Z0-9-]*-\d{3,}$` / `^VIS-[A-Z][A-Z0-9-]*-\d{3,}$` | `REQ-AUTH-007`、`SCEN-LOGIN-001`、`VIS-DASH-001` |

CLI 分配流程(每次 add-\* / batch invocation):

```
1. Zod 校验 input(`id_namespace` 通过 input regex)
2. lock 内扫 spec.md,找该 namespace 下 max 序号 → 计算 next
3. 拼完整 id(zero-padded ≥ 3 位)
4. 通过 output regex 兜底校验
5. 落 spec.md + `spec_version += 1`(整 batch atomic)
6. stdout 回打分配到的完整 id 范围(state-change line 见 §10.12)
```

机器表达见 `schemas.ts` §40(`SpecReqInput.id_namespace` / `SpecScenarioInput.id_namespace` / `SpecVisualInput.id_namespace`)。input regex 与 output regex 是**两个独立 Zod 类型**,CLI 任何阶段不可直接互转(防 LLM 在 input 里塞带序号的伪完整 id)。

### 4.3 tasks.json(kind-driven + labels[] + 每 kind 自己的 step)

> **Authority**: 派生投影(reducer 从 `event:tasks_planned` / `event:tasks_amended` / `event:task_claimed` / `event:task_step_started` / `event:task_step_done` / `event:task_abandoned` entries 重建)。Mutation 全经 `loaf tasks <op>` → journal entry → reducer apply → `snapshots/tasks.json` rebuild。

```jsonc
{
  "schema_version": 2,
  "version": 5,
  "based_on": { "spec": 3 },
  "tasks": [
    {
      "id": "T-001",
      "kind": "behavioral",
      "labels": ["bug"],                       // rev 3.1: bug-fix 折叠回 behavioral 用 label
      "drives": ["REQ-AUTH-002"],
      "tests": ["TokenCoord.concurrent401OnlyRefreshesOnce"],
      "test_layer": "unit",
      "depends_on": [],
      "red_test_registered": true,             // labels 含 "bug" 时必须 true
      "status": "done",
      "execution": {
        "red":       { "applicability": "must", "status": "passed", "evidence_refs": ["EV-000123"] },
        "implement": { "applicability": "must", "status": "passed", "evidence_refs": ["EV-000124"] },
        "refactor":  { "applicability": "optional", "status": "passed" }
      }
    },
    {
      "id": "T-099",
      "kind": "structural",
      "no_test_rationale": "rename AuthInterceptor → TokenInterceptor, no behavior change",
      "depends_on": ["T-001"],
      "status": "pending",
      "execution": {
        "implement": { "applicability": "must", "status": "pending" },
        "refactor":  { "applicability": "optional", "status": "pending" }
      }
    },
    {
      "id": "T-200",
      "kind": "visual-ui",
      "visual_contract_refs": ["VIS-AUTH-001"],
      "depends_on": [],
      "status": "pending",
      "execution": {
        "mockup":             { "applicability": "must", "status": "pending" },
        "implement":          { "applicability": "must", "status": "pending" },
        "screenshot-compare": { "applicability": "must", "status": "pending" }
      }
    },
    {
      "id": "T-900",
      "kind": "spike",
      "no_test_rationale": "explore single-flight library options",
      "depends_on": [],
      "status": "pending",
      "execution": {
        "explore":   { "applicability": "must", "status": "pending" },
        "prototype": { "applicability": "must", "status": "pending" },
        "record":    { "applicability": "must", "status": "pending" }
      }
    },
    {
      "id": "T-950",
      "kind": "chore",
      "no_test_rationale": "version bump in gradle.properties",
      "depends_on": [],
      "status": "pending",
      "execution": {
        "execute": { "applicability": "must", "status": "pending" }
      }
    }
  ]
}
```

**关键约束**:
- 6 task kind:`behavioral` / `structural` / `visual-ui` / `docs` / `spike` / `chore`
- bug-fix 不再是独立 kind,用 `behavioral + labels: ["bug"]`;含 `bug` label 时必须 `red_test_registered=true`
- 每个 kind 有**自己的 execution 形状**(只包含本 kind 合法的 step)
- spike task **永远不允许 `loaf deliver`**——只能 archive / convert / abandon
- `tasks.execution.<step>.status` 是 **cache**,不是真理源;真理源是 `evidence.jsonl`。`loaf tasks check` 跑一致性校验

**ID 分配**(rev 4.3,ADR-0004 A5):`loaf tasks add --input` input JSON **不**携 `id` / `id_namespace` 字段 — task id(`^T-\d{3,}$`)由 CLI 在 per-session lock 内自动单调分配,batch 输入 N 条原子分配 N 个连续 id(`spec_version` 不变;`tasks.version += 1` per invocation)。`execution` 块也由 CLI 初始化:每 step 按 `STEP_TO_KIND` 表落 `applicability` + `status="pending"`。input 只携 `kind` / `drives` / `depends_on` / `labels` / kind-specific 字段(`tests` / `no_test_rationale` / `visual_contract_refs` 等),见 `schemas.ts` §40 `TaskInput`。

### 4.4 evidence.jsonl(稳定 EV-id + waiver kind + hashed attachments)

> **Authority**: 派生投影(reducer 从 `evidence:added` entries 重建,落 `snapshots/evidence.json`);attachments 内容是 sidecar canonical (`.loaf/<feature>/attachments/<entry_id>/`,**rev 5.0:目录按 journal `entry_id`(JE-NNNNNN)分桶,非 evidence_id**;sha256 在 journal entry payload 内的 `AttachmentRef` anchor;orphan GC 也按 entry_id 比对)。Legacy `gate-decision` evidence(v0.0.x)迁移后仅以 `migration:snapshot_imported` payload 形态存在,reducer 派生到 evidence + derived gate view,但**不**伪造新 `gate:decided` entry(ADR-0005 §5.2)。

```jsonl
{"schema_version":2,"evidence_id":"EV-000123","at":"2026-05-12T09:00Z","kind":"task-summary","iteration":1,"actor":"skill:loaf-cli/sdd-execute","result":"passed","summary":"4 unit tests passed","task_id":"T-001","covers":["REQ-AUTH-002","T-001"],"cmd":"bun test auth","exit":0}
{"schema_version":2,"evidence_id":"EV-000124","at":"2026-05-12T09:15Z","kind":"local-check","iteration":1,"actor":"cli:loaf","result":"passed","summary":"lint + typecheck clean","task_id":"T-001","covers":["T-001"]}
{"schema_version":2,"evidence_id":"EV-000125","at":"2026-05-12T09:30Z","kind":"verify-review","iteration":1,"actor":"skill:loaf-cli/sdd-verify","result":"approved","summary":"spec_fit passes; no anti-pattern","check":"review","covers":["REQ-AUTH-001","REQ-AUTH-002"]}
{"schema_version":2,"evidence_id":"EV-000126","at":"2026-05-12T09:50Z","kind":"visual-review","iteration":1,"actor":"human:est9","result":"approved","summary":"button shows spinner; disabled state correct","check":"visual","covers":["VIS-AUTH-001"],"attachments":[{"path":".loaf/auth-refresh/attachments/JE-000456/login-primary-button.png","sha256":"a1b2c3d4e5f6...64hex","mime":"image/png","bytes":48213}]}
{"schema_version":2,"evidence_id":"EV-000127","at":"2026-05-12T09:55Z","kind":"waiver","iteration":1,"actor":"human:est9","result":"waived","reason":"REQ-AUTH-005 acceptance_na=true; intuitive feel validated via separate user-testing protocol","covers":["REQ-AUTH-005"],"waiver_obligation_id":"REQ-AUTH-005"}
{"schema_version":2,"evidence_id":"EV-000128","at":"2026-05-12T10:00Z","kind":"gate-decision","iteration":1,"actor":"human:est9","decided_by":"human:est9","result":"approved","gate":"verify-accept","reason":"all checks passed; waivers documented","covers":[],"based_on":{"spec":2,"tasks":4}}
```

**核心约束**:
- 每条 entry 必带 `evidence_id`(单调 `EV-` + ≥6 位数字)、`iteration`、`actor`、`result`、`summary`
- `actor` 自由字符串,**推荐前缀**:`human:<id>` / `skill:<plugin>/<skill>` / `cli:loaf` / `ci:<job>`
- `covers[]` 是 **AC 覆盖的真理源**(替代 task.drives → evidence.task_id 间接链)
- `manual` 和 `waiver` 是**两个独立 kind**:
  - `manual`:人工验证(`result` 通常是 `passed/failed`)
  - `waiver`:人工豁免(`result=waived`,`actor` 必须 `human:*`,`reason` 必填 ≥10 字符)
- `*-review` kind 的 `actor` 必须 ≠ implementer(`ceremony.strict_spec_review=true` 时 gate-time enforce;rev 4.2)
- visual evidence 的 `attachments[]` 是对象数组,**强制 sha256 + mime**;rev 5.0 路径规范化到 `.loaf/<feature>/attachments/<entry_id>/<file>`(按发出该 evidence 的 journal entry_id JE-NNNNNN 分桶,**非** EV-id);`evidence_id` 仍保留在 payload 中作为 evidence projection 的稳定 ID
- gate-decision 通过 `loaf gate decide` 写入,不直接编辑

#### Attachment 自动处理(rev 4.3,ADR-0004 A6)

`loaf evidence add --input` 时,`attachments[]` 是**简化输入形态** `[{ path }]`,**不**携 sha256 / mime / bytes。CLI 在 lock 内 transactionally 完成 shape transformation:

```
1. 验证 path 存在(否则 ATTACHMENT_NOT_FOUND exit 2)
2. 验证 path 是 regular file(目录 / socket / FIFO / 符号链接到非文件 → ATTACHMENT_NOT_FILE exit 2)
3. 拷贝到 `.loaf/<feature>/attachments/<entry_id>/<basename>`(**rev 5.0**:目录按发出该 evidence 的 journal entry_id (JE-NNNNNN) 分桶,非 EV-id;basename 冲突时 suffix `-2` / `-3` ...)
4. 计算 sha256(hex,64 字符)
5. 从扩展名 + magic bytes 推断 mime
6. stat() bytes
7. 写完整 Attachment 对象(`{ path, sha256, mime, bytes }`)到 evidence.jsonl;落盘后 attachments[].path 是规范化后的相对路径(repo-relative)
```

理由:LLM 在 shell 调 `sha256sum` 或推断 mime 几乎必错,这是经典 **shape transformation**(path → canonical entry with hash/mime/bytes),归 CLI 完美。机器表达见 `schemas.ts` §15 `EvidenceAddInput.attachments`(`Array<{ path }>`)vs 落盘的 `EvidenceEntry.attachments`(完整 `Attachment` 对象)。

**ID 分配**(rev 4.3,ADR-0004 A5):`evidence add --input` input JSON **不**携 `evidence_id` / `at` 字段 — `EV-id`(`^EV-\d{6,}$`)与 timestamp 由 CLI 单调分配并 stdout 回打;batch 输入 N 条原子分配 N 个连续 id(append-only / spec_version 不变)。

### 4.5 findings.jsonl(6 category × 6 action + EV-id refs)

> **Authority**: 派生投影(reducer 从 `finding:raised` / `finding:closed` entries 重建,落 `snapshots/findings.json`)。

**只能在 VERIFY.\*** sub-state raise(标准情况),**或** spec_locked=true 的 EXECUTE.* sub-state raise(post-lock 漂移)。Quick profile 完全不允许。

```jsonl
{"schema_version":2,"id":"FND-001","event":"opened","at":"2026-05-12T09:32Z","raised_in":"VERIFY.visual","raised_by":"skill:loaf-cli/sdd-verify","iteration":1,"category":"spec-gap","action":"amend-spec","summary":"按钮 hover 状态 spec 沉默","refs":["REQ-AUTH-007"],"evidence_refs":["EV-000125"]}
{"schema_version":2,"id":"FND-001","event":"closed","at":"2026-05-12T09:55Z","iteration":2,"resolution":"REQ-AUTH-008 added in spec v3 + AuthButton hover state implemented","evidence_refs":["EV-000132"]}
{"schema_version":2,"id":"FND-002","event":"opened","at":"2026-05-12T10:01Z","raised_in":"VERIFY.review","raised_by":"skill:loaf-cli/sdd-verify","iteration":2,"category":"risk-escalation","action":"amend-tasks","summary":"实现中发现需要改 PublicAuthAPI;触发 standard→deep 升级","refs":["T-005"],"evidence_refs":["EV-000130"]}
```

#### 3-tier ActionRisk + `FINDING_ACTION_GRID`(rev 4.3,ADR-0004 A7)

`loaf finding raise --category X --action Y` 的 6×6 组合不再「全 legal」,按 `FINDING_ACTION_GRID`(`schemas.ts` §37)分三档行为:

| Risk | 行为 |
|---|---|
| `typical` | 正常 raise;`--reason` 可选 |
| `unusual` | require `--reason` 长度 ≥ 20 字符;否则 `FINDING_ACTION_UNUSUAL_REASON_REQUIRED` exit 2 |
| `incoherent` | 直接 block;`FINDING_ACTION_INCOHERENT` exit 2,stderr 解释「无 task 可 apply transition」并引导先 `amend-spec` |

6×6 矩阵(横:action,纵:category):

| category \ action | amend-spec | amend-tasks | fix-impl | fix-test | defer | backlog |
|---|---|---|---|---|---|---|
| `spec-gap` | typical | unusual | **incoherent** | **incoherent** | typical | typical |
| `spec-defect` | typical | unusual | unusual | unusual | typical | typical |
| `impl-defect` | unusual | typical | typical | unusual | typical | typical |
| `test-defect` | unusual | typical | unusual | typical | typical | typical |
| `new-scope` | typical | typical | **incoherent** | **incoherent** | typical | typical |
| `risk-escalation` | unusual | typical | unusual | unusual | typical | typical |

**Incoherent 4 格**全部满足「结构性无 target 可 apply transition」判据:`spec-gap × {fix-impl, fix-test}` 和 `new-scope × {fix-impl, fix-test}` — spec 在某方面缺乏内容时,**没有 task 可被 `fix-impl` / `fix-test` 选中**(`fix-impl` 的 transition `task.execution.implement.status=running` 需要具体 task);先 `amend-spec` 补齐缺口,后续才能精确定位 fix target。早 block 早 LLM feedback,胜过让 transition 阶段 fail 一次再回头改 finding。

每格判定的完整理由见 `references/finding-matrix-rationale.md`(workflow skill 调 `finding raise` 前可加载该 reference 做 cell pre-check)。

reconcile.json 配套字段 `unusual_findings_count`(§4.6)聚合本轮 unusual 数量,reviewer 一眼看出 finding ontology 是否漂移。

详见 §6。

### 4.6 reconcile.json(snapshot,不是 gate 源)

> **Authority**: 派生投影(SETTLE.reconcile 阶段从 journal + projection 重新计算,落 `snapshots/reconcile.json`)。永远不是 gate 源(§13.1)。
>
> **rev 5.x scope 收窄**:**只在 deep profile 产**(`ceremony.settle_phase=true`)。quick / light / standard 不产 reconcile.json。需要 audit 时走 `loaf doctor --rebuild` on-demand 触发 reducer 从 journal full-replay 重算(数据无丢失,只是不落显式 snapshot 文件)。

```jsonc
{
  "schema_version": 2,
  "based_on": { "spec": 3, "tasks": 5 },
  "planned_scope": ["src/auth/**", "tests/auth/**"],
  "actual_scope":  ["src/auth/**", "tests/auth/**", "src/network/retry.ts"],
  "drift": [
    {
      "path": "src/network/retry.ts",
      "category": "out_of_planned",
      "reason": "FND-002: 并发协调依赖 retry,本轮决定 carry forward 到下个 feature",
      "resolution": "carried_forward",
      "finding_id": "FND-002"
    }
  ],
  "ac_coverage": [
    { "ac_id": "REQ-AUTH-001", "evidence_refs": ["EV-000123","EV-000125"], "status": "passed" },
    { "ac_id": "REQ-AUTH-005", "evidence_refs": ["EV-000127"], "status": "waived" },
    { "ac_id": "SCEN-AUTH-E2E-001", "evidence_refs": ["EV-000131"], "status": "passed" },
    { "ac_id": "VIS-AUTH-001", "evidence_refs": ["EV-000126"], "status": "passed" }
  ],
  "verify_checks_status": {
    "run":        { "applicability": "must", "status": "passed", "evidence_refs": ["EV-000124"] },
    "review":     { "applicability": "must", "status": "passed", "evidence_refs": ["EV-000125"] },
    "acceptance": { "applicability": "must", "status": "passed", "evidence_refs": ["EV-000131"] },
    "visual":     { "applicability": "must", "status": "passed", "evidence_refs": ["EV-000126"] }
  },
  "iteration_stats": {
    "total": 2,
    "findings_total": 2,
    "findings_by_action":   { "amend-spec": 1, "amend-tasks": 1, "fix-impl": 0, "fix-test": 0, "defer": 0, "backlog": 0 },
    "findings_by_category": { "spec-gap": 1, "risk-escalation": 1, "spec-defect": 0, "impl-defect": 0, "test-defect": 0, "new-scope": 0 }
  },
  "unusual_findings_count": 1
}
```

**重要**:`verify_checks_status` 在这里是 SETTLE 时间的 snapshot;**verify-accept gate 不读这个,而是用 spec/tasks/evidence 实时计算**。

**`unusual_findings_count`**(rev 4.3,ADR-0004 A7):本轮 raise 时 cell 落 `unusual`(`FINDING_ACTION_GRID`,§4.5)的 finding 个数。`incoherent` 是 block 路径(raise 失败,不落 findings.jsonl,故**不**计入)。`unusual` finding 的 `--reason` 已强制 ≥ 20 字符,可在 reviewer 抽查时用作焦点定位(`findings.jsonl` grep `category × action` cell 是 unusual 的条目)。本字段不影响 verify-accept gate 决策,仅作 SETTLE 时 reconcile 审计信号。

### 4.7 lessons.md(free-form)

> **Authority**: Advisory(自由 markdown,不强校验;`loaf lessons add` 走 journal entry 走 reducer 拼接落 `lessons.md`,但内容形态不在 schema 闭环内)。

```markdown
## F-001 OAuth refresh · 2026-05-12 (iterations=2)

- single-flight refresh 协调器需要全局锁,否则并发请求触发重复 refresh
- 按钮 hover 状态第一轮 spec 漏写——**spec.spec 阶段 UI 元素必须问 hover/disabled/loading 三态**
- TDD 红测试 `TokenCoord.concurrent401OnlyRefreshesOnce` 进 regression
```

按 `feature.id + 日期(+ iterations 数)` 分段。格式不强校验。详见 §12。

### 4.8 gate-diagnostic.json(rev 3.1 新)

> **Authority**: 派生投影(诊断快照,允许 stale;gate 失败时 reducer 重新计算落 `snapshots/gate-diagnostic.json`)。

gate / submit / transition / diff-guard 失败时**覆写**到 `.loaf/<feature>/snapshots/gate-diagnostic.json`(rev 5.0:路径迁移到 `snapshots/`;读者必须先过 §10.15 Gate #5 fast check)。loaf-skill 读它喂 LLM 做下一轮 fix。

```jsonc
{
  "schema_version": 2,
  "at": "2026-05-12T08:32Z",
  "gate": "spec-lock",
  "failures": [
    {
      "code": "MISSING_VERIFIABILITY",
      "severity": "block",
      "ref": "REQ-AUTH-006",
      "vars": { "req_id": "REQ-AUTH-006" },
      "suggestion": "REQ-AUTH-006 needs measurable, verified_by_scenarios[], or acceptance_na+reason"
    },
    {
      "code": "DRIVES_NOT_BOUND",
      "severity": "block",
      "ref": "REQ-AUTH-007",
      "vars": { "req_id": "REQ-AUTH-007" }
    }
  ]
}
```

诊断模板在 `i18n/<lang>.json` 的 `diagnostic.<code>`,根据 `LOAF_LANG` 渲染人类可读消息。

### 4.9 resume-pack.json(rev 3.1 新)

> **Authority**: 派生投影(handoff 快照,允许 stale;`loaf handoff` / `loaf context pack` 触发 reducer 重计算)。

**仅** `loaf handoff` 显式触发(context overflow 检测是 loaf-skill 的事,loaf-cli 只持久化):

```jsonc
{
  "schema_version": 2,
  "at": "2026-05-12T11:00Z",
  "session_id": "550e8400-...",
  "reason": "main context approaching token limit; handoff to fresh session",
  "state_snapshot": { /* StateJson 当前完整 */ },
  "recent_evidence": ["EV-000125","EV-000126","EV-000127","EV-000128"],
  "recent_findings": ["FND-001","FND-002"],
  "open_pending": null,
  "notes": "FND-002 已 amend-tasks,等 T-005 重新进入 implement"
}
```

### 4.10 trace.jsonl(`--debug` only)

> **Authority**: Debug-trace(仅 `--debug` 写;git 永不污染;crash log 永不自动 upload,§10.11)。不是 journal entry,不进 reducer。

```jsonl
{"schema_version":2,"at":"...","session_id":"...","iteration":1,"sub_state":"EXECUTE.work","cmd":"bun test","argv":["auth.test.ts"],"exit":0,"wall_ms":3450,"stdout_summary":"4 passed"}
```

git 默认 `.gitignore` 排除。

### 4.11 loaf.config.json(rev 3.1 合并配置,project-level)

> **Authority**: Config(project-level,非 per-feature journal 一部分;mutation 经手动编辑或 `loaf config set` ——后者亦走 §11.2 transaction,但不在 `.loaf/<feature>/journal.jsonl` 体系内)。

```jsonc
{
  "schema_version": 2,
  "protected_files": [
    "**/credentials/**",
    ".env*",
    "**/secrets/**"
  ],
  "stable_core": [
    "src/api/**",
    "src/protocol/**"
  ],
  "paths": {
    "source": ["app/src/main/**", "*/src/main/**"],
    "tests":  ["**/src/test/**", "**/src/androidTest/**"],
    "docs":   ["docs/**", "*.md"],
    "ui":     ["**/res/layout/**", "**/ui/**", "**/*Screen.kt"],
    "public_api": ["core-api/**", "**/api/**"],
    "schema": ["**/*.graphql", "**/*.proto", "**/schemas/**"],
    "security": ["**/auth/**", "**/crypto/**", "**/token/**"]
  },
  "commands": {
    "run":        ["./gradlew testDebugUnitTest"],
    "lint":       ["./gradlew lintDebug"],
    "typecheck":  ["./gradlew compileDebugKotlin"],
    "visual":     ["./gradlew verifyPaparazziDebug"],
    "acceptance": ["./gradlew connectedDebugAndroidTest"],
    "build":      ["./gradlew assembleDebug"]
  },
  "constitution": {
    "tdd_strictness": "preferred",
    "default_ceremony_label": "standard",
    "require_red_for_behavioral": true,
    "allow_manual_for_requirement": true,
    "require_attachment_for_visual": true
  },
  "locale": {
    "default_lang": "zh"
  }
}
```

**所有字段都 optional**;loaf-cli ships 默认值。该文件解决两个 v1 痛点:
1. 把 legacy Python 原型的 `protected-files.json` + `stable-core-manifest.json` + mother 的 `constitution.json` 合并成一份
2. 给 diff-guard / verify-applicability / auto-escalation 提供项目级 paths 知识,避免硬编码 glob

### 4.12 registry per-session file(rev 3.1 Q15 翻牌)

> **Authority**: 派生投影(per-session,允许 stale,GC by `loaf doctor --rebuild-registry`;TUI 消费)。位于 `~/.loaf/registry/<id>.json`,**不**进 `.loaf/<feature>/journal.jsonl` 体系。

```
~/.loaf/registry/
  ├─ 7f3a8b2c-e29b-4afe-9a44-446655440000.json     # 一 session 一文件
  ├─ 9b2c1d3e-a7f8-4cde-8b55-557766551111.json
  └─ ...
```

**写法:atomic temp + rename**

```ts
async function updateRegistry(sessionId: string, snapshot: RegistryFile) {
  const target = `~/.loaf/registry/${sessionId}.json`;
  const tmp    = `${target}.tmp-${randomId()}`;
  await fs.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  await fs.rename(tmp, target);  // POSIX 原子保证
}
```

**为什么不用单 jsonl + flock**:不同 feature/session 并发写同一文件 = race。改成"一 session 一文件"让 filesystem 体现 session 独立性,POSIX `rename(2)` 原子,**零并发**。

**TUI 启动**:`readdir(~/.loaf/registry/)` + parallel reads。session 数百量级 = 微秒级。

**GC**:`mtime > 30d` → `unlink`(POSIX 原子)。文件权限默认 `0600`,他用户读不到 cwd / session_label。

**Best-effort projection 语义**(rev 4.1):RegistryFile **不是 canonical truth**,只是 TUI 投影。
- atomic rewrite 只保证单文件不撕,**不保证**跨文件 transaction:存在 crash window(`tasks.json` 写完 → `state.json` 写完 → crash 在 registry rewrite 之前 → registry 落后)
- TUI 必须容忍 stale:当 registry `at` 早于对应 `state.json.heartbeat_at` 超过 threshold 时,显示 `⚠ stale` 标记
- `loaf doctor --rebuild-registry` 从 canonical artifact 重建全部 session 投影
- **gate / 任何 blocking decision 永远不读 registry**;registry 仅供 TUI 列表展示

详见 §14。

---

## 5. Gate(2 个 human gate)

> **Gate 的 truth source 纪律**(rev 4.1 + rev 5.0 重锚,Principle #15 / 15a 落地):任何 gate 都从 **canonical truth**(`journal.jsonl` + `attachments/<entry_id>/` + `loaf.config.json`,详 §13.1 + ADR-0005 §3.1)**实时计算** — gate evaluator 直接 fold journal entries 走 reducer,或从 `snapshots/*.json` 读派生投影但必须先过 §10.15 fast check(Gate #5,mismatch → exit 2 `SNAPSHOT_STALE_REBUILD_REQUIRED`,**绝不静默 fallback**;ADR-0005 §3.6 reader contract)。Derived 文件(`snapshots/state.json` / `snapshots/tasks.json` / `snapshots/evidence.json` / `snapshots/findings.json` / `snapshots/reconcile.json` / `snapshots/gate-diagnostic.json` / `snapshots/resume-pack.json` / `spec.md` post-submit projection / `lessons.md` / `~/.loaf/registry/<id>.json`)**永远不是 blocking decision 的真理源** — 它们是诊断 / 投影 / handoff 产物,允许 stale;读时必须走 fast check 或退化到从 journal full-replay 重建(`loaf doctor --rebuild`)。详见 §13.1 四层 artifact authority。

### 5.1 spec-lock(SPEC → EXECUTE)

**Machine 校验**(rev 3.1 更新 8 条):
1. spec.md frontmatter 通过 `SpecFrontmatter` schema
2. `needs_clarification === []`
3. `tasks.based_on.spec === spec.spec_version`
4. 每个 REQ-* 被 ≥1 task 的 `drives[]` 引用
5. **每个 REQ 满足三选一可验证**(rev 3.1 替代原 vague-word check):
   - `measurable: { metric, threshold, unit }`,或
   - `verified_by_scenarios[]` 非空(指向 SCEN-*),或
   - `acceptance_na: true` + `acceptance_na_reason ≥ 10 chars`
6. 每个 `scenario.tag === "e2e"` 满足之一:
   - 有 task `requires_acceptance: true` 绑定它
   - scenario 自带 `acceptance_na` + reason
7. 每个 visual_contract 满足之一:
   - 有 visual-ui task `visual_contract_refs[]` 引用它
   - visual_contract 自带 `visual_na` + reason
8. 每个 task 通过 kind-specific schema(`behavioral+labels=["bug"]` 必须 `red_test_registered=true`,`structural/docs/spike/chore` 必须 `no_test_rationale`,`visual-ui` 必须 `visual_contract_refs[]`)

**Human**:`loaf gate decide spec-lock --approve --reason "..."` → evidence.jsonl `kind=gate-decision`。

**通过后**:`state.spec_locked = true`。后续任何 spec/tasks 变化必须经 finding 机制(详见 §6)。

### 5.2 verify-accept(VERIFY → SETTLE / DONE)

**Machine 校验**(5 条,**实时计算,不读 reconcile.json**):

1. 所有 applicable VerifyCheck(`applicability === "must"`)status === `passed` 或 `waived`
   - **rev 3.1**:`skipped` 已 deprecated;只能是 `passed` 或 `waived(actor=human:* + reason)`
2. `findings.jsonl` 无 status === open
3. **每个 REQ/SCEN/VIS(非 `*_na`)有 ≥1 evidence 通过 `canSatisfy()` 检查**(详见 §5.4),且 result ∈ {passed, approved, waived}
4. 每个 status=done 的 task 有 ≥1 evidence(kind ∈ {task-summary, local-check, manual, waiver})
5. deep profile:存在 `kind=spec-review` 且 `actor ≠ implementer` 的 evidence(`ceremony.strict_spec_review=true`)

**Human**:`loaf gate decide verify-accept --approve --reason "..."`。

**Transition target**(rev 5.x,跟 ceremony.settle_phase 分支):
- `settle_phase=true`(deep)→ `SETTLE.reconcile`(走 reconcile + lessons MUST)
- `settle_phase=false`(standard)→ `DONE.delivered` 经 `loaf deliver`(无 verify-min 二次跑,VERIFY 已覆盖)

详 `schemas.ts` `SUB_STATE_CONTRACTS.VERIFY.accept.next = ["SETTLE.reconcile", "DONE.delivered"]`,validateTransition 按 ceremony.settle_phase 选边。

### 5.3 反向 transition

- **spec-lock 前**:`loaf amend --target spec|tasks` 直接编辑,无需 finding
- **spec-lock 后**(`spec_locked === true`):**任何 spec/tasks/scope 变化必须经 finding 机制**——`loaf finding raise` 后由 action 触发回退
- **`amend-spec` action 触发时**:state machine 自动 `spec_locked = false`,must 重过 spec-lock 才能再进 EXECUTE

`amend` 命令在 `spec_locked=true` 时拒绝执行,提示用 finding。

**rev 4.3**(ADR-0004 A4):`spec add-req` / `add-scenario` / `add-visual` 与 `tasks add` 在 post-lock 阶段(EXECUTE/VERIFY/SETTLE/DONE)行为**镜像 `loaf amend`** — 拒绝执行,exit 2 `SPEC_LOCKED_NO_DIRECT_EDIT` / `tasks add` 对应 `amend-tasks` finding 路径(§4.2 / §4.3)。换言之:**任何**直接 mutation spec/tasks 的 surface(`amend` / `spec edit` / `spec add-*` / `tasks add`)post-lock 全部走同一条**唯一合法回退路径** = `loaf finding raise --action amend-spec/amend-tasks`。新 add-\* 命令没有引入新原则,只是把原 `loaf amend` 的回退闸门套用到增量入口。

### 5.4 Evidence 兼容性检查(Q8 — `canSatisfy()`)

每条 evidence 满足某个 covered ID 需要通过 `canSatisfy(evidence, coveredId)` 检查。逻辑分布在 `schemas.ts` 的 `EVIDENCE_COMPAT` 表:

```ts
function canSatisfy(evidence: EvidenceEntry, coveredId: string): boolean {
  const idKind = parseIdKind(coveredId);  // "REQ" | "SCEN" | "VIS" | "T" | "GATE"
  const rule = EVIDENCE_COMPAT[idKind];

  // 1. evidence.kind 必须在允许列表
  if (!rule.allowed.includes(evidence.kind)) return false;

  // 2. manual / waiver 需要 actor=human:* + reason
  if (evidence.kind === "manual" || evidence.kind === "waiver") {
    if (!evidence.actor.startsWith("human:")) return false;
    if (!evidence.reason || evidence.reason.length < 10) return false;
  }

  // 3. visual-review on VIS-* 必须带 attachment(rule.requires_attachment_for_visual_review)
  if (idKind === "VIS"
      && evidence.kind === "visual-review"
      && (!evidence.attachments || evidence.attachments.length === 0)) {
    return false;
  }

  return true;
}
```

兼容表(摘自 schemas.ts):

| coveredId 类型 | 合法 evidence kind |
|---|---|
| `REQ-*` | task-summary / verify-review / spec-review / manual(+reason) / waiver(+reason) |
| `SCEN-*`(tag=e2e) | acceptance / manual(+reason) / waiver(+reason) |
| `VIS-*` | visual-review(+attachment) / manual(+reason) / waiver(+reason) |
| `T-*` | task-summary / local-check / manual / waiver |
| `GATE` | gate-decision only |

---

## 6. Findings & Iteration

### 6.1 适用范围

- VERIFY.* sub-state:**任何时候可 raise**
- EXECUTE.* sub-state:**仅 spec_locked=true 时可 raise**(post-lock 漂移场景)
- 其他 sub-state:不允许 raise(直接 `loaf amend`)
- **`ceremony.spec_phase=false` 完全不允许 findings**(rev 4.2 — 原"quick profile 不允许 finding"的 ceremony 等价表达)

### 6.2 Category(6,rev 3.1)× Action(6)

**Category**(根因):

| category | 含义 |
|---|---|
| `spec-gap` | spec 沉默,需要补 |
| `spec-defect` | spec 写错(包括设计错误) |
| `impl-defect` | 实现没满足 spec(包括视觉不符) |
| `test-defect` | 测试本身错(env 细节进 `cause` 字段) |
| `new-scope` | 范围外新想法 |
| `risk-escalation` | task 复杂度超出当前 profile,触发 profile 升级(rev 3.1 新) |

**Action**:

| action | state 跳转 | target payload | iteration | spec.ver | tasks.ver | 重过 spec-lock |
|---|---|---|---|---|---|---|
| `amend-spec` | → SPEC.spec | — | +1 | +1 | +1 | **是(自动清 spec_locked)** |
| `amend-tasks` | → EXECUTE.work | `{ task_id?: T-N }` | +1 | 0 | +1 | 否(但自动 re-lock check)|
| `fix-impl` | → EXECUTE.work | `{ task_id: T-N, step: implement }` | +1 | 0 | 0 | 否 |
| `fix-test` | → EXECUTE.work | `{ task_id: T-N, step: red }` | +1 | 0 | 0 | 否 |
| `defer` | 留 VERIFY | — | 0 | 0 | 0 | 否 |
| `backlog` | 留 VERIFY | — | 0 | 0 | 0 | 否 |

> **rev 4.1 表头重画**:`target payload` 列把 `step` 从 sub_state 括号里抠出来。step 是 **finding resolution payload**,不是 session cursor —— 它写入 `tasks.<T-N>.execution.<step>.status="pending"` 让该 step 重跑;session state 只有 `phase=EXECUTE, sub_state=EXECUTE.work`,**不携带** step。rev 4 砍 `current_step` 后,旧表 `EXECUTE.work(step=X)` 写法把已砍字段视觉上塞回去,内部不一致,本轮修。`fix-impl` / `fix-test` action enum 保留(intent 不同 / 诊断模板不同 / 默认 prompt 不同,不合并成 redo-work,见 ADR-0003 Rejected #11)。机器表达见 schemas.ts `FindingActionEffect.requires_target_payload` + `FindingResolutionPayload`。

### 6.3 典型组合

| 场景 | category → action |
|---|---|
| 按钮颜色 spec 没说,要修 | spec-gap → amend-spec |
| 按钮颜色 spec 没说,本轮不修 | spec-gap → defer |
| spec 写蓝按钮应该绿 | spec-defect → amend-spec |
| spec 写蓝代码写绿(impl bug) | impl-defect → fix-impl |
| 测试用例错了 | test-defect → fix-test |
| 想加超时处理 | new-scope → backlog(下个 feature) |
| 想加超时处理,且决定本轮加 | new-scope → amend-spec + amend-tasks |
| EXECUTE 中发现要改 PublicAPI | **risk-escalation → amend-tasks**(触发 profile escalation prompt) |

### 6.4 amend-tasks 自动 re-lock check

`amend-tasks` 默认不重过 spec-lock。但 CLI 在 amend 时跑 machine check:
- 触及 public_api / schema / concurrency / security 路径 → 触发 escalation prompt
- planned_scope 扩张超出原 allowed glob → 触发 escalation prompt
- 跨 ceremony 阈值 → 触发 ceremony auto-escalation(详见 §3,rev 4.2)

任一触发 → `pending: profile_escalation`,等 user `loaf profile escalate --confirm`。

### 6.5 Fresh context per iteration

```bash
loaf resume --fresh
```

输出当前 iteration 的最小 context pack:当前 spec.md + 触发本轮的 finding + open findings + 当前 sub_state 期望产出。**工程建议,非 protocol 强制**。

---

## 7. VERIFY = Checklist 模型

**关键观念**:**`VerifyCheckKind` 与 `VERIFY.<lane>` sub_state 字面**重名(都是 `run` / `review` / `acceptance` / `visual`),**轴向不同**:
- `VerifyCheckKind`(`schemas.ts` §4)= **check 分类数据**(`run` / `review` / `acceptance` / `visual`),用在 checklist / verify 状态投影里;扩展只是 enum 加项(未来 `security` / `performance` / `accessibility`),**不影响 protocol surface**——新增 kind 走既有 lane,evidence 走对应的 `EvidenceKind`(例如 security check 沿 `VERIFY.review` lane 走 + `EvidenceKind="verify-review"`)。
- `VERIFY.<lane>` sub_state(目前 `VERIFY.run` / `.review` / `.acceptance` / `.visual`)= **串行控制游标**,代表当前批 verification 在哪一档;新增 lane 必须满足 §7.0 promotion rule(改变 ≥2 项机器行为)。
- `EvidenceKind`(`schemas.ts` §6,例如 `local-check` / `verify-review` / `spec-review` / `acceptance` / `visual-review` / `manual` / `waiver` …)= **第三个轴**,独立于上两者,描述每条 evidence 的来源类别。

三者**正交**:`VerifyCheckKind` 是 check 分类,`VERIFY.<lane>` 是 state machine cursor,`EvidenceKind` 是 evidence 来源。`VerifyCheckKind` 可任意扩展,`VERIFY.<lane>` 只在通过 promotion rule 时扩展。

### 7.0 Sub-state promotion rule(rev 4.1)

**规则**:一个 verification concern(或任何工作流关注点)当且仅当它改变以下 **至少 2 项** 时,才能 promote 成 first-class sub_state:

1. 允许的 CLI mutation 集合(`loaf evidence add` 接受的 kind / `loaf finding raise` 是否允许等)
2. write_paths(diff-guard 允许写入的路径集合)
3. 必需 evidence shape(kind / actor 约束 / attachments 强制等)
4. human / agent interaction mode(human approval / reviewer ≠ implementer 等)
5. recovery / back-edge 语义(finding action 落点)
6. TUI status semantics(`⏸ ask` / `▶ run` / `⏸ gate` 等显示分支)
7. gate diagnostic class(`gate-diagnostic.json` 的 `code` 分类)

仅 **"prompt 文案更精确"** 不构成 promotion 依据(coupling smell:把 prompt UX 当协议骨架理由)。

**未来 verification concerns(security / perf / a11y)MUST 先 map 到既有 lane**(典型:security check → 加 `EvidenceKind="security-review"` + 在 `VERIFY.review` lane 跑);除非满足以上 rule,才能新加 sub_state。

### 7.0.1 当前 4 VERIFY lane 反向 audit

每个 lane 钩中 rule 哪 ≥2 项:

| Lane | 钩中项 |
|---|---|
| `VERIFY.run` | #1(只允许 `local-check` / `task-summary` evidence)+ #3(evidence kind 限定 test/lint/typecheck 类) |
| `VERIFY.review` | #1(finding raise 主路径)+ #3(`verify-review`,`ceremony.strict_spec_review=true` 时强制 `actor ≠ implementer`)+ #5(action back-edge 集中在此 lane) |
| `VERIFY.acceptance` | #3(`kind=acceptance`,覆盖 `SCEN-*` tag=e2e)+ #7(diagnostic class 与 `local-check` 不同) |
| `VERIFY.visual` | #3(`visual-review` 必带 attachment sha256/mime)+ #4(human approval 常见) |

4 lane 全部过 rule,合法。**未来 audit 入口**:任何想加 `VERIFY.security` / `VERIFY.perf` / `VERIFY.a11y` 的提议必须在此填一行,论证它钩中哪 ≥2 项,否则归 evidence kind 扩展不开 sub_state。

### 7.1 六 sub-state(rev 4.0:VERIFY.check 拆 4)

```
VERIFY.plan         compute applicable checks(派生 applicability)
VERIFY.run          test + lint + typecheck(intent 由 sub_state 表达)
VERIFY.review       quality reviewer
VERIFY.acceptance   Gherkin E2E
VERIFY.visual       visual contract
VERIFY.accept       machine + human gate
```

> rev 3.x 的 `VERIFY.check` 单一 sub_state + `state.current_check` 字段被 rev 4.0 砍掉 —— intent 现在由 sub_state 精确表达,sub_state 才是状态机骨架该承担的语义。VERIFY 是 **control phase**,4 个 check 主 skill serial 跑,顺序由 applicability 驱动。

### 7.2 Applicability 派生规则

| Check | 触发 must |
|---|---|
| `run` | 任何 task 触代码 / 测试 / build 配置 |
| `review` | `verify_phase=true` MUST(standard / deep);`verify_phase=false`(quick / light)= NA |
| `acceptance` | 任意 scenario `tag=e2e` 且未 `acceptance_na` |
| `visual` | 任意 task `requires_visual=true` 或 spec 有 `visual_contracts[]` 未 `visual_na` |

### 7.3 Applicability 三档(rev 3.1 砍掉 `should`)

```
must       适用且阻塞 gate(未 passed/waived 时 verify-accept 拒)
optional   适用但不阻塞(用户可选跑)
na         不适用(计算结果,不参与 gate)
```

**「应该跑但不强制」这类灰区不进协议**。loaf-skill 想表达"建议跑 review"可以在 prompt 里说,但 protocol 只看 `must`。

### 7.4 `loaf verify status` 输出示例

```json
{
  "phase": "VERIFY",
  "iteration": 2,
  "checks": {
    "run":        { "applicability": "must", "status": "passed",  "reason": "source code changed", "evidence_refs": ["EV-000124"] },
    "review":     { "applicability": "must", "status": "passed",  "reason": "standard profile",     "evidence_refs": ["EV-000125"] },
    "acceptance": { "applicability": "must", "status": "passed",  "reason": "SCEN tag=e2e",          "evidence_refs": ["EV-000131"] },
    "visual":     { "applicability": "na",   "status": "na",      "reason": "no visual contract" }
  },
  "blocking": [],
  "open_findings": []
}
```

---

## 8. EXECUTE = Task Graph 模型(per-kind step)

**关键观念**:EXECUTE 不是固定 test→impl→refactor 顺序。task 之间用 depends_on 排序;**task 内部 step 跟随 task kind**(rev 3.1 每个 kind 自己的小 enum)。

### 8.1 三 sub-state

```
EXECUTE.plan    derive 每个 task 的 execution policy(应用 kind × profile 矩阵)
EXECUTE.work    active execution(worker active set 由 tasks.json filter status=in_progress 表达;rev 4.0 支持 sub-agent fan-out 并发)
EXECUTE.done    all tasks reached final status
```

### 8.2 每个 task kind 自己的 step 枚举(rev 3.1 Q6)

| Task kind | step 序列 | 说明 |
|---|---|---|
| `behavioral` | `red` → `implement` → `refactor` | TDD 三段。labels=["bug"] 时 `red_test_registered=true` 必填 |
| `structural` | `implement` → `refactor` | 行为不变;无 red |
| `visual-ui` | `mockup` → `implement` → `screenshot-compare` | mockup 抽取视觉合约,compare 校验 |
| `docs` | `draft` → `review` | 写 + peer review |
| `spike` | `explore` → `prototype` → `record` | **forbidden to deliver** |
| `chore` | `execute` | 单步操作(版本号 bump / 配置 edit) |

**两个伪 step 从协议层移除(Q6)**:
- `local-check` → 变成 **evidence kind**(任何 step 中跑测试都产 `kind=local-check` 的 evidence)
- `record-findings` → 变成**正交动作**,通过 `loaf finding raise` 触发,**不进 step 状态机**

### 8.3 spike 出口

spike task 完工有 3 个合法出口,**永远不允许 deliver**:

```
1. archive:   loaf archive --reason "spike, kept worktree for reference"
              → state → DONE.archived

2. convert:   loaf spike convert --to-feature F-002
              → spike findings 写入 lessons.md
              → 当前 session → DONE.archived
              → 新 session 开 F-002 把学到的写进 spec

3. abandon:   loaf abandon --reason "no value"
              → state → DONE.abandoned
```

`loaf deliver` 检测到 tasks 含 kind=spike 直接 exit 2。

### 8.4 删除的旧规则

```
✗ tasks.type: TEST | IMPL              (字段删除,rev 3)
✗ 每个 IMPL depends_on 至少一个 TEST    (规则删除,rev 3)
✗ 默认所有 task 跑 test→impl→refactor   (改成 kind-driven,rev 3)
✗ bug-fix 作为独立 kind                 (folded into behavioral + labels[], rev 3.1)
✗ local-check / record-findings 是 step  (改 evidence kind / 正交动作, rev 3.1)
```

### 8.5 `loaf tasks list` 输出示例

```json
{
  "phase": "EXECUTE",
  "iteration": 1,
  "tasks": [
    {
      "id": "T-001",
      "kind": "behavioral",
      "labels": ["bug"],
      "status": "done",
      "steps": {
        "red":       { "applicability": "must", "status": "passed", "evidence_refs": ["EV-000123"] },
        "implement": { "applicability": "must", "status": "passed", "evidence_refs": ["EV-000124"] },
        "refactor":  { "applicability": "optional", "status": "passed" }
      }
    },
    {
      "id": "T-099",
      "kind": "structural",
      "status": "pending",
      "steps": {
        "implement": { "applicability": "must", "status": "pending" },
        "refactor":  { "applicability": "optional", "status": "pending" }
      }
    }
  ],
  "blocking": ["T-099.implement"]
}
```

### 8.6 Mutation rights matrix(rev 4.1 新)

光看 sub_state 名字无法区分 `SPEC.plan`(risks/milestones 阶段)与 `EXECUTE.plan`(per-task execution policy 阶段)两个"plan"的写权限差异。本表是协议层显式声明,机器表达见 schemas.ts `SubStateContract.mutation_rights`。

本表描述**逻辑 mutation rights**(可改哪些 spec / task / evidence / finding 字段),不是物理写权限。**rev 5.0**:所有改动都通过 `loaf <cmd>` emit journal entries,reducer 派生到 `snapshots/*.json`;skill / sub-agent / 外部脚本永远不直写任何 artifact(§11.2 + Principle 15a)。"可写字段"列出的是 reducer-visible state 中允许被本 sub_state 修改的逻辑字段;落地通过 §10.8 kind-emission table 中对应命令 emit 的 journal kind 实现。

| Sub-state | 可写字段(reducer-visible)| 不可写 | 典型命令 / emitted kind |
|---|---|---|---|
| `SPEC.plan` | spec body risks / dependencies / milestones 段 | tasks graph, source code, spec frontmatter REQ/SCEN/VIS | `loaf spec edit` → `event:spec_submitted`(reducer 派生 `spec.md` projection) |
| `SPEC.design` | spec body design 段 + 整体 task graph(初次创建)| source code | `loaf spec edit` → `event:spec_submitted`;`loaf tasks submit` → `event:tasks_planned` |
| `EXECUTE.plan` | per-task `execution[].applicability`(per-task policy derive)+ `task.status` 从 pending → ready | spec body, REQ/SCEN/VIS frontmatter, `task.drives`, `task.depends_on`, `task.kind`, source code | `loaf tasks amend --policy ...` → `event:tasks_amended` |
| `EXECUTE.work` | per-task `execution[].status`(任意 step 推进)+ evidence ledger(新增)+ finding ledger(post-lock 时新增 / 关闭)+ source code(diff-guard 内)| spec body, `task.drives`, `task.kind`, `task.depends_on` | `loaf tasks step start/done` → `event:task_step_*`;`loaf evidence add` → `evidence:added`;`loaf finding raise/close` → `finding:raised|closed`;Write/Edit 工具(source code) |

**强制方式**:
- 字段维度:`loaf <cmd>` 在 §11.2 step 3 preflight 内做 sub_state × kind × mutation_rights refine(对应 schemas.ts `SUB_STATE_CONTRACTS.mutation_rights` + ADR-0005 §3.6 per-kind invariants);违反在 preflight 抛错,不进 journal
- source code 维度:PreToolUse(Write,Edit) hook 用 `STEP_WRITE_PATHS_BY_KIND[kind][step]` glob 校验
- 违反 → exit 2 + `snapshots/gate-diagnostic.json` 写 code `MUTATION_OUT_OF_RIGHTS`(写入字段 / 路径 / 当前 sub_state)

task graph 契约改(加 task / 改 drives / 改 kind / 改 depends_on)只能在 SPEC.design(`event:tasks_planned` 初创)或经 finding action `amend-tasks` 回退路径(emit `event:tasks_amended`),**不能在 EXECUTE.work 直接改 task graph**。

---

## 9. BDD / TDD 纪律

### 9.1 EARS 结构化 + 三选一可验证性(Q12)

```typescript
type RequirementEars =
  ({ id, type: "ubiquitous",   response }
 | { id, type: "event-driven", trigger, response }
 | { id, type: "state-driven", while_, behavior }
 | { id, type: "optional",     feature, response }
 | { id, type: "unwanted",     condition, response })
  & VerifiabilityFields;

type VerifiabilityFields = {
  measurable?: { metric, threshold, unit?, direction },
  verified_by_scenarios?: ScenId[],
  acceptance_na?: true,
  acceptance_na_reason?: string  // ≥10 chars
} // refine: 至少一个非空
```

CLI auto-render 出展示文本:
```
WHEN <trigger>, the system shall <response>.
```

**rev 3.1 砍掉 vague-word blacklist**。"fast / smooth / quickly / 流畅 / 合理 / 完善" 这类语言风格判断**不进协议**(由 loaf-skill 的 prompt 责任承担)。协议只看结构:**每条 REQ 必须有三选一可验证路径**(`measurable` / `verified_by_scenarios[]` / `acceptance_na+reason`)。

```yaml
# 合法:有 measurable
- id: REQ-PERF-001
  response: "the dashboard shall feel fast"
  measurable: { metric: time_to_first_paint, threshold: 500, unit: ms }

# 合法:由 scenario 验证
- id: REQ-AUTH-002
  response: "user can log in with valid credentials"
  verified_by_scenarios: [SCEN-LOGIN-001]

# 合法:显式不可测
- id: REQ-UX-001
  response: "the experience shall feel intuitive"
  acceptance_na: true
  acceptance_na_reason: "subjective UX quality validated via user testing outside protocol scope"

# 非法(spec-lock 拒):无三者
- id: REQ-BAD-001
  response: "the login screen shall load quickly"
```

### 9.2 Gherkin 只做 LLM lint shape

只用 `Scenario / Given / When / Then`。**不用** Background / Examples / Scenario Outline。**不引入** Cucumber 或任何 runner。

```
EARS    drives TDD          (REQ-* → task.execution.red+implement → unit/integration)
Gherkin drives BDD E2E      (SCEN-*-E2E-* → task.requires_acceptance → acceptance check)
Visual  drives visual check (VIS-* → task.visual_contract_refs[] → visual check)
```

### 9.3 RED-first(behavioral+label=bug 唯一硬约束)

含 `labels: ["bug"]` 的 behavioral task 必须 `loaf tasks register-red --task-id T-XXX` 先 RED。CLI mutator 层 enforce:非 RED 已 register 的 bug task 试图把 `task.execution.implement.status` 改成 `running` 时阻断。

**CLI 强制边界声明(rev 5.x,显式)**:

| 触发条件 | 谁强制 | 失败 effect |
|---|---|---|
| `task.kind=behavioral + labels.includes("bug")` → 必须 `register-red` 才能 implement | **CLI mutator 层硬 enforce** | exit 2 `BUG_TASK_REQUIRES_RED` |
| 其他所有 behavioral task 的 RED-first | **skill policy / team review**,**不**在协议层 enforce | 无 — skill prompt 提示,review 自查 |
| `constitution.tdd_strictness` / `constitution.require_red_for_behavioral` | **skill 读**(决定 prompt 严苛度),**CLI 不 enforce** | 无 |

理由(rev 5.x 决策):TDD 严格度是工程方法偏好,不是协议完成态的必要不变量。把所有 behavioral task 的 RED-first 都升成 schema/ceremony 字段会把 policy choice 混进 protocol shape,增加长期 schema 成本。bug RED 是 bugfix 防回归的客观底线,值得 CLI 硬卡;non-bug behavioral 的 RED-first 由 skill prompt + team review checklist + `constitution.tdd_strictness=strict` 软配置三层协同,**不上协议 enforcement**。详见 ADR-0003 / ADR-0004(`require_red_for_behavioral` 软配置历史)。

未来若出现「跨 skill 必须机器可验证一致的 TDD enforce 需求」,走独立 command/check 路径(类似 `loaf tasks register-red`),不塞进 ceremony 字段——保护 Ceremony schema 的 6 flag 维持「phase 跑不跑」的语义内聚性。

---

## 10. CLI Surface

所有命令 `loaf <subcommand>`。**Skill / hook 永远只写 `loaf <args>`,不暴露装法**。

rev 4.0 把 CLI presentation contract 全部规约下来(原 rev 3.x 仅有命令表,本节按 [clig.dev](https://clig.dev) audit 补全)。

### 10.0 Output streams(stdout vs stderr 分工)

skill / hook 把 loaf 输出 pipe 时依赖这条约定:

| Stream | 内容 |
|---|---|
| **stdout** | 主输出:JSON / 结构化 text(`--format` 控制)/ artifact 内容 / state snapshot / schema dump |
| **stderr** | log / progress / human-readable error 摘要 / pending prompt 提示 / diagnostic 引用文件路径 |

**任何错误信息不进 stdout**(否则 `loaf x --format json | jq` 在错误时炸)。`gate-diagnostic.json` 是文件 artifact,stderr 只 carry 「写到 ...gate-diagnostic.json — see file for details」简短引用。

### 10.1 Help contract

- 全命令支持 **`-h` / `--help`**(top-level + 每个 subcommand)
- `loaf help <subcommand>` 等价 `loaf <subcommand> --help`(git-style)
- `-h` 不被 overload(不当 `--host` 用)
- Help 文案结构(每命令):**1-line 描述** → **1-2 example** → **flag table** → **footer:`docs: $LOAF_DOCS_URL` + `report bug: $LOAF_ISSUE_URL`**(两 URL build-time 注入,见 §10.11;clig.dev §2 support path)
- bare `loaf`(无子命令)→ print 短 help + 列出常用命令 + exit 2
- 子命令缺必要参数 → print 该子命令 help + exit 2
- unknown subcommand → 按 Levenshtein 距离 suggest "did you mean X?",**不自动执行**
- stdin 是 TTY 且命令期待 piped input(如 `loaf spec submit --json -`)→ print help + exit 2,**不 hang**
- **`-h` / `--help` 在任意位置工作**(clig.dev §2):`loaf tasks step --task T-001 -h` 等价 `loaf tasks step --help`,parser 必须 short-circuit `-h` 在 subcommand context resolved 之后,不被未识别 flag 干扰

### 10.2 TTY / Color / Pager

- **TTY detection** 决定默认 format(不靠 `--no-pretty` flag):stdout 是 TTY → human-friendly + color;stdout 是 pipe → `--format text` 默认 line-oriented + 无 color
- **Color disabled when** 任一成立:**目标 stream(stdout 或 stderr 各自独立 `isatty()` 判断)**不是 TTY / `NO_COLOR` env 非空 / `LOAF_NO_COLOR` 非空 / `TERM=dumb` / `--no-color` flag。clig.dev §4:写到哪个 stream 各自检查 — 例 `loaf x 2>err.log` 时 stdout 仍 TTY 有色,stderr 走文件无色;不能用 stdout 一处判断绑两个 stream
- **Color force-enabled when**(rev 4.1)`FORCE_COLOR` env 非空 — 覆盖 "stdout 非 TTY → no color" 规则(CI 系统 pipe 仍想要彩色 log);但 `--no-color` flag / `NO_COLOR` env 仍 win(disable wins over force,clig.dev §13 conv)
- **不在 stdout 非 TTY 时**显示 spinner / 进度条 / 动画(`FORCE_COLOR` **不** override 这条 — 动画在非 TTY 是 garbage)
- 颜色只用于 error(红)/ warning(黄)/ success(绿) — 不全文本染色
- 长输出(`loaf <artifact> schema --json` / `loaf sessions list` 在 100+ session 时)通过 `$PAGER`(默认 `less -FIRX`,仅 stdout 是 TTY)

### 10.3 Environment variables + Config precedence

**Precedence**(high → low,clig.dev §12 强 require):

```
1. CLI flag                         (highest, per-invocation)
2. shell env (LOAF_* + 通用 env)    (per-user / per-session)
3. project config (loaf.config.json — cwd 或 $LOAF_CONFIG override)
4. user config (~/.config/loaf/config.json,XDG_CONFIG_HOME fallback)
5. built-in defaults                (lowest)
```

例:`tdd_strictness` 的解析顺序 = `--tdd-strictness=strict` flag > `LOAF_TDD_STRICTNESS=strict` env > project `loaf.config.json.constitution.tdd_strictness` > user config 同字段 > built-in `"preferred"`。

**Env vars**:

| Env var | 用途 | 是否 loaf 专属 |
|---|---|---|
| `LOAF_LANG` | i18n 语言(`en` / `zh`,见 §18) | ✅ |
| `LOAF_NO_COLOR` | 禁用颜色(等价 `--no-color`) | ✅ |
| `LOAF_DEBUG` | 等价 `--debug`(写 trace.jsonl) | ✅ |
| `LOAF_CONFIG` | 覆盖 `loaf.config.json` path | ✅ |
| `LOAF_SESSION` | **rev 4.1**:per-shell-session sticky session_id(UUID);CLI 默认 dispatch key,被 `--session` 覆盖 | ✅ |
| `LOAF_FEATURE` | **rev 4.1**:per-shell-session sticky feature 名(`.loaf/<name>/` dir basename);`LOAF_SESSION` 缺失时 fallback,被 `--feature` 覆盖 | ✅ |
| `LOAF_FORMAT` | **rev 4.2**:`json` / `text` 二选一,等价 `--format=<v>` flag 默认;CI / 脚本环境一次 export 不用每命令带 flag。precedence:显式 `--json`/`--plain`/`--format` flag > `LOAF_FORMAT` > TTY-derived default。值不在 enum 内 → exit 2 `INVALID_ENV_VALUE` + 提示合法值 | ✅ |
| `NO_COLOR` | 通用,respect(非空即禁色)| 通用 |
| `FORCE_COLOR` | 通用,respect(非空即强制启色,**rev 4.1**)— 用于 CI pipe 仍要彩色 log;`--no-color` / `NO_COLOR` 仍 win | 通用 |
| `DEBUG` | 通用,respect(非空 = 等价 `LOAF_DEBUG=1`,**rev 4.1**)— 跨工具统一开 trace 时方便;`LOAF_DEBUG` 仍 win | 通用 |
| `EDITOR` | `loaf spec edit` / `loaf lessons add` 调用 | 通用 |
| `PAGER` | 长输出走 pager(默认 `less -FIRX`) | 通用 |
| `TERM` / `TERMINFO` | 颜色 / TTY capability | 通用 |
| `XDG_CONFIG_HOME` | 用户级配置 fallback(无 `LOAF_CONFIG` 时) | 通用 |

**`LOAF_*` 命名**:UPPER_SNAKE,单行。**Secrets 不走 env**(loaf 不处理 secret,future-proof)。

#### Session dispatch precedence(rev 4.1,multi-feature in cwd 支持)

CLI 每次调用解析「这条命令操作哪个 session」时按下表(high → low):

| # | source | 说明 |
|---|---|---|
| 1 | `--session <UUID>` flag | 单次最高优先级;校验该 UUID 在 `~/.loaf/registry/` 存在且 `cwd` 字段 = 当前 cwd,否则 `SESSION_CWD_MISMATCH` exit 2 |
| 2 | `--feature <name>` flag | 单次;查 `cwd/.loaf/<name>/state.json` 拿 UUID |
| 3 | `$LOAF_SESSION` env | per-shell-session(每个 terminal process 独立,**无 race**);校验同 #1 |
| 4 | `$LOAF_FEATURE` env | 同 #3,但用 feature 名查 |
| 5 | Auto-pick `cwd/.loaf/*/state.json` | 0 个 non-DONE feature → `FEATURE_NOT_FOUND` exit 2;1 个 → use it + stderr「auto-picked 'X'」;2+ 个 → `FEATURE_AMBIGUOUS` exit 2 + 候选 + did-you-mean |

**不写** `.loaf/.active` 文件 — per-process ENV 自然隔离,**避免文件 race**(同 cwd 多 terminal / 多 Claude Code 各自 ENV 互不影响)。

**短 UUID prefix**:`$LOAF_SESSION` 或 `--session` 接受 ≥8 字符 prefix(同 git short-hash 纪律);registry 内唯一即可,否则 `SESSION_SHORT_AMBIGUOUS` exit 2 要求完整 UUID。

**重启 terminal 后拾回 UUID**:`loaf sessions list --in-cwd`(rev 4.1 新 flag,过滤当前 cwd 内 session)→ 列出短 UUID + feature name + phase.sub_state + last_advance_at。user `export LOAF_SESSION=<prefix>` 重设。

#### AI assistant client 跨 conversation 桥接(rev 4.1,§19 client 层职责)

Claude Code / Cursor 等 AI assistant 的 Bash tool 是 **one-shot shell per call**(`export` 不跨调用持久),且 conversation 压缩可能让模型忘掉自己生成的 UUID。loaf-cli 协议层无能为力(它只承诺 `--session` / `$LOAF_SESSION` 接口稳定);**client 自己 bridge**:

```
~/.loaf/claude-bridge/<claude-conversation-id>.json   ← 每个 conversation 一文件
{
  "claude_session_id": "abc-123-...",
  "loaf_session_uuid": "550e8400-...",
  "loaf_feature": "auth-refresh",
  "cwd": "/Users/est9/popposhell",
  "started_at": "2026-05-12T10:00:00Z"
}
```

`<claude-conversation-id>` 由 AI 工具的 runtime 提供(Claude Code hook `SessionStart` context 里有 session_id 字段;Cursor / Windsurf 各有自己的 conversation id)。skill 每次调 `loaf <cmd>` 前先读 bridge file → 拿 UUID → 加 `--session <UUID>` flag。compaction 不影响 bridge file。多 Claude Code 同 cwd 各自有独立 conversation_id = 独立 bridge file = **天然隔离**。

bridge 路径 `~/.loaf/claude-bridge/` 是 **client 协议约定**,不是 loaf-cli artifact(loaf-cli 不读不写它);其它非 Claude Code client 可以用 `~/.loaf/cursor-bridge/` / `~/.loaf/windsurf-bridge/` 各自一套。详见 §19。

### 10.4 Signal handling

- **SIGINT (Ctrl-C)**:立即 print 「`^C interrupted, cleaning up...`」一行到 stderr → 跑 atomic-rename rollback + state heartbeat skip + temp file unlink → exit 130
- **Second SIGINT** in cleanup window:立即 exit 130 skip cleanup(可能留 `.tmp-*` temp file,`loaf doctor` 下次启动会清)
- **Cleanup 硬超时 3 秒**:超过强制 exit
- **Second Ctrl-C 不会破坏数据**(stale `.tmp-*` 是 atomic rename 半截产物,`loaf doctor` 启动时清;evidence.jsonl append-only 永不丢)— 第一次 prompt 不需要警告 "second Ctrl-C is destructive"(它不是)
- 启动期(`loaf <any>`)正常处理 stale temp 文件(crash-only invariant);不需要显式 cleanup 命令
- **Wrapping 命令**(`loaf spec edit` 起 `$EDITOR` / `loaf tui` 起 fullscreen TUI)期间 **Ctrl-C 由内层接管**:editor 的 `:q` / `Ctrl-X` / TUI 的 `q` 退出;loaf 本身不 trap signal 在 wrap 期。Editor / TUI 退出后控制权交回 loaf,后续 SIGINT 走 §10.4 规则

### 10.5 Error contract

| 错误类型 | 行为 |
|---|---|
| **Expected**(schema fail / illegal transition / 缺必要 flag) | stderr 一行 human readable + 指向 `.loaf/<feature>/snapshots/gate-diagnostic.json`(rev 5.0;若适用;读者先走 §10.15 Gate #5 fast check) / `loaf doctor` 给修复建议;exit 2 |
| **Unexpected**(panic / unknown 异常) | stderr 一行「unexpected error — debug log at `~/.loaf/crashes/<ts>.log`;report at `$LOAF_ISSUE_URL?<prefilled-context>`」+ 写完整 stack 到 crash log;exit 1。`$LOAF_ISSUE_URL` 由 build 时注入(见 §10.11),query string **预填**:`loaf_version` / `schema_version` / `phase` / `sub_state` / `last_command`(argv,sanitized — 不含文件内容)/ `crash_log_path`(本地路径,提示用户手动 review 后贴) |
| **Diff guard violation**(`loaf advance`) | exit 2 + stderr 列出违反 path + 引用 `STEP_WRITE_PATHS_BY_KIND` rule 来源 |
| **Session dispatch**(rev 4.1)| 4 个 diagnostic code:`FEATURE_NOT_FOUND`(cwd 0 个 feature)/ `FEATURE_AMBIGUOUS`(cwd 2+ feature 且无 dispatch 上下文)/ `SESSION_CWD_MISMATCH`(`--session <UUID>` 指定的 UUID 注册 cwd ≠ 当前 cwd)/ `SESSION_SHORT_AMBIGUOUS`(短 UUID prefix 在 registry 多匹配)。全部 exit 2,stderr 列候选 + did-you-mean。详见 §10.3 dispatch precedence 段 |
| **Pending head invariant**(rev 4.1 Q3 minimal)| 3 个 diagnostic code:`PENDING_BLOCKS_ADVANCE`(`loaf advance` 时 head ∈ {gate_decision, profile_escalation})/ `GATE_NOT_PENDING`(`loaf gate decide <G>` 但 head 不是 `gate_decision(<G>)`)/ `ESCALATION_NOT_PENDING`(`loaf profile escalate --confirm` 但 head 不是 `profile_escalation`)。全部 exit 2,stderr 列 head 的 `pending_id` + `question`,提示先 resolve 或换合适命令 |
| **Flag mutual exclusion**(rev 4.2,clig.dev §6)| `MUTUALLY_EXCLUSIVE_FLAGS`:format flag 冲突(`--json --plain` / `--json --format=text` / `--plain --format=json`)+ 未来其它互斥对。exit 2,stderr 列冲突 flag 对 + `--format` 归一化提示。详见 §10.7 「Format flag 归一化与互斥」段 |

**信号到噪音**:类似错误**合并展示**(N 个 REQ 缺 measurable → 一条总结 + 详情写文件,不是 N 行 stderr)。最重要的信息**放在 stderr 末尾**(用户视线落点)。

**四段输出规约**(rev 4.3,ADR-0004 A9):所有 exit 2 user-recoverable 错误统一四行格式,重要信息按 clig.dev §5 排在尾部:

```
error: <one-line human description>
       <optional context: state we're in / what we saw>
       fix: <concrete command(s) the user should run>
       see: <doc anchor or local file path>
```

`fix:` 行可缺(罕见;无可执行修复时省略);`see:` 行可缺(无对应 doc anchor 时省略)。exit 1(unexpected panic)**不**走这套格式,只给 crash log + report URL(见上表第 2 行)。

`ERROR_CATALOG`(`schemas.ts` §39)是单一真理源:每个 `DiagnosticCode` 对应一条 `ErrorEntry { exit_code, message_template, fix_template?, doc_anchor? }`,模板渲染时按 vars 填占位符。i18n 走 `LOAF_LANG` bundle 按 code 查表(§18),CATALOG 内是英文 canonical 源。

**rev 4.3 新增 9 个 codes**(ADR-0004 A3 / A4 / A6 / A7):

| Code | 触发 | source |
|---|---|---|
| `INPUT_FILE_NOT_FOUND` | `--input <path>` 给的路径不存在或不可读 | A3 / A11 |
| `MISSING_INPUT` | mutator 命令未传 `--input` | A3 |
| `SCHEMA_VALIDATION_FAILED` | `--input` JSON 不满足 `INPUT_SCHEMAS` 对应 schema(Zod 报错路径 + 期望随附)| A3 |
| `SPEC_LOCKED_NO_DIRECT_EDIT` | post-lock(EXECUTE/VERIFY/SETTLE/DONE)调 `spec add-*`;镜像 `loaf amend` 的 post-lock 拒规则 | A4 |
| `SPEC_NOT_INITIALIZED` | feature 尚未 `loaf spec init`,直接 `spec add-*` | A4 |
| `ATTACHMENT_NOT_FOUND` | `evidence add` 的 `attachments[].path` 不存在 | A6 |
| `ATTACHMENT_NOT_FILE` | `attachments[].path` 是目录 / socket / FIFO / 符号链接到非文件 | A6 |
| `FINDING_ACTION_UNUSUAL_REASON_REQUIRED` | `finding raise` cell 是 `unusual`(`FINDING_ACTION_GRID`)但 `--reason` 缺或 < 20 字符 | A7 |
| `FINDING_ACTION_INCOHERENT` | `finding raise` cell 是 `incoherent`(4 个结构性死格)| A7 |
| `SETTLE_PHASE_DISABLED` | `VERIFY.accept → SETTLE.reconcile` 但 `ceremony.settle_phase=false`(quick / light / standard);`loaf settle` 在非 deep profile 调用同理 exit 2 | rev 5.x |
| `SETTLE_PHASE_BYPASS` | `VERIFY.accept → DONE.delivered` 但 `ceremony.settle_phase=true`(deep);deep 必须经 SETTLE.reconcile + SETTLE.lessons | rev 5.x |

**rev 5.x r5 catch-up runtime codes**(all are exit 2 family; source of truth for templates is `schemas.ts` §39):

| Code | Severity | When emitted | Fix hint |
|---|---:|---|---|
| `ACTOR_AUTHORITY_VIOLATION` | exit 2 | Preflight sees a journal kind emitted by an actor prefix not allowed for that kind | Use the correct command path; human-only kinds require resolved `human:*` actor |
| `FROM_CURSOR_MISMATCH` | exit 2 | `event:phase_advanced.payload.from` does not match the current reducer cursor | Refresh state and emit from the actual current `sub_state` |
| `INVALID_ENVELOPE` | exit 2 | JournalEntry envelope fails Zod validation in preflight or final append validation | Rebuild the entry through the CLI mutator; do not hand-write journal lines |
| `INVALID_PAYLOAD` | exit 2 | Payload fails the runtime `PER_KIND_PAYLOAD[kind]` schema, or reducer catches missing required fields | Fix payload shape for the emitted kind |
| `SEQ_NOT_MONOTONIC` | exit 2 | Candidate entry does not extend journal tail by exactly +1 | Refresh tail under lock; if tail is corrupt run doctor tail check |
| `SPEC_PHASE_FORK_VIOLATION` | exit 2 | Ceremony `spec_phase` disagrees with the TRIAGE.confirm fork target | Follow the selected ceremony path: SPEC.* when enabled, EXECUTE.plan when disabled |
| `SUB_STATE_AUTHORITY_VIOLATION` | exit 2 | Journal kind is not legal in the current `sub_state` | Advance/back-edge to a state that permits this kind, or use a valid command |
| `TRANSITION_ILLEGAL` | exit 2 | Transition edge is not in `LEGAL_TRANSITIONS` and not an always-legal terminal target | Choose an allowed transition for the current cursor |
| `VERIFY_PHASE_FORK_VIOLATION` | exit 2 | Ceremony `verify_phase` disagrees with the EXECUTE.done fork target | Enter VERIFY when verify is enabled; deliver directly only when disabled |
| `ALREADY_STARTED` | exit 2 | `session:started` or `migration:snapshot_imported` is applied after state already exists | Resume existing session or migrate/start in a fresh feature dir |
| `FINDING_NOT_FOUND` | exit 2 | `finding:closed` references an unknown finding id | List findings and close an existing id |
| `NO_SESSION` | exit 2 | Non-bootstrap kind is applied before session state exists | Run `loaf start` or `loaf doctor --migrate-v2` first |
| `PENDING_NOT_FOUND` | exit 2 | `pending:resolved` has no unresolved head, or id does not match the FIFO head | Resolve the current pending head id only |
| `REDUCER_NOT_IMPLEMENTED` | exit 2 | A payload-valid kind has no reducer handler | Do not append until reducer support and `REDUCER_IMPLEMENTED_KINDS` include the kind |
| `ENTRY_OVERSIZE` | exit 2 | Serialized final entry exceeds `ENTRY_BYTE_LIMIT` | Promote long text to sidecar form instead of inline payload |
| `SHORT_WRITE` | exit 2 | Filesystem write wrote fewer bytes than requested | Stop appending and run doctor tail verification before retry |
| `TAIL_CORRUPTION` | exit 2 | Tail line cannot provide an integer `seq` | Run `loaf doctor --check-tail`; do not append over a corrupt tail |
| `MIGRATION_BACKUP_MISSING` | exit 2 | Migration backup target already exists / cannot be safely created | Move/remove backup target and rerun migration |
| `MIGRATION_INCOMPLETE` | exit 2 | Legacy artifact parse/schema/consistency/sidecar hash validation fails | Fix or restore legacy artifacts, then rerun migration |
| `MIGRATION_REPLAY_ATTEMPT` | exit 2 | `doctor --migrate-v2` runs against a journal that already has entries | Do not rerun migration over initialized journal; inspect current journal or restore backup |
| `MIGRATION_SIDECAR_MISSING` | exit 2 | Required migration source artifact or sidecar is missing | Restore missing artifact/sidecar and rerun migration or doctor verification |
| `INVALID_ACTOR_FORMAT` | exit 2 | Explicit `LOAF_USER` / git human identifier cannot form a valid `human:<id>` ActorString | Set raw identifier without namespace prefix; unset bad env to allow fallback |
| `NO_HUMAN_ACTOR` | exit 2 | Human-only command cannot resolve a human actor in the current context | Run interactively with git user.email or set `LOAF_USER` explicitly |

完整出错示例(`SCHEMA_VALIDATION_FAILED`):

```
error: input does not satisfy schema for spec:add-req: /measurable/threshold: expected number, got string
       fix: run `loaf spec add-req --schema --json` to dump the JSON Schema, fix the offending field, and retry
       see: protocol.md#§10.5
```

### 10.6 Subcommand naming convention

**默认 noun-verb**(`docker container create` 风格):
- `loaf spec submit/init/edit/add-req/add-scenario/add-visual` ✅(rev 4.3:增量 `add-*`,见 §10.8)
- `loaf tasks check/list/next/step/submit/add` ✅
- `loaf evidence add/schema` ✅
- `loaf finding raise/list/close` ✅
- `loaf gate decide` ✅
- `loaf sessions list` ✅
- `loaf context pack` ✅(rev 4.3,见 §10.8)

**Chaos deviation — session lifecycle 命令保留单 verb**(git-style muscle memory):
- `loaf start` / `loaf status` / `loaf advance` / `loaf resume` / `loaf handoff`
- `loaf settle` / `loaf deliver` / `loaf archive` / `loaf abandon`
- `loaf doctor` / `loaf tui`

理由:这组命令是「session 自身的生命周期动词」(像 `git commit` / `git push` / `git status`),用户 muscle memory 是单 verb;强行 noun-verb 化(`loaf session status` 之类)显得啰嗦无收益。

**No catch-all**:`loaf unknown-cmd` 永远 exit 2 + suggest,不 fallback。
**No prefix abbreviation**:`loaf st` 不是 `loaf status` 的 alias(但 explicit alias 是 OK 的,见 §10.7)。

### 10.7 Global flags

| Flag | Short | Type | Default | Notes |
|---|---|---|---|---|
| `--help` | `-h` | bool | — | 每命令都有,top-level + 每 subcommand |
| `--version` | — | bool | — | `loaf --version` 打印 semver + commit + schema_version |
| `--format <fmt>` | — | `json\|text` | TTY 时 `text`,pipe 时 `text`(line-oriented) | 见 §10.2 |
| `--json` | — | bool | false | 等价 `--format json`,clig.dev 习惯 alias |
| `--plain` | — | bool | false | 等价 `--format text`(明确 line-oriented),clig.dev 习惯 alias |
| `--no-color` | — | bool | TTY/env 派生 | 见 §10.2 |
| `--no-input` | — | bool | false | **关键**:skill / hook / CI 用,禁用所有 prompt,缺必要输入直接 exit 2 |
| `--quiet` | `-q` | bool | false | 抑制非错误输出(stderr 仍出错误) |
| `--verbose` | `-v` | counter | 0 | `-v` / `-vv` 递增 stderr 信息密度;独立于 `--debug` |
| `--debug` | — | bool | false | 写 `trace.jsonl`(`LOAF_DEBUG=1` / `DEBUG=1` 等价);**不**改变 stderr 密度(用 `-v`) |
| `--dry-run` | `-n` | bool | false | **rev 4.1**:mutating 命令只校验不落盘(见下方 dry-run 契约);read-only 命令 reject + exit 2 |
| `--session <UUID>` | — | string | `$LOAF_SESSION` env or auto-pick | **rev 4.1**:dispatch 单次覆盖,见 §10.3 precedence;接受 ≥8 字符 prefix |
| `--feature <name>` | — | string | `$LOAF_FEATURE` env or auto-pick | **rev 4.1**:dispatch via feature 名(cwd-local alias),见 §10.3 |
| `--lang <en\|zh>` | — | enum | `LOAF_LANG` env or `en` | i18n bundle 选择,见 §10.3 env 表 + §18 |
| `--input <src>` | — | `-\|<json>\|<path>` | — | **rev 4.3**(ADR-0004 A3/A11):Tier 1 mutator 命令的统一 JSON 输入。`-` ⇒ stdin;首字符 `{` 或 `[` ⇒ inline JSON;其余 ⇒ 文件路径(不存在 → exit 2 `INPUT_FILE_NOT_FOUND`)。接受单条对象或非空数组(batch,A10)。判别细节见下方「`--input` source 判别」 |
| `--schema` | — | bool | false | **rev 4.3** modifier:与 `--json` 联用(`loaf <cmd> --schema --json`)dump 该命令 input Zod schema 派生的 JSON Schema(查 `schemas.ts` §40 `INPUT_SCHEMAS`)。用于 LLM 自描述 / fixture 生成 / `SCHEMA_VALIDATION_FAILED` 修复提示 |

**Format flag 归一化与互斥**(rev 4.2,clig.dev §6):
- 内部归一到 single `format`:`--json` ⇒ `format=json`,`--plain` ⇒ `format=text`,`--format=<fmt>` 显式赋值
- precedence(high → low):显式 flag > `$LOAF_FORMAT` env(v1.0,见 §10.3)> TTY-derived default(stdout TTY → text;pipe → text line-oriented)
- **同值无冲突**:`--json --format=json`、`--plain --format=text` 都 OK
- **冲突值** → exit 2 `MUTUALLY_EXCLUSIVE_FLAGS`,stderr 列冲突 flag 对:`--json --plain`、`--json --format=text`、`--plain --format=json`
- 同一 conflict code 复用于未来其它 flag 互斥(如 `--quiet -v` 同 invocation),错误体载 `{conflicting: ["--json", "--plain"]}` 给 scripting

**Prompt 行为**(扩展 `--no-input` 那一行):
- `loaf pending resolve` 在 **stdin 非 TTY** 或 **`--no-input`** 时缺 `--answer` → exit 2「pass --answer via flag」
- TTY + 无 `--no-input` 时,`loaf pending resolve` 漏 `--answer` → prompt 用户(展示 head 的 `question` + `options`)
- `loaf abandon` 漏 `--reason` 等隐式 prompt 仍走原 §10.4 规则

#### Pending head 阻塞 — protocol-level invariant(rev 4.1 minimal,Q3 决策)

CLI **唯一** enforce 的 pending 阻塞规则(state-machine integrity):

> `state.pending[0].kind ∈ {gate_decision, profile_escalation}` 时,**`loaf advance` 必须 exit 2 `PENDING_BLOCKS_ADVANCE`**

衍生约束(同一 invariant 的 corollary,见 §10.5 + §10.8):
- `loaf gate decide <G>`:head 必须是 `gate_decision(<G>)`,否则 `GATE_NOT_PENDING` exit 2(它本身就是该 head 的合法 resolution)
- `loaf profile escalate --confirm`:head 必须是 `profile_escalation`,否则 `ESCALATION_NOT_PENDING` exit 2(同理)

**其它命令 protocol 层不做 pending 阻塞**。理由:
- read-only 命令(`status` / `tasks list` / `pending list` 等)不动 state,无 enforce 必要
- append-only mutator(`evidence add` / `tasks step done` / `tasks claim` / `lessons add` / `finding raise --action defer|backlog` 等)不写 `state.phase / sub_state`,**不影响 state machine integrity**;rev 4.0 fan-out 需要 worker 在其它 worker 撞 pending 时**继续干自己活**
- user-explicit terminal(`abandon` / `archive` / `deliver` / `spike convert`)是显式 panic-eject,不该被协议拦
- back-edge `finding raise --action amend-spec/amend-tasks/fix-impl/fix-test`:**skill 责任**判断"现有 pending 是不是该等再 back-edge"(走 `loaf pending list` 自己 query)

**Skill 责任**(workflow 编排,protocol 不管):
- 主 skill / sub-agent 调任何 mutator 前调 `loaf pending list --format json` 自己看
- fan-out 调度策略(哪个 worker 等 / 哪个继续)由 skill 决定
- Claude Code 等 client 可用 `PreToolUse` hook 拦 `Bash(loaf advance:*)` 强化 UX(但这是 skill UX 选择,非 protocol enforce)
- 详见 §14.3 + `references/loaf-skill-helpers.md`

#### `--input` source 判别(rev 4.3,ADR-0004 A11)

`--input` flag 的判别顺序(数据形态 → 解析路径):

```
1. 值 === "-"               → 从 stdin 读直至 EOF;parse JSON
2. 值 matches /^[\{\[]/     → 当 inline JSON 字符串;直接 parse
3. 其它                      → 当文件路径;读文件后 parse(路径不存在 → exit 2 INPUT_FILE_NOT_FOUND)
```

覆盖三种典型调用形态,不增加 modality 维护成本:

- **LLM skill 写文件再引用** → 路径模式(skill 控制 LLM 多步产文件最自然)
- **机器管道** → `echo '{...}' | loaf <cmd> --input -`(CI / shell 脚本)
- **单条 ad-hoc** → `loaf <cmd> --input '{"...":"..."}'`(手工 / 一次性)

实现协议位于 `schemas.ts` §40 `InputSourceResolver`(discriminated union: `stdin` / `inline` / `path`)。5 个 mutator 命令(`spec:add-req` / `spec:add-scenario` / `spec:add-visual` / `tasks:add` / `evidence:add`)的 input schema 集中于同节 `INPUT_SCHEMAS`,每个支持 single 或 array 形态(batch 三纪律见 §11.2)。

**`--help` 顶部约定**(clig.dev §5):每个接受 `--input` 的命令 `--help` 顶部带 2-3 个工作 JSON 示例(覆盖典型 shape),flag 表在示例下方。`loaf <cmd> --schema --json` 一并 dump JSON Schema 供 LLM / fixture 自描述。

#### `--dry-run` 契约(rev 4.1,v1.0)

**动机**:rev 4.1 §11.2 引入 fan-out 后,N 个 worker 并发调 mutator 命令前,需要"会不会冲突 / 会不会过 gate"的预检能力,**不实际写盘**。CI 也需要 dry-run 做 pre-merge 校验。

**行为**:

| 命令类别 | `--dry-run` 行为 |
|---|---|
| **Mutating 命令**(`advance` / `spec submit` / `tasks submit` / `tasks step start/done` / `tasks amend` / `evidence add` / `finding raise/close` / `gate decide` / `waive` / `settle` / `amend` / `archive` / `abandon` / `spike convert` / `pending resolve` / `profile escalate` / `lessons add` / `start`) | **rev 5.0**:走 §11.2 10-step transaction 步 1-5(acquire .lock → read tail + `_meta` fast-check → preflight validate → prepare sidecar files into short-lived `.tmp-*`(不 rename)→ final validate against embedded refs),然后 **跳过 step 6 journal append + step 7 post-apply assert + step 8 snapshot rebuild + step 9 registry refresh**,改为:**unlink sidecar `.tmp-*` + release .lock**(即 step 10 cleanup-only 分支)。stdout 打"would do"摘要(JSON / text 按 `--format`)。**不分配 EV/PEND/T/REQ/SCEN/VIS id**(避免单调计数器空跳);若校验过则 stdout 列将分配的 next-id 范围。**不写 journal entry、不 rebuild snapshots、不 refresh registry**。exit 0 = 校验通过,exit 2 = 会失败(schema / transition / actor authority / lock 抢占等)。机器表达见 schemas.ts §34 `dry_run_transaction_order` |
| **Read-only 命令**(`status` / `tasks list` / `tasks next` / `tasks check` / `finding list` / `verify status` / `check <path>` / `<artifact> schema --json` / `evidence schema` / `resume` / `sessions list` / `tui` / `doctor`(no `--fix`)/ `--version` / `--help`)| **reject** `--dry-run`:exit 2 + stderr `error: --dry-run not applicable to read-only command` |
| **Wrapping 命令**(`spec edit` / `tui`)| reject `--dry-run`(无 mutation 意图直接落到 wrap 程序)|
| **Hook 入口**(`hook <event>`)| 透传给被 hook 的 mutator;`PreToolUse` hook 接 `--dry-run` 时只跑 write-guard 校验不写 reconcile 缓存 |

**Skill / CI 用法示例**:

```bash
# Skill fan-out 前 pre-check:每个 worker 想 claim 一个 task
loaf --dry-run tasks step start --task T-001 --step implement
# exit 0 → safe to proceed; exit 2 → 看 stderr / snapshots/gate-diagnostic.json

# CI pre-merge:检查 spec 改动会不会过 spec-lock
loaf --dry-run spec submit ./spec.md
loaf --dry-run gate decide spec-lock --approve --reason "ci precheck"
```

**rev 4.1 invariant**:dry-run 命令**不持久任何状态**(不写 `.loaf/<feature>/*`、不改 `~/.loaf/registry/`、不递增 EV-id 计数器)。机器表达见 schemas.ts §34 `CONCURRENCY_INVARIANTS.dry_run_transaction_order`。

### 10.8 Command table

**命名修正**(对照 rev 3.x):
- `loaf check tasks` → **`loaf tasks check`**(consistency:`loaf tasks` 系列名词在前)
- `loaf check <kind>` → 保留 `loaf check <path>` 形式(`<path>` 是文件 path,`loaf check` 作为 validation 入口)
- `loaf settle` → 保留(session lifecycle chaos deviation,见 §10.6)
- 其余命令名不变

**rev 5.0 actor / kind 契约**(ADR-0005 §3.3 / §3.4):
- **`--actor` 永久 non-flag**:actor 由 CLI 在 §11.2 step 3 自动注入(`human:` ← isatty + `$USER`;`skill:` ← SessionStart hook payload;`ci:` ← CI env;`cli:` ← fallback;`migration:` ← `loaf doctor --migrate-v2`)。任何命令 surface `--actor` 必被 ADR-trail 拒。
- **每个 mutator 命令显式 emit 一个 journal entry kind**(ADR-0005 §3.3 namespace);完整 command → kind 映射见本节末尾「Journal entry kind emitted」表。Reducer 在 §11.2 step 3 + step 5 对 (kind, payload, actor, sub_state) 做闭环 refine。

> **rev 4.1 did-you-mean 兜底**:用户敲 `loaf check tasks`(把 "tasks" 当 enum keyword 误用)时,`loaf check <path>` 在 path 解析阶段发现 "tasks" 不是有效文件路径,走 §10.1 did-you-mean 规则,stderr 提示「did you mean `loaf tasks check`?」并 exit 2。**`loaf tasks check` 与 `loaf check <path>` 不是 canonical/alias 关系**:前者跑 `tasks.execution.status ↔ evidence.jsonl` 一致性专项校验,后者是单文件 schema 校验入口(CI 用),做的不是同一件事。

**Tier 1 mutator 通用契约**(rev 4.3,ADR-0004 A2 / A3 / A5 / A10):

- 5 个结构化 mutator(`spec add-req` / `spec add-scenario` / `spec add-visual` / `tasks add` / `evidence add`)走统一 `--input <-|json|path>` modality(§10.7);positional id / per-field flag 已砍。
- 每条 input schema 接受单条对象**或**非空数组(batch);batch 三纪律(all-or-nothing / `spec_version += 1` per invocation / atomic id allocation)由 §11.2 transaction 落实。
- `id` 由 CLI 在 per-session lock 内单调分配:REQ / SCEN / VIS 输入只携 `id_namespace`(stem),CLI 扫该 namespace 下 max serial → 拼完整 id 落 spec.md(input regex vs output regex 见 §4.2 ID 分配段 + `schemas.ts` §40)。T / EV / FND / PEND 完全 CLI 自动分配,input **不**传 namespace 字段。
- `--schema` 全局 modifier 跟 `--json` 联用(`loaf <cmd> --schema --json`)dump 该 input 的 JSON Schema(派生自 `schemas.ts` §40 `INPUT_SCHEMAS`)。
- shape enforcement 全在 CLI:三选一可验证 / 6×6 finding grid / attachment hash+mime / id 唯一性 — workflow content 留给 loaf-skill,见 §19。

| 命令 | 用途 | exit |
|---|---|---|
| `loaf start <desc> [--feature <name>]` | 进入 TRIAGE,在 `.loaf/<feature>/` 起新 session。**rev 4.1**:stdout **最后一行**打印新 session 的 UUID(可预测,shell 脚本可 `UUID=$(loaf start ... \| tail -1)` 抓取);stderr 一行 state-change(§10.12)| 0 / 2 |
| `loaf status` | 读 state + artifact 健康度 | 0 |
| `loaf advance` | 跑下一 transition + diff guard | 0 / 1 / 2 |
| `loaf resume` | 恢复 session(从 `resume-pack.json` 接力)。**rev 4.3**(ADR-0004 A8):`--fresh` flag 已砍 — routine phase-switch 上下文切片改走 `loaf context pack` | 0 |
| `loaf context pack [--phase auto\|<sub_state>] [--format json\|text]` | **rev 4.3**(ADR-0004 A8):phase-aware context pack(`CONTEXT_PACK_TEMPLATES` 见 `schemas.ts` §38)— 每 sub_state 输出当前 phase 需要的最小上下文 slice。read-only,不写盘。default `--phase auto` 读 `state.json` 当前 sub_state | 0 |
| `loaf handoff` | **rev 5.0**:read-side 命令,reducer 从当前 journal + snapshots 派生 `snapshots/resume-pack.json`(显式 context overflow 接力快照);不 emit 新 journal entry,只触发 snapshot rebuild | 0 |
| `loaf spec submit <file>` | 提交 spec.md,严格 schema 校验 | 0 / 2 |
| `loaf spec submit --json -` | 从 stdin 接收 JSON(机器流水线) | 0 / 2 |
| `loaf spec init` | 生成 spec.md 模板,适合 `$EDITOR` 跟进 | 0 |
| `loaf spec edit` | 编辑当前 spec.md + 再次 schema check | 0 / 2 |
| `loaf spec add-req --input <src>` | **rev 4.3**(ADR-0004 A1 / A4 / A5):增量加单条或 batch EARS REQ。Input 含 `id_namespace`(`^REQ-[A-Z][A-Z0-9]*$`)+ EARS 字段;CLI 在 lock 内拼完整 `id`(`REQ-<NS>-<NNN>`)落 `spec.md`,`spec_version += 1`(per invocation,A10)。pre-lock(SPEC.spec/plan/design)合法;post-lock 拒 → `SPEC_LOCKED_NO_DIRECT_EDIT` exit 2,走 `amend-spec` finding。`--schema --json` dump input JSON Schema | 0 / 2 |
| `loaf spec add-scenario --input <src>` | **rev 4.3**(ADR-0004 A1 / A4 / A5):增量加 Gherkin scenario,id_namespace 模式 `^SCEN-[A-Z][A-Z0-9-]*$`。其余规约同 `spec add-req` | 0 / 2 |
| `loaf spec add-visual --input <src>` | **rev 4.3**(ADR-0004 A1 / A4 / A5):增量加 visual contract,id_namespace 模式 `^VIS-[A-Z][A-Z0-9-]*$`。其余规约同 `spec add-req` | 0 / 2 |
| `loaf tasks submit <file>` | 提交完整 task graph(SPEC.design 阶段)。**rev 5.0**:走 §11.2 transaction,emit `event:tasks_planned`(payload 含完整 task array);reducer 派生 `snapshots/tasks.json` | 0 / 2 |
| `loaf tasks add --input <src>` | **rev 4.3** + **rev 5.0**:单条或 batch task 加入。SPEC.design 阶段 emit `event:tasks_planned`(整批 entry,batch markers);EXECUTE 阶段 emit `event:tasks_amended`(走 finding `amend-tasks` 路径)。原 `<T-N>` positional + `--kind` / `--drives` per-field flag **已砍**;CLI 在 lock 内单调分配 `T-id`(`^T-\d{3,}$`)并 stdout 回打;reducer 派生 `snapshots/tasks.json` | 0 / 2 |
| `loaf tasks claim <T-N>` | 把 task 从 `ready` 拉到 `in_progress`(worker 拿活,fan-out 多 worker 并发用);CLI 在 lock 内确认 deps_on satisfied | 0 / 2 |
| `loaf tasks complete <T-N>` | 把 task 整体推到 `done`(要求全部 must step 已 passed/waived/na);**rev 4.1**:同 `tasks step done` 也是单 transaction。**rev 4.2**:rename from `loaf tasks done` — 与 `tasks step done` 同名异级歧义,改 `complete` 消歧(clig.dev §8) | 0 / 2 |
| `loaf tasks register-red <T-N>` | 给 `behavioral+labels=["bug"]` task 注册 RED 测试(§9.3 唯一硬约束)| 0 / 2 |
| `loaf tasks amend <T-N> --policy <...>` | spec-lock 后窄修 `execution[].applicability`(EXECUTE.plan 阶段;不能改 drives / depends_on / kind,见 §8.6) | 0 / 2 |
| `loaf tasks list` | 列所有 task 当前 step(rev 4.0:rename from `loaf tasks status`,避免跟 `loaf status` session-level 命名歧义) | 0 |
| `loaf tasks next` | CLI 算下一个 ready task | 0 |
| `loaf tasks check` | `snapshots/tasks.json` 的 `execution.<step>.status` 与 `snapshots/evidence.json` 一致性校验(rev 5.0:两个 derived projection 是 reducer 同一次重建产物,理论无 drift;mismatch → 触发 §10.15 snapshot-seq-mismatch / 提示 `loaf doctor --rebuild`);rename from `loaf check tasks` (rev 4.0) | 0 / 2 |
| `loaf tasks step start --task T-N --step <s>` | 开始一个 step(运行时校验 step ∈ kind 合法集) | 0 / 2 |
| `loaf tasks step done --task T-N --step <s>` | 完成一个 step。**rev 5.0** 行为(等价于原 rev 4.1 contract):走 §11.2 10-step journal transaction,**同一 batch 内 emit** `event:task_step_done` + 可选 `evidence:added`(若 `--evidence-*` flag);step 5 final-validate 通过后整批 append,reducer 派生到 `snapshots/tasks.json`(`execution.<step>.status`)与 `snapshots/evidence.json`,绝不分两次 `loaf <cmd>` 调用。无对应 evidence proof 时 step 3 preflight 报 `TASK_STATUS_WITHOUT_PROOF` exit 2 | 0 / 2 |
| `loaf evidence add --input <src>` | **rev 5.0**:走 §11.2 transaction,**emit `evidence:added`**(单条或 batch,batch markers N≥2);reducer 派生到 `snapshots/evidence.json`(含 covers[] / check / actor / result)。**rev 4.1**:不接受 `--id` flag,EV-id 由 CLI 单调分配在 payload 内并 stdout 回打;支持 `external_ref` 字段留调用方 correlation。**rev 4.3**(ADR-0004 A3 / A6 / A10):走 `--input` JSON 形态,`attachments` 接受简化 `[{ path }]` — CLI 自动 sha256 + mime infer + canonical path 拷到 `.loaf/<feature>/attachments/<entry_id>/`(**rev 5.0**:按 journal entry_id 分桶,非 EV-id)+ stat bytes(见 §4.4);path 不存在 → `ATTACHMENT_NOT_FOUND` exit 2,非常规文件 → `ATTACHMENT_NOT_FILE` | 0 / 2 |
| `loaf evidence schema --json` | dump evidence JSON Schema | 0 |
| `loaf waive <obligation-id> --reason "..."` | **rev 5.0**:emit `evidence:added`(payload `kind=waiver`);reducer 派生到 `snapshots/evidence.json` 的 waiver view。actor 必须 `human:*`;reason ≥10 字符 | 0 / 2 |
| `loaf finding raise --category X --action Y --summary "..."` | **rev 5.0**:emit `finding:raised`;若 action `requires_target_payload`(如 `amend-tasks` / `fix-impl`),同 batch 加 emit `event:tasks_amended` + `event:phase_advanced`(back-edge transition);reducer 派生到 `snapshots/findings.json` | 0 / 2 |
| `loaf finding list [--status open\|closed]` | 列 findings | 0 |
| `loaf finding close <FND-id>` | **rev 5.0**:emit `finding:closed`;reducer 派生到 `snapshots/findings.json` | 0 / 2 |
| `loaf verify status` | 实时算各 check 状态 | 0 |
| `loaf gate decide <G>` | gate 决策 → **rev 5.0**:走 §11.2 transaction,**同一 batch 内 emit** `gate:decided` + `pending:resolved`(消 head pending kind=gate_decision)+ `event:phase_advanced`(target 由 §3.5 复用的 LEGAL_TRANSITIONS 给出)。reducer 派生 evidence projection 中 `kind=gate-decision` 视图。head 不匹配 → step 3 preflight 报 `GATE_NOT_PENDING` exit 2 | 0 / 2 |
| `loaf settle` | **rev 5.0 + 5.x**:走 §11.2 transaction 进入 SETTLE.reconcile,emit `event:phase_advanced`;reducer 计算 drift + 派生到 `snapshots/reconcile.json`(**rev 5.x:deep only**;quick / light / standard 不产 reconcile snapshot)。session lifecycle chaos deviation 保留单 verb | 0 / 2 |
| `loaf check <path>` | 纯 schema check(CI 用,任意 artifact 文件) | 0 / 2 |
| `loaf <artifact> schema --json` | 自描述命令,dump JSON Schema(spec/tasks/evidence/finding/state,**限定 5 个 enum**,非 catch-all) | 0 |
| `loaf amend --target spec\|tasks` | spec-lock 前编辑回退;**post-lock 拒绝执行,提示走 finding** | 0 / 2 |
| `loaf profile escalate --confirm` | 接受 auto-escalation prompt。**rev 4.1 Q3**:本身就是答 `pending(kind=profile_escalation)` head 的方式,head 不匹配 → `ESCALATION_NOT_PENDING` exit 2 | 0 / 2 |
| `loaf spike convert --to-feature F-N` | spike → 新 feature scaffold | 0 / 2 |
| `loaf deliver` | **rev 3.1:advisory only,不碰 git/gh**;mark DONE.delivered + 打印 suggested next commands;spike hard block。**rev 4.1 + 5.x**:有效 source sub-state 取决于 ceremony —— `verify_phase=false`(`quick` / `light`)从 `EXECUTE.done` 调用(触发 verify-min,通过则 DONE.delivered;light 额外打印 "REQ coverage not closed" 提示,见 §3 verify-min);`verify_phase=true && settle_phase=false`(`standard`)从 `VERIFY.accept` 调用(VERIFY 已走完,无 verify-min 二次跑);`settle_phase=true`(`deep`)从 `SETTLE.lessons` 调用(reconcile.json + lessons.md 已产)| 0 / 2 |
| `loaf archive --reason "..."` | 不交付关闭 | 0 / 2 |
| `loaf abandon --reason "..."` | 中途放弃(reason required) | 0 / 2 |
| `loaf lessons add` | **rev 5.0**:emit `evidence:added`(payload.kind=`manual`,内容是 lesson 文本;LongTextField > 8KB 走 sidecar);reducer 拼接派生 `lessons.md`(Advisory,内容形态不在 schema 闭环内,见 §13.1)| 0 / 2 |
| `loaf tui` | 启动 session manager TUI(读 ~/.loaf/registry/) | 0 |
| `loaf sessions list [--in-cwd]` | 列 session(non-TUI)。**rev 4.1**:`--in-cwd` 过滤当前 cwd;每行 `<UUID-short8> <feature> <phase.sub_state> <last_advance>` — terminal 重启后拾回 UUID 用。`--format json` 给 scripting | 0 |
| `loaf hook <event>` | Claude Code hook 入口。**rev 4.2**:`<event>` enum 限定 `session-start` / `write-guard` / `scope-track` / `closure-check`(详见 §11 hook surface 表);bare `loaf hook` → exit 2 列出 enum + did-you-mean;`loaf hook --list-events` 显式 dump | 0 / 2 |
| `loaf pending raise --kind <K> --question "..." [--options "a,b,c"] [--task-id T-N]` | **rev 4.1**:append 新 pending 到队列尾(skill / hook / sub-agent 内部调用,user 通常不直接敲);CLI 分配 PEND-id 并 stdout 回打;5 种 kind 任选(`ask_user_question` / `gate_decision` / `spec_clarification` / `finding_decision` / `profile_escalation`)。**不接受 `--id` flag**(同 `evidence add` 纪律,见 §11.2 + schemas.ts §34) | 0 / 2 |
| `loaf pending list` | 列 state.pending FIFO 队列全部 entry(**rev 4.1**:含 head + 排队的;head 标 `*`)| 0 |
| `loaf pending status [--id PEND-N]` | 查 single entry 详情(**rev 4.1**:default 看 head;`--id` 看队列其它位置 — 只读不动队列)| 0 / 2 |
| `loaf pending resolve [--answer <a>]` | 回答 pending head(**rev 4.1**:FIFO 严格 — 永远 pop `pending[0]`,**不接受 `--id`**;v1.0 不支持跳序);`--no-input` 时必须 `--answer` flag。resolve 成功后队列若仍非空,新 head 自动 promote 为 blocker | 0 / 2 |
| `loaf doctor` | 版本 / 装机 / 仓库结构自检 + 修复建议。**rev 5.0** 加 5 sub-flag:`--rebuild`(full replay 重建 snapshots/)/ `--check-tail`(只跑 batch-aware tail recovery)/ `--migrate-v2`(v0.0.x → v0.1.0 sidecar import,§5.2)/ `--scope cwd`(对 cwd 下所有 `.loaf/<feature>/` 跑 mixed-version check)/ `--verify-checksum`(full chain rolling_checksum recompute,O(N))。详 §10.15 + ADR-0005 §5.4 | 0 / 1 / 2 |

**Journal entry kind emitted by each Tier 1 mutator**(rev 5.0,ADR-0005 §3.3):

| Command | Emitted kind(s) |
|---|---|
| `loaf advance` | `event:phase_advanced` |
| `loaf ceremony set` | `event:ceremony_set` |
| `loaf spec add-req` | `event:spec_req_added`(batch:N entries 共享 batch_id) |
| `loaf spec add-scenario` | `event:spec_scenario_added`(batch) |
| `loaf spec add-visual` | `event:spec_visual_added`(batch) |
| `loaf spec submit` | `event:spec_submitted` |
| `loaf tasks submit` / `tasks plan` | `event:tasks_planned` |
| `loaf tasks add` | `event:tasks_amended`(EXECUTE 阶段)/ batch entry under `event:tasks_planned`(SPEC.design) |
| `loaf tasks claim` | `event:task_claimed` |
| `loaf tasks step start` | `event:task_step_started` |
| `loaf tasks step done` / `tasks complete` | `event:task_step_done`(+ 同一 batch 内 `evidence:added` 若 `--evidence-*`) |
| `loaf tasks amend` | `event:tasks_amended` |
| `loaf evidence add` | `evidence:added`(batch) |
| `loaf waive` | `evidence:added`(payload.kind=`waiver`) |
| `loaf finding raise` | `finding:raised` |
| `loaf finding close` | `finding:closed` |
| `loaf pending raise` | `pending:added` |
| `loaf pending resolve` | `pending:resolved` |
| `loaf gate decide` | `gate:decided`(+ atomic `pending:resolved` 消 head;actor `human:` only) |
| `loaf start` | `session:started`(journal seq=0) |
| `loaf resume` | `session:resumed` |
| `loaf deliver` | `session:delivered`(actor `human:`) |
| `loaf settle` | `event:phase_advanced`(SETTLE 入口);reconcile 计算落 `snapshots/reconcile.json`,不发 entry |
| `loaf archive` | `session:archived`(actor `human:`;reason 必填) |
| `loaf abandon` | `session:abandoned`(actor `human:`;reason 必填) |
| `loaf spike convert` | `spike:converted`(actor `human:`) |
| `loaf doctor --migrate-v2` | `migration:snapshot_imported`(actor `migration:*`;journal seq=0/1 only) |
| `loaf tasks register-red` | reducer-side `event:task_step_done`(payload `red_test_registered=true`) |
| `loaf profile escalate` | `pending:resolved`(answers `profile_escalation` head)+ `event:ceremony_set` (新 ceremony) |
| `loaf lessons add` | (reducer 拼接 `lessons.md` 派生投影;journal kind 待 v0.1.x 定 — v0.1.0 直接 emit `evidence:added` payload.kind=`manual`,`lessons.md` 由 reducer 派生) |

Read-only 命令(`loaf status` / `tasks list` / `tasks check` / `tasks next` / `verify status` / `finding list` / `pending list` / `pending status` / `sessions list` / `<artifact> schema` / `check <path>` / `tui` / `handoff` / `context pack` / `hook *` 中的非-mutating event)**不**写 journal,只读 `snapshots/*.json` 并执行 §10.15 fast check(Gate #5)。

### 10.9 Exit codes

| Code | 含义 |
|---|---|
| **0** | success |
| **1** | unexpected internal error(panic / IO crash / out of disk);crash log 在 `~/.loaf/crashes/<ts>.log` |
| **2** | expected user error(schema validation / illegal transition / 缺必要 flag / unknown subcommand / `--no-input` + 缺 prompt input)— 这是最常见的非 0 code |
| **130** | SIGINT(Ctrl-C 中断,POSIX 惯例) |

**为什么只 3 档(不算 130)**:loaf 不做 network / 不碰 remote state,失败模式比典型 CLI 少;`1` 跟 `2` 区分「程序错」vs「用户错」足够。

### 10.10 Future-proofing

- **`--format json` 是 stable contract**(跟 `schemas.ts` 字段集 lock-step 演进;schema_version bump 时同步)
- **`--format text`(`--plain`)是 stable line-oriented contract**(脚本可解析)
- **Human terminal 输出**(TTY default)**不是 contract,可以自由演进**(改文案 / 加颜色 / 重排不算 breaking)
- **不引入 catch-all**(§10.6)+ **不引入 prefix abbreviation alias**(§10.6)
- §15 done-when freeze:**不允许新增 top-level CLI 子命令**(rev 4.0 后)— 跟 schema freeze 并行

### 10.11 Distribution(implementation 阶段)

- 单 binary(`bun build --compile`)— macOS / Linux x86_64 / arm64
- 分发:Homebrew formula(`brew install loaf-cli`)+ `bun install -g @loaf/cli` 双轨
- **Man pages**:生成 `man loaf`(top-level)+ 每个 subcommand group 一份(`man loaf-spec` / `man loaf-tasks` / `man loaf-evidence` / `man loaf-finding` / `man loaf-gate` / `man loaf-sessions` 等);`loaf help <topic>` 等价 `man loaf-<topic>`(若 topic 不是 group 则 fallback 到 `loaf <topic> --help`)
- `uninstall` 指引放安装文档**末尾**(clig.dev §15 约定):brew → `brew uninstall loaf-cli`;bun → `bun pm uninstall -g @loaf/cli`;man page 由包管理器自动清
- **No telemetry**(协议层面声明,§16 显式非目标也含此条);crash log(`~/.loaf/crashes/`)**永不自动 upload**,用户手动贴 issue 时 review 并删 PII 后才上传

**Build-time URL stamping**(rev 4.1):两个 URL 必须在 `bun build --compile` 时通过环境变量注入,**不允许**在 source 写死或留 `<placeholder>`:

| Build env var | 用途 | 默认 | v1.0.0 tag 强制 |
|---|---|---|---|
| `LOAF_DOCS_URL` | 注入到 `--help` 文案末尾的"完整 protocol"链接 | (placeholder)`https://docs.loaf-cli.invalid/v1` | ✅ 必须非 `*.invalid` |
| `LOAF_ISSUE_URL` | 注入到 unexpected error 的 bug-report URL(§10.5)| (placeholder)`https://github.com/loaf-cli/loaf/issues/new` | ✅ 必须非 placeholder |

- `loaf --version` 在 placeholder URL 下运行时 stderr 多打一行 `warning: docs URL placeholder; build with LOAF_DOCS_URL=...`;exit 仍 0
- CI release pipeline 在 tag v1.0.0 之前 grep `*.invalid` / `loaf-cli/loaf` 默认值,命中 → 阻断 release
- 见 §15 done-when freeze 第 5 条

### 10.12 State-change output convention(clig.dev §4 强 require)

任何**改变状态**的命令成功(exit 0)时,**stderr 必须**输出一行说明「什么变了」,可选再一行 next-step hint。`--quiet` / `-q` 抑制这两行(但不抑制错误)。

格式:

```
<action>: <what-changed-summary>
next: <suggested next command>            # 可选,仅在有强自然下一步时给
```

各命令规约:

| 命令 | state-change line | next hint(若适用) |
|---|---|---|
| `loaf start` | `start: F-001 'auth-refresh' created → TRIAGE.score` | `next: loaf advance` |
| `loaf advance` | `advance: <prev sub-state> → <new sub-state> (iter=N)` | `next: <prompt_inject 第一行>` |
| `loaf spec submit` | `spec submit: spec_version=N, locked=false` | `next: loaf gate decide spec-lock` |
| `loaf spec add-req` | `spec add-req: +K REQ (spec_version=N → N+1; allocated REQ-AUTH-007..009)` | `next: loaf spec add-scenario --input ...`(若 scenario 缺)或 `next: loaf spec submit`(若覆盖足够)|
| `loaf spec add-scenario` | `spec add-scenario: +K SCEN (spec_version=N → N+1; allocated SCEN-LOGIN-001..003)` | — |
| `loaf spec add-visual` | `spec add-visual: +K VIS (spec_version=N → N+1; allocated VIS-DASH-001)` | — |
| `loaf tasks submit` | `tasks submit: N tasks (tasks_version=M)` | `next: loaf advance` |
| `loaf tasks add` | `tasks add: +K tasks (tasks_version=M → M+1; allocated T-008..010)` | `next: loaf advance`(若 SPEC.design 已完成全量加入)|
| `loaf tasks step start` | `step start: T-007 implement (running)` | — |
| `loaf tasks step done` | `step done: T-007 implement (passed)` | `next: loaf tasks step start --task T-007 --step refactor`(若 task 还有 step;全部 must step 完成 → `next: loaf tasks complete T-007`) |
| `loaf tasks complete` | `tasks complete: T-007 → status=done (3/3 must steps passed)` | `next: loaf advance`(若该 task 是当前 sub_state 最后一个 must task) |
| `loaf evidence add` | `evidence add: +K evidence (EV-000125..000127; kind=verify-review, covers=REQ-AUTH-007)` — single 输入时退化为 `EV-000125` 单条形态 | — |
| `loaf finding raise` | `finding raise: FND-002 (category=spec-gap, action=amend-spec) — back-edge to SPEC.spec` | — |
| `loaf finding close` | `finding close: FND-002 → resolved (drift_index=0)` | — |
| `loaf gate decide` | `gate decide: spec-lock approved by human:est9` | `next: loaf advance` |
| `loaf settle` | `settle: snapshots/reconcile.json rebuilt (drift=0, iter_stats=...)` | `next: loaf deliver` |
| `loaf deliver` | `deliver: DONE.delivered (advisory only)` + 见 §10.12 advisory 段 | — |
| `loaf archive` / `loaf abandon` | `archive: DONE.archived` / `abandon: DONE.abandoned (reason='...')` | — |
| `loaf amend` | `amend: tasks_version=N (pre-lock edit)` | `next: loaf advance` |
| `loaf waive` | `waive: EV-000130 (kind=waiver, obligation=REQ-AUTH-008)` | — |
| `loaf pending resolve` | `pending resolve: '<answer>' → cleared` | `next: <prompt_inject>` |

**read-only 命令**(`loaf status` / `loaf tasks list` / `loaf finding list` / `loaf verify status` / `loaf sessions list` / `loaf doctor` / `loaf evidence schema` / `loaf <artifact> schema --json` / `loaf context pack`(rev 4.3)/ 任何 `--schema --json` modifier 调用)**不出 state-change line**(它们就是查询)。

**`--quiet` 行为**:抑制 state-change + next hint 行;主输出(stdout)正常;错误仍出。

**`--no-input` 不影响这些行**(它只控 prompt)。

### 10.13 Long-op progress(clig.dev §9)

预期耗时 > 1 秒的命令(典型:`loaf settle` 大 feature / `loaf check <path>` 跑全 evidence aggregate)stderr 出 progress 提示:

- stdout 是 TTY → spinner(`⠋ scanning evidence...`)或 milestone 行(`scanning evidence (24/47)`),覆写当前行
- stdout 非 TTY → 仅在 milestone 打 newline-terminated 一行(`scanning evidence (24/47)`),不动画
- `--quiet` 抑制 progress(保留错误)
- progress 永远走 stderr,不污染 stdout(否则 `--format json | jq` 炸)

### 10.14 `loaf deliver` 输出示例(Q4 advisory-only 落地)

```json
{
  "status": "delivered",
  "session_id": "...",
  "feature": "auth-refresh",
  "advisory": [
    "git status",
    "git add .loaf/auth-refresh/",
    "git commit -m \"feat(auth): refresh token recovery (F-001)\"",
    "gh pr create --title \"...\""
  ]
}
```

git / gh side effect 是 loaf-skill 或用户自己负责,**不进 loaf-cli**。

**永久 non-goal**:自动 commit / PR / CI 由 loaf-skill 或用户手工调(rev 3.1 锁定,见 §16)。lessons promote / list --hits 见 §12.2(v1 显式不做,scope discipline)。

### 10.15 `loaf doctor` 诊断清单(rev 4.1)

`loaf doctor` 是 loaf-cli 的**唯一自检入口**,被 §4.12 / §10.4 / §10.5 / §11.2 多处引用。本节定义它跑的全部 check 与可选 `--fix` 行为。所有 check **read-only by default**,加 `--fix` 才尝试修复。

| Check | 范围 | 检测条件 | `--fix` 行为 |
|---|---|---|---|
| **stale-lock** | `.loaf/<feature>/.lock`(所有 feature)| 文件存在 + 内含 PID 不在进程表 | `unlink` 锁文件(POSIX rename atomic 写过,所以安全)|
| **orphan-tmp** | `.loaf/<feature>/*.tmp-*` | mtime > 60 秒 + 无对应 active lock | `unlink` |
| **registry-stale** | `~/.loaf/registry/*.json` | 文件 `at` 早于对应 state.json `heartbeat_at` > 5 分钟 | 重写 registry 投影从 canonical(`--rebuild-registry` 简写)|
| **registry-orphan** | `~/.loaf/registry/<id>.json` | 对应 cwd 已无 `.loaf/<feature>/state.json`(repo 被删 / session id 不匹配)| `unlink` registry 文件 |
| **registry-gc** | `~/.loaf/registry/*.json` | mtime > 30 天 | `unlink`(§4.12 GC 策略)|
| **crash-log-prune** | `~/.loaf/crashes/*.log` | mtime > 30 天 | `unlink`(避免堆积)|
| **schema-drift** | `.loaf/<feature>/{journal.jsonl,snapshots/_meta.json}` + legacy `.loaf/<feature>/{state,spec,tasks,evidence,findings}.json/jsonl`(仅 v0.0.x backup 或迁移源)| 当前 binary 期望 `SCHEMA_VERSION=2`(rev 5.0);journal `entry_schema_version` 或 `snapshots/_meta.json.feature_schema_version` ≠ 2 → drift;legacy `schema_version=1` artifact 出现在 active feature 而非 backup → 触发 migration-v0.0.x 路径 | 不自动 fix;打印 `SCHEMA_VERSION_MISMATCH` + migration hint(`loaf doctor --migrate-v2`);v1 GA 后 `SCHEMA_VERSION` freeze 在 2,理论无 drift |
| **artifact-corruption** | 上同 | Zod parse 失败 / 非法 JSON | 不自动 fix;打印 path + Zod 错误,提示手动恢复或从 git 历史 checkout |
| **url-placeholder**(只在 startup 内嵌跑)| binary build 元数据 | `LOAF_DOCS_URL` 或 `LOAF_ISSUE_URL` 是默认 placeholder(见 §10.11)| 不 fix(rebuild 才能修);警告即可 |
| **stale-claim**(rev 4.1 + rev 5.0 reframed)| `snapshots/tasks.json` 中 `status="in_progress"` 的 task | `task.execution.<step>.started_at` > 30 分钟 + 自 started_at 后该 task_id 在 `snapshots/evidence.json`(`evidence:added` view)无新 entry | **v0.1.0 状态:non-trivial**——单写者纪律下,doctor 修复也得 emit journal entry 才能改 reducer-visible state。两种实现方案(待 ADR-0006-doctor-repair 决定):(a)emit 新 kind `event:claim_reclaimed`(actor `cli:doctor`,reducer 派生回 status=ready + 写 audit evidence:added),走 §11.2 transaction 落地;(b)纯诊断 — 只 stderr 警告 + 标 finding,不动 state,人工介入。**v0.1.0 默认 (b) advisory-only,不带 `--fix`**;`--fix` route 暂留为 v0.1.x 工程项(走 (a))。`loaf doctor` 现 stage 只识别 + 报,不改 state |
| **orphan-attachment**(rev 5.0,ADR-0005 §3.5 step 4d/5 crash window)| `.loaf/<feature>/attachments/<entry_id>/**` | 文件存在但 journal.jsonl 中无 matching `entry_id` 的 entry,或 entry 中无指向该 file 的 `AttachmentRef` | `--fix`:删 orphan 目录 + 写 `evidence:added kind=local-check actor=cli:doctor result=passed summary="purged orphan attachment <entry_id>/<path>"`(audit trail)|
| **tail-corruption**(rev 5.0,ADR-0005 §4.13 + Gate #4)| `.loaf/<feature>/journal.jsonl` 末尾 | 末行 partial JSON / 末 batch `batch_index < batch_count - 1` 或 batch 末 entry partial / sha256(last entry) ≠ `_meta.last_entry_line_hash` | `--fix`:单 entry partial → truncate 末行;batch incomplete → truncate 整批至 batch 第一 entry 之前;rewrite `snapshots/_meta.json`;若 truncate 跨过 `last_applied_seq` → 同时跑 `--rebuild` |
| **stale-tmp**(rev 5.0)| `.loaf/<feature>/{journal.jsonl,snapshots/*,attachments/**}.tmp-*` | 任意 `.tmp-*` 残留 + mtime > 60s + 无 active lock | `--fix`:`unlink` 全部 |
| **snapshot-seq-mismatch**(rev 5.0,Gate #5)| `.loaf/<feature>/snapshots/_meta.json` | `last_applied_seq` < 实际 journal 末 entry seq,或 `last_entry_line_hash` mismatch | 不自动 fix;打印 `SNAPSHOT_STALE_REBUILD_REQUIRED` 提示跑 `loaf doctor --rebuild`(reader contract 永不静默 fallback,ADR-0005 §3.6) |
| **migration-v0.0.x**(rev 5.0,ADR-0005 §5.2)| `.loaf/<feature>/` | 存在 v0.0.x N-file 形态(`state.json` / `tasks.json` / `evidence.jsonl` 等)且无 `journal.jsonl` | 不自动 fix;打印 `SCHEMA_VERSION_MISMATCH` 提示跑 `loaf doctor --migrate-v2`(Step 1-7 sidecar import) |
| **rolling-checksum-mismatch**(rev 5.0,ADR-0005 §3.1 full verify path)| `.loaf/<feature>/journal.jsonl` | `loaf doctor --verify-checksum` 重算整链(O(N))与 `_meta.rolling_checksum` 不匹配 | 不自动 fix;打印 journal 中段 corruption 位置;手动 recovery(git 历史 / backup) |
| **sidecar-validation-drift**(rev 5.0,ADR-0005 §3.5 step 5d)| internal invariant | step 5d final-validate reducer-visible diff vs step 3c preflight 结果(应当永远相同) | 不自动 fix;指示实现 bug;dump entry payload + reducer trace 进 `~/.loaf/crashes/<ts>.log` 报 |

**调用契约**:

```bash
loaf doctor              # 跑全部 check,read-only,exit 0 = 全过,exit 1 = 任一失败
loaf doctor --fix        # 跑全部 check,可 fix 的尝试 fix,exit 0 = 全清,exit 1 = 仍有未修
loaf doctor --rebuild-registry   # 等价 --fix 但只跑 registry-* 三 check
loaf doctor --json       # 结构化输出,CI / TUI 消费
```

**启动期内嵌**:`loaf <any-cmd>` 启动时静默跑 `stale-lock` + `orphan-tmp` 两个 check 的 fix 路径(crash-only invariant 落地);其它 check 仅在显式 `loaf doctor` 时跑(避免每次 CLI 调用都扫全 registry)。

---

## 11. Hook Surface(Claude Code 集成)

> **Canonical event-name registry**:本节 hook event 名(`session-start` / `write-guard` / `scope-track` / `closure-check`)、§4.5 finding event 名(`opened` / `closed`)、§10.12 state-change verb、§4.4 evidence kind、`Drift.resolution` 等所有 event-style 名称的**单一索引**位于 `schemas.ts` §41(Event-name registry — canonical homes)。该 §41 是 doc-only index,指向各 enum 真理源 + 列出「Known drift names — DO NOT USE」清单(rev 4.3 drift sweep,见 ADR-0004 §「未在本 ADR 处理的项」)。外部文档(plan.md / design.html / 未来 impl tooling)消费 event 名时必须从这里查;`scripts/check-event-drift.sh` 是配套 lint,CI 或 pre-commit 跑一遍兜底。

| Event | Hook | 作用 | 失败行为 |
|---|---|---|---|
| `SessionStart` | `loaf hook session-start` | 读 state.json,注入 sub-state 的 `prompt_inject` + open findings + iteration + pending(若有)| 静默(无 .loaf/ 不报错)|
| `PreToolUse(Write,Edit)` | `loaf hook write-guard --path "$PATH"` | 检查当前 sub_state + 每个 in_progress task 的 (kind, running step) write_paths glob 并集(rev 4.0:fan-out 时多 task 并集),AND-merge `loaf.config.json` paths.* | exit 2 + reason |
| `PostToolUse(Write,Edit)` | `loaf hook scope-track --path "$PATH"` | 记录 actual_scope 到 reconcile 缓存 + heartbeat | 静默 |
| `Stop` | `loaf hook closure-check` | 退出前校验 phase/artifact 一致;无 orphan evidence;findings 合理 | warning |

### 11.1 diff-based guard(rev 3.1 全口径 git status)

**不**加 PreToolUse(Bash) hook(避免每个 Bash 命令过 hook 的 latency)。改为:`loaf advance` 时跑**完整 git status 组合**收集变更:

```bash
# rev 3.1 covers untracked / staged / deleted / renamed / submodule
git diff --name-only --diff-filter=ACMRTUXB
git diff --cached --name-only --diff-filter=ACMRTUXB
git ls-files --others --exclude-standard
```

归一化到 repo root,与**允许集合**(sub_state.write_paths ∪ STEP_WRITE_PATHS_BY_KIND[kind][step] ∪ loaf.config.json paths.*) AND-merge 比对。任何路径 outside = hard block + 写 reconcile.drift + 写 gate-diagnostic.json。

Bash 绕开 Write hook 的修改在 advance 时一定会被发现。

### 11.2 Single-writer + per-session lock + 10-step journal transaction(rev 5.0)

**协议级 invariant**(Principle #15 ③ + 15a 落地):**所有** `.loaf/<feature>/` 下的 artifact mutation **必须经 `loaf <subcommand>` 落成 journal entry**。skill / sub-agent / 编辑器 / 外部脚本 **不得直接** 写 `journal.jsonl` / `attachments/**` / `snapshots/*.json` / `spec.md` / `lessons.md` / `~/.loaf/registry/<id>.json`。

唯一例外:`spec.md` 工作副本在 `SPEC.*` pre-lock sub_state 由 `$EDITOR` 或人工编辑 — 但提交必须经 `loaf spec submit` → `event:spec_submitted` journal entry → reducer 重写 `spec.md` 派生投影,**不能在 EXECUTE / VERIFY 阶段被外部直写**(diff-guard 兜底)。

**为什么是协议层**:rev 4 引入 sub-agent fan-out(EXECUTE.work),多 worker 并发不加锁会撞 seq 冲突 / JSONL 半行 append / batch 半提交 / sidecar 半 rename / snapshot 与 journal 失同步。fan-out 上线第一天就会翻车。Rev 5.0 truth model = single typed journal(ADR-0005)进一步把"mutation 落地"从「多 artifact rename ladder」收口为「journal append + reducer rebuild snapshot」单一通道,所有 atomicity 集中在 §11.2 transaction。

**实现 contract**(loaf-cli 内部,impl 阶段固化;mirror ADR-0005 §3.5):

```
锁文件:    .loaf/<feature>/.lock(flock + PID + acquired_at)
锁粒度:    per-feature(不是 per-artifact;一 feature 一时刻一写者)
N14 限制:  fan-out 下多 worker 并行只是执行并发,不是 mutation 并发。
           所有 mutator 通过 per-feature lock 串行化;throughput 受 lock 窗口 +
           reducer + snapshot rebuild + sidecar I/O 总成本约束。

10-step journal mutation transaction:
  1. acquire .lock(blocking,≤30s;超时 LOCK_TIMEOUT exit 2)

  2. read journal.jsonl tail + snapshots/_meta.json
     2a. 校验 _meta.last_applied_seq + last_entry_offset + last_entry_line_hash
         vs journal tail(O(1) fast check,Gate #5 reader contract 同一套)
     2b. mismatch → 释放 lock,prompt loaf doctor --rebuild,
         exit 2 SNAPSHOT_STALE_REBUILD_REQUIRED

  3. preflight validate(candidate entries WITHOUT 最终 sidecar refs):
     3a. CLI 注入 actor(human:/skill:/ci:/cli:/migration: — 见 ADR-0005 §3.4)
     3b. Zod parse candidate entries(占位 AttachmentRef.sha256/path/size)
     3c. cross-kind / sub_state / mutation_rights / actor refine
         (per-kind 表见 ADR-0005 §3.6;`gate:decided` 与 `event:phase_advanced`
         **复用同一套** validateTransition helper — Gate #1)
     3d. dry-run reducer apply on in-memory state 副本
     3e. 若任一 candidate fail → abort,不做 step 4 起任何 I/O,
         CLI exit 2 + 具体 error code
     3f. 若 batch:assign batch_id = uuid(),batch_index / batch_count

  4. prepare sidecar files(if LongTextField > 8KB,or migration:* manifest refs):
     4a. write attachments/<entry_id>/<field>.<ext>.tmp-<random>
     4b. fsync attachment file + parent dir
     4c. atomic rename → final path
     4d. compute sha256,write entry payload AttachmentRef.{path,sha256,size}

  5. final validate(Gate #2,append 前最后校验):
     5a. re-Zod-parse entries with **embedded final** AttachmentRef
     5b. byte-size check(每条 entry serialized ≤ 64KB;batch 总 ≤ 64KB)
     5c. final dry-run reducer apply with final entries
     5d. 应与 step 3d 结果一致(sidecar embed 是 deterministic);**比较范围**
         限定为 reducer-visible state transition result + emitted projections,
         不做 byte-for-byte payload 比对(sidecar ref 填充会让 payload 必然 diff);
         若 reducer-visible 结果 diff → abort + log SIDECAR_VALIDATION_DRIFT
         (`loaf doctor` 标记;实现 bug 指示)
     5e. 若 batch 中任一 entry 校验 fail → abort 整批,sidecar tmp 清扫,
         journal 未变

  6. append journal entry(Gate #2:**只允许 append step 5 验证过的 final-form
                          entry**;禁止重新序列化 / 重新计算 AttachmentRef /
                          修改任何已 final-validated 字段):
     6a. single write():all-entries 拼接(\n 分隔),总 size ≤ 64KB
     6b. fsync journal.jsonl

  7. post-apply assert(纯 corruption assert,不再 abort):
     7a. reducer apply final entries to in-memory state
     7b. 若 apply 抛错 → 这是 bug(step 5 应已抓到);log + doctor 标记
         corruption,但**不**回滚 journal(journal 已是事实)

  8. rebuild affected snapshots(tmp+atomic rename per file):
     8a. write snapshots/<file>.json.tmp-<random>
     8b. fsync + atomic rename
     8c. update snapshots/_meta.json(last_applied_seq, last_entry_offset,
         last_entry_line_hash, rolling_checksum chain extend)

  9. refresh registry projection(~/.loaf/registry/<id>.json,tmp+rename)

  10. release .lock(unlink + close)

SIGINT 期间: cleanup hook 释放 .lock(§10.4);second-Ctrl-C 留 .lock,
             `loaf doctor` 启动时 stale 检测(PID 不存在 → unlink)
```

**Crash window 恢复**(ADR-0005 §3.5):每步 crash 由 `loaf doctor` 启动期 + 显式 sub-flag 处理 —— stale-lock / orphan-attachment / tail-corruption (batch-aware,Gate #4) / sidecar-validation-drift / snapshot-seq-mismatch / rolling-checksum-mismatch 七类 check 详 §10.15。

> **Current implementation status (rev 5.x MVP / Stages 1-6):** runtime `mutate()` currently collapses the §11.2 transaction into one async function (`src/core/journal-mutate.ts:73`). The caller supplies `tail_seq` + current in-memory `snapshot`; step 1 lock acquire, step 8 snapshot persistence, step 9 registry refresh, and step 10 lock release are deferred follow-up stages. Steps 2-7 are live in MVP form: seq/entry_id fill, preflight, sidecar promotion, final append validation, journal append, and reducer apply. Audit r2-r5 fixes are also live: r2 rejects reducer-unimplemented kinds before append and preserves mutate atomicity, r3 runs reducer dry-run before append on a `structuredClone` snapshot, r4 validates migration sidecars before appending `migration:snapshot_imported`, and r5 widens migration rollback around staged sidecars. Direct `appendEntry()` calls remain possible as an internal primitive, but bypass preflight / actor+sub_state authority / reducer dry-run; `mutate()` is the audit-sanctioned mutation path for CLI and skill-facing writes.

`tasks step done`(§10.8)等需要 atomic emit **多条** journal entry 的命令(例如 `event:task_step_done` + 同一批内 `evidence:added`)在**同一 batch + 同一 lock window 内**通过 §11.2 transaction 完成,不能分多次 `loaf <cmd>` 调用。Batch atomicity invariants 详 ADR-0005 §4.16 + 下方 §11.2 batch 三纪律。

#### Batch transaction 三纪律(rev 4.3,ADR-0004 A10)

Tier 1 mutator 命令(`spec add-req` / `add-scenario` / `add-visual` / `tasks add` / `evidence add`)的 `--input` 接受 single 对象 **或** 非空数组(数组形态 = batch)。Batch 落地必须遵守三纪律:

| 纪律 | 规则 | 违反后果 |
|---|---|---|
| **1a All-or-nothing** | 数组**整批先在内存 validate**(Zod + 跨条 invariant);任一条 fail → 整批 reject,**0 落盘** | 满足 append-only / crash-only / fan-out 单写者纪律。LLM 出 batch 时无需手工拆分小试,失败即整批回退,fix 后重发即可 |
| **1b `spec_version` += 1 per invocation** | batch = **一次 atomic invocation = 一个 spec_version bump**,不是 +N | `tasks.based_on.spec` 不因 batch 内部条数跳号失序;LLM 一次 add 15 条仍是「一次 spec 变更」 |
| **1c Atomic ID allocation** | lock 内**一次性**从 allocator 拿 N 个连续 id;全过才 commit allocator state | fan-out 多 worker 并发 batch 时,allocator state 不被半提交污染;失败回退时 id 不漏号 |

**Transaction 顺序**(rev 5.0:**不再独立**,直接走主 10-step transaction)

Batch path 与单条 path **共用同一套** §11.2 上方 10-step transaction;batch = N ≥ 2 时 envelope 出现 `batch_id` / `batch_index` / `batch_count` 三元组(ADR-0005 §3.2)。三纪律 1a/1b/1c 在 10-step 主流程内的落点:

- **1a all-or-nothing**:**step 3 preflight** (entire batch Zod-validate without final sidecar refs) AND **step 5 final validate** (with embedded final AttachmentRef) 双道闸;任一道 fail → 整批 abort,0 journal append,sidecar tmp 清扫
- **1b one append = one bump**:step 6 一次 `write()` 把 N 个 entry 拼接 newline-separated append,total size ≤ `entry_byte_limit_kb`;`spec_version`(for spec_*_added)只 +1
- **1c atomic id range allocation**:**step 3f** 在 preflight 已确认 N 条全合法之后,一次性从 allocator 拿 N 个连续 serial(REQ/SCEN/VIS/T/EV/PEND),allocator state 只在 step 6 journal append 成功后 commit;step 6 失败时 allocator rollback

任一步失败 → 不写盘 + 不动 allocator state + release lock + stderr 给精确路径(`/<index>/<field>` Zod path)。LLM 收到 stderr 后改正即可重发整批。

机器表达:`schemas.ts` §40 `INPUT_SCHEMAS` 5 个 schema 全部为 `z.union([T, z.array(T).nonempty()])` 形态。

**违反方式与诊断**:
- 外部进程直写检测:`loaf hook closure-check`(`Stop` 事件)对比 artifact mtime 与 last `loaf <cmd>` exit time,异常 mtime 告警(不阻塞,记 trace.jsonl)
- Lock 抢占:并发两个 `loaf <cmd>` → 后者 block / 超时 → 报 LOCK_HELD_BY(pid, acquired_at, cmd)
- Stale lock:PID 不存在 → `loaf doctor` 自动清

机器表达见 schemas.ts §34 `CONCURRENCY_INVARIANTS`。

---

## 12. Lessons & Compound

### 12.1 单文件 lessons.md

按 `feature.id + 日期(+ iterations 数)` 分段:
```markdown
## F-001 OAuth refresh · 2026-05-12 (iterations=2)
- ...
```

格式不强校验,只校验「按 feature 分段存在」。**rev 4.2**:`ceremony.lessons_required` 控制:`"must"` 强制 append(原 deep)/ `"may"` 可选(原 standard)/ `"skip"` 跳过(原 quick)。

**rev 4.1 + 5.x:quick / light / standard + lessons 说明**:quick / light / standard 三档均跳过 SETTLE.lessons sub_state(rev 5.x:standard 也砍 SETTLE),但 `loaf lessons add` 命令本身**任意 phase 可调**(append-only,不动 state machine)。user 在 non-deep session 想记教训 → 调 `loaf lessons add` 即可,文件存在 → loaf-skill 可以 stderr **soft suggestion** "已记 lessons.md;考虑下个相似 feature 用 deep profile 进 SETTLE.lessons 强化复利",但**不强制** protocol 升 profile。

### 12.2 v1 不做 promote

`loaf lessons add` 是 v1 唯一的 lessons 命令。以下 **v1 显式不做**(scope discipline,不承诺时间窗;若 v1.x 后期需要可单独 ADR-0004+ 讨论):
- `loaf lessons list --hits N`(跨 run 模式检测)
- `loaf lessons promote <id> --as skill|hook`(自动 scaffold)
- 3-hit token overlap 算法

v1 的核心目标是 protocol 可靠,不是知识复利自动化。手工 grep `.loaf/*/lessons.md` 已 80% 解决跨 feature 模式查阅。

---

## 13. Observability & `--debug`

### 13.1 Artifact authority levels(rev 5.0 四层,canonical 收口至 journal)

按 **gate / blocking decision 是否可读** 分四层。gate 只从 Canonical truth 实时计算(§5 引言);其它三层任何时候都允许 stale。Rev 5.0 重要变化:**Canonical truth 收口至 `journal.jsonl` + `attachments/`**;原 rev 4.1 列在 Canonical 的 `state.json` / `spec.md` / `tasks.json` / `evidence.jsonl` / `findings.jsonl` 全部降为 Derived projection(reducer 从 journal entries 重建,落 `snapshots/*.json` 或 markdown,§4 + Principle 15a)。

| 层 | artifact | 性质 | gate 可读? |
|---|---|---|---|
| **Canonical truth** | `.loaf/<feature>/journal.jsonl` + `.loaf/<feature>/attachments/<entry_id>/**` + `loaf.config.json`(project-level config,非 journal 一部分但同属真理源) | 协议真理源。`journal.jsonl` **append-only**,typed envelope per ADR-0005 §3.2,batch markers + per-entry `entry_schema_version`;`attachments/` per-entry sidecar(sha256 在 entry payload 内 anchor)。由 loaf-cli 单写者纪律 + §11.2 10-step transaction 保护 | ✅ |
| **Derived projection** | `snapshots/state.json` / `snapshots/tasks.json` / `snapshots/evidence.json` / `snapshots/findings.json` / `snapshots/pending.json` / `snapshots/reconcile.json` / `snapshots/gate-diagnostic.json` / `snapshots/resume-pack.json` / `snapshots/_meta.json` / `spec.md`(post-submit) / `lessons.md` / `~/.loaf/registry/<id>.json` / `spec-draft-context.md` | 派生投影,reducer 从 journal entries 重建;**允许 ≤1 mutator 周期 stale**(写者在 lock 内增量更新)。TUI / handoff / diagnostic / read-side CLI 命令消费。Reader 必须走 §10.15 fast check;mismatch → exit 2 `SNAPSHOT_STALE_REBUILD_REQUIRED`(Gate #5,**不静默 fallback**) | ❌ |
| **Debug-trace** | `.loaf/<feature>/trace.jsonl` / `~/.loaf/crashes/<ts>.log` | 仅 `--debug` 写 trace;crash log 永不自动 upload(§10.11)。不是 journal entry,不进 reducer | ❌ |
| **Advisory** | `loaf deliver` 输出 / `loaf status` 人类输出 / `lessons.md` 内容形态 | 自由 markdown / 人类可读建议;格式不强校验(`lessons.md` 文件本身是 Derived projection,但其内容形态 advisory) | ❌ |

**底线规则**(Principle #15 ② + 15a 落地):
- **Gate / blocking decision 永远只读 Canonical truth**(journal.jsonl + attachments/)。Derived projection / Debug-trace / Advisory 三层失败 / 损坏 / stale 都不影响协议正确性 — `loaf doctor --rebuild` 从 seq=0 full replay 重建 `snapshots/*`,`loaf doctor --rebuild-registry` 重写 registry,`loaf settle` 重跑 reconcile。
- **Reader 永不静默 fallback**:`snapshots/_meta.json` fast check fail → CLI exit 2 + 提示 `loaf doctor --rebuild`(ADR-0005 §3.6 + Gate #5)。
- **Sidecar ↔ journal entry 双向一致**:每个 `AttachmentRef` 在 journal 中必有 entry sidecar 在 disk 上存在;每个 sidecar 文件必有 journal entry 指向(orphan-attachment doctor check,§10.15)。

### 13.2 `--debug` 触发

```bash
loaf --debug start "..."     # 本次 session 全程 debug
loaf --debug advance         # 单次 debug
```

或环境变量 `LOAF_DEBUG=1`。

`state.debug=true` 时额外产出:
- `.loaf/<feature>/trace.jsonl`:每次 CLI 调用 + 每次外部命令调用一行
- stderr 增加 verbose 解释(gate 失败时打印完整检查链)
- SessionStart hook 注入更详细的状态摘要

`debug=false`(默认):上述全无,git 不污染。

---

## 14. TUI / Session Manager

### 14.1 核心需求

- 列所有正在跑的 loaf workflow(跨目录、跨 worktree、跨 feature)
- 看到每个 session 的 phase / sub-state / iteration / pending
- 检测「卡在 AskUserQuestion」的 session,显式 `⏸ ask`

### 14.2 Per-session file registry(rev 3.1 Q15 翻牌)

`~/.loaf/registry/<session_id>.json` 每 session 一个文件。

**写**:loaf 每次 mutate state 时,以 atomic temp + rename 重写自己 session 的文件:

```ts
// 不需要 flock,因为 rename(2) POSIX 原子
fs.writeFile(tmp, snapshot, { mode: 0o600 });
fs.rename(tmp, target);
```

**读(TUI)**:`readdir(~/.loaf/registry/)` + parallel reads,latest-per-file mtime 排序。

**GC**:TUI 启动隐式跑,`mtime > 30 天` 的 unlink。

**为什么不用单 jsonl + O_APPEND + flock**:
- 多 feature 写同一文件 = 即使 O_APPEND 原子,compaction 还是要 lock
- 每 session 自己文件 = 跨 feature 零并发,POSIX rename 原子保证一切

```ts
// ~/.loaf/registry/<session_id>.json 一份的内容(整体覆写,不 append):
{
  "schema_version": 2,
  "at": "2026-05-12T10:30:45Z",
  "session_id": "...",
  "session_label": "popposhell · 添加登录方式",     // human display
  "feature": "add-login-methods",                  // rev 4.0 C9': machine ID
  "cwd": "/Users/est9/popposhell",
  "workspace": "default",
  "phase": "VERIFY",
  "sub_state": "VERIFY.visual",
  "iteration": 2,
  "active_tasks": [],
  "pending": null,                                 // rev 4.1: head of state.pending FIFO (or null)
  "pending_queue_depth": 0,                        // rev 4.1: state.pending.length (incl head)
  "ceremony_label": "standard"                     // rev 4.2: cosmetic preset name; ceremony flags live in canonical state.json
}
```

> rev 4.0:`current_task / current_step / current_check` 已砍。新增两个 **derived projection** 字段(由 loaf-cli 在 advance / transition 时写,reader 视为 cache):
> - **`feature: string`**(C9')—— `.loaf/<feature>/` dir basename(machine ID,kebab-case)。RegistryFile path 不含 feature 上下文,TUI 启动单文件读需要;invariant 由 transitions.ts 强制 `feature == basename(dir(对应 state.json))`。**StateJson 不 carry 同字段**(其 path 已 carry feature dir,reader 一行 path.basename derive)
> - **`active_tasks: TaskId[]`**(C4)—— filter `tasks.json.tasks.status="in_progress"`。control phase 时空数组;EXECUTE phase fan-out 多 task 时同时 carry 多个 ID
>
> rev 4.1 pending 队列升级配套,RegistryFile 同改两字段:
> - **`pending: PendingPromptEntry | null`** —— **head 元素**(`state.pending[0]`)OR null。TUI 单文件读就能 render head 的 question / kind / options
> - **`pending_queue_depth: number`** —— `state.pending.length`(含 head)。TUI 用来 render `[×N]` 队列深度徽章

### 14.3 PendingPrompt(协议级「卡住」signal,**rev 4.1 FIFO 队列**)

`state.pending: PendingPromptEntry[]`(default `[]`)。**Head 元素 `pending[0]` 是 active blocker**。

**Protocol 层阻塞规则极简**(rev 4.1 Q3 minimal,见 §10.7):**`loaf advance` 在 head kind ∈ {gate_decision, profile_escalation} 时 exit 2**。其它 35+ 命令 protocol 不做 pending 阻塞 — 是 skill 的 workflow 编排责任(skill 自己 `loaf pending list` 查队列决定 fan-out 调度)。

Resolve 永远 pop head(v1.0 严格 FIFO,无 `--id` 跳序)。队列里的后续 entry 在 head resolve 后自动 promote。

任何 hook / sub-agent / CLI 在调用 `AskUserQuestion` 之前,通过 mutator append 到队列尾(CLI 分配 PEND-id,在 per-session lock 内,见 §11.2 + schemas.ts §34):

```bash
# Append a new pending to the queue tail. CLI allocates pending_id.
loaf pending raise --kind ask_user_question --question "..." [--options "a,b,c"] [--task-id T-N]
# stdout: PEND-0008
```

用户回应 head:
```bash
loaf pending resolve --answer "<answer>"      # pops state.pending[0]
```

5 种 `PendingPromptKind`(与 rev 3.x 一致):
- `ask_user_question`(通用)
- `gate_decision`(human gate 等批准)
- `spec_clarification`(needs_clarification 待答)
- `finding_decision`(finding 等 action)
- `profile_escalation`(auto-escalation 待确认)

#### PendingPromptEntry 字段(rev 4.1)

```ts
{
  pending_id: "PEND-0007",          // CLI-allocated monotonic per feature
  kind: "profile_escalation",       // 5 种之一(上)
  question: "...",                  // ≥3 chars
  options: ["confirm", "decline"],  // optional
  blocks: "advance",                // advance / gate / deliver / all
  raised_at: "2026-05-12T10:18:00Z",// caller 构造时间(可能跟 at 不同 — caller 等 lock 时)
  raised_by: "skill:loaf-cli/sdd-execute",
  raised_by_task_id: "T-005",       // optional — fan-out worker 来源,不绑 task 时省略
  at: "2026-05-12T10:18:01Z",       // CLI 写入队列时间
}
```

#### Fan-out 多 worker raise 场景(v1.0 队列存在的真实理由)

```
T+0.0s  user 启动 sdd-execute,3 个 sub-agent worker 并发跑 EXECUTE.work
T+0.5s  worker A(T-005)发现要改 PublicAPI → loaf pending raise --kind profile_escalation
        队列:[PEND-0007 (head, blocks)]
T+1.2s  worker B(T-012)spec 漏写 hover 态 → loaf pending raise --kind finding_decision
        队列:[PEND-0007 (head, blocks), PEND-0008 (queued)]
T+1.8s  worker C(T-019)需 user clarify auth scope → loaf pending raise --kind spec_clarification
        队列:[PEND-0007 (head, blocks), PEND-0008, PEND-0009]
T+45s   user 看 TUI(`⏸ ask [×3]`)→ loaf pending resolve --answer confirm(回 PEND-0007)
        队列:[PEND-0008 (now head, blocks), PEND-0009]
T+90s   user resolve PEND-0008 → 队列:[PEND-0009 (head, blocks)]
T+150s  user resolve PEND-0009 → 队列:[]
        worker 们继续跑(non-blocking)
```

**关键 invariant**:**worker raise pending 不阻塞其它 worker**(它们继续跑各自的 task,在自己撞 pending 之前)。**Protocol 层 head 只阻塞 `loaf advance`,且仅在 head kind ∈ {`gate_decision`, `profile_escalation`} 时**(rev 4.1 Q3 minimal,见上 L2019);`loaf gate decide` / `loaf evidence add` 等其它 user-facing 命令 protocol 不做 pending 阻塞 — skill 自己 `loaf pending list` 查队列决定 fan-out 调度。这是 rev 4.0 fan-out 设计要的语义,rev 3.x single-valued 做不到。

#### Out-of-order resolve(v1.0 不支持)

v1.0 严格 FIFO:resolve 永远 pop `pending[0]`,不接 `--id` flag。理由:5 种 PendingPromptKind 全部是 yes/no 或 enum 选择,FIFO 不丢信息;跳序的真实 use case 在 v1 没出现,留 v1.x 加 `--id PEND-N`。

如果 user 想"放弃"某个 queued pending:答 head,直到该 entry 自然成为 head 再 resolve(用 `--answer skip` / `decline` 之类按 kind 语义)。

#### `loaf pending list` 输出

```json
{
  "queue_depth": 3,
  "head": {
    "pending_id": "PEND-0007",
    "kind": "profile_escalation",
    "question": "...",
    "blocks": "advance",
    "at": "2026-05-12T10:18:01Z",
    "raised_by_task_id": "T-005"
  },
  "queued": [
    { "pending_id": "PEND-0008", "kind": "finding_decision", "at": "...", "raised_by_task_id": "T-012" },
    { "pending_id": "PEND-0009", "kind": "spec_clarification", "at": "...", "raised_by_task_id": "T-019" }
  ]
}
```

### 14.4 `loaf tui` 界面

```
┌── loaf sessions ─────────────────────────────────────────────────────┐
│ LABEL                       PHASE.SUB           ITER  STATUS        │
│ popposhell · auth refresh   VERIFY.visual       2     ⏸ ask [×3]    │
│ work/auth-feature           EXECUTE.work [×3]   1     ▶ run [×3]    │
│ work/refactor               SETTLE.reconcile    3     ⏸ gate        │
│ sandbox/spike               DONE.archived       1     ✓ done        │
└──────────────────────────────────────────────────────────────────────┘
 [Enter] open · [q] quit · [r] refresh · [d] details · [p] pending · [a] archive
```

**rev 4.1 徽章语义**:
- `STATUS` 列的 `[×N]`(如 `⏸ ask [×3]`)= 队列深度,N ≥ 2 时显示。N=1 时不显示(单 pending 不打扰)。
- `PHASE.SUB` 列的 `[×3]`(如 `EXECUTE.work [×3]`)= worker active set 数量(`registry.active_tasks.length`)。
- `[p] pending` 快捷键展开 head + queued entry detail(读 RegistryFile `pending` + 必要时回 canonical `.loaf/<feature>/state.json` 拉 queued 详情)。

**实现**:**Ink**(React-based,bun 兼容,声明式)。读 `~/.loaf/registry/*.json` 渲染;`⚠ stale` 标(rev 4.1):registry `at` 早于对应 state.json `heartbeat_at` 超过 threshold 时显示。

---

## 15. v1 done-when freeze

**v1.0.0 tag 的硬判据**(对应 `schemas.ts` 的 `V1_DONE_CRITERIA`):

```
1. 跑通 3 个 standard profile feature 全生命周期(TRIAGE → DONE.delivered)
2. 跑通 1 个 deep profile feature 全生命周期
3. 4 次运行期间,不允许:
   - schema_version 升级(rev 5.0 落地后,GA tag 时 SCHEMA_VERSION 必须 = 2;
     此后任何 envelope shape 改动须走 ADR + bump)
   - 新增 phase / sub-state
   - 新增 top-level artifact 类型
   - 新增 hook surface
   - 新增 top-level CLI 子命令(见下方 rev 4.3 rewording)
4. 三件套文档(protocol.md / schemas.ts / protocol.html)与实际 CLI 行为对齐
5. Build-time URLs(rev 4.1):`LOAF_DOCS_URL` / `LOAF_ISSUE_URL` 均已注入非
   placeholder 值;CI release pipeline grep `*.invalid` 与默认 GitHub 路径
   命中即阻断 release(见 §10.11)
6. **v0.0.x → v0.1.0 upcaster end-to-end**(rev 5.0,ADR-0005 §5.2):`loaf doctor
   --migrate-v2` 对 v0.0.x fixture(N-file 形态)完成 Step 1-7 sidecar import,
   journal seq=0 写入 `migration:snapshot_imported` entry,resulting snapshots/
   replay 与 fixture 状态一致;`tests/core/v0.0.x-migration.test.ts` 覆盖 §5.2
   crash table 全部 7 行
7. **Snapshot rebuild perf benchmark**(rev 5.0,ADR-0005 §4.15):10K-entry full
   rebuild + 100K-entry full rebuild 在 release SLA 内完成(具体 SLA 在
   `tests/core/perf.test.ts` Stage 6 实现期 pin,pin 后即 release blocker)
```

**违反任一条 → 版本号回退到 v0.x**。不允许「再 RC 一次」。v1.x 增量在 v1 GA tag 之后开始。

**rev 4.3 freeze 边界 rewording**(ADR-0004 §「为什么 rev 4.3 不是 rev 5」,rewording of ADR-0003 §15;**不**完全 supersede):

> v1.0 GA tag **之后**协议 surface 永久冻结。GA tag **之前**,允许在 **ADR-trail** 下扩展 **CLI 命令** / **const 表** / **error codes**(纯 additive,不删既有 surface),但**不允许**改 `schema_version` / phase / sub_state / hook surface。

理由(详 ADR-0004):rev 4.3 净加 5 个 Tier 1 mutator + 1 个 context 命令组 + 4 个 const 表 + 9 个 error codes,**对任何 rev 4.2 写法行为不变**(不是 breaking change)。与 schema/phase/hook 这种「读旧文件 / 调旧 hook 会出错」的真 breaking 改动不同,additive surface 是设计期合法演进路径;命名为 rev 4.3 而非 rev 5 也是为了保「4.x 是稳定骨架,小数点是 polish」的语义对外信号。

第 3 条「不允许新增 top-level CLI 子命令」按上文 rewording 解读:GA tag 之后冻结,GA tag 之前 ADR-trail 下允许加(rev 4.3 添加的 `loaf spec add-*` / `loaf context pack` 即此路径下落地)。

---

## 16. v1 显式非目标

| Non-goal | 为什么 v1 不做 |
|---|---|
| `loaf lessons promote / list --hits` | 自动知识管理,先用纯 lessons.md |
| **自动 commit / PR / CI(从 `loaf deliver`)** | rev 3.1 锁定:v1 deliver 是 advisory hint,不自动 git/gh |
| orchestrated profile / wave / dispatch / parallel workers | 多 worker 编排成本远大于 solo 场景收益 |
| spec-graph DOT 导出 | 实际查阅频率低 |
| project-charter as MUST gate | 项目级配置已在 `loaf.config.json` constitution 部分 |
| 独立 telemetry 文件(session/dispatch/handoff)| 全 → trace.jsonl,`--debug` 控制 |
| 79+ 独立 gate-test 脚本 | Zod schema + 集中 transitions.ts |
| 自动 risk_tier derivation | LLM 显式声明 task kind + labels |
| Cucumber / Gherkin runner | Gherkin 只是 LLM lint shape |
| Bash PreToolUse hook(每命令 latency)| diff-based guard at `loaf advance` 兜底 |
| 自动 profile 升级无 user confirm | 升级永远要 user `loaf profile escalate --confirm` |
| 自动 profile 降级 | 永远不允许 |
| **vague-word blacklist** | rev 3.1 砍掉;语言风格由 loaf-skill 在 prompt 中处理 |
| ~~**state.json event sourcing**~~ | ~~codex rev 4 提议;v1 state.json 仍是直接写入的真理源~~ — **rev 5.0 退场**:ADR-0005 落地后 state.json 是派生投影,canonical 是 journal.jsonl(γ truth model)。本条非目标终止 |
| **work.json compile step** | codex rev 4 提议;tasks.json 是 spec.md 之外手编,不是编译产物 |
| `loaf pending resolve --id PEND-N` 跳序 | rev 4.1 队列严格 FIFO;5 种 PendingPromptKind 全部 yes/no 或 enum 选择,跳序在 v1 无真实 use case;留 v1.x 补 |

---

## 17. 与 legacy Python 原型的关系

loaf-cli v1 是 **legacy Python 原型** 的 successor,from scratch —— 实现不复用一行旧代码。原型在 early-draft 内部曾被称为 "v2"(rev 3.2 之前文档残留 "v3 是 v2 的 successor" 说法,与 `schemas.ts` 的 `SCHEMA_VERSION=1` + §15-16 直接矛盾,已在 rev 3.2 修正)。

| 维度 | legacy Python 原型(79+ tests) | loaf-cli v1(Bun + TS,Zod 单源) |
|---|---|---|
| **Truth model**(rev 5.0)| N-file mutable artifacts(state/tasks/evidence/findings/pending/spec 各自直写) | **Single typed journal**:`journal.jsonl`(append-only,typed envelope,batch markers)+ `attachments/<entry_id>/` sidecar;`state.json` / `tasks.json` / etc. 全部降为 reducer-derived snapshots(§4 + §13.1 + ADR-0005) |
| Phase | 6(含 DISCOVER + 模糊 DONE) | 6(含 DONE 一等) |
| Sub-state first-class | 否(隐于 prompt) | 是(17,phase 字段双校验) |
| Profile | 5 | 3(+ auto-escalation) |
| Artifact 类型 | ~20+ schemas | 9 per-feature + 1 config + 1 user-level |
| Schema | 33 独立 .schema.json | 1 份 Zod,自动 derive |
| Human gate | 3 | 2 |
| Iteration | 隐式(amend 分散) | first-class state 字段 |
| Findings | 无独立机制 | 独立 artifact + 6 category × 6 action |
| EXECUTE | 顺序 test→impl | task graph + **每 kind 自己的 step**(rev 3.1) |
| VERIFY | 顺序 run/review/E2E | checklist + applicability **3-tier**(rev 3.1) |
| Verifiability | 不强制 | **三选一可验证**(measurable / scenarios / acceptance_na) |
| Evidence ID | 行号 | **EV-000123 稳定 ID**(rev 3.1) |
| Attachments | 仅路径 | **{ path, sha256, mime } 对象**(rev 3.1) |
| Manual / Waiver | 混在一起 | **两个独立 kind**(rev 3.1) |
| Config | 3 个独立文件 | **`loaf.config.json` 合并**(rev 3.1) |
| Registry | 单 jsonl + 锁 | **一 session 一文件 + atomic rename**(rev 3.1) |
| i18n | 无 | **en + zh bundle,LOAF_LANG 切换**(rev 3.1) |
| Observability | 多份 telemetry 强制写 | trace.jsonl 仅 `--debug` |
| TUI | 无 | `loaf tui` + per-session file + pending signal |

**loaf-cli v1 GA 后,legacy Python 原型进 `archive/`**——不接 feature,严重 bug 半年内仍接 patch。

---

## 18. i18n(rev 3.1 新章节)

### 18.1 协议层与展示层分离

```
schemas.ts 里的 enum / ID / 字段名 → 稳定英文 ID,永不本地化
i18n/<lang>.json bundle           → 人类可读 label + diagnostic 模板
TUI / CLI 人类输出                → 通过 bundle 渲染
JSON 输出(`--json`)             → 永远是 stable ID,不走 i18n
```

### 18.2 Bundle 结构

`loaf-cli/i18n/en.json` + `loaf-cli/i18n/zh.json` 同 key 结构:

```json
{
  "evidence_kind": {
    "test-run": "测试运行",
    "manual": "人工验证",
    "waiver": "风险豁免",
    "gate-decision": "Gate 决策",
    ...
  },
  "phase":           { "TRIAGE": "分诊", "SPEC": "规格", ... },
  "task_kind":       { "behavioral": "行为", "structural": "结构", ... },
  "step":            { "red": "红测", "implement": "实现", "mockup": "模拟图", ... },
  "verify_check_kind":{ "run": "运行", "review": "评审", ... },
  "finding_category":{ "spec-gap": "规格缺漏", "risk-escalation": "风险升级", ... },
  "finding_action":  { "amend-spec": "修订规格", "waive": "豁免", ... },
  "gate":            { "spec-lock": "规格锁定", "verify-accept": "验证接收" },
  "applicability":   { "must": "必须", "optional": "可选", "na": "不适用" },
  "diagnostic": {
    "MISSING_VERIFIABILITY": "需求 {req_id} 缺少 measurable、verified_by_scenarios 或 acceptance_na+reason",
    "VAGUE_NO_SCENARIO": "需求 {req_id} 含模糊描述但没有可测度量",
    ...
  },
  "help": {
    "spec_submit": "提交 spec.md,严格按 SpecFrontmatter schema 校验",
    ...
  }
}
```

### 18.3 Lookup 优先级

1. `~/.loaf/i18n/<lang>.local.json`(用户覆盖,可选)
2. `loaf-cli/i18n/<lang>.json`(内置)
3. `loaf-cli/i18n/en.json`(fallback)

**Lang 解析顺序**:`LOAF_LANG` env > `loaf.config.json` `locale.default_lang` > `$LANG` > `"en"`

### 18.4 与 gate-diagnostic.json 的关系

`gate-diagnostic.json` 落 `code` + `vars`,**不**落人类语言。CLI/TUI 渲染时根据当前 lang 查 bundle 的 `diagnostic.<code>`,用 `vars` 填模板。这样 diagnostic 文件可以跨语言团队共享。

### 18.5 与 ERROR_CATALOG 的关系(rev 4.3,ADR-0004 A9)

§10.5 的四段错误输出(`error / context / fix / see`)走 `ERROR_CATALOG`(`schemas.ts` §39):每个 `DiagnosticCode` 对应一条 `ErrorEntry`,英文 `message_template` / `fix_template` / `doc_anchor` 是 canonical 源,bundle `<lang>.json` 的 `diagnostic.<code>` 与 `diagnostic.<code>.fix` / `diagnostic.<code>.see` 三 key 翻译。CLI 在 emit error 时按 `LOAF_LANG`(§10.3)查 bundle → 找不到 key 时 fallback 到 CATALOG 内英文模板 → 用 vars 填占位符。所有 exit 2 user-recoverable 错误统一走这条路径,散在各 throw 处的硬编码字符串归一(rev 4.2 仍有少量散字符串,work item 2 protocol.md §10.5 重写已起序;v1.0 GA 前完成全部迁移)。

---

## 19. 三层架构(rev 3.1 新章节)

### 19.1 三层职责

```text
loaf-cli       (npx 分发的协议内核)
               opinionated SDD,schemas 即契约
               state machine + gate + diff guard + 文件 IO
               不内置 spec-writer / verifier / implementer agent
               
loaf-skill     (1st-cc-plugin 里的 plugin)
               SDD 工作流的具体编排(prompt + LLM 对话 + 软建议)
               接受 3rd-party skill 的产出 → normalize 成严格 schema
               → 调 loaf-cli 严格 submit
               承载"vague word 警告"、"建议跑 review" 这种软建议 UX
               (loaf-cli 协议层不养灰区)

3rd-party      (superpowers brainstorming, openspec, gsd 等)
               领域对话(把模糊想法挖出来)
               产 markdown / JSON,交给 loaf-skill 适配
```

**职责边界明示**(rev 4.3,ADR-0004 A2):**shape enforcement = CLI 责任,workflow content = skill 责任**。Tier 1 mutator 的所有 shape 校验(id 分配 / 三选一可验证 / 6 evidence kind 字段矩阵 / 6×6 finding 合法性 / attachment hash+mime+canonicalization)集中在 loaf-cli;若放 skill,每个 3rd-party workflow skill(Wang / GSD / openspec / 内部 ad-hoc)都要重复实现 `schemas.ts` 子集,且 skill 改文件与 `loaf check` 之间引入 race window。CLI 做一次,所有 skill 共享 — 这是 ADR-0001「shape 在协议,content 在 skill」原则的直接 corollary。

### 19.2 集成契约 = CLI --help + schema --json

外部 skill 集成 loaf-cli 的方式:

```bash
# 1. 读 schema(自描述)
loaf evidence schema --json | jq        # 拿到 JSON Schema
loaf spec submit --help                 # 拿到提交语义说明

# 2. 产 strict 数据后提交(三种路径)
loaf spec submit ./spec.md              # 文件提交(主路径)
cat spec.json | loaf spec submit --json -  # JSON stdin(机器流水线)
loaf spec init && $EDITOR .loaf/<feature>/spec.md && loaf spec submit  # 人入口

# 3. 失败时读 diagnostic 修(rev 5.0:路径在 snapshots/ 下,先走 Gate #5 fast check)
loaf gate decide spec-lock || cat .loaf/<feature>/snapshots/gate-diagnostic.json
```

### 19.3 验证职责分配

| 职责 | 在哪 |
|---|---|
| schema shape validation | loaf-cli(strict at submit) |
| LLM 输出 normalize 成 schema | loaf-skill |
| 多轮对话 / 反向归纳 spec | loaf-skill 或 3rd-party skill |
| 软建议(风格、最佳实践) | loaf-skill 的 prompt(不进协议) |
| gate 实时计算 | loaf-cli |
| diff-guard | loaf-cli |
| TUI 展示 | loaf-cli `loaf tui`(读 ~/.loaf/registry) |
| git / gh 操作 | **不在 loaf-cli;loaf-skill 或用户自己** |

### 19.4 Worktree concurrency

**用户自己负责**。同一 worktree 多 feature 并行 = 源码编辑可能冲突(loaf 隔离 state,但隔离不了 source code 编辑);两个 feature 编辑 unrelated module 则不冲突,**支持并行**(rev 4.1 §10.3 session dispatch precedence 保障)。需要严格隔离用 `git worktree add`,每个 worktree 一份 `.loaf/`,各自有自己的 session_id。

### 19.5 AI assistant client 桥接(rev 4.1 新)

Claude Code / Cursor / Windsurf 等 AI assistant 的 conversation runtime 跟普通 shell 不一样:

| 普通 shell terminal | AI assistant conversation |
|---|---|
| `export FOO=bar` 跨命令持久 | Bash tool 是 **one-shot shell per call**;`export` 不跨 invocation |
| 用户记住 UUID 自己 `export` | AI 模型可能因 conversation compaction 忘掉自己生成的 UUID |
| terminal 跟 process 1:1 | 多个 AI conversation 可能跑在同 cwd(各自独立 session)|

loaf-cli 协议层**不处理** AI 工具的 runtime 特性(否则违反 §1 原则 14 — 协议管 shape 不管 content)。**client 自己 bridge**:

```
~/.loaf/claude-bridge/<claude-conversation-id>.json
{
  "claude_session_id": "abc-123-...",         // Claude Code runtime 提供(SessionStart hook context)
  "loaf_session_uuid": "550e8400-...",        // loaf 这边的 session_id
  "loaf_feature": "auth-refresh",             // human audit
  "cwd": "/Users/est9/popposhell",
  "started_at": "2026-05-12T10:00:00Z",
  "skill_version": "loaf-skill@0.x.x"
}
```

**Skill 职责**:
1. conversation 开头 / `loaf start` 触发时,从 SessionStart hook context 拿 `claude_session_id`;捕获 `loaf start` stdout 最后一行 UUID;写 bridge file
2. 每次调 loaf-cli 之前(无论 compaction 与否),**读 bridge file** → 拿 UUID → 加 `--session <UUID>` flag(或 `export LOAF_SESSION=<UUID>` 前缀同行调用)
3. compaction 后 skill description 让 model 重新走 step 2,bridge file 是 SSoT

**多 Claude Code 同 cwd**:每个 conversation 自己 conversation_id → 自己 bridge file → 自己 loaf UUID,**零冲突**。

**其它 AI assistant**:用各自的 `~/.loaf/<vendor>-bridge/<conv-id>.json`(cursor / windsurf / 自定义)。loaf-cli 协议**不读不写**任何 bridge file — bridge 是 **client 协议约定**,不是 loaf-cli artifact。loaf-cli 只承诺 `--session` flag + `$LOAF_SESSION` env 接口稳定。

**§13.1 artifact authority 分类**:bridge file 归 **Advisory tier**(client-side,可自由演进,不是 protocol artifact)。

---

*v1 draft rev 4.3 · 2026-05-14 · codex audit 2-round + clig.dev audit + pending queue + quick direct-DONE + session dispatch + AI bridge + Profile→Ceremony hybrid (ADR-0003 Addenda 1-6) + moni LLM-friendliness audit + rev 4.3 fix sweep (TaskBase.status `ready` / CoversRef union / pending invariant lockstep / DONE `pending: []` / state.json ceremony example / VerifyCheckKind vs sub_state lane / batch id_namespace wording / i18n DONE diag) · 进 implementation 阶段*
