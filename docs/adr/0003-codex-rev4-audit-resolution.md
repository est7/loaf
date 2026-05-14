# ADR-0003 — rev 4.1:codex rev 4 二轮审计共识落地

- Status: **Accepted**
- Date: 2026-05-12
- Scope: loaf-cli protocol kernel(rev 4.0 → rev 4.1;协议第四次 unfreeze,无 schema_version bump)
- Supersedes: 无(rev 4.0 决策保留;rev 4.1 是 polish + 漏洞补齐,不是 rev 5 重做)
- Related: `schemas.ts` revision history rev 4.1;`protocol.md` §1 / §4 / §5 / §6 / §7 / §8 / §10 / §11 / §13;
  `protocol.html` rev 4.1 changelog + finding action 卡片 + artifact authority 四层;
  ADR-0002(rev 4.0 fresh design)

## Context

rev 4.0 落地后由 codex CLI 跑了两轮深度审计:
- **第一轮**:17 条建议,粒度从架构 flatten(VERIFY 4-state / SPEC 4-state)到字段命名(`pending` → `interaction`)到 correctness 缺口(fan-out 单写者)
- **第二轮**:针对第一轮的反驳,codex 反过来抓住我两个真问题(finding action 表 `(step=X)` 表达污染、SPEC.plan vs EXECUTE.plan 边界没定),并把"prompt UX 当协议骨架理由"识别为 coupling smell

两轮共识:**11 接受 / 6 拒绝**。其中接受的部分按性质分三类:
- **3 条真实 correctness 缺口**:rev 4 开了 sub-agent fan-out(EXECUTE.work 多元 active set)但**没补并发模型**。一旦多个 worker 同时调 `loaf evidence add` / `loaf tasks step done`,会撞:EV-id 冲突 / JSONL 半行 append / `execution.status` 与 evidence 不一致 / registry 投影覆盖新状态。fan-out 上线第一天就会翻车。这一类是协议层硬伤,**不补 v1 无法实施**。
- **2 条真协议缺口**:SPEC.plan(risks/milestones)与 EXECUTE.plan(per-task policy)光看名字两个"plan"无法区分写权限 — loaf-skill prompt 必混;`pending` 缺反向定义防 contributor 当 todo list 用。
- **6 条文档纪律 + 防腐**:Principle #15(promotion / projection / mutation 三纪律)、sub-state promotion rule、finding action 表头重画、RegistryFile best-effort 声明、`EXECUTE.task` → `EXECUTE.work` rename、artifact authority 三层 → 四层。

### 为什么 rev 4.1 不是 rev 5

rev 4.0 是协议骨架重做(worker / control phase 分裂、3 字段砍、VERIFY.check 拆 4);rev 4.1 是**漏洞填补 + 纪律收口**,**不改 schema_version**、**不动 phase 数量**、**不改 sub_state 总数**、**不动 hook surface**、**不加 CLI subcommand**。§15 done-when freeze 未破。

如果命名成 rev 5,会暗示协议又一次结构重做,把演进史变成「3 → 3.1 → 3.2 → 4 → 5」,每次都"接近最优但还不够"——这会让外部接入方失去对协议稳定性的信任。**协议演进必须有节制**。

## Decision · Accepted(11)

每条列:(a) codex 原始建议要点 (b) 落点(protocol.md / schemas.ts 哪节) (c) 收益 > 改动成本的理由。

### A1 · 单写者纪律 + per-session lock(P0,fan-out 上线必修)

codex 第一轮 #8:rev 4 开了 sub-agent fan-out 但没补并发模型。所有 artifact mutation 必须经 loaf-cli 在 `.loaf/<feature>/.lock` 保护下走 atomic transaction(`acquire → read → validate → write tmp → fsync → rename → refresh registry → release`)。

**落点**:
- `protocol.md` §1 原则 #15 ③(三纪律之一)
- `protocol.md` §11.2 新增「Single-writer + per-session lock」整段(锁文件、流程、stale 检测、SIGINT 策略)
- `schemas.ts` §34 `CONCURRENCY_INVARIANTS` 常量(transaction_order / atomic_multi_artifact_commands / sigint_policy 等机器表达)

**为什么必要**:rev 4 设计层引入了 fan-out 但未声明并发模型,impl 阶段必然出现 race / 冲突 / corrupted append-only 文件。**这是协议级 invariant**(任何 binding 实现都必须遵守),不是 impl 阶段的局部细节。

### A2 · `loaf evidence add` 不接受 `--id` flag(P0)

codex 第一轮 #9:EV-id 必须 CLI 单调分配,否则多 agent 并发调用容易撞 ID 或伪造顺序。

**落点**:
- `protocol.md` §10.8 命令表 `loaf evidence add` 行加注:不接受 `--id`,CLI 单调分配并 stdout 回打;支持 `--external-ref <id>` 留调用方 correlation
- `schemas.ts` §15 新增 `EvidenceAddInput` 类型(从 `EvidenceEntry` omit `evidence_id` + `at`,加 optional `external_ref`)
- `schemas.ts` `EvidenceEntry` 加 `external_ref: z.string().optional()` 字段

**为什么必要**:EV-id 是 evidence.jsonl 的稳定 ID(Q7),覆盖所有 cross-ref。允许调用方传入会破坏 monotonic 顺序保证。

### A3 · `tasks step done` 单 transaction + `TASK_STATUS_WITHOUT_PROOF`(P0)

codex 第一轮 #10:`execution.status` 是 cache,evidence.jsonl 是真理源,但 rev 3.1 没说冲突谁赢。补:evidence 赢;`loaf tasks check` 发现 status 无 evidence 时报 `TASK_STATUS_WITHOUT_PROOF`,status 必须回滚。同时 `tasks step done` 必须在一个 transaction 内同时改 status + 写 evidence。

**落点**:
- `protocol.md` §10.8 `loaf tasks step done` 行 + `loaf evidence add` 周边加注:单 transaction;`TASK_STATUS_WITHOUT_PROOF` diagnostic code
- `schemas.ts` §34 `CONCURRENCY_INVARIANTS.atomic_multi_artifact_commands` 列出 `loaf tasks step done` 的双 artifact 写约束
- `schemas.ts` 既有 §31「tasks.json execution status — cache」注释配合

**为什么必要**:rev 3.1 留的 cache 语义在 fan-out 下会失效——worker A 改 status 但 worker B 写 evidence 的中间窗口,reader 看到 status=passed 但没 proof,gate 计算结果不稳定。

### A4 · `SPEC.plan` vs `EXECUTE.plan` mutation rights matrix(协议缺口)

codex 第二轮针对我反驳保留 SPEC 4-state 的追问:两个"plan"名字相同,写权限边界没定,后面 skill prompt 必混。

**落点**:
- `protocol.md` §8.6 新增 mutation rights matrix(SPEC.plan / SPEC.design / EXECUTE.plan / EXECUTE.work 四行,每行列「可写 artifact / 字段」「不可写」「典型 mutation」)
- `schemas.ts` §26 `SubStateContract` 加 optional `mutation_rights: MutationRights` 字段;4 个 critical sub_state 填 `writable_fields[]` + `forbidden_fields[]`
- `schemas.ts` 新增 `MutationRights` schema(writable_fields / forbidden_fields,支持 JSONPath glob)

**为什么必要**:`SPEC.plan` 与 `SPEC.design` 都 write spec.md,但前者只能改 body Plan 段、后者还能创建 tasks.json;`EXECUTE.plan` 与 `EXECUTE.work` 都 write tasks.json,但前者只能 derive `execution.applicability` 不能改 `task.drives`。这种字段级粒度 write_paths glob 表达不出,**必须显式声明**。

### A5 · `pending` 反向定义(协议缺口 + 防误用)

codex 第二轮:`pending` 语义必须写死为 single blocking interaction,加反向定义防 contributor 当 todo list 用。

**落点**:
- `protocol.md` §4.1 state.json invariant 列表加一条:**pending 不是** unfinished work 集合 / queue / derived obligation list

**为什么必要**:contributor 看到 `pending: null` 很容易当成 "pending tasks queue" 误用。反向定义是协议层防呆。

### A6 · §1 Principle #15(promotion / projection / mutation 三纪律)

codex 第二轮抓住我"prompt UX 当协议骨架理由"是 coupling smell。提议把判据写成硬纪律:protocol state 只有改变机器行为才能 promote;derived projection 永远不是 gate authority;所有 mutation 经 loaf-cli + lock。

**落点**:
- `protocol.md` §1 设计原则表加 Principle #15(三纪律分别落地到 §7.0 / §4.12 / §11.2)

**为什么必要**:这条原则挡住未来 80% 关于"要不要再加 sub_state / 字段 / 写者"的争论。判据写硬后,审议成本下降一档。

### A7 · §7.0 Sub-state promotion rule + 当前 4 VERIFY lane 反向 audit

codex 第二轮:不撤回 VERIFY 4-state,但必须写清楚 promotion rule。一个 verification concern 必须改变以下至少 2 项才能 promote 成 first-class sub_state:CLI mutation 集合 / write_paths / evidence shape / interaction mode / recovery / TUI semantics / diagnostic class。仅 prompt 文案更精确不够。

**落点**:
- `protocol.md` §7.0 新章节(rule + 反向 audit 表)

**为什么必要**:rule 把"为什么 4 个 VERIFY lane 合法"的判据写进协议;未来加 `VERIFY.security` / `VERIFY.perf` / `VERIFY.a11y` 时必须在反向 audit 表填一行,论证它钩中 ≥2 项。否则归 evidence kind 扩展,不开 sub_state。

### A8 · §6.2 finding action 表加 `target payload` 列(内部不一致 fix)

codex 第二轮抓我 rev 4.0 protocol.md 写的 `EXECUTE.task(step=implement)`:rev 4 已经砍 `current_step`,这种写法把已砍字段视觉上塞回去,protocol 内部不一致。正确表达:`state transition → EXECUTE.work`,`step` 是 `FindingResolutionPayload`,写入 `tasks.<T-N>.execution.<step>.status="pending"` 让 step 重跑。

**落点**:
- `protocol.md` §6.2 表头重画(加 `target payload` 列;`fix-impl` / `fix-test` / `amend-tasks` payload 字段填充)
- `schemas.ts` §25 `FindingActionEffect` 加 `requires_target_payload: enum("task_id_step" | "task_id_optional" | "none")` 字段;新增 `FindingResolutionPayload` schema(`{ task_id, step }`)
- `protocol.html` §6.2 finding action 卡片可视化(6 个 action 卡片,显示 transition / payload / iter delta / spec-locked 影响)

**为什么必要**:rev 4 的 schema 与 prose 不一致是真 bug;不修会让 contributor 误以为 `current_step` 还在。

### A9 · RegistryFile = best-effort projection(语义修正)

codex 第二轮:rev 4 我前一轮说"不存在投影落后"过度。atomic rewrite 只保证单文件不撕,跨文件 transaction 在 crash window(`tasks.json` 写完 → `state.json` 写完 → crash 在 registry rewrite 之前)可以让 registry 落后。

**落点**:
- `protocol.md` §4.12 RegistryFile 章节末尾加 best-effort projection 段:允许 stale / TUI 容忍 / `loaf doctor --rebuild-registry` 重建 / gate 永远不读 registry
- `protocol.md` §5 Gate 章节首段:gate 只从 canonical truth 实时计算
- `protocol.md` §13.1 重画为四层(Canonical truth / Derived projection / Debug-trace / Advisory),并在 Derived projection 注明 gate 不可读
- `schemas.ts` §13 `RegistryFile` doc comment 加 best-effort projection 段

**为什么必要**:不修这条,impl 阶段可能有人写 gate 路径读 registry 做"快速判断",违反 single-writer 与 canonical 纪律。**显式声明是协议防呆**。

### A10 · `EXECUTE.task` → `EXECUTE.work` rename

codex 第一轮 #3:rev 4 已经把 worker active set 改成"由 tasks.json 派生的多元素集合"。`EXECUTE.task` 单数命名跟 fan-out 现实拧着。

**落点**:
- `schemas.ts` `SubState` enum(line 283);`FINDING_ACTION_EFFECTS` 表 3 处(amend-tasks / fix-impl / fix-test);`SUB_STATE_CONTRACTS` 表多处(entry / exit / next array)
- `protocol.md` 全文 replace_all(8 处);§2 sub-state 清单 + ascii 图;§6.2 finding action 表;§8.1 三 sub-state 列表;§14.4 TUI mockup
- `protocol.html` 全文 replace_all(11 处);SVG 状态机 box 文本

**为什么必要**:命名与现实一致降低 contributor 认知负担。fan-out 多元 ≠ 单数 `.task`。

### A11 · §13.1 三层 → 四层 artifact authority

codex 第一轮 #15:rev 4 §13.1 三层(Stable Core / Closure / Observability)分类粒度不够;codex 提议四层(canonical truth / derived projection / debug-trace / advisory),核心区分是 gate 是否可读。

**落点**:
- `protocol.md` §13.1 表头重画为四层 + 底线规则"gate 只读 canonical truth"
- `protocol.html` 新增四层可视化(grid 布局,canonical truth 高亮绿框,其它三层灰框 + `❌ gate 不读` 标记)

**为什么必要**:与 A9(RegistryFile best-effort)配套。三层时 reconcile.json 在 Closure 层语义模糊,四层后归 Derived projection 一目了然。

## Decision · Rejected(6)

每条列:(a) codex 原始建议 (b) 拒绝的具体技术理由(不是审美判断)。

### R1 · VERIFY 4-state flatten 到 `collect/decide`(codex 第二轮 #2)

**拒绝**。promotion rule(A7)证明现有 4 lane 各自合法(每 lane 钩中 ≥2 项机器行为差异)。flatten 会:
- 丢失 prompt_inject 精度(SessionStart hook 注入"现在该做 visual check"比"现在该 collect,4 个 obligation 自己看 applicability"更可用)
- 把已做完的 C8 决策(rev 4.0 拆 4)再压回去,锯齿协议演进
- 未来加 security/perf/a11y 时,promotion rule 允许评估是否新加 sub_state,不会被卡

剩余风险:`VERIFY.*` 的 evidence shape / write_paths 必须 lane-specific,否则 promotion rule 就没意义。schemas.ts `SUB_STATE_CONTRACTS` 4 个 lane 已经 lane-specific,过门。

### R2 · SPEC 4-state flatten 到 `draft/design/lock`(codex 第一轮 #4)

**拒绝**。flatten 丢失 `amend-spec` finding action 的 back-edge 精度——current 表 `amend-spec → SPEC.spec`,flatten 后只能 `→ SPEC.draft`,LLM prompt 没法精确定位"该回到 EARS 阶段而不是 proposal 阶段"。

`proposal` 与 `spec` 是两种不同产出形态(why/scope/anti-scope vs EARS/Gherkin/Visual),prompt 完全不同;`plan` 与 `design` 拆开让 risks/milestones 与 task generation 分两步,便于 finding 定位回退点。

A4(mutation rights matrix)已经把 SPEC.plan vs SPEC.design 的写权限钉牢,flatten 的好处(命名"对称")不抵消失去回退精度的代价。

### R3 · `pending` → `interaction` / `blocking_prompt` 改名(codex 第二轮 #6)

**拒绝**。纯命名 bikeshed。`pending` + 「single-valued blocking」语义在 §4.1 / §14.3 已经清楚;A5 反向定义进一步收口。换名字带文档 churn(protocol.md / schemas.ts / protocol.html / TUI 字符串 / i18n bundle 全要刷),零行为收益。

### R4 · finding action 合并成 `redo-work`(codex 第一轮 #11)

**拒绝**。codex 想把 `fix-impl` / `fix-test` 合并成 `redo-work`,payload 带 `target.step`。

理由不成立:`fix-impl` / `fix-test` 在 §6.2 表里直接对应**不同 state machine transitions**(EXECUTE.work + payload `step=implement` vs `step=red`)。合并成 `redo-work` 后,state machine 仍然要根据 payload 分支,只是把判断从 action enum 移到 payload field。**增加一层间接,没简化任何东西**。

更重要:`fix-impl` / `fix-test` 的**默认 LLM prompt 不同**——前者集中在"实现没满足 spec",后者集中在"测试本身错"。诊断模板(`i18n/<lang>.json` 的 `diagnostic.<code>`)也分别有针对性消息。合并会丢掉这层语义。

### R5 · RegistryFile 加 `source.{state_version, tasks_version, spec_version, evidence_last_id}` 4 字段(codex 第二轮 #7)

**拒绝**(YAGNI)。codex 建议加 4 个 version anchor 字段用于 TUI 检测 stale。

实际情况:
- registry 每次 mutate 都 atomic rewrite(§4.12)+ `at` 时间戳
- A9 已经声明 best-effort projection + `loaf doctor --rebuild-registry` 重建
- `heartbeat_at` 在 state.json,TUI 用它就能判断 session 死活
- 加 4 个 derived 字段每 session 持久化只为防一个理论 race,YAGNI

如果未来真出现 stale 误判频繁发生,再加。**v1 不预先加**。

### R6 · `loaf check tasks` canonical/alias 关系(codex 第二轮 #14)

**拒绝**(codex 误读 rev 4)。rev 4.0 §10.8 已经只保留 `loaf tasks check`,删了 `loaf check tasks`。`loaf check <path>` 是另一个完全不同的命令:接 path 参数,做单文件 schema 校验(CI 用),不接 "tasks" 这种 enum keyword。

所以不存在双入口,不需要 canonical/alias 关系。protocol.md §10.8 加一行 did-you-mean 兜底说明就够(用户敲 `loaf check tasks` 时提示用 `loaf tasks check`)。

## Open future hooks

rev 4.1 给未来 v1.x 演进留的入口:
- **Promotion rule(A7)**:未来加 `VERIFY.security` / `VERIFY.perf` / `VERIFY.a11y` 时必须在 §7.0.1 反向 audit 表填一行,论证它钩中哪 ≥2 项 protocol 行为。否则归 evidence kind 扩展,不开 sub_state。
- **Mutation rights matrix(A4)**:未来新增 sub_state 时,`SubStateContract.mutation_rights` 字段强制每个新 entry 声明写权限。default(undefined)仅当 `write_paths` 已经足够区分时允许。
- **CONCURRENCY_INVARIANTS(A1)**:未来新增 `loaf <cmd>` mutator 必须在 `atomic_multi_artifact_commands` 列表声明它跨哪些 artifact 的 atomic 写,impl 测试覆盖此 invariant。
- **Best-effort projection 四层(A11)**:未来新增 artifact 时必须显式归入四层之一(Canonical truth / Derived projection / Debug-trace / Advisory);新增 canonical truth artifact 触发 §15 done-when freeze breach,需 v2 schema bump。

## Addendum · CLI design audit follow-up(rev 4.1,同日)

ADR-0003 主决议落地后,跑了一轮独立的 clig.dev audit(`/cli-design:cli-design` skill 走 24-section checklist),又收到 1 Major + 5 Minor + 4 Nit。本节记录 follow-up 决策,全部已在 rev 4.1 内合并(不再 bump rev)。

### Accepted(audit follow-up · 5 项)

| # | clig.dev § | 落点 | 备注 |
|---|---|---|---|
| F1 | §6 Args/Flags | `protocol.md` §10.7 加 `--dry-run` / `-n` global flag + §10.7 dry-run 契约表;`schemas.ts` §34 加 `dry_run_transaction_order` + `dry_run_rejects_read_only` | **v1.0**,理由:rev 4.1 §11.2 fan-out 模型上线后,worker 并发 claim 前 pre-check "会不会过 gate / 抢 lock" 是真实场景;CI pre-merge 也要这个能力。`--dry-run` 不是新 subcommand,§15 freeze 第 3 条不阻挡 |
| F2 | §2 Help + §5 Errors | `protocol.md` §10.1 + §10.5 + §10.11 + §15:build-time URL stamping(`LOAF_DOCS_URL` / `LOAF_ISSUE_URL`)| placeholder URL 在 `loaf --version` 时 stderr 警告;CI release pipeline grep `*.invalid` 与默认 GitHub 路径 命中阻断 |
| F3 | §5 Errors | 新加 `protocol.md` §10.15 `loaf doctor` 诊断清单(9 check + `--fix` / `--rebuild-registry` / `--json`)| `loaf doctor` 在 §4.12 / §10.4 / §10.5 / §11.2 多处被引用但责任面散乱,本节集中表达 |
| F4 | §13 Env vars | `protocol.md` §10.2 + §10.3 加 `FORCE_COLOR`(CI pipe 仍要彩色 log)+ `DEBUG`(等价 `LOAF_DEBUG`)respect | clig.dev §13 通用 env 列表收口;`--no-color` / `LOAF_DEBUG` 仍 win |
| F5 | §8 Subcommands + 微改 | `protocol.md` §10.6 chaos list 补 `loaf settle`;§10.8 `loaf tasks <op>` 一行展开为 6 行(add / claim / done / register-red / amend / submit);§10.0 自夸 microcopy 修剪 | naming / 表达一致性 |

### Open Question 收口

audit 报告的 Open Question:"`--dry-run` v1.0 还是 v1.1?"

**决策:v1.0**。

理由:
1. fan-out(EXECUTE.work 多 worker)是 v1.0 critical path(rev 4.0 C1 α + rev 4.1 §11.2);worker pre-check 是 fan-out 实际使用场景的必备能力,不是 nice-to-have
2. `--dry-run` 是 global flag,**不是新 subcommand**——§15 done-when 第 3 条只禁新 phase / sub-state / artifact / hook / **subcommand**,global flag 不在禁止列表
3. dry-run 的 transaction order(`schemas.ts` §34 `dry_run_transaction_order`)与 live transaction 共享 step 1-5,实现成本低于"额外加一个 read-only 子命令"
4. 推迟到 v1.1 会让 v1.0 fan-out 实施变成"硬撞 + 回滚"风格——不符合 §1 Principle #15 的「protocol-level deterministic 保证」纪律

## Addendum 2 · 多 pending 队列升级 v1.0(rev 4.1 内合并)

原 §16 non-goal "多 pending 队列 — v1 single-valued;v1.1 再考虑" 在 fan-out 设计落地后暴露语义冲突:rev 4.0 引入的 `EXECUTE.work` worker fan-out 允许多 sub-agent 并发执行,但单值 pending 强制 serialize 阻塞 — 一个 worker 撞 `profile_escalation` 就把全部 worker 卡住直到 user 响应。这违背 fan-out 设计意图,把单值 pending 留到 v1.1 就是把 fan-out 也变成不可用。

### Decision

升级到 v1.0,**rev 4.1 内合并**。

**Schema 改动**:
- `StateJson.pending: PendingPrompt | null` → `PendingPromptEntry[]`(default `[]`)
- 新 `PendingId` type(`/^PEND-\d{4,}$/`)
- 新 `PendingPromptEntry` schema:`PendingPrompt.extend({ pending_id, at, raised_by_task_id? })`
- `RegistryFile.pending: PendingPrompt | null` → `PendingPromptEntry | null`(投影 = head),新加 `pending_queue_depth: number`(投影 = `state.pending.length`)
- DONE.* 终态 invariant:`pending.length === 0`(原 `pending === null` 等价改写)
- schemas.ts §34 `CONCURRENCY_INVARIANTS` 加 `pending_id_allocation` + `pending_fifo_discipline` + 两条 atomic mutation(`pending raise` / `pending resolve`)

**语义**:
- FIFO 严格 — `pending[0]` 是 active blocker;resolve 永远 pop head,**v1.0 不支持 `--id PEND-N` 跳序**
- Head blocks user-facing 命令(`loaf advance` / `loaf gate decide` / `loaf evidence add` 等);**不阻塞 worker**(它们继续跑自己的 task 直到自己撞 pending)
- 队列非空时(`pending.length > 0`),只允许 `loaf pending list / status / resolve`,其它命令 exit 2
- 5 种 PendingPromptKind 与 rev 3.x 一致

**CLI surface**:
- 新加 `loaf pending list`(列全部 entry,head 标 `*`)
- 新加 `loaf pending status [--id PEND-N]`(只读,default = head)
- `loaf pending resolve` 行为更新:resolves head;**不接受 `--id`**;`--no-input` 时必须 `--answer` flag

**TUI**:`STATUS` 列 `⏸ ask [×N]` 徽章 = 队列深度(N ≥ 2 时显示);`[p] pending` 快捷键展开 head + queued detail。

### 不破 §15 freeze

- ✓ `schema_version` 仍 1。`pending` 字段类型变化(`T | null` → `T[]`)在 v1 unfrozen 期间 acceptable —— Hyrum's Law 暴露 = 0(v1 还未 implement),与 rev 4.0 砍 `current_task/current_step/current_check` 3 字段策略一致
- ✓ `PendingPromptEntry` 是 `PendingPrompt.extend()` 包装,**不是新 artifact**(仍是 PendingPrompt 同一族 schema)
- ✓ `loaf pending list / status` 是 **nested verb**(`pending` 已是 v1 top-level subcommand),不是新 top-level subcommand;§15 freeze 第 3 条不阻挡

### 推迟到 v1.x 的(新 non-goal)

- `loaf pending resolve --id PEND-N` 跳序:5 种 PendingPromptKind 全部 yes/no 或 enum 选择,FIFO 不丢信息;跳序的 use case 在 v1 没有真实场景。留 v1.x 加(那才是真"v1.1 再考虑")。已写进 §16 非目标表。

### 副带:v1.1 措辞统一清理

借这次 rev 4.1 同步清理协议正文里所有 "v1.1" 模糊承诺:
- §10.14 `loaf deliver` "v1.1 推迟" 自动 commit/PR/CI → 改为 **永久 non-goal**(rev 3.1 已 lock 为 advisory only,见 §16)
- §12.2 `loaf lessons promote/list --hits` "推迟到 v1.1" → 改为 **v1 显式不做**(scope discipline,不承诺时间窗;若 v1.x 后期需要可单独 ADR-0004+ 讨论)
- §14.3 + §16 "多 pending 队列 v1.1 再考虑" → 删(已升级 v1.0)
- ADR-0003 Open Question 段保留 "v1.1" 字样 — 它是历史决策记录(讨论 `--dry-run` v1.0 vs v1.1 的 reasoning),不是 deferred 功能承诺

清理后,grep `v1\.1` 在整个 design tree 只剩 ADR-0003 Open Question 段一处历史 reasoning。

## Addendum 3 · quick profile 跳过 SETTLE 直跳 DONE(rev 4.1 内合并)

原 quick 流程 `TRIAGE → EXECUTE → SETTLE → DONE` 里 SETTLE 是**纯仪式**:
- `reconcile.json` 是 `standard+`,quick 不产
- `lessons.md` 是 `deep MUST / std MAY / quick skip`,quick 不写
- 所以 quick 走 SETTLE.reconcile + SETTLE.lessons 两个 sub-state 都是 no-op pass-through

实际场景:典型 quick task 是"button → 16.dp"这种单文件改动 — 改值 → `./gradlew build` → 一次 evidence → done。强制走 SETTLE 让用户多敲 2 个 `loaf advance`,纯仪式无实质产出。

### Decision

quick 完全跳过 SETTLE。`loaf deliver` 从 `EXECUTE.done` 直接转 `DONE.delivered`;verify-min 边界从 "EXECUTE.done → SETTLE.reconcile" 迁移到 "EXECUTE.done → DONE.delivered"(即 `loaf deliver` 入口)。

**Schema 改动**:
- `PROFILE_POLICIES.quick.phases_run`:`["TRIAGE","EXECUTE","SETTLE","DONE"]` → `["TRIAGE","EXECUTE","DONE"]`
- `SUB_STATE_CONTRACTS.EXECUTE.done.next`:`["VERIFY.plan", "SETTLE.reconcile"]` → `["VERIFY.plan", "DONE.delivered"]`(quick 走第二条)
- `SUB_STATE_CONTRACTS.SETTLE.{reconcile,lessons}.entry`:去掉 quick 分支,标 "standard / deep only"

**CLI 行为**:
- `loaf deliver` 现在有**两个**合法 source sub-state:
  - quick 非 spike:从 `EXECUTE.done` 调用 → verify-min(若任一 task 是 spike → hard block;若 task 触代码 → 必须 build/test evidence ≥1;…)→ 通过则 `DONE.delivered`
  - standard / deep:从 `SETTLE.lessons` 调用(VERIFY.* 已经走完,reconcile.json 已产)→ `DONE.delivered`
- `loaf advance` 从 quick 的 `EXECUTE.done` 不再前进(没有下一步 advance target;stderr 提示"run `loaf deliver` to terminate")

**Spike 不在本路径**:任何 profile + spike → `loaf deliver` hard block;用户显式走 §8.3 三出口(`loaf archive` / `loaf spike convert` / `loaf abandon`)。

### 不破 §15 freeze

- ✓ schema_version 仍 1。`phases_run` 是 array 内容变化,不是新字段
- ✓ 无新 sub-state(`DONE.delivered` 早就存在)
- ✓ 无新 top-level CLI subcommand(`loaf deliver` 早就存在,只是 source state 集合从单 → 双)
- ✓ 无新 hook surface
- ✓ 实际上简化了协议:quick 路径从 4 phase → 3 phase

### 典型 use case 对照

**改动前(rev 4.0 quick non-spike)**:
```
loaf start "button to 16.dp"     → TRIAGE.score → TRIAGE.confirm (profile=quick)
loaf advance                     → EXECUTE.plan
loaf advance                     → EXECUTE.work
# 改 dp,跑 build
loaf evidence add --kind local-check ...
loaf advance                     → EXECUTE.done (all tasks done)
loaf advance                     → SETTLE.reconcile (no-op, 走个过场)
loaf advance                     → SETTLE.lessons (no-op)
loaf deliver                     → DONE.delivered
# 总命令数:9(advance × 5)
```

**改动后(rev 4.1 quick non-spike)**:
```
loaf start "button to 16.dp"     → TRIAGE.score → TRIAGE.confirm (profile=quick)
loaf advance                     → EXECUTE.plan
loaf advance                     → EXECUTE.work
# 改 dp,跑 build
loaf evidence add --kind local-check ...
loaf advance                     → EXECUTE.done (all tasks done)
loaf deliver                     → verify-min ok → DONE.delivered
# 总命令数:7(advance × 3)
```

省 2 个 advance 调用(SETTLE 两个 sub-state)。

### v1.0 还是 v1.x?

**v1.0**(本 rev 4.1)。理由:
- 不破 §15 freeze(见上)
- impl 阶段才落地,Hyrum's Law 暴露 = 0
- 推迟到 v1.1 会让 v1.0 quick 路径长期保持"走过场"状态,反而是技术债

### 副带:`loaf advance` 语义校准

`loaf advance` 从 quick 的 `EXECUTE.done` 不自动跳 DONE.delivered —— DONE 是 user-explicit 转移(`loaf deliver` 才打 advisory 提示 + state 切换)。`advance` 的行为是**stderr 提示"run `loaf deliver` to terminate"** + exit 0(不报错,但也不前进)。这点跟 standard/deep 的 `SETTLE.lessons → DONE.*` 转移一致(那里也是 `loaf deliver` / `archive` / `abandon` 用户显式动作)。

## Addendum 4 · Session dispatch + AI client bridge(rev 4.1 内合并)

### 起因 / 问题

rev 4.0 / rev 4.1 之前的协议只在 `loaf start <desc> [--feature <name>]` 提了 feature 名,**其它 38 个命令都没说怎么定位 feature**。一个 cwd 多 active feature 时,CLI 不知道操作哪个 session。

讨论中识别出三层真实场景:
1. **普通 shell user 单 feature**(90% case):cwd 只一个 feature,auto-pick 解决
2. **普通 shell user 多 feature 并行**(unrelated module 在同 repo):双 terminal 各自处理一个 feature,各自 `export LOAF_SESSION=<UUID>` 隔离
3. **AI assistant(Claude Code / Cursor / Windsurf)**:Bash tool 是 one-shot shell per call(`export` 不持久);conversation compaction 可能让 model 忘掉自己生成的 UUID — 此时光靠 shell ENV 不够

### 否决方案

- **`.loaf/.active` pointer 文件**:race trap(双 terminal 同 cwd 各自 `loaf start` 会互相覆盖 `.active`)
- **1-active-per-cwd 硬约束**(`loaf start` 拒绝在已有 non-DONE feature 的 cwd 起新 session):太严,违反用户对 "unrelated module 同 cwd 并行" 的合法 use case

### Decision

**三层协议**:

#### 层 1 — loaf-cli 协议层(简单 + 通用)

dispatch precedence(high → low):
```
1. --session <UUID> flag        (单次最高;校验 SESSION_CWD_MISMATCH)
2. --feature <name> flag        (cwd-local alias)
3. $LOAF_SESSION env            (per-shell-session sticky,无 race)
4. $LOAF_FEATURE env            (同上,human-readable)
5. Auto-pick cwd's .loaf/*:
   - 0 non-DONE → FEATURE_NOT_FOUND exit 2
   - 1 non-DONE → use it + stderr「auto-picked 'X'」
   - 2+ non-DONE → FEATURE_AMBIGUOUS exit 2 + 候选 + did-you-mean
```

短 UUID prefix(≥8 字符)接受 — 同 git short-hash 纪律;`SESSION_SHORT_AMBIGUOUS` 时 exit 2 要求完整 UUID。

`loaf start` stdout **最后一行**打印新 session 的 UUID(可预测,shell scripting `UUID=$(loaf start ... | tail -1)`)。

`loaf sessions list --in-cwd`(新 flag)— terminal 重启后拾回 UUID。

**无 `.loaf/.active`,无 `loaf use`,无新 top-level subcommand**。

#### 层 2 — shell user 工作流(无需额外文档,业界标准模式)

跟 kubectl `$KUBECONFIG` / AWS CLI `$AWS_PROFILE` 一致:
```bash
# Terminal 1:auth refresh
cd ~/popposhell && loaf start "auth refresh"      # stdout UUID-AUTH
export LOAF_SESSION=<UUID-AUTH>
loaf advance && loaf evidence add ...             # 走 ENV,操作 .loaf/auth-refresh/

# Terminal 2(同 cwd 并发,不需要 worktree):payment flow
cd ~/popposhell && loaf start "payment flow"      # stdout UUID-PAYMENT
export LOAF_SESSION=<UUID-PAYMENT>
loaf advance ...                                  # 走自己 ENV,操作 .loaf/payment-flow/
# 各 ENV process-scope 隔离,零 race
```

#### 层 3 — AI assistant client bridge(rev 4.1 新加,§19.5)

Claude Code 等 AI assistant 的 Bash tool 是 **one-shot shell per call**,`export` 不跨 invocation,compaction 可能丢 UUID。**client 自己 bridge**:

```
~/.loaf/claude-bridge/<claude-conversation-id>.json
{
  "claude_session_id": "abc-123-...",       // Claude Code SessionStart hook context 提供
  "loaf_session_uuid": "550e8400-...",      // loaf 这边的 session_id
  "loaf_feature": "auth-refresh",
  "cwd": "/Users/est9/popposhell",
  "started_at": "2026-05-12T10:00:00Z",
  "skill_version": "loaf-skill@0.x.x"
}
```

Skill 职责:
1. SessionStart hook 拿 `claude_session_id` + 捕获 `loaf start` stdout UUID → 写 bridge file
2. 每次调 loaf-cli 之前 **读 bridge file** → 拿 UUID → 加 `--session <UUID>` flag
3. compaction 后 model 重走 step 2(bridge file = SSoT,不在 conversation context)

多 Claude Code 同 cwd:每 conversation 自己 conv_id → 自己 bridge file → 自己 loaf UUID,**零冲突**。

bridge 路径 `~/.loaf/<vendor>-bridge/`(`claude-bridge` / `cursor-bridge` / `windsurf-bridge` / 自定义)是 **client 协议约定**,**不是 loaf-cli artifact**(loaf-cli 不读不写)。归 §13.1 **Advisory tier**,client 自由演进。

### 影响的 protocol surface

- §4 artifact 树:**不加** `.loaf/.active`(零文件 race);**注**:`~/.loaf/claude-bridge/` 是 client 私有,不是 loaf-cli artifact
- §10.3 env 表:加 `LOAF_SESSION` + `LOAF_FEATURE` 两行 + dispatch precedence 小段
- §10.5 error 表:加 `FEATURE_AMBIGUOUS` / `FEATURE_NOT_FOUND` / `SESSION_CWD_MISMATCH` / `SESSION_SHORT_AMBIGUOUS` 4 个 diagnostic code
- §10.7 global flag:加 `--session <UUID>` + `--feature <name>` 两行
- §10.8 命令表:`loaf start` 行加 stdout UUID 注释;`loaf sessions list` 行加 `[--in-cwd]` flag
- §19 加 §19.5「AI assistant client 桥接」整段
- §19.4 worktree concurrency 段从 advisory("用户自己负责")补成 "支持并行,源码冲突自己保证;严格隔离用 worktree"

### 不破 §15 freeze

- ✓ 无新 top-level CLI 子命令(`sessions list` 加 flag 不算新)
- ✓ 无新 artifact(bridge file 不是 loaf-cli artifact)
- ✓ 无新 hook / phase / sub-state
- ✓ schema_version 仍 1

### 推迟到 v1.x 的(新 non-goal)

- `loaf use <feature|UUID>` 持久化命令:本 rev 否决,因 `.active` race trap;ENV/flag 已满足 80% use case。若 v1.x 后出现"我希望 cwd 默认指针"的真实需求,再 ADR 讨论
- Cross-vendor bridge schema 统一(`~/.loaf/bridge/` instead of `<vendor>-bridge/`):v1.x 看哪些 vendor 实际接入,再决定要不要 RFC

## Addendum 5 · Pending 阻塞 protocol vs skill 边界(rev 4.1 Q3 决策)

### 起因

rev 4.1 多 pending FIFO 队列升级后,§10.7 / §14.3 两处描述冲突:
- §10.7 写「pending.length > 0 时只允许 pending 命令,其它 exit 2」(广义)
- §14.3 写「head 阻塞 user-facing 命令,不阻塞 worker」(狭义)

冲突起源是 rev 3.x 单值 pending 时代直接 ban 全部 — 升 FIFO + fan-out 后语义没同步更新。

最初设计意图是搞个 3 bucket 表:
- A:read-only 永远 allowed
- B:worker append-only allowed(fan-out 必要)
- C:state-changing blocked

但实施时用户 push back 指出:**这是 skill orchestration 责任,不是 CLI protocol 责任**(§1 原则 14)。

### Decision

CLI 协议层 **只 enforce 1 条 pending invariant**(state-machine integrity):

> `state.pending[0].kind ∈ {gate_decision, profile_escalation}` 时,`loaf advance` 必须 `exit 2 PENDING_BLOCKS_ADVANCE`

衍生约束(同一 invariant 不同表现):
- `loaf gate decide <G>` head 必须是 `gate_decision(<G>)`,否则 `GATE_NOT_PENDING`
- `loaf profile escalate --confirm` head 必须是 `profile_escalation`,否则 `ESCALATION_NOT_PENDING`

这两条命令本身是答 head 的合法路径 — CLI pop pending + 写 evidence + 推 state 在一个 lock 内 atomic。

### 为什么这条 + 这条**就够**

state machine integrity 关心的是 **state.phase / state.sub_state 不能越过未解决的 gate / escalation 推进**。

- `gate_decision` head 存在 = user 没批准这个 gate → 越过 = state 假装已批准 → **真协议失败**
- `profile_escalation` head 存在 = user 没确认升档 → 越过 = state 走错 profile policy → **真协议失败**

其它 PendingPromptKind:
- `ask_user_question` / `spec_clarification` / `finding_decision` — workflow signals,user 没答影响 UX 和调度,**不影响**协议正确性(state machine 仍在合法位置)

### 砍掉的 3 bucket 表

- **A bucket**(read-only 38 命令分类)— CLI 本来就不动 state,无 enforce 必要
- **B bucket**(append-only mutators)— 不写 `state.phase / sub_state`,不影响 integrity;**协议拦它 = fan-out 失效**(worker A 撞 pending 卡 worker B 的 evidence add)
- **C bucket**(state-changing 命令)— 实际真影响 cursor 的只 `advance` + 几个 corollary;其它如 `spec submit` 写 spec.md 不写 cursor、`abandon` 是 user-explicit panic-eject

bucket 表把 skill 工作做到 CLI 里 — 违反 §1 原则 14。

### Skill 责任(不进 CLI 协议)

- 主 skill / sub-agent 调任何 mutator 前 `loaf pending list --format json` 查队列
- Fan-out 调度策略(哪个 worker 等 / 哪个继续)由 skill 自己判断
- Claude Code 等 client 可用 `PreToolUse(Bash)` hook 拦 `loaf advance:*` 强化 UX(skill 选择,不是 protocol)
- 详见 `references/loaf-skill-helpers.md`(impl 阶段写)

### 影响的 protocol surface

- §10.7 prompt 行为段加 "Pending head 阻塞 protocol-level invariant" 小节,1 条规则 + 4 段 corollary / 不 enforce 的解释 / skill 责任
- §14.3 head 阻塞段 simplify 为 cross-ref §10.7
- §10.5 error 表加 3 个 diagnostic code:`PENDING_BLOCKS_ADVANCE` / `GATE_NOT_PENDING` / `ESCALATION_NOT_PENDING`
- §10.8 命令表 `gate decide` + `profile escalate --confirm` 行加 head match 注释
- `schemas.ts §34 CONCURRENCY_INVARIANTS` 加 `advance_blocks_when_pending_head_kind: ["gate_decision", "profile_escalation"]` 字段(机器化表达)+ 30+ 行注释解释 bucket 砍掉的理由

### 不破 §15 freeze

- ✓ 无新 phase / sub_state / artifact / hook / CLI subcommand
- ✓ 加 3 个 diagnostic code(在既有 §10.5 error 表内)
- ✓ schemas.ts 加常量字段(`advance_blocks_when_pending_head_kind`)在既有 `CONCURRENCY_INVARIANTS` 里

## Addendum 6 · Profile enum 砍掉,改 Ceremony hybrid B+label(rev 4.2)

### 起因

rev 4.1 在 codex audit / clig audit 后稳定下来,3 profile(quick/standard/deep)+ Q3 minimal pending blocking + Q4-Q7 default 全部落地。

用户提了一个新需求:**灵活性** — 想要中间档(spec 但跳 verify)。grilling 走了几轮:
1. 提议 4 profile(加 light)— 加 1 enum 值 + 1 PROFILE_POLICIES row
2. 用户提议 `--skip-verify` / `--skip-settle` flag — 被否决(跟 profile 双重 mechanism redundant)
3. 用户问"如果有 skip flag,profile 还有什么意义" — 触发更根本的设计问题
4. 二选一:(a) pure 协议内核 + skill 决定 preset (b) opinionated SDD framework 内置 4-tier
5. 用户选 (a),但担心"state machine 严谨性"
6. 我证明严谨性 0 损失(同 6 flag,只是字段名 vs enum 名),提议 hybrid B+label
7. 用户接受 hybrid

### Decision

**Profile enum 整个砍掉**。替代:`Ceremony` 6 flag schema(机器接口)+ `ceremony_label` cosmetic 字符串(skill 填,CLI 透传)。

#### Schema 改动

- `Profile` enum(`"quick" | "standard" | "deep"`)→ 删除
- 新 `Ceremony` schema:
  ```ts
  {
    spec_phase: boolean (default false),
    verify_phase: boolean (default false),
    settle_phase: boolean (default false),
    strict_spec_review: boolean (default false),
    lessons_required: "must" | "may" | "skip" (default "skip"),
    strict_drift_check: boolean (default false),
  }
  ```
  cross-field invariants(Zod refine):
  - settle_phase=true 要求 verify_phase=true
  - strict_spec_review=true 要求 spec_phase=true
  - lessons_required ≠ "skip" 要求 settle_phase=true
  - strict_drift_check=true 要求 settle_phase=true
- 新 `CeremonyLabel = z.string()` — 仅 cosmetic
- `StateJson.profile: Profile` → `StateJson.ceremony: Ceremony` + `StateJson.ceremony_label: CeremonyLabel`
- `RegistryFile.profile: Profile` → `RegistryFile.ceremony_label: CeremonyLabel`(TUI 显示用;详细 ceremony 走 canonical state.json)
- `PROFILE_POLICIES` 表整个砍 → 注释说明移到 skill PRESETS
- `EscalationRule`(from/to profile) → 改 `EscalationDetection`(triggers + recommend_enable)
- `LoafConfig.constitution.default_profile` → `default_ceremony_label` + optional `default_ceremony`
- `SUB_STATE_CONTRACTS.entry` 字符串里 `profile != quick` → `ceremony.{spec,verify,settle}_phase=true`

#### Skill PRESETS 表(loaf-skill 维护,不进协议)

```ts
const PRESETS: Record<string, Ceremony> = {
  quick:    { spec_phase: false, verify_phase: false, settle_phase: false, strict_spec_review: false, lessons_required: "skip", strict_drift_check: false },
  light:    { spec_phase: true,  verify_phase: false, settle_phase: false, strict_spec_review: false, lessons_required: "skip", strict_drift_check: false },
  standard: { spec_phase: true,  verify_phase: true,  settle_phase: true,  strict_spec_review: false, lessons_required: "may",  strict_drift_check: false },
  deep:     { spec_phase: true,  verify_phase: true,  settle_phase: true,  strict_spec_review: true,  lessons_required: "must", strict_drift_check: true  },
};
```

skill `loaf start` 流程:
1. 算 complexity_score
2. 推荐 preset label(skill 自己定 score → label 映射,如 quick < 20 / light 20-40 / standard 40-70 / deep ≥ 70)
3. user 接受或 override
4. skill 调 `loaf start --ceremony-json '<PRESETS[label]>' --ceremony-label '<label>'`
5. CLI 写 `state.ceremony` + `state.ceremony_label`,后续 enforcement 全走 ceremony.* 6 flag

3rd-party skill(cursor-loaf / windsurf-loaf / 公司自定义)可起任意 preset 名,**协议层中立** — `state.ceremony_label` 是 user-readable 字符串,CLI 不解析。

### 为什么这样

**§1 原则 14**:协议管 shape,skill 管 content。Profile 是 **content**(preset 选哪个 = 工作流策略),不是 shape(state machine 长什么样)。砍下 5 件 content→skill 决策之**最后一件**:
1. vague-word blacklist(rev 3.1 砍)
2. `should` soft tier(rev 3.1 砍)
3. `decomposition_preference`(rev 3.2 砍)
4. `verify_cadence`(rev 3.x reject)
5. `Profile` enum(rev 4.2 砍) ← 本 Addendum

**State machine 严谨性 0 损失**:CLI 用 ceremony.* 6 flag 强制 phase 跑哪些(`ceremony.spec_phase=false` → 不允许 sub_state ∈ SPEC.* → exit 2),跟之前 `state.profile="quick"` 查 PROFILE_POLICIES 表禁 SPEC.* 完全等价。差别只在错误信息引用字段名 vs profile 名。

**Cosmetic label 保住品牌名 readability**:错误信息 / TUI / state-change line 显示 `"ceremony_label='quick' (ceremony.spec_phase=false)..."`,user 心智锚点不变。

**协议中立 → 多 skill 互操作**:cursor-loaf / windsurf-loaf 可以有自己的 preset 名(`prototype/feature/release`),CLI 不绑死 4 个 hardcoded 名字。

### Trade-off 诚实摆出

**砍 Profile 损失**:
- 简单 user 看 `state.ceremony` 比看 `profile=standard` 难懂 — 6 个 bool 比 1 个 word 复杂
- score-based auto-detection 现在归 skill(skill 维护 score → label 映射),不再是协议常量
- 跨 skill 用 ceremony 名字不一致时 user 切 skill 困惑(loaf-skill 叫 "standard",cursor-loaf-skill 可能叫 "feature")

**砍 Profile 收益**:
- 协议中立 → 任意 client 自由起 preset
- skill 加新 preset(`rapid-iteration` / `release-candidate`)零协议改
- 跟 §1 原则 14 / rev 3-4.x 之前 4 次内容下沉同向(连贯)
- 6 flag 比 enum 更细致表达 — 用户想"standard 但跳 lessons"做得到(set lessons_required="skip" + 不 set strict_drift_check),不用新加 profile

权衡:**长期协议中立性 + skill 演进自由 > 短期简单性**。v1 design 阶段一次性付清比 GA 后改容易。

### 不破 §15 freeze

- ✓ schema_version 仍 1
- ✓ 无新 phase / sub-state / hook / CLI subcommand
- ✓ 无新 top-level artifact 类型
- ✗ Profile enum 砍 + StateJson/RegistryFile/LoafConfig 字段类型变化 — 不在 freeze 禁止列表的明文条件,但是**真 schema 改动**

按 rev 4.0 + 4.1 同样 unfrozen 期 schema 调整的纪律论证 acceptable:v1 还未 implement,Hyrum's Law=0,客户端 binding 还没生效。本次 schema 改动跟 rev 4.0 (砍 current_*)、rev 4.1 (改 pending 为 array) 一脉相承。

GA 之后若需要类似改动,必须 v2 schema_version bump。本 rev 4.2 趁 unfrozen 期收尾干净。

### 推迟 / 永久 non-goal

- **Profile enum 复活**:永久 non-goal。skill PRESETS 表代替。
- **`--skip-verify` / `--skip-settle` 命令 flag**:永久 non-goal(违反 hybrid B 设计,user pushed back 后撤回)。skill 想要 "skip 某 phase" 改 ceremony object 即可。

## Addendum 7 · clig.dev 三轮 review polish(rev 4.2 内合并)

### 起因

rev 4.2 Profile→Ceremony 落地后,跑了**第三轮 clig.dev review**(前两轮在 rev 4.0 / rev 4.1)。这一轮目标是把 §10 CLI surface 的微观边界点钉牢 — 不动 schema 语义,只补 clig.dev 24 节里之前漏掉的局部歧义、conflict 语义、TTY 边界。

最终 6 fix(0 blocker / 3 major / 3 minor),全部 §10.x microsurface 改动,无新字段、无新 phase、无新命令。

### Decision · Accepted(6)

1. **`loaf tasks done` → `loaf tasks complete` rename**(clig.dev §8 ambiguous names)
   起因:`loaf tasks done <T-N>`(整 task 关闭)与 `loaf tasks step done --task --step`(单 step 关闭)同 `done` 动词在不同 nesting 层 — muscle memory 易混。signature 差别(positional vs flag)只在 argv 解析后才显现,help 文案肉眼仍可能错敲。
   落点:`protocol.md` §10.8 命令表 + §10.12 state-change line(`tasks step done` row 加 "若全部 must step 完成 → next: tasks complete";新增 `tasks complete` row + `next: loaf advance`)+ `protocol.html` 命令表 + `schemas.ts` revision history。

2. **`--json` / `--plain` / `--format` 互斥契约**(clig.dev §6 standard flags)
   起因:三 flag 共存但 conflict 语义未定义。`loaf x --json --plain` 是 undefined behavior — pipe / CI 脚本依赖此 flag,但无契约就不可预测。
   决策:同值归一无冲突(`--json --format=json` OK),冲突值 → exit 2 `MUTUALLY_EXCLUSIVE_FLAGS`,stderr 列冲突 flag 对(`{conflicting: ["--json", "--plain"]}` JSON body for scripting)。
   落点:`protocol.md` §10.5 错误表加行 + §10.7 新「Format flag 归一化与互斥」段 + `schemas.ts` 新 §35 `FLAG_EXCLUSIONS` const(`output_format` set + `verbosity_reserved` 占位 future)。错误代码用 `MUTUALLY_EXCLUSIVE_FLAGS` 而非 `INCOMPATIBLE_FORMAT_FLAGS` — 通用名复用于未来其它 flag 互斥(`--quiet -v` 等)。

3. **stderr color TTY gate 独立 `isatty()`**(clig.dev §4 color)
   起因:§10.2 原文「Color disabled when stdout 不是 TTY」漏 stderr。`loaf x 2>err.log` 时 stdout 仍 TTY 染色,stderr 走文件被 ANSI 码污染 — CI log 常见场景。
   落点:`protocol.md` §10.2 改成「**目标 stream(stdout 或 stderr 各自独立 `isatty()`)**不是 TTY 时 disabled」+ 加例。

4. **Help footer 加 `$LOAF_ISSUE_URL`**(clig.dev §2 support path)
   起因:§10.1 help 文案只 reference `$LOAF_DOCS_URL`,缺 issue tracker。clig.dev §2:「Help text contains a support path — URL, issue tracker, email」。crash 时 §10.5 unexpected error 已经给 URL,但正常 `--help` user 不知道遇 bug 去哪报。
   落点:`protocol.md` §10.1 footer 改成 `docs: $LOAF_DOCS_URL + report bug: $LOAF_ISSUE_URL`。build-time stamping 已在 §10.11(rev 4.1 加的),无需新增 env var。

5. **`-h` 任意位置 short-circuit**(clig.dev §2)
   起因:parser default 行为可能让 `loaf tasks step --task T-001 -h` 因为 `--task T-001` 未识别(在 `tasks step` 阶段)而报错,而不是打 `tasks step` help。
   落点:`protocol.md` §10.1 加一行规约 — parser 必须 short-circuit `-h` 在 subcommand context resolved 之后,不被中间未识别 flag 干扰。这条间接影响 impl 阶段 parser 选型(see Implementation Hooks 段)。

6. **`loaf hook <event>` enum 限定 + `--list-events`**(clig.dev §2 discoverability + §8 no catch-all)
   起因:§10.8 命令表 `loaf hook <event>` 行只写「Claude Code hook 入口」,`<event>` enum 不可发现。user 敲 `loaf hook` 无 arg 会被 parser 报"missing arg"但不知道哪些值合法。
   落点:`protocol.md` §10.8 hook 行加 enum(`session-start` / `write-guard` / `scope-track` / `closure-check`)+ `--list-events` 显式 dump + bare 调用 exit 2 列 enum + did-you-mean。`schemas.ts` 新 §36 `HookEvent = z.enum([...])` + `HOOK_EVENT_TO_CLAUDE_CODE` 映射表(kebab-case shell surface → PascalCase Claude Code event)。

### Decision · Promoted to v1.0(1)

**`LOAF_FORMAT` env** — 原计划留 v1.x reserved,review 末尾用户决定 v1.0 就支持:
- `protocol.md` §10.3 env 表加行(`json` / `text` 二选一;precedence:explicit flag > `LOAF_FORMAT` > TTY default;out-of-enum 值 → exit 2 `INVALID_ENV_VALUE`)
- `schemas.ts` §35 `FLAG_EXCLUSIONS` precedence comment 同步更新

理由:CI / 脚本环境一次 `export LOAF_FORMAT=json` 比每命令带 `--json` 自然。在 §15 freeze 前一次性付清,GA 后再加只能 ADR + minor version bump,成本更高。

### Decision · Rejected(0)

本轮所有 fix 都接受 — 全是 microsurface polish,无语义冲突,无 trade-off 争议。

### Trade-off / Implementation Hooks

- **Parser 选型**(impl 阶段第一个 PR):#5(`-h` 任意位置)间接 require parser 在 subcommand resolved 后 short-circuit `-h`。Bun 内建 `parseArgs` 子命令体验弱,推荐 `@effect/cli` 或 `cmd-ts` 二选一(看是否已投 Effect 生态)。无投入 → `cmd-ts`(更轻、`-h` 任意位置原生)。本 ADR 不锁选型,留 impl PR 决定。
- **HookEvent enum 在 §15 freeze 内**:hook surface 是 freeze 边界。post-v1.0 加新 event 必须 minor version bump + ADR。本轮 hardcode 4 值是 v1.0 final。

### 不破 §15 freeze

- ✓ schema_version 仍 1
- ✓ 无新 phase / sub-state / artifact 类型
- ✓ 无新 top-level CLI 子命令(`tasks done → complete` 是 rename;`--list-events` 是 `hook` 子命令的 flag)
- ✓ 无新 hook surface(`HookEvent` enum 是把既有 §11 表里 4 个 event 字面 hardcode,不增不减)
- ✓ 字段增加:`FLAG_EXCLUSIONS` const、`HookEvent` enum、`HOOK_EVENT_TO_CLAUDE_CODE` 映射表 — 全部是 CLI 辅助常量,不是 artifact / state 字段。延续 rev 4.0/4.1/4.2 同样 unfrozen 期内部常量扩展纪律。
- ✓ 环境变量增加:`LOAF_FORMAT`(协议层 `LOAF_*` 命名空间内,clig.dev §13 合规)— v1.0 freeze 内已声明 `LOAF_*` 命名空间为协议契约。

GA 之后这些都属 freeze 范围,改一律 minor version bump + ADR。

## v1.0.0 done-when freeze 状态

rev 4.1 **未破** §15 freeze 任何一条:
- ✓ `schema_version` 仍为 1
- ✓ phase 数量仍为 6
- ✓ sub_state 总数仍为 20(EXECUTE.task → EXECUTE.work 是 rename,不是 add/remove)
- ✓ 无新 top-level artifact 类型
- ✓ 无新 hook surface
- ✓ 无新 top-level CLI 子命令(`--dry-run` 是 global flag,不是 subcommand)

唯一字段增加:`FindingActionEffect.requires_target_payload`(action effect 元数据,不是 artifact 字段)、`SubStateContract.mutation_rights`(optional 字段)、`EvidenceEntry.external_ref`(optional)、`EvidenceAddInput`(input 类型,不是新 artifact)、`CONCURRENCY_INVARIANTS`(常量,不是新 artifact;含 `dry_run_transaction_order` rev 4.1 补)、`FindingResolutionPayload`(新 type,但配 finding action,不是新 artifact)、`FLAG_EXCLUSIONS`(CLI 辅助常量,rev 4.2 polish)、`HookEvent` z.enum + `HOOK_EVENT_TO_CLAUDE_CODE` 映射表(既有 §11 hook 表 4 event 字面 hardcode,不增不减,rev 4.2 polish)。这些都在既有 schema 内部扩展,不构成 freeze 违反。

audit follow-up **新增 §15 done-when 第 5 条**(`LOAF_DOCS_URL` / `LOAF_ISSUE_URL` placeholder check)是 release pipeline 契约,不是协议字段。

环境变量增加:`LOAF_FORMAT`(rev 4.2 polish,落 §10.3 env 表)— 协议层 `LOAF_*` 命名空间在 freeze 内已声明为契约,新增协议变量纳入 freeze 同时声明 v1.0 final。

---

*rev 4.2 · 2026-05-12 · codex 2-round audit + clig.dev 3-round audit + 多 pending 队列 v1.0 升级 + quick 跳过 SETTLE 直跳 DONE + session dispatch + AI client bridge + Profile→Ceremony hybrid + Addendum 7 (tasks complete rename / FLAG_EXCLUSIONS / stderr color gate / LOAF_ISSUE_URL footer / -h short-circuit / HookEvent enum / LOAF_FORMAT v1.0) 全部 resolved · 等下一轮 review 或直接进 implementation 阶段*
