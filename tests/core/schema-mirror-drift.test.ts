// W6 — schema mirror-drift gate.
//
// Remaining docs/schemas.ts mirror-drift gate. Payload-domain schemas now
// live in src/core/{finding,evidence,task,spec}-schema.ts and no longer need
// runtime-vs-doc comparisons. Journal-domain mirrors remain until their own
// dissolution sub-cycle.
//
// Scope: closed `z.enum` value sets only (the drift class that silently bypasses
// invariants). Shapes/refines are out of scope — those have their own tests.

import { describe, expect, test } from "vitest";

import * as docs from "../../docs/schemas.js";
import {
  GateName as RtGateName,
  PendingPromptKind as RtPendingPromptKind,
} from "../../src/core/journal-entry.js";

type ZEnum = { options: readonly string[] };

// Runtime mirror ↔ docs/schemas.ts canonical for domains not dissolved yet.
const PAIRS: Array<{ name: string; runtime: ZEnum; canonical: ZEnum }> = [
  { name: "GateName", runtime: RtGateName, canonical: docs.GateName },
  { name: "PendingPromptKind", runtime: RtPendingPromptKind, canonical: docs.PendingPromptKind },
];

describe("W6 — remaining runtime schema mirrors match docs/schemas.ts", () => {
  for (const { name, runtime, canonical } of PAIRS) {
    test(`${name} enum value set is in lockstep`, () => {
      // Order-insensitive set equality: the runtime mirror must enumerate
      // exactly the canonical value set — no missing, no extra.
      expect([...runtime.options].sort()).toEqual([...canonical.options].sort());
    });
  }

  test("every pair references a defined canonical enum (no typo'd import)", () => {
    for (const { name, canonical } of PAIRS) {
      expect(Array.isArray(canonical.options), `${name} canonical .options`).toBe(true);
    }
  });
});
