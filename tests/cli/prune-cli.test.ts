// prune slice 6a — `loaf prune <scope>` CLI surface (RED-first, e2e via runCli).
//
// Wires resolve → (preview | execute) → audit. Safety surface: exactly one scope
// (USAGE otherwise); preview by default (no side effects), --yes executes;
// --session <prefix> ambiguity is gated (SESSION_SHORT_AMBIGUOUS); destructive
// only on terminal sessions unless --force.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { main, type MainDeps } from "../../src/cli.js";

let root: string;
let registryDir: string;
let projects: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "prune-cli-"));
  registryDir = path.join(root, ".loaf", "registry"); // trash/log derive as siblings
  projects = path.join(root, "projects");
  await fs.mkdir(registryDir, { recursive: true });
  await fs.mkdir(projects, { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const U = (n: number): string => `0000000${n}-0000-4000-8000-00000000000${n}`.slice(-36);

async function seed(id: string, feature: string, cwd: string, sub_state: string): Promise<void> {
  await fs.writeFile(
    path.join(registryDir, `${id}.json`),
    JSON.stringify({
      schema_version: 2,
      at: "2026-06-01T00:00:00.000Z",
      session_id: id,
      session_label: "",
      feature,
      cwd,
      workspace: "default",
      phase: sub_state.split(".")[0],
      sub_state,
      iteration: 1,
      active_tasks: [],
      pending: null,
      pending_queue_depth: 0,
      ceremony_label: "standard",
    }),
  );
  await fs.mkdir(path.join(cwd, ".loaf", feature), { recursive: true });
  await fs.writeFile(path.join(cwd, ".loaf", feature, "journal.jsonl"), "J");
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
};

function run(argv: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
  const deps: MainDeps = { registryDir, now: () => new Date("2026-06-09T00:00:00.000Z") };
  // capture
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (s: string) => (out.push(s), true);
  (process.stderr.write as unknown) = (s: string) => (err.push(s), true);
  return main(["node", "loaf", ...argv], deps)
    .then((exit) => ({ exit, stdout: out.join(""), stderr: err.join("") }))
    .finally(() => {
      process.stdout.write = o;
      process.stderr.write = e;
    });
}

describe("loaf prune — scope + safety surface", () => {
  test("no scope → USAGE exit 2", async () => {
    const r = await run(["prune", "--format", "json"]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr).code).toBe("USAGE");
  });

  test("more than one scope → USAGE exit 2", async () => {
    const r = await run(["prune", "--all", "--in-cwd", "--format", "json"]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr).code).toBe("USAGE");
  });

  test("--all without --yes previews (no side effects)", async () => {
    const cwd = path.join(projects, "p1");
    await seed(U(1), "done-a", cwd, "DONE.delivered");
    const r = await run(["prune", "--all", "--format", "json"]);
    expect(r.exit).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.dry_run).toBe(true);
    expect(body.pruned.map((p: { session_id: string }) => p.session_id)).toEqual([U(1)]);
    // nothing deleted
    expect(await exists(path.join(registryDir, `${U(1)}.json`))).toBe(true);
  });

  test("--all --yes prunes terminal sessions to trash + writes audit log", async () => {
    const cwd = path.join(projects, "p1");
    await seed(U(1), "done-a", cwd, "DONE.delivered");
    await seed(U(2), "active-b", cwd, "EXECUTE.work"); // active → skipped (no --force)

    const r = await run(["prune", "--all", "--yes", "--format", "json"]);
    expect(r.exit).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.pruned.map((p: { session_id: string }) => p.session_id)).toEqual([U(1)]);
    expect(body.skipped.map((s: { session_id: string }) => s.session_id)).toEqual([U(2)]);
    // terminal pruned, active untouched
    expect(await exists(path.join(registryDir, `${U(1)}.json`))).toBe(false);
    expect(await exists(path.join(registryDir, `${U(2)}.json`))).toBe(true);
    // trashed + audit logged (siblings of registry dir)
    const base = path.dirname(registryDir);
    expect(await exists(path.join(base, "trash"))).toBe(true);
    expect(await exists(path.join(base, "prune-log.jsonl"))).toBe(true);
  });

  test("--session <ambiguous-prefix> → SESSION_SHORT_AMBIGUOUS exit 2", async () => {
    const cwd = path.join(projects, "p1");
    // two uuids share the prefix "0000000" (U(1) and U(2) both start with it)
    await seed(U(1), "a", cwd, "DONE.delivered");
    await seed(U(2), "b", cwd, "DONE.delivered");
    const r = await run(["prune", "--session", "0000000", "--format", "json"]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr).code).toBe("SESSION_SHORT_AMBIGUOUS");
  });
});
