import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { normalizeScopePath } from "../../src/core/scope-track.js";

async function fixture(): Promise<{ repoRoot: string; outside: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-scope-normalize-"));
  const repoRoot = path.join(root, "repo");
  const outside = path.join(root, "outside");
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(repoRoot, "src", "actual.ts"), "export {};\n");
  await fs.writeFile(path.join(outside, "secret.ts"), "secret\n");
  return { repoRoot, outside };
}

describe("normalizeScopePath", () => {
  test("absolute-inside and relative paths resolve to canonical POSIX ScopePath", async () => {
    const { repoRoot } = await fixture();
    const absolute = path.join(repoRoot, "src", "actual.ts");
    await expect(normalizeScopePath(absolute, repoRoot)).resolves.toEqual({
      ok: true,
      kind: "scope",
      path: "src/actual.ts",
    });
    await expect(normalizeScopePath("src/actual.ts", repoRoot)).resolves.toEqual({
      ok: true,
      kind: "scope",
      path: "src/actual.ts",
    });
  });

  test("inside symlink records its resolved target; outside symlink is rejected", async () => {
    const { repoRoot, outside } = await fixture();
    await fs.symlink(path.join(repoRoot, "src", "actual.ts"), path.join(repoRoot, "alias.ts"));
    await fs.symlink(path.join(outside, "secret.ts"), path.join(repoRoot, "escape.ts"));
    await expect(normalizeScopePath("alias.ts", repoRoot)).resolves.toEqual({
      ok: true,
      kind: "scope",
      path: "src/actual.ts",
    });
    await expect(normalizeScopePath("escape.ts", repoRoot)).resolves.toMatchObject({
      ok: false,
      reason: "outside_repo_root",
    });
  });

  test("not-yet-existing target resolves nearest existing ancestor then re-appends suffix", async () => {
    const { repoRoot } = await fixture();
    await expect(normalizeScopePath("src/new/deep/file.ts", repoRoot)).resolves.toEqual({
      ok: true,
      kind: "scope",
      path: "src/new/deep/file.ts",
    });
  });

  test("lexical/absolute outside reject; .loaf is classified heartbeat-only", async () => {
    const { repoRoot, outside } = await fixture();
    await expect(normalizeScopePath("../outside/secret.ts", repoRoot)).resolves.toMatchObject({
      ok: false,
      reason: "outside_repo_root",
    });
    await expect(normalizeScopePath(path.join(outside, "secret.ts"), repoRoot)).resolves.toMatchObject(
      { ok: false, reason: "outside_repo_root" },
    );
    await expect(normalizeScopePath(".loaf/session/state.json", repoRoot)).resolves.toEqual({
      ok: true,
      kind: "internal",
      path: ".loaf/session/state.json",
    });
  });
});
