import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { main } from "../../src/cli.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function probe(value: string, json: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-prune-duration-"));
  const bucket = path.join(root, "trash", "2026-01-01T00-00-00.000Z", "probe");
  await fs.mkdir(bucket, { recursive: true });
  await fs.writeFile(path.join(bucket, "keep.txt"), "PERSISTENT DATA\n");
  vi.stubEnv("LOAF_LANG", "en");
  vi.stubEnv("LOAF_FEATURE", undefined);
  vi.stubEnv("LOAF_SESSION", undefined);
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
    const exit = await main(
      [
        "node",
        "loaf",
        "prune",
        "--trash",
        "--yes",
        `--older-than=${value}`,
        ...(json ? ["--format=json"] : []),
      ],
      {
        registryDir: path.join(root, "registry"),
        userConfigHomeDir: path.join(root, "home"),
        now: () => new Date("2026-10-10T00:00:00Z"),
      },
    );
    return { root, bucket, exit, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

test.each([
  "1d",
  "-1",
  "1.5",
  "not-a-duration",
  "NaN",
  "Infinity",
])("invalid --older-than=%s returns JSON USAGE with exact offending value and no side effects", async (value) => {
  const result = await probe(value, true);
  try {
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const diagnostic = JSON.parse(result.stderr);
    expect(diagnostic).toMatchObject({
      code: "USAGE",
      detail: { parser_code: "commander.invalidArgument" },
    });
    expect(diagnostic.detail.reason).toContain(value);
    expect(diagnostic.detail.reason).toContain("--older-than");
    expect(result.stderr).not.toContain("UNEXPECTED_ERROR");
    expect(await fs.readFile(path.join(result.bucket, "keep.txt"), "utf8")).toBe(
      "PERSISTENT DATA\n",
    );
    await expect(fs.stat(path.join(result.root, "home", ".loaf", "crashes"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  } finally {
    await fs.rm(result.root, { recursive: true, force: true });
  }
});

test("invalid duration text output reports USAGE and offending value", async () => {
  const result = await probe("1d", false);
  try {
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: USAGE");
    expect(result.stderr).toContain("1d");
    expect(result.stderr).not.toContain("UNEXPECTED_ERROR");
  } finally {
    await fs.rm(result.root, { recursive: true, force: true });
  }
});

test.each([
  "0",
  "1",
  "30",
  "1.0",
  "1e2",
])("existing valid numeric spelling %s still executes retention", async (value) => {
  const result = await probe(value, true);
  try {
    expect(result.exit, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      dry_run: false,
      removed: [{ ts: "2026-01-01T00-00-00.000Z" }],
    });
    await expect(fs.stat(result.bucket)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.rm(result.root, { recursive: true, force: true });
  }
});
