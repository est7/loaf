// L5 / T3 — compile-time contract test. The full→slim conversion
// (extractTaskSlim) consumes TaskFullProjection, a flattened read-view whose
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

import { describe, expectTypeOf, test } from "vitest";

import type { TaskFullPayload, TaskFullProjection } from "../../src/core/task-schema.js";

describe("TaskFullProjection read-view contract (L5 / T3)", () => {
  test("every validated TaskFullPayload variant is assignable to TaskFullProjection", () => {
    expectTypeOf<TaskFullPayload>().toExtend<TaskFullProjection>();
  });
});
