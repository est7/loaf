import { describe, expect, test } from "vitest";

import { allocateNextLessonId } from "../../src/cli/lesson-id-allocator.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";

function entry(kind: JournalEntry["kind"], id: string): JournalEntry {
  return {
    seq: 0,
    entry_id: "JE-000001",
    at: "2026-07-16T12:00:00.000Z",
    actor: "human:tester",
    entry_schema_version: 1,
    kind,
    payload:
      kind === "lesson:recorded"
        ? {
            id,
            iteration: 1,
            reason: "captured during allocator testing",
            summary: "allocator fixture lesson",
          }
        : { id },
  } as JournalEntry;
}

describe("allocateNextLessonId", () => {
  test("allocates LSN-001 for a history without lesson:recorded entries", () => {
    expect(allocateNextLessonId([entry("evidence:added", "EV-000999")])).toBe("LSN-001");
  });

  test("scans only lesson:recorded ids and advances the maximum serial", () => {
    const entries = [
      entry("lesson:recorded" as JournalEntry["kind"], "LSN-002"),
      entry("evidence:added", "LSN-999"),
      entry("lesson:recorded" as JournalEntry["kind"], "LSN-014"),
    ];

    expect(allocateNextLessonId(entries)).toBe("LSN-015");
  });

  test("keeps serials above 999 without truncation", () => {
    expect(
      allocateNextLessonId([
        entry("lesson:recorded" as JournalEntry["kind"], "LSN-1007"),
      ]),
    ).toBe("LSN-1008");
  });
});
