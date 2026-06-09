// prune slice 5 — trash retention GC (RED-first).
//
// M1: recoverable trash without a retention sweep just relocates the unbounded
// growth. `gcTrash` removes trash buckets older than a cutoff. The bucket dir
// name is a filesystem-safe ISO timestamp (shared with execute's bucket key);
// unparseable names are kept (never GC something we can't date).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { gcTrash } from "../../src/cli/prune/trash-gc.js";
import { fromTrashTs, toTrashTs } from "../../src/cli/prune/trash-ts.js";

let root: string;
let trashDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "prune-gc-"));
  trashDir = path.join(root, "trash");
  await fs.mkdir(trashDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
};
async function seedBucket(ts: string): Promise<void> {
  await fs.mkdir(path.join(trashDir, ts, "some-session"), { recursive: true });
}

describe("trash timestamp format", () => {
  test("toTrashTs is filesystem-safe and round-trips via fromTrashTs", () => {
    const d = new Date("2026-06-09T12:34:56.789Z");
    const ts = toTrashTs(d);
    expect(ts).not.toContain(":"); // safe for a path segment
    expect(fromTrashTs(ts)?.toISOString()).toBe(d.toISOString());
  });
  test("fromTrashTs returns null for a non-timestamp name", () => {
    expect(fromTrashTs("not-a-timestamp")).toBeNull();
  });
});

describe("gcTrash", () => {
  const now = new Date("2026-06-09T00:00:00.000Z");

  test("removes buckets older than the cutoff, keeps newer ones", async () => {
    const oldTs = toTrashTs(new Date("2026-05-01T00:00:00.000Z")); // ~39 days old
    const recentTs = toTrashTs(new Date("2026-06-08T00:00:00.000Z")); // 1 day old
    await seedBucket(oldTs);
    await seedBucket(recentTs);

    const r = await gcTrash({ trashDir, olderThanDays: 30, now });

    expect(r.removed.map((x) => x.ts)).toEqual([oldTs]);
    expect(r.kept.map((x) => x.ts)).toEqual([recentTs]);
    expect(await exists(path.join(trashDir, oldTs))).toBe(false);
    expect(await exists(path.join(trashDir, recentTs))).toBe(true);
  });

  test("keeps unparseable bucket names (never GC something we cannot date)", async () => {
    await seedBucket("not-a-timestamp");
    const r = await gcTrash({ trashDir, olderThanDays: 0, now });
    expect(r.removed).toEqual([]);
    expect(r.kept.map((x) => x.ts)).toEqual(["not-a-timestamp"]);
    expect(await exists(path.join(trashDir, "not-a-timestamp"))).toBe(true);
  });

  test("a bucket exactly at the cutoff is kept (strictly older-than)", async () => {
    const exactTs = toTrashTs(new Date("2026-05-10T00:00:00.000Z")); // exactly 30 days
    await seedBucket(exactTs);
    const r = await gcTrash({ trashDir, olderThanDays: 30, now });
    expect(r.removed).toEqual([]);
    expect(r.kept.map((x) => x.ts)).toEqual([exactTs]);
  });

  test("missing trash dir → empty result", async () => {
    const r = await gcTrash({ trashDir: path.join(root, "nope"), olderThanDays: 30, now });
    expect(r).toEqual({ removed: [], kept: [] });
  });
});
