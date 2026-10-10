// `lessons.md` is the user-facing markdown projection of independent
// `lesson:recorded` entries (top-level `.loaf/<feature>/lessons.md`, like
// `spec.md` — NOT a `snapshots/*.json` machine leaf). Advisory tier (§4.7):
// free-form, not
// strictly validated.
//
// Layering mirrors projection-writer.ts / spec-projection.ts:
//   - pure: `selectLessonEntries` + `composeLessonsProjection` markdown render
//     + `deriveLessonsHeader` (no IO)
//   - IO:   `resolveLessonBodies` reads + verifies `summary` sidecars
// The IO resolver is kept OUT of the pure composer (codex F-024 r2): sidecar
// read / sha256 / size failures surface loud as PROJECTION_WRITE_FAILED at
// the writeProjections boundary, mirroring the spec.md / snapshots pattern.

import { readAttachment } from "./attachment-authority.js";
import { LessonRecordedPayload, type JournalEntry } from "./journal-entry.js";
import type { Snapshot } from "./reducer.js";

export interface LessonEntry {
  entry_id: string;
  at: string;
  /** Lesson summary — `string` (short) or a LongTextField. */
  summary: LessonRecordedPayload["summary"];
}

/**
 * Select lesson entries from the journal stream (journal order = seq order).
 * Only the dedicated lesson kind owns lesson content.
 * Operates on FULL journal payloads, not the slim `Snapshot.evidence`.
 */
export function selectLessonEntries(entries: readonly JournalEntry[]): LessonEntry[] {
  const lessons: LessonEntry[] = [];
  for (const e of entries) {
    if (e.kind !== "lesson:recorded") continue;
    const payload = LessonRecordedPayload.parse(e.payload);
    lessons.push({
      entry_id: e.entry_id,
      at: e.at,
      summary: payload.summary,
    });
  }
  return lessons;
}

export interface ResolvedLesson {
  body: string;
  at: string;
}

/**
 * IO resolver — inline `summary` strings / inline LongTextFields pass through;
 * sidecar LongTextFields are resolved by the attachment authority, which
 * verifies entry/slot ownership, path safety, `ref.sha256`, and `ref.size`.
 * Any rejection THROWS and surfaces as PROJECTION_WRITE_FAILED at the writer
 * boundary.
 */
export async function resolveLessonBodies(
  featureDir: string,
  lessons: readonly LessonEntry[],
): Promise<ResolvedLesson[]> {
  const resolved: ResolvedLesson[] = [];
  for (const lesson of lessons) {
    const { summary } = lesson;
    let body: string;
    if (typeof summary === "string") {
      body = summary;
    } else if (summary.mode === "inline") {
      body = summary.text;
    } else {
      const buf = await readAttachment(
        featureDir,
        { entry_id: lesson.entry_id, kind: "lesson:recorded" },
        "summary",
        summary.ref,
      );
      body = buf.toString("utf8");
    }
    resolved.push({ body, at: lesson.at });
  }
  return resolved;
}

export interface LessonsHeader {
  id: string;
  name: string;
  /** YYYY-MM-DD from session:started.at (stable across appends). */
  date: string;
  iterations: number;
}

/**
 * Header identity (codex F-024 Q3): prefer the spec header (id + name from
 * spec.md), with a required fallback for legal no-spec / quick paths — id =
 * state.feature, name = session_label (off session:started) ?? state.feature.
 * Date = session:started.at date; iterations = current snapshot iteration.
 * Does NOT depend on spec_header being non-null.
 */
export function deriveLessonsHeader(
  snapshot: Snapshot,
  entries: readonly JournalEntry[],
): LessonsHeader {
  const started = entries.find((e) => e.kind === "session:started");
  const sessionLabel =
    started && typeof (started.payload as { session_label?: unknown }).session_label === "string"
      ? ((started.payload as { session_label?: string }).session_label as string)
      : undefined;
  const feature = snapshot.state?.feature ?? "(unknown)";
  const id = snapshot.spec_header?.feature.id ?? feature;
  const name = snapshot.spec_header?.feature.name ?? sessionLabel ?? feature;
  const date = started ? started.at.slice(0, 10) : "";
  const iterations = snapshot.state?.iteration ?? 1;
  return { id, name, date, iterations };
}

/**
 * Pure markdown render (§4.7): one flat section per feature.
 *
 * ```markdown
 * ## <id> <name> · <date> (iterations=N)
 *
 * - lesson one
 * - lesson two
 * ```
 *
 * Multi-line lesson bodies indent continuation lines under the bullet.
 * Caller decides write-vs-skip when `resolved` is empty.
 */
export function composeLessonsProjection(
  resolved: readonly ResolvedLesson[],
  header: LessonsHeader,
): string {
  const bullets = resolved.map((r) => `- ${r.body.trim().replace(/\n/g, "\n  ")}`).join("\n");
  return `## ${header.id} ${header.name} · ${header.date} (iterations=${header.iterations})\n\n${bullets}\n`;
}
