// Phase 15 SC3 — projection-loader (read-side snapshot consumer with M0-anchored TOCTOU).
//
// Single fast-check transaction per loadProjections() call:
//   M0 = read+parse _meta.json
//   fast-check(M0) → if !fresh: SnapshotStaleError
//   read N requested projection leaves
//   fast-check(M0) again → linearization guard against mid-call mutator
//   return leaves
//
// Stale/corruption taxonomy (9 reasons centralized in projection-loader):
//   5 reader reasons (journal_missing/journal_empty/tail_*/trailing_partial_line)
//   + meta_missing / meta_invalid (cause: json_parse | schema)
//   + projection_missing / projection_invalid (cause: json_parse | schema)
// NO_SESSION is a separate code, not a stale reason — fires when isEmptyMeta + journal
// also empty/missing (loader gate runs BEFORE leaf reads).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { appendEntry } from "../../src/core/journal-append.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import {
  emptyMeta,
  FEATURE_SCHEMA_VERSION,
  type SnapshotMeta,
} from "../../src/core/snapshot.js";
import { mutate as mutateRaw } from "../../src/core/journal-mutate.js";
import type { Ceremony, JournalEntry } from "../../src/core/journal-entry.js";

// SC3 API (committed `1f21758`).
import {
  loadProjections,
  loadProjection,
  type SnapshotStaleError,
} from "../../src/core/projection-loader.js";

// SC4 test-only seam — not exposed to CLI / docs. Used to deterministically
// simulate a mid-call mutator extending the journal between the two
// fast-checks (codex r178 Q1: separate test-only export, NOT an underscore
// option on canonical loadProjections input).
import { loadProjectionsWithHooks } from "../../src/core/projection-loader.js";

const STANDARD: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-projloader-"));
}

/**
 * Seed a feature dir at SESSION-STARTED with a single `session:started`
 * entry + writeProjections to populate snapshots/{state,evidence,findings,pending}.json
 * + _meta.json. tasks.json is intentionally absent (no plan yet).
 *
 * Returns the post-write snapshot, entries, and meta so callers can poke
 * specific files for stale/invalid cases without going through the CLI.
 */
async function seedStarted(dir: string): Promise<{
  snapshot: ReturnType<typeof initialSnapshot>;
  entries: JournalEntry[];
  meta: SnapshotMeta;
}> {
  const r = await mutateRaw(
    {
      at: "2026-05-15T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "auth-refresh",
        ceremony: STANDARD,
      },
    },
    { feature_dir: dir, snapshot: initialSnapshot(), tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
  );
  if (!r.ok) throw new Error(`seed boot failed: ${r.message}`);
  return { snapshot: r.snapshot, entries: [r.entry], meta: r.meta };
}

// ─────────────────────────────────────────────────────────────────────────
// Stale paths — 5 reader reasons + meta_missing + meta_invalid×2 +
// projection_missing + projection_invalid×2 = 11 cases.
// ─────────────────────────────────────────────────────────────────────────

describe("loadProjections — stale paths (9-reason taxonomy)", () => {
  test("meta seq beyond journal tail → tail_offset_mismatch (5 reader reasons covered via cli e2e elsewhere)", async () => {
    const dir = await tmpFeatureDir();
    await seedStarted(dir);
    // Corrupt _meta.json to claim a fictitious last_entry_offset.
    const metaPath = path.join(dir, "snapshots", "_meta.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as SnapshotMeta;
    meta.last_entry_offset = 99999;
    await fs.writeFile(metaPath, JSON.stringify(meta));

    await expect(loadProjections({ feature_dir: dir, kinds: ["state"] })).rejects.toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      reason: "tail_offset_mismatch",
    });
  });

  test("meta line_hash differs from journal tail → tail_hash_mismatch", async () => {
    const dir = await tmpFeatureDir();
    await seedStarted(dir);
    const metaPath = path.join(dir, "snapshots", "_meta.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as SnapshotMeta;
    meta.last_entry_line_hash = "deadbeef".repeat(8);
    await fs.writeFile(metaPath, JSON.stringify(meta));

    await expect(loadProjections({ feature_dir: dir, kinds: ["state"] })).rejects.toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      reason: "tail_hash_mismatch",
    });
  });

  test("journal tail missing trailing newline → trailing_partial_line", async () => {
    const dir = await tmpFeatureDir();
    await seedStarted(dir);
    const journalPath = path.join(dir, "journal.jsonl");
    const stat = await fs.stat(journalPath);
    await fs.truncate(journalPath, stat.size - 1);

    await expect(loadProjections({ feature_dir: dir, kinds: ["state"] })).rejects.toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      reason: "trailing_partial_line",
    });
  });

  test("journal grown beyond meta (replay extends past meta tail) → tail_offset_mismatch", async () => {
    const dir = await tmpFeatureDir();
    const seeded = await seedStarted(dir);
    // Append a second entry directly to the journal (NOT through mutateBatch),
    // simulating a mutator that crashed mid-step-8 (journal append succeeded,
    // projection write didn't).
    const journalPath = path.join(dir, "journal.jsonl");
    await appendEntry(
      journalPath,
      {
        seq: 1,
        entry_id: "JE-000002",
        at: "2026-05-15T10:00:01.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: "TRIAGE.score", to: "TRIAGE.confirm" },
      },
      seeded.meta,
      { fsync: false },
    );

    await expect(loadProjections({ feature_dir: dir, kinds: ["state"] })).rejects.toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      reason: "tail_offset_mismatch",
    });
  });

  test("_meta.json absent + journal present → meta_missing", async () => {
    const dir = await tmpFeatureDir();
    await seedStarted(dir);
    await fs.rm(path.join(dir, "snapshots", "_meta.json"));

    await expect(loadProjections({ feature_dir: dir, kinds: ["state"] })).rejects.toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      reason: "meta_missing",
    });
  });

  test("_meta.json malformed JSON → meta_invalid cause=json_parse", async () => {
    const dir = await tmpFeatureDir();
    await seedStarted(dir);
    await fs.writeFile(path.join(dir, "snapshots", "_meta.json"), "{ not valid json");

    try {
      await loadProjections({ feature_dir: dir, kinds: ["state"] });
      throw new Error("expected SnapshotStaleError");
    } catch (e) {
      const err = e as SnapshotStaleError;
      expect(err.code).toBe("SNAPSHOT_STALE_REBUILD_REQUIRED");
      expect(err.reason).toBe("meta_invalid");
      expect(err.detail).toMatchObject({ cause: "json_parse" });
    }
  });

  test("_meta.json fails schema (extra field / wrong type) → meta_invalid cause=schema", async () => {
    const dir = await tmpFeatureDir();
    await seedStarted(dir);
    const metaPath = path.join(dir, "snapshots", "_meta.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    meta.last_applied_seq = "not-a-number"; // schema requires int
    await fs.writeFile(metaPath, JSON.stringify(meta));

    await expect(loadProjections({ feature_dir: dir, kinds: ["state"] })).rejects.toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      reason: "meta_invalid",
      detail: { cause: "schema" },
    });
  });

  test("r175 sentinel guard — meta seq=-1 + non-empty structural fields → meta_invalid cause=schema (never NO_SESSION)", async () => {
    // The critical case codex r175 flagged: a corrupt meta claiming the empty
    // sentinel (seq=-1) but carrying non-empty offset/hash/checksum must not
    // silently translate to NO_SESSION via checkSnapshotFresh.
    const dir = await tmpFeatureDir();
    await fs.mkdir(path.join(dir, "snapshots"), { recursive: true });
    // Journal does not exist (would be the NO_SESSION path), but meta does.
    const malformed: SnapshotMeta = {
      last_applied_seq: -1,
      last_entry_offset: 500, // ← non-zero (violates empty sentinel invariant)
      last_entry_line_hash: "0".repeat(64),
      rolling_checksum: "0".repeat(64),
      feature_schema_version: FEATURE_SCHEMA_VERSION,
      written_at: "2026-05-15T00:00:00.000Z",
    };
    await fs.writeFile(path.join(dir, "snapshots", "_meta.json"), JSON.stringify(malformed));

    await expect(loadProjections({ feature_dir: dir, kinds: ["state"] })).rejects.toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      reason: "meta_invalid",
      detail: { cause: "schema" },
    });
  });

  test("r176 BLOCK 2 — meta seq=-1 + zero offset/hashes BUT wrong feature_schema_version → meta_invalid cause=schema (not journal_missing)", async () => {
    // codex r176 live probe: prior refine missed feature_schema_version, so
    // a corrupt empty-sentinel meta with feature_schema_version=999 got
    // classified as journal_missing (silent fallback through fast-check).
    // isEmptyMeta() checks all 5 structural fields including
    // feature_schema_version === FEATURE_SCHEMA_VERSION (snapshot.ts:64-72).
    // The runtime SnapshotMeta refine must mirror that exactly.
    const dir = await tmpFeatureDir();
    await fs.mkdir(path.join(dir, "snapshots"), { recursive: true });
    const malformed = {
      last_applied_seq: -1,
      last_entry_offset: 0,
      last_entry_line_hash: "0".repeat(64),
      rolling_checksum: "0".repeat(64),
      feature_schema_version: 999, // ← wrong; sentinel requires FEATURE_SCHEMA_VERSION
      written_at: "2026-05-15T00:00:00.000Z",
    };
    await fs.writeFile(path.join(dir, "snapshots", "_meta.json"), JSON.stringify(malformed));

    await expect(loadProjections({ feature_dir: dir, kinds: ["state"] })).rejects.toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      reason: "meta_invalid",
      detail: { cause: "schema" },
    });
  });

  test("state.json absent + journal non-empty (post-start) → projection_missing", async () => {
    const dir = await tmpFeatureDir();
    await seedStarted(dir);
    await fs.rm(path.join(dir, "snapshots", "state.json"));

    await expect(loadProjections({ feature_dir: dir, kinds: ["state"] })).rejects.toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      reason: "projection_missing",
      detail: { projection_kind: "state" },
    });
  });

  test("pending.json absent (unconditional writer — corruption) → projection_missing", async () => {
    const dir = await tmpFeatureDir();
    await seedStarted(dir);
    await fs.rm(path.join(dir, "snapshots", "pending.json"));

    await expect(loadProjections({ feature_dir: dir, kinds: ["pending"] })).rejects.toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      reason: "projection_missing",
      detail: { projection_kind: "pending" },
    });
  });

  test("state.json malformed JSON → projection_invalid cause=json_parse", async () => {
    const dir = await tmpFeatureDir();
    await seedStarted(dir);
    await fs.writeFile(path.join(dir, "snapshots", "state.json"), "{ not valid");

    await expect(loadProjections({ feature_dir: dir, kinds: ["state"] })).rejects.toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      reason: "projection_invalid",
      detail: { projection_kind: "state", cause: "json_parse" },
    });
  });

  test("findings.json schema-fail → projection_invalid cause=schema", async () => {
    const dir = await tmpFeatureDir();
    await seedStarted(dir);
    await fs.writeFile(
      path.join(dir, "snapshots", "findings.json"),
      JSON.stringify({ schema_version: 2, findings: [{ id: "BAD" /* malformed id */ }] }),
    );

    await expect(loadProjections({ feature_dir: dir, kinds: ["findings"] })).rejects.toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      reason: "projection_invalid",
      detail: { projection_kind: "findings", cause: "schema" },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// NO_SESSION paths — pre-`loaf start` situations that must NOT be classified as stale.
// ─────────────────────────────────────────────────────────────────────────

describe("loadProjections — NO_SESSION paths", () => {
  test("feature dir empty (no journal, no meta) → NO_SESSION", async () => {
    const dir = await tmpFeatureDir();

    await expect(loadProjections({ feature_dir: dir, kinds: ["state"] })).rejects.toMatchObject({
      code: "NO_SESSION",
    });
  });

  test("meta is the fresh empty sentinel (isEmptyMeta=true) + journal empty/absent → NO_SESSION", async () => {
    const dir = await tmpFeatureDir();
    await fs.mkdir(path.join(dir, "snapshots"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "snapshots", "_meta.json"),
      JSON.stringify(emptyMeta()),
    );

    await expect(loadProjections({ feature_dir: dir, kinds: ["state"] })).rejects.toMatchObject({
      code: "NO_SESSION",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Conditional empty — tasks.json absent with state.based_on.tasks===0 → valid empty.
// ─────────────────────────────────────────────────────────────────────────

describe("loadProjections — conditional empty", () => {
  test("tasks.json absent + state.based_on.tasks===0 → tasks: null (valid empty, not projection_missing)", async () => {
    // After `loaf start` (no `tasks submit`), state.based_on.tasks is 0 and
    // tasks.json is correctly absent (writer skips per writer:399-409).
    const dir = await tmpFeatureDir();
    await seedStarted(dir);
    // Sanity: tasks.json should not exist yet.
    await expect(fs.access(path.join(dir, "snapshots", "tasks.json"))).rejects.toBeTruthy();

    const result = await loadProjections({ feature_dir: dir, kinds: ["state", "tasks"] });
    expect(result.state).toMatchObject({ schema_version: 2 });
    expect(result.tasks).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Happy paths — each kind individually + the plural call.
// ─────────────────────────────────────────────────────────────────────────

describe("loadProjections — happy paths", () => {
  test("loadProjection('state') singular wrapper returns StateProjection", async () => {
    const dir = await tmpFeatureDir();
    await seedStarted(dir);
    const state = await loadProjection(dir, "state");
    expect(state).toMatchObject({
      schema_version: 2,
      phase: "TRIAGE",
      sub_state: "TRIAGE.score",
    });
  });

  test("loadProjections with all unconditional kinds (evidence/findings/pending) returns empty arrays after seed", async () => {
    const dir = await tmpFeatureDir();
    await seedStarted(dir);
    const result = await loadProjections({
      feature_dir: dir,
      kinds: ["evidence", "findings", "pending"],
    });
    expect(result.evidence).toMatchObject({ schema_version: 2, evidence: [] });
    expect(result.findings).toMatchObject({ schema_version: 2, findings: [] });
    expect(result.pending).toMatchObject({ schema_version: 2, pending: [] });
  });

  test("plural call requesting two kinds returns both with one fast-check transaction", async () => {
    const dir = await tmpFeatureDir();
    await seedStarted(dir);
    const result = await loadProjections({
      feature_dir: dir,
      kinds: ["state", "pending"],
    });
    expect(result.state).toMatchObject({ schema_version: 2 });
    expect(result.pending).toMatchObject({ schema_version: 2, pending: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// TOCTOU — mutator runs step 8 between pre-check and leaf read; second
// fast-check (M0-anchored) fires SnapshotStaleError.
// ─────────────────────────────────────────────────────────────────────────

describe("loadProjections — TOCTOU M0-anchored linearization guard (SC4)", () => {
  test("mutator extends journal between pre-check and leaf read → second-check fires SnapshotStaleError", async () => {
    // SC4 deterministic seam: the `afterFirstFastCheck` hook fires AFTER
    // Stage 2 (first fast-check vs M0) and BEFORE Stage 3 (leaf reads).
    // We use it to append a real journal entry — the second fast-check
    // (Stage 4) then compares cached M0 against a tail that has moved,
    // and must fire SNAPSHOT_STALE_REBUILD_REQUIRED with no payload.
    //
    // Acceptance per codex r178: this test MUST fail if the second
    // fast-check is disabled, and pass when it is in place. (See task
    // #17 manual probe.)
    const dir = await tmpFeatureDir();
    await seedStarted(dir);

    let hookCalls = 0;
    const journalPath = path.join(dir, "journal.jsonl");

    await expect(
      loadProjectionsWithHooks(
        { feature_dir: dir, kinds: ["state"] },
        {
          afterFirstFastCheck: async () => {
            hookCalls += 1;
            // Append a second entry directly to the journal — moves the tail
            // past M0's offset/hash without updating _meta.json. Mirrors
            // the race window where a concurrent mutator's journal append
            // landed but step 8 hasn't completed yet (or is the writer
            // updating meta last per the writer protocol).
            await appendEntry(
              journalPath,
              {
                seq: 1,
                entry_id: "JE-000002",
                at: "2026-05-15T10:00:01.000Z",
                actor: "cli:loaf",
                entry_schema_version: 1,
                kind: "event:phase_advanced",
                payload: { from: "TRIAGE.score", to: "TRIAGE.confirm" },
              },
              // Use a meta that matches the on-disk tail before this append,
              // computed from the seed. The appendEntry call doesn't need
              // a fresh meta as input here — it just needs prior meta that
              // matches; we fake by reading current _meta.json (still M0).
              JSON.parse(await fs.readFile(path.join(dir, "snapshots", "_meta.json"), "utf8")),
              { fsync: false },
            );
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      // The exact reason depends on which check fires; tail_offset_mismatch
      // is expected since the appended entry's tail offset != M0's claim.
      reason: expect.stringMatching(/^(tail_offset_mismatch|tail_hash_mismatch)$/),
    });
    expect(hookCalls).toBe(1);
  });
});
