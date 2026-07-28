import { describe, expect, test } from "vitest";

import { allocateTaskAuthoringInputs } from "../../src/cli/task-authoring.js";
import { TaskAuthoringInputBatched, TasksSubmitInput } from "../../src/core/task-schema.js";

const chore = (localKey: string, dependsOn: unknown[] = []) => ({
  local_key: localKey,
  kind: "chore" as const,
  no_test_rationale: "task authoring fixture",
  depends_on: dependsOn,
});

describe("strict task authoring contract", () => {
  test("submit rejects legacy full payload fields and unknown envelope keys", () => {
    const legacy = {
      based_on: { spec: 1 },
      tasks: [
        {
          ...chore("legacy"),
          id: "T-001",
          status: "pending",
          execution: {
            execute: {
              applicability: "must",
              status: "pending",
              evidence_refs: [],
            },
          },
        },
      ],
    };

    expect(TasksSubmitInput.safeParse(legacy).success).toBe(false);
    expect(
      TasksSubmitInput.safeParse({
        tasks: [chore("valid")],
        envelope: { actor: "caller" },
      }).success,
    ).toBe(false);
  });

  test("submit and add reject duplicate local keys", () => {
    expect(TasksSubmitInput.safeParse({ tasks: [chore("same"), chore("same")] }).success).toBe(
      false,
    );
    expect(TaskAuthoringInputBatched.safeParse([chore("same"), chore("same")]).success).toBe(false);
  });

  test("two-pass allocation resolves forward local refs and preserves task-id refs", () => {
    const parsed = TasksSubmitInput.parse({
      tasks: [
        chore("dependent", [{ local_key: "dependency" }, { task_id: "T-007" }]),
        chore("dependency"),
      ],
    });

    const result = allocateTaskAuthoringInputs(parsed.tasks, ["T-007"]);

    expect(result).toEqual({
      ok: true,
      task_ids_by_local_key: {
        dependent: "T-008",
        dependency: "T-009",
      },
      tasks: [
        expect.objectContaining({
          id: "T-008",
          depends_on: ["T-009", "T-007"],
          status: "pending",
        }),
        expect.objectContaining({
          id: "T-009",
          depends_on: [],
          status: "pending",
        }),
      ],
    });
  });

  test("unknown local dependency fails without inventing a graph edge", () => {
    const parsed = TaskAuthoringInputBatched.parse(chore("dependent", [{ local_key: "missing" }]));
    const inputs = Array.isArray(parsed) ? parsed : [parsed];

    expect(allocateTaskAuthoringInputs(inputs, [])).toEqual({
      ok: false,
      code: "SCHEMA_VALIDATION_FAILED",
      message: "task local_key=dependent depends on unknown local_key=missing",
      detail: {
        local_key: "dependent",
        dependency_local_key: "missing",
      },
    });
  });
});
