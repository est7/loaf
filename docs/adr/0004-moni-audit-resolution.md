# ADR-0004 — rev 4.3:moni-review LLM-friendliness audit 共识落地

- Status: **Accepted**
- Date: 2026-05-13
- Scope: loaf-cli protocol surface(rev 4.2 → rev 4.3;新增 CLI 命令 + 4 const 表 + 1 helper type + 9 个 error codes)
- Supersedes: ADR-0003 §15 freeze interpretation(rewording,not full supersede)—— 把「不加 CLI subcommand」条款放开为「pre-GA 允许 ADR-trail 下扩展 CLI surface」;rev 4.0 / 4.1 / 4.2 其余决策全部保留
- Partially superseded: 2026-07-27 architecture program A08 supersedes A5's
  task-input detail. `tasks submit` and `tasks add` now share strict semantic
  authoring (`local_key` + explicit dependency refs), while the CLI still owns
  permanent ID and execution-state materialization. The journal payload is
  unchanged; legacy full CLI input is intentionally rejected.
- Related: `protocol.md` §4 / §10 / §15 / §19;`schemas.ts` §5 / §15 / 新增 §37-§40(原计划 §35-§38,落地时与 rev 4.2 既有 §35 FLAG_EXCLUSIONS / §36 HookEvent 挤占,顺延);
  ADR-0001(shape 在协议 / content 在 skill 原则);ADR-0002(rev 4.0 fresh design);
  ADR-0003(rev 4.1 fan-out 单写者纪律);`moni-review.md`(audit 源);
  `references/loaf-skill-helpers.md`(三层架构)

## Context

`moni-review.md`(2026-05-13)对 rev 4.2 protocol 做了一轮审计。与 codex 第一/二轮审计(ADR-0003)关注 correctness / concurrency 缺口不同,moni 的核心论点是 **LLM 友好性**:

> LLM 一次性手搓大型 YAML / JSON artifact(spec.md 一次产 200+ 行 frontmatter、tasks.json 一次产 10+ task 配 6 种 kind 的 execution shape、evidence.jsonl 手编 sha256 / mime)出错率高且修复循环昂贵。CLI 应该承担 **shape enforcement** 责任 —— LLM 出语义 content,CLI 出结构 shape。

这与 ADR-0001 已经确立的「shape 在协议,content 在 skill」原则方向一致,但 rev 4.2 协议**只在 spec.md 部分应用**了这条原则(tasks add 已存在、evidence add 已 flag-driven),其余 artifact 的 shape enforcement 还停留在「LLM 自己拼 JSON,Zod 落盘时校验」的 reactive 形态。

经过 9 题 grilling + 3 条 push back 反复,决策树收敛为 **11 项接受 / 3 项拒绝**。本 ADR 把这套共识固化,作为后续 `protocol.md` / `schemas.ts` / `references/` 编辑的单一上游决策源。

### moni 审计与 codex 审计的差异

| 维度 | codex(ADR-0003 源)| moni(本 ADR 源)|
|---|---|---|
| 关注层面 | correctness / concurrency / 协议骨架 | LLM UX / 增量构造 / shape enforcement 一致性 |
| 触发产物 | fan-out 单写者纪律、SPEC.plan vs EXECUTE.plan、Principle #15 三纪律 | Tier 1 增量命令、3-tier finding grid、`loaf context pack`、`ERROR_CATALOG` |
| 协议层影响 | 骨架重构(VERIFY 4-state / SPEC 4-state / sub_state promotion rule) | surface 扩展(新增 5 命令 + 5 const 表 + 9 codes,无 schema_version bump) |
| 演进版本 | rev 4.0 → rev 4.1 | rev 4.2 → rev 4.3 |

两轮审计互补:codex 锁死了**协议 invariant 不被并发 / 抽象漂移破坏**,moni 锁死了**LLM 消费者不被结构化输出压力压垮**。两者都是 v1 GA 前的必要硬化。

### 与 ADR-0001 的关系

ADR-0001 立下「shape 在协议,content 在 skill」原则,但只在 task DAG / Sprint 容器场景落地。rev 4.2 协议的实际状态:

- spec.md:**LLM 全手搓** —— frontmatter 5 EARS type × 三选一可验证 × scenarios × visual_contracts,无增量构造路径
- tasks.json:`loaf tasks add <T-N>` 已存在,但 LLM 出 positional T-id(违反 shape enforcement)
- evidence.jsonl:`loaf evidence add` 已存在但 flag-driven,attachment sha256 / mime LLM 自己算(必错)
- findings.jsonl:`loaf finding raise --category X --action Y` 已存在,但 6 × 6 组合合法性无 enforcement
- 错误消息:`exit 2` codes 大多只给 description,无 fix 提示

本 ADR 把 ADR-0001 原则**彻底贯穿**所有 Tier 1 artifact:每个结构化 mutator 都是「LLM 出语义,CLI 出 shape」的同款形态,不再 spec 孤岛。

---

## Decision · Accepted(11)

每条按 ADR-0003 格式:**(a) 决策一句话 + (b) 落点 + (c) 收益 > 改动**。

### A1 · Tier 1 + Tier 1.5 + Tier 2 范围接受(Q1)

**(a) 决策**:扩张 CLI surface,新增 5 个结构化 mutator 命令 + 1 个 context 命令组 + 错误 fix-hint 全覆盖。Tier 3(`config init --preset` / `snapshot diff` / batch via file)v1 不做。

**(b) 落点**:
- `protocol.md` §10.8 命令表新增 5 条 + 改动 4 条
- `protocol.md` §15 done-when freeze 重写(原「不允许新增 top-level CLI 子命令」放开,user 显式解锁)

**(c) 收益**:rev 4.2 协议把 LLM 当作「能输出 200 行结构化文本」假设,实际 LLM 在大块 YAML / 嵌套 JSON 上错误率 > 30%(moni 实测引用)。Tier 1 把这类输出**降到每命令 5-15 行 JSON**,错误率显著下降,且每条 add 即时 schema 校验,失败修复成本从「重写整个 spec.md」降到「重发一条命令」。

### A2 · CLI 层承担 shape enforcement(Q2)

**(a) 决策**:Tier 1 命令的 shape 校验(id 分配、三选一可验证、6 evidence kind 字段矩阵、6 × 6 finding 合法性、attachment hash / mime)全部在 CLI 层 enforce,不下沉到 skill。

**(b) 落点**:
- `schemas.ts` 新增 `INPUT_SCHEMAS: Record<MutatorCommand, ZodSchema>` const(集中所有 Tier 1 命令 input Zod schema)
- `protocol.md` §19 三层架构段落补一句:「shape enforcement = CLI 责任,workflow content = skill 责任」明示

**(c) 收益**:若放在 skill,每个 3rd-party workflow skill(Wang / GSD / openspec / 内部 ad-hoc)都要重新实现 `schemas.ts` 的子集。CLI 层做一次,所有 skill 共享。这是 ADR-0001 原则的直接 corollary。

### A3 · `--input <-|inline|path>` 统一 input modality(Q3)

**(a) 决策**:所有 Tier 1 结构化 mutator 用同一种 input 形态 —— `--input` flag,三种 source:

| 形态 | 例 |
|---|---|
| stdin | `echo '{}' \| loaf spec add-req --input -` |
| inline JSON | `loaf spec add-req --input '{"type":"event-driven",...}'` |
| 文件路径 | `loaf spec add-req --input /tmp/req.json` |

判别:值 = `-` → stdin;值匹配 `^[\{\[]` → inline;其它 → 路径(不存在 → exit 2 `INPUT_FILE_NOT_FOUND`)。

**配套 clig.dev 4 项加固**:
1. `--help` 顶部带 2-3 个工作 JSON 示例(覆盖典型 shape),flag 表在下方
2. `loaf <cmd> --schema --json` dump Zod-derived JSON Schema(全局 modifier)
3. Zod error path → human 可读(`/measurable/threshold: expected number, got string` + `fix: see 'loaf spec add-req --schema --json'`)
4. **`--input` 而非 `--json`**:避免与全局 output flag `--json`(format=json)overload(clig.dev §6 反模式)

**(b) 落点**:
- `protocol.md` §10.7 全局 flag 表新增 `--input <-|json|path>` + `--schema` modifier
- `protocol.md` §10.5 error 表新增 `INPUT_FILE_NOT_FOUND` / `MISSING_INPUT` / `SCHEMA_VALIDATION_FAILED`
- `schemas.ts` `INPUT_SCHEMAS` 表 + 每 schema 暴露 `dumpJsonSchema()` 方法

**(c) 收益**:LLM 在 shell quote escape 上错误率高于 JSON 语法(训练分布友好性差异)。`--input` 统一给 LLM 一种调用形态,文档 ×1 / fixture ×1 / error path ×1,不出现 hybrid modality 的双倍维护成本。

### A4 · `spec_version` per-invocation +1 + phase gating(Q4)

**(a) 决策**:
- 每次 `loaf spec add-req / add-scenario / add-visual` 调用 → `spec_version += 1`(batch 仍 +1 per invocation,见 A10)
- Pre-lock(`SPEC.spec` / `SPEC.plan` / `SPEC.design`)合法;post-lock(EXECUTE/VERIFY/SETTLE/DONE)拒,必经 `loaf finding raise --category spec-gap --action amend-spec` 回退到 SPEC.spec

**(b) 落点**:
- `protocol.md` §4.2 spec.md 后新增「增量构造 + spec_version bump 策略」sub-section
- `protocol.md` §5.3 反向 transition 段补一句:add-\* 命令 post-lock 行为同 `loaf amend`(reject + 提示 finding)
- `protocol.md` §10.5 error 表新增 `SPEC_LOCKED_NO_DIRECT_EDIT` + `SPEC_NOT_INITIALIZED`

**(c) 收益**:`spec_version` 单调递增满足 spec-lock 校验 #3(`tasks.based_on.spec === spec.spec_version`),任何 spec 内容变化都反映在 spec_version,杜绝「spec.md 改了但 version 没动」的漂移。30+ 版本号是内部计数,不面向用户。phase gating 跟现有 `tasks add` 规则(§10.8「EXECUTE 阶段拒 → 走 amend-tasks finding」)镜像,无新原则引入。

### A5 · ID 分配:CLI 单调,LLM 出 `id_namespace`(Q5)

> **2026-07-27 supersession note:** the ID-ownership decision remains active,
> but the task authoring shape below is replaced by
> `protocol.md` §4.3 / A08. Tasks now carry a unique invocation-local
> `local_key`; dependencies use explicit `{local_key}` or `{task_id}` refs,
> enabling deterministic two-pass forward-reference resolution under the
> feature lease. Callers still cannot provide permanent IDs or execution
> progress.

**(a) 决策**:
- 所有 Tier 1 命令 input JSON **不接受完整 `id`** —— CLI 在 lock 内单调分配完整 id
- REQ / SCEN / VIS:input JSON **必填 `id_namespace`** 字段(语义 = stem,不含序号),CLI 拼成完整 id 落到 spec.md。两个独立 regex 不可混用:
  - **Input regex(LLM 出的 namespace)**:`^REQ-[A-Z][A-Z0-9]*$` / `^SCEN-[A-Z][A-Z0-9-]*$` / `^VIS-[A-Z][A-Z0-9-]*$`(不含 `-\d{3,}` 尾段)
  - **Output regex(CLI 拼完整 id 落盘到 spec.md)**:沿 schema 既有 `^REQ-[A-Z][A-Z0-9]*-\d{3,}$` / `^SCEN-[A-Z][A-Z0-9-]*-\d{3,}$` / `^VIS-[A-Z][A-Z0-9-]*-\d{3,}$`(含序号)
  - CLI 流程:input 通过 input regex → 扫 spec.md 找该 namespace 下 max suffix → 分配 next → 拼完整 id 通过 output regex → 落盘
- T / EV / FND / PEND:CLI 全自动,**input 完全不传 namespace 字段**(沿 schema 既有 output regex `^T-\d{3,}$` / `^EV-\d{6,}$` / `^FND-\d{3,}$` / `^PEND-\d{4,}$`)
- `loaf tasks add <T-N>` positional **砍**,改 `--input -`(positional alias 不保留)

**(b) 落点**:
- `schemas.ts` §15 新增 `SpecReqInput` / `SpecScenarioInput` / `SpecVisualInput` / `TaskInput` 类型(从对应 entry omit `id` + `at` 等 CLI-allocated 字段;`SpecReqInput.id_namespace` 用 input regex)
- `schemas.ts` §7 spec.md 段补一句:`id_namespace` 与完整 `id` 是两个独立字段类型,各自 regex 不同
- `protocol.md` §10.8 命令表 `loaf tasks add` 行重写
- `protocol.md` §4.2 / §4.3 / §4.4 各自补 ID 分配段(`id_namespace` 输入语义 + CLI 拼接策略)

**(c) 收益**:fan-out 场景下(rev 4.0 引入)多个 worker 同时调 add-\* 命令时,CLI 持 lock 单调分配杜绝 ID 冲突。LLM 失去 id 命名自由度但获得无冲突保证 —— 工程层最佳实践。Schema 已 enforce 的 NS 模式给 workflow skill(Wang AUTH / OAUTH / NET 等)足够 namespace 表达力,不损失语义。

### A6 · Attachment 自动 sha256 + mime + canonical path(Q6)

**(a) 决策**:`loaf evidence add` input JSON `attachments: [{path: string}]` 只接受文件路径,CLI:
1. 验证 path 存在 + 可读 + 非目录
2. 拷贝到 `.loaf/<feature>/attachments/<EV-id>/<basename>`(basename 冲突时 suffix `-2`/`-3`)
3. 计算 sha256(hex)
4. 从扩展名 + magic bytes 推断 mime
5. stat `bytes`
6. 写完整 attachment 对象到 evidence.jsonl

**(b) 落点**:
- `protocol.md` §4.4 evidence.jsonl 段补 attachment 自动处理章
- `protocol.md` §10.5 新增 `ATTACHMENT_NOT_FOUND` / `ATTACHMENT_NOT_FILE`
- `schemas.ts` §15 `EvidenceAddInput.attachments` 字段定义为 `Array<{path: string}>`(简化形态);落盘到 `EvidenceEntry.attachments` 时是完整对象(已有 schema)

**(c) 收益**:LLM 在 shell 里调 `sha256sum` / 推 mime 几乎必错。这是经典 **shape transformation**(path → canonical entry with hash/mime/bytes),归 CLI 完美。

### A7 · 3-tier `FINDING_ACTION_GRID`(Q7 + FB#2)

**(a) 决策**:把原计划的 2-tier(legal / illegal)拆成 3-tier(`typical` / `unusual` / `incoherent`),enforce 三种行为:

```ts
type ActionRisk = "typical" | "unusual" | "incoherent";

const FINDING_ACTION_GRID: Record<FindingCategory, Record<FindingAction, ActionRisk>> = {
  "spec-gap":        { "amend-spec":"typical", "amend-tasks":"unusual",  "fix-impl":"incoherent", "fix-test":"incoherent", "defer":"typical", "backlog":"typical" },
  "spec-defect":     { "amend-spec":"typical", "amend-tasks":"unusual",  "fix-impl":"unusual",    "fix-test":"unusual",    "defer":"typical", "backlog":"typical" },
  "impl-defect":     { "amend-spec":"unusual", "amend-tasks":"typical",  "fix-impl":"typical",    "fix-test":"unusual",    "defer":"typical", "backlog":"typical" },
  "test-defect":     { "amend-spec":"unusual", "amend-tasks":"typical",  "fix-impl":"unusual",    "fix-test":"typical",    "defer":"typical", "backlog":"typical" },
  "new-scope":       { "amend-spec":"typical", "amend-tasks":"typical",  "fix-impl":"incoherent", "fix-test":"incoherent", "defer":"typical", "backlog":"typical" },
  "risk-escalation": { "amend-spec":"unusual", "amend-tasks":"typical",  "fix-impl":"unusual",    "fix-test":"unusual",    "defer":"typical", "backlog":"typical" },
};
```

Enforcement:
- `typical` → 正常 raise,reason 可选
- `unusual` → require `--reason` 且 ≥ 20 字符;否则 `FINDING_ACTION_UNUSUAL_REASON_REQUIRED` exit 2
- `incoherent` → block,`FINDING_ACTION_INCOHERENT` exit 2,stderr 解释「无 task 可 apply transition」

Incoherent 4 格全部满足「结构性无 target 可 apply」判据:`spec-gap × {fix-impl, fix-test}` 和 `new-scope × {fix-impl, fix-test}` —— 没有 REQ ⇒ 没有 task ⇒ 没有 impl/test 可修;`fix-impl` 的 transition `task.execution.implement.status=running` 必然 fail,早 block 早 LLM feedback。

配套审计字段:`reconcile.json` 新增 `unusual_findings_count`,reviewer 一眼看出哪些 finding 是非典型分类。

**(b) 落点**:
- `schemas.ts` §37(新)`FindingActionRisk` enum + `FINDING_ACTION_GRID` const
- `protocol.md` §4.5 findings.jsonl 段加 3-tier risk 段 + 矩阵表
- `protocol.md` §4.6 reconcile.json 例加 `unusual_findings_count` 字段
- `protocol.md` §10.5 新增 2 codes
- `references/finding-matrix-rationale.md`(新增,每格判定理由)

**(c) 收益**:既给 LLM 分类模糊空间(`unusual` 允许出但要解释 reason),又保留 `incoherent` 硬 block 防 fail-time 推迟;`unusual_findings_count` 让 reconcile 聚合不丢信号(non-typical findings 单独可见),避免 finding ontology 漂移让 `spec_defects_count` / `impl_defects_count` 失去意义。

### A8 · `loaf context pack` 替代 `loaf resume --fresh`(Q8)

**(a) 决策**:
- 新增 `loaf context pack [--phase auto|<sub_state>] [--format json|text]`,phase-aware 输出当前 phase 需要的最小上下文
- `loaf resume --fresh` flag 砍,`loaf resume` 只管 handoff 恢复(读 resume-pack.json)
- 模板表 `CONTEXT_PACK_TEMPLATES: Record<SubState, ContextPackProjection>` 在 `schemas.ts`,每 sub_state 列「pack 包含 / 不包含」

**典型切片**:

| sub_state | 包含 | 不包含 |
|---|---|---|
| TRIAGE.score | feature.intent + 评分项 + ceremony presets | spec/tasks/evidence(尚未建)|
| SPEC.spec | feature meta + spec_version + REQ/SCEN/VIS counts + verifiability 缺口 + needs_clarification + pending head | tasks DAG / evidence detail |
| EXECUTE.work | ceremony preset + tasks 状态汇总 + in_progress 当前 step + ready leaf top-5 + open findings + pending + write scope | spec EARS 详情 / verify checks |
| VERIFY.\* | 4 VerifyCheck 状态表 + REQ/SCEN/VIS 覆盖矩阵 + 未满足 covers + open findings + pending | task DAG |
| SETTLE.lessons | iteration 总数 + findings stats by category × action + drift 摘要 | tasks / spec 详情 |

不截断不分页,skill 觉得仍大用 `head -N` 或 `--format json | jq` 自切。

**(b) 落点**:
- `protocol.md` §10.8 命令表新增 `loaf context pack`,改动 `loaf resume` 去掉 `--fresh`
- `protocol.md` §10.12 read-only 命令列表加 `loaf context pack`
- `schemas.ts` §38(新)`ContextPackProjection` schema + `CONTEXT_PACK_TEMPLATES` 表

**(c) 收益**:`loaf resume` 本职是 handoff(罕用),`--fresh` 把日常 context 切片塞在 resume 子命令下违反 clig.dev §8 subcommand 语义独立。拆出 `loaf context` 命令组让 skill 在每次 phase 切换后取最小 context,token 节省 60-80%(moni 实测引用)。模板表集中 = 后续 phase 新增 / 字段调整改一处。

### A9 · `ERROR_CATALOG` + exit 2 全 fix-hint(Q9)

**(a) 决策**:所有 exit 2 user-recoverable 错误强制四段格式输出(clig.dev §5 重要信息在尾部):

```
error: <one-line human description>
       <optional context: what state we're in, what we saw>
       fix: <concrete command(s) the user should run>
       see: <doc URL anchor or local file path>
```

集中实现:`schemas.ts` 新增 `ERROR_CATALOG: Record<DiagnosticCode, ErrorEntry>`,每 entry 含 `exit_code` / `message_template` / `fix_template` / `doc_anchor`。exit 1(internal panic)不带 fix(只给 crash log + report URL,既有 §10.5 不变)。i18n 天然落地(`LOAF_LANG=zh` 切 zh bundle)。

**(b) 落点**:
- `schemas.ts` §39(新)`ErrorEntry` schema + `ERROR_CATALOG` const
- `protocol.md` §10.5 error contract 段重写(加 fix/see 行规约 + ERROR_CATALOG 引用)
- `protocol.md` §18 i18n 段补一句:错误消息走 ERROR_CATALOG bundle

**(c) 收益**:rev 4.2 协议成功路径(§10.12)已有 `next:` hint,失败路径不对称是 LLM round trip 浪费源。集中后散在各 throw 处的字符串无法 i18n 的问题一并解决。

### A10 · Batch transaction 三纪律(FB#1)

**(a) 决策**:Tier 1 命令 input schema 改 `z.union([T, z.array(T)])`,支持单条或数组形态。Batch 行为:

| 纪律 | 规则 |
|---|---|
| **1a all-or-nothing** | 整批先在内存 validate,有一条 fail → 整批 reject,0 落盘(满足 append-only / crash-only invariant)|
| **1b spec_version +1** | batch 是一次 invocation = 一个 atomic change → +1 spec_version,不是 +N |
| **1c atomic ID alloc** | lock 内一次性从 allocator 拿 N 个连续 id,全过才 commit allocator state |

**(b) 落点**:
- `schemas.ts` §15 Tier 1 input schema 每个加 `.or(z.array(...))` 联合形态
- `protocol.md` §11.2 single-writer transaction 段补 batch 三纪律小节
- `protocol.md` §10.8 命令表每条 add-\* 行补一句「支持 single 或 array input」

**(c) 收益**:中等 feature 15 REQ + 10 task = 25 次 CLI 调用,每次都有 lock 获取 / events 读取 / projection / validate / append 开销;batch 后是 2 次调用。性能与 LLM token 双优化。Transaction 三纪律保证语义不破坏既有 append-only / spec_version monotonic 约束。

### A11 · `--input` 三种 source 判别策略(FB#3)

**(a) 决策**:`--input` flag 接受值的判别顺序:

```
1. 值 === "-"               → 从 stdin 读
2. 值 matches /^[\{\[]/      → inline JSON 字符串
3. 其它                      → 文件路径(不存在 → exit 2 INPUT_FILE_NOT_FOUND)
```

LLM skill 路径(写文件 + 引用)和机器管道路径(echo + pipe)都自然支持。

**(b) 落点**:
- `protocol.md` §10.7 `--input` flag 行补判别策略
- `schemas.ts` §40(新)`InputSourceResolver` 工具类型(供 CLI 实现引用)

**(c) 收益**:覆盖 3 种典型调用形态,实现代价是一个 if-elif-else。LLM 在 stdin pipe vs 文件路径之间可选偏好(写文件更自然),无强制单一形态。

---

## Decision · Rejected(3)

### R1 · `loaf config init --preset android`

**moni 提议**:CLI 提供项目类型预设(android / ts / rust 等),`loaf.config.json` 的 `paths.*` glob 一键生成。

**拒绝理由**:
- Preset 内容(哪些 paths 对 android 是 source / tests / ui / public_api)是 **content**,不是 shape
- 各 workflow skill(Wang android workflow / 内部 mobile 团队 ad-hoc)可以自带 preset 文件,通过 `loaf config init --from <preset.json>` 路径走通 —— 不需要 CLI hardcode
- v1 协议不该绑定具体技术栈;rev 4.2 §16 「v1 不锁定语言 / 平台」精神延续

**alternative**:loaf-skill plugin 提供 preset library(各 workflow skill 维护自己版本),`loaf config init` 接受 `--from` 任意 JSON 文件。

### R2 · `loaf snapshot diff --from <n> --to <m>`

**moni 提议**:对比两次 state snapshot,输出变化项(task 状态变化、新 evidence、findings 状态切换、iteration 增长),帮 skill 在闭环动作后理解「改了什么」。

**拒绝理由**:
- 这是 **query 复合**(`loaf status` 两次 + diff),不是协议层 shape enforcement
- skill 可以自己实现:`loaf status --format json` × 2 + JSON diff,或调 `loaf tasks list --format json` / `loaf finding list` 各自 diff
- v1 不引入「snapshot 多版本存储」(rev 4.2 协议 state.json 是单一当前 snapshot,无历史版本)—— snapshot diff 命令会暗示需要历史 snapshot,scope 蔓延
- 调试 / 恢复场景频次低,不值得占协议 surface

### R3 · 全 warn 无 block 的 Finding matrix

**user push back 提议**(grilling 中)**:把所有「不连贯」组合改成 warn + require-reason,不 block 任何 cell。

**拒绝理由**:
- 4 个 cell(`spec-gap × {fix-impl, fix-test}` / `new-scope × {fix-impl, fix-test}`)是 **target-determinacy 不可解**,不是「LLM 难分类」:
  - 这两类 category 表示 spec 在某方面缺乏内容(完全沉默 / 已有 REQ 的部分缺口 / 新范围)。在 spec 未先补齐之前,**`fix-impl` / `fix-test` 的合法 target 不确定** —— `fix-impl` 的 transition `task.execution.implement.status=running` 需要一个具体 task,但「修哪个 task / 改哪段 impl」恰恰是 spec 应该指明的内容
  - 即使 spec-gap 是已有 REQ 的局部缺口,缺口部分仍**没有 task / test** 可被这条 transition 选中;先 `amend-spec` 补齐缺口,后续才能精确定位 fix target
- raise 时不 block,后续 action 必然在 target-determinacy 校验时 fail,等于把 fail 时间推迟一轮 round trip
- 早 block 早 LLM feedback 才是 LLM 友好(「改 category 或 action」立即可见,vs 等到 transition 时再 debug)

**采纳**:3-tier(`typical` / `unusual` / `incoherent`)— 把 user 的 risk 思路覆盖到 `unusual` 层(require reason),`incoherent` 仅保留 4 个结构性死格。详 A7。

---

## 为什么 rev 4.3 不是 rev 5

| 不变项 | 状态 |
|---|---|
| `SCHEMA_VERSION` | 仍 = 1,无 bump |
| Phase / sub_state 数量 | 无增删 |
| Hook surface | 无改动(§11) |
| Artifact 数量 | 仍 9 per-feature + 1 config + 1 user-level(§4) |
| canSatisfy / EVIDENCE_COMPAT | 无改动(§5.4) |

**新增项**:5 个 CLI 命令(top-level + sub-subcommand)+ 4 个 const 表 + 1 个 helper type + 9 个 error codes + 1 个 input modality(`--input`)。属于 **API surface 加项,纯 additive**,非协议骨架重做。

**为什么 additive command surface 仍记 rev 4.3 而不是 rev 5**:
- 既有命令 + 既有 input modality + 既有 exit code 语义全部保留,**任何 rev 4.2 写法在 rev 4.3 下行为不变** —— 不是 breaking change
- 跟 schema_version bump / phase 增删 / hook surface 改 这种「读旧文件 / 调旧 hook 会出错」的真 breaking 不同,Tier 1 命令是 net-new surface,旧 caller 不调即可
- pre-GA freeze 由 user 显式解锁是协议演进合法路径 —— `protocol.md` §15 freeze 本来就是 v1.0 GA tag 后才永久冻结,pre-GA 阶段在 ADR-trail 下扩展属于设计期常规动作

如果命名 rev 5 会暗示协议又一次结构重做,把演进史变成「3 → 3.1 → 3.2 → 4 → 5」(rev 4.x 仅活了 4 个月),外部接入方对协议稳定性失去信任。rev 4.3 保留「4.x 是稳定骨架,小数点是 polish」的语义。

`protocol.md` §15 done-when freeze 段的「不允许新增 top-level CLI 子命令」子条款由本 ADR 重写为(rewording,not full supersede ADR-0003):

> v1.0 GA tag 之后协议 surface 冻结。GA tag 之前,允许在 ADR-trail 下扩展 CLI 命令 / const 表 / error codes(纯 additive,不删既有 surface),但**不允许**改 schema_version / phase / sub_state / hook surface。

---

## Consequences

### `protocol.md` 改动清单

每节一个 commit,scope = `loaf-cli`(12 节):

1. **§10.8 命令表**:新增 `loaf spec add-req` / `add-scenario` / `add-visual` / `loaf context pack` / 全局 `--schema --json` modifier;改动 `loaf tasks add`(positional 砍)/ `loaf evidence add`(JSON 化)/ `loaf resume`(去 `--fresh`);全部 add-\* 行注明「single 或 array input」
2. **§10.5 error 表**:全 exit 2 行加 `fix:` / `see:` 列;新增 9 个 codes
3. **§10.7 全局 flag 表**:新增 `--input <-|json|path>` + `--schema` modifier
4. **§4.2 spec.md**:frontmatter 后新增「增量构造 + spec_version 策略」sub-section + `id_namespace` 输入语义段
5. **§4.4 evidence.jsonl**:attachment 自动处理段
6. **§4.5 findings.jsonl**:3-tier risk 段 + 矩阵表
7. **§4.6 reconcile.json**:加 `unusual_findings_count` 字段例
8. **§5.3 反向 transition**:add-\* 命令 post-lock 行为镜像 `loaf amend`
9. **§11.2 single-writer**:补 batch 三纪律小节
10. **§15 done-when freeze**:rewording(GA-tag 后冻结,GA-tag 前 ADR-trail 加 surface)
11. **§18 i18n**:错误消息走 ERROR_CATALOG bundle 一句话
12. **§19 三层架构**:补一句「shape enforcement = CLI 责任,workflow content = skill 责任」明示(A2 落点)

### `schemas.ts` 改动

- 新增 **4 个 const 表**:`FINDING_ACTION_GRID`(§37)/ `CONTEXT_PACK_TEMPLATES`(§38)/ `ERROR_CATALOG`(§39)/ `INPUT_SCHEMAS`(§40)
- 新增 **1 个 helper type**:`InputSourceResolver`(§40,与 `INPUT_SCHEMAS` 同节,供 CLI 实现引用,不是 const data)
- 新增 enum:`FindingActionRisk`
- 新增 5 input Zod schema(`SpecReqInput` / `SpecScenarioInput` / `SpecVisualInput` / `TaskInput` / 扩展现有 `EvidenceAddInput`),每个支持 `z.union([T, z.array(T)])`;`SpecReqInput.id_namespace` 等字段用 input regex(`^REQ-[A-Z][A-Z0-9]*$` 等,不含序号)
- 扩展 `DiagnosticCode` enum 加 9 个新 codes
- `reconcile.json` schema 加 `unusual_findings_count: number`
- `EvidenceAddInput.attachments` 字段定义为简化形态 `Array<{path: string}>`(落盘走完整 EvidenceEntry.attachments 已有 schema)

### 新增 reference 文档

- **`references/finding-matrix-rationale.md`** —— 6 × 6 grid 每格判定理由(本 ADR A7 决策的展开,承接 user 在 grilling 中提的「需要写 readme」)
- **`references/incremental-construction.md`** —— Tier 1 + 1.5 命令的统一设计原则(为什么 JSON-stdin、为什么 CLI 分配 id、为什么 attachment 自动化、为什么 batch 三纪律),与 `references/loaf-skill-helpers.md` 呼应

### memory 更新

- 新增 `project_loaf_cli_incremental_construction.md` 锚定 rev 4.3 LLM-friendliness 决策(单一真理源:`shape enforcement = CLI` / `--input` 统一形态 / ID CLI 分配 / batch 三纪律)
- 更新 `MEMORY.md` 索引追加该 memory 条目

### moni-review 未在本 ADR 处理的项

交还后续 ADR / 独立 commit:

- **blocker · schemas.ts `CONCURRENCY_INVARIANTS` 残留旧 N-file 描述**:跟 codex review-4 残留协同,独立 cleanup commit(scope = `loaf-cli`,type = `refactor`)
- **major · event kind 命名 drift**(`finding_close` vs `finding_closed` / `spec_init` 缺失 / `StepStarted` 漂移):跨文档一致性 sweep,独立 commit
- **major · design.html 跟着 ES 化**:protocol.html(rev 4.2 已 ES,html 镜像未同步)独立 commit
- **观察(非 protocol)**:reducer 复杂度被低估 / ceremony 状态空间过重 / 26 天估算 —— 是工程风险与 plan.md 范畴,不进 ADR;记入 plan.md M1 / M3 拆分讨论

---

## Alternatives Considered

### Alt-1 · 增量构造放 loaf-skill 层(不进协议)

skill 自己读 spec.md → in-memory edit → 写回 → 调 `loaf check spec`。

**否决**:违反 ADR-0001 「shape 在协议」原则;每个 3rd-party workflow skill(Wang / GSD / openspec / ad-hoc)重复实现 `schemas.ts` 的子集,引入 race window(skill 改文件与 `loaf check spec` 之间)。详见 grilling Q2。

### Alt-2 · Per-field flag(`--type X --trigger Y --response Z`)

moni 原始提议的形式。

**否决**:嵌套字段(`measurable.{metric, threshold, unit, direction}`)需要要么 flag 爆炸,要么发明 mini-DSL(撕 clig.dev §10 future-proofing);array 字段(Gherkin given/when/then)靠 `--given X --given Y` 顺序敏感;LLM 在 shell quote escape 上错误率高于 JSON 语法。详见 grilling Q3 clig.dev audit。

### Alt-3 · Hybrid input modality(flag + JSON 共存)

简单字段 flag,嵌套字段 JSON。

**否决**:违反 clig.dev §8 一致性原则;两套维护 = 文档 ×2 / fixture ×2 / error path ×2;LLM 学两套语法判别何时用哪套,**最坏复杂度叠加**。详见 grilling Q3。

### Alt-4 · 增强 `loaf spec edit`(不引入 add-\*)

不新增命令,只让 `loaf spec edit` 更强大(EARS-aware skeleton、字段补全)。

**否决**:`spec edit` 是 `$EDITOR` 交互模式,LLM 调用 `$EDITOR` 困难(headless 环境无 editor,Bash one-shot 无法多轮交互);`add-*` 才能命令式调用,适合 LLM workflow。详见 grilling Q3。

### Alt-5 · 全 warn 无 block 的 Finding matrix

user 在 grilling FB#2 中提议,covered in R3。

### Alt-6 · Spec_version batch +N(per item)

A4 决策中讨论:batch 15 REQ → spec_version +15。

**否决**:违反「一次 invocation = 一个 atomic change」语义;`tasks.based_on.spec` 因为「刚好用了 batch」跳号,审计语义错乱;A10 决策为 batch +1 per invocation。

---

## Follow-ups

ADR 接受后(即 commit 本文件后)按以下顺序展开:

1. **`schemas.ts` 改动**(单 commit,scope = `loaf-cli`,type = `feat`):5 const 表 + 5 input schema + enum 扩展 + reconcile 字段
2. **`protocol.md` 改动**(11 节,分 3 commit 控制 PR 体积):
   - commit 1:§10 surface(命令表 + flag 表 + error 表 + state-change 表)
   - commit 2:§4 artifact(spec / evidence / findings / reconcile 4 个 sub-section)
   - commit 3:§5 / §11 / §15 / §18(transition + transaction + freeze + i18n)
3. **2 个新 reference 文档**(单 commit,scope = `loaf-cli`,type = `docs`):finding-matrix-rationale + incremental-construction
4. **memory 更新**(单 commit,scope = `loaf-cli`):新增 1 memory + MEMORY.md 索引
5. **protocol.html 镜像更新**(本 ADR 不强 require,留给 moni 「design.html ES 化」独立 commit 一起做)

每 commit 各自 atomic + 不依赖后续 commit;rollback 单 commit 不破坏 ADR 整体决策(decision 在文本,落盘在文件,两者解耦)。

**ADR 接受标志**:本文件 commit 到 main(scope = `loaf-cli`,type = `docs`)。后续协议改动 commit message 必须引 `ADR-0004 A<N>` 标明决策源。
