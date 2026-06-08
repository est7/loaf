// Phase 16 SC-15c — STEP_WRITE_PATHS / WRITE_CATEGORIES runtime/docs lockstep.
//
// Catches drift between the canonical tables in docs/schemas.ts (§27 + §27b)
// and the runtime mirror in src/core/step-write-paths.ts. The category
// tables are the write-guard security boundary, so deep-equality across the
// full structure matters.

import { describe, expect, test } from "vitest";

import {
  STEP_WRITE_PATHS_BY_KIND as DOCS_PATHS,
  VERIFY_CHECK_WRITE_PATHS as DOCS_VERIFY_PATHS,
  STEP_WRITE_CATEGORIES_BY_KIND as DOCS_CATEGORIES,
  VERIFY_CHECK_WRITE_CATEGORIES as DOCS_VERIFY_CATEGORIES,
  WriteCategory as DocsWriteCategory,
} from "../../docs/schemas.js";
import {
  STEP_WRITE_PATHS_BY_KIND,
  VERIFY_CHECK_WRITE_PATHS,
  STEP_WRITE_CATEGORIES_BY_KIND,
  VERIFY_CHECK_WRITE_CATEGORIES,
  WriteCategory,
} from "../../src/core/step-write-paths.js";

function norm(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v));
}

describe("STEP_WRITE_PATHS / categories runtime/docs lockstep", () => {
  test("STEP_WRITE_PATHS_BY_KIND deep-equals docs", () => {
    expect(norm(STEP_WRITE_PATHS_BY_KIND)).toEqual(norm(DOCS_PATHS));
  });

  test("VERIFY_CHECK_WRITE_PATHS deep-equals docs", () => {
    expect(norm(VERIFY_CHECK_WRITE_PATHS)).toEqual(norm(DOCS_VERIFY_PATHS));
  });

  test("STEP_WRITE_CATEGORIES_BY_KIND deep-equals docs", () => {
    expect(norm(STEP_WRITE_CATEGORIES_BY_KIND)).toEqual(norm(DOCS_CATEGORIES));
  });

  test("VERIFY_CHECK_WRITE_CATEGORIES deep-equals docs", () => {
    expect(norm(VERIFY_CHECK_WRITE_CATEGORIES)).toEqual(norm(DOCS_VERIFY_CATEGORIES));
  });

  test("WriteCategory enum options match docs (same set + order)", () => {
    expect(WriteCategory.options).toEqual(DocsWriteCategory.options);
  });

  test("every kind/step in PATHS has a matching CATEGORIES entry", () => {
    for (const [kind, steps] of Object.entries(STEP_WRITE_PATHS_BY_KIND)) {
      for (const step of Object.keys(steps)) {
        const cats = (STEP_WRITE_CATEGORIES_BY_KIND as Record<string, Record<string, unknown>>)[
          kind
        ]?.[step];
        expect(cats, `${kind}.${step} missing category entry`).toBeDefined();
      }
    }
  });
});
