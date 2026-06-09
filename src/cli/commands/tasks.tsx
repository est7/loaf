import type { Command } from "commander";
import type { CommandContext } from "../command-context.js";
import type { CommandMutator, MutateOkBatch, MutateOkSingle } from "../command-mutator.js";
import { FAILURE_SITE_KEYS, SUCCESS_KEYS, CHROME_KEYS, taskKindKey, taskStatusKey, type TaskStatus } from "../runtime-i18n-keys.js";
import { loadSession } from "../../core/cli-runtime.js";
import { mutateBatch } from "../../core/journal-mutate.js";
import { parseInputSource } from "../input-source.js";
import { readJsonInput } from "../input-read.js";
import type { MutatorEntry } from "../mutator-entry.js";
import {
  carryForwardStepProgress,
  latestCanonicalTaskBody,
  materializeTaskForAmend,
} from "../../core/task-history.js";
import {
  TaskInput,
  extractTaskSlim,
  materializeTaskInput,
  type TaskFullPayload,
  type TaskFullProjection,
} from "../../core/task-schema.js";
import type { I18n } from "../i18n.js";

function formatTaskListKind(i18n: I18n, kind: TaskFullProjection["kind"]): string {
  if (i18n.locale === "en") return kind;
  return i18n.t(taskKindKey(kind));
}

function formatTaskStatus(i18n: I18n, status: TaskStatus): string {
  return i18n.t(taskStatusKey(status));
}

export function registerTasks(
  program: Command,
  ctx: CommandContext,
  mutator: CommandMutator,
  actor: string,
  isStdinTty: () => boolean,
  readStdin: () => Promise<string>,
): { tasksCmd: Command } {
  // ── loaf tasks <subcommand> ─────────────────────────────────────────
  // Slice 2 SC2/SC3 task lifecycle CLI surface. The parent `tasks`
  // command is a namespace; sub-commands carry the actual work:
  //   submit <file>          — emit event:tasks_planned (SC2)
  //   claim <task-id>        — emit event:task_claimed (SC3)
  //   step start             — emit event:task_step_started (SC3)
  //   step done              — emit event:task_step_done (SC3)
  // All preconditions enforced by SC1 preflight step 5e (TASK_NOT_FOUND
  // / TASK_NOT_CLAIMABLE / TASK_ALREADY_CLAIMED / TASK_DEPS_NOT_SATISFIED
  // / TASK_NOT_CLAIMED).
  const tasksCmd = program
    .command("tasks")
    .description("Task lifecycle commands (Slice 2 MVP: submit / claim / step)");

  // ── loaf tasks submit --input <src> ─────────────────────────────────
  tasksCmd
    .command("submit")
    .description(
      "Submit a complete task graph from --input <src> (stdin / inline JSON / file path; whole-graph single object)",
    )
    .requiredOption(
      "--input <src>",
      "JSON source: `-` (stdin), inline JSON literal, or file path (protocol §10.7). Whole-graph single object only.",
    )
    .option("--feature <name>", "Feature whose task graph to submit")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { input: string; feature: string; featureDir?: string }) => {
      // Phase 16 SC-4b — unified --input modality (protocol §10.7).
      const source = parseInputSource(opts.input);
      if (source.kind === "stdin" && isStdinTty()) {
        ctx.failure(
          "USAGE",
          "stdin is TTY — `loaf tasks submit --input -` expects piped input. " +
            "Pipe JSON via `... | loaf tasks submit --input -`, OR pass inline " +
            "JSON / file path. Run --help for examples.",
        );
        return;
      }
      const read = await readJsonInput(source, { readStdin });
      if (!read.ok) {
        ctx.failure(read.code, read.message, read.detail);
        return;
      }
      const payload = read.value;

      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await ctx.resolveSession(featureDir);
      if (!session.snapshot.state) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
        return;
      }

      // Mutate. Preflight validates TasksPlannedPayload + sub_state +
      // duplicate task ids + reducer dry-run + final-validate. CLI does
      // not duplicate any of that.
      const result = await mutator.run(
        featureDir,
        session,
        { kind: "event:tasks_planned", payload: payload as Record<string, unknown>, actor },
        "raw-ctx-failure",
      );
      if (!result) return;

      // Success output via ctx.success — output bytes identical to
      // pre-SC-4b shape (asserted via existing tasks-submit tests).
      const tasks = result.snapshot.tasks;
      const taskIds = tasks.map((t) => t.id);
      const out = {
        ok: true,
        feature: opts.feature,
        sub_state: result.snapshot.state?.sub_state,
        tasks_count: tasks.length,
        task_ids: taskIds,
        tasks_based_on: result.snapshot.tasks_based_on,
      };
      ctx.success(
        out,
        (i18n) =>
          i18n.t(
            tasks.length === 1 ? SUCCESS_KEYS.tasksSubmitTextOne : SUCCESS_KEYS.tasksSubmitTextMany,
            {
              count: tasks.length,
              task_ids: taskIds.join(", "),
            },
          ) + "\n",
        (i18n) => ({
          stateChange: i18n.t(SUCCESS_KEYS.tasksSubmitStateChange, { count: tasks.length }),
          next: i18n.t(SUCCESS_KEYS.nextAdvance),
        }),
      );
    });

  // ── loaf tasks add --input <src> [--finding <FND-N>] ────────────────
  tasksCmd
    .command("add")
    .description(
      "Append id-less task(s) to the graph — --input <src> with single object or array (batch); SPEC.design whole-graph, or EXECUTE.work sponsored via --finding",
    )
    .option(
      "--input <src>",
      "JSON source for TaskInput (single object or array): `-` (stdin), inline JSON, or file path (protocol §10.7)",
    )
    .option("--schema", "Dump the input JSON Schema instead of mutating (Phase 16 SC-10)")
    .option("--feature <name>", "Feature whose task graph to extend")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .option("--finding <FND-N>", "Sponsoring amend-tasks finding (sponsored add at EXECUTE.work)")
    .action(
      async (rawOpts: {
        input?: string;
        schema?: boolean;
        feature: string;
        featureDir?: string;
        finding?: string;
      }) => {
        // ctx.dispatchOrFail(opts) below records the trace target after input pre-validation.
        if (rawOpts.schema === true) {
          if (ctx.rejectIfDryRun("tasks add --schema")) return;
          mutator.emitSchemaAndExit("tasks:add");
          return;
        }
        if (rawOpts.input === undefined) {
          ctx.emitFailure(
            "MISSING_INPUT",
            "loaf tasks add requires --input <src> (or pass --schema to dump the input JSON Schema)",
          );
          return;
        }
        const opts = rawOpts as {
          input: string;
          feature: string;
          featureDir?: string;
          finding?: string;
        };
        // Phase 16 SC-4b — unified --input modality (protocol §10.7).
        const source = parseInputSource(opts.input);
        if (source.kind === "stdin" && isStdinTty()) {
          ctx.failure(
            "USAGE",
            "stdin is TTY — `loaf tasks add --input -` expects piped input. " +
              "Pipe JSON via `... | loaf tasks add --input -`, OR pass inline " +
              "JSON / file path. Run --help for examples.",
          );
          return;
        }
        const read = await readJsonInput(source, { readStdin });
        if (!read.ok) {
          ctx.failure(read.code, read.message, read.detail);
          return;
        }
        const parsed = read.value;

        // Normalize to an array; validate each against the strict TaskInput
        // schema. TaskInput omits id / status / execution (CLI-owned);
        // `.strict()` rejects a caller that supplies any of them — the
        // shape-enforcement point of ADR-0004 (codex r113).
        const rawTasks: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        if (rawTasks.length === 0) {
          ctx.failureKeyed(
            "SCHEMA_VALIDATION_FAILED",
            FAILURE_SITE_KEYS.tasksAddEmptyArray,
            {},
            {},
          );
          return;
        }
        const validatedInputs: TaskInput[] = [];
        for (const raw of rawTasks) {
          const p = TaskInput.safeParse(raw);
          if (!p.success) {
            ctx.failure(
              "SCHEMA_VALIDATION_FAILED",
              `tasks add input is not a valid id-less task (omit id / status / execution): ${p.error.issues.map((i) => i.message).join("; ")}`,
              { issues: p.error.issues },
            );
            return;
          }
          validatedInputs.push(p.data);
        }

        // Load session; resolve the surface (unsponsored vs sponsored).
        const featureDir = await ctx.dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await ctx.resolveSession(featureDir);
        if (!session.snapshot.state) {
          ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
          return;
        }
        const subState = session.snapshot.state.sub_state;
        const sponsored = opts.finding !== undefined;
        // --finding is the EXECUTE.work sponsored path; SPEC.design is the
        // unsponsored whole-graph path. Reject the cross-product explicitly
        // rather than silently ignoring the flag (codex r136 Q6).
        if (sponsored && subState === "SPEC.design") {
          ctx.failure(
            "USAGE",
            "--finding is for the sponsored EXECUTE.work add; at SPEC.design `tasks add` is the unsponsored whole-graph path — drop --finding",
          );
          return;
        }
        if (!sponsored && subState !== "SPEC.design") {
          ctx.failure(
            "SUB_STATE_AUTHORITY_VIOLATION",
            `loaf tasks add without --finding is only valid at SPEC.design (current sub_state=${subState}); post-lock task additions go through \`loaf finding raise --action amend-tasks\` then \`tasks add --finding\``,
            { sub_state: subState },
          );
          return;
        }

        // (4) Allocate T-ids. Existing ids must all be canonical T-NNN — a
        // non-canonical id cannot participate in collision-safe allocation
        // (codex r112: fail loud, do not skip).
        let maxSerial = 0;
        for (const t of session.snapshot.tasks) {
          const m = /^T-(\d{3,})$/.exec(t.id);
          if (!m) {
            ctx.failure(
              "REDUCER_ERROR",
              `internal: task id ${t.id} in the projection is not canonical T-NNN; cannot allocate the next id`,
              { task_id: t.id },
            );
            return;
          }
          const n = Number.parseInt(m[1]!, 10);
          if (n > maxSerial) maxSerial = n;
        }
        // Materialize each validated input into a full TaskFull — the CLI
        // stamps the allocated id, status="pending", and the per-kind
        // execution map (all steps applicability="must", status="pending").
        const seededNew = validatedInputs.map((input, i) =>
          materializeTaskInput(input, `T-${String(maxSerial + 1 + i).padStart(3, "0")}`),
        );
        const newIds = seededNew.map((t) => t.id);

        if (sponsored) {
          // (5s) SPONSORED — emit one event:tasks_amended mode="add" +
          // sponsored_by_finding_id per added task (a mutateBatch when the
          // input carries several). Preflight §8.6 verifies the finding is
          // open with action=amend-tasks; the reducer dry-run appends each
          // task and rejects a duplicate id.
          // L1 exclusion (codex L1 audit): this sponsored multi-add stamps a
          // per-entry `at` inside the map — each event:tasks_amended carries its
          // own timestamp. runMutator captures one `now` per call, which would
          // flatten the batch to a single `at`. To stay behavior-preserving this
          // path keeps its direct mutateBatch with per-entry timestamps.
          const sponsoredBatch: Parameters<typeof mutateBatch>[0] = seededNew.map((task) => ({
            at: new Date().toISOString(),
            actor,
            entry_schema_version: 1,
            kind: "event:tasks_amended",
            payload: {
              mode: "add",
              task,
              sponsored_by_finding_id: opts.finding,
            },
          }));
          const result = mutator.finishMutate(
            await mutateBatch(sponsoredBatch, mutator.mctxFor(featureDir, session)),
            "raw-ctx-failure",
          );
          if (!result) return;
          const out = {
            ok: true,
            feature: opts.feature,
            task_ids: newIds,
            sponsored_by_finding_id: opts.finding,
            tasks_count: result.snapshot.tasks.length,
            sub_state: result.snapshot.state?.sub_state,
          };
          ctx.success(
            out,
            (i18n) =>
              i18n.t(
                newIds.length === 1
                  ? SUCCESS_KEYS.tasksAddSponsoredTextOne
                  : SUCCESS_KEYS.tasksAddSponsoredTextMany,
                {
                  count: newIds.length,
                  finding: opts.finding,
                  task_ids: newIds.join(", "),
                },
              ) + "\n",
            (i18n) => ({
              stateChange: i18n.t(SUCCESS_KEYS.tasksAddStateChange, {
                count: newIds.length,
                task_ids: newIds.join(","),
              }),
            }),
          );
          return;
        }

        // (5u) UNSPONSORED — re-materialize every existing task to its
        // canonical full body. tasks_planned is whole-replacement, so the
        // re-emit must carry the complete graph; the slim projection alone
        // would erase body fields.
        const existingFull: TaskFullPayload[] = [];
        for (const t of session.snapshot.tasks) {
          const base = latestCanonicalTaskBody(session.entries, t.id);
          if (!base) {
            ctx.failure(
              "CANONICAL_TASK_BODY_UNAVAILABLE",
              `task ${t.id} is in the projection but has no canonical body in the journal (migration-imported); cannot rebuild the graph to append`,
              { task_id: t.id, source: "migration" },
            );
            return;
          }
          existingFull.push(materializeTaskForAmend(base, t));
        }

        // (6) Emit one whole-replacement event:tasks_planned. based_on carries
        // forward the spec version the graph derives from.
        const based_on = session.snapshot.tasks_based_on ?? {
          spec: session.snapshot.state.spec_version,
        };
        const result = await mutator.run(
          featureDir,
          session,
          {
            kind: "event:tasks_planned",
            payload: { based_on, tasks: [...existingFull, ...seededNew] },
            actor,
          },
          "raw-ctx-failure",
        );
        if (!result) return;

        // (7) Success output — echo the allocated ids for shell scripting.
        const out = {
          ok: true,
          feature: opts.feature,
          task_ids: newIds,
          tasks_count: result.snapshot.tasks.length,
          sub_state: result.snapshot.state?.sub_state,
        };
        ctx.success(
          out,
          (i18n) =>
            i18n.t(
              newIds.length === 1 ? SUCCESS_KEYS.tasksAddTextOne : SUCCESS_KEYS.tasksAddTextMany,
              {
                count: newIds.length,
                task_ids: newIds.join(", "),
              },
            ) + "\n",
          (i18n) => ({
            stateChange: i18n.t(SUCCESS_KEYS.tasksAddStateChange, {
              count: newIds.length,
              task_ids: newIds.join(","),
            }),
          }),
        );
      },
    );

  // ── loaf tasks claim <task-id> ──────────────────────────────────────
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

  // ── loaf tasks abandon <task-id> --reason "..." ─────────────────────
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

  // ── loaf tasks list [--status <s>] [--format json] ──────────────────
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
        const depsAllDone =
          t.depends_on.length === 0 ||
          t.depends_on.every((d) => tasksById.get(d)?.status === "done");
        return {
          ...t,
          ready: t.status === "pending" && depsAllDone,
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
      // "ready" status filter matches derived ready=true (since no task
      // ever persists status="ready" per Option C arch — codex r57).
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

  // ── loaf tasks next ─────────────────────────────────────────────────
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
      const ready = tasks.find((t) => {
        if (t.status !== "pending") return false;
        return (
          t.depends_on.length === 0 ||
          t.depends_on.every((d) => tasksById.get(d)?.status === "done")
        );
      });
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

  // ── loaf tasks complete <task-id> ───────────────────────────────────
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

  // ── loaf tasks amend <task-id> ──────────────────────────────────────
  tasksCmd
    .command("amend <task-id>")
    .description(
      "Amend a task: --policy <step>=<applicability> (EXECUTE.plan) or --input <file> --finding <FND-N> (sponsored, EXECUTE.work)",
    )
    .option("--feature <name>", "Feature whose task to amend")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .option(
      "--policy <step=applicability>",
      "Step applicability override (must|optional|na); repeatable",
      (val: string, acc: string[]) => [...acc, val],
      [] as string[],
    )
    .option(
      "--input <file>",
      "New id-less task definition for a sponsored graph replacement (JSON file or '-')",
    )
    .option("--finding <FND-N>", "Sponsoring amend-tasks finding (required with --input)")
    .action(
      async (
        taskId: string,
        opts: {
          feature: string;
          featureDir?: string;
          policy: string[];
          input?: string;
          finding?: string;
        },
      ) => {
        // SC-6b — record trace target at action entry so long pre-validation
        // failures (input parse, policy/finding mutex) still trace.
        // SC-8: dispatchOrFail resolves §10.3 + records traceTarget.
        const earlyFeatureDir = await ctx.dispatchOrFail(opts);
        if (earlyFeatureDir === null) return;
        // (0) Resolve the surface — --policy and --input are mutually
        // exclusive; --finding pairs with --input.
        const policies = opts.policy ?? [];
        const hasPolicy = policies.length > 0;
        const hasInput = opts.input !== undefined;
        const hasFinding = opts.finding !== undefined;
        if (hasPolicy && hasInput) {
          ctx.emitFailure(
            "USAGE",
            "--policy and --input are mutually exclusive: --policy narrows applicability at EXECUTE.plan, --input replaces the task graph (sponsored) at EXECUTE.work",
          );
          return;
        }
        if (hasInput !== hasFinding) {
          ctx.emitFailure(
            "USAGE",
            "--input and --finding must be specified together — a sponsored graph replacement needs the sponsoring amend-tasks finding",
          );
          return;
        }
        if (!hasPolicy && !hasInput) {
          ctx.emitFailure(
            "USAGE",
            "tasks amend needs either --policy <step>=<applicability> or --input <src> --finding <FND-N>",
          );
          return;
        }

        // ── (b) SPONSORED --input path ──────────────────────────────────
        if (hasInput) {
          const inputPath = opts.input!;
          const findingId = opts.finding!;
          // Phase 16 SC-4b — unified --input modality (protocol §10.7).
          const source = parseInputSource(inputPath);
          if (source.kind === "stdin" && isStdinTty()) {
            ctx.failure(
              "USAGE",
              "stdin is TTY — `loaf tasks amend --input -` expects piped input. " +
                "Pipe JSON via `... | loaf tasks amend --input -`, OR pass inline " +
                "JSON / file path. Run --help for examples.",
            );
            return;
          }
          const read = await readJsonInput(source, { readStdin });
          if (!read.ok) {
            ctx.failure(read.code, read.message, read.detail);
            return;
          }
          const inParsed = read.value;
          const inTask = TaskInput.safeParse(inParsed);
          if (!inTask.success) {
            ctx.failure(
              "SCHEMA_VALIDATION_FAILED",
              `tasks amend --input is not a valid id-less task (omit id / status / execution): ${inTask.error.issues.map((i) => i.message).join("; ")}`,
              { issues: inTask.error.issues },
            );
            return;
          }
          // (b3) Load session via ctx; the task being replaced must exist.
          const sFeatureDir = earlyFeatureDir;
          const sSession = await ctx.resolveSession(sFeatureDir);
          if (!sSession.snapshot.state) {
            ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
            return;
          }
          const sCurrent = sSession.snapshot.tasks.find((t) => t.id === taskId);
          if (!sCurrent) {
            ctx.failure("TASK_NOT_FOUND", `task ${taskId} is not in the current tasks projection`, {
              task_id: taskId,
            });
            return;
          }
          // (b4) Recover the current canonical body from the journal.
          const sCanonical = latestCanonicalTaskBody(sSession.entries, taskId);
          if (!sCanonical) {
            ctx.emitFailure(
              "CANONICAL_TASK_BODY_UNAVAILABLE",
              `task ${taskId} is in the projection but has no canonical body in the journal (migration-imported); cannot amend in place`,
              { task_id: taskId, source: "migration" },
            );
            return;
          }
          // (b5) Materialize the input under the EXISTING task id, carry the
          // body-only execution progress forward from the canonical body for
          // retained steps, then overlay live runtime status/applicability.
          const sNewGraph = materializeTaskInput(inTask.data, taskId);
          // (b5.1) codex r137 BLOCK 2 — reject a sponsored replace that DROPS
          // a canonical step still carrying execution progress.
          const sNewSteps = new Set(Object.keys(sNewGraph.execution));
          const sPriorExec = sCanonical.execution as Record<
            string,
            { status: string; evidence_refs: string[]; started_at?: string; reason?: string }
          >;
          for (const [stepName, prior] of Object.entries(sPriorExec)) {
            if (sNewSteps.has(stepName)) continue;
            if (
              prior.status !== "pending" ||
              prior.evidence_refs.length > 0 ||
              prior.started_at !== undefined ||
              prior.reason !== undefined
            ) {
              ctx.failure(
                "MUTATION_OUT_OF_RIGHTS",
                `sponsored tasks amend on ${taskId} drops step '${stepName}', which carries ` +
                  `execution progress — a graph amend may not erase execution history (codex r136 Q4)`,
                { task_id: taskId, step: stepName, reason: "sponsored_amend_drops_progress_step" },
              );
              return;
            }
          }
          const sWithProgress = carryForwardStepProgress(sNewGraph, sCanonical);
          const sMaterialized = materializeTaskForAmend(sWithProgress, sCurrent);
          // (b6) Emit event:tasks_amended mode="replace" + sponsorship marker.
          const sResult = await mutator.run(
            sFeatureDir,
            sSession,
            {
              kind: "event:tasks_amended",
              payload: {
                mode: "replace",
                task: sMaterialized,
                sponsored_by_finding_id: findingId,
              },
              actor,
            },
            "raw-ctx-failure",
          );
          if (!sResult) return;
          const sOut = {
            ok: true,
            feature: opts.feature,
            task_id: taskId,
            sponsored_by_finding_id: findingId,
            sub_state: sResult.snapshot.state?.sub_state,
          };
          ctx.success(
            sOut,
            (i18n) =>
              i18n.t(SUCCESS_KEYS.amendSponsoredText, {
                task_id: taskId,
                finding_id: findingId,
              }) + "\n",
            (i18n) => ({
              stateChange: i18n.t(SUCCESS_KEYS.amendStateChange, { task_id: taskId }),
            }),
          );
          return;
        }

        // ── (a) UNSPONSORED --policy path ───────────────────────────────
        // (1) Parse + validate --policy flags.
        const APPLICABILITY = ["must", "optional", "na"];
        const policyMap = new Map<string, string>();
        for (const p of policies) {
          const eq = p.indexOf("=");
          if (eq <= 0 || eq === p.length - 1) {
            ctx.emitFailure(
              "SCHEMA_VALIDATION_FAILED",
              `malformed --policy '${p}' — expected <step>=<applicability>`,
            );
            return;
          }
          const step = p.slice(0, eq);
          const applicability = p.slice(eq + 1);
          if (!APPLICABILITY.includes(applicability)) {
            ctx.emitFailure(
              "SCHEMA_VALIDATION_FAILED",
              `--policy '${p}': applicability must be one of must | optional | na`,
            );
            return;
          }
          if (policyMap.has(step)) {
            ctx.emitFailure(
              "SCHEMA_VALIDATION_FAILED",
              `--policy step '${step}' specified more than once`,
            );
            return;
          }
          policyMap.set(step, applicability);
        }

        // (2) Load session.
        const featureDir = await ctx.dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
        if (!session.snapshot.state) {
          ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
          return;
        }

        // (3) Current task must be in the projection.
        const current = session.snapshot.tasks.find((t) => t.id === taskId);
        if (!current) {
          ctx.emitFailure("TASK_NOT_FOUND", `task ${taskId} is not in the current tasks projection`, {
            task_id: taskId,
          });
          return;
        }

        // (4) Recover the canonical full body from the journal.
        const base = latestCanonicalTaskBody(session.entries, taskId);
        if (!base) {
          ctx.emitFailure(
            "CANONICAL_TASK_BODY_UNAVAILABLE",
            `task ${taskId} is in the projection but has no canonical body in the journal (migration-imported); cannot amend in place`,
            { task_id: taskId, source: "migration" },
          );
          return;
        }

        // (5) Materialize (canonical body + live runtime status) then apply
        // the --policy applicability deltas.
        const materialized = materializeTaskForAmend(base, current);
        const execution = materialized.execution as Record<string, { applicability: string }>;
        for (const [step, applicability] of policyMap) {
          const seeded = execution[step];
          if (!seeded) {
            ctx.emitFailure(
              "TASK_STEP_NOT_FOUND",
              `step '${step}' is not in task ${taskId}'s execution set`,
              { task_id: taskId, step },
            );
            return;
          }
          seeded.applicability = applicability;
        }

        // (6) Emit event:tasks_amended (mode=replace). Preflight §8.6
        // validates the change is applicability-only.
        const result = await mutator.run(featureDir, session, {
          kind: "event:tasks_amended",
          payload: { mode: "replace", task: materialized },
          actor,
        });
        if (!result) return;

        // (7) Success output.
        const applied = [...policyMap].map(([s, a]) => `${s}=${a}`).join(", ");
        const out = {
          ok: true,
          feature: opts.feature,
          task_id: taskId,
          policy: Object.fromEntries(policyMap),
          sub_state: result.snapshot.state?.sub_state,
        };
        ctx.success(
          out,
          (i18n) =>
            i18n.t(SUCCESS_KEYS.amendPolicyText, {
              task_id: taskId,
              applied,
            }) + "\n",
          (i18n) => ({
            stateChange: i18n.t(SUCCESS_KEYS.amendStateChange, { task_id: taskId }),
          }),
        );
      },
    );

  // ── loaf tasks register-red <task-id> ───────────────────────────────
  tasksCmd
    .command("register-red <task-id>")
    .description("Register the RED test for a claimed behavioral bug task (EXECUTE.work)")
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

  // ── loaf tasks step <subcommand> ────────────────────────────────────
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
    .description("Mark a task step as done (--result passed|failed|waived|na; default passed)")
    .requiredOption("--task <task-id>", "Task whose step to mark done")
    .requiredOption("--step <step-name>", "Step name (kind-specific)")
    .option("--result <r>", "Step result: passed (default) | failed | waived | na", "passed")
    // Slice 3 SC4 --evidence-* batch flags. Any one of these triggers
    // the batch path; --evidence-kind + --evidence-summary are then
    // required together (others optional, mirrors evidence add payload).
    .option("--evidence-kind <kind>", "Evidence kind (closed EvidenceKind enum)")
    .option(
      "--evidence-result <r>",
      "Evidence result (passed | failed | approved | rejected | waived)",
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
          // Allocate EV-NNNNNN — same shape as evidence add CLI.
          const maxSerial = session.snapshot.evidence.reduce((max, e) => {
            const m = /^EV-(\d+)$/.exec(e.id);
            if (!m) return max;
            return Math.max(max, Number.parseInt(m[1]!, 10));
          }, 0);
          evidenceId = `EV-${String(maxSerial + 1).padStart(6, "0")}`;
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

  return { tasksCmd };
}
