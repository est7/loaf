Let me look at the docs first.

Let me read through the core docs.

好,我看完了主要的文档。说实话这方案写得很扎实,ES 化的决策我整体认同。下面提我的意见,按严重度排。

---

## Blocker 级

**1. schemas.ts 还没清干净旧的 N-file 事务逻辑**

review-4 里 codex 指出的 blocker 你还没修。`CONCURRENCY_INVARIANTS` 里还残留着 dry-run transaction / lock / atomic rename 的描述,跟 design.md §4.0 的 ES 模型直接矛盾。这是机器契约文件,实现者会直接 port 这个对象。M0 必须先清这个。

## Major 级

**2. 事件 kind 命名不一致**

schemas.ts §0a 列了 `finding_raised` / `finding_closed`,plan.md M1 那边冒出来 `finding_close`(少了 d)和 `spec_init`(schemas.ts 里没有)。还有 plan.md 里出现 `StepStarted` 但 §0a 事件清单里没有。这种 drift 会导致 reducer fixture、CLI 命令、schema 三边打架。建议你维护一个**单一事件清单**(schemas.ts §0a 是唯一 truth),plan.md 和 design.md 都从这里引用,不要各自维护一份。

**3. design.html 没有跟着 ES 化**

design.html 还大量展示 `state.json` 作为 protocol truth、`tasks.json` 作为 active-set SSOT、`loaf tasks step done` 写 tasks.json + evidence.jsonl 两步操作。既然 design.html 是"可视化伴读文档",要么跟着改,要么标记清楚"此图仅供参考,N-file 模型已被 §4.0 ES 模型替代"。

**4. Pending 阻塞语义自相矛盾**

design.md 的例子里说 PEND-0007 "blocks all non pending commands",但下面的 invariant 又说只阻塞 `loaf advance` 且只有 head kind ∈ {gate_decision, profile_escalation} 时才阻塞。schemas.ts 确认的是窄规则。我同意窄规则(fan-out 场景下宽规则会让 worker 互相卡死),但矛盾的描述会让实现者迷惑。删掉那句宽描述。

## 我自己的观察(非 review-4 重复)

**5. Reducer 复杂度被低估了**

plan.md risk #1 提到了 reducer 是新的 stable kernel,但我觉得严重性被低估了。你现在有 18 种 event kind,每种 apply 要维护 6 个 projection slice 的一致性,加上 8 个 post-condition invariant。这不是一个"几天写完"的东西。spike 里只覆盖了 10 种 event、3 个 invariant,已经 195ms/10k events。扩展到全量后 reducer 的正确性验证会是最大的工程风险。

建议:
- M1 拆成 M1a(核心 10 event port) + M1b(8 个新 event),每个都有独立的 golden fixture gate
- reducer 的 invariant 测试用 property-based testing(vitest + fast-check?),不要只靠手写 fixture

**6. ceremony 系统有点重**

6 个 flag + 4 个 preset + auto-escalation + cross-field refine... 对 v0.1.0 来说这是很多状态空间。我理解你想让 quick / standard / deep 有明确的协议区分,但 auto-escalation 的 trigger 检测(scope_expansion / public_api_touched / schema_change / concurrency / security)本身又是另一个需要维护的状态机。

建议 v0.1.0 只保留 `spec_phase` / `verify_phase` / `settle_phase` 三个 bool,`strict_spec_review` / `lessons_required` / `strict_drift_check` 推到 v0.1.x。减少一半的状态组合。

**7. spec.md 的 EARS + Gherkin + Visual Contracts 三件套**

写一个 spec.md 要填 frontmatter 里的 requirements(每条 REQ 要三选一可验证)、scenarios(Gherkin)、visual_contracts,还要在 body 里锚点引用... 这对 LLM skill 来说是很大的输出约束。我的担心是:skill 产出的 spec.md 质量会参差不齐,然后大量 spec-gap / spec-defect finding 回旋回来,反而拖慢进度。

建议:验证模式(三选一可验证)是好的,但 scenarios 和 visual_contracts 在 quick / light profile 里应该 optional 而非 required。目前从 §5.1 的 spec-lock checks 来看,e2e scenario 和 visual_contract 都需要有 task 绑定或显式 NA — 这对简单 feature 来说负担太重。

**8. 26 天估算乐观了**

M1 3 天写 18 种 event kind 的 Zod schema + reducer + golden fixtures... 按我经验这种状态机代码,光 reducer 的边界 case 就够写一周。M6 4 天写 ~15 个 mutating commands 每个都要 happy-path + error-path 测试... 也偏紧。建议加 20-30% buffer 到 33-34 天。

## Nit

**9.** plan.md §9 测试策略里的 fixture 路径还是旧的 N-file 结构(`state.json` / `tasks.json` / `evidence.jsonl` 分开),应该改成 `events.jsonl` 单文件 + snapshot 断言。

**10.** `canSatisfy()` 函数里 `waiver` 要求 `reason ≥ 10 chars`,但 `manual` 也要求 — 这个约束在 design.md §4.4 的描述里只提到了 waiver。确认 manual 是否真的要 reason。

---

## 总结

ES 化的决策是正确的,核心架构设计很清晰。但**跨文档一致性还没收敛**(schemas.ts / design.html / plan.md 各自维护了不同版本的事实),这是你实施前必须解决的。review-4 的 blocker + 3 个 major 建议先修完再开工 M0。

另外 reducer 的复杂度和 ceremony 的状态空间是我额外担心的两个点,建议在 M1 milestone 里做更细的拆分。

好问题。这个我有明确看法。

## 不是 CLI 替 LLM 写,是 CLI 给 LLM 脚手架

核心问题是:让 LLM 一次性生成一个完整的 spec.md(10+ requirements × 三选一可验证 + scenarios + visual contracts + body 锚点引用),输出约束太重,质量方差大。

解法不是"CLI 来写 spec.md"(那你要把语义理解塞进 CLI,不可能),而是 **拆成多个小步骤,每步验证后才进下一步**。

### 现在的问题:spec-lock 是一次性大检查

```
SPEC.proposal → SPEC.spec → SPEC.plan → SPEC.design
                                         ↑
                                    spec-lock 一次性跑 8 条 check
                                    不过 → 重写整个 spec → 再检查
```

LLM 在 `SPEC.spec` 阶段一口气产出整个 spec.md,然后 `SPEC.design` 前的 spec-lock 发现 5 条 REQ 缺 verifiability、2 个 scenario 没 task 绑定、1 个 visual_contract 漏了... → finding → amend-spec → 重来。这个循环很贵。

### 解法:CLI 提供增量式 spec 构建命令

```bash
# 1. init 创建骨架 (CLI 做,纯结构)
loaf spec init --intent "用户 access token 过期时无感刷新"

# → .loaf/<feature>/spec.md 生成:
# ---
# schema_version: 1
# spec_version: 0
# feature: { id: F-001, name: "" }
# intent: "用户 access token 过期时无感刷新"
# adr_refs: []
# requirements: []
# scenarios: []
# visual_contracts: []
# needs_clarification: []
# ---
# 
# ## Why
# (待填写)

# 2. add-req 逐条加 requirement,每条即时验证
loaf spec add-req \
  --type event-driven \
  --trigger "an API request receives HTTP 401" \
  --response "the system shall attempt token refresh" \
  --verified-by SCEN-AUTH-E2E-001

# → CLI: 写入 frontmatter, 自动分配 REQ-AUTH-001,
#   验证 verifiability ✓, 打印 "REQ-AUTH-001 added (verified_by_scenarios)"

# 3. add-req 带 measurable 的
loaf spec add-req \
  --type event-driven \
  --trigger "multiple 401s concurrently" \
  --response "at most one refresh within 500ms" \
  --measurable "refresh_requests_within_500ms <= 1 count"

# → REQ-AUTH-002 added (measurable)

# 4. add-scenario
loaf spec add-scenario \
  --name "Expired token recovered by refresh" \
  --tag e2e \
  --given "user has valid refresh token" \
  --given "access token is expired" \
  --when "user opens the order list" \
  --then "system refreshes the access token" \
  --then "order list is displayed" \
  --requires-acceptance

# → SCEN-AUTH-E2E-001 added

# 5. add-visual
loaf spec add-visual \
  --target "Login primary button during refresh" \
  --check "shows loading spinner" \
  --check "button is disabled"

# → VIS-AUTH-001 added

# 6. LLM 写 body (唯一的 LLM 步骤)
loaf spec edit   # $EDITOR 打开, LLM 只需写 prose body 段落
                 # body 里引用 REQ-AUTH-001, SCEN-AUTH-E2E-001 等锚点

# 7. 即时校验,不等到 spec-lock
loaf check spec
# → "REQ-AUTH-001: body anchor found ✓"
# → "REQ-AUTH-002: body anchor MISSING — add 'REQ-AUTH-002' to body"
# → "SCEN-AUTH-E2E-001: requires_acceptance but no task binds it yet (ok, pre-lock)"

# 8. spec submit (spec_version bump)
loaf spec submit
```

### 这样做的好处

| 维度 | 现在(一次性生成) | 改后(增量构建) |
|---|---|---|
| LLM 输出量 | 一次 200+ 行结构化 YAML | 每次 3-5 行(一个 req / scenario) |
| 验证时机 | spec-lock 一次性 | 每个 add-xx 命令即时 |
| 错误修复成本 | 重写整个 spec | 重发一条命令 |
| verifiability miss | 常见(漏 measurable/scenarios) | 不可能(add-req 强制三选一) |
| ID 分配 | LLM 自己编,容易冲突/跳号 | CLI 自动分配,单调递增 |
| body 锚点 | LLM 容易忘 | `loaf check spec` 即时提示 |

### LLM skill 的职责变成什么

```
skill 不再直接写 spec.md 文件
skill 调 CLI 命令:
  1. "这个 feature 的意图是什么" → skill 输出 intent string → loaf spec init
  2. "需要哪些 requirement" → skill 逐条输出 req 内容 → loaf spec add-req × N
  3. "每个 req 的验证路径" → skill 已经在 add-req 时选好了
  4. "写 body prose" → skill 调 loaf spec edit 或直接 write file
  5. "检查完整性" → loaf check spec
```

LLM 做它擅长的(语义理解、需求拆解、prose 写作),CLI 做它擅长的(结构校验、ID 分配、schema 验证、格式保证)。

### 影响到设计文档的改动

这个改动不大,但要动几处:

1. **design.md §4.2**: spec.md 的 frontmatter 不再要求 LLM 一次性生成,改为 CLI 增量构建
2. **cli.md**: 新增 `loaf spec add-req` / `loaf spec add-scenario` / `loaf spec add-visual` 子命令
3. **schemas.ts**: 新增 `SpecReqInput` / `SpecScenarioInput` / `SpecVisualInput` 输入 schema
4. **plan.md M6**: spec 相关命令从 `submit/init/edit` 三个扩展到包含 add-req 等增量命令
5. **findings 机制**: spec-gap 类 finding 的修复从"重写 spec"变成"补调 add-req"

不涉及 state machine / event kind 变动 —— 这些命令最终还是产出 `spec_submitted` event,只是 spec.md 的**构建过程**被 CLI 辅助了。protocol 层面不变。

你觉得这个方向对吗?还是你有别的思路?

好问题。让我把整个协议过一遍,找出所有 LLM skill 需要手搓结构化数据的地方。

## 全协议扫描:LLM 容易犯错的格式化热点

### 1. tasks — 最大的重灾区

现在 `loaf tasks submit` 让 skill 一次提交整个 tasks.json。LLM 要同时搞定:

- 6 种 task kind 各自的 step enum(behavioral 有 red/implement/refactor; visual-ui 有 mockup/implement/screenshot-compare; spike 有 explore/prototype/record...)
- `depends_on[]` DAG 不能有环
- `drives[]` 必须引用存在的 REQ-*
- `labels` 含 `"bug"` 时必须 `red_test_registered: true`
- structural/docs/chore/spike 必须有 `no_test_rationale`
- visual-ui 必须有 `visual_contract_refs[]`

**建议新增:**

```bash
# 逐条加 task,CLI 根据 kind 自动填充 execution shape
loaf tasks add \
  --kind behavioral \
  --drives REQ-AUTH-002 \
  --tests TokenCoord.concurrent401OnlyRefreshesOnce \
  --test-layer unit

# → CLI 自动:
#   - 分配 T-003
#   - 生成 execution: { red: {applicability:"must"}, implement: {applicability:"must"}, refactor: {applicability:"optional"} }
#   - 校验 REQ-AUTH-002 存在于 spec.md
#   - 输出 "T-003 added (behavioral, drives REQ-AUTH-002)"

# bug 类 task
loaf tasks add \
  --kind behavioral \
  --label bug \
  --drives REQ-AUTH-003 \
  --tests AuthButton.hoverShowsTooltip

# → CLI 自动:
#   - labels: ["bug"] → 强制 red_test_registered: true
#   - 校验 tests 字段非空(bug 必须有测试)

# visual-ui task
loaf tasks add \
  --kind visual-ui \
  --visual-contract VIS-AUTH-001

# → CLI 自动:
#   - execution: { mockup, implement, screenshot-compare } 三步
#   - 校验 VIS-AUTH-001 存在于 spec.md

# spike task
loaf tasks add \
  --kind spike \
  --desc "explore single-flight library options"

# → CLI 自动:
#   - execution: { explore, prototype, record }
#   - no_test_rationale 自动生成
#   - 标记 "此 task 不可 deliver"

# structural task (带依赖)
loaf tasks add \
  --kind structural \
  --desc "rename AuthInterceptor → TokenInterceptor" \
  --depends-on T-001

# → CLI 自动:
#   - execution: { implement, refactor }
#   - no_test_rationale 必填
#   - 校验 T-001 存在且 DAG 无环

# 校验整个 tasks 集合的 DAG
loaf tasks check
# → "T-005 depends_on T-006 but T-006 depends_on T-005: CYCLE"
# → "T-003 drives REQ-AUTH-002 but REQ-AUTH-002 not in spec: ORPHAN_REF"
```

核心思路:**kind 决定 execution shape,CLI 填充,LLM 只填语义内容**(drives 什么、描述什么、测试什么)。

---

### 2. evidence — 格式花样多

6 种 evidence kind 各有不同的必填字段组合:

| kind | actor 约束 | 额外必填 | covers 规则 |
|---|---|---|---|
| task-summary | 任意 | cmd, exit | T-* 或 REQ-* |
| local-check | 任意 | — | T-* |
| verify-review | `actor ≠ implementer` | check | REQ-* |
| visual-review | 任意 | attachments[] | VIS-* |
| manual | 必须 `human:*` | reason ≥10 | 任意 |
| waiver | 必须 `human:*` | reason ≥10, waiver_obligation_id | 对应的 REQ/SCEN/VIS |
| gate-decision | `human:*` | gate, decided_by, reason | 空 |

**建议新增:**

```bash
# 测试证据
loaf evidence add \
  --kind task-summary \
  --task T-001 \
  --covers REQ-AUTH-002 \
  --cmd "bun test auth" \
  --exit 0 \
  --summary "4 unit tests passed"

# → CLI 自动:
#   - 分配 EV-000123 (单调递增)
#   - 校验 T-001 存在
#   - 校验 REQ-AUTH-002 被 T-001 的 drives[] 引用
#   - result 默认 "passed" (exit=0)
#   - 输出 "EV-000123 added (task-summary, covers REQ-AUTH-002)"

# 视觉证据 (自动管理附件)
loaf evidence add \
  --kind visual-review \
  --covers VIS-AUTH-001 \
  --attachment ./screenshot.png \
  --summary "button shows spinner; disabled state correct"

# → CLI 自动:
#   - copy attachment → .loaf/<feature>/attachments/EV-000126/login-primary-button.png
#   - 计算 sha256
#   - 设置 mime type (从文件推断)
#   - actor 默认 "human:<username>" (visual-review 通常是人工)

# 豁免
loaf evidence add \
  --kind waiver \
  --covers REQ-AUTH-005 \
  --reason "intuitive feel validated via separate user-testing protocol"

# → CLI 自动:
#   - 校验 reason ≥ 10 chars
#   - 设置 waiver_obligation_id = REQ-AUTH-005
#   - 设置 actor = "human:<username>"
#   - 设置 result = "waived"
#   - 校验 REQ-AUTH-005 的 acceptance_na === true (waiver 只能豁免 NA 标记的)

# gate 决策 (已有 loaf gate decide,这个 OK)
```

核心思路:**CLI 知道每种 kind 的字段组合,LLM 只提供语义**(测了什么、结论是什么、豁免理由)。

---

### 3. findings — category × action 组合容易选错

6 category × 6 action 但不是全排列合法。比如:
- `new-scope` → `fix-impl` 无意义(范围外的不能靠修实现解决)
- `test-defect` → `amend-spec` 无意义(测试错了不该改 spec)
- `impl-defect` → `defer` 可以但语义可疑

**建议新增:**

```bash
# CLI 根据 category 推荐合法 action,拒绝无意义组合
loaf finding raise \
  --category spec-gap \
  --summary "按钮 hover 状态 spec 沉默" \
  --refs REQ-AUTH-007

# → CLI 输出:
#   "FND-001 raised (spec-gap)"
#   "Suggested actions: amend-spec | defer | backlog"
#   "Run: loaf finding close FND-001 --action <action>"

# close 时校验 action 合法性
loaf finding close FND-001 --action amend-spec
# → CLI 自动:
#   - 校验 (spec-gap, amend-spec) 是合法组合
#   - 触发 state spec_locked = false
#   - 输出 "FND-001 closed → amend-spec (iteration++)"

# 非法组合直接拒绝
loaf finding close FND-002 --action fix-impl --category test-defect
# → exit 2: "test-defect → fix-impl: invalid combination. Did you mean fix-test?"
```

---

### 4. loaf.config.json — glob 模式容易写错

Android 项目的 paths glob 模式对 LLM 来说是个坑:

```bash
# CLI 提供 Android preset,一键生成
loaf config init --preset android

# → 生成 loaf.config.json:
# {
#   "paths": {
#     "source": ["app/src/main/**", "*/src/main/**"],
#     "tests": ["**/src/test/**", "**/src/androidTest/**"],
#     "docs": ["docs/**", "*.md"],
#     "ui": ["**/res/layout/**", "**/ui/**", "**/*Screen.kt"],
#     "public_api": ["core-api/**", "**/api/**"],
#     "schema": ["**/*.graphql", "**/*.proto"],
#     "security": ["**/auth/**", "**/crypto/**"]
#   },
#   "commands": {
#     "run": ["./gradlew testDebugUnitTest"],
#     "lint": ["./gradlew lintDebug"],
#     "typecheck": ["./gradlew compileDebugKotlin"],
#     ...
#   }
# }

# 或者从现有项目自动推断
loaf config detect
# → 扫描项目结构,输出建议的 config,等用户确认
```

---

### 5. 汇总:哪些该内化到 CLI

| 操作 | 现在 | 建议 | 优先级 |
|---|---|---|---|
| `spec add-req` | LLM 写完整 spec.md | CLI 逐条加 + 即时验证 | **P0** |
| `spec add-scenario` | LLM 写完整 spec.md | CLI 加 + 自动分配 SCEN-id | **P0** |
| `spec add-visual` | LLM 写完整 spec.md | CLI 加 + 自动分配 VIS-id | **P1** |
| `tasks add` | LLM 写完整 tasks.json | CLI 按 kind 填 execution shape | **P0** |
| `tasks check --dag` | 不存在 | CLI 校验 DAG + refs | **P0** |
| `evidence add` | 已有,但字段校验弱 | CLI 按 kind 校验必填字段 | **P1** |
| `finding raise` | LLM 手写 JSONL | CLI 校验 category/action 组合 | **P1** |
| `config init --preset` | LLM 手写 | CLI 提供项目 preset | **P2** |

**P0 的三个**(spec add-req, tasks add, tasks check)是最值得先做的,因为它们的格式化复杂度最高、LLM 犯错频率最大,而且做好后 spec-lock 的通过率会显著提升。

整个思路跟 spec 那个一样:**LLM 负责语义决策(这个 feature 需要什么 requirement、每个 task 测什么),CLI 负责结构保证(id 分配、execution shape、cross-ref 校验、DAG 无环)**。

对,核心就是这个:LLM 做决策,CLI 做格式保证。除此之外还有几个维度可以优化。

## 1. Context Pack — 最大的 token 省点

现在 skill 每次被调用,要把 spec.md + tasks.json + evidence + findings + state 全喂给 LLM。一个中等 feature 可能 2000+ tokens 的上下文。

**加一个 `loaf context pack` 命令:**

```bash
# 根据当前 phase 输出最精简的上下文
loaf context pack

# 输出:
# === F-001 OAuth refresh | EXECUTE.work (iter 2) ===
# Pending: none
# 
# Tasks (active set):
#   T-001 [behavioral] ✓ done — drives REQ-AUTH-002
#   T-003 [behavioral] ▶ T-001.red=running — drives REQ-AUTH-003
#   T-005 [structural] ○ blocked on T-001
#
# Open findings:
#   FND-002 (spec-gap) → amend-spec suggested
#
# Next actions:
#   - Complete T-001.red → loaf tasks step done --task T-001 --step red
#   - Resolve FND-002 → loaf finding close FND-002 --action amend-spec
```

对比现在的方案(skill 自己拼上下文):

| | 现在 | context pack |
|---|---|---|
| token 量 | 2000-4000 | 200-500 |
| 信息密度 | 大量无关字段 | 只看当前 phase 需要的 |
| LLM 理解成本 | 要自己解析 JSON 结构 | 人可读的摘要 |
| 出错率 | 高(漏看字段) | 低(关键信息前置) |

核心思路:**不同 phase 需要的上下文完全不同**。EXECUTE.work 不需要 spec 的 EARS 详情,只需要"哪个 task 在跑、drives 什么 REQ、当前 step 是什么"。VERIFY 不需要 task DAG,只需要"哪些 check 还没过、哪些 finding 还开着"。

实现上就是 `project.ts` 已经算出 Snapshot,`context pack` 只是按 `state.sub_state` 选择性渲染。

## 2. Pre-flight Check — 命令执行前先预检

现在是:skill 发命令 → CLI 执行 → 失败 → skill 改 → 再发。每次失败是一个 round trip。

**加 `--dry-run` 全局 flag:**

```bash
loaf tasks step done --task T-001 --step red --dry-run

# → "Would emit step_done event for T-001.red"
# → "Evidence: EV-00045 auto-allocated"
# → "Covers: T-001, REQ-AUTH-002 (from drives[])"
# → "Exit: 0 (valid)"

loaf advance --dry-run
# → "Blocked: PEND-0007 is head (kind=profile_escalation)"
# → "Exit 2: PENDING_BLOCKS_ADVANCE"
# → "Fix: loaf pending resolve --answer confirm"
```

skill 可以在真正执行前先 dry-run 一次,确认没问题再跑。或者更省 token 的做法:

**CLI 在错误消息里直接给修复命令:**

```bash
loaf tasks step done --task T-001 --step red
# → exit 2
# → "T-001.red status is 'pending', not 'running'. 
#     Did you forget to claim? Run:
#     loaf tasks claim --task T-001"
```

现在 error message 只给 diagnostic code,skill 要自己推断怎么修。加上修复建议后,skill 可以直接 copy 命令执行,省一轮思考。

## 3. 批量操作 — 减少 per-command 开销

spec 构建阶段,skill 要连续调 10+ 次 `loaf spec add-req`。每次都是:读 events → project → 校验 → append → 输出。中间的读 + project 是重复的。

**方案 A: pipeline stdin**

```bash
# 一次提交多条,内部只读一次 events
loaf spec add-req --batch - <<'EOF'
[
  {"type":"event-driven","trigger":"401 received","response":"attempt refresh","verified_by":["SCEN-001"]},
  {"type":"event-driven","trigger":"concurrent 401s","response":"max one refresh per 500ms","measurable":"refresh_count<=1"}
]
EOF
```

**方案 B: file-based batch**

```bash
# skill 先写一个 JSON 文件
loaf tasks submit --from reqs.json
```

A 更 Unix 风格,B 更适合 LLM(写文件比写 heredoc 容易)。我倾向 B。

## 4. Phase-aware Error Recovery

现在失败了 skill 只拿到错误码。应该根据 phase 给**具体的恢复路径**:

```bash
# VERIFY.run 阶段,lint 失败
loaf verify status
# → "VERIFY.run: lint failed (2 errors)"
# → "Recovery options:"
# → "  1. Fix and re-run: loaf advance (re-runs checks)"
# → "  2. Waive: loaf evidence add --kind waiver --covers T-003 --reason '...'"
# → "  3. Raise finding: loaf finding raise --category impl-defect --summary '...'"

# SPEC.lock 阶段,3 条 REQ 缺 verifiability
loaf check spec
# → "REQ-AUTH-004: no verifiability (needs measurable | verified_by_scenarios | acceptance_na)"
# → "REQ-AUTH-006: no verifiability"
# → "REQ-AUTH-007: no verifiability"
# → "Fix: loaf spec add-req --id REQ-AUTH-004 --measurable '...' "
# → "   or: loaf spec add-req --id REQ-AUTH-004 --acceptance-na --reason '...'"
```

这让 skill 不用猜"失败了该干什么"。

## 5. Snapshot Diff — 变更感知

skill 修复了一个 finding 后,需要知道"改了什么"才能决定下一步。

```bash
# 对比两次 snapshot
loaf snapshot diff --from 100 --to 150

# → 
# + T-003 status: pending → done
# + EV-00089: task-summary for T-003
# + FND-002: open → closed (amend-spec)
# + state.iteration: 1 → 2
# + state.spec_locked: true → false → true (re-locked after amend)
```

比让 skill 自己对比两个完整 snapshot 省很多 token。

## 优先级排序

| 优化 | 收益 | 工程量 | 建议 milestone |
|---|---|---|---|
| context pack | token 省 60-80% | 小(渲染层) | **M3** (跟 read-only commands 一起) |
| 错误消息带修复命令 | 减少 round trip | 小(改 error format) | **M5** (跟 mutating commands 一起) |
| spec/tasks 增量命令 | 准确性大幅提升 | 中(新增 CLI surface) | **M6** (work-phase commands) |
| batch submit | 构建阶段速度 | 中 | **M6** |
| snapshot diff | 调试/恢复效率 | 小 | **M3** |
| pre-flight --dry-run | 减少 round trip | 中(每个命令加 dry-run 路径) | **M7** (可以后做) |

**context pack + 错误修复建议**这两个投入最小、回报最大,建议优先做。
