// Phase v0.1.1 / F-024 — lessons.md projection unit tests.
//
// The load-bearing case is the lesson SELECTOR (codex F-024 r2): only
// `loaf lessons add` output is a lesson; `loaf evidence add --kind manual`
// verification evidence (covers / task_id / check / gate) must be EXCLUDED.

import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

import {
  isLesson,
  selectLessonEntries,
  resolveLessonBodies,
  composeLessonsProjection,
  deriveLessonsHeader,
  type LessonEntry,
} from "../../src/core/lessons-projection.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";
import type { Snapshot } from "../../src/core/reducer.js";

type Payload = Parameters<typeof isLesson>[0];

function payload(overrides: Partial<Record<string, unknown>>): Payload {
  return {
    id: "EV-000001",
    kind: "manual",
    iteration: 1,
    actor: "human:dev@test.invalid",
    result: "passed",
    summary: "a lesson",
    reason: "captured during execution",
    covers: [],
    ...overrides,
  } as unknown as Payload;
}

// ── isLesson selector ────────────────────────────────────────────────────
describe("isLesson — lesson vs manual-verification selector", () => {
  test("lessons-add shape → true", () => {
    expect(isLesson(payload({}))).toBe(true);
  });
  test("manual + covers REQ → false (verification, not a lesson)", () => {
    expect(isLesson(payload({ covers: ["REQ-AUTH-001"] }))).toBe(false);
  });
  test("manual + task_id → false", () => {
    expect(isLesson(payload({ task_id: "T-001" }))).toBe(false);
  });
  test("manual + check → false", () => {
    expect(isLesson(payload({ check: "run" }))).toBe(false);
  });
  test("manual + gate → false", () => {
    expect(isLesson(payload({ gate: "spec-lock" }))).toBe(false);
  });
  test("non-human actor → false", () => {
    expect(isLesson(payload({ actor: "cli:loaf" }))).toBe(false);
  });
  test("non-manual kind → false", () => {
    expect(isLesson(payload({ kind: "local-check" }))).toBe(false);
  });
});

// ── selectLessonEntries over journal stream ───────────────────────────────
describe("selectLessonEntries", () => {
  function evEntry(id: string, payloadOverrides: Record<string, unknown>): JournalEntry {
    return {
      seq: 0,
      entry_id: id,
      actor: "human:dev@test.invalid",
      iso_ts: "2026-05-15T10:00:00.000Z",
      at: "2026-05-15T10:00:00.000Z",
      schema_version: 2,
      kind: "evidence:added",
      payload: payload(payloadOverrides) as unknown as Record<string, unknown>,
    } as unknown as JournalEntry;
  }

  test("keeps lessons in journal order, drops verification evidence", () => {
    const entries = [
      evEntry("JE-000001", { id: "EV-000001", summary: "lesson one" }),
      evEntry("JE-000002", { id: "EV-000002", summary: "verify", covers: ["REQ-X-001"] }),
      evEntry("JE-000003", { id: "EV-000003", summary: "lesson two" }),
    ];
    const lessons = selectLessonEntries(entries);
    expect(lessons.map((l) => l.summary)).toEqual(["lesson one", "lesson two"]);
  });
});

// ── resolveLessonBodies (IO) ──────────────────────────────────────────────
describe("resolveLessonBodies", () => {
  test("inline string + inline LongTextField pass through", async () => {
    const lessons: LessonEntry[] = [
      { entry_id: "JE-1", at: "2026-05-15T10:00:00.000Z", summary: "short lesson" },
      {
        entry_id: "JE-2",
        at: "2026-05-15T10:00:00.000Z",
        summary: { mode: "inline", text: "inline lesson" } as never,
      },
    ];
    const resolved = await resolveLessonBodies("/unused", lessons);
    expect(resolved.map((r) => r.body)).toEqual(["short lesson", "inline lesson"]);
  });

  test("sidecar good → body inlined; hash mismatch → throws loud", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "loaf-lessons-"));
    const body = "a very long sidecar lesson body";
    const rel = path.join("attachments", "JE-000009", "summary.txt");
    await fsp.mkdir(path.join(dir, "attachments", "JE-000009"), { recursive: true });
    await fsp.writeFile(path.join(dir, rel), body);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const size = Buffer.byteLength(body);

    const good: LessonEntry[] = [
      {
        entry_id: "JE-000009",
        at: "2026-05-15T10:00:00.000Z",
        summary: { mode: "sidecar", ref: { path: rel, sha256, size } } as never,
      },
    ];
    expect((await resolveLessonBodies(dir, good))[0]!.body).toBe(body);

    const bad: LessonEntry[] = [
      {
        entry_id: "JE-000009",
        at: "2026-05-15T10:00:00.000Z",
        summary: { mode: "sidecar", ref: { path: rel, sha256: "0".repeat(64), size } } as never,
      },
    ];
    await expect(resolveLessonBodies(dir, bad)).rejects.toThrow(/integrity mismatch/);
  });
});

// ── deriveLessonsHeader ───────────────────────────────────────────────────
describe("deriveLessonsHeader", () => {
  const started = {
    seq: 0,
    entry_id: "JE-000000",
    actor: "cli:loaf",
    iso_ts: "2026-05-15T10:00:00.000Z",
    at: "2026-05-15T10:00:00.000Z",
    schema_version: 2,
    kind: "session:started",
    payload: { session_id: "x", feature: "auth-refresh", session_label: "Auth refresh work" },
  } as unknown as JournalEntry;

  test("prefers spec_header.feature when present", () => {
    const snap = {
      state: { feature: "auth-refresh", iteration: 2 },
      spec_header: { feature: { id: "F-001", name: "OAuth token refresh" } },
    } as unknown as Snapshot;
    const h = deriveLessonsHeader(snap, [started]);
    expect(h).toMatchObject({
      id: "F-001",
      name: "OAuth token refresh",
      date: "2026-05-15",
      iterations: 2,
    });
  });

  test("no-spec fallback: id=state.feature, name=session_label", () => {
    const snap = {
      state: { feature: "auth-refresh", iteration: 1 },
      spec_header: null,
    } as unknown as Snapshot;
    const h = deriveLessonsHeader(snap, [started]);
    expect(h).toMatchObject({ id: "auth-refresh", name: "Auth refresh work" });
  });
});

// ── composeLessonsProjection (pure render) ────────────────────────────────
describe("composeLessonsProjection", () => {
  test("renders header + ordered bullets", () => {
    const md = composeLessonsProjection(
      [
        { body: "lesson one", at: "2026-05-15T10:00:00.000Z" },
        { body: "lesson two", at: "2026-05-15T11:00:00.000Z" },
      ],
      { id: "F-001", name: "OAuth token refresh", date: "2026-05-15", iterations: 2 },
    );
    expect(md).toContain("## F-001 OAuth token refresh · 2026-05-15 (iterations=2)");
    expect(md).toContain("- lesson one");
    expect(md).toContain("- lesson two");
  });

  test("multi-line lesson body indents continuation lines", () => {
    const md = composeLessonsProjection(
      [{ body: "line A\nline B", at: "2026-05-15T10:00:00.000Z" }],
      { id: "F-001", name: "x", date: "2026-05-15", iterations: 1 },
    );
    expect(md).toContain("- line A\n  line B");
  });
});
