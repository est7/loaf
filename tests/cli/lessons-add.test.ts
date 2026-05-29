// Phase 16 SC-11 — pure tests for lessons-add payload builder.
//
// Covers (codex r325 P1 Option A — payload only):
//   - kind=manual, result=passed, covers=[]
//   - LongTextField inline shape when text > SIDECAR_THRESHOLD_BYTES
//   - plain string when text ≤ SIDECAR_THRESHOLD_BYTES
//   - reason / actor / iteration / evidenceId injection
//   - boundary: exactly SIDECAR_THRESHOLD_BYTES → plain string (codex r327
//     non-blocking — `>` not `>=` to mirror sidecar predicate)

import { describe, expect, test } from "vitest";

import { buildLessonsEvidencePayload } from "../../src/cli/lessons-add.js";
import { SIDECAR_THRESHOLD_BYTES } from "../../src/core/journal-entry.js";
import { EvidenceFullPayload } from "../../src/core/evidence-schema.js";

describe("buildLessonsEvidencePayload — payload shape", () => {
  test("short lesson: summary is plain string, covers=[]", () => {
    const payload = buildLessonsEvidencePayload({
      evidenceId: "EV-000042",
      lessonText: "single-flight refresh requires a global lock",
      reason: "diagnosed during retry storm post-mortem",
      actor: "human:dev@example.com",
      iteration: 2,
    });
    expect(payload.kind).toBe("manual");
    expect(payload.result).toBe("passed");
    expect(payload.covers).toEqual([]);
    expect(payload.summary).toBe("single-flight refresh requires a global lock");
  });

  test(`text > SIDECAR_THRESHOLD_BYTES (${SIDECAR_THRESHOLD_BYTES}) → LongTextField inline shape`, () => {
    const bigText = "x".repeat(SIDECAR_THRESHOLD_BYTES + 100);
    const payload = buildLessonsEvidencePayload({
      evidenceId: "EV-000001",
      lessonText: bigText,
      reason: "deep retro of refresh storm incident",
      actor: "human:dev@example.com",
      iteration: 1,
    });
    expect(typeof payload.summary).toBe("object");
    if (typeof payload.summary === "string") throw new Error("unreachable");
    expect(payload.summary.mode).toBe("inline");
    expect(payload.summary.text).toBe(bigText);
  });

  test("boundary: exactly SIDECAR_THRESHOLD_BYTES stays plain string (mirrors sidecar `>` predicate)", () => {
    const exactText = "x".repeat(SIDECAR_THRESHOLD_BYTES);
    const payload = buildLessonsEvidencePayload({
      evidenceId: "EV-000001",
      lessonText: exactText,
      reason: "boundary case retro analysis",
      actor: "human:dev@example.com",
      iteration: 1,
    });
    expect(typeof payload.summary).toBe("string");
  });

  test("evidenceId / actor / iteration / reason passed through verbatim", () => {
    const payload = buildLessonsEvidencePayload({
      evidenceId: "EV-000099",
      lessonText: "short lesson body",
      reason: "context for the lesson learned",
      actor: "human:reviewer@example.com",
      iteration: 3,
    });
    expect(payload.id).toBe("EV-000099");
    expect(payload.actor).toBe("human:reviewer@example.com");
    expect(payload.iteration).toBe(3);
    expect(payload.reason).toBe("context for the lesson learned");
  });

  test("passes EvidenceFullPayload refine (kind=manual + human:* actor + reason≥10)", () => {
    const payload = buildLessonsEvidencePayload({
      evidenceId: "EV-000007",
      lessonText: "short lesson body",
      reason: "post-mortem context for the lesson",
      actor: "human:dev@example.com",
      iteration: 1,
    });
    const result = EvidenceFullPayload.safeParse(payload);
    expect(result.success).toBe(true);
  });

  test("EvidenceFullPayload rejects non-human actor (kind=manual refine)", () => {
    const payload = buildLessonsEvidencePayload({
      evidenceId: "EV-000007",
      lessonText: "short lesson body",
      reason: "post-mortem context for the lesson",
      actor: "cli:loaf",
      iteration: 1,
    });
    const result = EvidenceFullPayload.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("EvidenceFullPayload rejects reason <10 chars", () => {
    const payload = buildLessonsEvidencePayload({
      evidenceId: "EV-000007",
      lessonText: "short lesson body",
      reason: "too short",
      actor: "human:dev@example.com",
      iteration: 1,
    });
    const result = EvidenceFullPayload.safeParse(payload);
    expect(result.success).toBe(false);
  });
});
