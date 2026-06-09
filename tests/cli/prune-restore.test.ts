// prune slice 3 — `restorePrune` (RED-first).
//
// Inverse of execute's trash: read a bucket manifest, move the feature dir +
// registry entry back to their original locations. Safety:
//   - multiple trashings of one uuid (different <ts> buckets) → AMBIGUOUS unless
//     `at` selects one (mirrors SESSION_SHORT_AMBIGUOUS).
//   - a destination that already exists → PATH_OCCUPIED, nothing moved.
//   - orphan (registry-only) bucket → restores only the registry entry.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { restorePrune } from "../../src/cli/prune/restore.js";

const U = (n: number): string => `0000000${n}-0000-4000-8000-00000000000${n}`.slice(-36);

let root: string;
let registryDir: string;
let trashDir: string;
let projects: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "prune-restore-"));
  registryDir = path.join(root, "registry");
  trashDir = path.join(root, "trash");
  projects = path.join(root, "projects");
  await fs.mkdir(registryDir, { recursive: true });
  await fs.mkdir(projects, { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Seed a trash bucket the way executePrune writes one. */
async function seedBucket(opts: {
  ts: string;
  id: string;
  feature: string;
  cwd: string;
  orphan: boolean;
  content?: string;
}): Promise<string> {
  const bucket = path.join(trashDir, opts.ts, opts.id);
  await fs.mkdir(bucket, { recursive: true });
  await fs.writeFile(
    path.join(bucket, "registry.json"),
    JSON.stringify({ session_id: opts.id, feature: opts.feature, cwd: opts.cwd }),
  );
  const featureTrashed = !opts.orphan;
  if (featureTrashed) {
    await fs.mkdir(path.join(bucket, "feature"), { recursive: true });
    await fs.writeFile(path.join(bucket, "feature", "journal.jsonl"), opts.content ?? "J");
  }
  await fs.writeFile(
    path.join(bucket, "manifest.json"),
    JSON.stringify({
      session_id: opts.id,
      feature: opts.feature,
      cwd: opts.cwd,
      feature_dir: path.join(opts.cwd, ".loaf", opts.feature),
      orphan: opts.orphan,
      feature_trashed: featureTrashed,
      at: opts.ts,
    }),
  );
  return bucket;
}
const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
};

describe("restorePrune", () => {
  test("round-trip: registry entry + feature dir return, content preserved", async () => {
    const cwd = path.join(projects, "p1");
    await seedBucket({ ts: "T1", id: U(1), feature: "feat-a", cwd, orphan: false, content: "HELLO" });

    const r = await restorePrune({ registryDir, trashDir, sessionId: U(1) });
    expect(r.ok).toBe(true);
    expect(await exists(path.join(registryDir, `${U(1)}.json`))).toBe(true);
    expect(await fs.readFile(path.join(cwd, ".loaf", "feat-a", "journal.jsonl"), "utf8")).toBe(
      "HELLO",
    );
    // bucket consumed
    expect(await exists(path.join(trashDir, "T1", U(1)))).toBe(false);
  });

  test("orphan bucket restores registry entry only (no feature dir)", async () => {
    const cwd = path.join(projects, "p1");
    await seedBucket({ ts: "T1", id: U(2), feature: "gone", cwd, orphan: true });

    const r = await restorePrune({ registryDir, trashDir, sessionId: U(2) });
    expect(r.ok).toBe(true);
    expect(await exists(path.join(registryDir, `${U(2)}.json`))).toBe(true);
    expect(await exists(path.join(cwd, ".loaf", "gone"))).toBe(false);
  });

  test("unknown session → PRUNE_RESTORE_NOT_FOUND", async () => {
    const r = await restorePrune({ registryDir, trashDir, sessionId: U(9) });
    expect(r).toMatchObject({ ok: false, code: "PRUNE_RESTORE_NOT_FOUND" });
  });

  test("multiple trashings of one uuid → PRUNE_RESTORE_AMBIGUOUS, nothing restored", async () => {
    const cwd = path.join(projects, "p1");
    await seedBucket({ ts: "T1", id: U(1), feature: "feat-a", cwd, orphan: false });
    await seedBucket({ ts: "T2", id: U(1), feature: "feat-a", cwd, orphan: false });

    const r = await restorePrune({ registryDir, trashDir, sessionId: U(1) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("PRUNE_RESTORE_AMBIGUOUS");
      expect((r.detail?.timestamps as string[]).sort()).toEqual(["T1", "T2"]);
    }
    expect(await exists(path.join(registryDir, `${U(1)}.json`))).toBe(false); // untouched
  });

  test("ambiguity resolved by `at`", async () => {
    const cwd = path.join(projects, "p1");
    await seedBucket({ ts: "T1", id: U(1), feature: "feat-a", cwd, orphan: false, content: "ONE" });
    await seedBucket({ ts: "T2", id: U(1), feature: "feat-a", cwd, orphan: false, content: "TWO" });

    const r = await restorePrune({ registryDir, trashDir, sessionId: U(1), at: "T2" });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(cwd, ".loaf", "feat-a", "journal.jsonl"), "utf8")).toBe("TWO");
    expect(await exists(path.join(trashDir, "T2", U(1)))).toBe(false); // consumed
    expect(await exists(path.join(trashDir, "T1", U(1)))).toBe(true); // other left
  });

  test("occupied destination → PRUNE_PATH_OCCUPIED, nothing moved", async () => {
    const cwd = path.join(projects, "p1");
    await seedBucket({ ts: "T1", id: U(1), feature: "feat-a", cwd, orphan: false });
    // pre-occupy the registry slot
    await fs.writeFile(path.join(registryDir, `${U(1)}.json`), "PRE-EXISTING");

    const r = await restorePrune({ registryDir, trashDir, sessionId: U(1) });
    expect(r).toMatchObject({ ok: false, code: "PRUNE_PATH_OCCUPIED" });
    expect(await fs.readFile(path.join(registryDir, `${U(1)}.json`), "utf8")).toBe("PRE-EXISTING");
    expect(await exists(path.join(trashDir, "T1", U(1)))).toBe(true); // bucket intact
  });
});
