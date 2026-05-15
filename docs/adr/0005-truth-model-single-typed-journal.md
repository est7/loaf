# ADR-0005 — rev 5.0: N10 truth model locked = (γ) 单 typed journal

- Status: **Accepted with implementation gates** (rev 4, codex audit r3 verdict)
- Date: 2026-05-14
- Scope: loaf-cli protocol kernel (rev 4.3 → rev 5.0; v1 frozen 第五次 unfreeze;
  SCHEMA_VERSION bump 1 → 2 — 见 §5.2 兼容策略)
- Supersedes:
  - `protocol.md` §16 `state.json event sourcing` non-goal 条款（部分翻牌）
  - `protocol.md` §4.1 `state.json(单源真理)` 单源真理定位（state.json 降级为派生投影）
  - `protocol.md` §11.2 N-file lock 模型（lock 保留，但 mutation transaction 改为 preflight validate + sidecar prepare + final validate + journal append + projection 多阶段 crash contract）
  - `schemas.ts §34 CONCURRENCY_INVARIANTS` 多 artifact 写入纪律（统一为 single-journal append + sidecar discipline）
- Related:
  - `protocol.md` §1 / §4.1-§4.12 / §10.8 / §10.15 / §11.2 / §13.1 / §15 / §16 / §17
  - `schemas.ts` revision history rev 5.0；`§34 CONCURRENCY_INVARIANTS`
  - `src/spike/*.ts` → `src/core/*.ts`
  - `tests/spike/*.test.ts` → `tests/core/*.test.ts`
  - `skills/CONTRACT.md`（loaf-skill 边界）
  - ADR-0001 / ADR-0002 / ADR-0003 / ADR-0004
  - `docs/moni-review.md`

### Audit history

- **rev 1**（2026-05-14 first draft）：三方 audit 12 条盲点收口 + N10 元决策落地
- **rev 2**（codex audit r1）：抓出 2 blocker + 5 high + 2 new blind spots (N13/N14) + 4 medium；全口径吸纳
- **rev 3**（codex audit r2）：抓出 rev 2 引入的 3 新 blocker（batch atomicity / reducer preflight order / migration overpromise）+ 4 high + 4 medium + plan 重估 22-25d；全口径吸纳
- **rev 4**（codex audit r3）：抓出 rev 3 剩余 2 blocker（N19 migration entry 超 64KB / N20 sidecar 后缺 final validation）+ 4 high + 4 medium + plan 重估 25-27d；全口径吸纳。codex 表态：N19/N20 修后可从 Proposed 升 Accepted-with-implementation-gates
- **rev 4 final**（codex audit r4 verdict）：**Accepted with implementation gates**。剩余 2 medium（step 数 doc drift / validateTransition helper 应列为显式 gate）+ 3 nit（checksum 双字段 OK / migration sidecar 命名 OK / step 5d 比较范围限定）全部 cleanup 后 lock；§11 新增 Implementation Gates 章节
- **rev 4.4 erratum**（2026-05-15，codex audit r5 / 写代码前最后一审）：纯 doc erratum,**决策不变**。两处 stale "11 步"(§5.1 §11.2 row + §5.2 §34 row)改为 "10 步" 与 §3.5 / §10 / 落地 protocol+schemas 对齐。三处实现盲点(plan.md 步序错乱 / plan.md 不存在的 envelope 字段 / protocol.md 残留 9-step batch 路径)+ 两处 wording drift(§4.4 `<EV-id>` → `<entry_id>` / §10.15 schema_version=1 → 2)+ 一处 schemas.ts 旧 step ref 在 sibling `docs/{plan,protocol,schemas}.md|.ts` 修复,**ADR §3 / §4 / §6 / §10 实质内容不动**。详 audit msg `2026-05-15T05-45-17.906Z_pid9885_f70cfc00`(`.agent-mail/audit/`)。

## 1. Context

### 1.1 触发

rev 4.3 GA freeze 前的最后一次扫雷：三方 audit + codex 对 ADR 的三轮 audit。
codex round 2 抓出元决策 N10：

> protocol.md §16 写 `state.json event sourcing` 是 v1 non-goal，
> 但 `src/spike/*.ts` 已经实质 ES 化。文档与实现的 truth model 分裂。

### 1.2 之前的 truth model 演化

- **legacy Python 原型**：N-file，state.json 直写
- **rev 4.0**（ADR-0002）：N-file + fan-out 引入
- **rev 4.1**（ADR-0003）：per-feature `.lock` 仲裁
- **rev 4.3**（ADR-0004）：CLI surface + batch transaction 三纪律
- **spike 平行演进**：events.jsonl + reducer + snapshot 派生，未正式收编

### 1.3 audit 收集的盲点（共 18 条 + 多轮 codex 修订）

| 编号 | 提出 | 内容 | 最终归宿 |
|---|---|---|---|
| B1 | claude#2 | actor 无 prefix refine | §4.1 / Blocker |
| B2 | codex#1 | reducer 不查 ceremony | §4.2 / Blocker |
| B3 | claude#3 | tasks_submitted 盲替换 | §4.3 / Blocker |
| H1 | codex#2 | fan-out 写权分裂 | §4.4 / doc cleanup |
| H2 | gemini#1 | user-answer 不进 audit | §4.5 / snapshot 投影 |
| H3 | claude#1 | EVENT_BYTE_LIMIT 隐墙 | §4.6 / Blocker |
| M1 | codex#3 | spike pre-ready | §4.7 / High |
| M2 | gemini#2 | spec_version 改 hash | §4.8 / drop |
| M3 | gemini#3 | strict_drift_check 无 enforcement | §4.9 / High |
| N10 | codex r2 | truth model 元决策 | §2 + 全 ADR |
| N11 | claude r2 | at monotonic | §4.11 / High |
| B5 | gemini r2 | reconcile deadlock | §4.12 / drop deadlock，保留 lock contention 限制 |
| N13 | codex ADR r1 | tail-corruption | §4.13 / Blocker |
| N14 | codex ADR r1 | lock 串行化限制声明 | §3.5 + §4.14 |
| N15 | codex ADR r2 | batch + tail recovery 矛盾 | §3.2 batch_id + §4.13 + §4.16 / Blocker |
| N16 | codex ADR r2 | envelope 缺 entry schema version | §3.2 + §4.17 / High |
| N17 | codex ADR r2 | migration: actor 绕过 refine | §3.4 + §4.18 / High |
| N18 | codex ADR r2 | reader stale read contract | §3.6 + §4.19 / Medium |
| **N19** | **codex ADR r3** | **migration entry 超 64KB** | **§3.2 + §5.2 sidecar / Blocker** |
| **N20** | **codex ADR r3** | **sidecar 后缺 final validation** | **§3.5 step 5 / Blocker** |

## 2. Decision

### 2.1 主决策

**v0.1.0 truth model = (γ) 单 typed journal**。

每 feature 一个 `.loaf/<feature>/journal.jsonl`；所有 protocol-level 状态变化
和领域 artifact 通过 **typed entry** 追加；snapshots/ 目录存 reducer 派生
投影；attachments/ 目录存 sidecar 大字段（含 migration import artifacts）。

### 2.2 拒绝的替代方案

| 方案 | 否决理由 |
|---|---|
| **N-file 保持现状** | rev 4.0 fan-out 下跨文件原子性脆弱；spike 已实质 ES 化 |
| **(α) 纯 ES + 单 events.jsonl** | "万物皆 event" 把 evidence/findings 塞进 event payload，sidecar 复杂度 + event kind 爆炸 |
| **(β) 多 ledger ES** | 跨 ledger 事务依赖写顺序 + orphan cleanup；reducer 读 union of N files 时间戳 drift 是真问题 |

(γ) 仍需多阶段 crash contract（§3.5）——sidecar / snapshot / registry 跨文件
依然存在；rev 1 误写"无需 orphan cleanup"，rev 2+ 已修正。

## 3. (γ) Architecture

### 3.1 文件布局

```
.loaf/<feature>/
├── journal.jsonl              # SSoT,append-only,typed entries with batch markers
├── attachments/               # sidecar 目录(per-entry,per-field)
│   ├── JE-000000/             # migration entry sidecar(rev 4 N19 新形态)
│   │   └── migration/
│   │       ├── state.json     # v0.0.x state.json content
│   │       ├── tasks.json
│   │       ├── spec.md
│   │       ├── evidence.jsonl
│   │       ├── findings.jsonl
│   │       └── pending.json
│   ├── JE-000123/             # 普通 entry sidecar
│   │   └── summary.txt
│   └── JE-000456/
│       └── description.md
├── snapshots/                 # reducer 派生(读优化 cache,可重建)
│   ├── state.json             # phase + sub_state + ceremony + iteration
│   ├── tasks.json             # task graph snapshot
│   ├── evidence.json          # evidence ledger view + 派生 gate-decision view
│   ├── findings.json          # findings list view
│   ├── pending.json           # pending queue view (含 resolved_log slice)
│   ├── reconcile.json         # drift snapshot (SETTLE 阶段产)
│   ├── gate-diagnostic.json   # gate 失败时的结构化诊断快照 (按需重建)
│   ├── resume-pack.json       # `loaf handoff` 输出的接力快照
│   └── _meta.json             # 一致性元数据,见 §3.6 reader contract
├── spec.md                    # 派生投影(reducer 从 event:spec_* 重建)
├── lessons.md                 # 派生投影(SETTLE 最终态)
├── .lock                      # per-feature flock
└── ../<feature>.backup-v1/    # v0.0.x → v0.1.0 迁移时 backup
```

`snapshots/` 与 `spec.md` / `lessons.md` 是**派生投影**；SSoT 永远是
`journal.jsonl` + `attachments/`。

`_meta.json` schema（**rev 4 N21 加入 read-repair**）：

```ts
type SnapshotMeta = {
  last_applied_seq: number;          // 增量 rebuild 起点
  last_entry_offset: number;         // journal.jsonl byte offset 至 last_applied_seq 末
  last_entry_line_hash: string;      // sha256(last entry full line);startup fast check 用
  rolling_checksum: string;          // sha256 of (prev_checksum || entry_line) chain;full verify 用
  feature_schema_version: number;    // 当前 .loaf/<feature> 的 schema_version(rev 5.0 = 2)
  written_at: TimestampISO;
};
```

**Checksum 两级语义（rev 4 H 修复）**：
- **Startup fast check**：reader 启动时只验 `last_entry_offset` + `last_entry_line_hash`（O(1)）。能发现 tail 不一致 / journal 被 truncate / last entry 被改
- **Full chain verify**：`loaf doctor --verify-checksum` 重算整链（O(N)）。能发现 journal 中段被改
- Fast check fail → CLI exit 2 `SNAPSHOT_STALE_REBUILD_REQUIRED`，提示 `loaf doctor --rebuild`（rev 4 N21）
- Fast check 不是"完整 corruption detection"，只是 lightweight tail sanity；full verify 是 explicit user operation

### 3.2 Entry envelope

```ts
type JournalEntry = {
  // Identity & ordering
  seq: number;                        // 单调递增;严格 +1 invariant
  entry_id: string;                   // "JE-" + zero-padded seq;sidecar 目录名
  at: TimestampISO;                   // wall-clock ISO 8601;at ≥ prev.at invariant
  actor: ActorString;                 // CLI 注入,见 §3.4
  entry_schema_version: number;       // per-entry schema version(rev 4 N16 改名);upcaster keyed by (kind, entry_schema_version)

  // Domain
  kind: EntryKind;                    // namespaced;见 §3.3
  payload: EntryPayload;              // union by kind;Zod refine on (kind, payload) pair

  // Batch markers(rev 3 N15;只在 multi-entry batch 中出现)
  batch_id?: string;                  // UUID;同一 batch 所有 entry 共享
  batch_index?: number;               // 0-based
  batch_count?: number;               // batch 总 entry 数

  // Optional crypto
  signature?: SignatureEnvelope;      // v0.1.0 reserve
};

type AttachmentRef = {
  path: string;                       // "attachments/JE-<seq>/<...subpath>"
  sha256: string;                     // attachment 内容 sha256
  size: number;                       // attachment byte count
};
```

**字段命名约定（rev 4 修复）**：
- `entry_schema_version`：per-entry schema version（envelope 字段）
- `feature_schema_version`：feature-level 当前 schema 版本（在 SnapshotMeta）
- `SCHEMA_VERSION`：envelope shape 级常量（在 schemas.ts）

三者职责分明，不再同名冲突。

byte limit per entry：64KB。LongTextField 超 8KB → sidecar `attachments/<entry_id>/<field>.<ext>`。

#### Batch entry semantics

`batch_id` UUID；`batch_index` 0..N-1；`batch_count` 总数。Tail recovery 必须
batch-aware（§4.13）：incomplete batch（末 entry partial 或 `batch_index <
batch_count - 1`）→ truncate 整个 batch。

### 3.3 Kind 命名空间

```
# State machine transitions
event:phase_advanced          # 非 gate 类 transition(SPEC.spec → SPEC.plan 等)
event:ceremony_set
event:tasks_planned
event:tasks_amended
event:task_claimed
event:task_step_started
event:task_step_done
event:task_abandoned
event:spec_req_added
event:spec_scenario_added
event:spec_visual_added
event:spec_submitted

# Domain ledger entries
evidence:added                # kind ∈ {test, review, visual, manual, waiver}
                              # rev 3:删除 gate-decision 子类型
finding:raised
finding:closed
pending:added
pending:resolved

# Human gates(REQUIRE human: actor;隐式 state transition,rev 3)
gate:decided                  # gate_kind: spec-lock | verify-accept
                              # 通过 loaf gate decide 写入
                              # **rev 4**:transition 校验复用 event:phase_advanced
                              # 同套 LEGAL_TRANSITIONS validator(同一逻辑,不同 kind 入口)

# Session lifecycle
session:started               # 仅 seq=0 且 journal empty 时合法
session:resumed
session:delivered             # verify-min basis(quick) / SETTLE basis(standard+)
session:archived              # reason 必填
session:abandoned             # reason 必填

# Spike branch closure
spike:converted               # convert_target: F-N 新 feature scaffold

# Migration(v0.0.x → v0.1.0 lossy snapshot import)
migration:snapshot_imported   # 仅 actor migration:* 且 journal seq=0/1 时合法
                              # rev 4:payload 改为 manifest(refs),artifacts 全 sidecar 化
```

**`gate:decided` 隐式 transition 详细（rev 4 H 修复）**：

reducer apply `gate:decided` 时，**复用** `event:phase_advanced` 的同一套
`LEGAL_TRANSITIONS` validator。区别仅在 `kind/payload` 入口；transition 表的
source/target 映射对两种 kind 一致。

| gate_kind | source sub_state | target sub_state |
|---|---|---|
| `spec-lock` | `SPEC.design` | `EXECUTE.plan` |
| `verify-accept` | `VERIFY.accept` | `SETTLE.reconcile` |

**注意**：quick profile **不**经过 verify-accept gate——quick 的 deliver 路径
是 `EXECUTE.done` 直接 `session:delivered`，无 gate（rev 4 nit 修复）。

Evidence projection（`snapshots/evidence.json`）中的 gate-decision view 由
reducer 从 `gate:decided` entries **派生**——legacy v0.0.x evidence 中的
gate-decision entries 通过 §5.2 migration payload 投影到同一 view，新的
gate decision 必须走 `gate:decided`。

### 3.4 Actor authority

```ts
type ActorString =
  | `human:${string}`
  | `skill:${string}`
  | `ci:${string}`
  | `cli:${string}`
  | `migration:${string}`;  // 仅 migration window
```

- CLI 自动注入 actor；`--actor` flag 不接受
- 注入规则：`human:` ← isatty + $USER；`skill:` ← SessionStart hook payload；
  `ci:` ← CI env；`cli:` ← fallback；`migration:` ← `loaf doctor --migrate-v2`

| Kind | 允许 actor prefix |
|---|---|
| `gate:decided` | `human:` only |
| `evidence:added` (payload.kind ∈ {manual, waiver}) | `human:` only |
| `session:archived` / `session:abandoned` / `session:delivered` | `human:` only |
| `spike:converted` | `human:` only |
| `migration:snapshot_imported` | `migration:` only |
| 其他 mutator kinds | `human:` / `skill:` / `ci:` / `cli:` |

**`migration:` 不能用于任何非 migration kind**——schema 闭环保护。

### 3.5 Lock 模型 + Multi-step crash contract（**rev 4 step 5 final validate**）

#### Lock 基本契约

- `lock_path: .loaf/<feature>/.lock`：per-feature flock
- 一 feature 一时刻一写者
- **N14 限制声明**：fan-out 下多 worker 并行只是**执行并发**，不是 mutation
  并发。所有 mutator 通过 per-feature lock 串行化；throughput 受 lock 窗口 +
  reducer + snapshot rebuild + sidecar I/O 总成本约束

#### Multi-step mutation transaction（**rev 4：10 步，step 5 final validate**）

每个 mutator 在 lock 内执行；任一步骤 fail 释放 lock，journal 未 append，外部
reader 看不到部分状态：

```
1. acquire .lock(blocking,≤30s;超时 LOCK_TIMEOUT exit 2)

2. read journal.jsonl tail + snapshots/_meta.json
   2a. 校验 _meta.last_applied_seq + last_entry_offset + last_entry_line_hash
       vs journal tail(O(1) fast check)
   2b. mismatch → 释放 lock,prompt loaf doctor --rebuild,exit 2 SNAPSHOT_STALE_REBUILD_REQUIRED

3. preflight validate(rev 3 B2-rev2 修复;**仍是 candidate entries WITHOUT 最终
   sidecar refs**):
   3a. Zod parse candidate entries(占位 AttachmentRef.sha256/path/size)
   3b. cross-kind / sub_state / mutation_rights / actor refine
   3c. dry-run reducer apply on in-memory state 副本
   3d. 若任一 candidate fail → abort,不做 step 4 起任何 I/O
   3e. 若 batch:assign batch_id = uuid(),index/count

4. prepare sidecar files(if LongTextField > 8KB):
   4a. write attachments/<entry_id>/<field>.<ext>.tmp-<random>
   4b. fsync attachment file + parent dir
   4c. atomic rename → final path
   4d. compute sha256,write entry payload AttachmentRef.{path,sha256,size}

5. **final validation(rev 4 N20 修复;append 前最后校验)**:
   5a. re-Zod-parse entries with **embedded final** AttachmentRef
   5b. byte-size check(每条 entry serialized ≤ 64KB;batch 总 ≤ 64KB)
   5c. final dry-run reducer apply with final entries
   5d. 应与 step 3c 结果一致(sidecar embed 是 deterministic);**比较范围限定**
       为 reducer-visible state transition result + emitted projections,不做
       byte-for-byte payload 比对(sidecar ref 填充会让 payload 必然 diff);
       若 reducer-visible 结果 diff → abort + log SIDECAR_VALIDATION_DRIFT
       (实现 bug 指示)
   5e. 若 batch 中任一 entry 校验 fail → abort 整批,sidecar tmp 清扫,journal 未变

6. append journal entry(or batch):
   6a. single write(): all-entries 拼接(\n 分隔),总 size ≤ 64KB
   6b. fsync journal.jsonl

7. post-apply assert(rev 3:不再 abort,纯 corruption assert):
   7a. reducer apply candidate entries to in-memory state(已 final-validated)
   7b. 若 apply 抛错 → 这是 bug(step 5 应已抓到),log + doctor 标记 corruption,
       但不 rollback journal(journal 已是事实)

8. rebuild affected snapshots(tmp+atomic rename per file):
   8a. write snapshots/<file>.json.tmp-<random>
   8b. fsync + atomic rename
   8c. update snapshots/_meta.json(last_applied_seq, last_entry_offset,
       last_entry_line_hash, rolling_checksum extend)

9. refresh registry projection(~/.loaf/registry/<id>.json,tmp+rename)

10. release .lock(unlink + close)
```

**核心修正（rev 4）**：step 5 final validate **修复 N20**——sidecar finalization
后 entry payload 已带 final AttachmentRef，append 前必须再 Zod parse + dry-run
一次，否则 step 3 preflight 不算"最终校验"。step 5d 一致性 assert 在正常路径
应当 pass；diff 意味着 sidecar 写入 bug，必须立即抓出。

#### Crash window analysis（rev 4 step number 更新）

| Crash 在第几步 | 状态 | doctor 启动恢复 |
|---|---|---|
| 1-2 | `.lock` 残留 | stale-lock：PID dead → unlink |
| 3 | `.lock` 残留，无 I/O | unlink lock |
| 4a-4c | sidecar `.tmp-*` 残留 | 清扫 attachments/**/*.tmp-* |
| 4d | sidecar 已 rename，journal 未 append | orphan-attachment：扫 attachments/ vs journal AttachmentRef 集合，orphan 删除 |
| 5（final validate） | sidecar 已 rename，journal 未 append | 同上 orphan-attachment 清扫 |
| 6a-6b 单 entry write 中途 | journal 末尾 partial line | tail-corruption truncate-after-last-good-line（§4.13） |
| 6a-6b batch write 中途 | partial batch | **batch-aware**：truncate 整个 batch（§4.13） |
| 7（post-apply assert） | journal 完整；snapshot 落后 | startup 增量 rebuild |
| 8（snapshot tmp 但 rename 前） | snapshot tmp 残留 | 清扫 + 增量 rebuild |
| 9-10 | 状态正确，lock 残留 | stale-lock 清扫 |

### 3.6 Reducer + Replay + Reader contract

#### Reducer apply

- 启动：reducer 从 `snapshots/_meta.json.last_applied_seq + 1` 起增量 apply
- 写入：每条 entry append 后增量更新 snapshots（lock 内）
- 重建：`loaf doctor --rebuild` 从 seq=0 full replay

#### Preflight vs post-apply

- **Preflight (step 3)**：candidate entries WITHOUT 最终 sidecar refs，dry-run。
  validation 主入口
- **Final validate (step 5)**：candidate entries WITH 最终 sidecar refs，dry-run。
  sidecar pipeline 完整性 assert
- **Post-apply (step 7)**：纯 assert。journal 已落盘，不 abort

#### Reader contract（**rev 4 N21 read repair**）

**任何 read-side caller 读 `snapshots/state.json` / `tasks.json` 等派生投影时**：

1. 必须读 `_meta.json.last_applied_seq` 作为 "as-of" 版本号
2. 必须读 `_meta.json.last_entry_offset + last_entry_line_hash` 做 fast tail check
3. **若 fast check fail** → CLI 命令 exit 2 `SNAPSHOT_STALE_REBUILD_REQUIRED`，
   stderr 提示 `loaf doctor --rebuild`。**不静默输出可能不可信的 snapshot**
4. snapshot 保证 ≤ 1 mutator 周期 stale（写者在 lock 内增量更新 snapshot）

CLI 输出（命令成功路径）wrap footer：`# snapshot as-of seq=N (last_applied_seq)`。

#### Reducer apply invariants（per-kind 表）

| kind | 允许的 sub_state / 触发条件 | mutation rights 来源 | 额外校验 |
|---|---|---|---|
| `event:phase_advanced` | 任意 non-gate transition | `loaf advance` | LEGAL_TRANSITIONS 含；ceremony phase flag |
| `event:ceremony_set` | `TRIAGE.*` only | `loaf ceremony set` | 不可 SPEC.* 之后改 |
| `event:tasks_planned` | `EXECUTE.plan` only | `loaf tasks plan` | tasks.based_on.spec === spec_version |
| `event:tasks_amended` | `EXECUTE.*` / `VERIFY.*` | finding action amend-tasks | 详见 §4.3 |
| `event:task_claimed` | `EXECUTE.work` only | `loaf tasks claim` | task.status="ready" |
| `event:task_step_started` | `EXECUTE.work` only | `loaf tasks step start` | task.status="in_progress" |
| `event:task_step_done` | `EXECUTE.work` only | `loaf tasks step done` | evidence satisfies |
| `event:task_abandoned` | `EXECUTE.work` only | finding action / 手工 | reason 必填 |
| `event:spec_*` / `_submitted` | `SPEC.*` (pre-lock) | `loaf spec add-*` | spec_locked=false |
| `evidence:added` | `EXECUTE.*` / `VERIFY.*` | `loaf evidence add` | covers 指向合法 id |
| `finding:raised` / `closed` | `VERIFY.*` / post-lock `EXECUTE.*` | `loaf finding raise/close` | category/action 合法 |
| `pending:added` / `resolved` | 任意 | `loaf pending raise/resolve` | FIFO 严格 |
| `gate:decided` | `gate_kind="spec-lock"` ⇒ `SPEC.design`；`gate_kind="verify-accept"` ⇒ `VERIFY.accept`（standard+ only） | `loaf gate decide` | actor `human:`；**复用 LEGAL_TRANSITIONS validator**（rev 4） |
| `session:started` | journal empty 且 entry seq=0 时合法 | `loaf init` | 不存在 prev sub_state |
| `session:resumed` | startup, existing journal | `loaf resume` | journal 非空 |
| `session:delivered` | `EXECUTE.done`（quick）/ `SETTLE.lessons`（standard+） | `loaf deliver` | verify-min basis / reconcile basis 必填；actor `human:` |
| `session:archived` | 任意 non-DONE | `loaf archive` | reason；actor `human:` |
| `session:abandoned` | 任意 non-DONE | `loaf abandon` | reason；actor `human:` |
| `spike:converted` | spike 模式 active | `loaf spike convert` | convert_target；actor `human:` |
| `migration:snapshot_imported` | journal seq=0/1 only | `loaf doctor --migrate-v2` | actor `migration:`；payload 含 §5.2 artifact refs |

违反时 preflight (step 3) abort，CLI exit 2 + 具体 error code。

### 3.7 CLI 层 advance guard

`loaf advance` / `loaf tasks plan` / `loaf tasks claim` / `loaf gate decide` /
等带 sub_state authority 限制的命令在 dispatch 前做 pre-check（与 reducer
preflight 一致）。Pre-check 是 fast feedback，reducer preflight 是最终 source
of truth。

`loaf gate decide` 内部走与 `loaf advance` 同套 LEGAL_TRANSITIONS pre-check
（rev 4）；只是 kind/payload 入口和 actor 校验不同。

## 4. Cascading decisions

### 4.1 B1 — Actor authority + envelope signature reserve + migration namespace

- **决策**：CLI 注入 + per-kind refine + signature reserve；`migration:` 正式入
  namespace
- **(γ) 落点**：§3.4 refine 表；§3.3 unify gate
- **工程估算**：~1 day
- **Acceptance test**：`tests/core/actor-authority.test.ts`

### 4.2 B2 — Reducer ceremony guard 双层 + preflight + final validate

- **决策**：CLI advance pre-check + reducer step 3 preflight + step 5 final
  validate
- **(γ) 落点**：§3.5 step 3 / step 5；§3.6 per-kind 表；§3.7
- **工程估算**：~3 day
- **Acceptance test**：`tests/core/ceremony-guard.test.ts` +
  `tests/core/per-kind-substate.test.ts` + `tests/core/preflight-validation.test.ts` +
  `tests/core/final-validation.test.ts`（rev 4 新）

### 4.3 B3 — `tasks_amended` 新 kind + 完整 invariant

- **决策**：5 项 invariant（见 rev 2 / rev 3 说明）
- **工程估算**：~1 day

### 4.4 H1 — Protocol permissive + doc cleanup

- **工程估算**：~0.5 day

### 4.5 H2 — `resolved_pending_log` snapshot 投影

- **工程估算**：~0.5 day

### 4.6 H3 — Per-field sidecar rule + entry_id 统一

- **工程估算**：~3 day（rev 4 上调，含 crash injection + final validation
  integration）

### 4.7 M1 — `ready` + `tasks_planned`

- **工程估算**：~0.5-1 day

### 4.8 M2 — `spec_version` monotonic 保持，drop hash

- **拒绝 content hash 理由**（rev 2 修正后保留）：
  - monotonic anchor 失序
  - corruption detection 由 `_meta.rolling_checksum` 提供（per-entry 链式，
    跟 spec_version 解耦）
  - write-guard hook 兜直编

### 4.9 M3 — `strict_drift_check` enforcement

- **工程估算**：~1 day

### 4.10 N10 — Truth model

- **(γ) 落点**：本 ADR

### 4.11 N11 — `seq` + `at` monotonic

- **工程估算**：（含在 reducer）

### 4.12 B5 — Drop deadlock；lock contention 限制保留

### 4.13 N13 — Batch-aware tail recovery

- **决策**：doctor batch-aware truncate，partial batch → drop 整批
- **工程估算**：~1.5 day（含 batch edge）
- **Acceptance test**：`tail-corruption.test.ts` 7 场景

### 4.14 N14 — Lock serialization 限制声明

- **工程估算**：0（doc）

### 4.15 Snapshot rebuild perf benchmark + rolling_checksum 两级（rev 4 H 修复）

- **决策**：
  - 10K entries replay < 500ms
  - 100K entries replay < 5s
  - `_meta.rolling_checksum` per-entry 链式（O(entry size) per append）
  - **Startup fast check** = `last_entry_offset` + `last_entry_line_hash`（O(1)）
  - **Full chain verify** = `loaf doctor --verify-checksum`（O(N)，user-invoked）
  - fast check mismatch → exit 2 `SNAPSHOT_STALE_REBUILD_REQUIRED`
- **工程估算**：~0.5 day

### 4.16 N15 — Batch atomicity via batch_id

- **(γ) 落点**：§3.2 batch markers + §3.5 + §4.13
- **Acceptance test**：`tests/core/batch-atomicity.test.ts` 4 场景

### 4.17 N16 — Per-entry `entry_schema_version`（rev 4 改名）

- **决策**：envelope 加 `entry_schema_version: number`；upcaster keyed by
  `(kind, entry_schema_version)`；与 `SCHEMA_VERSION` / `feature_schema_version`
  字段命名分明
- **工程估算**：~0.5 day
- **Acceptance test**：`tests/core/per-entry-upcast.test.ts`

### 4.18 N17 — `migration:` actor namespace

- **(γ) 落点**：§3.4
- **工程估算**：（含在 B1）

### 4.19 N18 — Reader stale read contract + N21 read repair（rev 4 加 exit code）

- **决策**：reader contract 强制 check `_meta`；mismatch → exit 2
  `SNAPSHOT_STALE_REBUILD_REQUIRED`；CLI footer `# snapshot as-of seq=N`
- **工程估算**：~0.5 day
- **Acceptance test**：`tests/core/reader-staleness.test.ts`

### 4.20 N19 — Migration entry sidecar 化（rev 4 新 Blocker 修复）

- **决策**：`migration:snapshot_imported` entry payload **仅含 artifact refs**
  （manifest），不含正文。v0.0.x N-file artifacts 全部落
  `attachments/JE-000000/migration/<artifact>`：

```ts
type MigrationSnapshotImportedPayload = {
  source_schema_version: number;             // v0.0.x = 1
  migrated_at: TimestampISO;
  artifacts: {
    state: AttachmentRef;                    // path: "attachments/JE-000000/migration/state.json"
    tasks: AttachmentRef;                    // path: "attachments/JE-000000/migration/tasks.json"
    spec_md: AttachmentRef;                  // path: "attachments/JE-000000/migration/spec.md"
    evidence: AttachmentRef;                 // path: "attachments/JE-000000/migration/evidence.jsonl"
    findings: AttachmentRef;                 // path: "attachments/JE-000000/migration/findings.jsonl"
    pending: AttachmentRef;                  // path: "attachments/JE-000000/migration/pending.json"
  };
};
```

- Migration entry 本身 small（typically <2KB），满足 §3.2 64KB limit
- Reducer apply `migration:snapshot_imported`：读每个 `artifacts.<name>`
  sidecar 文件 + verify sha256，然后从 content 初始化 in-memory state
- **(γ) 落点**：§3.2 + §3.3 + §5.2
- **工程估算**：（含在 §5.2 migration 5d）
- **Acceptance test**：`tests/core/v0.0.x-migration.test.ts` 端到端 + sidecar
  ref consistency check

### 4.21 N20 — Step 5 final validation（rev 4 新 Blocker 修复）

- **决策**：§3.5 transaction 在 sidecar finalize（step 4d 写 AttachmentRef.sha256
  入 payload）之后、journal append（step 6）之前，加 step 5 final validate：
  - 5a re-Zod-parse with final refs
  - 5b byte-size check
  - 5c final dry-run apply
  - 5d 与 step 3 preflight 结果一致性 assert
  - 5e diff → abort + log `SIDECAR_VALIDATION_DRIFT`
- **(γ) 落点**：§3.5 step 5
- **工程估算**：（含在 §4.6 H3 sidecar transaction 3d）
- **Acceptance test**：`tests/core/final-validation.test.ts`——sidecar refs
  注入前后 entry 一致性 + corner case（>64KB 反弹）

## 5. Migration

### 5.1 protocol.md diff（按章节）

| 章节 | 改动 |
|---|---|
| §1 | 加 `15a` "single journal SSoT + reducer-derived projection" |
| §4.1 | state.json 改写为派生投影 |
| §4.2-4.12 | 各 artifact 标注 authority layer |
| §10.8 Command table | 加 `kind emitted` 列；`--actor` 砍；新增 doctor 5 sub-flag |
| §10.15 Doctor checklist | 加 `orphan-attachment` / `tail-corruption` / `stale-tmp` / `snapshot-seq-mismatch` / `migration-v0.0.x` / `rolling-checksum-mismatch` / `sidecar-validation-drift` |
| §11.2 | 全面重写为 §3.5 10 步 crash contract |
| §13.1 Authority layer | 4-tier 收紧：Canonical = journal.jsonl + attachments/；其余 derived |
| §15 v1 done-when | 翻 schema_version freeze 条款；加"必须通过 §5.2 upcaster 迁移 v0.0.x" |
| §16 | 翻 `state.json event sourcing` |
| §17 legacy 对照 | 加 truth model 演化栏 |

### 5.2 schemas.ts diff + v0.0.x → v0.1.0 lossy snapshot import（**rev 4 N19 修复**）

#### Schema version bump

`SCHEMA_VERSION: 1 → 2`（envelope shape 级常量，在 schemas.ts 中）。配合
per-entry `entry_schema_version`（envelope 字段）做 per-kind upcast。

#### Migration 流程（rev 4 sidecar 化）

```
v0.0.x N-file → v0.1.0 journal:

Step 1: doctor 读 v0.0.x artifacts:
  - state.json, tasks.json, spec.md
  - evidence.jsonl(含可能的 gate-decision entries)
  - findings.jsonl, pending.json

Step 2: 复制每个 artifact 到 .loaf/<feature>/attachments/JE-000000/migration/:
  - state.json     → attachments/JE-000000/migration/state.json
  - tasks.json     → ...migration/tasks.json
  - spec.md        → ...migration/spec.md
  - evidence.jsonl → ...migration/evidence.jsonl
  - findings.jsonl → ...migration/findings.jsonl
  - pending.json   → ...migration/pending.json
  每个 copy 通过 tmp+rename 落盘,fsync 文件 + 父目录

Step 3: 计算每个 sidecar 文件的 sha256 + size

Step 4: 写 migration:snapshot_imported entry 到 journal.jsonl:
  {
    seq: 0,
    entry_id: "JE-000000",
    at: <migration_at>,
    actor: "migration:v0.0.x→v2",
    entry_schema_version: 1,
    kind: "migration:snapshot_imported",
    payload: {
      source_schema_version: 1,
      migrated_at: <migration_at>,
      artifacts: {
        state:    { path: "attachments/JE-000000/migration/state.json",     sha256: <hash>, size: <bytes> },
        tasks:    { ... },
        spec_md:  { ... },
        evidence: { ... },
        findings: { ... },
        pending:  { ... }
      }
    }
  }
  通过 §3.5 multi-step transaction 写入(走 step 5 final validate)

Step 5: Reducer apply migration:snapshot_imported:
  - 读每个 artifacts.<name>.path sidecar 文件
  - verify sha256 匹配 payload AttachmentRef.sha256
  - 从 content 初始化 in-memory state:
    - artifacts.state    → state
    - artifacts.tasks    → tasks projection
    - artifacts.spec_md  → spec.md projection
    - artifacts.evidence → evidence projection(包括 legacy gate-decision
      entries 投影到 derived evidence view + derived gate view —— 但
      **不**伪造新 gate:decided entry,legacy gate 只在 migration payload 留)
    - artifacts.findings → findings projection
    - artifacts.pending  → pending projection

Step 6: 生成 snapshots/*.json from in-memory state

Step 7: v0.0.x 原文件移动到 ../<feature>.backup-v1/(保留备份,不破坏现场)
```

#### Migration crash table（rev 4 sidecar 化）

| Crash 在 step | 状态 | 恢复路径 |
|---|---|---|
| 1（读旧 artifacts） | 无写入 | 重跑 doctor --migrate-v2 |
| 2a-2c（sidecar tmp 但 rename 前） | sidecar tmp 残留 | doctor 清扫 .tmp-* 重跑 |
| 2d（部分 sidecar 已 rename） | 部分 attachments/ 落 | doctor 检测：journal 无 migration entry → 删除 attachments/JE-000000/，重跑 |
| 3-4a（journal tmp） | journal tmp 残留 | doctor 清扫 .tmp-* 重跑 |
| 4b（journal rename 完成但旧文件未 move） | 新 journal + 新 attachments + 旧 artifacts 并存 | doctor 检测：journal 有 migration entry → 移动旧 artifacts 到 backup |
| 5-6（snapshot 生成中） | journal 完整，snapshot 不完整 | startup rebuild |
| 7（backup move 中） | 部分 backup 完成 | doctor 完成 move；不可重复 migrate |

#### 错误码

- `SCHEMA_VERSION_MISMATCH`（exit 2）：v0.0.x .loaf 但无 journal
- `MIGRATION_INCOMPLETE`（exit 2）：upcaster 中途 fail
- `MIGRATION_BACKUP_MISSING`（exit 2）：拒绝无 backup 执行 migrate
- `MIGRATION_REPLAY_ATTEMPT`（exit 2）：journal 已有 migration entry，拒绝重复
- `MIGRATION_SIDECAR_MISSING`（exit 2，rev 4）：journal 有 migration entry 但
  attachments/JE-000000/migration/ 缺文件

#### Mixed project 禁止

一个 cwd 下所有 `.loaf/<feature>` 必须 schema_version 一致。doctor `--scope cwd`
拦截。

#### 旧 enum 迁移映射（rev 4 简化）

| 旧（v0.0.x）位置 | 旧值 | 新（v0.1.0）位置 |
|---|---|---|
| `evidence.jsonl entry.kind` | `test/review/visual/manual/waiver/gate-decision` | 全部留在 `migration:snapshot_imported` payload sidecar 中（含 legacy gate-decision）；reducer 派生到 evidence view + derived gate view |
| `findings.jsonl entry.event` | `raised/closed` | 同上，留 migration sidecar；reducer 派生到 findings view |
| `pending.json entry.kind` | 5 种 PendingPromptKind | 同上，留 migration sidecar；reducer 派生到 pending view |
| `state.json` 各字段 | enum / scalar | reducer 直接从 migration sidecar `state.json` 内容复制到 in-memory state |
| `tasks.json.tasks[]` | TaskBase | reducer 从 migration sidecar `tasks.json` 复制 |
| `spec.md` | EARS markdown | reducer 复制到 spec.md projection |

**关键（rev 4 修正）**：legacy gate-decision evidence **不**合成新 `gate:decided`
entry——这避免 rev 2 的"双 truth source"问题。它们仅以 legacy data 形态存在
于 migration payload sidecar，reducer 派生时既投影到 evidence view 也投影到
derived gate view（**派生**，不是 canonical）。新写 spec-lock / verify-accept
gate decision 才走 `gate:decided` kind。

#### Schemas.ts 段落 diff

| 段落 | 改动 |
|---|---|
| §0a | 改为 `EntryKind` registry |
| §34 CONCURRENCY_INVARIANTS | 全面重写：10 步 transaction + entry_byte_limit + sidecar threshold + monotonic + tail recovery batch-aware + orphan GC + checksum 两级 + step 5 final validate |
| 新增 | `JournalEntry` + envelope schema |
| 新增 | `EntryKind` enum + payload union per kind |
| 新增 | `LongTextField` / `AttachmentRef` |
| 新增 | `SignatureEnvelope`（reserve） |
| 新增 | `SnapshotMeta` schema |
| 新增 | `MIGRATION_V1_TO_V2_BOUNDARY` table（lossy import + sidecar layout） |
| `SCHEMA_VERSION` | 1 → 2 |
| 新增 | `ENTRY_SCHEMA_VERSIONS` table（keyed by kind） |
| 新增 | `UPCASTER_REGISTRY`（keyed by (kind, entry_schema_version)） |

### 5.3 spike → core promote

| from | to | 改动 |
|---|---|---|
| `src/spike/events.ts` | `src/core/journal-entry.ts` | envelope 加 entry_id / entry_schema_version / batch markers |
| `src/spike/reducer.ts` | `src/core/reducer.ts` | preflight + per-kind 表 + N13/N15/N16/N18/N19/N20/N21 |
| `src/spike/append.ts` | `src/core/journal-append.ts` | 64KB + LongTextField sidecar + §3.5 step 3 preflight + step 5 final validate 集成 |
| `src/spike/snapshot.ts` | `src/core/snapshot.ts` | 6 个 snapshots + `_meta.json` + rolling_checksum chain + last_entry_line_hash fast check |
| `src/spike/project.ts` | `src/core/journal-bootstrap.ts` | batch-aware tail recovery |
| `tests/spike/atomicity.test.ts` | `tests/core/journal-atomicity.test.ts` | |
| `tests/spike/reducer.test.ts` | `tests/core/reducer.test.ts` | + per-kind matrix |
| `tests/spike/replay.test.ts` | `tests/core/replay.test.ts` | + incremental |
| `tests/spike/schema-evolution.test.ts` | `tests/core/per-entry-upcast.test.ts` | |
| `tests/spike/perf.test.ts` | `tests/core/perf.test.ts` | 10K/100K + rolling_checksum cost |
| 新增 | `tests/core/sidecar-crash.test.ts` | |
| 新增 | `tests/core/tail-corruption.test.ts` | 7 场景 |
| 新增 | `tests/core/batch-atomicity.test.ts` | 4 场景 |
| 新增 | `tests/core/preflight-validation.test.ts` | step 3 全口径 |
| 新增 | **`tests/core/final-validation.test.ts`** | **rev 4 N20：step 5 sidecar ref injection consistency** |
| 新增 | `tests/core/per-kind-substate.test.ts` | full Cartesian matrix(需 fixture builder) |
| 新增 | `tests/core/reader-staleness.test.ts` | _meta + SNAPSHOT_STALE_REBUILD_REQUIRED |
| 新增 | `tests/core/v0.0.x-migration.test.ts` | lossy snapshot import + sidecar ref consistency |
| 新增 | `tests/core/per-kind-fixture-builder.ts` | rev 4：full matrix fixture 生成器(独立 1d 工程) |

### 5.4 CLI surface 改动

- `--actor` flag 砍
- 输出 footer `# snapshot as-of seq=N`
- Snapshot mismatch → exit 2 `SNAPSHOT_STALE_REBUILD_REQUIRED`
- 新增 doctor sub-flags：
  - `loaf doctor --rebuild`
  - `loaf doctor --check-tail`
  - `loaf doctor --migrate-v2`
  - `loaf doctor --scope cwd`
  - `loaf doctor --verify-checksum`（full chain O(N)）

## 6. Plan impact（**rev 4 重估 25-27d**）

| 项 | day | 备注 |
|---|---|---|
| **Journal SSoT refactor 子项** | | |
| Core journal schema + append + crash contract | 1.5 | §3.2 / §3.5 |
| Reducer preflight + per-kind invariants + final validate | 3.0 | §3.6 + step 5 |
| Projection rebuild + doctor + batch-aware tail | 1.5 | §3.6 + §4.13 |
| Sidecar transaction + crash injection + orphan GC + final validate test | 3.0 | rev 4 上调（含 N20 final validate test） |
| v0.0.x → v0.1.0 lossy snapshot import + sidecar artifacts + crash table | 5.0 | rev 4 上调（含 N19 sidecar redesign） |
| Per-entry `entry_schema_version` + upcaster registry | 0.5 | N16/rev 4 |
| Reader staleness contract + CLI footer + exit code | 0.5 | N18/N21 |
| Per-kind fixture builder（rev 4 显式预算） | 1.0 | full Cartesian matrix |
| **Journal SSoT refactor 小计** | **15.5** | |
| **Cascade decision 子项** | | |
| B1 actor authority + migration namespace | 1.0 | §4.1 |
| B2 ceremony guard | （已含在 reducer） | |
| B3 tasks_amended 完整 invariant | 1.0 | §4.3 |
| H1 doc cleanup | 0.5 | §4.4 |
| H2 resolved_pending_log | 0.5 | §4.5 |
| H3 per-field sidecar | （已含） | |
| M1 ready + tasks_planned | 0.5 | §4.7 |
| M2 spec_version | 0 | §4.8 |
| M3 strict_drift_check | 1.0 | §4.9 |
| N11 monotonic | （已含） | |
| N13 batch-aware tail recovery | （已含） | |
| N14 limitation doc | 0 | §4.14 |
| §4.15 perf benchmark + rolling_checksum 两级 | 0.5 | rev 4 |
| **Cascade decision 小计** | **5.0** | |
| **总计 base** | **20.5** | rev 3 估 18.0 / rev 4 上调 |

加 25-30% 风险 buffer：**25-27 day 进 plan.md**。

**plan.md 路径注释**：`plan.md` 当前 checkout 下不存在。ADR 落地后立即起
`docs/plan.md`，把原 26-34 day 估算调整为 51-61 day（含本 ADR 的 +25-27d）。

## 7. Rejected alternatives

详见 §2.2。

## 8. Audit traceability

| Source | 编号 | ADR §章 | Acceptance test |
|---|---|---|---|
| 三方 r1 | B1 | §4.1 | `actor-authority.test.ts` |
| 三方 r1 | B2 | §4.2 | `ceremony-guard.test.ts` + `per-kind-substate.test.ts` |
| 三方 r1 | B3 | §4.3 | `tasks-amended.test.ts` |
| 三方 r1 | H1 | §4.4 | doc review |
| 三方 r1 | H2 | §4.5 | `pending-resolved-log.test.ts` |
| 三方 r1 | H3 | §4.6 | `sidecar-crash.test.ts` |
| 三方 r1 | M1 | §4.7 | `tasks-planned-claim.test.ts` |
| 三方 r1 | M2 | §4.8 | 复用 spec-lock check #3 |
| 三方 r1 | M3 | §4.9 | `strict-drift.test.ts` |
| 三方 r1 | N10 | §2 + 全 ADR | 联合验证 |
| 三方 r1 | N11 | §4.11 | `monotonic-replay.test.ts` |
| 三方 r1 | B5 | §4.12 | N/A |
| codex ADR r1 | Blocker #1 (orphan cleanup) | §3.5 | `sidecar-crash.test.ts` |
| codex ADR r1 | Blocker #2 (schema version) | §5.2 | `v0.0.x-migration.test.ts` |
| codex ADR r1 | High #3 (amend invariant 窄) | §3.6 + §4.3 | `tasks-amended.test.ts` |
| codex ADR r1 | High #4 (per-kind sub_state) | §3.6 表 | `per-kind-substate.test.ts` |
| codex ADR r1 | High #5 (§10.8/§10.15/§15) | §5.1 | protocol diff review |
| codex ADR r1 | High #6 (spike tests promote) | §5.3 | tests promote checklist |
| codex ADR r1 | High #7 (plan 估算) | §6 | plan.md update |
| codex ADR r1 | Medium #8 (terminal kinds) | §3.3 | `per-kind-substate.test.ts` |
| codex ADR r1 | Medium #9 (cli: fallback) | §3.4 | `actor-authority.test.ts` |
| codex ADR r1 | Medium #10 (旧 enum 迁移) | §5.2 | `v0.0.x-migration.test.ts` |
| codex ADR r1 | Medium #11 (M2/B5 拒绝理由) | §4.8 / §4.12 | doc only |
| codex ADR r1 | Medium #12 (snapshot perf) | §4.15 | `perf.test.ts` |
| codex ADR r1 | N13 | §4.13 | `tail-corruption.test.ts` |
| codex ADR r1 | N14 | §3.5 + §4.14 | N/A |
| codex ADR r2 | Blocker B1 (batch atomicity) | §3.2 + §4.16 | `batch-atomicity.test.ts` |
| codex ADR r2 | Blocker B2 (preflight order) | §3.5 step 3 | `preflight-validation.test.ts` |
| codex ADR r2 | Blocker B3 (migration redesign) | §5.2 lossy import | `v0.0.x-migration.test.ts` |
| codex ADR r2 | High H1 (gate 双 truth) | §3.3 + §5.2 不伪造 gate:decided history | `per-kind-substate.test.ts` |
| codex ADR r2 | High H2 (gate transition) | §3.3 + §3.6 隐式 + 复用 LEGAL_TRANSITIONS | `per-kind-substate.test.ts` |
| codex ADR r2 | High H3 (checksum 成本) | §3.1 + §4.15 | `perf.test.ts` |
| codex ADR r2 | N16 (entry schema version) | §3.2 + §4.17 | `per-entry-upcast.test.ts` |
| codex ADR r2 | N17 (migration actor) | §3.4 + §4.18 | `actor-authority.test.ts` |
| codex ADR r2 | N18 (reader stale) | §3.6 + §4.19 | `reader-staleness.test.ts` |
| codex ADR r2 | Medium (N13 ref drift) | §3.1 fix ref | doc only |
| codex ADR r2 | Medium (entry-id 命名) | §3.1 + §3.2 统一 JE- | `sidecar-crash.test.ts` |
| codex ADR r2 | Medium (session:started invariant) | §3.6 表 fix | `per-kind-substate.test.ts` |
| **codex ADR r3** | **Medium (step count doc drift)** | **§3.5 标题 11 → 10** | doc only |
| **codex ADR r3** | **Medium / N22 (validateTransition helper)** | **§11 Implementation Gate #1** | `per-kind-substate.test.ts` |
| **codex ADR r3** | **Nit / N23 (checksum 双字段)** | doc 确认非冗余 | N/A |
| **codex ADR r3** | **Nit / N24 (migration sidecar 命名)** | doc 确认 OK | N/A |
| **codex ADR r3** | **Nit (step 5d 比较范围)** | **§3.5 step 5d scope 限定** | `final-validation.test.ts` |
| **codex ADR r3** | **Blocker N19 (migration 超 64KB)** | **§3.2 + §4.20 + §5.2 sidecar** | **`v0.0.x-migration.test.ts` + sidecar ref consistency** |
| **codex ADR r3** | **Blocker N20 (sidecar 后缺 final validate)** | **§3.5 step 5 + §4.21** | **`final-validation.test.ts`** |
| **codex ADR r3** | **High (gate projection 矛盾)** | **§5.2 修正：legacy gate 仅在 migration payload，不伪造新 gate:decided** | **`v0.0.x-migration.test.ts`** |
| **codex ADR r3** | **High (checksum scope)** | **§3.1 + §4.15 两级：fast/full** | **`perf.test.ts`** |
| **codex ADR r3** | **Medium (gate LEGAL_TRANSITIONS 复用)** | **§3.3 + §3.6 表 + §3.7** | **`per-kind-substate.test.ts`** |
| **codex ADR r3** | **Nit (verify-accept quick 分支)** | **§3.3 + §3.6 删 quick** | doc |
| **codex ADR r3** | **Medium (schema_version 命名)** | **§3.2 envelope 改 `entry_schema_version`；§3.1 `feature_schema_version`** | `per-entry-upcast.test.ts` |
| **codex ADR r3** | **Medium (N21 read repair)** | **§3.6 + §4.19 exit 2 SNAPSHOT_STALE_REBUILD_REQUIRED** | `reader-staleness.test.ts` |
| **codex ADR r3** | **Medium (full matrix 预算)** | **§5.3 + §6 加 fixture builder 1d** | `per-kind-fixture-builder.ts` |

## 9. Open questions（v0.1.x / v0.2 不阻塞 GA）

1. **Signature 体系选择**：ADR-0006
2. **Cross-feature audit**：v0.2
3. **Snapshot checkpoint**：>100K events，v0.2
4. **Compaction / archive**：feature `session:delivered` 后 journal 压缩，v0.2
5. **Reader watch-style API**：v0.2

## 10. Implementation Gates（codex r4 verdict 落地）

本 ADR 状态 `Accepted with implementation gates`，意味着架构方向已锁，但以下 5
条 gate 必须在 plan.md 的 milestone 中显式列为任务/约束，实现时不得偏离：

### Gate #1 — `validateTransition` shared helper

`event:phase_advanced` 与 `gate:decided` **复用同一套** transition validator：

```ts
// 实现层(src/core/reducer/transition.ts)
function validateTransition(
  prevSubState: SubState,
  targetSubState: SubState,
  context: { ceremony, gate_kind?, actor }
): Result<void, TransitionError>
```

两个 kind 的 apply 路径只能调用 `validateTransition`，不得各写一套 if/else
fork。Plan.md milestone：抽 helper + 双 kind 用例 fixture（`tests/core/per-kind-substate.test.ts` 覆盖）。

### Gate #2 — Final-entry-only append

§3.5 step 5 final validate 通过后，**唯一被允许 append 到 journal 的 entry
对象是 step 5 验证过的 final-form entry**。Append 层（`src/core/journal-append.ts`
step 6）不得：
- 重新序列化旧 candidate entry
- 重新计算 AttachmentRef
- 修改任何已 final-validated 字段

测试 fixture `tests/core/final-validation.test.ts` 覆盖 sidecar ref 注入前后
entry object identity 校验（仅 reducer-visible 字段比较，不做 byte-for-byte
对比——避免 sidecar 填充的合法 diff）。

### Gate #3 — Migration sidecar manifest-only

`migration:snapshot_imported` 的 journal payload **只允许**含 `AttachmentRef`
manifest（artifact 名 → path/sha256/size），**绝不**允许含 artifact 正文。

实现层 schema enforce：

```ts
const MigrationSnapshotImportedPayload = z.object({
  source_schema_version: z.literal(1),
  migrated_at: TimestampISO,
  artifacts: z.object({
    state: AttachmentRef,
    tasks: AttachmentRef,
    spec_md: AttachmentRef,
    evidence: AttachmentRef,
    findings: AttachmentRef,
    pending: AttachmentRef,
  }),
}).strict();  // strict() 拒绝任何额外字段(防 artifact 正文 leak)
```

`.strict()` Zod refine 保证 schema 层闭环。测试：
`tests/core/v0.0.x-migration.test.ts` 覆盖 schema rejection of inline artifact
content。

### Gate #4 — Batch-aware tail recovery

doctor startup tail recovery **必须以 batch 为单位**（§4.13 N15 修复）：
- 单 entry partial → truncate 单 entry
- batch incomplete（`batch_index < batch_count - 1` 或 batch 末 entry partial）→
  truncate 整个 batch 到 batch 第一个 entry 之前

`src/core/journal-bootstrap.ts` 实现层 invariant：
```ts
// 伪代码
function recoverTail(journalPath): RecoveryAction {
  const lines = readLinesBackward(journalPath);
  const lastBatch = collectLastBatch(lines);
  if (lastBatch.isIncomplete()) {
    return { action: "truncate-to-batch-prev-end", offset: lastBatch.startOffset };
  }
  if (lastSingleEntry.isPartial()) {
    return { action: "truncate-to-last-good-line", offset: lastGoodLine.endOffset };
  }
  return { action: "no-op" };
}
```

测试 `tests/core/tail-corruption.test.ts` 7 场景覆盖。

### Gate #5 — Snapshot read fail-fast

CLI read 命令（`loaf state` / `loaf tasks list` / `loaf evidence list` / etc.）
读 `snapshots/*.json` 时必须先做 fast check（§3.6 reader contract）：

```ts
// 实现层(src/core/snapshot-reader.ts)
function readSnapshot(name: string): Result<T, ReaderError> {
  const meta = readSnapshotMeta();
  const fastCheck = verifyFastCheck(meta, journalPath);
  if (fastCheck.mismatch) {
    process.exit(2);  // SNAPSHOT_STALE_REBUILD_REQUIRED
    stderr.write("snapshot inconsistent with journal; run `loaf doctor --rebuild`\n");
  }
  return parseSnapshot(name);
}
```

**禁止静默 fallback**：不得在 mismatch 时输出 cached snapshot + warn；必须
hard exit 2，强制用户跑 `loaf doctor --rebuild`。

测试 `tests/core/reader-staleness.test.ts` 覆盖 mismatch exit-code 校验。

### Milestone gating 顺序（plan.md）

Codex 建议的 implementation order：

1. **Stage 1**：journal schema + append + step 5 final validation
   （Gates #2 落地）
2. **Stage 2**：reducer preflight + `validateTransition` helper + per-kind
   matrix（Gate #1 落地）
3. **Stage 3**：projection rebuild + doctor + batch-aware tail recovery
   （Gate #4 落地）
4. **Stage 4**：sidecar transaction + orphan GC + final validation test harness
   （Gate #2 验证）
5. **Stage 5**：migration sidecar import + crash table + `migration:snapshot_imported`
   （Gate #3 落地）
6. **Stage 6**：perf / checksum / read repair（Gate #5 落地 + §4.15 perf
   benchmark）

§4.15 perf benchmark + §5.2 v0.0.x migration 是 **v0.1.0 release blocker**，
不是 post-implementation cleanup。

## 11. References

- ADR-0001/0002/0003/0004
- `docs/protocol.md` rev 4.3 → rev 5.0
- `docs/schemas.ts` rev 5.0；SCHEMA_VERSION 1 → 2
- `docs/moni-review.md`
- `skills/CONTRACT.md`
- `src/spike/*.ts` → `src/core/*.ts`
- `tests/spike/*.test.ts` → `tests/core/*.test.ts`
