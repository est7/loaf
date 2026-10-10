import { diagnostic, diagnosticVariant } from "../../../core/error-catalog.js";
import type { Command } from "commander";

import { loadSession } from "../../../core/cli-runtime.js";
import {
  carryForwardStepProgress,
  latestCanonicalTaskBody,
  materializeTaskForAmend,
} from "../../../core/task-history.js";
import {
  TaskAuthoringInputBatched,
  TaskInput,
  TasksSubmitInput,
  materializeTaskInput,
  type TaskAuthoringInput,
  type TaskFullPayload,
} from "../../../core/task-schema.js";
import { allocateTaskAuthoringInputs, collectOccupiedTaskIds } from "../../task-authoring.js";
import { jsonInputHelp, type JsonInputDeclaration } from "../../input-ingestion.js";
import { SUCCESS_KEYS } from "../../runtime-i18n-keys.js";
import { buildNextAdvisoryFromSnapshot, selectorForCommandContext } from "../../next-advisory.js";
import type { TasksRegistrationDeps } from "./types.js";

const TASKS_SUBMIT_INPUT: JsonInputDeclaration = {
  command: "loaf tasks submit",
  helpPrefix: "JSON source",
  inlineLabel: "inline JSON literal",
  helpSuffix: " (protocol §10.7). Whole-graph single object only.",
};

const TASKS_ADD_INPUT: JsonInputDeclaration = {
  command: "loaf tasks add",
  helpPrefix: "JSON source for semantic task input (single object or array)",
  inlineLabel: "inline JSON",
  helpSuffix: " (protocol §10.7)",
};

const TASKS_AMEND_INPUT: JsonInputDeclaration = {
  command: "loaf tasks amend",
  helpPrefix: "New id-less task definition for a sponsored graph replacement",
  inlineLabel: "inline JSON",
  helpText: "New id-less task definition for a sponsored graph replacement (JSON file or '-')",
};

export function registerTaskSubmit(tasksCmd: Command, deps: TasksRegistrationDeps): void {
  const { ctx, mutator, actor, input } = deps;
  tasksCmd
    .command("submit")
    .description(
      "Submit a complete task graph from --input <src> (stdin / inline JSON / file path; whole-graph single object)",
    )
    .option("--input <src>", jsonInputHelp(TASKS_SUBMIT_INPUT))
    .option("--schema", "Dump the semantic authoring JSON Schema instead of mutating")
    .option("--feature <name>", "Feature whose task graph to submit")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
      async (rawOpts: {
        input?: string;
        schema?: boolean;
        feature: string;
        featureDir?: string;
      }) => {
        if (rawOpts.schema === true) {
          if (ctx.rejectIfDryRun("tasks submit --schema")) return;
          mutator.emitSchemaAndExit("tasks:submit");
          return;
        }
        if (!input.requireArg(ctx, rawOpts.input, TASKS_SUBMIT_INPUT)) return;
        const opts = rawOpts as { input: string; feature: string; featureDir?: string };
        const read = await input.readJson(ctx, opts.input, TASKS_SUBMIT_INPUT);
        if (!read.ok) return;
        const parsed = TasksSubmitInput.safeParse(read.value);
        if (!parsed.success) {
          ctx.failure(
            diagnostic("SCHEMA_VALIDATION_FAILED", {
              reason: parsed.error.issues.map((issue) => issue.message).join("; "),
              issues: parsed.error.issues,
              migration: "legacy-full-input-rejected",
            }),
          );
          return;
        }

        const featureDir = await ctx.dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await ctx.resolveSession(featureDir);
        if (!session.snapshot.state) {
          ctx.failure(
            diagnosticVariant("failure.no_session.tasks", { ...{}, feature: opts.feature }),
          );
          return;
        }

        const occupiedTaskIds = collectOccupiedTaskIds(session.snapshot, session.entries);
        const result = await mutator.runPlannedBatch(
          featureDir,
          session,
          (snapshot) => {
            const allocation = allocateTaskAuthoringInputs(parsed.data.tasks, occupiedTaskIds);
            if (!allocation.ok) return allocation;
            const specVersion = snapshot.state?.spec_version;
            if (specVersion === undefined) {
              return {
                ok: false,
                code: "REDUCER_ERROR",
                detail: { reason: "session_state_missing" },
              };
            }
            return {
              ok: true,
              entries: [
                {
                  kind: "event:tasks_planned",
                  payload: {
                    based_on: { spec: specVersion },
                    tasks: allocation.tasks,
                  },
                  actor,
                },
              ],
            };
          },
          {},
        );
        if (!result) return;
        const state = result.snapshot.state;
        if (state === null) {
          ctx.failure(diagnostic("REDUCER_ERROR", {}));
          return;
        }

        // Success output via ctx.success — output bytes identical to
        // pre-SC-4b shape (asserted via existing tasks-submit tests).
        const tasks = result.snapshot.tasks;
        const taskIds = tasks.map((t) => t.id);
        const plannedTasks = (
          result.entries[0]!.payload as {
            tasks: Array<{ id: string }>;
          }
        ).tasks;
        const taskIdsByLocalKey = Object.fromEntries(
          parsed.data.tasks.map((task, index) => [task.local_key, plannedTasks[index]!.id]),
        );
        const out = {
          ok: true,
          feature: opts.feature,
          sub_state: state.sub_state,
          tasks_count: tasks.length,
          task_ids: taskIds,
          task_ids_by_local_key: taskIdsByLocalKey,
          tasks_based_on: result.snapshot.tasks_based_on,
        };
        const selector = await selectorForCommandContext(ctx);
        ctx.success(
          out,
          (i18n) =>
            i18n.t(
              tasks.length === 1
                ? SUCCESS_KEYS.tasksSubmitTextOne
                : SUCCESS_KEYS.tasksSubmitTextMany,
              {
                count: tasks.length,
                task_ids: taskIds.join(", "),
              },
            ) + "\n",
          (i18n) => {
            const next = buildNextAdvisoryFromSnapshot(i18n, result.snapshot, featureDir, selector);
            return {
              stateChange: i18n.t(SUCCESS_KEYS.tasksSubmitStateChange, { count: tasks.length }),
              ...(next === undefined ? {} : { next }),
            };
          },
        );
      },
    );
}

export function registerTaskAdd(tasksCmd: Command, deps: TasksRegistrationDeps): void {
  const { ctx, mutator, actor, input } = deps;
  tasksCmd
    .command("add")
    .description(
      "Append id-less task(s) to the graph — --input <src> with single object or array (batch); SPEC.design whole-graph, or EXECUTE.work sponsored via --finding",
    )
    .option("--input <src>", jsonInputHelp(TASKS_ADD_INPUT))
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
        if (!input.requireArg(ctx, rawOpts.input, TASKS_ADD_INPUT)) return;
        const opts = rawOpts as {
          input: string;
          feature: string;
          featureDir?: string;
          finding?: string;
        };
        const read = await input.readJson(ctx, opts.input, TASKS_ADD_INPUT);
        if (!read.ok) return;
        const parsed = read.value;

        const inputParse = TaskAuthoringInputBatched.safeParse(parsed);
        if (!inputParse.success) {
          if (Array.isArray(parsed) && parsed.length === 0) {
            ctx.failure(diagnosticVariant("failure.tasks_add.empty_array", { ...{}, ...{} }));
            return;
          }
          ctx.failure(
            diagnostic("SCHEMA_VALIDATION_FAILED", {
              reason: inputParse.error.issues.map((issue) => issue.message).join("; "),
              issues: inputParse.error.issues,
              migration: "legacy-task-input-rejected",
            }),
          );
          return;
        }
        const validatedInputs: TaskAuthoringInput[] = Array.isArray(inputParse.data)
          ? inputParse.data
          : [inputParse.data];

        // Load session; resolve the surface (unsponsored vs sponsored).
        const featureDir = await ctx.dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await ctx.resolveSession(featureDir);
        if (!session.snapshot.state) {
          ctx.failure(
            diagnosticVariant("failure.no_session.tasks", { ...{}, feature: opts.feature }),
          );
          return;
        }
        const subState = session.snapshot.state.sub_state;
        const sponsored = opts.finding !== undefined;
        // --finding is the EXECUTE.work sponsored path; SPEC.design is the
        // unsponsored whole-graph path. Reject the cross-product explicitly
        // rather than silently ignoring the flag (codex r136 Q6).
        if (sponsored && subState === "SPEC.design") {
          ctx.failure(diagnostic("USAGE", { reason: "sponsorship_not_allowed_at_spec_design" }));
          return;
        }
        if (!sponsored && subState !== "SPEC.design") {
          ctx.failure(
            diagnostic("SUB_STATE_AUTHORITY_VIOLATION", {
              kind: "event:tasks_amended",
              sub_state: subState,
            }),
          );
          return;
        }

        const occupiedTaskIds = collectOccupiedTaskIds(session.snapshot, session.entries);

        if (sponsored) {
          // (5s) SPONSORED — emit one event:tasks_amended mode="add" +
          // sponsored_by_finding_id per added task (a mutateBatch when the
          // input carries several). Preflight §8.6 verifies the finding is
          // open with action=amend-tasks; the reducer dry-run appends each
          // task and rejects a duplicate id.
          const result = await mutator.runPlannedBatch(
            featureDir,
            session,
            () => {
              const allocation = allocateTaskAuthoringInputs(validatedInputs, occupiedTaskIds);
              if (!allocation.ok) return allocation;
              return {
                ok: true,
                entries: allocation.tasks.map((task) => ({
                  actor,
                  kind: "event:tasks_amended" as const,
                  payload: {
                    mode: "add",
                    task,
                    sponsored_by_finding_id: opts.finding,
                  },
                })),
              };
            },
            { timestamps: "per-entry" },
          );
          if (!result) return;
          const newIds = result.entries.map(
            (entry) => (entry.payload as { task: { id: string } }).task.id,
          );
          const taskIdsByLocalKey = Object.fromEntries(
            validatedInputs.map((task, index) => [task.local_key, newIds[index]!]),
          );
          const out = {
            ok: true,
            feature: opts.feature,
            task_ids: newIds,
            task_ids_by_local_key: taskIdsByLocalKey,
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
          // Current-task selection and shared replay history guarantee this body.
          const base = latestCanonicalTaskBody(session.entries, t.id)!;
          existingFull.push(materializeTaskForAmend(base, t));
        }

        // (6) Allocate and emit under one lease. The planner resolves local
        // refs only after every new id is known, so forward refs are stable.
        const result = await mutator.runPlannedBatch(
          featureDir,
          session,
          (snapshot) => {
            const allocation = allocateTaskAuthoringInputs(validatedInputs, occupiedTaskIds);
            if (!allocation.ok) return allocation;
            const based_on = snapshot.tasks_based_on ?? {
              spec: snapshot.state?.spec_version,
            };
            return {
              ok: true,
              entries: [
                {
                  kind: "event:tasks_planned",
                  payload: {
                    based_on,
                    tasks: [...existingFull, ...allocation.tasks],
                  },
                  actor,
                },
              ],
            };
          },
          {},
        );
        if (!result) return;

        // (7) Success output — echo the allocated ids for shell scripting.
        const plannedTasks = (
          result.entries[0]!.payload as {
            tasks: Array<{ id: string }>;
          }
        ).tasks;
        const newIds = plannedTasks.slice(existingFull.length).map((task) => task.id);
        const taskIdsByLocalKey = Object.fromEntries(
          validatedInputs.map((task, index) => [task.local_key, newIds[index]!]),
        );
        const out = {
          ok: true,
          feature: opts.feature,
          task_ids: newIds,
          task_ids_by_local_key: taskIdsByLocalKey,
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
}

export function registerTaskAmend(tasksCmd: Command, deps: TasksRegistrationDeps): void {
  const { ctx, mutator, actor, input } = deps;
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
    .option("--input <file>", jsonInputHelp(TASKS_AMEND_INPUT))
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
          ctx.failure(diagnostic("USAGE", { reason: "policy_and_input_mutually_exclusive" }));
          return;
        }
        if (hasInput !== hasFinding) {
          ctx.failure(diagnostic("USAGE", { reason: "sponsored_input_finding_pair_required" }));
          return;
        }
        if (!hasPolicy && !hasInput) {
          ctx.failure(diagnostic("USAGE", { reason: "amend_input_required" }));
          return;
        }

        // ── (b) SPONSORED --input path ──────────────────────────────────
        if (hasInput) {
          const inputPath = opts.input!;
          const findingId = opts.finding!;
          const read = await input.readJson(ctx, inputPath, TASKS_AMEND_INPUT);
          if (!read.ok) return;
          const inParsed = read.value;
          const inTask = TaskInput.safeParse(inParsed);
          if (!inTask.success) {
            ctx.failure(
              diagnostic("SCHEMA_VALIDATION_FAILED", {
                reason: inTask.error.issues.map((issue) => issue.message).join("; "),
                issues: inTask.error.issues,
              }),
            );
            return;
          }
          // (b3) Load session via ctx; the task being replaced must exist.
          const sFeatureDir = earlyFeatureDir;
          const sSession = await ctx.resolveSession(sFeatureDir);
          if (!sSession.snapshot.state) {
            ctx.failure(
              diagnosticVariant("failure.no_session.tasks", { ...{}, feature: opts.feature }),
            );
            return;
          }
          const sCurrent = sSession.snapshot.tasks.find((t) => t.id === taskId);
          if (!sCurrent) {
            ctx.failure(
              diagnostic("TASK_NOT_FOUND", {
                task_id: taskId,
              }),
            );
            return;
          }
          // (b4) Recover the current canonical body from the journal.
          // Current-task selection and shared replay history guarantee this body.
          const sCanonical = latestCanonicalTaskBody(sSession.entries, taskId)!;
          // (b5) Materialize the input under the EXISTING task id, carry the
          // body-only execution progress forward from the canonical body for
          // retained steps, then overlay live runtime status/applicability.
          const sNewGraph = materializeTaskInput(inTask.data, taskId);
          // (b5.1) codex r137 BLOCK 2 — reject a sponsored replace that DROPS
          // a canonical step still carrying execution progress.
          const sNewSteps = new Set(Object.keys(sNewGraph.execution));
          const sPriorExec = sCanonical.execution as Record<
            string,
            {
              status: string;
              started_at?: string;
              reason?: string;
            }
          >;
          for (const [stepName, prior] of Object.entries(sPriorExec)) {
            if (sNewSteps.has(stepName)) continue;
            if (
              prior.status !== "pending" ||
              prior.started_at !== undefined ||
              prior.reason !== undefined
            ) {
              ctx.failure(
                diagnostic("MUTATION_OUT_OF_RIGHTS", {
                  task_id: taskId,
                  step: stepName,
                  reason: "sponsored_amend_drops_progress_step",
                  sub_state: sSession.snapshot.state!.sub_state,
                }),
              );
              return;
            }
          }
          const sWithProgress = carryForwardStepProgress(sNewGraph, sCanonical);
          const sMaterialized = materializeTaskForAmend(sWithProgress, sCurrent);
          // (b6) Emit event:tasks_amended mode="replace" + sponsorship marker.
          const sResult = await mutator.run(sFeatureDir, sSession, {
            kind: "event:tasks_amended",
            payload: {
              mode: "replace",
              task: sMaterialized,
              sponsored_by_finding_id: findingId,
            },
            actor,
          });
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
              stateChange: i18n.t(SUCCESS_KEYS.amendStateChange, {
                task_id: taskId,
              }),
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
            ctx.failure(
              diagnostic("SCHEMA_VALIDATION_FAILED", {
                reason: "policy_requires_step_assignment",
                value: p,
              }),
            );
            return;
          }
          const step = p.slice(0, eq);
          const applicability = p.slice(eq + 1);
          if (!APPLICABILITY.includes(applicability)) {
            ctx.failure(
              diagnostic("SCHEMA_VALIDATION_FAILED", {
                reason: "invalid_policy_applicability",
                step,
                value: applicability,
                allowed: APPLICABILITY,
              }),
            );
            return;
          }
          if (policyMap.has(step)) {
            ctx.failure(
              diagnostic("SCHEMA_VALIDATION_FAILED", { reason: "duplicate_policy_step", step }),
            );
            return;
          }
          policyMap.set(step, applicability);
        }

        // (2) Load session.
        const featureDir = await ctx.dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await loadSession(featureDir, {
          ensureDir: !ctx.dryRun,
        });
        if (!session.snapshot.state) {
          ctx.failure(
            diagnosticVariant("failure.no_session.tasks", { ...{}, feature: opts.feature }),
          );
          return;
        }

        // (3) Current task must be in the projection.
        const current = session.snapshot.tasks.find((t) => t.id === taskId);
        if (!current) {
          ctx.failure(
            diagnostic("TASK_NOT_FOUND", {
              task_id: taskId,
            }),
          );
          return;
        }

        // (4) Recover the canonical full body from the journal.
        // Current-task selection and shared replay history guarantee this body.
        const base = latestCanonicalTaskBody(session.entries, taskId)!;

        // (5) Materialize (canonical body + live runtime status) then apply
        // the --policy applicability deltas.
        const materialized = materializeTaskForAmend(base, current);
        const execution = materialized.execution as Record<string, { applicability: string }>;
        for (const [step, applicability] of policyMap) {
          const seeded = execution[step];
          if (!seeded) {
            ctx.failure(diagnostic("TASK_STEP_NOT_FOUND", { task_id: taskId, step }));
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
            stateChange: i18n.t(SUCCESS_KEYS.amendStateChange, {
              task_id: taskId,
            }),
          }),
        );
      },
    );
}
