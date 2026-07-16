import { describe, expect, test } from "vitest";

import {
  STEP_WRITE_CATEGORIES_BY_KIND,
  STEP_WRITE_PATHS_BY_KIND,
  VERIFY_CHECK_WRITE_CATEGORIES,
  VERIFY_CHECK_WRITE_PATHS,
  WriteCategory,
} from "../../src/core/step-write-paths.js";

describe("step-write-paths machine contract", () => {
  test("WriteCategory keeps the canonical option order", () => {
    expect(WriteCategory.options).toEqual([
      "source",
      "tests",
      "docs",
      "ui",
      "public_api",
      "schema",
      "security",
    ]);
  });

  test("every task kind/step path entry has a category entry", () => {
    for (const [kind, steps] of Object.entries(STEP_WRITE_PATHS_BY_KIND)) {
      for (const step of Object.keys(steps)) {
        const categories = (
          STEP_WRITE_CATEGORIES_BY_KIND as Record<string, Record<string, readonly string[]>>
        )[kind]?.[step];
        expect(categories, `${kind}.${step} missing category entry`).toBeDefined();
        expect(categories!.every((category) => WriteCategory.safeParse(category).success)).toBe(
          true,
        );
      }
    }
  });

  test("every category entry has a matching path entry", () => {
    for (const [kind, steps] of Object.entries(STEP_WRITE_CATEGORIES_BY_KIND)) {
      for (const step of Object.keys(steps)) {
        const paths = (STEP_WRITE_PATHS_BY_KIND as Record<string, Record<string, unknown>>)[kind]?.[
          step
        ];
        expect(paths, `${kind}.${step} missing path entry`).toBeDefined();
      }
    }
  });

  test("verify paths and categories cover the same four lanes", () => {
    const expected = ["run", "review", "acceptance", "visual"];
    expect(Object.keys(VERIFY_CHECK_WRITE_PATHS)).toEqual(expected);
    expect(Object.keys(VERIFY_CHECK_WRITE_CATEGORIES)).toEqual(expected);
  });
});
