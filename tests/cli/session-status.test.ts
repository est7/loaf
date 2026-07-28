import { describe, expect, test } from "vitest";

import {
  classifyPendingHead,
  classifySessionStatus,
} from "../../src/cli/session-status.js";

describe("session status semantics", () => {
  test.each([
    [
      "done wins over blocked and running",
      {
        sub_state: "DONE.delivered",
        pending_queue_depth: 1,
        active_tasks: ["T-001"],
      },
      "done",
    ],
    [
      "blocked wins over running",
      {
        sub_state: "EXECUTE.work",
        pending_queue_depth: 1,
        active_tasks: ["T-001"],
      },
      "blocked",
    ],
    [
      "active tasks are running",
      {
        sub_state: "EXECUTE.work",
        pending_queue_depth: 0,
        active_tasks: ["T-001"],
      },
      "running",
    ],
    [
      "remaining sessions are idle",
      {
        sub_state: "VERIFY.accept",
        pending_queue_depth: 0,
        active_tasks: [],
      },
      "idle",
    ],
  ] as const)("%s", (_name, input, expected) => {
    expect(classifySessionStatus(input)).toBe(expected);
  });

  test.each([
    ["gate_decision", "decision"],
    ["profile_escalation", "decision"],
    ["ask_user_question", "question"],
    ["spec_clarification", "question"],
    ["finding_decision", "question"],
    [null, null],
  ] as const)("maps pending head %s to %s", (kind, expected) => {
    expect(classifyPendingHead(kind)).toBe(expected);
  });
});
