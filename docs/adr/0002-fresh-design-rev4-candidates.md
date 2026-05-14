# ADR-0002 — Fresh-design rev 4.0:worker phase vs control phase

- Status: **Accepted**
- Date: 2026-05-12
- Scope: loaf-cli protocol kernel(rev 3.2 → rev 4.0;v1 frozen 第三次 unfreeze)
- Supersedes: 部分覆盖 ADR-0001 已收口的判断(rule-candidate auto-promote / batch parallel 归 skill)
- Related: `schemas.ts` revision history rev 4.0;`protocol.md` §1-§14;
  `protocol.html` SVG state-machine;`references/loaf-skill-helpers.md` §4

## Context

经过 9 轮 grilling(2026-05-12 session)走完 4 个 candidate,识别出 rev 3.1 / 3.2
的 `state.json` 把两类**性质不同的语义**混在一起,导致 `state.current_task` /
`current_step` / `current_check` 三字段无法在 sub-agent fan-out 场景下正确表达
worker active-set,同时也无法在 VERIFY phase 用 sub_state 精确表达 control
cursor。这个混淆是设计层面的,不是单字段补丁能解决的。

### 触发的根本原则

> **Phase 按工作性质分两类:**
>
> - **Worker phase**(EXECUTE)—— 承载实际副作用(写代码 / 跑测试 / 改文件),
>   是 session 中**最耗时**的部分。**支持 sub-agent fan-out 并发**(主 skill
>   编排 N 个 subagent 并行跑互不依赖的 leaf task),active 集合需要表达多元素。
>
> - **Control phase**(TRIAGE / SPEC / VERIFY / SETTLE)—— 承载 planning /
>   checking / settling,**主 skill serial 跑**(spec 是单一 narrative;verify
>   check 是 feature-level serial check;settle 是聚合操作),intent 是单值
>   的「现在在干什么」cursor。
>
> **fan-out 只在 worker phase**;其他 phase 自然 serial。

这条原则在 v1 设计里**隐含存在**(EXECUTE 用 task graph、VERIFY 用 phase-level
checklist 已经反映了 worker/control 性质区分),但没有显式表达,导致 state
字段把两类语义混在一起。

### 为什么现在改而不是 v1.0.0 GA 之后

- v1 还**没 implement**,没有 client / hook / skill 依赖 `state.current_*` 字段
- Hyrum's Law 暴露 **= 0**,migration cost = 0
- 一旦 GA 之后改,所有 client 假设要改,**成本高一个数量级**

「v1 frozen」在没 implement 之前实际是**软冻结**(文档 commitment,不是 client
commitment)。rev 4.0 是设计 iteration,不是真 breaking。

## Decision

落 **5 个 schema candidate**(C1 α / C4 / C6 / C8 / C9'),全部由 worker vs
control phase 原则 drive(C9' 在 grilling 末期 surface,补 RegistryFile 的
TUI 单文件读硬场景)。

**外加 1 个 CLI presentation candidate(C10)**:按 [clig.dev](https://clig.dev)
audit 整段重写 protocol.md §10。原 rev 3.x 只有命令表,无 stdout/stderr 分工 /
help 契约 / TTY 行为 / env var 命名 / signal handling / error rewriting
规约 → implementation 阶段会产生大量 ad-hoc 行为分歧。C10 把这层在 design
阶段全部锁死。详见 protocol.md §10.0-§10.11。

C10 不涉及任何 schema 字段变化,纯 CLI surface 契约硬化,不破坏 §15 done-when。
唯一命名 break 是 `loaf check tasks` → `loaf tasks check`(consistency:跟 `loaf
tasks <op>` 系列名词在前对齐);所有 session lifecycle 单 verb 命令
(`start` / `status` / `advance` / `deliver` / `archive` / `abandon` / `doctor`
/ `tui`)作为 chaos deviation 明确保留,理由是 git-style muscle memory。

### C1 α — Phase 不合并(保 6 phase)

Phase 数量保持 6(`TRIAGE` / `SPEC` / `EXECUTE` / `VERIFY` / `SETTLE` / `DONE`)。

**Rejected**:β 方案(合并 EXECUTE + VERIFY 为单一 BUILD phase) —— worker
vs control 是不同性质,phase 边界承担「这段流程允许 fan-out 吗?」的语义
indicator,合并会破坏边界。

### C4 — `StateJson` 砍 3 字段 + `RegistryFile` 加 `active_tasks`

**`schemas.ts` StateJson**(`§12`):
- 砍 `current_task: TaskId | null`(worker active set 用 tasks.json filter)
- 砍 `current_step: AnyStep | null`(每 task 的 current step 用
  `task.execution.<step>.status === "running"` derive)
- 砍 `current_check: VerifyCheckKind | null`(VERIFY phase intent 由 sub_state
  精确表达,见 C8)

**DONE.* 终态 invariant**(L573-589):
- StateJson 内嵌 refine 只检查 `pending === null`
- Active-set 部分(`tasks.json` 无 `status="in_progress"`)由
  `transitions.ts` **cross-file invariant** 在 `loaf advance` / `loaf check
  tasks` 时强制
- 这意味着 §1 原则 3「Schema IS the contract」**让一档** —— Zod 单文件 schema
  不再是 100% 契约,部分 invariant 在实现层

**`RegistryFile`**(`§13`,TUI metadata):
- 砍同样 3 字段(state.json 的 mirror,跟着砍)
- 加 `active_tasks: z.array(TaskId).default([])` —— **derived projection**,
  由 loaf-cli 在 advance / transition 时 filter `tasks.json.tasks.status ===
  "in_progress"` 写入。TUI 启动单文件读到「这 session 在跑哪 N 个 task」,
  符合 §14 微秒级目标。

### C6 — `resume-pack.json` 加 `tasks_active_summary`

`state_snapshot` 现在不再 carry current_*。Resume 接力时如果只有 StateJson,
无法知道「上次中断时哪些 task 在跑、跑到哪一步」。

`schemas.ts §20` ResumePack 加:
```ts
TasksActiveSummary = z.object({
  task_id: TaskId,
  status: TaskStatus,
  current_step: z.string().nullable(),  // derive from task.execution
})

ResumePack = z.object({
  ...,
  state_snapshot: StateJson,
  tasks_active_summary: z.array(TasksActiveSummary).default([]),
  ...,
})
```

GateDiagnostic 没有 state_snapshot 字段(只 carry code/ref/vars 用于 repair),
所以**不需要**加 tasks_active_summary。C6 只影响 ResumePack。

### C9' — `RegistryFile` 加 `feature: string`(derived projection)

**Why now**:rev 4.0 砍 `current_task/step/check` 三字段后,fresh-context
设计走完 grilling 才识别出来:**StateJson 跟 RegistryFile 对 feature scope
identifier 的需求不对称**。

| 文件 | 路径 | reader 读时是否已知 feature name? |
|---|---|---|
| `.loaf/<feature>/state.json` | path **含** feature dir | ✅ 已知,一行 `path.basename(dir(file))` derive |
| `~/.loaf/registry/<session-id>.json` | path **不含** feature dir(只 session_id uuid) | ❌ 不知,reader 必须读字段否则要 N 次 readdir+parse |

TUI 启动 `readdir(~/.loaf/registry/)` 后想 single-file-read 拿 machine ID(`add-login-methods`),如果 RegistryFile 不 carry,**违反 §14 微秒级目标**(要 N 次 readdir + parse)。

**`schemas.ts §13`** RegistryFile:
```ts
feature: z.string().regex(/^[a-z][a-z0-9-]+$/).min(2)
```

**Cross-file invariant**(由 transitions.ts 强制): `RegistryFile.feature ===
path.basename(dirname(对应 state.json 文件))`。跟 `active_tasks: TaskId[]`
同 pattern(都是 derived projection cache,cli 写,reader 视为 cache)。

**StateJson 不加同字段**(见下 Alternatives 段)。

### C8 — `SubState` `VERIFY.check` 拆 4 个 check-specific

**`schemas.ts §1`** SubState enum:
- 砍 `"VERIFY.check"`
- 加 `"VERIFY.run"` / `"VERIFY.review"` / `"VERIFY.acceptance"` / `"VERIFY.visual"`
- 17 sub_state → 20 sub_state

**Why**:VERIFY 是 control phase,4 个 check kind(run / review / acceptance /
visual)是主 skill **serial** 跑的(整 feature 跑一遍,不 per-task);intent
「现在在跑哪个 check」**本质上就是 sub_state 该承担的语义**。原 rev 3.x 用
`VERIFY.check` 单一 sub_state + `current_check` 字段二分,**把状态机骨架本
应承担的 intent 推到了字段层**。

`PHASE_TRANSITIONS`(L1421-1449)同步 — `VERIFY.check` 单一 transition 拆 4
个,各自带 entry / exit / write_paths / next。

`reconcile.json`(`§18`)的 `verify_checks_status: Record<VerifyCheckKind,
VerifyCheckSnapshot>` **不动** —— map 结构基于 VerifyCheckKind enum(4 类),
跟 SubState 拆细独立。

## Why this is the right call

1. **SSOT 完美**:active set 真理源在 tasks.json(每个 task 自己的 status +
   execution.<step>.status),state.json 不再做 redundant mirror。
2. **fan-out 天然支持**:N 个 task 同时 `status="in_progress"` 是合法 tasks.json
   状态;state.current_task 单值表达不了的 mismatch 在 rev 4.0 model 下消失。
3. **VERIFY intent 显示精确**:TUI / gate-diagnostic / resume-pack 直接读
   sub_state 就能知道在跑哪个 check,无需 skill→TUI 旁路 channel(用户明确
   reject 的方案)。
4. **Phase 边界保留**(C1 α):worker vs control 性质不同,各管各的 model;
   TUI 看 phase 就能知道「这 session 是否在并发」。
5. **跟「最耗时是 EXECUTE,SPEC/VERIFY 轻量」这条朴素观察 align**:fan-out 只
   在 EXECUTE 阶段,其他 phase 不需要 worker model,protocol 也不该把 worker
   语义强加给它们。

## Consequences

### Positive

- StateJson schema 缩小(20 字段 → 17 字段),概念更纯
- RegistryFile 加 derived 字段,TUI 显示能力升级(per-session 一文件读)
- VERIFY phase 状态机骨架更精确(20 sub_state)
- Wang batch parallel(skill subagent fan-out)在 EXECUTE phase 100% 装得下,
  无 protocol gap
- Wang rule-candidate auto-promote(skill 编排 evidence + finding lifecycle)
  无 protocol surface 变更,完全 skill 层 emulate
- v1 模型对 Wang 类 SDD workflow 完整支持(唯一 §16 真砍的 multi-session 编排
  跟 fan-out 不冲突,Wang 实际不需要)

### Negative / Trade-offs

- **§1 原则 3 让一档**:Zod 不再 100% 契约,DONE.* active-set invariant 由
  transitions.ts 强制(cross-file Zod refine 不可表达)。这是真代价,但是
  「single-file Zod 表达力 vs SSOT 完美 + fan-out 天然」之间的取舍,后者更值。
- **transitions.ts** 责任更重(新 entity:cross-file invariant enforcer)。
  实现阶段需要明确这个模块的接口。
- **breaking schema** vs rev 3.2(`StateJson` 字段集 + `RegistryFile` 字段集
  + `SubState` enum)。v1 还没 implement,acceptable。

### Cross-file invariants 文档化清单

需要 transitions.ts 强制(rev 4.0 引入):

1. `state.phase ∈ DONE.* ⇒ tasks.json 中无 status="in_progress" 的 task`
2. `state.phase ∈ DONE.* ⇒ state.pending === null`(已在 Zod refine,这条留单
   文件 refine)
3. `RegistryFile.active_tasks === tasks.json.tasks.filter(in_progress).map(id)`
   (cache consistency,advance / transition 时由 loaf-cli 写)
4. `RegistryFile.feature === path.basename(dirname(对应 state.json 文件))`
   (C9' cache consistency,advance / `loaf start` 时由 loaf-cli 写)
5. **Fan-out 协议**(EXECUTE phase only):主 skill 在 fan-out 前先 atomic
   batch write「N task.status = in_progress」,fan-in 后 serial 写结果。详见
   `references/loaf-skill-helpers.md §4`。

## Alternatives Considered

### M:N — `task.execution` 集成 verify(rejected)

把 `run` + `review` 作为 step 加进每个 TaskExecution(behavioral/structural/
visual-ui/docs/chore 各加 2 字段),acceptance + visual 留 VERIFY phase。

**Rejected**:把 worker-style per-task model **强加到 control phase**(verify
是 feature-level serial check,不该 per-task 重复跑);6 个 TaskExecution shape
都要改,reconcile.json verify_checks_status 要拆嵌套(task_checks +
feature_checks),`review` step 跟 docs task 的 `review` step 命名撞,要 docs
rename `editorial-review`,改动量数倍于 C8 + sub_state 拆细路线。

### Phase 合并 β(EXECUTE + VERIFY → BUILD)— rejected

合并 EXECUTE + VERIFY 成单一 BUILD phase,task.execution 包含所有 step + verify。

**Rejected**:worker / control 性质不同,合并破坏 phase 边界承担的
「这段流程是否允许 fan-out」语义;state machine / sub_state / 17 → ? 重组,
影响面远超 rev 4.0 scope;长期 maintenance cost 高,**人类工程师 mental model
不再有 BUILD vs CHECK 分相**。

### `StateJson` 也加 `feature: string` 字段(rejected — 不对称设计代替)

C9' 走完 grilling 时,初始提议是 **StateJson + RegistryFile 都加 `feature`
字段**。fresh-context 重新走 deletion test 后 reject 「StateJson 也加」:

- StateJson 在 `.loaf/<feature>/state.json`,**reader 已知文件路径**
- caller 想 query feature name → `path.basename(path.dirname(stateJsonPath))`
  一行解决
- 加字段是**真冗余**(violates SSOT —— `.loaf/<feature>/` dir name 已是真理源)
- Hyrum's Law +1 没有对应硬场景 justify

不对称设计(RegistryFile 加 / StateJson 不加)的关键洞察是 **path context
是否已 carry 信息** —— RegistryFile path(在 `~/.loaf/registry/`)不 carry
feature,StateJson path(在 `.loaf/<feature>/`)carry,所以前者需要字段后者
不需要。

历史:grilling 中曾尝试用「SSOT 破」论点 reject 整个 C9,后被 user push back
矫正(derived projection + cross-file invariant enforcement 不算 SSOT 破,
跟已接受的 `RegistryFile.active_tasks` 同 pattern)。最终走到不对称设计。

### `state.current_task` 改 `array`(rejected)

把 single-value 改成 array 直接 carry N 个并发 task。

**Rejected**:违反 SSOT(tasks.json 已经 carry,state 重复 store);
`current_task` 字段语义 conflate「worker active set」vs「control cursor」;
连锁改动(`current_step` / `current_check` 同需改 array,DONE.* refine,
所有 hook / advance / TUI 读写路径)。

详见 grilling 历史:用户最终自己 reject,选了 M:1 + sub_state 拆细路线。

## Follow-ups(pending)

- **rev 4.0 commit**:把 schemas.ts / protocol.md / protocol.html / ADR-0002 /
  references/loaf-skill-helpers.md §4 / memory 一起 commit
- **transitions.ts 文档化**:cross-file invariant enforcer 模块的接口设计,
  在实现阶段 v1.0.0 之前确认
- **loaf-skill scaffolding**:fan-out 协议(`references/loaf-skill-helpers.md
  §4`)是 loaf-skill 的首发能力之一,跟 flatten / warn / decomposition-default
  并列。等 v1.0.0 GA 后开始
- **memory 同步**:新加 `project_loaf_cli_phase_typology.md`,跨 session 持
  worker vs control phase 原则;关联 ADR-0002
