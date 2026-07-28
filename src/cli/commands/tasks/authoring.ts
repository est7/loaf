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
import { FAILURE_SITE_KEYS, SUCCESS_KEYS } from "../../runtime-i18n-keys.js";
import { buildNextAdvisory, pendingKindsForNext } from "../../next-advisory.js";
import type { TasksRegistrationDeps } from "./types.js";

const TASKS_SUBMIT_INPUT: JsonInputDeclaration = {
  command: "loaf tasks submit",
  helpPrefix: "JSON source",
  inlineLabel: "inline JSON literal",
  helpSuffix: " (protocol §10.7). Whole-graph single object only.",
  stdinExpectation: "piped input",
  missing: {
    message:
      "loaf tasks submit requires --input <src> (or pass --schema to dump the input JSON Schema)",
    route: "emit-failure",
  },
};

const TASKS_ADD_INPUT: JsonInputDeclaration = {
  command: "loaf tasks add",
  helpPrefix: "JSON source for semantic task input (single object or array)",
  inlineLabel: "inline JSON",
  helpSuffix: " (protocol §10.7)",
  stdinExpectation: "piped input",
  missing: {
    message:
      "loaf tasks add requires --input <src> (or pass --schema to dump the input JSON Schema)",
    route: "emit-failure",
  },
};

const TASKS_AMEND_INPUT: JsonInputDeclaration = {
  command: "loaf tasks amend",
  helpPrefix: "New id-less task definition for a sponsored graph replacement",
  inlineLabel: "inline JSON",
  helpText: "New id-less task definition for a sponsored graph replacement (JSON file or '-')",
  stdinExpectation: "piped input",
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
    .action(async (rawOpts: {
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
          "SCHEMA_VALIDATION_FAILED",
          "tasks submit input must be a strict semantic graph with id-less tasks and unique local_key values",
          {
            issues: parsed.error.issues,
            migration: "legacy-full-input-rejected",
          },
        );
        return;
      }

      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await ctx.resolveSession(featureDir);
      if (!session.snapshot.state) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
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
              message: "internal: session state missing while planning task graph",
              detail: {},
            };
          }
          return {
            ok: true,
            entries: [{
              kind: "event:tasks_planned",
              payload: {
                based_on: { spec: specVersion },
                tasks: allocation.tasks,
              },
              actor,
            }],
          };
        },
        { route: "raw-ctx-failure" },
      );
      if (!result) return;
      const state = result.snapshot.state;
      if (state === null) {
        ctx.emitFailure(
          "REDUCER_ERROR",
          "internal: state missing from snapshot after successful event:tasks_planned apply",
        );
        return;
      }

      // Success output via ctx.success — output bytes identical to
      // pre-SC-4b shape (asserted via existing tasks-submit tests).
      const tasks = result.snapshot.tasks;
      const taskIds = tasks.map((t) => t.id);
      const plannedTasks = (result.entries[0]!.payload as {
        tasks: Array<{ id: string }>;
      }).tasks;
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
        (i18n) => {
          const next = buildNextAdvisory(
            i18n,
            {
              feature: state.feature,
              feature_dir: featureDir,
              phase: state.phase,
              sub_state: state.sub_state,
              ceremony: state.ceremony,
              spec_locked: state.spec_locked,
              verify_accepted: state.verify_accepted,
              pending: pendingKindsForNext(result.snapshot.pending),
            },
            opts.featureDir !== undefined
              ? { kind: "feature-dir", value: featureDir }
              : { kind: "feature", value: state.feature },
          );
          return {
            stateChange: i18n.t(SUCCESS_KEYS.tasksSubmitStateChange, { count: tasks.length }),
            ...(next === undefined ? {} : { next }),
          };
        },
      );
    });
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
            ctx.failureKeyed(
              "SCHEMA_VALIDATION_FAILED",
              FAILURE_SITE_KEYS.tasksAddEmptyArray,
              {},
              {},
            );
            return;
          }
          ctx.failure(
            "SCHEMA_VALIDATION_FAILED",
            "tasks add input must contain strict id-less tasks with local_key and explicit dependency refs",
            {
              issues: inputParse.error.issues,
              migration: "legacy-task-input-rejected",
            },
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
            { timestamps: "per-entry", route: "raw-ctx-failure" },
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
              entries: [{
                kind: "event:tasks_planned",
                payload: {
                  based_on,
                  tasks: [...existingFull, ...allocation.tasks],
                },
                actor,
              }],
            };
          },
          { route: "raw-ctx-failure" },
        );
        if (!result) return;

        // (7) Success output — echo the allocated ids for shell scripting.
        const plannedTasks = (result.entries[0]!.payload as {
          tasks: Array<{ id: string }>;
        }).tasks;
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
          const read = await input.readJson(ctx, inputPath, TASKS_AMEND_INPUT);
          if (!read.ok) return;
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
            {
              status: string;
              evidence_refs: string[];
              started_at?: string;
              reason?: string;
            }
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
                {
                  task_id: taskId,
                  step: stepName,
                  reason: "sponsored_amend_drops_progress_step",
                },
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
        const session = await loadSession(featureDir, {
          ensureDir: !ctx.dryRun,
        });
        if (!session.snapshot.state) {
          ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
          return;
        }

        // (3) Current task must be in the projection.
        const current = session.snapshot.tasks.find((t) => t.id === taskId);
        if (!current) {
          ctx.emitFailure(
            "TASK_NOT_FOUND",
            `task ${taskId} is not in the current tasks projection`,
            {
              task_id: taskId,
            },
          );
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
            stateChange: i18n.t(SUCCESS_KEYS.amendStateChange, {
              task_id: taskId,
            }),
          }),
        );
      },
    );
}
