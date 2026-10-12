import { afterEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { admitEntry } from "../../src/core/entry-admission.js";
import { initialSnapshot, type Snapshot } from "../../src/core/reducer.js";
import { mutateBatch } from "../../src/core/journal-mutate.js";
import { replayJournal } from "../../src/core/journal-bootstrap.js";
import { composeStateProjection } from "../../src/core/projection-writer.js";
import type { Ceremony, JournalEntry } from "../../src/core/journal-entry.js";

const ceremony: Ceremony = {
  spec_phase: false,
  verify_phase: true,
  settle_phase: true,
  strict_spec_review: false,
  lessons_required: "must",
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const deliver = {
  kind: "session:delivered" as const,
  actor: "human:tester",
  payload: {},
  entry_schema_version: 1,
  at: "2026-10-12T07:00:00.000Z",
};
const lesson = {
  kind: "lesson:recorded" as const,
  actor: "human:tester",
  entry_schema_version: 1,
  at: "2026-10-12T07:00:00.000Z",
  payload: {
    id: "LSN-001",
    iteration: 1,
    reason: "a useful session retrospective",
    summary: "A validated lesson",
  },
};
function entry(partial: typeof lesson | typeof deliver, seq = 1): JournalEntry {
  return { ...partial, seq, entry_id: `JE-${String(seq + 1).padStart(6, "0")}` };
}
function settled(required: Ceremony["lessons_required"] = "must", count = 0): Snapshot {
  return {
    ...initialSnapshot(),
    lesson_count: count,
    state: {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "lessons",
      phase: "SETTLE",
      sub_state: "SETTLE.lessons",
      iteration: 3,
      spec_version: 0,
      spec_locked: false,
      verify_accepted: true,
      ceremony: { ...ceremony, lessons_required: required },
    },
  };
}

async function context() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-required-lessons-"));
  roots.push(dir);
  // Admission fixture: legal cursor edges and approval flag, without a CLI gate-evaluation fixture.
  const entries: JournalEntry[] = [
    {
      seq: 0,
      entry_id: "JE-000001",
      at: "2026-10-12T07:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: {
        ceremony,
        ceremony_label: "custom-deep",
        workspace: "default",
        loaf_version_required: "^0.12.0",
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "lessons",
      },
    },
  ];
  let from = "TRIAGE.score";
  for (const to of [
    "TRIAGE.confirm",
    "EXECUTE.plan",
    "EXECUTE.work",
    "EXECUTE.done",
    "VERIFY.plan",
    "VERIFY.run",
    "VERIFY.accept",
  ]) {
    const seq = entries.length;
    entries.push({
      seq,
      entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
      at: "2026-10-12T07:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "event:phase_advanced",
      payload: { from, to },
    });
    from = to;
  }
  let seq = entries.length;
  entries.push({
    seq,
    entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
    at: "2026-10-12T07:00:00.000Z",
    actor: "human:tester",
    entry_schema_version: 1,
    kind: "gate:decided",
    payload: {
      gate_kind: "verify-accept",
      decision: "approved",
      reason: "fixture admission approval",
    },
  });
  seq = entries.length;
  entries.push({
    seq,
    entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
    at: "2026-10-12T07:00:00.000Z",
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind: "event:phase_advanced",
    payload: { from: "VERIFY.accept", to: "SETTLE.lessons" },
  });
  const journal = path.join(dir, "journal.jsonl");
  await fs.writeFile(journal, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const replay = await replayJournal(journal, { collect_entries: true });
  if (!replay.ok) throw new Error(JSON.stringify(replay));
  return {
    feature_dir: dir,
    snapshot: replay.snapshot,
    tail_seq: replay.meta.last_applied_seq,
    entries,
    meta: replay.meta,
    fsync: false,
    journal,
  };
}

describe("required session lessons", () => {
  test.each(["must", "may", "skip"] as const)("zero lessons under %s", (required) => {
    const result = admitEntry(settled(required), entry(deliver));
    if (required === "must")
      expect(result).toMatchObject({
        ok: false,
        code: "DELIVER_LESSONS_REQUIRED",
        detail: { lesson_count: 0, lessons_required: "must" },
      });
    else
      expect(result).toMatchObject({
        ok: true,
        snapshot: { state: { sub_state: "DONE.delivered" } },
      });
  });
  test("lesson from an earlier iteration counts, without becoming evidence or state.json data", () => {
    const snapshot = settled();
    const recorded = admitEntry(snapshot, entry(lesson));
    expect(recorded).toMatchObject({ ok: true, snapshot: { lesson_count: 1, evidence: [] } });
    const serialized = composeStateProjection(snapshot, [
      {
        seq: 0,
        entry_id: "JE-000001",
        at: lesson.at,
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          ceremony,
          ceremony_label: "deep",
          workspace: "default",
          loaf_version_required: "^0.12.0",
          session_id: snapshot.state!.session_id,
          feature: "lessons",
        },
      },
    ]);
    expect(serialized).not.toHaveProperty("lesson_count");
    expect(admitEntry(snapshot, entry(deliver, 2))).toMatchObject({ ok: true });
  });
  test("manual evidence does not count as a lesson", () => {
    const snapshot = settled();
    snapshot.evidence = [
      {
        id: "EV-000001",
        kind: "manual",
        actor: "human:tester",
        covers: [],
        reason: "human review retrospective",
        result: "passed",
      },
    ];
    expect(admitEntry(snapshot, entry(deliver))).toMatchObject({
      ok: false,
      code: "DELIVER_LESSONS_REQUIRED",
    });
  });
  test("invalid lesson does not increment the admitted count", () => {
    const snapshot = settled();
    const invalid = entry({ ...lesson, payload: { ...lesson.payload, reason: "short" } });
    expect(admitEntry(snapshot, invalid)).toMatchObject({ ok: false, code: "INVALID_PAYLOAD" });
    expect(snapshot.lesson_count).toBe(0);
  });
  test.each([
    false,
    true,
  ])("lesson before deliver is admitted in a batch (dry-run=%s)", async (dry_run) => {
    const ctx = await context();
    const before = await fs.readFile(ctx.journal);
    const result = await mutateBatch([lesson, deliver], { ...ctx, dryRun: dry_run });
    expect(result).toMatchObject({
      ok: true,
      snapshot: { lesson_count: 1, state: { sub_state: "DONE.delivered" } },
    });
    if (dry_run) expect(await fs.readFile(ctx.journal)).toEqual(before);
    else
      expect(await replayJournal(ctx.journal)).toMatchObject({
        ok: true,
        snapshot: { lesson_count: 1 },
      });
  });
  test("later lesson cannot justify an earlier delivery; whole batch stays unwritten", async () => {
    const ctx = await context();
    const before = await fs.readFile(ctx.journal);
    expect(await mutateBatch([deliver, lesson], ctx)).toMatchObject({
      ok: false,
      code: "DELIVER_LESSONS_REQUIRED",
      failed_index: 0,
      commit_state: "not-committed",
    });
    expect(await fs.readFile(ctx.journal)).toEqual(before);
  });
});
