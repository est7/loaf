// Phase 16 SC-15a — HookEvent runtime/docs lockstep drift gate.
//
// Catches drift between `docs/schemas.ts:HookEvent` (canonical) and
// `src/core/hook-events.ts:HookEvent` (runtime mirror) on the
// canonical 4-event enum + ClaudeCode wire-protocol map.

import { describe, expect, test } from "vitest";

import { HookEvent as DocsHookEvent, HOOK_EVENT_TO_CLAUDE_CODE as DOCS_MAP } from "../../docs/schemas.js";
import {
  HOOK_EVENTS,
  HOOK_EVENT_TO_CLAUDE_CODE,
  HookEvent as RuntimeHookEvent,
} from "../../src/core/hook-events.js";

describe("HookEvent runtime/docs lockstep", () => {
  test("enum options match (same 4 values, same order)", () => {
    expect(RuntimeHookEvent.options).toEqual(DocsHookEvent.options);
    expect(HOOK_EVENTS).toEqual([
      "session-start",
      "write-guard",
      "scope-track",
      "closure-check",
    ]);
  });

  test("ClaudeCode map keys + values match docs", () => {
    expect(HOOK_EVENT_TO_CLAUDE_CODE).toEqual(DOCS_MAP);
  });

  test("every runtime event parses through docs schema", () => {
    for (const event of HOOK_EVENTS) {
      expect(DocsHookEvent.safeParse(event).success).toBe(true);
    }
  });

  test("unknown event rejected by both schemas", () => {
    expect(DocsHookEvent.safeParse("bogus").success).toBe(false);
    expect(RuntimeHookEvent.safeParse("bogus").success).toBe(false);
  });
});
