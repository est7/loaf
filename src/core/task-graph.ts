import type { TaskState } from "./projection-types.js";

type TaskGraphTask = Pick<TaskState, "id" | "status" | "depends_on">;

export type TaskGraphFailure =
  | {
      code: "TASK_DEP_NOT_FOUND";
      message: string;
      detail: { task_id: string; field: string; ref: string };
    }
  | {
      code: "TASK_DEP_SELF";
      message: string;
      detail: { task_id: string };
    }
  | {
      code: "TASK_DEP_DUPLICATE";
      message: string;
      detail: { task_id: string; ref: string; indexes: [number, number] };
    }
  | {
      code: "TASK_DEP_CYCLE";
      message: string;
      detail: { cycle: string[] };
    }
  | {
      code: "TASK_DEP_ABANDONED";
      message: string;
      detail: { task_id: string; field: string; ref: string; hint: string };
    };

export type TaskGraphFailureCode = TaskGraphFailure["code"];

export function areTaskDependenciesSatisfied(
  task: Pick<TaskState, "depends_on">,
  tasksById: ReadonlyMap<string, Pick<TaskState, "status">>,
): boolean {
  return task.depends_on.every((dependencyId) => tasksById.get(dependencyId)?.status === "done");
}

/** Validate the batch-final task projection at the admission boundary. */
export function checkTaskGraph(tasks: readonly TaskGraphTask[]): TaskGraphFailure | null {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));

  for (const task of tasks) {
    for (let index = 0; index < task.depends_on.length; index++) {
      const dependencyId = task.depends_on[index]!;
      if (!tasksById.has(dependencyId)) {
        return {
          code: "TASK_DEP_NOT_FOUND",
          message: `task ${task.id} dependency ${dependencyId} at depends_on[${index}] does not exist in the batch-final task graph`,
          detail: { task_id: task.id, field: `depends_on[${index}]`, ref: dependencyId },
        };
      }
    }
  }

  for (const task of tasks) {
    if (task.depends_on.includes(task.id)) {
      return {
        code: "TASK_DEP_SELF",
        message: `task ${task.id} cannot depend on itself`,
        detail: { task_id: task.id },
      };
    }
  }

  for (const task of tasks) {
    const firstIndexByDependency = new Map<string, number>();
    for (let index = 0; index < task.depends_on.length; index++) {
      const dependencyId = task.depends_on[index]!;
      const firstIndex = firstIndexByDependency.get(dependencyId);
      if (firstIndex !== undefined) {
        return {
          code: "TASK_DEP_DUPLICATE",
          message: `task ${task.id} dependency ${dependencyId} is duplicated at depends_on indexes ${firstIndex} and ${index}`,
          detail: { task_id: task.id, ref: dependencyId, indexes: [firstIndex, index] },
        };
      }
      firstIndexByDependency.set(dependencyId, index);
    }
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];

  const findCycle = (taskId: string): string[] | null => {
    visited.add(taskId);
    active.add(taskId);
    stack.push(taskId);

    const task = tasksById.get(taskId)!;
    for (const dependencyId of task.depends_on) {
      if (!visited.has(dependencyId)) {
        const cycle = findCycle(dependencyId);
        if (cycle !== null) return cycle;
      } else if (active.has(dependencyId)) {
        const cycleStart = stack.indexOf(dependencyId);
        return [...stack.slice(cycleStart), dependencyId];
      }
    }

    stack.pop();
    active.delete(taskId);
    return null;
  };

  // Selection is deterministic: roots follow task array order, adjacency
  // follows depends_on index order, and the first DFS back edge wins.
  for (const task of tasks) {
    if (visited.has(task.id)) continue;
    const cycle = findCycle(task.id);
    if (cycle !== null) {
      return {
        code: "TASK_DEP_CYCLE",
        message: `task dependency graph contains cycle ${cycle.join(" -> ")}`,
        detail: { cycle },
      };
    }
  }

  for (const task of tasks) {
    if (task.status === "done" || task.status === "abandoned") continue;
    for (let index = 0; index < task.depends_on.length; index++) {
      const dependencyId = task.depends_on[index]!;
      if (tasksById.get(dependencyId)!.status === "abandoned") {
        return {
          code: "TASK_DEP_ABANDONED",
          message: `non-terminal task ${task.id} dependency ${dependencyId} at depends_on[${index}] is abandoned; replace it via amend-tasks`,
          detail: {
            task_id: task.id,
            field: `depends_on[${index}]`,
            ref: dependencyId,
            hint: "replace the abandoned dependency via amend-tasks",
          },
        };
      }
    }
  }

  return null;
}
