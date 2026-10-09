import { admitEntry } from "../../src/core/entry-admission.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initialSnapshot, type Snapshot } from "../../src/core/reducer.js";
import { mutateBatch, type MutateContext } from "../../src/core/journal-mutate.js";
import { preflight } from "../../src/core/reducer/preflight.js";
import * as sidecar from "../../src/core/sidecar.js";
import { emptyMeta } from "../../src/core/snapshot.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";

const ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip" as const,
  strict_drift_check: false,
};
function snapshot(started: boolean): Snapshot {
  return {
    ...initialSnapshot(),
    state: started
      ? {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "admission",
          phase: "TRIAGE",
          sub_state: "TRIAGE.score",
          iteration: 1,
          spec_locked: false,
          verify_accepted: false,
          spec_version: 0,
          ceremony,
        }
      : null,
  };
}
function entry(bootstrap: boolean, passes: boolean): JournalEntry {
  return {
    seq: 0,
    entry_id: "JE-000001",
    at: "2026-05-15T10:00:00.000Z",
    actor: passes ? "cli:loaf" : "migration:test",
    entry_schema_version: 1,
    kind: bootstrap ? "session:started" : "pending:added",
    payload: bootstrap
      ? {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "admission",
          ceremony,
        }
      : { id: "PEND-0001", kind: "ask_user_question", question: "Choose?" },
  };
}
// D1 deliberately changes four caller rows from the green pre-refactor baseline:
// Pass 1 non-bootstrap/null/fail: ACTOR_AUTHORITY_VIOLATION -> NO_SESSION.
// Pass 3 non-bootstrap/null/fail: ACTOR_AUTHORITY_VIOLATION -> NO_SESSION.
// Pass 3 bootstrap/null/fail: OK -> ACTOR_AUTHORITY_VIOLATION.
// Pass 3 bootstrap/set/fail: ALREADY_STARTED -> ACTOR_AUTHORITY_VIOLATION.
const rows = [
  { bootstrap: true, started: false, passes: true, mutation: "OK", final: "OK", replay: "OK" },
  {
    bootstrap: true,
    started: false,
    passes: false,
    mutation: "ACTOR_AUTHORITY_VIOLATION",
    final: "ACTOR_AUTHORITY_VIOLATION",
    replay: "OK",
  },
  {
    bootstrap: true,
    started: true,
    passes: true,
    mutation: "ALREADY_STARTED",
    final: "ALREADY_STARTED",
    replay: "ALREADY_STARTED",
  },
  {
    bootstrap: true,
    started: true,
    passes: false,
    mutation: "ACTOR_AUTHORITY_VIOLATION",
    final: "ACTOR_AUTHORITY_VIOLATION",
    replay: "ALREADY_STARTED",
  },
  {
    bootstrap: false,
    started: false,
    passes: true,
    mutation: "NO_SESSION",
    final: "NO_SESSION",
    replay: "NO_SESSION",
  },
  {
    bootstrap: false,
    started: false,
    passes: false,
    mutation: "NO_SESSION",
    final: "NO_SESSION",
    replay: "NO_SESSION",
  },
  { bootstrap: false, started: true, passes: true, mutation: "OK", final: "OK", replay: "OK" },
  {
    bootstrap: false,
    started: true,
    passes: false,
    mutation: "ACTOR_AUTHORITY_VIOLATION",
    final: "ACTOR_AUTHORITY_VIOLATION",
    replay: "ACTOR_AUTHORITY_VIOLATION",
  },
];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
function partial(e: JournalEntry) {
  const { seq: _seq, entry_id: _id, ...rest } = e;
  return rest;
}
async function context(started: boolean, dryRun: boolean): Promise<MutateContext> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-admission-"));
  dirs.push(dir);
  const ctx: MutateContext = {
    feature_dir: dir,
    snapshot: snapshot(started),
    tail_seq: -1,
    entries: [],
    meta: emptyMeta(),
    fsync: false,
    dryRun,
  };
  if (started && !dryRun) {
    const seeded = await mutateBatch([partial(entry(true, true))], {
      ...ctx,
      snapshot: initialSnapshot(),
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded));
    ctx.tail_seq = 0;
    ctx.entries = seeded.entries;
    ctx.meta = seeded.meta;
  }
  return ctx;
}
describe("entry admission characterization — real callers", () => {
  for (const row of rows) {
    const label = `bootstrap=${row.bootstrap} state=${row.started ? "set" : "null"} preflight=${row.passes ? "pass" : "fail"}`;
    test(`mutation Pass 1: ${label}`, async () => {
      const ctx = await context(row.started, true);
      const e = entry(row.bootstrap, row.passes);
      expect(preflight(e, { snapshot: ctx.snapshot, tail_seq: -1 }).ok).toBe(row.passes);
      const result = await mutateBatch([partial(e)], ctx);
      if (row.mutation === "OK") {
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (result.ok) expect(result.snapshot.state?.feature).toBe("admission");
      } else {
        expect(result).toMatchObject(
          row.mutation === "ALREADY_STARTED" || row.mutation === "NO_SESSION"
            ? { ok: false, code: "REDUCER_ERROR", detail: { code: row.mutation } }
            : { ok: false, code: row.mutation },
        );
      }
    });
    test(`mutation Pass 3: ${label}`, async () => {
      // Pass 1 cannot admit invalid/null-session rows. Inject only at the
      // sidecar boundary to expose the real final-validation path independently.
      const ctx = await context(!row.bootstrap, false);
      const promoted = entry(row.bootstrap, row.passes);
      vi.spyOn(sidecar, "promoteSidecars").mockImplementationOnce(async (candidate) => {
        ctx.snapshot = snapshot(row.started);
        return { ...candidate, actor: promoted.actor };
      });
      const result = await mutateBatch([partial(entry(row.bootstrap, true))], ctx);
      if (row.final === "OK") {
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (result.ok) expect(result.snapshot.state?.feature).toBe("admission");
      } else {
        expect(result).toMatchObject({
          ok: false,
          code: "REDUCER_ERROR",
          detail: { code: row.final },
        });
        if (row.bootstrap) {
          await expect(
            fs.readFile(path.join(ctx.feature_dir, "journal.jsonl"), "utf8"),
          ).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          const lines = (await fs.readFile(path.join(ctx.feature_dir, "journal.jsonl"), "utf8"))
            .trim()
            .split("\n");
          expect(lines).toHaveLength(1);
          expect(JSON.parse(lines[0]!).kind).toBe("session:started");
        }
      }
    });
    test(`replay: ${label}`, () => {
      const prev = snapshot(row.started);
      const e = entry(row.bootstrap, row.passes);
      expect(preflight(e, { snapshot: prev }).ok).toBe(row.passes);
      const result = admitEntry(prev, e, { kind: "replay" });
      if (row.replay === "OK") {
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (result.ok) expect(result.snapshot.state?.feature).toBe("admission");
      } else expect(result).toMatchObject({ ok: false, code: row.replay });
    });
  }
});
