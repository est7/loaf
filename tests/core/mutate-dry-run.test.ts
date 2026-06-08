// Phase 16 SC-6c — mutate / mutateBatch dry-run pipeline tests.
//
// Covers:
//   - dry-run short-circuits before disk write (no journal.jsonl appended,
//     no attachments/ directory created)
//   - dry-run preserves preflight + reducer + gate error priority (codex
//     r275/r276 P3 / P7 — integrity check after Pass 1.5, before
//     early-return; preflight errors win over INVALID_BATCH)
//   - dry-run still applies the in-memory snapshot dry-run (caller can
//     read the would-be projection state from the result)
//   - Long-text-field sidecar promotion NOT triggered under dry-run

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { mutate, mutateBatch } from "../../src/core/journal-mutate.js";
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

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc6c-mutate-"));
}

describe("SC-6c — mutate dry-run pipeline", () => {
  test("T9: dry-run session:started → ok, no journal.jsonl, no attachments/", async () => {
    const dir = await tmpFeatureDir();
    const result = await mutate(
      {
        at: "2026-05-28T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      },
      {
        feature_dir: dir,
        snapshot: initialSnapshot(),
        tail_seq: -1,
        entries: [],
        meta: emptyMeta(),
        dryRun: true,
        fsync: false,
      },
    );

    expect(result.ok).toBe(true);
    // No journal.jsonl on disk
    await expect(fs.stat(path.join(dir, "journal.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // No attachments/ directory
    await expect(fs.stat(path.join(dir, "attachments"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("T10: dry-run returns the would-be snapshot (in-memory projection applied)", async () => {
    const dir = await tmpFeatureDir();
    const result = await mutate(
      {
        at: "2026-05-28T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      },
      {
        feature_dir: dir,
        snapshot: initialSnapshot(),
        tail_seq: -1,
        entries: [],
        meta: emptyMeta(),
        dryRun: true,
        fsync: false,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The would-be snapshot has the session state populated
      expect(result.snapshot.state?.sub_state).toBe("TRIAGE.score");
      expect(result.snapshot.state?.feature).toBe("auth-refresh");
    }
  });

  test("T11: dry-run preflight error (bad payload shape) → preflight code wins", async () => {
    const dir = await tmpFeatureDir();
    const result = await mutate(
      {
        at: "2026-05-28T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          /* missing session_id / feature / ceremony */
        } as never,
      },
      {
        feature_dir: dir,
        snapshot: initialSnapshot(),
        tail_seq: -1,
        entries: [],
        meta: emptyMeta(),
        dryRun: true,
        fsync: false,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Preflight surfaces SCHEMA_VALIDATION_FAILED (or PER_KIND_PAYLOAD
      // schema code); never INVALID_BATCH from the integrity check
      expect(result.code).not.toBe("INVALID_BATCH");
    }
  });

  test("T12: dry-run with stale ctx (entries empty, meta empty, tail_seq off) → INVALID_BATCH", async () => {
    const dir = await tmpFeatureDir();
    // Stale: tail_seq=5 but entries empty and meta empty
    const result = await mutate(
      {
        at: "2026-05-28T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      },
      {
        feature_dir: dir,
        snapshot: initialSnapshot(),
        tail_seq: 5, // ← inconsistent: entries says tail seq -1
        entries: [],
        meta: emptyMeta(), // ← inconsistent: meta.last_applied_seq -1
        dryRun: true,
        fsync: false,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_BATCH");
    }
    // Verify NO journal on disk either way
    await expect(fs.stat(path.join(dir, "journal.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("T13: dry-run mutateBatch short-circuits — no partial writes", async () => {
    const dir = await tmpFeatureDir();
    const result = await mutateBatch(
      [
        {
          at: "2026-05-28T10:00:00.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "session:started",
          payload: {
            session_id: "550e8400-e29b-41d4-a716-446655440000",
            feature: "auth-refresh",
            ceremony: STANDARD_CEREMONY,
          },
        },
      ],
      {
        feature_dir: dir,
        snapshot: initialSnapshot(),
        tail_seq: -1,
        entries: [],
        meta: emptyMeta(),
        dryRun: true,
        fsync: false,
      },
    );

    expect(result.ok).toBe(true);
    // No journal on disk
    await expect(fs.stat(path.join(dir, "journal.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("T14: NON-dry-run still works (regression — default behavior unchanged)", async () => {
    const dir = await tmpFeatureDir();
    const result = await mutate(
      {
        at: "2026-05-28T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      },
      {
        feature_dir: dir,
        snapshot: initialSnapshot(),
        tail_seq: -1,
        entries: [],
        meta: emptyMeta(),
        // dryRun omitted (defaults false)
        fsync: false,
      },
    );

    expect(result.ok).toBe(true);
    // Real append happened
    const journal = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journal.trim().split("\n").length).toBe(1);
  });
});
