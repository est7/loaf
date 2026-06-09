// W8-follow / prune slice 1 — `resolvePruneTargets` core (RED-first).
//
// Pure-ish target resolution: given a registry dir + scope + the --force flag,
// classify each in-scope session into targets vs skipped. The two safety gates:
//   - status gate: only terminal (DONE.*) sessions by default; --force widens it.
//   - lock gate: a session whose feature-dir `.lock` is held is ALWAYS skipped,
//     even with --force (a live writer must not be pruned).
// Orphans (feature-dir gone) are registry-only and cannot be locked.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resolvePruneTargets } from "../../src/cli/prune/resolve.js";

const U = (n: number): string => `0000000${n}-0000-4000-8000-00000000000${n}`.slice(-36);

let root: string;
let registryDir: string;
let projects: string; // simulated project cwds live here

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "prune-resolve-"));
  registryDir = path.join(root, "registry");
  projects = path.join(root, "projects");
  await fs.mkdir(registryDir, { recursive: true });
  await fs.mkdir(projects, { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeEntry(opts: {
  id: string;
  feature: string;
  cwd: string;
  sub_state: string;
}): Promise<void> {
  const phase = opts.sub_state.split(".")[0];
  const entry = {
    schema_version: 2,
    at: "2026-06-01T00:00:00.000Z",
    session_id: opts.id,
    session_label: "",
    feature: opts.feature,
    cwd: opts.cwd,
    workspace: "default",
    phase,
    sub_state: opts.sub_state,
    iteration: 1,
    active_tasks: [],
    pending: null,
    pending_queue_depth: 0,
    ceremony_label: "standard",
  };
  await fs.writeFile(path.join(registryDir, `${opts.id}.json`), JSON.stringify(entry));
}

/** Materialize <cwd>/.loaf/<feature>/ ; optionally hold the `.lock`. */
async function makeFeatureDir(cwd: string, feature: string, opts?: { locked?: boolean }): Promise<void> {
  const dir = path.join(cwd, ".loaf", feature);
  await fs.mkdir(dir, { recursive: true });
  if (opts?.locked) await fs.writeFile(path.join(dir, ".lock"), "");
}

const ids = (r: { targets: { session_id: string }[] }): string[] =>
  r.targets.map((t) => t.session_id).sort();
const skipReasons = (r: { skipped: { session_id: string; reason: string }[] }): Record<string, string> =>
  Object.fromEntries(r.skipped.map((s) => [s.session_id, s.reason]));

describe("resolvePruneTargets — status gate", () => {
  test("scope=all: terminal sessions are targets, active are skipped non-terminal", async () => {
    const cwd = path.join(projects, "p1");
    await writeEntry({ id: U(1), feature: "done-feat", cwd, sub_state: "DONE.delivered" });
    await makeFeatureDir(cwd, "done-feat");
    await writeEntry({ id: U(2), feature: "active-feat", cwd, sub_state: "EXECUTE.work" });
    await makeFeatureDir(cwd, "active-feat");

    const r = await resolvePruneTargets({ registryDir, scope: { kind: "all" }, includeActive: false });
    expect(ids(r)).toEqual([U(1)]);
    expect(skipReasons(r)).toEqual({ [U(2)]: "non-terminal" });
  });

  test("--force (includeActive) makes active sessions targets too", async () => {
    const cwd = path.join(projects, "p1");
    await writeEntry({ id: U(1), feature: "done-feat", cwd, sub_state: "DONE.archived" });
    await makeFeatureDir(cwd, "done-feat");
    await writeEntry({ id: U(2), feature: "active-feat", cwd, sub_state: "SPEC.design" });
    await makeFeatureDir(cwd, "active-feat");

    const r = await resolvePruneTargets({ registryDir, scope: { kind: "all" }, includeActive: true });
    expect(ids(r)).toEqual([U(1), U(2)]);
    expect(r.skipped).toEqual([]);
  });
});

describe("resolvePruneTargets — lock gate is absolute", () => {
  test("held .lock skips a terminal session", async () => {
    const cwd = path.join(projects, "p1");
    await writeEntry({ id: U(1), feature: "locked-feat", cwd, sub_state: "DONE.delivered" });
    await makeFeatureDir(cwd, "locked-feat", { locked: true });

    const r = await resolvePruneTargets({ registryDir, scope: { kind: "all" }, includeActive: false });
    expect(ids(r)).toEqual([]);
    expect(skipReasons(r)).toEqual({ [U(1)]: "locked" });
  });

  test("--force does NOT override the lock gate", async () => {
    const cwd = path.join(projects, "p1");
    await writeEntry({ id: U(1), feature: "locked-active", cwd, sub_state: "EXECUTE.work" });
    await makeFeatureDir(cwd, "locked-active", { locked: true });

    const r = await resolvePruneTargets({ registryDir, scope: { kind: "all" }, includeActive: true });
    expect(ids(r)).toEqual([]);
    expect(skipReasons(r)).toEqual({ [U(1)]: "locked" });
  });

  // codex prune-slice-1 BLOCK: a `.lock` that exists but cannot be stat'd (e.g.
  // the feature dir is chmod 000) must NOT be read as "unlocked". A catch-all
  // `pathExists → false` would target a LOCKED terminal session.
  test.skipIf(process.getuid?.() === 0)(
    "lock-probe I/O error is conservative (inaccessible), never a target",
    async () => {
      const cwd = path.join(projects, "p1");
      await writeEntry({ id: U(1), feature: "inacc", cwd, sub_state: "DONE.delivered" });
      await makeFeatureDir(cwd, "inacc", { locked: true });
      const fdir = path.join(cwd, ".loaf", "inacc");
      await fs.chmod(fdir, 0o000); // stat(<fdir>/.lock) now → EACCES
      try {
        const r = await resolvePruneTargets({
          registryDir,
          scope: { kind: "all" },
          includeActive: false,
        });
        expect(ids(r)).toEqual([]); // the held lock was not silently lost
        expect(skipReasons(r)[U(1)]).toBe("inaccessible");
      } finally {
        await fs.chmod(fdir, 0o755); // restore so afterEach rm can recurse
      }
    },
  );
});

describe("resolvePruneTargets — scope selectors", () => {
  test("scope=session matches by uuid prefix", async () => {
    const cwd = path.join(projects, "p1");
    await writeEntry({ id: U(1), feature: "a", cwd, sub_state: "DONE.delivered" });
    await makeFeatureDir(cwd, "a");
    await writeEntry({ id: U(2), feature: "b", cwd, sub_state: "DONE.delivered" });
    await makeFeatureDir(cwd, "b");

    const r = await resolvePruneTargets({
      registryDir,
      scope: { kind: "session", id: U(1).slice(0, 8) },
      includeActive: false,
    });
    expect(ids(r)).toEqual([U(1)]);
  });

  test("scope=cwd only considers sessions registered under that cwd", async () => {
    const p1 = path.join(projects, "p1");
    const p2 = path.join(projects, "p2");
    await writeEntry({ id: U(1), feature: "a", cwd: p1, sub_state: "DONE.delivered" });
    await makeFeatureDir(p1, "a");
    await writeEntry({ id: U(2), feature: "b", cwd: p2, sub_state: "DONE.delivered" });
    await makeFeatureDir(p2, "b");

    const r = await resolvePruneTargets({ registryDir, scope: { kind: "cwd", cwd: p1 }, includeActive: false });
    expect(ids(r)).toEqual([U(1)]);
  });
});

describe("resolvePruneTargets — orphans", () => {
  test("scope=orphans targets only dangling registry entries (no feature dir), flagged orphan", async () => {
    const cwd = path.join(projects, "p1");
    // live (has dir) — excluded from orphans
    await writeEntry({ id: U(1), feature: "live", cwd, sub_state: "DONE.delivered" });
    await makeFeatureDir(cwd, "live");
    // orphan (no dir) — even non-terminal, since the work is already gone
    await writeEntry({ id: U(2), feature: "gone", cwd, sub_state: "EXECUTE.work" });

    const r = await resolvePruneTargets({ registryDir, scope: { kind: "orphans" }, includeActive: false });
    expect(ids(r)).toEqual([U(2)]);
    expect(r.targets[0]?.orphan).toBe(true);
  });

  test("scope=all flags a terminal session whose feature dir is gone as orphan (registry-only)", async () => {
    const cwd = path.join(projects, "p1");
    await writeEntry({ id: U(1), feature: "gone", cwd, sub_state: "DONE.archived" });
    // no makeFeatureDir → dir missing

    const r = await resolvePruneTargets({ registryDir, scope: { kind: "all" }, includeActive: false });
    expect(ids(r)).toEqual([U(1)]);
    expect(r.targets[0]?.orphan).toBe(true);
  });
});
