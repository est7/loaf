import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

// tests/scripts/<file> → repo root is two levels up. A third `..` overshoots
// into the parent directory, whose incidental `docs/` masked the bug locally
// while CI's checkout layout surfaced it as ENOENT.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS_ROOT = path.join(REPO_ROOT, "docs");

function runtimeTypeScriptFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...runtimeTypeScriptFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(path.relative(REPO_ROOT, absolute));
    }
  }
  return found.sort();
}

describe("docs/runtime boundary", () => {
  test("docs contains no runtime TypeScript files", () => {
    expect(runtimeTypeScriptFiles(DOCS_ROOT)).toEqual([]);
  });

  test("the legacy docs/schemas facade is absent", () => {
    expect(existsSync(path.join(DOCS_ROOT, "schemas.ts"))).toBe(false);
  });
});
