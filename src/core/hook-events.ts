// Phase 16 SC-15a — runtime mirror of `docs/schemas.ts:HookEvent`.
//
// Stable-core layer does NOT import from docs/ (project pattern).
// Lockstep test at `tests/cli/hook-events-runtime-lockstep.test.ts`
// catches drift between this mirror and the canonical docs schema.

import { z } from "zod";

/** Canonical 4-event enum per protocol §11 / docs/schemas.ts §36. */
export const HookEvent = z.enum([
  "session-start",
  "write-guard",
  "scope-track",
  "closure-check",
]);
export type HookEvent = z.infer<typeof HookEvent>;

/** Canonical event list — frozen order for stable `--list-events` output
 *  and unknown-event did-you-mean ranking. */
export const HOOK_EVENTS = HookEvent.options;

/** Map each hook event to its Claude Code wire-protocol event name.
 *  Mirror of `docs/schemas.ts:HOOK_EVENT_TO_CLAUDE_CODE`. */
export const HOOK_EVENT_TO_CLAUDE_CODE: Record<HookEvent, string> = {
  "session-start": "SessionStart",
  "write-guard": "PreToolUse(Write,Edit)",
  "scope-track": "PostToolUse(Write,Edit)",
  "closure-check": "Stop",
};
