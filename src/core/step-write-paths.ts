// Phase 16 SC-15c — runtime mirror of the canonical write-path + write-
// category tables in `docs/schemas.ts`:
//   - STEP_WRITE_PATHS_BY_KIND        (§27)
//   - VERIFY_CHECK_WRITE_PATHS        (§27)
//   - STEP_WRITE_CATEGORIES_BY_KIND   (§27b)
//   - VERIFY_CHECK_WRITE_CATEGORIES   (§27b)
//
// Stable-core does NOT import from docs/ (project pattern, same as
// hook-events.ts / sub-state-contracts.ts). The lockstep test at
// `tests/cli/step-write-paths-runtime-lockstep.test.ts` catches drift.
//
// The category tables are the write-guard SECURITY BOUNDARY: they decide
// which `loaf.config.json paths.<category>` keys may widen a given step's
// built-in globs. They are canonical in docs/schemas.ts (§27b) precisely
// because they are a public authorization rule, not an implementation
// detail.

import { z } from "zod";

export type VerifyCheckKind = "run" | "review" | "acceptance" | "visual";

/** Semantic write categories — the `loaf.config.json paths.*` keys. */
export const WriteCategory = z.enum([
  "source",
  "tests",
  "docs",
  "ui",
  "public_api",
  "schema",
  "security",
]);
export type WriteCategory = z.infer<typeof WriteCategory>;

export const STEP_WRITE_PATHS_BY_KIND = {
  behavioral: {
    red: ["**/test/**", "tests/**", "src/**/__tests__/**"],
    implement: ["src/**", "lib/**"],
    refactor: ["src/**", "lib/**", "**/test/**"],
  },
  structural: {
    implement: ["src/**", "lib/**"],
    refactor: ["src/**", "lib/**"],
  },
  "visual-ui": {
    mockup: ["docs/mockups/**", ".loaf/<feature>/attachments/**"],
    implement: ["src/**", "res/**", "**/ui/**"],
    "screenshot-compare": [".loaf/<feature>/attachments/**"],
  },
  docs: {
    draft: ["docs/**", "**/*.md", "README*"],
    review: [],
  },
  spike: {
    explore: [],
    prototype: ["**/*"],
    record: [".loaf/<feature>/evidence.jsonl"],
  },
  chore: {
    execute: ["**/*"],
  },
} as const;

export const VERIFY_CHECK_WRITE_PATHS: Record<VerifyCheckKind, string[]> = {
  run: [],
  review: [],
  acceptance: [],
  visual: [".loaf/<feature>/attachments/**"],
};

export const STEP_WRITE_CATEGORIES_BY_KIND: {
  [K in keyof typeof STEP_WRITE_PATHS_BY_KIND]: {
    [S in keyof (typeof STEP_WRITE_PATHS_BY_KIND)[K]]: WriteCategory[];
  };
} = {
  behavioral: {
    red: ["tests"],
    implement: ["source"],
    refactor: ["source", "tests"],
  },
  structural: {
    implement: ["source"],
    refactor: ["source"],
  },
  "visual-ui": {
    mockup: ["docs"],
    implement: ["source", "ui"],
    "screenshot-compare": [],
  },
  docs: {
    draft: ["docs"],
    review: [],
  },
  spike: {
    explore: [],
    prototype: [],
    record: [],
  },
  chore: {
    execute: [],
  },
};

export const VERIFY_CHECK_WRITE_CATEGORIES: Record<VerifyCheckKind, WriteCategory[]> = {
  run: [],
  review: [],
  acceptance: [],
  visual: [],
};

export type TaskKind = keyof typeof STEP_WRITE_PATHS_BY_KIND;

/**
 * Built-in write globs for a (kind, step) pair. Returns `[]` for an unknown
 * kind/step combination (caller treats absence as "no built-in grant").
 */
export function stepWritePaths(kind: string, step: string): readonly string[] {
  const byKind = (STEP_WRITE_PATHS_BY_KIND as Record<string, Record<string, readonly string[]>>)[
    kind
  ];
  return byKind?.[step] ?? [];
}

/**
 * Config-widenable semantic categories for a (kind, step) pair. Returns `[]`
 * for an unknown combination or a step that writes only loaf-internal
 * artifacts.
 */
export function stepWriteCategories(kind: string, step: string): readonly WriteCategory[] {
  const byKind = (
    STEP_WRITE_CATEGORIES_BY_KIND as Record<string, Record<string, readonly WriteCategory[]>>
  )[kind];
  return byKind?.[step] ?? [];
}
