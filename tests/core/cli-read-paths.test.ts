// Phase 15 SC3 — CLI read-path integration tests for the four commands
// that switch from loadSession (full replay) to loadProjections (snapshot +
// fast-check): `status`, `tasks list`, `pending list`, `finding list`.
//
// Two test groups:
//   1. Contract preservation — public JSON shape MUST stay byte-for-byte
//      identical to the current (loadSession-derived) output. Regression
//      guard for the slim adapter (tasks list: TaskFull → slim+ready;
//      pending list: pending_id → id).
//   2. New behavior — stale/invalid/NO_SESSION paths surface as structured
//      failures on stderr with exit 2 (was not exercised before SC3).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-cli-readpath-"));
}

async function runCli(
  argv: string[],
): Promise<{ exit: number; stdout: string; stderr: string }> {
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

async function startFeature(dir: string): Promise<void> {
  const r = await runCli([
    "start", "auth-refresh",
    "--ceremony", "standard",
    "--feature-dir", dir,
    "--format", "json",
  ]);
  if (r.exit !== 0) throw new Error(`start failed (exit=${r.exit}): ${r.stderr}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Contract preservation — happy path public shape (regression guard).
// ─────────────────────────────────────────────────────────────────────────

describe("SC3 contract preservation — 4 read commands, happy path", () => {
  test("status JSON shape preserved (top-level + state slim, codex r176 BLOCK 1 guard)", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);
    const r = await runCli([
      "status", "--feature", "auth-refresh", "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    // Top-level keys EXACTLY: ok, feature, feature_dir, tail_seq, state,
    // 4 counts. No extras (catches incidental widening).
    expect(Object.keys(out).sort()).toEqual([
      "evidence_count",
      "feature",
      "feature_dir",
      "findings_count",
      "ok",
      "pending_count",
      "state",
      "tail_seq",
      "tasks_count",
    ]);
    expect(out.ok).toBe(true);
    expect(out.feature).toBe("auth-refresh");
    expect(out.feature_dir).toBe(dir);
    expect(typeof out.tail_seq).toBe("number");
    expect(out.tasks_count).toBe(0);
    expect(out.evidence_count).toBe(0);
    expect(out.findings_count).toBe(0);
    expect(out.pending_count).toBe(0);
    // state slim shape — SessionState-compatible 9 fields ONLY. No SC1
    // bucket-C widening (session_label / workspace / loaf_version_required
    // / ceremony_label / complexity_score / based_on / created_at /
    // updated_at / pending / schema_version stay in StateProjection but
    // MUST NOT leak through status.state).
    expect(Object.keys(out.state).sort()).toEqual([
      "ceremony",
      "feature",
      "iteration",
      "phase",
      "session_id",
      "spec_locked",
      "spec_version",
      "sub_state",
      "verify_accepted",
    ]);
    expect(out.state.feature).toBe("auth-refresh");
    expect(out.state.phase).toBe("TRIAGE");
    expect(out.state.sub_state).toBe("TRIAGE.score");
  });

  test("tasks list JSON shape preserved (count + slim tasks with derived ready) — post-start pre-submit empty", async () => {
    // codex r173 minimum case: tasks.json is absent (writer skipped — no plan)
    // yet command must return exit 0 + count=0, NOT projection_missing.
    const dir = await tmpFeatureDir();
    await startFeature(dir);
    const r = await runCli([
      "tasks", "list", "--feature", "auth-refresh", "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(0);
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ ok: true, count: 0, tasks: [] });
  });

  test("pending list JSON shape preserved (id, kind, resolved, head — NOT pending_id)", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);
    const r = await runCli([
      "pending", "list", "--feature", "auth-refresh", "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ ok: true, count: 0, pending: [] });
    // After a pending:added landed, each row must have `id` (slim) not
    // `pending_id` (pending.json native). Covered when fixture extends to
    // include a pending entry — for now the empty-list shape guards the
    // top-level contract.
  });

  test("finding list JSON shape preserved (id, category, action, status)", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);
    const r = await runCli([
      "finding", "list", "--feature", "auth-refresh", "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ ok: true, count: 0, findings: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// NO_SESSION — fresh empty dir; loader's no-session gate must fire BEFORE
// any leaf read attempt (so projection_missing never surfaces here).
// ─────────────────────────────────────────────────────────────────────────

describe("SC3 NO_SESSION — fresh dir for all 4 commands", () => {
  test("status on empty dir → exit 2 NO_SESSION", async () => {
    const dir = await tmpFeatureDir();
    const r = await runCli([
      "status", "--feature", "auth-refresh", "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toBeTruthy();
    const err = JSON.parse(r.stderr);
    // SC-8: dispatch resolver maps NoSessionError → FEATURE_NOT_FOUND
    // (the dispatch-layer code for "no session in this feature dir").
    expect(err).toMatchObject({ ok: false, code: "FEATURE_NOT_FOUND" });
  });

  test("tasks list on empty dir → exit 2 NO_SESSION", async () => {
    const dir = await tmpFeatureDir();
    const r = await runCli([
      "tasks", "list", "--feature", "auth-refresh", "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(2);
    const err = JSON.parse(r.stderr);
    // SC-8: dispatch resolver maps NoSessionError → FEATURE_NOT_FOUND
    // (the dispatch-layer code for "no session in this feature dir").
    expect(err).toMatchObject({ ok: false, code: "FEATURE_NOT_FOUND" });
  });

  test("pending list on empty dir → exit 2 NO_SESSION", async () => {
    const dir = await tmpFeatureDir();
    const r = await runCli([
      "pending", "list", "--feature", "auth-refresh", "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(2);
    const err = JSON.parse(r.stderr);
    // SC-8: dispatch resolver maps NoSessionError → FEATURE_NOT_FOUND
    // (the dispatch-layer code for "no session in this feature dir").
    expect(err).toMatchObject({ ok: false, code: "FEATURE_NOT_FOUND" });
  });

  test("finding list on empty dir → exit 2 NO_SESSION", async () => {
    const dir = await tmpFeatureDir();
    const r = await runCli([
      "finding", "list", "--feature", "auth-refresh", "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(2);
    const err = JSON.parse(r.stderr);
    // SC-8: dispatch resolver maps NoSessionError → FEATURE_NOT_FOUND
    // (the dispatch-layer code for "no session in this feature dir").
    expect(err).toMatchObject({ ok: false, code: "FEATURE_NOT_FOUND" });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Stale — fast-check fires SNAPSHOT_STALE_REBUILD_REQUIRED on stderr (exit 2).
// Genuine RED: current loadSession-based commands do not run fast-check at
// all, so these will fail until SC3 impl lands.
// ─────────────────────────────────────────────────────────────────────────

describe("SC3 stale meta → SNAPSHOT_STALE_REBUILD_REQUIRED on stderr (exit 2)", () => {
  async function corruptMetaOffset(dir: string): Promise<void> {
    const metaPath = path.join(dir, "snapshots", "_meta.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    meta.last_entry_offset = 99999;
    await fs.writeFile(metaPath, JSON.stringify(meta));
  }

  test("status with corrupt meta offset → exit 2 + stale on stderr (tail_offset_mismatch)", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);
    await corruptMetaOffset(dir);
    const r = await runCli([
      "status", "--feature", "auth-refresh", "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(2);
    expect(r.stdout).toBe("");
    const err = JSON.parse(r.stderr);
    expect(err).toMatchObject({
      ok: false,
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      detail: { reason: "tail_offset_mismatch", feature_dir: dir, fix: expect.stringContaining("doctor --rebuild") },
    });
  });

  test("tasks list with corrupt meta offset → exit 2 + stale on stderr", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);
    await corruptMetaOffset(dir);
    const r = await runCli([
      "tasks", "list", "--feature", "auth-refresh", "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(2);
    expect(r.stdout).toBe("");
    const err = JSON.parse(r.stderr);
    expect(err).toMatchObject({
      ok: false,
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      detail: { reason: "tail_offset_mismatch" },
    });
  });

  test("pending list with corrupt meta offset → exit 2 + stale on stderr", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);
    await corruptMetaOffset(dir);
    const r = await runCli([
      "pending", "list", "--feature", "auth-refresh", "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(2);
    expect(r.stdout).toBe("");
    const err = JSON.parse(r.stderr);
    expect(err).toMatchObject({
      ok: false,
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      detail: { reason: "tail_offset_mismatch" },
    });
  });

  test("finding list with corrupt meta offset → exit 2 + stale on stderr", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);
    await corruptMetaOffset(dir);
    const r = await runCli([
      "finding", "list", "--feature", "auth-refresh", "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(2);
    expect(r.stdout).toBe("");
    const err = JSON.parse(r.stderr);
    expect(err).toMatchObject({
      ok: false,
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      detail: { reason: "tail_offset_mismatch" },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Invalid — meta or leaf is malformed JSON / schema-fail. Distinct from
// stale (which is "fresh fields but inconsistent with journal").
// ─────────────────────────────────────────────────────────────────────────

describe("SC3 invalid meta/leaf → exit 2 + structured cause on stderr", () => {
  test("status: malformed _meta.json → exit 2 meta_invalid cause=json_parse", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);
    await fs.writeFile(path.join(dir, "snapshots", "_meta.json"), "{ not valid json");
    const r = await runCli([
      "status", "--feature", "auth-refresh", "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(2);
    expect(r.stdout).toBe("");
    const err = JSON.parse(r.stderr);
    expect(err).toMatchObject({
      ok: false,
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      detail: { reason: "meta_invalid", cause: "json_parse" },
    });
  });

  test("pending list: malformed pending.json → exit 2 projection_invalid cause=schema or json_parse", async () => {
    const dir = await tmpFeatureDir();
    await startFeature(dir);
    // Schema-fail: write valid JSON that violates the PendingJson schema.
    await fs.writeFile(
      path.join(dir, "snapshots", "pending.json"),
      JSON.stringify({ schema_version: 2, pending: [{ pending_id: "BAD-ID" }] }),
    );
    const r = await runCli([
      "pending", "list", "--feature", "auth-refresh", "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(2);
    expect(r.stdout).toBe("");
    const err = JSON.parse(r.stderr);
    expect(err).toMatchObject({
      ok: false,
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      detail: {
        reason: "projection_invalid",
        projection_kind: "pending",
        cause: "schema",
      },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// TOCTOU coverage notes (SC4 wiring per codex r178 Q2):
//   - Deterministic loader-level race exercised via the test-only seam
//     `loadProjectionsWithHooks` in tests/core/projection-loader.test.ts
//     (the "TOCTOU M0-anchored linearization guard" describe block).
//   - End-to-end stale→rebuild lifecycle at the CLI level exercised in
//     tests/core/sc4-e2e.test.ts.
//   - No CLI-level test seam is exposed; mid-call CLI race testing would
//     require an injectable boundary in the public command surface that
//     codex deliberately ruled out. The loader-level seam + SC4 E2E
//     cover the contract end-to-end.
// ─────────────────────────────────────────────────────────────────────────
