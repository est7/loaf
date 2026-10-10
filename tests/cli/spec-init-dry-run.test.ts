import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { main, type MainDeps } from "../../src/cli.js";
import { readSpecFrontmatter } from "../../src/core/spec-frontmatter.js";

async function runCli(args: string[], deps: MainDeps) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    const exit = await main(["node", "loaf", ...args, "--format=json"], deps);
    return { exit, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

async function treeSnapshot(root: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  async function visit(file: string) {
    const stat = await fs.stat(file, { bigint: true });
    result[path.relative(root, file)] = stat.isDirectory()
      ? { kind: "directory", mtime: String(stat.mtimeNs) }
      : {
          kind: "file",
          mtime: String(stat.mtimeNs),
          bytes: (await fs.readFile(file)).toString("base64"),
        };
    if (stat.isDirectory())
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name));
  }
  await visit(root);
  return result;
}

async function fixture(existingSession: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-spec-init-dry-"));
  const featureDir = path.join(root, "feature");
  const deps: MainDeps = {
    userConfigHomeDir: path.join(root, "home"),
    registryDir: path.join(root, "registry"),
    runtimeDir: path.join(root, "runtime"),
  };
  vi.stubEnv("LOAF_SESSION", undefined);
  vi.stubEnv("LOAF_FEATURE", undefined);
  vi.stubEnv("LOAF_LANG", "en");
  if (existingSession) {
    const start = await runCli(
      ["start", "probe", "--ceremony=standard", `--feature-dir=${featureDir}`],
      deps,
    );
    expect(start.exit, start.stderr).toBe(0);
  }
  return { root, featureDir, deps, selectors: ["--feature=probe", `--feature-dir=${featureDir}`] };
}

afterEach(() => vi.unstubAllEnvs());

test.each([
  "--dry-run",
  "-n",
])("spec init %s leaves every file/directory unchanged in a live session", async (flag) => {
  const f = await fixture(true);
  const before = await treeSnapshot(f.root);
  const result = await runCli(["spec", "init", flag, "--debug", ...f.selectors], f.deps);
  expect(await treeSnapshot(f.root)).toEqual(before);
  expect(result.exit).toBe(2);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toMatchObject({
    code: "DRY_RUN_NOT_APPLICABLE",
    detail: { command: "spec init", command_type: "scaffold-writer" },
  });
});

test("dry-run rejects before dispatch can create an absent feature or report missing session", async () => {
  const f = await fixture(false);
  const before = await treeSnapshot(f.root);
  const result = await runCli(["spec", "init", "--dry-run", ...f.selectors], f.deps);
  expect(await treeSnapshot(f.root)).toEqual(before);
  expect(result.exit).toBe(2);
  expect(JSON.parse(result.stderr)).toMatchObject({
    code: "DRY_RUN_NOT_APPLICABLE",
    detail: { command_type: "scaffold-writer" },
  });
});

test("dry-run rejection precedes existing-scaffold and invalid-override checks", async () => {
  const f = await fixture(true);
  expect((await runCli(["spec", "init", ...f.selectors], f.deps)).exit).toBe(0);
  const before = await treeSnapshot(f.root);
  const result = await runCli(
    ["spec", "init", "--dry-run", "--feature-id=BAD", "--intent=short", ...f.selectors],
    f.deps,
  );
  expect(await treeSnapshot(f.root)).toEqual(before);
  expect(result.exit).toBe(2);
  expect(JSON.parse(result.stderr)).toMatchObject({ code: "DRY_RUN_NOT_APPLICABLE" });
});

test("ordinary spec init still writes parser-valid scaffold without changing the journal", async () => {
  const f = await fixture(true);
  const journal = await fs.readFile(path.join(f.featureDir, "journal.jsonl"));
  const result = await runCli(["spec", "init", ...f.selectors], f.deps);
  expect(result.exit, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    feature: "probe",
    spec_md_path: path.join(f.featureDir, "spec.md"),
  });
  expect(await fs.readFile(path.join(f.featureDir, "journal.jsonl"))).toEqual(journal);
  expect((await readSpecFrontmatter(f.featureDir)).ok).toBe(true);
});
