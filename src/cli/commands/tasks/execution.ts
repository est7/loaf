import type { Command } from "commander";

import { loadSession } from "../../../core/cli-runtime.js";
import type { MutateOkBatch, MutateOkSingle } from "../../command-mutator.js";
import { allocateNextEvidenceId } from "../../evidence-id-allocator.js";
import type { MutatorEntry } from "../../mutator-entry.js";
import { CHROME_KEYS, FAILURE_SITE_KEYS, SUCCESS_KEYS } from "../../runtime-i18n-keys.js";
import { formatTaskStatus } from "./presentation.js";
import type { TasksRegistrationDeps } from "./types.js";

export function registerTaskClaim(tasksCmd: Command, deps: TasksRegistrationDeps): void {
  const { ctx, mutator, actor } = deps;
  tasksCmd
    .command("claim <task-id>")
    .description("Claim a ready task (pending → in_progress) at EXECUTE.work")
    .option("--feature <name>", "Feature whose task to claim")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (taskId: string, opts: { feature: string; featureDir?: string }) => {
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
        return;
      }
      const result = await mutator.run(featureDir, session, {
        kind: "event:task_claimed",
        payload: { task_id: taskId },
        actor,
      });
      if (!result) return;
      // Read the actual claimed task status from the reducer-applied snapshot
      // (codex r60 P2.1 + r61 BLOCK closure): fail-fast if the post-mutate
      // lookup misses. Preflight + reducer guarantee task exists on success,
      // so a missing lookup is an internal contract violation — match the
      // fail-fast pattern step start / step done use, instead of silently
      // falling back to a hardcoded status.
      const claimed = result.snapshot.tasks.find((t) => t.id === taskId);
      if (!claimed) {
        ctx.emitFailure(
          "REDUCER_ERROR",
          `internal: task ${taskId} missing from snapshot after successful task_claimed apply`,
        );
        return;
      }
      const status = claimed.status;
      const out = {
        ok: true,
        feature: opts.feature,
        task_id: taskId,
        status,
        sub_state: result.snapshot.state?.sub_state,
      };
      ctx.success(
        out,
        () => "",
        (i18n) => ({
          stateChange: i18n.t(SUCCESS_KEYS.tasksClaimStateChange, {
            task_id: taskId,
            status,
          }),
        }),
      );
    });
}

export function registerTaskAbandon(tasksCmd: Command, deps: TasksRegistrationDeps): void {
  const { ctx, mutator, actor } = deps;
  tasksCmd
    .command("abandon <task-id>")
    .description("Abandon a non-terminal task (→ abandoned) at EXECUTE.work")
    .requiredOption("--reason <text>", "Why the task is being abandoned (required)")
    .option("--feature <name>", "Feature whose task to abandon")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
      async (taskId: string, opts: { reason: string; feature: string; featureDir?: string }) => {
        const featureDir = await ctx.dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
        if (!session.snapshot.state) {
          ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
          return;
        }
        const result = await mutator.run(featureDir, session, {
          kind: "event:task_abandoned",
          payload: { task_id: taskId, reason: opts.reason },
          actor,
        });
        if (!result) return;
        // Read the abandoned task status from the reducer-applied snapshot;
        // fail-fast if the post-mutate lookup misses (preflight + reducer
        // guarantee the task exists on success — same pattern as claim).
        const abandoned = result.snapshot.tasks.find((t) => t.id === taskId);
        if (!abandoned) {
          ctx.emitFailure(
            "REDUCER_ERROR",
            `internal: task ${taskId} missing from snapshot after successful task_abandoned apply`,
          );
          return;
        }
        const status = abandoned.status;
        const out = {
          ok: true,
          feature: opts.feature,
          task_id: taskId,
          status,
          sub_state: result.snapshot.state?.sub_state,
        };
        ctx.success(
          out,
          () => "",
          (i18n) => ({
            stateChange: i18n.t(SUCCESS_KEYS.tasksAbandonStateChange, {
              task_id: taskId,
              status,
            }),
          }),
        );
      },
    );
}

export function registerTaskComplete(tasksCmd: Command, deps: TasksRegistrationDeps): void {
  const { ctx } = deps;
  tasksCmd
    .command("complete <task-id>")
    .description("Confirm a task has reached status=done (read-only; emits nothing)")
    .option("--feature <name>", "Feature whose task to confirm")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (taskId: string, opts: { feature: string; featureDir?: string }) => {
      if (ctx.rejectIfDryRun("tasks complete")) return;
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
        return;
      }
      const task = session.snapshot.tasks.find((t) => t.id === taskId);
      if (!task) {
        ctx.emitFailure("TASK_NOT_FOUND", `task ${taskId} is not in the current tasks projection`, {
          task_id: taskId,
        });
        return;
      }
      if (task.status !== "done") {
        // Enumerate the must-applicable steps that block auto-promote so the
        // caller knows exactly what is still owed (codex r101 Q2 detail).
        const TERMINAL_POSITIVE = ["passed", "waived", "na"];
        const blockingSteps = Object.entries(task.steps)
          .filter(([, s]) => s.applicability === "must" && !TERMINAL_POSITIVE.includes(s.status))
          .map(([name]) => name);
        ctx.emitFailure(
          "TASK_COMPLETE_PRECONDITION_VIOLATED",
          `task ${taskId} is not complete (status=${task.status}); must-applicable steps not terminal-positive: ${blockingSteps.join(", ") || "(none — task has no must steps to auto-promote)"}`,
          { task_id: taskId, status: task.status, blocking_steps: blockingSteps },
        );
        return;
      }
      const out = {
        ok: true,
        feature: opts.feature,
        task_id: taskId,
        status: task.status,
      };
      ctx.success(
        out,
        (i18n) =>
          i18n.t(CHROME_KEYS.tasksCompleteText, {
            task_id: taskId,
            status: formatTaskStatus(i18n, "done"),
          }) + "\n",
      );
    });
}

export function registerTaskRegisterRed(tasksCmd: Command, deps: TasksRegistrationDeps): void {
  const { ctx, mutator, actor } = deps;
  tasksCmd
    .command("register-red <task-id>")
    .description(
      "Register an established failing RED test for a claimed behavioral bug task (ordering proof; not a general step shortcut)",
    )
    .option("--feature <name>", "Feature whose task to register")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (taskId: string, opts: { feature: string; featureDir?: string }) => {
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
        return;
      }
      const result = await mutator.run(featureDir, session, {
        kind: "event:task_step_done",
        payload: { task_id: taskId, step: "red", result: "passed", red_test_registered: true },
        actor,
      });
      if (!result) return;
      const out = {
        ok: true,
        feature: opts.feature,
        task_id: taskId,
        red_test_registered: true,
        sub_state: result.snapshot.state?.sub_state,
      };
      ctx.success(
        out,
        () => "",
        (i18n) => ({
          stateChange: i18n.t(SUCCESS_KEYS.tasksRegisterRedStateChange, { task_id: taskId }),
        }),
      );
    });
}

export function registerTaskStep(tasksCmd: Command, deps: TasksRegistrationDeps): void {
  const { ctx, mutator, actor } = deps;
  const stepCmd = tasksCmd.command("step").description("Task step lifecycle (start / done)");

  // ── loaf tasks step start --task T-N --step <s> ─────────────────────
  stepCmd
    .command("start")
    .description("Mark a task step as running (task must be claimed)")
    .requiredOption("--task <task-id>", "Task whose step to start")
    .requiredOption("--step <step-name>", "Step name (kind-specific; see spec)")
    .option("--feature <name>", "Feature whose task lifecycle to advance")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { task: string; step: string; feature: string; featureDir?: string }) => {
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
        return;
      }
      const result = await mutator.run(featureDir, session, {
        kind: "event:task_step_started",
        payload: { task_id: opts.task, step: opts.step },
        actor,
      });
      if (!result) return;
      // Slice 2 SC4 (codex r60 P2.2 closure): preflight + reducer guarantee
      // task + step exist on success; fail-fast if either is missing so
      // output schema never silently drops `step_status` to undefined.
      const updated = result.snapshot.tasks.find((t) => t.id === opts.task);
      if (!updated) {
        ctx.emitFailure(
          "REDUCER_ERROR",
          `internal: task ${opts.task} missing from snapshot after successful step_started apply`,
        );
        return;
      }
      const stepInfo = updated.steps[opts.step];
      if (!stepInfo) {
        ctx.emitFailure(
          "REDUCER_ERROR",
          `internal: step ${opts.step} missing from task ${opts.task} after successful step_started apply`,
        );
        return;
      }
      const out = {
        ok: true,
        feature: opts.feature,
        task_id: opts.task,
        step: opts.step,
        step_status: stepInfo.status,
        sub_state: result.snapshot.state?.sub_state,
      };
      ctx.success(
        out,
        () => "",
        (i18n) => ({
          stateChange: i18n.t(SUCCESS_KEYS.stepStartStateChange, {
            task_id: opts.task,
            step: opts.step,
          }),
        }),
      );
    });

  // ── loaf tasks step done --task T-N --step <s> [--result <r>] ───────
  stepCmd
    .command("done")
    .description(
      "Complete a workflow step; --result is the step outcome, independent of --evidence-result",
    )
    .requiredOption("--task <task-id>", "Task whose step to mark done")
    .requiredOption("--step <step-name>", "Step name (kind-specific)")
    .option("--result <r>", "Step outcome: passed (default) | failed | waived | na", "passed")
    // Slice 3 SC4 --evidence-* batch flags. Any one of these triggers
    // the batch path; --evidence-kind + --evidence-summary are then
    // required together (others optional, mirrors evidence add payload).
    .option("--evidence-kind <kind>", "Evidence kind (closed EvidenceKind enum)")
    .option(
      "--evidence-result <r>",
      "Independent evidence outcome (passed | failed | approved | rejected | waived)",
    )
    .option("--evidence-summary <text>", "Evidence summary (≥3 chars)")
    .option(
      "--evidence-covers <csv>",
      "Comma-separated REQ/SCEN/VIS/Task ids covered by this evidence",
    )
    .option("--evidence-check <kind>", "Verify-check kind (run | review | acceptance | visual)")
    .option("--evidence-reason <text>", "Evidence reason (manual/waiver require ≥10 chars)")
    .option(
      "--evidence-actor <actor>",
      "Override evidence actor (default: cli:loaf; required human:* for manual/waiver)",
    )
    .option("--feature <name>", "Feature whose task lifecycle to advance")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
      async (opts: {
        task: string;
        step: string;
        result: string;
        feature: string;
        featureDir?: string;
        evidenceKind?: string;
        evidenceResult?: string;
        evidenceSummary?: string;
        evidenceCovers?: string;
        evidenceCheck?: string;
        evidenceReason?: string;
        evidenceActor?: string;
      }) => {
        // Validate --result client-side (payload schema also enforces).
        const validResults = ["passed", "failed", "waived", "na"] as const;
        if (!(validResults as readonly string[]).includes(opts.result)) {
          ctx.emitFailure(
            "USAGE",
            `--result must be one of: passed | failed | waived | na (got ${opts.result})`,
          );
          return;
        }
        // SC4 batch path: any --evidence-* flag triggers; --kind + --summary
        // are mutually required (kind without summary or vice versa → USAGE).
        const evidenceFlagSet =
          opts.evidenceKind !== undefined ||
          opts.evidenceResult !== undefined ||
          opts.evidenceSummary !== undefined ||
          opts.evidenceCovers !== undefined ||
          opts.evidenceCheck !== undefined ||
          opts.evidenceReason !== undefined ||
          opts.evidenceActor !== undefined;
        if (evidenceFlagSet) {
          if (opts.evidenceKind === undefined || opts.evidenceSummary === undefined) {
            ctx.emitFailure(
              "USAGE",
              "--evidence-kind and --evidence-summary must be specified together when any --evidence-* flag is present",
            );
            return;
          }
        }
        const featureDir = await ctx.dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
        if (!session.snapshot.state) {
          ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
          return;
        }
        // Build the step_done entry. SC4 batch path adds evidence:added
        // afterward when --evidence-* is set.
        const stepDoneEntry: MutatorEntry = {
          kind: "event:task_step_done",
          payload: { task_id: opts.task, step: opts.step, result: opts.result },
          actor,
        };
        let result: MutateOkSingle | MutateOkBatch | null;
        let evidenceId: string | undefined;
        if (evidenceFlagSet) {
          evidenceId = allocateNextEvidenceId(session.snapshot);
          const iteration = session.snapshot.state.iteration ?? 1;
          const evidenceActor = opts.evidenceActor ?? actor;
          const evidencePayload: Record<string, unknown> = {
            id: evidenceId,
            kind: opts.evidenceKind,
            iteration,
            actor: evidenceActor,
            // Evidence.result defaults to the step result so passed steps
            // emit passed evidence by default; caller can override via
            // --evidence-result for waiver / approved / rejected cases.
            result: opts.evidenceResult ?? opts.result,
            summary: opts.evidenceSummary,
            task_id: opts.task,
          };
          if (opts.evidenceCovers !== undefined) {
            evidencePayload["covers"] = opts.evidenceCovers
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
          }
          if (opts.evidenceCheck !== undefined) evidencePayload["check"] = opts.evidenceCheck;
          if (opts.evidenceReason !== undefined) evidencePayload["reason"] = opts.evidenceReason;
          // Journal envelope actor is always the CLI-injected machine actor
          // (codex r72 BLOCK fix): protocol §10.8 keeps `--actor` a permanent
          // non-flag — envelope provenance must stay `cli:loaf@...` so audit
          // trail aligns with the adjacent event:task_step_done entry.
          // Payload.actor inside evidencePayload can still carry `human:*`
          // for manual/waiver evidence (preserved above).
          result = await mutator.run(featureDir, session, [
            stepDoneEntry,
            { kind: "evidence:added", payload: evidencePayload, actor },
          ]);
        } else {
          result = await mutator.run(featureDir, session, stepDoneEntry);
        }
        if (!result) return;
        // Slice 2 SC4 (codex r60 P2.2 closure): same fail-fast assertions
        // as step start — concrete step_status / task_status in output.
        const updated = result.snapshot.tasks.find((t) => t.id === opts.task);
        if (!updated) {
          ctx.emitFailure(
            "REDUCER_ERROR",
            `internal: task ${opts.task} missing from snapshot after successful step_done apply`,
          );
          return;
        }
        const stepInfo = updated.steps[opts.step];
        if (!stepInfo) {
          ctx.emitFailure(
            "REDUCER_ERROR",
            `internal: step ${opts.step} missing from task ${opts.task} after successful step_done apply`,
          );
          return;
        }
        const out: Record<string, unknown> = {
          ok: true,
          feature: opts.feature,
          task_id: opts.task,
          step: opts.step,
          step_status: stepInfo.status,
          task_status: updated.status, // reflects auto-promote if it fired
          sub_state: result.snapshot.state?.sub_state,
        };
        if (evidenceId !== undefined) out["evidence_id"] = evidenceId;
        ctx.success(
          out,
          (i18n) => {
            const promoteSuffix =
              updated.status === "done" ? i18n.t(SUCCESS_KEYS.stepDonePromoteSuffix) : "";
            const evidenceSuffix =
              evidenceId !== undefined
                ? i18n.t(SUCCESS_KEYS.stepDoneEvidenceSuffix, { evidence_id: evidenceId })
                : "";
            return (
              i18n.t(SUCCESS_KEYS.stepDoneText, {
                task_id: opts.task,
                step: opts.step,
                result: opts.result,
                evidence_suffix: evidenceSuffix,
                promote_suffix: promoteSuffix,
              }) + "\n"
            );
          },
          (i18n) => ({
            stateChange: i18n.t(SUCCESS_KEYS.stepDoneStateChange, {
              task_id: opts.task,
              step: opts.step,
              result: opts.result,
            }),
          }),
        );
      },
    );
}
