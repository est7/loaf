// Trash bucket representation contracts and approved compensation/error semantics.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { executePrune } from "../../src/cli/prune/execute.js";
import { restoreTrashBucket } from "../../src/core/trash-bucket.js";
import { toTrashTs, fromTrashTs } from "../../src/core/trash-bucket.js";

const id = "00000001-0000-4000-8000-000000000001";
const timestamp = "2026-10-10T00-00-00.123Z";
const featureBytes = "EXACT FEATURE BYTES\n";
const registryBytes = '{"session_id":"' + id + '","feature":"probe"}\n';
let root: string;
let registryDir: string;
let trashDir: string;
let featureDir: string;
let bucket: string;
let cwd: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-bucket-characterization-"));
  registryDir = path.join(root, "registry");
  trashDir = path.join(root, "trash");
  cwd = path.join(root, "project");
  featureDir = path.join(cwd, ".loaf", "probe");
  bucket = path.join(trashDir, timestamp, id);
  await fs.mkdir(registryDir);
  await fs.mkdir(featureDir, { recursive: true });
  await fs.writeFile(path.join(featureDir, "journal.jsonl"), featureBytes);
  await fs.writeFile(path.join(registryDir, `${id}.json`), registryBytes);
  const result = await executePrune({
    registryDir,
    trashDir,
    mode: "trash",
    timestamp,
    targets: [
      {
        session_id: id,
        feature: "probe",
        cwd,
        feature_dir: featureDir,
        orphan: false,
        sub_state: "DONE.delivered",
      },
    ],
  });
  expect(result.failed).toEqual([]);
  expect(result.done).toHaveLength(1);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const restore = () => restoreTrashBucket({ registryDir, trashDir, sessionId: id });
async function absent(file: string) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}
async function intactBucket() {
  expect(await fs.readFile(path.join(bucket, "feature", "journal.jsonl"), "utf8")).toBe(
    featureBytes,
  );
  expect(await fs.readFile(path.join(bucket, "registry.json"), "utf8")).toBe(registryBytes);
  await absent(featureDir);
  await absent(path.join(registryDir, `${id}.json`));
}
function registryMoveFailure() {
  const cause = Object.assign(new Error("injected registry restore failure"), { code: "EACCES" });
  const rename = fs.rename.bind(fs);
  let injected = 0;
  const spy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (
      String(source) === path.join(bucket, "registry.json") &&
      String(destination) === path.join(registryDir, `${id}.json`)
    ) {
      injected++;
      throw cause;
    }
    return rename(source, destination);
  });
  return { cause, count: () => injected, spy };
}

test("bucket writer preserves exact seven-field JSON order, indentation and trailing newline", async () => {
  const expected = `{
  "session_id": "${id}",
  "feature": "probe",
  "cwd": ${JSON.stringify(cwd)},
  "feature_dir": ${JSON.stringify(featureDir)},
  "orphan": false,
  "feature_trashed": true,
  "at": "${timestamp}"
}\n`;
  expect(await fs.readFile(path.join(bucket, "manifest.json"), "utf8")).toBe(expected);
  expect((await fs.readdir(bucket)).sort()).toEqual(["feature", "manifest.json", "registry.json"]);
  await intactBucket();
});

test("timestamp layout and round-trip preserve exact registry/feature bytes", async () => {
  const date = new Date("2026-10-10T00:00:00.123Z");
  expect(toTrashTs(date)).toBe(timestamp);
  expect(fromTrashTs(timestamp)?.toISOString()).toBe(date.toISOString());
  expect(await restore()).toEqual({
    ok: true,
    session_id: id,
    feature: "probe",
    cwd,
    restored_from: bucket,
  });
  expect(await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8")).toBe(featureBytes);
  expect(await fs.readFile(path.join(registryDir, `${id}.json`), "utf8")).toBe(registryBytes);
  await absent(bucket);
});

test("failed registry restore rolls feature back to a retryable bucket", async () => {
  const fault = registryMoveFailure();
  await expect(restore()).rejects.toBe(fault.cause);
  expect(fault.count()).toBe(1);
  fault.spy.mockRestore();
  await intactBucket();
  expect(
    JSON.parse(await fs.readFile(path.join(bucket, "manifest.json"), "utf8")).feature_trashed,
  ).toBe(true);
  expect(await restore()).toMatchObject({ ok: true, session_id: id });
});

test("malformed JSON returns manifest-invalid diagnostic before either artifact moves", async () => {
  await fs.writeFile(path.join(bucket, "manifest.json"), "{ invalid JSON");
  expect(await restore()).toMatchObject({
    ok: false,
    code: "PRUNE_RESTORE_INCOMPLETE",
    detail: { path: path.join(bucket, "manifest.json"), cause: expect.any(String) },
  });
  await intactBucket();
});

test("missing feature_dir returns manifest-invalid diagnostic before either artifact moves", async () => {
  await fs.writeFile(
    path.join(bucket, "manifest.json"),
    JSON.stringify({ feature: "probe", cwd, feature_trashed: true }),
  );
  expect(await restore()).toMatchObject({
    ok: false,
    code: "PRUNE_RESTORE_INCOMPLETE",
    detail: {
      path: path.join(bucket, "manifest.json"),
      cause: expect.stringContaining("feature_dir"),
    },
  });
  await intactBucket();
});

test("unknown manifest fields and currently unused identity fields are not required by restore", async () => {
  await fs.writeFile(
    path.join(bucket, "manifest.json"),
    JSON.stringify({
      feature: "probe",
      cwd,
      feature_dir: featureDir,
      feature_trashed: true,
      future_metadata: { opaque: [1, 2] },
    }),
  );
  expect(await restore()).toMatchObject({ ok: true, session_id: id });
  expect(await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8")).toBe(featureBytes);
});

test.each([
  "ENOENT",
  "EACCES",
])("manifest read %s propagates original cause before moves", async (code) => {
  const cause = Object.assign(new Error(`manifest read ${code}`), { code });
  const read = fs.readFile.bind(fs);
  vi.spyOn(fs, "readFile").mockImplementation(((file: unknown, ...args: unknown[]) => {
    if (String(file) === path.join(bucket, "manifest.json")) return Promise.reject(cause);
    return Reflect.apply(read, fs, [file, ...args]);
  }) as typeof fs.readFile);
  await expect(restore()).rejects.toBe(cause);
  await intactBucket();
});

test("discovery EACCES propagates its cause before moves", async () => {
  const cause = Object.assign(new Error("trash directory unreadable"), { code: "EACCES" });
  const read = fs.readdir.bind(fs);
  vi.spyOn(fs, "readdir").mockImplementation(((file: unknown, ...args: unknown[]) => {
    if (String(file) === trashDir) return Promise.reject(cause);
    return Reflect.apply(read, fs, [file, ...args]);
  }) as typeof fs.readdir);
  await expect(restore()).rejects.toBe(cause);
  await intactBucket();
});

test("cleanup failure after both moves propagates and retains restored bytes without rollback", async () => {
  const cause = Object.assign(new Error(`bucket cleanup failed: ${bucket}`), { code: "EACCES" });
  const rm = fs.rm.bind(fs);
  const spy = vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
    if (String(file) === bucket) throw cause;
    return rm(file, options);
  });
  await expect(restore()).rejects.toMatchObject({
    cause,
    message: expect.stringContaining(bucket),
  });
  spy.mockRestore();
  expect(await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8")).toBe(featureBytes);
  expect(await fs.readFile(path.join(registryDir, `${id}.json`), "utf8")).toBe(registryBytes);
  expect(await fs.readdir(bucket)).toEqual(["manifest.json"]);
});

test.each([
  null,
  [],
  {},
  { feature: "probe", cwd: "project", feature_dir: "path" },
  { feature: "probe", cwd: "project", feature_dir: "path", feature_trashed: "false" },
  { feature: "", cwd: "project", feature_dir: "path", feature_trashed: false },
  { feature: "probe", cwd: 5, feature_dir: "path", feature_trashed: false },
])("invalid manifest %j is fail-closed even in preview", async (value) => {
  await fs.writeFile(path.join(bucket, "manifest.json"), JSON.stringify(value));
  const rename = vi.spyOn(fs, "rename");
  for (const dryRun of [false, true]) {
    expect(
      await restoreTrashBucket({ registryDir, trashDir, sessionId: id, dryRun }),
    ).toMatchObject({
      ok: false,
      code: "PRUNE_RESTORE_INCOMPLETE",
      detail: { path: path.join(bucket, "manifest.json"), cause: expect.any(String) },
    });
  }
  expect(rename).not.toHaveBeenCalled();
  await intactBucket();
});

test("restore double fault retains both causes, all data copies and manifest", async () => {
  const registryError = Object.assign(new Error("registry blocked"), { code: "EACCES" });
  const rollbackError = Object.assign(new Error("rollback blocked"), { code: "EIO" });
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (String(source) === path.join(bucket, "registry.json")) throw registryError;
    if (String(source) === featureDir && String(destination) === path.join(bucket, "feature"))
      throw rollbackError;
    return rename(source, destination);
  });
  let failure: unknown;
  try {
    await restore();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([registryError, rollbackError]);
  expect((failure as Error).cause).toBe(registryError);
  expect((failure as Error).message).toContain(featureDir);
  expect((failure as Error).message).toContain(bucket);
  expect(await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8")).toBe(featureBytes);
  expect(await fs.readFile(path.join(bucket, "registry.json"), "utf8")).toBe(registryBytes);
  expect(await fs.stat(path.join(bucket, "manifest.json"))).toBeDefined();
  await absent(path.join(registryDir, `${id}.json`));
});

test("ENOENT caused by missing destination cannot silently consume feature data", async () => {
  const cause = Object.assign(new Error("destination parent vanished"), { code: "ENOENT" });
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (String(source) === path.join(bucket, "feature")) throw cause;
    return rename(source, destination);
  });
  await expect(restore()).rejects.toBe(cause);
  await intactBucket();
});

test("source disappearing after preflight returns INCOMPLETE without moving registry", async () => {
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (String(source) === path.join(bucket, "feature"))
      await fs.rm(source, { recursive: true, force: true });
    return rename(source, destination);
  });
  expect(await restore()).toMatchObject({
    ok: false,
    code: "PRUNE_RESTORE_INCOMPLETE",
    detail: { missing: "feature/" },
  });
  expect(await fs.readFile(path.join(bucket, "registry.json"), "utf8")).toBe(registryBytes);
  expect(await fs.stat(path.join(bucket, "manifest.json"))).toBeDefined();
  await absent(path.join(registryDir, `${id}.json`));
});

test("rollback source disappearing is a double fault, never reported as successful compensation", async () => {
  const primary = registryMoveFailure();
  const rename = fs.rename.bind(fs);
  primary.spy.mockRestore();
  vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (String(source) === path.join(bucket, "registry.json")) throw primary.cause;
    if (String(source) === featureDir) await fs.rm(source, { recursive: true, force: true });
    return rename(source, destination);
  });
  await expect(restore()).rejects.toMatchObject({
    cause: primary.cause,
    message: expect.stringContaining("feature rollback also failed"),
  });
  expect(await fs.readFile(path.join(bucket, "registry.json"), "utf8")).toBe(registryBytes);
  expect(await fs.stat(path.join(bucket, "manifest.json"))).toBeDefined();
});

test.each([
  "copy",
  "remove",
])("EXDEV registry %s failure preserves source/destination copies and compensates feature", async (stage) => {
  const cause = Object.assign(new Error(`${stage} failed`), { code: "EIO" });
  const src = path.join(bucket, "registry.json");
  const dest = path.join(registryDir, `${id}.json`);
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (String(source) === src) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    return rename(source, destination);
  });
  if (stage === "copy") {
    vi.spyOn(fs, "copyFile").mockImplementation(async (source, destination) => {
      expect(String(source)).toBe(src);
      await fs.writeFile(destination, "PARTIAL");
      throw cause;
    });
  } else {
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (String(file) === src) throw cause;
      return rm(file, options);
    });
  }
  await expect(restore()).rejects.toMatchObject({ cause, message: expect.stringContaining(dest) });
  expect(await fs.readFile(src, "utf8")).toBe(registryBytes);
  expect(await fs.readFile(dest, "utf8")).toBe(stage === "copy" ? "PARTIAL" : registryBytes);
  expect(await fs.readFile(path.join(bucket, "feature", "journal.jsonl"), "utf8")).toBe(
    featureBytes,
  );
  await absent(featureDir);
});

test("EXDEV feature copy and registry copy success preserve exact bytes", async () => {
  vi.spyOn(fs, "rename").mockRejectedValue(
    Object.assign(new Error("cross-device"), { code: "EXDEV" }),
  );
  expect(await restore()).toMatchObject({ ok: true });
  expect(await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8")).toBe(featureBytes);
  expect(await fs.readFile(path.join(registryDir, `${id}.json`), "utf8")).toBe(registryBytes);
  await absent(bucket);
});

test("non-ENOENT destination stat error propagates and never authorizes an overwrite", async () => {
  const cause = Object.assign(new Error("destination cannot be inspected"), { code: "EACCES" });
  const stat = fs.stat.bind(fs);
  const spy = vi.spyOn(fs, "stat").mockImplementation(((file: unknown, ...args: unknown[]) => {
    if (String(file) === featureDir) return Promise.reject(cause);
    return Reflect.apply(stat, fs, [file, ...args]);
  }) as typeof fs.stat);
  const rename = vi.spyOn(fs, "rename");
  await expect(restore()).rejects.toBe(cause);
  expect(rename).not.toHaveBeenCalled();
  spy.mockRestore();
  await intactBucket();
});

test.each([
  "copy",
  "remove",
])("EXDEV feature %s failure keeps all surviving copies and registry in bucket", async (stage) => {
  const cause = Object.assign(new Error(`feature ${stage} failed`), { code: "EIO" });
  const src = path.join(bucket, "feature");
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (String(source) === src) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    return rename(source, destination);
  });
  if (stage === "copy")
    vi.spyOn(fs, "cp").mockImplementation(async (_source, destination) => {
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(String(destination), "journal.jsonl"), "PARTIAL");
      throw cause;
    });
  else {
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (String(file) === src) throw cause;
      return rm(file, options);
    });
  }
  await expect(restore()).rejects.toMatchObject({
    cause,
    message: expect.stringContaining(featureDir),
  });
  expect(await fs.readFile(path.join(src, "journal.jsonl"), "utf8")).toBe(featureBytes);
  expect(await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8")).toBe(
    stage === "copy" ? "PARTIAL" : featureBytes,
  );
  expect(await fs.readFile(path.join(bucket, "registry.json"), "utf8")).toBe(registryBytes);
  await absent(path.join(registryDir, `${id}.json`));
});

test("trash EXDEV registry removal failure retains the copied registry and compensates feature", async () => {
  expect(await restore()).toMatchObject({ ok: true });
  const src = path.join(registryDir, `${id}.json`);
  const cause = Object.assign(new Error("registry source remove failed"), { code: "EACCES" });
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (String(source) === src) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    return rename(source, destination);
  });
  const rm = fs.rm.bind(fs);
  vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
    if (String(file) === src) throw cause;
    return rm(file, options);
  });
  const result = await executePrune({
    registryDir,
    trashDir,
    mode: "trash",
    timestamp,
    targets: [
      {
        session_id: id,
        feature: "probe",
        cwd,
        feature_dir: featureDir,
        orphan: false,
        sub_state: "DONE.delivered",
      },
    ],
  });
  expect(result.done).toEqual([]);
  expect(result.failed).toHaveLength(1);
  expect(result.failed[0]!.error).toContain(String(cause.message));
  expect(result.failed[0]!.error).toContain(src);
  expect(result.failed[0]!.error).toContain(path.join(bucket, "registry.json"));
  expect(await fs.readFile(src, "utf8")).toBe(registryBytes);
  expect(await fs.readFile(path.join(bucket, "registry.json"), "utf8")).toBe(registryBytes);
  expect(await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8")).toBe(featureBytes);
  expect(await fs.stat(path.join(bucket, "manifest.json"))).toBeDefined();
});
