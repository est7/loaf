import { FIX_ACTION_STEP } from "../../finding-schema.js";
import {
  firstAddFreshnessViolation,
  firstFrozenViolation,
  firstSponsoredFrozenViolation,
} from "../../task-amend-policy.js";
import { areTaskDependenciesSatisfied } from "../../task-graph.js";
import { extractTaskSlim, type TaskFullProjection } from "../../task-schema.js";
import type { PreflightCheckCtx, PreflightFailure } from "../preflight.js";

export function checkTasksPlanned(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, rawEntry } = c;
  if (entry.kind === "event:tasks_planned") {
    const tasksPayload = (rawEntry as { payload?: Record<string, unknown> }).payload ?? {};
    const incoming = tasksPayload["tasks"] as
      | Array<{ id?: string; red_test_registered?: unknown }>
      | undefined;
    if (Array.isArray(incoming)) {
      const seenIds = new Set<string>();
      for (const t of incoming) {
        if (typeof t?.id === "string") {
          if (seenIds.has(t.id)) {
            return {
              ok: false,
              code: "DUPLICATE_TASK_ID",
              message: `tasks_planned: task id ${t.id} appears more than once in payload`,
              detail: { task_id: t.id },
            };
          }
          seenIds.add(t.id);
        }
        // Slice C SC-C4 (R2) — creation-time red-flag rejection. A planned
        // task must be born unregistered; red_test_registered is set only
        // by `loaf tasks register-red` after the task exists, so the
        // journal records RED registration strictly after task creation.
        // (Preflight only — replay of pre-guard journals stays apply-only.)
        if (t?.red_test_registered === true) {
          return {
            ok: false,
            code: "BUG_TASK_FLAG_MISUSE",
            message: `tasks_planned: task ${t.id ?? "?"} carries red_test_registered=true — a planned task is born unregistered; use \`loaf tasks register-red\` after creation`,
            detail: { task_id: t.id, kind: "event:tasks_planned" },
          };
        }
      }
    }
  }
  return null;
}

// (5d.2) Slice C SC-C2b + Phase 11 Item 3 SC1b — event:tasks_amended §8.6
// mutation rights.
//
// UNSPONSORED `tasks amend` (mode=replace at EXECUTE.plan) may change only
// execution[].applicability and advance status pending→ready; every
// graph / kind-flag / step-set / step-status field is frozen. An
// unsponsored mode=add or a mode=replace outside EXECUTE.plan is rejected.
//
// SPONSORED `tasks_amended` (SC1b) carries `sponsored_by_finding_id` — the
// journal-derivable marker that authorizes a post-back-edge graph amend at
// EXECUTE.work. The sponsored branch runs FIRST (before the unsponsored
// mode=add / replace-outside-EXECUTE.plan rejections): it verifies the
// marker against snapshot.findings exactly like the back-edge sponsorship
// precedent (step 5b: missing / closed / action-mismatch → FINDING_NOT_FOUND),
// pins the surface to EXECUTE.work (Q3), and under valid sponsorship enforces
// the Q4 frozen-field split — identity + execution PROGRESS frozen, graph /
// definition fields + step set mutable.
//
// Enforcement is option B (codex r108, reaffirmed for SC1b at r136):
// the frozen diff runs against the slim Snapshot.tasks projection. Body-only
// fields — `tests` / `test_layer` / per-step `evidence_refs` / `reason` /
// `started_at` — are NOT in the slim projection, so stable-core preflight
// does NOT independently re-verify their preservation. The CLI sponsored
// `tasks amend --input` path carries those body-only progress fields
// forward from the current canonical body via `carryForwardStepProgress`
// (task-history.ts) for every retained step; that carry-forward is the
// body-only-field guard. This is a deliberate locus split, not a preflight
// capability gap.
export function checkTasksAmended(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, payloadData, sub_state, ctx } = c;
  if (entry.kind === "event:tasks_amended") {
    const amended = payloadData as {
      mode?: "add" | "replace";
      task: TaskFullProjection;
      sponsored_by_finding_id?: string;
    };
    const mode = amended.mode ?? "replace";
    const taskId = amended.task.id;
    const sponsorId = amended.sponsored_by_finding_id;

    if (sponsorId !== undefined) {
      // (a) Verify the sponsorship marker against snapshot.findings — mirror
      // the back-edge sponsorship checks (step 5b): the finding must exist,
      // be open, and carry action=amend-tasks. These are FINDING_NOT_FOUND
      // (the finding is the thing being checked); only AFTER the finding is
      // known valid do authorization / surface violations use
      // MUTATION_OUT_OF_RIGHTS.
      const finding = ctx.snapshot.findings.find((f) => f.id === sponsorId);
      if (!finding) {
        return {
          ok: false,
          code: "FINDING_NOT_FOUND",
          message: `event:tasks_amended.sponsored_by_finding_id=${sponsorId} not found in projection`,
          detail: { id: sponsorId, reason: "not_found" },
        };
      }
      if (finding.status === "closed") {
        return {
          ok: false,
          code: "FINDING_NOT_FOUND",
          message: `event:tasks_amended.sponsored_by_finding_id=${sponsorId} is already_closed; only open findings can sponsor a tasks amend`,
          detail: { id: sponsorId, reason: "already_closed" },
        };
      }
      if (finding.action !== "amend-tasks") {
        return {
          ok: false,
          code: "FINDING_NOT_FOUND",
          message: `event:tasks_amended.sponsored_by_finding_id=${sponsorId} has action=${finding.action} but only amend-tasks findings can sponsor a tasks amend`,
          detail: {
            id: sponsorId,
            reason: "action_mismatch",
            expected_action: "amend-tasks",
            actual_action: finding.action,
          },
        };
      }

      // (b) Q3 — sponsored tasks_amended is legal ONLY at EXECUTE.work (the
      // amend-tasks back-edge target). The per-kind sub_state table allows
      // the whole VERIFY-or-post-lock-EXECUTE band; the sponsored path
      // narrows it.
      if (sub_state !== "EXECUTE.work") {
        return {
          ok: false,
          code: "MUTATION_OUT_OF_RIGHTS",
          message: `sponsored event:tasks_amended is permitted only at EXECUTE.work (current sub_state=${sub_state})`,
          detail: {
            task_id: taskId,
            mode,
            sub_state,
            reason: "sponsored_tasks_amended_wrong_sub_state",
          },
        };
      }

      // (c) mode=add — the reducer dry-run catches a duplicate id
      // (DUPLICATE_TASK_ID); firstAddFreshnessViolation rejects a forged
      // task that smuggles execution progress (codex r137 BLOCK 1: a
      // sponsored add must introduce a fresh / unstarted task).
      // mode=replace — verify the Q4 frozen-field split.
      if (mode === "add") {
        const violation = firstAddFreshnessViolation(amended.task);
        if (violation) {
          return {
            ok: false,
            code: "MUTATION_OUT_OF_RIGHTS",
            message:
              `sponsored event:tasks_amended mode=add must introduce a fresh task — ` +
              `'${violation.field}' carries execution progress (§8.6: a sponsored ` +
              `amend may not fabricate completed work)`,
            detail: {
              task_id: taskId,
              mode,
              sub_state,
              field: violation.field,
              reason: "sponsored_add_not_fresh",
            },
          };
        }
      }
      if (mode === "replace") {
        const currentTask = ctx.snapshot.tasks.find((t) => t.id === taskId);
        if (!currentTask) {
          return {
            ok: false,
            code: "TASK_NOT_FOUND",
            message: `tasks_amended: task ${taskId} is not in the current tasks projection`,
            detail: { task_id: taskId },
          };
        }
        const incomingSlim = extractTaskSlim(amended.task);
        const violation = firstSponsoredFrozenViolation(currentTask, incomingSlim);
        if (violation) {
          return {
            ok: false,
            code: "MUTATION_OUT_OF_RIGHTS",
            message: `sponsored event:tasks_amended on task ${taskId} changes frozen field '${violation.field}' — a graph amend may not erase or rewrite execution progress (§8.6)`,
            detail: {
              task_id: taskId,
              mode,
              sub_state,
              field: violation.field,
              from: violation.from,
              to: violation.to,
            },
          };
        }
      }
      // Sponsored path validated — fall through (no unsponsored rejection).
      return null;
    }

    if (mode === "add") {
      return {
        ok: false,
        code: "MUTATION_OUT_OF_RIGHTS",
        message: `event:tasks_amended mode=add on task ${taskId} is not authorized — an add must be sponsored by an amend-tasks finding (sponsored_by_finding_id)`,
        detail: { task_id: taskId, mode, sub_state, reason: "unsponsored_add" },
      };
    }

    if (sub_state !== "EXECUTE.plan") {
      return {
        ok: false,
        code: "MUTATION_OUT_OF_RIGHTS",
        message: `event:tasks_amended mode=replace is permitted only at EXECUTE.plan (current sub_state=${sub_state})`,
        detail: {
          task_id: taskId,
          mode,
          sub_state,
          reason: "replace_outside_execute_plan",
        },
      };
    }

    const currentTask = ctx.snapshot.tasks.find((t) => t.id === taskId);
    if (!currentTask) {
      return {
        ok: false,
        code: "TASK_NOT_FOUND",
        message: `tasks_amended: task ${taskId} is not in the current tasks projection`,
        detail: { task_id: taskId },
      };
    }

    const incomingSlim = extractTaskSlim(amended.task);
    const violation = firstFrozenViolation(currentTask, incomingSlim);
    if (violation) {
      return {
        ok: false,
        code: "MUTATION_OUT_OF_RIGHTS",
        message: `event:tasks_amended on task ${taskId} changes frozen field '${violation.field}' — §8.6 forbids it at EXECUTE.plan`,
        detail: {
          task_id: taskId,
          mode,
          sub_state,
          field: violation.field,
          from: violation.from,
          to: violation.to,
        },
      };
    }
  }
  return null;
}

// (5e) Slice 2 SC1 — task lifecycle preflight refines.
//
// `event:task_claimed` / `event:task_step_started` / `event:task_step_done`
// payloads carry a task_id (+ step). Reducer-side checks today report
// TASK_NOT_FOUND / TASK_STEP_NOT_FOUND after dry-run, and `task_claimed`
// historically silently no-opped on unknown ids (codex r56 BLOCK 3a).
// This step lifts those checks into preflight where they belong, and
// adds the claim/status/deps refines the reducer never enforced:
//   * task_claimed:
//       - task exists in snapshot.tasks → else TASK_NOT_FOUND
//       - task.status ∈ {pending, ready} → else
//         * status=in_progress → TASK_ALREADY_CLAIMED
//         * status=done/abandoned → TASK_NOT_CLAIMABLE
//       - all deps_on tasks have status=done → else TASK_DEPS_NOT_SATISFIED
//   * task_step_started / task_step_done:
//       - task exists → TASK_NOT_FOUND
//       - task.status === "in_progress" → else TASK_NOT_CLAIMED
// Reducer keeps its TASK_NOT_FOUND / TASK_STEP_NOT_FOUND fallbacks as
// defense-in-depth (preflight is authoritative, reducer must not silently
// no-op).
export function checkTaskLifecycle(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, rawEntry, ctx } = c;
  if (
    entry.kind === "event:task_claimed" ||
    entry.kind === "event:task_step_started" ||
    entry.kind === "event:task_step_done"
  ) {
    const payload = (rawEntry as { payload?: Record<string, unknown> }).payload ?? {};
    const task_id = payload["task_id"] as string | undefined;
    if (!task_id) {
      // Schema validation should have caught this; defensive.
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: `${entry.kind}: missing task_id`,
        detail: { kind: entry.kind },
      };
    }
    const task = ctx.snapshot.tasks.find((t) => t.id === task_id);
    if (!task) {
      return {
        ok: false,
        code: "TASK_NOT_FOUND",
        message: `${entry.kind}: task ${task_id} is not in the current tasks projection`,
        detail: { task_id, kind: entry.kind },
      };
    }
    if (entry.kind === "event:task_claimed") {
      if (task.status === "in_progress") {
        return {
          ok: false,
          code: "TASK_ALREADY_CLAIMED",
          message: `task ${task_id} is already claimed (status=in_progress)`,
          detail: { task_id, status: task.status },
        };
      }
      if (task.status === "done" || task.status === "abandoned") {
        return {
          ok: false,
          code: "TASK_NOT_CLAIMABLE",
          message: `task ${task_id} cannot be claimed (status=${task.status} — terminal state)`,
          detail: { task_id, status: task.status },
        };
      }
      // status ∈ {pending, ready} — check deps_on.
      const tasksById = new Map(ctx.snapshot.tasks.map((candidate) => [candidate.id, candidate]));
      if (!areTaskDependenciesSatisfied(task, tasksById)) {
        const blockingDepId = task.depends_on.find(
          (dependencyId) => tasksById.get(dependencyId)?.status !== "done",
        )!;
        const blockingDep = tasksById.get(blockingDepId);
        const blockingStatus = blockingDep?.status ?? "missing";
        return {
          ok: false,
          code: "TASK_DEPS_NOT_SATISFIED",
          message:
            blockingDep === undefined
              ? `task ${task_id} cannot be claimed: dependency ${blockingDepId} is not in the tasks projection`
              : `task ${task_id} cannot be claimed: dependency ${blockingDepId} is not done (status=${blockingStatus})`,
          detail: {
            task_id,
            blocking_dep: blockingDepId,
            blocking_status: blockingStatus,
          },
        };
      }
    } else {
      // task_step_started or task_step_done
      const step = payload["step"] as string | undefined;
      if (task.status !== "in_progress") {
        return {
          ok: false,
          code: "TASK_NOT_CLAIMED",
          message: `task ${task_id} step ${step ?? "?"} mutation requires task.status=in_progress (got status=${task.status}); claim the task first`,
          detail: { task_id, step, status: task.status, kind: entry.kind },
        };
      }
      // (5e.1) Slice C SC-C4 (R2) — bug-task implement gate. A behavioral
      // task labelled `bug` cannot start OR complete its `implement` step
      // until `loaf tasks register-red` has set red_test_registered. Both
      // edges are gated regardless of result, so a direct task_step_done
      // cannot bypass task_step_started (codex r115 Q4).
      if (
        step === "implement" &&
        task.kind === "behavioral" &&
        task.labels.includes("bug") &&
        task.red_test_registered !== true
      ) {
        return {
          ok: false,
          code: "BUG_TASK_REQUIRES_RED",
          message: `behavioral bug task ${task_id} must register its RED test before the implement step — run \`loaf tasks register-red ${task_id}\` first`,
          detail: { task_id, step, kind: entry.kind },
        };
      }
      // (5e.2) Slice C SC-C4 (R2) — red-flag misuse gate. The
      // red_test_registered flag may ride a task_step_done only when it is
      // a red-step registration on a behavioral bug task with a
      // passed/waived result (undefined result reduces to "passed").
      if (entry.kind === "event:task_step_done" && payload["red_test_registered"] === true) {
        const result = payload["result"] as string | undefined;
        const okResult = result === undefined || result === "passed" || result === "waived";
        const okShape =
          step === "red" && task.kind === "behavioral" && task.labels.includes("bug") && okResult;
        if (!okShape) {
          return {
            ok: false,
            code: "BUG_TASK_FLAG_MISUSE",
            message: `red_test_registered=true is valid only on a red-step task_step_done for a behavioral bug task with a passed/waived result (task ${task_id}, step=${step ?? "?"}, result=${result ?? "passed"}, kind=${task.kind})`,
            detail: {
              task_id,
              step,
              result: result ?? "passed",
              kind: task.kind,
              labels: task.labels,
            },
          };
        }
      }
    }
  }
  return null;
}

// (5e.3) Item 1 — event:task_abandoned refines.
//
// `loaf tasks abandon <T-N> --reason "..."` emits event:task_abandoned.
// Per-kind already gates actor (ALL_NON_MIGRATION) + sub_state
// (EXECUTE.work) — this step adds the task-graph refines the reducer
// never enforced (the reducer flips status→abandoned unconditionally):
//   - task exists in snapshot.tasks → else TASK_NOT_FOUND
//   - task.status ∉ {done, abandoned} → else TASK_NOT_ABANDONABLE
//     (abandoning a terminal task is a no-op contract error)
//   - no non-terminal task lists this task in depends_on → else
//     TASK_ABANDON_BLOCKED_DEPENDENTS (abandoning the parent strands
//     the child: task_claimed preflight requires deps status=done).
// INVALID_PAYLOAD for missing / empty reason rides the PER_KIND_PAYLOAD
// parse above (TaskAbandonedPayload requires reason: z.string().min(1)).
export function checkTaskAbandoned(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, rawEntry, ctx } = c;
  if (entry.kind === "event:task_abandoned") {
    const payload = (rawEntry as { payload?: Record<string, unknown> }).payload ?? {};
    const task_id = payload["task_id"] as string | undefined;
    if (!task_id) {
      // Schema validation should have caught this; defensive.
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: `${entry.kind}: missing task_id`,
        detail: { kind: entry.kind },
      };
    }
    const task = ctx.snapshot.tasks.find((t) => t.id === task_id);
    if (!task) {
      return {
        ok: false,
        code: "TASK_NOT_FOUND",
        message: `${entry.kind}: task ${task_id} is not in the current tasks projection`,
        detail: { task_id, kind: entry.kind },
      };
    }
    if (task.status === "done" || task.status === "abandoned") {
      return {
        ok: false,
        code: "TASK_NOT_ABANDONABLE",
        message: `task ${task_id} cannot be abandoned (status=${task.status} — already in a final status)`,
        detail: { task_id, status: task.status },
      };
    }
    const blockingDependents = ctx.snapshot.tasks
      .filter(
        (t) => t.depends_on.includes(task_id) && t.status !== "done" && t.status !== "abandoned",
      )
      .map((t) => t.id);
    if (blockingDependents.length > 0) {
      return {
        ok: false,
        code: "TASK_ABANDON_BLOCKED_DEPENDENTS",
        message:
          `task ${task_id} cannot be abandoned: ${blockingDependents.length} non-terminal ` +
          `task(s) depend on it (${blockingDependents.join(", ")}); abandon or complete ` +
          `the dependents first`,
        detail: { task_id, blocking_dependents: blockingDependents },
      };
    }
  }
  return null;
}

// (5e.4) Phase 11 Item 3 SC2/SC3 — event:task_step_reset refines (codex
// r139 Q3, r142). `loaf finding raise --action fix-impl|fix-test` co-emits
// this inside its 3-entry back-edge batch. Per-kind already gates actor
// (cli-only) + sub_state (the shared fix back-edge from-set). This step
// adds the sponsorship + target-authority refines:
//   - finding_id exists / open / action ∈ {fix-impl, fix-test} → else
//     FINDING_NOT_FOUND (detail.reason ∈ {not_found, already_closed,
//     action_mismatch}), mirroring the back-edge sponsorship precedent
//     (step 5b).
//   - the finding's `target` must equal the reset payload's {task_id,
//     step}, and `step` must equal the finding action's canonical step
//     FIX_ACTION_STEP[finding.action] (fix-impl → "implement", fix-test →
//     "red"). A structurally-valid-but-unauthorized payload is
//     MUTATION_OUT_OF_RIGHTS (reason task_step_reset_target_mismatch /
//     task_step_reset_step_mismatch) — the payload parsed, but it is not
//     authorized by its sponsoring finding.
//   - the task + step must exist in the projection (a step absent from
//     the task is a target mismatch — the finding cannot legitimately
//     target a step the task does not carry).
//   - the target task must not be `abandoned` (r141 guard — see below).
// No new DiagnosticCode — FINDING_NOT_FOUND + MUTATION_OUT_OF_RIGHTS
// are reused (codex r139 Q3).
export function checkTaskStepReset(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, payloadData, ctx } = c;
  if (entry.kind === "event:task_step_reset") {
    const payload = payloadData as {
      task_id: string;
      step: string;
      finding_id: string;
    };
    const finding = ctx.snapshot.findings.find((f) => f.id === payload.finding_id);
    if (!finding) {
      return {
        ok: false,
        code: "FINDING_NOT_FOUND",
        message: `event:task_step_reset.finding_id=${payload.finding_id} not found in projection`,
        detail: { id: payload.finding_id, reason: "not_found" },
      };
    }
    if (finding.status === "closed") {
      return {
        ok: false,
        code: "FINDING_NOT_FOUND",
        message: `event:task_step_reset.finding_id=${payload.finding_id} is already_closed; only open findings can sponsor a step reset`,
        detail: { id: payload.finding_id, reason: "already_closed" },
      };
    }
    // SC3 (codex r142): the kind serves both fix-impl and fix-test — a step
    // reset may be sponsored by either action. Any other action (amend-* /
    // defer / backlog) carries no canonical step and cannot author a reset.
    if (finding.action !== "fix-impl" && finding.action !== "fix-test") {
      return {
        ok: false,
        code: "FINDING_NOT_FOUND",
        message: `event:task_step_reset.finding_id=${payload.finding_id} has action=${finding.action} but only fix-impl / fix-test findings can sponsor a step reset`,
        detail: {
          id: payload.finding_id,
          reason: "action_mismatch",
          expected_action: ["fix-impl", "fix-test"],
          actual_action: finding.action,
        },
      };
    }
    // The payload's {task_id, step} must equal the finding's target — the
    // reset cannot drift off the task/step the finding authorized. The
    // canonical step is the finding action's own (fix-impl → "implement",
    // fix-test → "red") — SC3 keys it off finding.action, not a hardcode.
    const expectedStep = FIX_ACTION_STEP[finding.action]!;
    if (payload.step !== expectedStep) {
      return {
        ok: false,
        code: "MUTATION_OUT_OF_RIGHTS",
        message: `event:task_step_reset step="${payload.step}" but ${finding.action} resets step="${expectedStep}"`,
        detail: {
          finding_id: payload.finding_id,
          task_id: payload.task_id,
          step: payload.step,
          expected_step: expectedStep,
          reason: "task_step_reset_step_mismatch",
        },
      };
    }
    const expectedTarget = finding.target;
    if (
      expectedTarget === undefined ||
      expectedTarget.task_id !== payload.task_id ||
      expectedTarget.step !== payload.step
    ) {
      return {
        ok: false,
        code: "MUTATION_OUT_OF_RIGHTS",
        message: `event:task_step_reset target {task_id=${payload.task_id}, step=${payload.step}} does not match finding ${payload.finding_id}'s target`,
        detail: {
          finding_id: payload.finding_id,
          expected_target: expectedTarget ?? null,
          actual_target: { task_id: payload.task_id, step: payload.step },
          reason: "task_step_reset_target_mismatch",
        },
      };
    }
    // The target task + step must exist in the projection — a step the task
    // does not carry cannot be reset (treated as a target mismatch: the
    // finding's target points at a step absent from the task graph).
    const task = ctx.snapshot.tasks.find((t) => t.id === payload.task_id);
    if (!task || !(payload.step in task.steps)) {
      return {
        ok: false,
        code: "MUTATION_OUT_OF_RIGHTS",
        message: `event:task_step_reset target {task_id=${payload.task_id}, step=${payload.step}} is not present in the tasks projection`,
        detail: {
          finding_id: payload.finding_id,
          task_id: payload.task_id,
          step: payload.step,
          reason: "task_step_reset_target_mismatch",
        },
      };
    }
    // codex r140 P1 — a fix-impl/fix-test step reset may reopen a `done`
    // task (r139 Q5: a done task's step cannot otherwise be re-run), but
    // `abandoned` is a TERMINAL status and must NOT be reactivated
    // (protocol.md — abandoned is a final task status; task-schema.ts —
    // abandoned tasks cannot be reactivated). The reducer rewrites the target
    // task to `in_progress`; without this guard a fix finding targeting an
    // abandoned task would resurrect it. The guard is action-agnostic — it
    // serves both fix-impl and fix-test.
    if (task.status === "abandoned") {
      return {
        ok: false,
        code: "MUTATION_OUT_OF_RIGHTS",
        message: `event:task_step_reset cannot reset task ${payload.task_id}: status=abandoned is terminal and cannot be reactivated (a fix step reset may reopen a done task, never an abandoned one)`,
        detail: {
          finding_id: payload.finding_id,
          task_id: payload.task_id,
          status: task.status,
          reason: "task_step_reset_task_abandoned",
        },
      };
    }
  }
  return null;
}

// (5g) Slice 3 SC3 — finding:raised refines (FINDING_ACTION_GRID +
// target_payload). Runs after PER_KIND_PAYLOAD parse so `payloadData`
// is the typed FindingRaisedPayload. Order:
//   1. INCOHERENT grid cells block first (no transition target).
//   2. UNUSUAL cells require --reason ≥20 chars.
//   3. Target shape (fix-impl/fix-test require {task_id, step}; step
//      must equal action's canonical step; task must exist; step must
//      exist in task.steps; amend-tasks accepts absence but validates
//      if present).
