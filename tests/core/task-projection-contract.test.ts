// L5 / T3 — compile-time contract test. The full→slim conversion
// (extractTaskSlim) accepts a raw TaskProjectionInput derived from the
// TaskFullProjection flattened read-view, whose
// doc claims "any TaskFullPayload variant satisfies" it. That claim used to be
// FALSE under exactOptionalPropertyTypes (zod `.optional()` keys are `T |
// undefined`, the read-view's were exact `?: T`), and the CLI read-path bypassed
// it with `as unknown as TaskFullProjection`. L5 relaxed the read-view's
// optionals to `?: T | undefined` so the union provably satisfies it and the
// casts disappear.
//
// This pins that contract: the assertion is COMPILE-TIME, enforced by
// `bun run typecheck` (tsc --noEmit covers tests/**/*.ts), NOT by `vitest run`.
// If the six optionals are re-tightened to exact `?: T`, tsc fails HERE — so the
// cast pressure can never silently return. Direction is payload ⊑ projection.

import type { z } from "zod";
import { describe, expect, expectTypeOf, test } from "vitest";

import type {
  TaskFullPayload,
  TaskFullProjection,
  TaskProjectionInput,
} from "../../src/core/task-schema.js";

import { extractTaskSlim } from "../../src/core/task-schema.js";

describe("TaskFullProjection read-view contract (L5 / T3)", () => {
  test("every validated TaskFullPayload variant is assignable to TaskFullProjection", () => {
    expectTypeOf<TaskFullPayload>().toExtend<TaskFullProjection>();
  });
  test("raw schema input is assignable to the projection input seam", () => {
    expectTypeOf<z.input<typeof TaskFullPayload>>().toExtend<TaskProjectionInput>();
    expectTypeOf<TaskFullPayload>().toExtend<TaskProjectionInput>();
  });
});

test("slim projection preserves explicit arrays, flags and historical extra execution steps", () => {
  const task: TaskProjectionInput = {
    id: "T-001",
    kind: "chore",
    status: "pending",
    depends_on: ["T-002"],
    labels: ["maintenance"],
    no_test_rationale: "Routine maintenance operation",
    requires_acceptance: true,
    execution: {
      execute: { applicability: "must", status: "pending" },
      historical_extra: {
        applicability: "optional",
        status: "passed",
        reason: "Preserved historical step",
      },
    },
  };
  expect(extractTaskSlim(task)).toEqual({
    id: "T-001",
    kind: "chore",
    status: "pending",
    drives: [],
    depends_on: ["T-002"],
    labels: ["maintenance"],
    no_test_rationale: "Routine maintenance operation",
    requires_acceptance: true,
    steps: {
      execute: { applicability: "must", status: "pending" },
      historical_extra: { applicability: "optional", status: "passed" },
    },
  });
});
