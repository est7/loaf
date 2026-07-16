import { describe, expect, test } from "vitest";

import { HOOK_EVENTS, HOOK_EVENT_TO_CLAUDE_CODE, HookEvent } from "../../src/core/hook-events.js";

describe("HookEvent machine contract", () => {
  test("keeps the four canonical events in wire order", () => {
    expect(HOOK_EVENTS).toEqual(["session-start", "write-guard", "scope-track", "closure-check"]);
    expect(HookEvent.options).toEqual(HOOK_EVENTS);
  });

  test("maps every event to its Claude Code protocol name", () => {
    expect(HOOK_EVENT_TO_CLAUDE_CODE).toEqual({
      "session-start": "SessionStart",
      "write-guard": "PreToolUse(Write,Edit)",
      "scope-track": "PostToolUse(Write,Edit)",
      "closure-check": "Stop",
    });
  });

  test("rejects unknown events", () => {
    expect(HookEvent.safeParse("bogus").success).toBe(false);
  });
});
