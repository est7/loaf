# Wang Agentic Governance SDD Workflow

> Source: `WangSnapshots/my-ai-workflow.jpeg`.
>
> This is an extraction of Wang's framework only. It intentionally does not map the flow to this repo's `protocol.md`.

## What Wang Is

Wang is a sprint-scoped governance loop for agent execution.

The framework is not centered on a single `/sdd-*` command. Those commands create the governance assets. The runtime center is the loop:

```text
Sprint 未结束?
  -> Scheduler
  -> Execution
  -> Review Loop
  -> Delivery + State Sync
  -> 是否还有下一批 ready leaf TK?
      yes -> 继续 Sprint 编排 -> Sprint 未结束?
      no  -> Sprint Exit
```

The key design move is that agents do not continue from memory. They continue from `CURSOR`, `TASKS`, `REVIEWS`, `TK`, `CR`, and checklist state.

## Source Fidelity

The document is mostly faithful to the source diagram. The structural claims below are directly present in `my-ai-workflow.jpeg`:

| Source element                                                                                                             | Document interpretation                                                    |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `Sprint 未结束?` sits after `/sdd-rfc` and receives the return arrow from `继续 Sprint 编排`.                              | Sprint execution is a loop, not a one-shot command chain.                  |
| Scheduler reads `CURSOR`, `TASKS`, current `TK`, and recent `CR` before choosing work.                                     | Runtime continuation is file-state driven rather than memory driven.       |
| `ready` batch requires satisfied dependencies, non-conflicting write scopes, not being excluded, and 2-4 concurrent tasks. | Parallelism is controlled by explicit scheduling constraints.              |
| Review creates a `CR` for each leaf `TK`.                                                                                  | Review state is isolated per executable task.                              |
| High-impact `rule-candidate` lands script, unit test, and `check-fast` integration before recheck.                         | Important review lessons become guardrails in the current round.           |
| Delivery syncs `TASKS / REVIEWS / checklist / CURSOR` before deciding next batch or Sprint exit.                           | Completion is a state-accounting step, not just implementation completion. |

Two points in this extraction are intentional interpretations rather than literal labels in the diagram:

1. `CURSOR = resume point` is inferred from the diagram's `读取 CURSOR / 恢复当前 phase` and `同步 ... CURSOR` nodes. The source note's explicit "状态同步铁律" only lists `TASKS`, `REVIEWS`, and `checklist`.
2. "Split re-scheduling" means a split parent must be reflected back into `TASKS / CURSOR / parent TK` before the generated child TKs can proceed through the same scheduler/execution path. It does not mean the system must leave the scheduler and start a separate Sprint loop immediately after every split.

## 1. Control Loop

```mermaid
flowchart LR
  context["用户需求<br/>或延续上下文"] --> pre["Pre-Sprint<br/>资产生成"]
  pre --> assets["RFC / PLAN / CURSOR<br/>Sprint / TASKS / REVIEWS / TK"]
  assets --> active{"Sprint 未结束?"}
  active -- 是 --> scheduler["Scheduler"]
  scheduler --> execution["Execution<br/>执行批次"]
  execution --> review["Review Loop"]
  review --> delivery["Delivery + State Sync"]
  delivery --> next{"下一批 ready leaf TK?"}
  next -- 是 --> continueNode["继续 Sprint 编排"]
  continueNode --> active
  next -- 否 --> exit["Sprint Exit<br/>经验与规则候选"]
  active -- 已结束 --> archive["归档 / 下一 Sprint"]
  exit --> archive
```

## 2. Pre-Sprint Asset Builder

Pre-Sprint converts loose intent into assets the scheduler can operate on.

```mermaid
flowchart TD
  input["输入需求 / 延续上下文"] --> specify{"需要 /sdd-specify?"}
  specify -- 是 --> requirement["输出 requirement<br/>等待用户审阅"]
  specify -- 否 --> draft
  requirement --> draft["/sdd-draft<br/>创建 draft"]
  draft --> userReview["用户审阅 draft"]
  userReview --> needReview{"需要 /sdd-review?"}
  needReview -- 是 --> fork{{并行 review}}
  fork --> arch["架构评审"]
  fork --> security["安全评审"]
  arch --> join{{汇合}}
  security --> join
  join --> merge["汇总并回写<br/>draft + .review.md"]
  needReview -- 否 --> rfc
  merge --> rfc["/sdd-rfc"]
  rfc --> outputs["生成 RFC / PLAN / CURSOR<br/>Sprint / TASKS / REVIEWS / TK"]
  outputs -. "目标: 明确项目与 Sprint 边界<br/>生成叶子 TK<br/>标出并行车道" .-> note["Pre-Sprint<br/>输出契约"]
```

## 3. Scheduler + Execution

Scheduler is the main governance point. It chooses work only when it is ready, bounded, and safe to run.

There are two scheduling modes:

| Mode     | Behavior                                              | When it applies                                                                            |
| -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `batch`  | Select 2-4 ready leaf `TK`s and run them in parallel. | Tasks are small enough and their write scopes do not conflict.                             |
| `serial` | Select exactly one ready leaf `TK`.                   | The current planned work should not be split further, but should also not be parallelized. |

```mermaid
flowchart TD
  cursor["读取 CURSOR<br/>恢复当前 phase"] --> tasks["读取 TASKS / 当前 TK<br/>必要时读取最近 CR"]
  tasks --> ready{"存在 ready 批次?"}
  ready -- 是 --> batch["选择 batch-001~NNN"]
  ready -- 否 --> large{"当前 planned TK 过大?"}
  large -- 是 --> split["拆分父 TK<br/>TK-A / TK-B / TK-C"]
  split --> rewrite["回写 TASKS<br/>CURSOR / 父 TK"]
  large -- serial --> single["选择单个 ready leaf TK"]

  batch --> fork{{并行}}
  rewrite --> fork
  single --> fork
  fork --> leafA["执行 leaf TK A<br/>只改分配写入范围"]
  fork --> leafB["执行 leaf TK B<br/>只改分配写入范围"]
  leafA --> verifyA["开发验证"]
  leafB --> verifyB["开发验证"]
  verifyA --> join{{汇合}}
  verifyB --> join
  join --> precheck["主 Agent 前置检查<br/>单测 / 验证 / 变更范围"]

  readyRules["ready 要求:<br/>依赖已满足<br/>写入范围不冲突<br/>不在互斥列表中<br/>并行数约 2-4"] -.-> ready
```

## 4. Review Loop

Review is not just inspection. It converts review output into explicit decisions.

A high-impact `rule-candidate` is not merely filed into a later backlog. In this loop it means: fix the finding, then immediately turn the lesson into a durable guardrail for the current round: script, unit test, and `check-fast` integration.

```mermaid
flowchart TD
  precheck["主 Agent 前置检查通过"] --> create["为每个 leaf TK 创建 CR"]
  create --> initial["初始 review"]
  initial --> findings{"是否有 findings?"}
  findings -- clean --> resolved["CR resolved"]
  findings -- 是 --> triage["主 Agent 分诊<br/>accepted / rejected"]
  triage --> accepted{"存在 accepted findings?"}
  accepted -- 全部 rejected --> clean["直接进入 clean"]
  accepted -- 是 --> fix["修复 accepted findings"]
  fix --> rule{"高影响<br/>rule-candidate?"}
  rule -- 是 --> land["当前轮落地脚本 / 单测<br/>check-fast 集成"]
  rule -- 否 --> recheck
  land --> recheck["重新 review"]
  recheck --> rounds{"轮次 > 5?"}
  rounds -- 否 --> initial
  rounds -- 是 --> human["熔断并升级<br/>人工 review"]
  resolved --> done((review 完成))
  clean --> done
  human --> done
```

## 5. Delivery + State Sync

Delivery closes the accounting. A task is not done just because the implementation and CR are done.

```mermaid
flowchart TD
  reviewDone["Review 完成"] --> delivery["交付验证"]
  delivery --> sync["同步 TASKS / REVIEWS<br/>checklist / CURSOR"]
  sync --> split{"父 TK 是 split?"}
  split -- 是 --> closeParent["仅在以下条件关闭父 TK:<br/>全部子 TK done<br/>父级交付验证通过"]
  split -- 否 --> join(( ))
  closeParent --> join
  join --> next{"是否还有下一批 ready leaf TK?"}
  next -- 是 --> continueNode["继续 Sprint 编排<br/>回到 Sprint 未结束?"]
  next -- 否 --> exit["进入 Sprint 退出检查"]
  exit --> lessons["提炼 experiences<br/>团队经验候选<br/>规则升级候选"]
  lessons --> ask["询问用户:<br/>退出 Sprint 或初始化下一 Sprint?"]

  law["状态同步铁律:<br/>TASKS = TK 卡片状态<br/>REVIEWS = CR + review 报告状态<br/>checklist = done 状态<br/>CURSOR 同步为恢复点"] -.-> sync
```

## Mechanisms

| Mechanism                     | What it controls                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-Sprint                    | Turns loose context into schedulable governance assets.                                                                                                 |
| `CURSOR`                      | Makes continuation explicit and resumable.                                                                                                              |
| Scheduler                     | Enforces dependencies, write scopes, exclusion list, and parallelism cap.                                                                               |
| Split re-scheduling           | Splitting is only valid after `TASKS`, `CURSOR`, and the parent `TK` are rewritten; child TKs then proceed through the normal scheduler/execution path. |
| `batch` / `serial` scheduling | Chooses between parallel leaf work and one-at-a-time execution.                                                                                         |
| Pre-check Gate                | A final automated validation before moving from Execution to the Review Loop.                                                                           |
| Leaf `TK`                     | Smallest executable, reviewable, state-synced task card.                                                                                                |
| CR per leaf `TK`              | Keeps review state isolated across parallel work.                                                                                                       |
| Accepted/rejected findings    | Prevents review output from automatically becoming implementation work.                                                                                 |
| Rule candidate                | Converts high-impact review knowledge into current-round automated guardrails.                                                                          |
| State sync law                | Ensures task state, review state, checklist state, and the resumable cursor agree.                                                                      |
| Evolution                     | Extracts cross-project experiences and rule-upgrade candidates during Sprint exit.                                                                      |

## Resolved Decisions

1. `serial` is one-at-a-time scheduling: choose a single ready leaf `TK` and enter execution.
2. High-impact `rule-candidate` findings are immediately hardened into scripts, unit tests, and `check-fast` integration in the current round.
3. `轮次 > 5` is a fixed fuse: stop the automated review/fix loop and escalate to human review.
4. Sprint exit is not only "no more work"; it includes extracting experiences, team candidates, and rule-upgrade candidates, then asking whether to exit the Sprint or initialize the next Sprint.
