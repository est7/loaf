import type { Ceremony, SubState } from "./journal-entry.js";

/** Session-wide delivery obligation shared by admission and owner routing. */
export function requiresLessonBeforeDelivery(
  subState: SubState,
  ceremony: Pick<Ceremony, "lessons_required">,
  lessonCount: number,
): boolean {
  return subState === "SETTLE.lessons" && ceremony.lessons_required === "must" && lessonCount === 0;
}
