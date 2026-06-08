// Phase 16 SC-15c — pure write-guard decision unit tests.
//
// evaluateWritePath is the write-guard SECURITY BOUNDARY. The category-
// isolation negative cases (codex Q1 lock) are the load-bearing ones:
// paths.tests must NOT authorize source writes in implement, and
// paths.source must NOT authorize test writes in red.

import { describe, expect, test } from "vitest";

import { WriteGuardConfig } from "../../src/core/loaf-config.js";
import type { WriteCategory } from "../../src/core/step-write-paths.js";
import {
  evaluateWritePath,
  normalizeToRepoRoot,
  parseHookStdinPath,
} from "../../src/core/write-guard.js";

const REPO = "/repo";

function cfg(overrides: {
  protected_files?: string[];
  paths?: Partial<Record<WriteCategory, string[]>>;
}): WriteGuardConfig {
  return WriteGuardConfig.parse({
    schema_version: 2,
    protected_files: overrides.protected_files ?? [],
    paths: overrides.paths ?? {},
  });
}

describe("normalizeToRepoRoot", () => {
  test("absolute path → repo-relative POSIX", () => {
    expect(normalizeToRepoRoot("/repo/src/a.ts", REPO)).toBe("src/a.ts");
  });
  test("relative path resolved against repo root", () => {
    expect(normalizeToRepoRoot("src/a.ts", REPO)).toBe("src/a.ts");
  });
});

describe("evaluateWritePath — base allow/deny", () => {
  const base = {
    repoRoot: REPO,
    feature: "auth",
    subState: "EXECUTE.work",
    activeCategories: [] as WriteCategory[],
    config: null,
  };

  test("in-scope source write during implement → allowed", () => {
    const d = evaluateWritePath({
      ...base,
      targetPath: "/repo/src/auth/login.ts",
      builtinGlobs: ["src/**", "lib/**"],
    });
    expect(d.allowed).toBe(true);
  });

  test("out-of-scope write → WRITE_PATH_VIOLATION", () => {
    const d = evaluateWritePath({
      ...base,
      targetPath: "/repo/tests/login.test.ts",
      builtinGlobs: ["src/**", "lib/**"],
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("WRITE_PATH_VIOLATION");
  });

  test("<feature> placeholder substituted before matching", () => {
    const d = evaluateWritePath({
      ...base,
      targetPath: "/repo/.loaf/auth/state.json",
      builtinGlobs: [".loaf/<feature>/state.json"],
    });
    expect(d.allowed).toBe(true);
  });
});

describe("evaluateWritePath — protected_files hard-deny", () => {
  test("protected file denied even when inside the allow-set", () => {
    const d = evaluateWritePath({
      repoRoot: REPO,
      feature: "auth",
      subState: "EXECUTE.work",
      targetPath: "/repo/src/secrets.ts",
      builtinGlobs: ["src/**"], // would otherwise allow
      activeCategories: [],
      config: cfg({ protected_files: ["src/secrets.ts"] }),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.code).toBe("PROTECTED_FILE_WRITE");
      if (d.code === "PROTECTED_FILE_WRITE") expect(d.matchedDeny).toBe("src/secrets.ts");
    }
  });
});

describe("evaluateWritePath — category-aware widening (codex Q1 SECURITY BOUNDARY)", () => {
  test("paths.source widens a custom source root during implement", () => {
    const d = evaluateWritePath({
      repoRoot: REPO,
      feature: "auth",
      subState: "EXECUTE.work",
      targetPath: "/repo/app/main/login.kt",
      builtinGlobs: ["src/**"],
      activeCategories: ["source"],
      config: cfg({ paths: { source: ["app/**"] } }),
    });
    expect(d.allowed).toBe(true);
  });

  test("NEGATIVE: paths.tests does NOT authorize a source-tree write in implement", () => {
    // implement step → activeCategories = [source]. paths.tests is set but
    // must NOT widen, because tests is not an active category here.
    const d = evaluateWritePath({
      repoRoot: REPO,
      feature: "auth",
      subState: "EXECUTE.work",
      targetPath: "/repo/custom-tests/login.spec.ts",
      builtinGlobs: ["src/**"], // implement built-ins (source only)
      activeCategories: ["source"],
      config: cfg({ paths: { tests: ["custom-tests/**"] } }),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("WRITE_PATH_VIOLATION");
  });

  test("NEGATIVE: paths.source does NOT authorize a source write in red (tests-only step)", () => {
    // red step → activeCategories = [tests]. paths.source is set but must
    // NOT widen source writes during a red step.
    const d = evaluateWritePath({
      repoRoot: REPO,
      feature: "auth",
      subState: "EXECUTE.work",
      targetPath: "/repo/app/login.kt",
      builtinGlobs: ["**/test/**", "tests/**"], // red built-ins (tests only)
      activeCategories: ["tests"],
      config: cfg({ paths: { source: ["app/**"] } }),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("WRITE_PATH_VIOLATION");
  });

  test("POSITIVE control: paths.tests DOES widen during a red (tests) step", () => {
    const d = evaluateWritePath({
      repoRoot: REPO,
      feature: "auth",
      subState: "EXECUTE.work",
      targetPath: "/repo/custom-tests/login.spec.ts",
      builtinGlobs: ["**/test/**", "tests/**"],
      activeCategories: ["tests"],
      config: cfg({ paths: { tests: ["custom-tests/**"] } }),
    });
    expect(d.allowed).toBe(true);
  });
});

describe("parseHookStdinPath", () => {
  test("valid Claude Code envelope → ok", () => {
    const r = parseHookStdinPath(JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }));
    expect(r).toEqual({ ok: true, path: "/repo/src/a.ts" });
  });
  test("malformed JSON → fail closed", () => {
    expect(parseHookStdinPath("{not json").ok).toBe(false);
  });
  test("missing tool_input.file_path → fail closed", () => {
    expect(parseHookStdinPath(JSON.stringify({ tool_input: {} })).ok).toBe(false);
  });
  test("empty file_path → fail closed", () => {
    expect(parseHookStdinPath(JSON.stringify({ tool_input: { file_path: "" } })).ok).toBe(false);
  });
});
