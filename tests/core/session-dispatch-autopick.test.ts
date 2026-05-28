// Phase 16 SC-8 — auto-pick (level 5) tests.
//
// Codex r286 P5 invariant:
//   - NoSessionError → silent skip (not a candidate)
//   - SnapshotStaleError → PROPAGATE as SNAPSHOT_STALE_REBUILD_REQUIRED
//   - Successful load + phase === "DONE" → terminal (not active)
//   - Successful load + phase !== "DONE" → active candidate

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { resolveDispatch } from "../../src/core/session-dispatch.js";
import { mutate } from "../../src/core/journal-mutate.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import { emptyMeta } from "../../src/core/snapshot.js";
import type { Ceremony } from "../../src/core/journal-entry.js";

const STANDARD_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

async function tmpCwd(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc8-autopick-"));
}

async function tmpRegDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc8-autopick-reg-"));
}

async function seedFeature(cwd: string, feature: string, regDir: string): Promise<void> {
  const featureDir = path.join(cwd, ".loaf", feature);
  await fs.mkdir(featureDir, { recursive: true });
  await mutate(
    {
      at: "2026-05-28T13:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: {
        session_id: `550e8400-e29b-41d4-a716-${Math.random().toString(16).slice(2, 14).padStart(12, "0")}`,
        feature,
        ceremony: STANDARD_CEREMONY,
      },
    },
    {
      feature_dir: featureDir,
      snapshot: initialSnapshot(),
      tail_seq: -1,
      entries: [],
      meta: emptyMeta(),
      fsync: false,
      registryWriter: { registryDir: regDir, cwd: () => cwd },
    },
  );
}

describe("SC-8 — auto-pick (level 5)", () => {
  test("T-auto-1: 0 features in cwd → FEATURE_NOT_FOUND", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const result = await resolveDispatch({
      argv: [],
      env: {},
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FEATURE_NOT_FOUND");
  });

  test("T-auto-2: 1 active feature → DispatchOk + advisory", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    await seedFeature(cwd, "auth-refresh", regDir);

    const result = await resolveDispatch({
      argv: [],
      env: {},
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("auto-pick");
      expect(result.feature).toBe("auth-refresh");
      expect(result.autoPickAdvisory).toBe("auto-picked 'auth-refresh'");
    }
  });

  test("T-auto-4: 2+ active features → FEATURE_AMBIGUOUS", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    await seedFeature(cwd, "feature-one", regDir);
    await seedFeature(cwd, "feature-two", regDir);

    const result = await resolveDispatch({
      argv: [],
      env: {},
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FEATURE_AMBIGUOUS");
      expect((result.detail.feature_list as string[]).sort()).toEqual(
        ["feature-one", "feature-two"].sort(),
      );
    }
  });

  test("T-auto-5a: 1 valid + 1 empty .loaf/<x>/ dir (no session) → DispatchOk on valid (NoSession silent skip)", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    await seedFeature(cwd, "valid-feature", regDir);
    // Create an empty `.loaf/empty/` dir with no journal — should trigger NoSessionError
    await fs.mkdir(path.join(cwd, ".loaf", "empty-feature"), { recursive: true });

    const result = await resolveDispatch({
      argv: [],
      env: {},
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.feature).toBe("valid-feature");
      expect(result.source).toBe("auto-pick");
    }
  });

  test("T-auto-5b: 1 valid + 1 corrupt/stale projection → PROPAGATE SNAPSHOT_STALE_REBUILD_REQUIRED", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    await seedFeature(cwd, "valid-feature", regDir);
    // Create a feature with corrupt _meta.json to trigger SnapshotStaleError
    const staleDir = path.join(cwd, ".loaf", "stale-feature");
    await fs.mkdir(path.join(staleDir, "snapshots"), { recursive: true });
    // Write minimal journal so NoSessionError doesn't trigger (we want
    // SnapshotStaleError instead). Easier: write corrupt _meta.json
    // alongside a partial journal.
    await fs.writeFile(path.join(staleDir, "journal.jsonl"),
      JSON.stringify({
        seq: 0,
        entry_id: "JE-000000",
        at: "2026-05-28T13:00:00.000Z",
        actor: "cli:loaf",
        kind: "session:started",
        schema_version: 2,
        payload: { session_id: "550e8400-e29b-41d4-a716-deadbeefdead", feature: "stale-feature", ceremony: STANDARD_CEREMONY },
      }) + "\n");
    // Write a _meta.json that intentionally mismatches the journal tail
    // to trigger snapshot-stale.
    await fs.writeFile(
      path.join(staleDir, "snapshots", "_meta.json"),
      JSON.stringify({
        schema_version: 2,
        last_applied_seq: 999, // intentional mismatch
        last_entry_iso_ts: "2026-05-28T13:00:00.000Z",
        rolling_checksum: "abc123",
      }),
    );

    const result = await resolveDispatch({
      argv: [],
      env: {},
      cwd,
      registryDir: regDir,
    });
    // Stale must propagate, NOT be silently skipped (codex r286 P5)
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SNAPSHOT_STALE_REBUILD_REQUIRED");
      expect(result.detail.dispatch_phase).toBe("auto-pick");
    }
  });

  test("T-auto-7: 0 valid + 1 stale only → SNAPSHOT_STALE_REBUILD_REQUIRED (not FEATURE_NOT_FOUND)", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const staleDir = path.join(cwd, ".loaf", "stale-only");
    await fs.mkdir(path.join(staleDir, "snapshots"), { recursive: true });
    await fs.writeFile(path.join(staleDir, "journal.jsonl"),
      JSON.stringify({
        seq: 0,
        entry_id: "JE-000000",
        at: "2026-05-28T13:00:00.000Z",
        actor: "cli:loaf",
        kind: "session:started",
        schema_version: 2,
        payload: { session_id: "550e8400-e29b-41d4-a716-deadbeefdea1", feature: "stale-only", ceremony: STANDARD_CEREMONY },
      }) + "\n");
    await fs.writeFile(
      path.join(staleDir, "snapshots", "_meta.json"),
      JSON.stringify({
        schema_version: 2,
        last_applied_seq: 999,
        last_entry_iso_ts: "2026-05-28T13:00:00.000Z",
        rolling_checksum: "abc123",
      }),
    );

    const result = await resolveDispatch({
      argv: [],
      env: {},
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Stale propagation takes precedence over the empty-set FEATURE_NOT_FOUND
      expect(result.code).toBe("SNAPSHOT_STALE_REBUILD_REQUIRED");
    }
  });
});
