import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { main } from "../../src/cli.js";

const id = "00000001-0000-4000-8000-000000000001";
let root: string;
let registry: string;
let bucket: string;
let feature: string;
let manifest: Record<string, unknown>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-bucket-cli-"));
  registry = path.join(root, "registry");
  bucket = path.join(root, "trash", "T1", id);
  feature = path.join(root, "project", ".loaf", "probe");
  await fs.mkdir(registry);
  await fs.mkdir(path.join(bucket, "feature"), { recursive: true });
  await fs.writeFile(path.join(bucket, "feature", "journal.jsonl"), "FEATURE\n");
  await fs.writeFile(path.join(bucket, "registry.json"), "REGISTRY\n");
  manifest = {
    feature: "probe",
    cwd: path.join(root, "project"),
    feature_dir: feature,
    feature_trashed: true,
  };
  await fs.writeFile(path.join(bucket, "manifest.json"), JSON.stringify(manifest));
  vi.stubEnv("LOAF_SESSION", undefined);
  vi.stubEnv("LOAF_FEATURE", undefined);
  vi.stubEnv("LOAF_LANG", "en");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function run(flags: string[] = []) {
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
    const exit = await main(["node", "loaf", "prune", "restore", id, "--format=json", ...flags], {
      registryDir: registry,
      userConfigHomeDir: path.join(root, "home"),
    });
    return { exit, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}
async function bytes() {
  const result: Record<string, string> = {};
  for (const file of (await fs.readdir(root, { recursive: true })).sort()) {
    const full = path.join(root, file);
    if ((await fs.stat(full)).isFile()) result[file] = (await fs.readFile(full)).toString("base64");
  }
  return result;
}

test.each([
  "{broken",
  JSON.stringify({ feature: "probe", cwd: "project", feature_trashed: true }),
])("manifest rejection reaches CLI as typed exit2 with path/cause", async (raw) => {
  await fs.writeFile(path.join(bucket, "manifest.json"), raw);
  const before = await bytes();
  for (const flags of [[], ["--dry-run"]]) {
    const result = await run(flags);
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "PRUNE_RESTORE_INCOMPLETE",
      detail: { path: path.join(bucket, "manifest.json"), cause: expect.any(String) },
    });
    expect(await bytes()).toEqual(before);
  }
});

test("registry move fault reaches existing crash outlet, but compensation leaves a retryable complete bucket", async () => {
  const source = path.join(bucket, "registry.json");
  const rename = fs.rename.bind(fs);
  const spy = vi.spyOn(fs, "rename").mockImplementation(async (src, dest) => {
    if (String(src) === source)
      throw Object.assign(new Error("CLI registry restore fault"), { code: "EACCES" });
    return rename(src, dest);
  });
  const result = await run();
  expect(result.exit).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toMatchObject({ code: "UNEXPECTED_ERROR" });
  expect(await fs.readFile(path.join(bucket, "feature", "journal.jsonl"), "utf8")).toBe(
    "FEATURE\n",
  );
  expect(await fs.readFile(source, "utf8")).toBe("REGISTRY\n");
  await expect(fs.stat(feature)).rejects.toMatchObject({ code: "ENOENT" });
  spy.mockRestore();
  const retry = await run();
  expect(retry.exit).toBe(0);
  expect(retry.stderr).toBe("");
  expect(JSON.parse(retry.stdout)).toMatchObject({
    ok: true,
    dry_run: false,
    session_id: id,
    feature: "probe",
  });
  expect(await fs.readFile(path.join(feature, "journal.jsonl"), "utf8")).toBe("FEATURE\n");
  expect(await fs.readFile(path.join(registry, id + ".json"), "utf8")).toBe("REGISTRY\n");
  await expect(fs.stat(bucket)).rejects.toMatchObject({ code: "ENOENT" });
});

test("valid restore preview is byte-identical and ordinary roundtrip preserves output shape", async () => {
  const before = await bytes();
  const preview = await run(["--dry-run"]);
  expect(preview.exit).toBe(0);
  expect(preview.stderr).toBe("");
  expect(JSON.parse(preview.stdout)).toEqual({
    ok: true,
    dry_run: true,
    session_id: id,
    feature: "probe",
    cwd: manifest.cwd,
  });
  expect(await bytes()).toEqual(before);
  const restored = await run();
  expect(restored.exit).toBe(0);
  expect(restored.stderr).toBe("");
  expect(JSON.parse(restored.stdout)).toEqual({
    ok: true,
    dry_run: false,
    session_id: id,
    feature: "probe",
    cwd: manifest.cwd,
  });
});
