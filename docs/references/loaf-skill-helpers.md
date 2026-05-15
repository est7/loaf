# loaf-skill — planned helpers

> **Status**: design intent. loaf-skill is the middle layer in the
> three-tier architecture (`protocol.md` §19):
>
> ```
> loaf-cli (protocol core)
>   → loaf-skill (workflow orchestration)
>     → 3rd-party workflow skill (domain dialogue)
> ```
>
> These capabilities were surfaced during loaf-cli v1 (rev 3.1) design
> grilling and are deliberately **NOT** implemented in loaf-cli itself.
> Each entry below is a future loaf-skill responsibility, recorded here
> so that when loaf-skill scaffolding begins (post v1.0.0 GA), these
> requirements are not re-discovered or re-litigated.

## 1. `flatten` — hierarchical intent → DAG `tasks.json`

### Why this lives in loaf-skill

3rd-party workflow skills (Wang, GSD, openspec, ad-hoc team workflows)
naturally think in hierarchical terms: "this work breaks into 3
deliverables, each into 4-5 leaf tasks, with an integration verify on
top." `loaf-cli` expresses task relationships as a DAG via `depends_on`
only — no `parent_task_id`, no tree fields. See
`adr/0001-task-graph-is-dag-not-tree.md` for the load-bearing rationale.

Without a shared helper, each workflow skill would reimplement the
hierarchical → DAG transformation. That is a `shape transformation`
(structure of `tasks.json`), not domain content, so it belongs in
loaf-skill, not in each domain skill.

### Input (free-form, skill-defined)

Hierarchical intent. Example shape (skills may use any nested form):

```text
Group G-007: OAuth refresh integration
├─ leaf  T-007a  drives REQ-OAUTH-001  (refresh token endpoint)
├─ leaf  T-007b  drives REQ-OAUTH-002  (refresh interceptor)
├─ leaf  T-007c  drives REQ-OAUTH-003  (persistent storage)
└─ integration   verify end-to-end refresh flow across the three above
```

### Output (conforms to `tasks.json` schema)

Flat `Task[]`:

- N independent leaf tasks (no inter-`depends_on`, only external if any)
- 1 integration task with
  `depends_on: [T-007a, T-007b, T-007c]`, `kind: "structural"` (or
  skill-chosen kind), and integration test list / no_test_rationale
- All members carry `labels: ["group:G-007"]`
- Integration task additionally carries `labels: ["integration"]`

### `labels[]` namespace registry (maintained by loaf-skill)

| namespace prefix | meaning | example |
|---|---|---|
| `group:<id>` | tasks belong to same workflow-defined group / flatten output | `group:G-007` |
| `integration` | integration / aggregation task (no value) | — |
| `parent-of:<id>` | **RESERVED — do not use.** Tree semantics rejected by ADR-0001. | — |
| `parent:<id>` | **RESERVED — do not use.** Same. | — |

`loaf-cli` does NOT parse `labels[]` semantically — it only validates
they are `string[]`. Convention enforcement lives in loaf-skill.

### Runtime split (mid-execution decomposition)

When a workflow skill decides an in-progress task is too large:

- Original task → `status: "abandoned"` (existing enum, no new state)
- New leaf tasks + integration task emitted via `flatten`
- Finding raised with `action: "amend-tasks"` (§1 principle 13)
- Original evidence preserved in `evidence.jsonl` (append-only invariant)
- Reconcile coverage counts only the new children; abandoned task drops
  out of coverage by virtue of `status="abandoned"`

## 2. `warn` — soft suggestion (advisory only, no block)

### Why this lives in loaf-skill

loaf-cli v1 (rev 3.1) deliberately removed `should` from the protocol
layer. All protocol-level checks are MUST / MAY only (`Applicability`
3-tier: `must / optional / na`). But workflows frequently need soft
advice ("you should make this task smaller", "consider adding a visual
contract for this REQ", "you've decomposed into 12 tasks — usually a
sign of over-decomposition").

loaf-skill provides a `warn` mechanism:

- Workflow skill emits advisory text via a shared helper
- loaf-skill renders to stderr / TUI as a warning prefix
- User can ignore freely — no gate, no block, no exit code change

### Memory anchor

`~/.claude/projects/-Users-est9-MyPluginRepo-1st-cc-plugin/memory/project_loaf_skill_soft_suggestion.md`

## 3. `decomposition-default` — coarse-over-fine bias

### Why this lives in loaf-skill

LLM over-decomposition is a documented failure mode (memory entry below).
loaf-cli v1 (rev 3.1) initially carried this as
`constitution.decomposition_preference: "coarse"` in `loaf.config.json`,
plus `max_tasks_warning_threshold`. ADR-0001 establishes these are
workflow content, not protocol shape (§1 principle 14: 协议管 shape,
skill 管 content). Their removal from v1 schema is a separate pending
decision (see ADR-0001 "Open follow-ups").

Once removed, loaf-skill carries:

- Default coarse bias in `newloaf:spec` prompt template
- Stderr warning when emitted `tasks.json` exceeds N tasks (N = 8 by
  current convention, configurable in loaf-skill prompt — not in
  protocol)
- 3rd-party workflow skills may override per-workflow (e.g. a "rapid
  prototyping" skill might prefer `balanced` or `fine`)

### Memory anchor

`~/.claude/projects/-Users-est9-MyPluginRepo-1st-cc-plugin/memory/project_loaf_skill_decomposition_coarse.md`

(This memory entry will need updating when the loaf-cli field is
formally removed — from "loaf-cli config default" to "loaf-skill prompt
default.")

## 4. `fan-out` 协议 —— EXECUTE phase 并发编排(rev 4.0 新)

### Why this lives in loaf-skill

rev 4.0(ADR-0002)确立的根本原则:**fan-out 只在 worker phase**(EXECUTE)。
EXECUTE 阶段是 session 中**最耗时**的部分(实际写代码 / 跑测试 / 改文件),允许
主 skill fan-out N 个 subagent 并发跑互不依赖的 leaf task,**真节省时间**。其它
phase(TRIAGE / SPEC / VERIFY / SETTLE)是 control phase,主 skill serial,
轻量。

loaf-cli 在 rev 4.0 model 下**协议支持 worker active set 多元素**(tasks.json
可同时有 N 个 `status="in_progress"`),但**编排责任在 loaf-skill** —— 协议
不感知 subagent / 并发数 / write scope 隔离这些 workflow concern。

### 协议要求(rev 4.0 cross-file invariant,见 ADR-0002)

主 skill 在 EXECUTE 阶段做 fan-out,**必须遵守以下 4 步 sequence**:

1. **选择 ready leaf 批次**(skill 内部决策,protocol 不感知)
   - 从 `tasks.json` 读出 `status="pending"` 且 `depends_on` 全 `done` 的 task
   - 检查互不冲突:写入 scope(由 `STEP_WRITE_PATHS_BY_KIND[kind][step]` +
     `loaf.config.json.paths.*` 并集 derive)不重叠
   - 选 N 个(典型 2-4,Wang convention;loaf-skill 内部可配)
2. **Atomic batch transition**:主 skill **串行**调用
   `loaf tasks step start --task T-X --step <s>` N 次,把 N 个 task 的
   `status` 从 `pending` 改成 `in_progress`,并设各自起始 step
   `task.execution.<step>.status="running"`。这一步**单线程**,无 race,
   loaf-cli `advance` 校验 transition 合法性。
3. **Fan-out N subagent**:主 skill 启动 N 个 subagent(LLM 推理层并发),
   每个 subagent 负责一个 task:
   - 读 task.drives / task.execution / spec.md / 现有 evidence
   - 跑副作用(写代码 / 跑测试,**只改自己 task 的 write scope**)
   - **不直接写 loaf artifact**(避免 race) —— 返回 result 给主 skill
4. **Fan-in 串行写**:主 skill 收齐 N 个 subagent result 后,**串行**调用
   `loaf evidence add` + `loaf tasks step done` + 必要时 `loaf finding raise`,
   把 N 个 task 的 step 进展回写 tasks.json + evidence.jsonl + findings.jsonl。
   这一步**单线程**,无 race。回 step 1 选下一批。

### 关键 invariant(loaf-skill 文档化 + 自检)

- **Side effects 真并发**(step 3 subagent 跑代码 / 跑测试)
- **loaf artifact 写入永远 serial**(step 2 + step 4 主 skill 单线程)
- **Write scope 不重叠**(step 1 选批次时确认)— Wang 「ready 要求:写入范围
  不冲突」的本意
- **失败处理**:若 subagent A 跑挂(报错 / 超时),fan-in 时主 skill 调
  `loaf finding raise --category test-defect --refs T-A`,然后用 `amend-tasks`
  action 回 EXECUTE.work 重跑

### 反例 ——`fan-out` 在其它 phase 永远 NOT allowed

| Phase | 为什么不 fan-out |
|---|---|
| TRIAGE | Scoring 是单一判断,主 skill 一线 |
| SPEC | spec.md / plan / design 是单一 narrative;多 subagent 并发产 fragment 会互相打架 EARS REQ |
| VERIFY | 4 个 check 是 feature-level serial check;并发跑 check 不会更快,顺序由 applicability 驱动;intent 由 sub_state 表达(rev 4.0 `VERIFY.run / .review / .acceptance / .visual`) |
| SETTLE | reconcile 是聚合操作 scan 全 evidence + tasks + findings;lessons 是 narrative 提炼 |
| DONE | 终态,无 work |

### 配套 memory

`~/.claude/projects/-Users-est9-MyPluginRepo-1st-cc-plugin/memory/project_loaf_cli_phase_typology.md`
跨 session 持「worker vs control phase」原则。

## 5. PRESETS 4 档 — rev 5.x 设计决策

> **Status**: rev 5.x 决策记录(2026-05-15,driven by 4-profile design
> grilling w/ codex)。loaf-skill 实际 PRESETS 表实现时按此落点。

### 4 档单调递增 ceremony

```ts
const PRESETS: Record<string, Ceremony> = {
  quick: {
    spec_phase: false, verify_phase: false, settle_phase: false,
    strict_spec_review: false, lessons_required: "skip", strict_drift_check: false,
  },
  light: {
    spec_phase: true,  verify_phase: false, settle_phase: false,
    strict_spec_review: false, lessons_required: "skip", strict_drift_check: false,
  },
  standard: {
    spec_phase: true,  verify_phase: true,  settle_phase: false,  // rev 5.x: SETTLE 砍
    strict_spec_review: false, lessons_required: "skip", strict_drift_check: false,
  },
  deep: {
    spec_phase: true,  verify_phase: true,  settle_phase: true,
    strict_spec_review: true, lessons_required: "must", strict_drift_check: true,
  },
};
```

### 设计原则

**每档加一件事**:
- `quick`(EXECUTE 直跳 DONE,verify-min @ deliver 兜底)
- → `light`(+SPEC,跳 VERIFY/SETTLE)
- → `standard`(+VERIFY,跳 SETTLE)
- → `deep`(+SETTLE + strict 三件套)

### 关键决策(为什么 standard 砍 SETTLE)

之前 standard 默认 `settle_phase=true + lessons_required="may"`,但 strict
三件套(`strict_spec_review` / `strict_drift_check` / `lessons_required=must`)
都默认 false / "may"。这意味着 standard 跑 SETTLE.reconcile + SETTLE.lessons
**只产数据不 enforce**,sub_state 走过场——`reconcile.json` 在 standard
仅 audit view,verify-accept gate 已经实时计算(不读 reconcile),lessons.md
默认可空。

rev 5.0 起 reconcile.json 是 reducer-derived(数据全在 journal),需要 audit
时走 `loaf doctor --rebuild` 即可重算落盘。所以让 standard 多跑一个
`loaf settle` 命令 + 多一个 phase 心智负担,换不被 enforce 的 audit view,
ROI 不划算。SETTLE 移到 deep 独占,作为 deep 的差异化卖点(audit + lessons
+ strict drift 三件套整体打包)。

### 关键决策(为什么不加 ceremony.tdd_strict)

discussion 期间提过把 TDD 严格度从 `constitution.tdd_strictness` 软配置
上移到 `ceremony.tdd_strict` 硬 flag,与 standard/deep label 绑定。**否决**。

理由:
1. **TDD 是工程方法偏好,不是协议完成态的必要不变量**。把 policy choice 混
   进 protocol shape 增加长期 schema 成本(Hyrum's Law:`tdd_strict` 一旦
   作为 ceremony 字段暴露,任何 3rd-party skill 或 tooling 都会读它,后续
   想砍/调整都成 breaking)。
2. **反例:legacy migration / generated code / SDK integration / UI glue**
   经常需要 `standard` VERIFY 但不适合 red-first(snapshot test 先于
   refactor 才是该场景的正确 discipline)。`tdd_strict=true` 跟 standard
   绑死会卡这些用户。
3. **协议层已经有客观硬约束**:`behavioral + labels=["bug"]` → register-red
   是 bugfix 防回归的底线。这条 CLI mutator 已 enforce。non-bug behavioral
   的 RED-first 由 skill prompt + team review + `constitution.tdd_strictness`
   软配置三层协同,**不需要协议层介入**。

未来若出现「跨 skill 必须机器可验证一致的 TDD enforce 需求」,走独立
command/check 路径(类似 `loaf tasks register-red`),不塞进 Ceremony
schema——保护 ceremony 6 flag 维持「phase 跑不跑」的语义内聚性。

### loaf-skill PRESETS API 草案

```ts
// loaf-skill 期望提供:
function resolvePreset(score: number): { label: string; ceremony: Ceremony } {
  if (score < 20)  return { label: "quick",    ceremony: PRESETS.quick };
  if (score < 40)  return { label: "light",    ceremony: PRESETS.light };
  if (score < 70)  return { label: "standard", ceremony: PRESETS.standard };
  return            { label: "deep",     ceremony: PRESETS.deep };
}

// `loaf start` 调用:
const { label, ceremony } = resolvePreset(score);
await loaf.start({
  ceremonyJson: JSON.stringify(ceremony),
  ceremonyLabel: label,  // cosmetic only, CLI does not parse
});
```

3rd-party skill(cursor-loaf / windsurf-loaf / 自定义)可起任意 preset 名
(`prototype / feature / release` / `fast-fix / full-feature / regulatory` /
等等),只要每档落到合法的 `Ceremony` object 即可。CLI 完全不解析 label。

---

## What does NOT live in loaf-skill

These were considered during the same grilling pass and ruled out of
both loaf-cli AND loaf-skill — they're outside loaf's scope entirely:

- **Sprint / milestone / epic containers**: PM workflow, not SDD
  workflow. Workflow skills needing Sprint semantics maintain own state
  outside loaf (`.wang/sprint-2026-W19.json`, external tracker, etc.)
- **Parallel `batch` execution (2-4 concurrent leaf TK)**: explicit
  loaf-cli v1 non-goal (§16). Workflow skills degrade to serial; if
  parallelism is critical, that's an orchestration-layer concern
  (multi-worker dispatch), not SDD protocol concern.
- **`Rule-candidate` auto-promotion**: Wang's "immediately harden
  high-impact review finding into script + unit test + check-fast" is
  an automation concern. v1 non-goal (`loaf lessons promote`). Skills
  may flag rule-candidate intent in `lessons.md` notes, but
  materialization is user/CI responsibility.
- **Review round counter / fuse**: Wang's "轮次 > 5 熔断" — loaf-cli
  has `state.iteration` (general) but no round-kind-specific fuse.
  Workflow skills may track their own fuse if desired; not protocol.
