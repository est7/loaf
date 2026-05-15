// Stage 5 — v0.0.x → v0.1.0 migration (ADR-0005 §5.2, Gate #3).
//
// Tests cover the happy roundtrip + Gate #3 schema rejection +
// MIGRATION_REPLAY_ATTEMPT + sidecar verification. Crash table 7-row
// coverage is partial: cases that surface as state errors (not mid-write
// SIGKILL) are exercised; true fault injection remains future work.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

import { migrateV2, verifyMigrationSidecars, MigrationError } from "../../src/core/migration.js";
import { replayJournal } from "../../src/core/journal-bootstrap.js";
import { MigrationSnapshotImportedPayload } from "../../src/core/journal-entry.js";

// ─────────────────────────────────────────────────────────────────────
// Synthetic v0.0.x fixture builder
// ─────────────────────────────────────────────────────────────────────

async function buildFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-v0fix-"));
  const featureDir = path.join(root, "auth-refresh");
  await fs.mkdir(featureDir, { recursive: true });

  // Minimal v0.0.x N-file artifacts. Content is illustrative — Stage 5 MVP
  // doesn't yet project these into the new snapshot tree (deferred to
  // per-projection writers in later stages); the test just verifies the
  // sidecar refs + sha256 round-trip cleanly.
  const files: Record<string, string> = {
    "state.json": JSON.stringify({
      phase: "EXECUTE",
      sub_state: "EXECUTE.work",
      iteration: 1,
      profile: "standard",
    }),
    "tasks.json": JSON.stringify({
      tasks: [
        { id: "T-001", kind: "behavioral", status: "in_progress" },
        { id: "T-002", kind: "structural", status: "pending" },
      ],
    }),
    "spec.md": "## REQ-AUTH-001\nWHEN user logs in, system shall issue a session token.\n",
    "evidence.jsonl":
      JSON.stringify({ id: "EV-000001", kind: "test", result: "passed" }) + "\n",
    "findings.jsonl":
      JSON.stringify({ id: "FND-001", category: "spec-gap", action: "amend-spec" }) + "\n",
    "pending.json": JSON.stringify({ pending: [] }),
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(featureDir, name), body);
  }
  return featureDir;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("migrateV2 — Stage 5 §5.2", () => {
  test("happy roundtrip: fixture → migration entry → replay → sidecars verified", async () => {
    const featureDir = await buildFixture();

    const result = await migrateV2(featureDir, {
      migrated_at: "2026-05-15T12:00:00.000Z",
      fsync: false,
    });

    // Sanity: journal exists with single entry seq=0 + entry_id=JE-000000.
    const journal = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
    const lines = journal.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.kind).toBe("migration:snapshot_imported");
    expect(parsed.entry_id).toBe("JE-000000");
    expect(parsed.seq).toBe(0);
    expect(parsed.actor).toBe("migration:v0.0.x→v2");

    // Payload is Gate-#3-compliant (only AttachmentRef manifest).
    const payloadCheck = MigrationSnapshotImportedPayload.safeParse(parsed.payload);
    expect(payloadCheck.success).toBe(true);

    // Sidecars exist + sha256 matches.
    await verifyMigrationSidecars(featureDir, parsed);

    // Backup directory has original v0.0.x files.
    expect(await fs.readdir(result.backup_dir)).toEqual(
      expect.arrayContaining([
        "state.json", "tasks.json", "spec.md",
        "evidence.jsonl", "findings.jsonl", "pending.json",
      ]),
    );
    // Original featureDir no longer has those at top level (moved to backup).
    await expect(fs.access(path.join(featureDir, "state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    // Replay journal with feature_dir → migration rehydrates projection
    // from sidecars (audit r1 Blocker #6 fix).
    const replay = await replayJournal(
      path.join(featureDir, "journal.jsonl"),
      { feature_dir: featureDir },
    );
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.entries_applied).toBe(1);
      expect(replay.meta.last_applied_seq).toBe(0);
      // Verify projection rehydrated from sidecars:
      // - tasks.json had 2 tasks
      expect(replay.snapshot.tasks).toHaveLength(2);
      expect(replay.snapshot.tasks[0]!.id).toBe("T-001");
      expect(replay.snapshot.tasks[0]!.status).toBe("in_progress");
      // - evidence.jsonl had 1 entry
      expect(replay.snapshot.evidence).toHaveLength(1);
      expect(replay.snapshot.evidence[0]!.id).toBe("EV-000001");
      // - findings.jsonl had 1 entry
      expect(replay.snapshot.findings).toHaveLength(1);
      expect(replay.snapshot.findings[0]!.id).toBe("FND-001");
      // - state.json sub_state="EXECUTE.work" rehydrated
      expect(replay.snapshot.state?.sub_state).toBe("EXECUTE.work");
    }
  });

  test("Gate #3: payload with inline artifact body is rejected at Zod parse", async () => {
    const malformed = {
      source_schema_version: 1,
      migrated_at: "2026-05-15T12:00:00.000Z",
      artifacts: {
        // Strict schema requires AttachmentRef object; inline string MUST fail.
        state: "literal-inline-content-not-a-ref",
        tasks: { path: "x", sha256: "0".repeat(64), size: 0 },
        spec_md: { path: "x", sha256: "0".repeat(64), size: 0 },
        evidence: { path: "x", sha256: "0".repeat(64), size: 0 },
        findings: { path: "x", sha256: "0".repeat(64), size: 0 },
        pending: { path: "x", sha256: "0".repeat(64), size: 0 },
      },
    };
    const parsed = MigrationSnapshotImportedPayload.safeParse(malformed);
    expect(parsed.success).toBe(false);
  });

  test("MIGRATION_REPLAY_ATTEMPT: journal already has entries → rejected", async () => {
    const featureDir = await buildFixture();
    await migrateV2(featureDir, { fsync: false });

    // Second invocation must refuse.
    const secondFixture = await buildFixture();
    // Plant a fake journal in the secondFixture to force the precondition.
    await fs.writeFile(path.join(secondFixture, "journal.jsonl"), '{"fake":"line"}\n');

    let caught: MigrationError | null = null;
    try {
      await migrateV2(secondFixture, { fsync: false });
    } catch (err) {
      caught = err as MigrationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MIGRATION_REPLAY_ATTEMPT");
  });

  test("MIGRATION_BACKUP_MISSING: backup target already exists → rejected", async () => {
    const featureDir = await buildFixture();
    const explicitBackup = `${featureDir}.backup-v1`;
    await fs.mkdir(explicitBackup);

    let caught: MigrationError | null = null;
    try {
      await migrateV2(featureDir, { backup_dir: explicitBackup, fsync: false });
    } catch (err) {
      caught = err as MigrationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MIGRATION_BACKUP_MISSING");
  });

  test("MIGRATION_SIDECAR_MISSING: missing v0.0.x artifact is reported", async () => {
    const featureDir = await buildFixture();
    await fs.unlink(path.join(featureDir, "pending.json"));

    let caught: MigrationError | null = null;
    try {
      await migrateV2(featureDir, { fsync: false });
    } catch (err) {
      caught = err as MigrationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MIGRATION_SIDECAR_MISSING");
  });

  test("verifyMigrationSidecars detects post-migration tampering", async () => {
    const featureDir = await buildFixture();
    const { entry } = await migrateV2(featureDir, { fsync: false });

    // Tamper with a sidecar after migration.
    const target = path.join(featureDir, "attachments", "JE-000000", "migration", "spec.md");
    await fs.writeFile(target, "tampered content");

    let caught: MigrationError | null = null;
    try {
      await verifyMigrationSidecars(featureDir, entry);
    } catch (err) {
      caught = err as MigrationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MIGRATION_INCOMPLETE");
  });

  test("AttachmentRef.sha256 matches on-disk file content", async () => {
    const featureDir = await buildFixture();
    const { attachments } = await migrateV2(featureDir, { fsync: false });

    for (const ref of Object.values(attachments)) {
      const body = await fs.readFile(path.join(featureDir, ref.path));
      const actual = createHash("sha256").update(body).digest("hex");
      expect(actual).toBe(ref.sha256);
      expect(body.length).toBe(ref.size);
    }
  });
});
