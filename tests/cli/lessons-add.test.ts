// Pure tests for the lesson:recorded payload builder.
//
// Covers (codex r325 P1 Option A — payload only):
//   - LongTextField inline shape when text > SIDECAR_THRESHOLD_BYTES
//   - plain string when text ≤ SIDECAR_THRESHOLD_BYTES
//   - reason / iteration / lessonId injection
//   - boundary: exactly SIDECAR_THRESHOLD_BYTES → plain string (codex r327
//     non-blocking — `>` not `>=` to mirror sidecar predicate)

import { describe, expect, test } from "vitest";

import { buildLessonRecordedPayload } from "../../src/cli/lessons-add.js";
import { LessonRecordedPayload, SIDECAR_THRESHOLD_BYTES } from "../../src/core/journal-entry.js";

describe("buildLessonRecordedPayload — payload shape", () => {
  test("short lesson: summary is plain string", () => {
    const payload = buildLessonRecordedPayload({
      lessonId: "LSN-042",
      lessonText: "single-flight refresh requires a global lock",
      reason: "diagnosed during retry storm post-mortem",
      iteration: 2,
    });
    expect(payload.summary).toBe("single-flight refresh requires a global lock");
  });

  test(`text > SIDECAR_THRESHOLD_BYTES (${SIDECAR_THRESHOLD_BYTES}) → LongTextField inline shape`, () => {
    const bigText = "x".repeat(SIDECAR_THRESHOLD_BYTES + 100);
    const payload = buildLessonRecordedPayload({
      lessonId: "LSN-001",
      lessonText: bigText,
      reason: "deep retro of refresh storm incident",
      iteration: 1,
    });
    expect(typeof payload.summary).toBe("object");
    if (typeof payload.summary === "string") throw new Error("unreachable");
    expect(payload.summary.mode).toBe("inline");
    if (payload.summary.mode !== "inline") throw new Error("unreachable");
    expect(payload.summary.text).toBe(bigText);
  });

  test("boundary: exactly SIDECAR_THRESHOLD_BYTES stays plain string (mirrors sidecar `>` predicate)", () => {
    const exactText = "x".repeat(SIDECAR_THRESHOLD_BYTES);
    const payload = buildLessonRecordedPayload({
      lessonId: "LSN-001",
      lessonText: exactText,
      reason: "boundary case retro analysis",
      iteration: 1,
    });
    expect(typeof payload.summary).toBe("string");
  });

  test("lessonId / iteration / reason passed through verbatim", () => {
    const payload = buildLessonRecordedPayload({
      lessonId: "LSN-099",
      lessonText: "short lesson body",
      reason: "context for the lesson learned",
      iteration: 3,
    });
    expect(payload.id).toBe("LSN-099");
    expect(payload.iteration).toBe(3);
    expect(payload.reason).toBe("context for the lesson learned");
  });

  test("passes the strict LessonRecordedPayload@1 schema", () => {
    const payload = buildLessonRecordedPayload({
      lessonId: "LSN-007",
      lessonText: "short lesson body",
      reason: "post-mortem context for the lesson",
      iteration: 1,
    });
    expect(LessonRecordedPayload.safeParse(payload).success).toBe(true);
    expect(LessonRecordedPayload.safeParse({ ...payload, actor: "human:tester" }).success).toBe(
      false,
    );
  });

  test("LessonRecordedPayload rejects reason <10 chars", () => {
    const payload = buildLessonRecordedPayload({
      lessonId: "LSN-007",
      lessonText: "short lesson body",
      reason: "too short",
      iteration: 1,
    });
    const result = LessonRecordedPayload.safeParse(payload);
    expect(result.success).toBe(false);
  });
});
