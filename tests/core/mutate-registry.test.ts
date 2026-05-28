// Phase 16 SC-7 — mutator pipeline step 9 (registry refresh) integration.
//
// Covers the codex r280 P4 invariant split:
//   - IO write failure → mutate returns ok:true (best-effort silenced)
//   - Derivation failure → mutate returns ok:false with PROJECTION_WRITE_FAILED
//     (NOT silent ok, NOT CLI crash)
// Plus dry-run suppression (registry stays absent) + happy-path write
// (registry file produced with correct shape).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

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

async function tmpRegDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc7-mut-reg-"));
}

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc7-mut-feat-"));
}

describe("SC-7 — mutator step 9 registry refresh", () => {
  test("T11: mutate(session:started) writes registry file to injected dir", async () => {
    const featureDir = await tmpFeatureDir();
    const regDir = await tmpRegDir();
    const result = await mutate(
      {
        at: "2026-05-28T11:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440010",
          feature: "auth-refresh",
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
        registryWriter: { registryDir: regDir },
      },
    );

    expect(result.ok).toBe(true);
    // Registry file exists at the expected path
    const regPath = path.join(regDir, "550e8400-e29b-41d4-a716-446655440010.json");
    const stat = await fs.stat(regPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);

    const reg = JSON.parse(await fs.readFile(regPath, "utf8"));
    expect(reg.session_id).toBe("550e8400-e29b-41d4-a716-446655440010");
    expect(reg.feature).toBe("auth-refresh");
    expect(reg.sub_state).toBe("TRIAGE.score");
  });

  test("T12: dry-run does NOT write registry", async () => {
    const featureDir = await tmpFeatureDir();
    const regDir = await tmpRegDir();
    const result = await mutate(
      {
        at: "2026-05-28T11:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440011",
          feature: "auth-refresh",
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
        dryRun: true,
        registryWriter: { registryDir: regDir },
      },
    );

    expect(result.ok).toBe(true);
    // No registry file written under dry-run
    const regPath = path.join(regDir, "550e8400-e29b-41d4-a716-446655440011.json");
    await expect(fs.stat(regPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("T13: registry IO write failure does NOT fail mutate (best-effort, P4)", async () => {
    const featureDir = await tmpFeatureDir();
    // Inject a registry dir path that cannot be created (a regular file
    // at the path that mkdir -p will fail on).
    const parent = await tmpRegDir();
    const blockingFile = path.join(parent, "blocker");
    await fs.writeFile(blockingFile, "I am a file, not a dir");
    // Now try to use `<blockingFile>/sub` as registryDir — mkdir will
    // fail because blockingFile is a file.
    const blockedRegDir = path.join(blockingFile, "sub");

    const result = await mutate(
      {
        at: "2026-05-28T11:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440012",
          feature: "auth-refresh",
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
        registryWriter: { registryDir: blockedRegDir },
      },
    );

    // Best-effort: mutate still returns ok despite registry IO failure
    expect(result.ok).toBe(true);
    // Journal IS written (mutate proper succeeded)
    const journal = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
    expect(journal.trim().split("\n").length).toBe(1);
  });

  test("T15: derivation failure surfaces as PROJECTION_WRITE_FAILED (codex r280 P4)", async () => {
    // Force buildRegistryFile to throw by injecting a `now()` that
    // throws. The exception propagates out of the field eval before
    // buildRegistryFile parses; the outer try wrapper catches and
    // converts to a mutate failure result. Asserts:
    //   - ok:false (NOT silent ok — codex r280 P4 invariant)
    //   - code: PROJECTION_WRITE_FAILED
    //   - detail.projection: "registry"
    //   - detail.phase: "derivation"
    //   - NOT a top-level CLI crash (no rethrow)
    const featureDir = await tmpFeatureDir();
    const regDir = await tmpRegDir();
    const result = await mutate(
      {
        at: "2026-05-28T11:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440015",
          feature: "auth-refresh",
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
        registryWriter: {
          registryDir: regDir,
          now: (): Date => {
            throw new Error("test-induced derivation failure");
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROJECTION_WRITE_FAILED");
      expect(result.detail?.projection).toBe("registry");
      expect(result.detail?.phase).toBe("derivation");
      expect(result.message).toContain("test-induced derivation failure");
    }
    // Journal IS written (mutate proper had succeeded; step 9 derivation
    // is post-append per protocol §11.2)
    const journal = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
    expect(journal.trim().split("\n").length).toBe(1);
  });

  test("T14: NON-dry-run regression — registry writes for session:started by default", async () => {
    const featureDir = await tmpFeatureDir();
    const regDir = await tmpRegDir();
    const result = await mutate(
      {
        at: "2026-05-28T11:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440014",
          feature: "auth-refresh",
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
        registryWriter: { registryDir: regDir },
      },
    );
    expect(result.ok).toBe(true);
    const files = await fs.readdir(regDir);
    expect(files).toContain("550e8400-e29b-41d4-a716-446655440014.json");
  });
});
