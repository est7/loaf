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
      // v0.0.x legacy kind="test" exercises the migration normalization
      // path (test → local-check per docs/schemas.ts:741-749 +
      // ADR-0005:720). Restored from r34 fixture churn after r35 noted
      // the documented legacy values must round-trip.
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
      // - evidence.jsonl had 1 entry; legacy kind="test" normalized to
      //   "local-check" via LEGACY_EVIDENCE_KIND_MAP per docs §741-749 +
      //   ADR-0005:720 (codex r35 fix).
      expect(replay.snapshot.evidence).toHaveLength(1);
      expect(replay.snapshot.evidence[0]!.id).toBe("EV-000001");
      expect(replay.snapshot.evidence[0]!.kind).toBe("local-check");
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

  // Audit r3 — migration strict validation, not just strict JSON parse.
  // r4 update: migrateV2 now preflight-rehydrates before appending, so
  // migrateV2 ITSELF throws on invalid legacy artifacts (was: migrate
  // committed then rehydrate failed). Tests below verify migrateV2 fails
  // directly.
  test("migration rejects invalid sub_state in legacy state.json", async () => {
    const featureDir = await buildFixture();
    await fs.writeFile(
      path.join(featureDir, "state.json"),
      JSON.stringify({ sub_state: "NOT_A_REAL_PHASE", iteration: 1 }),
    );

    let caught: MigrationError | null = null;
    try {
      await migrateV2(featureDir, { fsync: false });
    } catch (err) {
      caught = err as MigrationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MIGRATION_INCOMPLETE");
    expect(caught!.message).toMatch(/sub_state/);
  });

  test("migration rejects tasks missing id field", async () => {
    const featureDir = await buildFixture();
    await fs.writeFile(
      path.join(featureDir, "tasks.json"),
      JSON.stringify({
        tasks: [
          { id: "T-001", status: "in_progress" },
          { kind: "structural", status: "pending" }, // no id
        ],
      }),
    );

    let caught: MigrationError | null = null;
    try {
      await migrateV2(featureDir, { fsync: false });
    } catch (err) {
      caught = err as MigrationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MIGRATION_INCOMPLETE");
  });

  test("migration rejects pending entries missing id or kind", async () => {
    const featureDir = await buildFixture();
    await fs.writeFile(
      path.join(featureDir, "pending.json"),
      JSON.stringify({ pending: [{ kind: "ask_user_question" /* no id */ }] }),
    );

    let caught: MigrationError | null = null;
    try {
      await migrateV2(featureDir, { fsync: false });
    } catch (err) {
      caught = err as MigrationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MIGRATION_INCOMPLETE");
  });

  // Audit r4 Blocker — migrateV2 must validate sidecars BEFORE appending
  // the migration entry + moving originals. Without preflight, migrateV2
  // returns success but the journal entry can't be replayed (silent commit
  // of broken upcaster output). The preflight calls rehydrateMigration
  // dry-run on staged sidecars; failure rolls back the sidecar dir.
  test("migrateV2 preflight rejects invalid state.json BEFORE appending journal", async () => {
    const featureDir = await buildFixture();
    await fs.writeFile(
      path.join(featureDir, "state.json"),
      JSON.stringify({ sub_state: "NOT_A_REAL_PHASE" }),
    );

    let caught: MigrationError | null = null;
    try {
      await migrateV2(featureDir, { fsync: false });
    } catch (err) {
      caught = err as MigrationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MIGRATION_INCOMPLETE");

    // Journal must NOT exist — preflight aborted before appendEntry.
    await expect(fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Originals must NOT have been moved to backup.
    expect(await fs.readdir(featureDir)).toEqual(
      expect.arrayContaining([
        "state.json", "tasks.json", "spec.md",
        "evidence.jsonl", "findings.jsonl", "pending.json",
      ]),
    );
    // Sidecar dir was rolled back.
    await expect(fs.access(path.join(featureDir, "attachments", "JE-000000"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("migrateV2 preflight rejects invalid runtime types (iteration string, status enum)", async () => {
    const featureDir = await buildFixture();
    // iteration as string — TS interface lied; runtime Zod must catch.
    await fs.writeFile(
      path.join(featureDir, "state.json"),
      JSON.stringify({ sub_state: "EXECUTE.work", iteration: "one" }),
    );

    let caught: MigrationError | null = null;
    try {
      await migrateV2(featureDir, { fsync: false });
    } catch (err) {
      caught = err as MigrationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MIGRATION_INCOMPLETE");
    expect(caught!.message).toMatch(/iteration/);
  });

  test("migrateV2 preflight rejects invalid task status enum", async () => {
    const featureDir = await buildFixture();
    await fs.writeFile(
      path.join(featureDir, "tasks.json"),
      JSON.stringify({ tasks: [{ id: "T-001", status: "nonsense_status" }] }),
    );

    let caught: MigrationError | null = null;
    try {
      await migrateV2(featureDir, { fsync: false });
    } catch (err) {
      caught = err as MigrationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MIGRATION_INCOMPLETE");
  });

  test("migrateV2 preflight rejects invalid pending.resolved type", async () => {
    const featureDir = await buildFixture();
    await fs.writeFile(
      path.join(featureDir, "pending.json"),
      JSON.stringify({ pending: [{ id: "PEND-1", kind: "ask_user_question", resolved: "yes" }] }),
    );

    let caught: MigrationError | null = null;
    try {
      await migrateV2(featureDir, { fsync: false });
    } catch (err) {
      caught = err as MigrationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MIGRATION_INCOMPLETE");
    expect(caught!.message).toMatch(/resolved/);
  });

  // Audit r5 High — evidence/findings JSONL runtime validation (Phase J
  // missed these two artifact types when adding Zod). Phase K adds
  // LegacyEvidenceSchema + LegacyFindingSchema and validates per-line.
  test("migration rejects evidence.jsonl line with invalid covers type (not array)", async () => {
    const featureDir = await buildFixture();
    await fs.writeFile(
      path.join(featureDir, "evidence.jsonl"),
      JSON.stringify({ id: "EV-1", kind: "test", covers: "not-an-array" }) + "\n",
    );

    let caught: MigrationError | null = null;
    try {
      await migrateV2(featureDir, { fsync: false });
    } catch (err) {
      caught = err as MigrationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MIGRATION_INCOMPLETE");
    expect(caught!.message).toMatch(/evidence/);
  });

  // Slice 1.C sub-cycle 1 r35: fail-loud goal preserved for non-documented
  // legacy values. Only documented v0.0.x kinds (test/review/visual/manual/
  // waiver/gate-decision) are mapped; anything else throws.
  test("migration rejects evidence.jsonl line with undocumented legacy kind", async () => {
    const featureDir = await buildFixture();
    await fs.writeFile(
      path.join(featureDir, "evidence.jsonl"),
      JSON.stringify({ id: "EV-000001", kind: "bogus_unknown_kind", result: "passed" }) + "\n",
    );

    let caught: MigrationError | null = null;
    try {
      await migrateV2(featureDir, { fsync: false });
    } catch (err) {
      caught = err as MigrationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MIGRATION_INCOMPLETE");
    expect(caught!.message).toMatch(/unknown kind/);
    expect(caught!.message).toMatch(/bogus_unknown_kind/);
  });

  test("migration rejects findings.jsonl line with invalid status enum", async () => {
    const featureDir = await buildFixture();
    await fs.writeFile(
      path.join(featureDir, "findings.jsonl"),
      JSON.stringify({
        id: "FND-1",
        category: "spec-gap",
        action: "amend-spec",
        status: "nonsense_status",
      }) + "\n",
    );

    let caught: MigrationError | null = null;
    try {
      await migrateV2(featureDir, { fsync: false });
    } catch (err) {
      caught = err as MigrationError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MIGRATION_INCOMPLETE");
    expect(caught!.message).toMatch(/findings/);
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
