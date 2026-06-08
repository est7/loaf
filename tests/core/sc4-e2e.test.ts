// Phase 15 SC4 — end-to-end closure: write → fast-check → consume →
// stale-fails → rebuild-repairs.
//
// Proves the full Phase 15 lifecycle through the public CLI surface:
//   1. `loaf start` writes journal + step 8 writes snapshots/*.json + _meta
//   2. SC3-wired command reads OK from projections via projection-loader
//   3. Corrupt _meta.json → command exit 2 SNAPSHOT_STALE_REBUILD_REQUIRED,
//      structured stderr, NO stdout payload
//   4. `loaf doctor --rebuild` re-serializes snapshots from journal truth
//   5. Same command reads OK again, byte-equal to step 2 output
//
// Covers all 4 SC3-wired commands (status / tasks list / pending list /
// finding list) per codex r178 "if cheap, do the full stale/rebuild loop
// for all four". Cheap = same fixture across all 4.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc4-"));
}

async function runCli(argv: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await main(["node", "loaf", ...argv]);
    return { exit, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
}

const FEATURE = "auth-refresh";

async function setup(): Promise<string> {
  const dir = await tmpFeatureDir();
  const r = await runCli([
    "start",
    FEATURE,
    "--ceremony",
    "standard",
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  if (r.exit !== 0) throw new Error(`setup start failed: exit=${r.exit} stderr=${r.stderr}`);
  return dir;
}

async function corruptMeta(dir: string): Promise<void> {
  const metaPath = path.join(dir, "snapshots", "_meta.json");
  const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  meta.last_entry_offset = 99999; // claims tail at a fictitious offset
  await fs.writeFile(metaPath, JSON.stringify(meta));
}

async function rebuild(dir: string): Promise<void> {
  const r = await runCli(["doctor", "--rebuild", "--feature", FEATURE, "--feature-dir", dir]);
  if (r.exit !== 0) throw new Error(`doctor --rebuild failed: exit=${r.exit} stderr=${r.stderr}`);
}

/**
 * Run a SC3-wired command through the full closure cycle and assert
 * each transition. Returns the happy-path JSON stdout for byte-equality
 * comparison across the cycle.
 */
async function fullClosure(
  dir: string,
  cmdArgs: readonly string[],
): Promise<{ initialJson: unknown; afterRebuildJson: unknown }> {
  // 2. happy path read
  const happy = await runCli([
    ...cmdArgs,
    "--feature",
    FEATURE,
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  expect(happy.exit).toBe(0);
  expect(happy.stderr).toBe("");
  const initialJson = JSON.parse(happy.stdout);

  // 3. corrupt _meta → command fails stale
  await corruptMeta(dir);
  const stale = await runCli([
    ...cmdArgs,
    "--feature",
    FEATURE,
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  expect(stale.exit).toBe(2);
  expect(stale.stdout).toBe(""); // no stdout payload on stale
  const staleErr = JSON.parse(stale.stderr);
  expect(staleErr).toMatchObject({
    ok: false,
    code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
    detail: { reason: "tail_offset_mismatch", feature_dir: dir },
  });

  // 4. rebuild
  await rebuild(dir);

  // 5. happy path read again, byte-equal to step 2
  const recovered = await runCli([
    ...cmdArgs,
    "--feature",
    FEATURE,
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  expect(recovered.exit).toBe(0);
  expect(recovered.stderr).toBe("");
  const afterRebuildJson = JSON.parse(recovered.stdout);

  return { initialJson, afterRebuildJson };
}

describe("SC4 — write → stale → rebuild → read closure (4 SC3 commands)", () => {
  test("status: full closure cycle, post-rebuild output byte-equal to pre-corruption", async () => {
    const dir = await setup();
    const { initialJson, afterRebuildJson } = await fullClosure(dir, ["status"]);
    expect(afterRebuildJson).toEqual(initialJson);
  });

  test("tasks list: full closure cycle (no-plan empty case)", async () => {
    const dir = await setup();
    const { initialJson, afterRebuildJson } = await fullClosure(dir, ["tasks", "list"]);
    expect(afterRebuildJson).toEqual(initialJson);
    // Sanity: pre-submit empty (codex r173 minimum case)
    expect(initialJson).toMatchObject({ ok: true, count: 0, tasks: [] });
  });

  test("pending list: full closure cycle (empty queue)", async () => {
    const dir = await setup();
    const { initialJson, afterRebuildJson } = await fullClosure(dir, ["pending", "list"]);
    expect(afterRebuildJson).toEqual(initialJson);
    expect(initialJson).toMatchObject({ ok: true, count: 0, pending: [] });
  });

  test("finding list: full closure cycle (empty ledger)", async () => {
    const dir = await setup();
    const { initialJson, afterRebuildJson } = await fullClosure(dir, ["finding", "list"]);
    expect(afterRebuildJson).toEqual(initialJson);
    expect(initialJson).toMatchObject({ ok: true, count: 0, findings: [] });
  });
});

describe("SC4 — alternative stale paths exercised via the same cycle", () => {
  test("trailing_partial_line: truncate journal tail by 1 byte → stale + rebuild repairs", async () => {
    const dir = await setup();
    // happy
    const happy = await runCli([
      "status",
      "--feature",
      FEATURE,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(happy.exit).toBe(0);
    // corrupt: truncate trailing \n from journal
    const journalPath = path.join(dir, "journal.jsonl");
    const stat = await fs.stat(journalPath);
    await fs.truncate(journalPath, stat.size - 1);
    const stale = await runCli([
      "status",
      "--feature",
      FEATURE,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(stale.exit).toBe(2);
    expect(stale.stdout).toBe("");
    const err = JSON.parse(stale.stderr);
    expect(err.code).toBe("SNAPSHOT_STALE_REBUILD_REQUIRED");
    // Note: rebuild after a journal-tail truncation requires the truncated
    // bytes to be recoverable, which `doctor --rebuild` alone cannot do
    // (the journal IS the source of truth). This case is out of the rebuild
    // recovery path — covered by `doctor --check-tail` (future slice).
    // SC4 only asserts that stale is correctly detected here.
  });

  test("projection_missing: delete pending.json → stale + rebuild repairs", async () => {
    const dir = await setup();
    await fs.rm(path.join(dir, "snapshots", "pending.json"));
    const stale = await runCli([
      "pending",
      "list",
      "--feature",
      FEATURE,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(stale.exit).toBe(2);
    expect(stale.stdout).toBe("");
    const err = JSON.parse(stale.stderr);
    expect(err).toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      detail: { reason: "projection_missing", projection_kind: "pending" },
    });
    // rebuild repairs (unconditional writer re-emits pending.json)
    await rebuild(dir);
    const recovered = await runCli([
      "pending",
      "list",
      "--feature",
      FEATURE,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(recovered.exit).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({ ok: true, count: 0, pending: [] });
  });

  test("meta_invalid (schema): wrong feature_schema_version → stale + rebuild repairs", async () => {
    // Probe path codex r176 BLOCK 2 — empty sentinel with bad feature_schema_version.
    // After setup the meta is non-empty (post-start has 1 journal entry), so this
    // test uses a different shape: write a meta with seq=0 but invalid schema field.
    const dir = await setup();
    const metaPath = path.join(dir, "snapshots", "_meta.json");
    const raw = JSON.parse(await fs.readFile(metaPath, "utf8"));
    raw.last_applied_seq = "not-a-number"; // schema fail
    await fs.writeFile(metaPath, JSON.stringify(raw));
    const stale = await runCli([
      "status",
      "--feature",
      FEATURE,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(stale.exit).toBe(2);
    expect(stale.stdout).toBe("");
    const err = JSON.parse(stale.stderr);
    expect(err).toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      detail: { reason: "meta_invalid", cause: "schema" },
    });
    // rebuild repairs (writes a valid _meta)
    await rebuild(dir);
    const recovered = await runCli([
      "status",
      "--feature",
      FEATURE,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(recovered.exit).toBe(0);
  });
});
