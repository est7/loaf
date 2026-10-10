// #8 Slice 1: persistent bucket contracts and the known restore rollback gap.
// Slice 3 must remove the expected-failure marker and replace legacy error
// classification assertions when the approved fail-closed policy lands.
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

test("legacy restore failure leaves split locations and a non-retryable bucket", async () => {
  const fault = registryMoveFailure();
  await expect(restore()).rejects.toBe(fault.cause);
  expect(fault.count()).toBe(1);
  fault.spy.mockRestore();
  expect(await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8")).toBe(featureBytes);
  await absent(path.join(bucket, "feature"));
  expect(await fs.readFile(path.join(bucket, "registry.json"), "utf8")).toBe(registryBytes);
  await absent(path.join(registryDir, `${id}.json`));
  expect(await restore()).toMatchObject({
    ok: false,
    code: "PRUNE_RESTORE_INCOMPLETE",
    detail: { bucket, missing: "feature/" },
  });
});

// Current owner: src/core/trash-bucket.ts. Slice 2 preserves legacy
// behavior; the approved production compensation change belongs to Slice 3.
// Remove test.fails when that change lands. Until then the split/non-retryable
// failure remains unfixed; the companion legacy witness verifies its cause.
test.fails("KNOWN GAP: failed registry restore must roll feature back to a retryable bucket", async () => {
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

test("legacy malformed JSON propagates SyntaxError before either artifact moves", async () => {
  await fs.writeFile(path.join(bucket, "manifest.json"), "{ invalid JSON");
  await expect(restore()).rejects.toBeInstanceOf(SyntaxError);
  await intactBucket();
});

test("legacy missing feature_dir rejects before either artifact moves", async () => {
  await fs.writeFile(
    path.join(bucket, "manifest.json"),
    JSON.stringify({ feature: "probe", cwd, feature_trashed: true }),
  );
  await expect(restore()).rejects.toBeInstanceOf(TypeError);
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

test("legacy discovery EACCES is collapsed to NOT_FOUND (approved change in Slice 3)", async () => {
  const cause = Object.assign(new Error("trash directory unreadable"), { code: "EACCES" });
  const read = fs.readdir.bind(fs);
  vi.spyOn(fs, "readdir").mockImplementation(((file: unknown, ...args: unknown[]) => {
    if (String(file) === trashDir) return Promise.reject(cause);
    return Reflect.apply(read, fs, [file, ...args]);
  }) as typeof fs.readdir);
  expect(await restore()).toMatchObject({ ok: false, code: "PRUNE_RESTORE_NOT_FOUND" });
  await intactBucket();
});

test("cleanup failure after both moves propagates and retains restored bytes without rollback", async () => {
  const cause = Object.assign(new Error(`bucket cleanup failed: ${bucket}`), { code: "EACCES" });
  const rm = fs.rm.bind(fs);
  const spy = vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
    if (String(file) === bucket) throw cause;
    return rm(file, options);
  });
  await expect(restore()).rejects.toBe(cause);
  spy.mockRestore();
  expect(await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8")).toBe(featureBytes);
  expect(await fs.readFile(path.join(registryDir, `${id}.json`), "utf8")).toBe(registryBytes);
  expect(await fs.readdir(bucket)).toEqual(["manifest.json"]);
});
