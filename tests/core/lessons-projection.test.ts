// lessons.md projects dedicated lesson:recorded entries in journal order.
// Manual and verification evidence remain evidence, never lesson content.

import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

import {
  selectLessonEntries,
  resolveLessonBodies,
  composeLessonsProjection,
  deriveLessonsHeader,
  type LessonEntry,
} from "../../src/core/lessons-projection.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";
import type { Snapshot } from "../../src/core/reducer.js";

function payload(overrides: Record<string, unknown>): Record<string, unknown> {
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
  };
}

// ── selectLessonEntries over journal stream ───────────────────────────────
describe("selectLessonEntries", () => {
  function evEntry(id: string, payloadOverrides: Record<string, unknown>): JournalEntry {
    return {
      seq: 0,
      entry_id: id,
      actor: "human:dev@test.invalid",
      at: "2026-05-15T10:00:00.000Z",
      entry_schema_version: 1,
      kind: "evidence:added",
      payload: payload(payloadOverrides),
    };
  }

  function lessonEntry(id: string, lessonId: string, summary: string): JournalEntry {
    return {
      seq: 0,
      entry_id: id,
      actor: "human:dev@test.invalid",
      at: "2026-05-15T10:00:00.000Z",
      entry_schema_version: 1,
      kind: "lesson:recorded",
      payload: {
        id: lessonId,
        iteration: 1,
        reason: "captured during projection testing",
        summary,
      },
    };
  }

  test("human manual evidence without linkage is not a lesson", () => {
    expect(
      selectLessonEntries([evEntry("JE-000001", { summary: "ordinary manual evidence" })]),
    ).toEqual([]);
  });

  test("keeps only lesson:recorded entries in journal order", () => {
    const entries = [
      evEntry("JE-000001", { id: "EV-000001", summary: "manual evidence" }),
      lessonEntry("JE-000002", "LSN-001", "lesson one"),
      evEntry("JE-000003", { id: "EV-000002", summary: "verification", task_id: "T-001" }),
      lessonEntry("JE-000004", "LSN-002", "lesson two"),
    ];
    expect(selectLessonEntries(entries).map((lesson) => lesson.summary)).toEqual([
      "lesson one",
      "lesson two",
    ]);
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
        summary: { mode: "inline", text: "inline lesson" },
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
        summary: { mode: "sidecar", ref: { path: rel, sha256, size } },
      },
    ];
    expect((await resolveLessonBodies(dir, good))[0]!.body).toBe(body);

    const bad: LessonEntry[] = [
      {
        entry_id: "JE-000009",
        at: "2026-05-15T10:00:00.000Z",
        summary: { mode: "sidecar", ref: { path: rel, sha256: "0".repeat(64), size } },
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
