import type { Command } from "commander";

import { loadSession } from "../../../core/cli-runtime.js";
import { areTaskDependenciesSatisfied } from "../../../core/task-graph.js";
import { extractTaskSlim } from "../../../core/task-schema.js";
import { CHROME_KEYS, FAILURE_SITE_KEYS } from "../../runtime-i18n-keys.js";
import { formatTaskListKind, formatTaskStatus } from "./presentation.js";
import type { TasksRegistrationDeps } from "./types.js";

export function registerTaskQueries(tasksCmd: Command, deps: TasksRegistrationDeps): void {
  const { ctx } = deps;
  tasksCmd
    .command("list")
    .description("List tasks (read-only); shows derived `ready` column")
    .option("--feature <name>", "Feature whose tasks to list")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .option("--status <s>", "Filter by task status (pending|ready|in_progress|done|abandoned)")
    .action(async (opts: { feature: string; featureDir?: string; status?: string }) => {
      if (ctx.rejectIfDryRun("tasks list")) return;
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      // Phase 15 SC3 — projection-loader read-path. Adapter: TasksJson
      // (TaskFullPayload[]) → slim TaskState via the same `extractTaskSlim`
      // the reducer uses, preserving byte-equal output with the prior
      // loadSession-derived shape. tasks: null (writer skips when no plan)
      // surfaces as count=0 + tasks:[] — codex r173 minimum case.
      const loaded = await ctx.loadProjectionsOrFail(
        featureDir,
        ["state", "tasks"] as const,
        opts.feature,
        FAILURE_SITE_KEYS.noSessionTasks,
      );
      if (loaded === null) return;
      const slimTasks = loaded.tasks ? loaded.tasks.tasks.map((t) => extractTaskSlim(t)) : [];
      const tasksById = new Map(slimTasks.map((t) => [t.id, t]));
      const withDerived = slimTasks.map((t) => {
        return {
          ...t,
          ready:
            (t.status === "pending" || t.status === "ready") &&
            areTaskDependenciesSatisfied(t, tasksById),
        };
      });

      // Apply --status filter (codex r60 P2 wording: validate filter
      // value client-side for actionable USAGE error).
      const validStatuses = ["pending", "ready", "in_progress", "done", "abandoned"] as const;
      if (
        opts.status !== undefined &&
        !(validStatuses as readonly string[]).includes(opts.status)
      ) {
        ctx.emitFailure(
          "USAGE",
          `--status must be one of: ${validStatuses.join(" | ")} (got ${opts.status})`,
        );
        return;
      }
      // "ready" status filter matches the shared readiness rule, including
      // the persisted ready status admitted by tasks amendments.
      const filtered = withDerived.filter((t) => {
        if (!opts.status) return true;
        if (opts.status === "ready") return t.ready;
        return t.status === opts.status;
      });

      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          count: filtered.length,
          tasks: filtered,
        },
        (i18n) => {
          if (filtered.length === 0) {
            return opts.status
              ? i18n.t(CHROME_KEYS.tasksListEmptyFiltered, { status: opts.status }) + "\n"
              : i18n.t(CHROME_KEYS.tasksListEmpty) + "\n";
          }
          return filtered
            .map((t) => {
              const vars = {
                task_id: t.id,
                kind: formatTaskListKind(i18n, t.kind),
                status: formatTaskStatus(i18n, t.status),
                ready: i18n.t(CHROME_KEYS.tasksListReadyMarker),
              };
              return (
                i18n.t(t.ready ? CHROME_KEYS.tasksListRowReady : CHROME_KEYS.tasksListRow, vars) +
                "\n"
              );
            })
            .join("");
        },
      );
    });

  tasksCmd
    .command("next")
    .description("Print the next ready task id (or empty if none); read-only")
    .option("--feature <name>", "Feature whose ready task to compute")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      if (ctx.rejectIfDryRun("tasks next")) return;
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
        return;
      }
      const tasks = session.snapshot.tasks;
      const tasksById = new Map(tasks.map((t) => [t.id, t]));
      const ready = tasks.find(
        (task) =>
          (task.status === "pending" || task.status === "ready") &&
          areTaskDependenciesSatisfied(task, tasksById),
      );
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          task_id: ready?.id ?? null,
          kind: ready?.kind ?? null,
        },
        () => (ready ? `${ready.id}\n` : ""),
      );
    });
}
