import { describe, expect, test } from "vitest";

import type { TaskState } from "../../src/core/projection-types.js";
import {
  areTaskDependenciesSatisfied,
  checkTaskGraph,
} from "../../src/core/task-graph.js";

function task(
  id: string,
  dependsOn: string[] = [],
  status: TaskState["status"] = "pending",
): TaskState {
  return {
    id,
    kind: "chore",
    status,
    steps: {},
    drives: [],
    depends_on: dependsOn,
    labels: [],
  };
}

describe("checkTaskGraph", () => {
  test.each([
    {
      name: "rejects an unresolved dependency with its indexed field path",
      tasks: [task("T-001", ["T-404"])],
      expected: {
        code: "TASK_DEP_NOT_FOUND",
        detail: { task_id: "T-001", field: "depends_on[0]", ref: "T-404" },
      },
    },
    {
      name: "rejects a self dependency",
      tasks: [task("T-001", ["T-001"])],
      expected: {
        code: "TASK_DEP_SELF",
        detail: { task_id: "T-001" },
      },
    },
    {
      name: "rejects duplicate dependencies with their first pair of indexes",
      tasks: [task("T-001", ["T-002", "T-003", "T-002"]), task("T-002"), task("T-003")],
      expected: {
        code: "TASK_DEP_DUPLICATE",
        detail: { task_id: "T-001", ref: "T-002", indexes: [0, 2] },
      },
    },
    {
      name: "rejects a cycle with an ordered closed path",
      tasks: [task("T-001", ["T-002"]), task("T-002", ["T-003"]), task("T-003", ["T-001"])],
      expected: {
        code: "TASK_DEP_CYCLE",
        detail: { cycle: ["T-001", "T-002", "T-003", "T-001"] },
      },
    },
    {
      name: "rejects a non-terminal task depending on an abandoned task",
      tasks: [task("T-001", ["T-002"], "pending"), task("T-002", [], "abandoned")],
      expected: {
        code: "TASK_DEP_ABANDONED",
        detail: {
          task_id: "T-001",
          field: "depends_on[0]",
          ref: "T-002",
          hint: "replace the abandoned dependency via amend-tasks",
        },
      },
    },
  ])("$name", ({ tasks, expected }) => {
    const failure = checkTaskGraph(tasks);
    expect(failure).toEqual(expect.objectContaining(expected));
    expect(Object.keys(failure?.detail ?? {}).sort()).toEqual(
      Object.keys(expected.detail).sort(),
    );
  });

  test("accepts a done task depending on an abandoned task", () => {
    expect(
      checkTaskGraph([task("T-001", ["T-002"], "done"), task("T-002", [], "abandoned")]),
    ).toBeNull();
  });

  test("selects the first DFS back edge by task order, then depends_on index order", () => {
    const tasks = [
      task("T-001", ["T-004", "T-002"]),
      task("T-002", ["T-003"]),
      task("T-003", ["T-002"]),
      task("T-004", ["T-005"]),
      task("T-005", ["T-004"]),
    ];

    expect(checkTaskGraph(tasks)).toMatchObject({
      code: "TASK_DEP_CYCLE",
      detail: { cycle: ["T-004", "T-005", "T-004"] },
    });
  });
});

describe("areTaskDependenciesSatisfied", () => {
  test("requires every referenced dependency to exist and be done", () => {
    const done = task("T-001", [], "done");
    const pending = task("T-002");
    const tasksById = new Map([done, pending].map((item) => [item.id, item]));

    expect(areTaskDependenciesSatisfied(task("T-003"), tasksById)).toBe(true);
    expect(areTaskDependenciesSatisfied(task("T-003", ["T-001"]), tasksById)).toBe(true);
    expect(areTaskDependenciesSatisfied(task("T-003", ["T-002"]), tasksById)).toBe(false);
    expect(areTaskDependenciesSatisfied(task("T-003", ["T-404"]), tasksById)).toBe(false);
  });
});
