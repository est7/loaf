// prune slice 2 — `executePrune` (RED-first).
//
// Given resolved targets, move them to a recoverable trash bucket (default) or
// hard-purge them. Invariants:
//   - move-then-deregister (M5): the feature dir is trashed/removed BEFORE the
//     registry entry, so a crash mid-op leaves a recoverable orphan entry, not a
//     dangling live dir.
//   - trash writes a manifest so slice 3 (restore) can put it back.
//   - orphan targets are registry-only (no feature dir to move).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { executePrune } from "../../src/cli/prune/execute.js";
import type { PruneTarget } from "../../src/cli/prune/resolve.js";

const U = (n: number): string => `0000000${n}-0000-4000-8000-00000000000${n}`.slice(-36);
const TS = "2026-06-09T00-00-00.000Z";

let root: string;
let registryDir: string;
let trashDir: string;
let projects: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "prune-exec-"));
  registryDir = path.join(root, "registry");
  trashDir = path.join(root, "trash");
  projects = path.join(root, "projects");
  await fs.mkdir(registryDir, { recursive: true });
  await fs.mkdir(projects, { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function writeEntry(id: string, feature: string, cwd: string): Promise<void> {
  await fs.writeFile(
    path.join(registryDir, `${id}.json`),
    JSON.stringify({ session_id: id, feature, cwd, sub_state: "DONE.delivered" }),
  );
}
async function makeFeatureDir(cwd: string, feature: string, marker: string): Promise<string> {
  const dir = path.join(cwd, ".loaf", feature);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "journal.jsonl"), marker);
  return dir;
}
function target(id: string, feature: string, cwd: string, orphan: boolean): PruneTarget {
  return {
    session_id: id,
    feature,
    cwd,
    sub_state: "DONE.delivered",
    feature_dir: path.join(cwd, ".loaf", feature),
    orphan,
  };
}
const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
};

describe("executePrune — trash mode (default, recoverable)", () => {
  test("non-orphan: feature dir + registry entry move to the trash bucket; manifest written", async () => {
    const cwd = path.join(projects, "p1");
    await writeEntry(U(1), "feat-a", cwd);
    const fdir = await makeFeatureDir(cwd, "feat-a", "JOURNAL-CONTENT");

    const r = await executePrune({
      registryDir,
      trashDir,
      targets: [target(U(1), "feat-a", cwd, false)],
      mode: "trash",
      timestamp: TS,
    });

    // originals gone
    expect(await exists(fdir)).toBe(false);
    expect(await exists(path.join(registryDir, `${U(1)}.json`))).toBe(false);
    // trashed, content preserved
    const bucket = path.join(trashDir, TS, U(1));
    expect(await exists(path.join(bucket, "manifest.json"))).toBe(true);
    expect(await exists(path.join(bucket, "registry.json"))).toBe(true);
    expect(await fs.readFile(path.join(bucket, "feature", "journal.jsonl"), "utf8")).toBe(
      "JOURNAL-CONTENT",
    );
    const manifest = JSON.parse(await fs.readFile(path.join(bucket, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ session_id: U(1), feature: "feat-a", cwd, orphan: false });
    // outcome
    expect(r.failed).toEqual([]);
    expect(r.done).toHaveLength(1);
    expect(r.done[0]).toMatchObject({ session_id: U(1), mode: "trash", orphan: false });
    expect(r.done[0]?.trash_path).toBe(bucket);
  });

  test("orphan: registry-only — entry moves to trash, no feature dir", async () => {
    const cwd = path.join(projects, "p1");
    await writeEntry(U(2), "gone", cwd); // no feature dir

    const r = await executePrune({
      registryDir,
      trashDir,
      targets: [target(U(2), "gone", cwd, true)],
      mode: "trash",
      timestamp: TS,
    });

    const bucket = path.join(trashDir, TS, U(2));
    expect(await exists(path.join(registryDir, `${U(2)}.json`))).toBe(false);
    expect(await exists(path.join(bucket, "registry.json"))).toBe(true);
    expect(await exists(path.join(bucket, "feature"))).toBe(false);
    const manifest = JSON.parse(await fs.readFile(path.join(bucket, "manifest.json"), "utf8"));
    expect(manifest.orphan).toBe(true);
    expect(r.done[0]).toMatchObject({ session_id: U(2), mode: "trash", orphan: true });
  });
});

describe("executePrune — purge mode (hard, irreversible)", () => {
  test("non-orphan: feature dir + registry entry removed; nothing in trash", async () => {
    const cwd = path.join(projects, "p1");
    await writeEntry(U(1), "feat-a", cwd);
    const fdir = await makeFeatureDir(cwd, "feat-a", "x");

    const r = await executePrune({
      registryDir,
      trashDir,
      targets: [target(U(1), "feat-a", cwd, false)],
      mode: "purge",
      timestamp: TS,
    });

    expect(await exists(fdir)).toBe(false);
    expect(await exists(path.join(registryDir, `${U(1)}.json`))).toBe(false);
    expect(await exists(trashDir)).toBe(false); // purge never touches trash
    expect(r.done[0]).toMatchObject({ session_id: U(1), mode: "purge", orphan: false });
    expect(r.done[0]?.trash_path).toBeUndefined();
  });

  test("orphan: registry entry removed", async () => {
    const cwd = path.join(projects, "p1");
    await writeEntry(U(2), "gone", cwd);
    const r = await executePrune({
      registryDir,
      trashDir,
      targets: [target(U(2), "gone", cwd, true)],
      mode: "purge",
      timestamp: TS,
    });
    expect(await exists(path.join(registryDir, `${U(2)}.json`))).toBe(false);
    expect(r.done[0]).toMatchObject({ session_id: U(2), mode: "purge", orphan: true });
  });
});

describe("executePrune — robustness", () => {
  // codex prune-core BLOCK 1: a manifest-write failure must not strand
  // already-moved feature data in a manifest-less (unrecoverable) bucket.
  test("manifest-write failure does not move feature data (manifest written first)", async () => {
    const cwd = path.join(projects, "p1");
    await writeEntry(U(1), "feat-a", cwd);
    const fdir = await makeFeatureDir(cwd, "feat-a", "DATA");
    // Sabotage: pre-create the manifest PATH as a directory → writeFile EISDIR.
    await fs.mkdir(path.join(trashDir, TS, U(1), "manifest.json"), { recursive: true });

    const r = await executePrune({
      registryDir,
      trashDir,
      targets: [target(U(1), "feat-a", cwd, false)],
      mode: "trash",
      timestamp: TS,
    });

    expect(r.failed).toHaveLength(1);
    expect(r.done).toEqual([]);
    // feature + registry untouched — the write failed BEFORE any move
    expect(await fs.readFile(path.join(fdir, "journal.jsonl"), "utf8")).toBe("DATA");
    expect(await exists(path.join(registryDir, `${U(1)}.json`))).toBe(true);
  });

  // codex prune-core BLOCK 3: a registry-move failure AFTER the feature moved
  // must roll the feature back, never strand it in an unreconnectable bucket.
  test("registry-move failure after feature move rolls back — no stranded feature data", async () => {
    const cwd = path.join(projects, "p1");
    await writeEntry(U(1), "feat-a", cwd);
    const fdir = await makeFeatureDir(cwd, "feat-a", "DATA");
    // Sabotage: pre-create bucket/registry.json as a directory → the registry
    // rename fails AFTER the feature has already moved into the bucket.
    await fs.mkdir(path.join(trashDir, TS, U(1), "registry.json"), { recursive: true });

    const r = await executePrune({
      registryDir,
      trashDir,
      targets: [target(U(1), "feat-a", cwd, false)],
      mode: "trash",
      timestamp: TS,
    });

    expect(r.failed).toHaveLength(1);
    expect(r.done).toEqual([]);
    // rolled back: feature restored at its original path with content intact
    expect(await fs.readFile(path.join(fdir, "journal.jsonl"), "utf8")).toBe("DATA");
    // registry entry never moved (still at origin) → session is whole
    expect(await exists(path.join(registryDir, `${U(1)}.json`))).toBe(true);
    // no stranded feature data in the trash bucket
    expect(await exists(path.join(trashDir, TS, U(1), "feature"))).toBe(false);
  });

  // codex prune-core BLOCK 4: if the rollback ALSO fails (double fault), the
  // bucket holds the only feature copy — it must be PRESERVED, never removed.
  test("double fault (rollback also fails) preserves the bucket — no data loss", async () => {
    const cwd = path.join(projects, "p1");
    await writeEntry(U(1), "feat-a", cwd);
    await makeFeatureDir(cwd, "feat-a", "DATA");

    // Inject: 1st rename (feature → bucket) succeeds; the registry move (2nd) and
    // the rollback (3rd) both fail with a non-EXDEV/ENOENT error.
    const realRename = fs.rename.bind(fs);
    let n = 0;
    vi.spyOn(fs, "rename").mockImplementation(((src: string, dest: string) => {
      n += 1;
      if (n === 1) return realRename(src, dest);
      return Promise.reject(Object.assign(new Error("EIO injected"), { code: "EIO" }));
    }) as typeof fs.rename);

    const r = await executePrune({
      registryDir,
      trashDir,
      targets: [target(U(1), "feat-a", cwd, false)],
      mode: "trash",
      timestamp: TS,
    });

    expect(r.done).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.error).toContain("retained in");
    expect(r.failed[0]?.error).toContain("recover manually");
    // Honest recovery contract (codex BLOCK 5/6): claim NO command that fails for
    // this state — `loaf prune restore` returns INCOMPLETE; bare `loaf doctor` is
    // DOCTOR_MODE_NOT_IMPLEMENTED. Only the manual move actually works.
    expect(r.failed[0]?.error).not.toContain("loaf prune restore");
    expect(r.failed[0]?.error).not.toContain("loaf doctor");
    // the only feature copy is preserved in the bucket — NOT deleted
    expect(await fs.readFile(path.join(trashDir, TS, U(1), "feature", "journal.jsonl"), "utf8")).toBe(
      "DATA",
    );
    // registry entry never moved
    expect(await exists(path.join(registryDir, `${U(1)}.json`))).toBe(true);
  });

  test("non-orphan whose feature dir vanished between resolve and execute degrades to registry-only", async () => {
    const cwd = path.join(projects, "p1");
    await writeEntry(U(1), "feat-a", cwd); // entry exists, but feature dir never created
    const r = await executePrune({
      registryDir,
      trashDir,
      targets: [target(U(1), "feat-a", cwd, false)], // claims non-orphan
      mode: "trash",
      timestamp: TS,
    });
    // registry entry still gets trashed; no crash; no feature/ subdir
    expect(await exists(path.join(registryDir, `${U(1)}.json`))).toBe(false);
    expect(await exists(path.join(trashDir, TS, U(1), "registry.json"))).toBe(true);
    expect(r.failed).toEqual([]);
    expect(r.done).toHaveLength(1);
  });
});
