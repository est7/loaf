// Phase 14 SC2 — `loaf doctor --rebuild` CLI end-to-end tests.
//
// Exercises the CLI layer over the SC1 projection serializer: exit codes
// (0 rebuilt / 1 rebuild-cannot-complete / 2 usage), the `rebuilt` output
// contract (lists only files actually written — no tasks.json without a
// plan), --json mode, the bare-doctor guard, the migrated-journal guard,
// and the unreplayable-journal path (codex r160).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import { appendEntry } from "../../src/core/journal-append.js";
import { mutateBatch } from "../../src/core/journal-mutate.js";
import { apply, initialSnapshot, type Snapshot } from "../../src/core/reducer.js";
import type { Ceremony, JournalEntry } from "../../src/core/journal-entry.js";
import { emptyMeta, SnapshotMeta } from "../../src/core/snapshot.js";
import { migrateV2 } from "../../src/core/migration.js";

const STANDARD: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

/** Capture stdout/stderr around a `main(argv)` call. Serial — patches the
 *  process write streams globally (F-011); this file's tests are not
 *  marked concurrent. */
async function runCli(argv: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    outChunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    errChunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await main(["node", "loaf", ...argv]);
    return { exit, stdout: outChunks.join(""), stderr: errChunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

async function tmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-doctor-rebuild-"));
}

const JOURNAL_DERIVED_PROJECTIONS = [
  { name: "state.json", path: ["snapshots", "state.json"] },
  { name: "tasks.json", path: ["snapshots", "tasks.json"] },
  { name: "evidence.json", path: ["snapshots", "evidence.json"] },
  { name: "findings.json", path: ["snapshots", "findings.json"] },
  { name: "pending.json", path: ["snapshots", "pending.json"] },
  { name: "lessons.md", path: ["lessons.md"] },
  { name: "_meta.json", path: ["snapshots", "_meta.json"] },
] as const;

async function readProjectionBytes(dir: string): Promise<Map<string, Buffer>> {
  return new Map(
    await Promise.all(
      JOURNAL_DERIVED_PROJECTIONS.map(async (projection) => [
        projection.name,
        await fs.readFile(path.join(dir, ...projection.path)),
      ] as const),
    ),
  );
}

function projectionByteMismatches(
  expected: ReadonlyMap<string, Buffer>,
  actual: ReadonlyMap<string, Buffer>,
): string[] {
  return JOURNAL_DERIVED_PROJECTIONS.map(
    (projection) => projection.name,
  ).filter(
    (name) => name !== "_meta.json",
  ).filter(
    (name) => !expected.get(name)?.equals(actual.get(name) ?? Buffer.alloc(0)),
  );
}

function parseMeta(bytes: Buffer): SnapshotMeta {
  return SnapshotMeta.parse(JSON.parse(bytes.toString("utf8")));
}

function stableMeta(meta: SnapshotMeta): Omit<SnapshotMeta, "written_at"> {
  const { written_at: _writtenAt, ...stable } = meta;
  return stable;
}

/** A minimal valid behavioral task body for an event:tasks_planned payload. */
function behavioralTask(): Record<string, unknown> {
  return {
    id: "T-001",
    kind: "behavioral",
    drives: ["REQ-AUTH-001"],
    tests: ["TokenCoord.refreshOnce"],
    status: "pending",
    depends_on: [],
    labels: [],
    execution: {
      red: { applicability: "must", status: "pending", evidence_refs: [] },
      implement: { applicability: "must", status: "pending", evidence_refs: [] },
      refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
    },
  };
}

/**
 * Seed a real journal.jsonl under `dir` via the production mutation path.
 * With a plan, the fixture reaches EXECUTE.work and produces every projection
 * rebuilt by doctor, including non-empty evidence/finding/pending ledgers,
 * a sidecar-backed evidence summary, and the top-level lessons.md projection.
 */
async function seedJournal(dir: string, opts: { withPlan: boolean }): Promise<void> {
  let snapshot: Snapshot = initialSnapshot();
  let tail = -1;
  let entries: JournalEntry[] = [];
  let meta = emptyMeta();
  async function step(partials: Parameters<typeof mutateBatch>[0]): Promise<void> {
    const r = await mutateBatch(partials, {
      feature_dir: dir,
      snapshot,
      tail_seq: tail,
      entries,
      meta,
      fsync: false,
    });
    if (!r.ok) throw new Error(`seed step failed: ${r.code} ${r.message}`);
    snapshot = r.snapshot;
    tail += partials.length;
    entries = entries.concat(r.entries);
    meta = r.meta;
  }

  await step([
    {
      at: "2026-05-21T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "auth-refresh",
        ceremony: STANDARD,
      },
    },
  ]);

  const walk: Array<[string, string]> = [
    ["TRIAGE.score", "TRIAGE.confirm"],
    ["TRIAGE.confirm", "SPEC.proposal"],
    ["SPEC.proposal", "SPEC.spec"],
    ["SPEC.spec", "SPEC.plan"],
    ["SPEC.plan", "SPEC.design"],
  ];
  for (const [from, to] of walk) {
    await step([
      {
        at: "2026-05-21T10:00:01.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from, to } as unknown as Record<string, unknown>,
      },
    ]);
  }

  await step([
    {
      at: "2026-05-21T10:00:02.000Z",
      actor: "human:tester@example.invalid",
      entry_schema_version: 1,
      kind: "event:spec_submitted",
      payload: {
        spec_version: 1,
        feature: { id: "F-001", name: "OAuth access token refresh" },
        intent: "users should not perceive auth recovery flows in flight",
        adr_refs: [],
        needs_clarification: [],
      },
    },
  ]);

  if (opts.withPlan) {
    await step([
      {
        at: "2026-05-21T10:00:03.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:tasks_planned",
        payload: { based_on: { spec: 1 }, tasks: [behavioralTask()] },
      },
    ]);

    const journalPath = path.join(dir, "journal.jsonl");
    const gateSeq = tail + 1;
    const gateEntry: JournalEntry = {
      seq: gateSeq,
      entry_id: `JE-${String(gateSeq + 1).padStart(6, "0")}`,
      at: "2026-05-21T10:00:03.500Z",
      actor: "human:tester@example.invalid",
      entry_schema_version: 1,
      kind: "gate:decided",
      payload: {
        gate_kind: "spec-lock",
        decision: "approved",
        reason: "representative rebuild-equivalence fixture",
      },
    };
    meta = await appendEntry(journalPath, gateEntry, meta, { fsync: false });
    const gateApplied = apply(snapshot, gateEntry);
    if (!gateApplied.ok) throw new Error(`gate apply failed: ${gateApplied.code}`);
    snapshot = gateApplied.snapshot;
    tail = gateSeq;
    entries = entries.concat(gateEntry);

    for (const [from, to] of [
      ["SPEC.design", "EXECUTE.plan"],
      ["EXECUTE.plan", "EXECUTE.work"],
    ] as Array<[string, string]>) {
      await step([
        {
          at: "2026-05-21T10:00:04.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from, to },
        },
      ]);
    }

    await step([
      {
        at: "2026-05-21T10:00:05.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "evidence:added",
        payload: {
          id: "EV-000001",
          kind: "local-check",
          iteration: 1,
          actor: "cli:loaf",
          result: "passed",
          summary: { mode: "inline", text: "sidecar-backed check ".repeat(600) },
          covers: [],
        },
      },
      {
        at: "2026-05-21T10:00:06.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "finding:raised",
        payload: {
          id: "FND-001",
          category: "spec-gap",
          action: "defer",
          summary: "edge case not covered by current scope",
        },
      },
      {
        at: "2026-05-21T10:00:07.000Z",
        actor: "human:tester@example.invalid",
        entry_schema_version: 1,
        kind: "pending:added",
        payload: {
          id: "PEND-0001",
          kind: "ask_user_question",
          question: "should the retry budget be configurable?",
        },
      },
      {
        at: "2026-05-21T10:00:08.000Z",
        actor: "human:tester@example.invalid",
        entry_schema_version: 1,
        kind: "lesson:recorded",
        payload: {
          id: "LSN-001",
          iteration: 1,
          reason: "captured during rebuild equivalence testing",
          summary: "the replay path must preserve user-facing lesson projections",
        },
      },
    ]);
  }
}

/** A minimal v0.0.x feature dir — input for `migrateV2` (mirrors
 *  v0.0.x-migration.test.ts buildFixture). */
async function buildV0Fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-doctor-v0-"));
  const featureDir = path.join(root, "auth-refresh");
  await fs.mkdir(featureDir, { recursive: true });
  const files: Record<string, string> = {
    "state.json": JSON.stringify({
      phase: "EXECUTE",
      sub_state: "EXECUTE.work",
      iteration: 1,
      profile: "standard",
    }),
    "tasks.json": JSON.stringify({
      tasks: [{ id: "T-001", kind: "behavioral", status: "in_progress" }],
    }),
    "spec.md": "## REQ-AUTH-001\nWHEN user logs in, system shall issue a session token.\n",
    "evidence.jsonl": JSON.stringify({ id: "EV-000001", kind: "test", result: "passed" }) + "\n",
    "findings.jsonl":
      JSON.stringify({ id: "FND-001", category: "spec-gap", action: "amend-spec" }) + "\n",
    "pending.json": JSON.stringify({ pending: [] }),
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(featureDir, name), body);
  }
  return featureDir;
}

describe("loaf doctor --rebuild — Phase 14 SC2", () => {
  test("rebuilds the journal-derived projections + _meta.json (exit 0)", async () => {
    const dir = await tmpDir();
    try {
      await seedJournal(dir, { withPlan: false });
      const r = await runCli([
        "doctor",
        "--rebuild",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
      ]);
      expect(r.exit).toBe(0);
      expect(r.stderr).toContain("doctor rebuild: rebuilt");
      const snapDir = path.join(dir, "snapshots");
      for (const f of [
        "state.json",
        "evidence.json",
        "findings.json",
        "pending.json",
        "_meta.json",
      ]) {
        expect((await fs.stat(path.join(snapDir, f))).isFile()).toBe(true);
      }
      expect(r.stdout).toContain("# snapshot as-of seq=");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("--json success: stdout shape, stderr empty, rebuilt omits tasks.json with no plan", async () => {
    const dir = await tmpDir();
    try {
      await seedJournal(dir, { withPlan: false });
      const r = await runCli([
        "doctor",
        "--rebuild",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
        "--format",
        "json",
      ]);
      expect(r.exit).toBe(0);
      expect(r.stderr).toContain("doctor rebuild: rebuilt");
      const out = JSON.parse(r.stdout);
      expect(out.ok).toBe(true);
      expect(out.feature).toBe("auth-refresh");
      expect(typeof out.tail_seq).toBe("number");
      expect(out.rebuilt).toEqual([
        "state.json",
        "evidence.json",
        "findings.json",
        "pending.json",
        "_meta.json",
      ]);
      expect(out.rebuilt).not.toContain("tasks.json");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("with a task plan, rebuilt includes tasks.json and the file is written", async () => {
    const dir = await tmpDir();
    try {
      await seedJournal(dir, { withPlan: true });
      const r = await runCli([
        "doctor",
        "--rebuild",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
        "--format",
        "json",
      ]);
      expect(r.exit).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.rebuilt).toContain("tasks.json");
      expect((await fs.stat(path.join(dir, "snapshots", "tasks.json"))).isFile()).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("normal mutation and doctor replay produce byte-identical projections", async () => {
    const dir = await tmpDir();
    try {
      await seedJournal(dir, { withPlan: true });
      const mutationBytes = await readProjectionBytes(dir);
      expect(
        JSON.parse(mutationBytes.get("evidence.json")!.toString("utf8")).evidence,
      ).toHaveLength(1);
      expect(
        JSON.parse(mutationBytes.get("findings.json")!.toString("utf8")).findings,
      ).toHaveLength(1);
      expect(
        JSON.parse(mutationBytes.get("pending.json")!.toString("utf8")).pending,
      ).toHaveLength(1);
      expect(mutationBytes.get("lessons.md")!.toString("utf8")).toContain(
        "the replay path must preserve user-facing lesson projections",
      );
      const journalEntries = (await fs.readFile(path.join(dir, "journal.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as JournalEntry);
      const evidenceEntry = journalEntries.find((entry) => entry.kind === "evidence:added");
      const summary = (evidenceEntry?.payload as { summary?: unknown } | undefined)?.summary as
        | { mode: "sidecar"; ref: { path: string } }
        | undefined;
      expect(summary?.mode).toBe("sidecar");
      expect(
        (
          await fs.stat(path.join(dir, summary!.ref.path))
        ).isFile(),
      ).toBe(true);

      // Negative control: alter a journal fact, rebuild through the real doctor
      // publication path, and prove the comparator detects the resulting
      // semantic projection drift. Restore the journal before the real proof.
      const journalPath = path.join(dir, "journal.jsonl");
      const originalJournal = await fs.readFile(journalPath);
      const driftedJournal = originalJournal
        .toString("utf8")
        .replace(
          "edge case not covered by current scope",
          "edge case intentionally changed for drift",
        );
      expect(driftedJournal).not.toBe(originalJournal.toString("utf8"));
      await fs.writeFile(journalPath, driftedJournal);
      for (const projection of JOURNAL_DERIVED_PROJECTIONS) {
        await fs.rm(path.join(dir, ...projection.path), { force: true });
      }
      const drifted = await runCli([
        "doctor",
        "--rebuild",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
        "--format",
        "json",
      ]);
      expect(drifted.exit).toBe(0);
      expect(
        projectionByteMismatches(mutationBytes, await readProjectionBytes(dir)),
      ).toEqual(["findings.json"]);
      await fs.writeFile(journalPath, originalJournal);

      for (const projection of JOURNAL_DERIVED_PROJECTIONS) {
        await fs.rm(path.join(dir, ...projection.path), { force: true });
      }
      const rebuilt = await runCli([
        "doctor",
        "--rebuild",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
        "--format",
        "json",
      ]);
      expect(rebuilt.exit).toBe(0);
      const rebuiltBytes = await readProjectionBytes(dir);
      expect(projectionByteMismatches(mutationBytes, rebuiltBytes)).toEqual([]);
      const mutationMeta = parseMeta(mutationBytes.get("_meta.json")!);
      const rebuiltMeta = parseMeta(rebuiltBytes.get("_meta.json")!);
      expect(stableMeta(rebuiltMeta)).toEqual(stableMeta(mutationMeta));
      expect(Date.parse(rebuiltMeta.written_at)).toBeGreaterThanOrEqual(
        Date.parse(mutationMeta.written_at),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("rebuilds state.json — 5/5 projections, journal-derived StateProjection", async () => {
    const dir = await tmpDir();
    try {
      await seedJournal(dir, { withPlan: true });
      const r = await runCli([
        "doctor",
        "--rebuild",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
        "--format",
        "json",
      ]);
      expect(r.exit).toBe(0);
      const out = JSON.parse(r.stdout);
      // state.json leads the rebuilt list; _meta.json trails after all data
      // projections, including the top-level lessons.md leaf.
      expect(out.rebuilt).toEqual([
        "state.json",
        "tasks.json",
        "evidence.json",
        "findings.json",
        "pending.json",
        "lessons.md",
        "_meta.json",
      ]);
      const state = JSON.parse(
        await fs.readFile(path.join(dir, "snapshots", "state.json"), "utf8"),
      );
      expect(state.session_id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(state.phase).toBe("EXECUTE");
      expect(state.sub_state).toBe("EXECUTE.work");
      expect(state.based_on).toEqual({ spec: 1, tasks: 1 });
      // seedJournal's hand-rolled session:started predates the SC1 widening
      // — the documented legacy fallback applies.
      expect(state.session_label).toBeNull();
      expect(state.loaf_version_required).toBeNull();
      expect(state.workspace).toBe("default");
      expect(state.ceremony_label).toBe("");
      // complexity_score has no journal source — always null (F-019).
      expect(state.complexity_score).toBeNull();
      // D-bucket machine-local fields never appear in the projection.
      expect(state).not.toHaveProperty("cwd");
      expect(state).not.toHaveProperty("debug");
      expect(state).not.toHaveProperty("heartbeat_at");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("a session started with --label / --workspace projects them into state.json", async () => {
    const dir = await tmpDir();
    try {
      const s = await runCli([
        "start",
        "auth-refresh",
        "--feature-dir",
        dir,
        "--ceremony",
        "standard",
        "--label",
        "OAuth refresh",
        "--workspace",
        "team-a",
      ]);
      expect(s.exit).toBe(0);
      const r = await runCli([
        "doctor",
        "--rebuild",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
        "--format",
        "json",
      ]);
      expect(r.exit).toBe(0);
      const state = JSON.parse(
        await fs.readFile(path.join(dir, "snapshots", "state.json"), "utf8"),
      );
      expect(state.session_label).toBe("OAuth refresh");
      expect(state.workspace).toBe("team-a");
      expect(state.ceremony_label).toBe("standard");
      // Matches both pre-RC pins (`^0.1.0`) and RC/build-suffixed pins
      // (`^0.1.0-rc.1`) — mirror of the widened schema regex (codex r182).
      expect(state.loaf_version_required).toMatch(
        /^\^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("re-run is idempotent — exit 0 both times", async () => {
    const dir = await tmpDir();
    try {
      await seedJournal(dir, { withPlan: true });
      const argv = ["doctor", "--rebuild", "--feature", "auth-refresh", "--feature-dir", dir];
      const first = await runCli(argv);
      const second = await runCli(argv);
      expect(first.exit).toBe(0);
      expect(second.exit).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("bare `loaf doctor` (literal, no args) fails closed — exit 2 DOCTOR_MODE_NOT_IMPLEMENTED", async () => {
    // Mode is checked before --feature: a literal bare command must
    // surface the mode error, not Commander's missing-feature error
    // (codex r161 — --feature is an .option, not .requiredOption).
    const r = await runCli(["doctor"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("DOCTOR_MODE_NOT_IMPLEMENTED");
    expect(r.stdout).toBe("");
  });

  test("`loaf doctor --feature X` without --rebuild fails closed — exit 2 DOCTOR_MODE_NOT_IMPLEMENTED", async () => {
    const r = await runCli(["doctor", "--feature", "auth-refresh"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("DOCTOR_MODE_NOT_IMPLEMENTED");
    expect(r.stdout).toBe("");
  });

  test("a v0.0.x-migrated journal is rejected cleanly — exit 2, no fresh _meta.json", async () => {
    // Phase 16 SC-2 PATCH A: DOCTOR_REBUILD_MIGRATED_UNSUPPORTED is a SC-1
    // catalogued code with exit_code: 2 (src/core/error-catalog.ts). The
    // pre-SC-2 failRebuild() path emitted exit 1 here, which contradicted
    // the catalog and the protocol §10.9 contract (exit 1 reserved for
    // unexpected internal errors + crash log). SC-2 normalizes the helper
    // through emitFailure() so catalog ⇔ runtime exit_code agree.
    const featureDir = await buildV0Fixture();
    try {
      await migrateV2(featureDir, {
        migrated_at: "2026-05-15T12:00:00.000Z",
        fsync: false,
      });
      const r = await runCli([
        "doctor",
        "--rebuild",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        featureDir,
      ]);
      expect(r.exit).toBe(2);
      expect(r.stderr).toContain("DOCTOR_REBUILD_MIGRATED_UNSUPPORTED");
      // The guard fires before writeProjections — nothing materialized.
      await expect(fs.stat(path.join(featureDir, "snapshots", "_meta.json"))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    } finally {
      await fs.rm(path.dirname(featureDir), { recursive: true, force: true });
    }
  });

  test("an unreplayable journal fails cleanly — exit 2, no fresh _meta.json", async () => {
    // Phase 16 SC-2 PATCH A: same normalization as DOCTOR_REBUILD_MIGRATED_UNSUPPORTED.
    // replayJournal's failure surface (INVALID_ENVELOPE etc.) is catalogued
    // at exit 2; failRebuild() previously masked it as exit 1.
    const dir = await tmpDir();
    try {
      // Envelope-invalid line — replayJournal returns INVALID_ENTRY.
      await fs.writeFile(path.join(dir, "journal.jsonl"), '{"not":"a journal entry"}\n', "utf8");
      const r = await runCli([
        "doctor",
        "--rebuild",
        "--feature",
        "auth-refresh",
        "--feature-dir",
        dir,
      ]);
      expect(r.exit).toBe(2);
      expect(r.stderr).toContain("cannot be replayed");
      await expect(fs.stat(path.join(dir, "snapshots", "_meta.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("`doctor --rebuild` without --feature is a usage error — exit 2 DOCTOR_FEATURE_REQUIRED", async () => {
    const r = await runCli(["doctor", "--rebuild"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("DOCTOR_FEATURE_REQUIRED");
  });

  test("malformed feature lease fails closed before projection rebuild", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, ".lock"), "{malformed");
    const r = await runCli([
      "doctor",
      "--rebuild",
      "--feature",
      "auth-refresh",
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("LOCK_INVALID");
    await expect(fs.readFile(path.join(dir, ".lock"), "utf8")).resolves.toBe("{malformed");
  });
});
