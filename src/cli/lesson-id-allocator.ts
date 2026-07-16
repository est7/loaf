import type { JournalEntry } from "../core/journal-entry.js";
import { LessonRecordedPayload } from "../core/journal-entry.js";
import { nextSerialInNamespace } from "../core/spec-schema.js";

/** Allocate the next independent lesson id from canonical journal history. */
export function allocateNextLessonId(entries: readonly JournalEntry[]): string {
  const lessonIds = entries
    .filter((entry) => entry.kind === "lesson:recorded")
    .map((entry) => LessonRecordedPayload.parse(entry.payload).id);
  const serial = nextSerialInNamespace(lessonIds, "LSN");
  return `LSN-${String(serial).padStart(3, "0")}`;
}
