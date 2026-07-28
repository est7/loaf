import {
  materializeTaskInput,
  TaskInput,
  type TaskAuthoringInput,
  type TaskFullPayload,
} from "../core/task-schema.js";
import type { JournalEntry } from "../core/journal-entry.js";
import type { Snapshot } from "../core/reducer.js";

export type TaskAuthoringAllocation =
  | {
      ok: true;
      tasks: TaskFullPayload[];
      task_ids_by_local_key: Record<string, string>;
    }
  | {
      ok: false;
      code: "SCHEMA_VALIDATION_FAILED" | "REDUCER_ERROR";
      message: string;
      detail: Record<string, unknown>;
    };

/** Collect every task id ever authored so whole-graph replacement never reuses one. */
export function collectOccupiedTaskIds(
  snapshot: Pick<Snapshot, "tasks">,
  entries: readonly JournalEntry[],
): string[] {
  const ids = new Set(snapshot.tasks.map((task) => task.id));
  for (const entry of entries) {
    if (entry.kind === "event:tasks_planned") {
      const tasks = (entry.payload as { tasks?: Array<{ id?: unknown }> }).tasks ?? [];
      for (const task of tasks) {
        if (typeof task.id === "string") ids.add(task.id);
      }
    } else if (entry.kind === "event:tasks_amended") {
      const taskId = (entry.payload as { task?: { id?: unknown } }).task?.id;
      if (typeof taskId === "string") ids.add(taskId);
    }
  }
  return [...ids];
}

function maxTaskSerial(taskIds: readonly string[]): number | null {
  let max = 0;
  for (const taskId of taskIds) {
    const match = /^T-(\d{3,})$/.exec(taskId);
    if (match === null) return null;
    max = Math.max(max, Number.parseInt(match[1]!, 10));
  }
  return max;
}

/**
 * Allocate every id before resolving dependencies, so forward local refs are
 * deterministic. `occupiedTaskIds` should include current and historical ids;
 * callers execute this planner while the feature write lease is held.
 */
export function allocateTaskAuthoringInputs(
  inputs: readonly TaskAuthoringInput[],
  occupiedTaskIds: readonly string[],
): TaskAuthoringAllocation {
  const maxSerial = maxTaskSerial(occupiedTaskIds);
  if (maxSerial === null) {
    const invalid = occupiedTaskIds.find((taskId) => !/^T-\d{3,}$/.test(taskId))!;
    return {
      ok: false,
      code: "REDUCER_ERROR",
      message: `internal: task id ${invalid} is not canonical T-NNN; cannot allocate the next id`,
      detail: { task_id: invalid },
    };
  }

  const taskIdsByLocalKey: Record<string, string> = {};
  for (let index = 0; index < inputs.length; index += 1) {
    taskIdsByLocalKey[inputs[index]!.local_key] =
      `T-${String(maxSerial + index + 1).padStart(3, "0")}`;
  }

  const tasks: TaskFullPayload[] = [];
  for (const input of inputs) {
    const dependsOn: string[] = [];
    for (const dependency of input.depends_on) {
      if ("task_id" in dependency) {
        dependsOn.push(dependency.task_id);
        continue;
      }
      const taskId = taskIdsByLocalKey[dependency.local_key];
      if (taskId === undefined) {
        return {
          ok: false,
          code: "SCHEMA_VALIDATION_FAILED",
          message: `task local_key=${input.local_key} depends on unknown local_key=${dependency.local_key}`,
          detail: {
            local_key: input.local_key,
            dependency_local_key: dependency.local_key,
          },
        };
      }
      dependsOn.push(taskId);
    }

    const {
      local_key: _localKey,
      depends_on: _dependencies,
      step_policy: stepPolicy,
      ...body
    } = input;
    const canonicalInput = TaskInput.parse({ ...body, depends_on: dependsOn });
    const task = materializeTaskInput(canonicalInput, taskIdsByLocalKey[input.local_key]!);
    if (stepPolicy !== undefined) {
      const execution = task.execution as Record<
        string,
        { applicability: "must" | "optional" | "na" }
      >;
      for (const [step, applicability] of Object.entries(stepPolicy)) {
        if (applicability === undefined) continue;
        execution[step]!.applicability = applicability;
      }
    }
    tasks.push(task);
  }

  return {
    ok: true,
    tasks,
    task_ids_by_local_key: taskIdsByLocalKey,
  };
}
