// Phase v0.1.1 / F-024 — `lessons.md` projection writer.
//
// `loaf lessons add` emits an `evidence:added` payload with kind=manual.
// `lessons.md` is the user-facing markdown projection of those lesson
// entries (top-level `.loaf/<feature>/lessons.md`, like `spec.md` — NOT a
// `snapshots/*.json` machine leaf). Advisory tier (§4.7): free-form, not
// strictly validated.
//
// Layering mirrors projection-writer.ts / spec-projection.ts:
//   - pure: `isLesson` predicate + `composeLessonsProjection` markdown render
//     + `deriveLessonsHeader` (no IO)
//   - IO:   `resolveLessonBodies` reads + verifies `summary` sidecars
// The IO resolver is kept OUT of the pure composer (codex F-024 r2): sidecar
// read / sha256 / size failures surface loud as PROJECTION_WRITE_FAILED at
// the writeProjections boundary, mirroring the spec.md / snapshots pattern.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { EvidenceFullPayload } from "./evidence-schema.js";
import type { JournalEntry } from "./journal-entry.js";
import type { Snapshot } from "./reducer.js";

/**
 * Lesson selector (codex F-024 r2): NOT every kind=manual evidence is a
 * lesson — `loaf evidence add --kind manual` is a legitimate verification
 * path that covers REQ/SCEN/VIS/T. A lesson (from `loaf lessons add`,
 * `buildLessonsEvidencePayload`) is shaped EXACTLY as: kind=manual,
 * result=passed, empty covers, no task_id / check / gate linkage, human
 * actor. The shape heuristic is exact for the current emitter; an explicit
 * payload marker is future hardening (needs an evidence-schema rev).
 */
export function isLesson(payload: ReturnType<typeof EvidenceFullPayload.parse>): boolean {
  return (
    payload.kind === "manual" &&
    payload.result === "passed" &&
    (payload.covers?.length ?? 0) === 0 &&
    payload.task_id === undefined &&
    payload.check === undefined &&
    payload.gate === undefined &&
    payload.actor.startsWith("human:")
  );
}

export interface LessonEntry {
  entry_id: string;
  at: string;
  /** EvidenceFullPayload.summary — `string` (short) or a LongTextField. */
  summary: ReturnType<typeof EvidenceFullPayload.parse>["summary"];
}

/**
 * Select lesson entries from the journal stream (journal order = seq order).
 * Operates on the FULL journal payloads (codex F-024 r2: NOT the slim
 * `Snapshot.evidence`, which drops summary / task_id / gate).
 */
export function selectLessonEntries(entries: readonly JournalEntry[]): LessonEntry[] {
  const lessons: LessonEntry[] = [];
  for (const e of entries) {
    if (e.kind !== "evidence:added") continue;
    const payload = EvidenceFullPayload.parse(e.payload);
    if (!isLesson(payload)) continue;
    lessons.push({ entry_id: e.entry_id, at: e.at, summary: payload.summary });
  }
  return lessons;
}

export interface ResolvedLesson {
  body: string;
  at: string;
}

/**
 * IO resolver — inline `summary` strings / inline LongTextFields pass through;
 * sidecar LongTextFields are read from `<featureDir>/<ref.path>` and verified
 * against `ref.sha256` + `ref.size`. A missing file or hash/size mismatch
 * THROWS — surfaced as PROJECTION_WRITE_FAILED at the writer boundary.
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
      const ref = summary.ref;
      const abs = path.join(featureDir, ref.path);
      const buf = await fsp.readFile(abs);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      if (sha256 !== ref.sha256 || buf.byteLength !== ref.size) {
        throw new Error(
          `lesson sidecar ${ref.path} integrity mismatch ` +
            `(sha256 ${sha256 === ref.sha256 ? "ok" : "MISMATCH"}, ` +
            `size ${buf.byteLength}≟${ref.size})`,
        );
      }
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
