import { describe, expect, test } from "vitest";

import { EarsType } from "../../src/core/spec-schema.js";
import {
  AnyStep,
  BehavioralStep,
  STEP_TO_KIND,
  TaskInputBatched,
  TaskKind,
} from "../../src/core/task-schema.js";

describe("payload-domain dissolution", () => {
  test("task domain owns the closed kind and derived step contracts", () => {
    expect(TaskKind.options).toEqual([
      "behavioral",
      "structural",
      "visual-ui",
      "docs",
      "spike",
      "chore",
    ]);
    expect(BehavioralStep.options).toEqual(["red", "implement", "refactor"]);
    expect(AnyStep.safeParse("screenshot-compare").success).toBe(true);
    expect(AnyStep.safeParse("unknown-step").success).toBe(false);
    expect(STEP_TO_KIND).toEqual({
      red: ["behavioral"],
      implement: ["behavioral", "structural", "visual-ui"],
      refactor: ["behavioral", "structural"],
      mockup: ["visual-ui"],
      "screenshot-compare": ["visual-ui"],
      draft: ["docs"],
      review: ["docs"],
      explore: ["spike"],
      prototype: ["spike"],
      record: ["spike"],
      execute: ["chore"],
    });
  });

  test("task batch contract accepts one input or a non-empty array", () => {
    const input = {
      kind: "chore" as const,
      no_test_rationale: "Version metadata-only maintenance.",
    };

    expect(TaskInputBatched.safeParse(input).success).toBe(true);
    expect(TaskInputBatched.safeParse([input]).success).toBe(true);
    expect(TaskInputBatched.safeParse([]).success).toBe(false);
  });

  test("spec domain owns the closed EARS discriminator", () => {
    expect(EarsType.options).toEqual([
      "ubiquitous",
      "event-driven",
      "state-driven",
      "optional",
      "unwanted",
    ]);
  });
});
