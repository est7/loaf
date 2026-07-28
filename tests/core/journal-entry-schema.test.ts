import { describe, expect, test } from "vitest";

import {
  AttachmentRef,
  BatchId,
  Ceremony,
  CeremonyLabel,
  JournalEntry,
  LessonRecordedPayload,
  Phase,
  SignatureEnvelope,
} from "../../src/core/journal-entry.js";

describe("journal-entry machine contracts", () => {
  test("Ceremony requires all six protocol fields", () => {
    expect(Ceremony.safeParse({}).success).toBe(false);
    expect(
      Ceremony.safeParse({
        spec_phase: false,
        verify_phase: false,
        settle_phase: false,
        strict_spec_review: false,
        lessons_required: "skip",
        strict_drift_check: false,
      }).success,
    ).toBe(true);
  });

  test("JournalEntry rejects the reserved signature field", () => {
    const unsigned = {
      seq: 0,
      entry_id: "JE-000001",
      at: "2026-07-16T08:19:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started" as const,
      payload: {},
    };
    const signature = {
      alg: "ed25519" as const,
      key_id: "key-1",
      sig: "base64-signature",
      signed_at: "2026-07-16T08:19:00.000Z",
    };

    expect(SignatureEnvelope.safeParse(signature).success).toBe(true);
    expect(JournalEntry.safeParse({ ...unsigned, signature }).success).toBe(false);
    expect(JournalEntry.safeParse(unsigned).success).toBe(true);
  });

  test("supporting enums and identifiers retain their runtime boundaries", () => {
    expect(BatchId.safeParse("not-a-uuid").success).toBe(false);
    expect(Phase.safeParse("EXECUTE").success).toBe(true);
    expect(Phase.safeParse("UNKNOWN").success).toBe(false);
    expect(CeremonyLabel.safeParse("").success).toBe(true);
  });

  test.each([
    "../outside.txt",
    "attachments/../outside.txt",
    "/tmp/outside.txt",
    "C:\\temp\\outside.txt",
    "\\\\server\\share\\outside.txt",
    "attachments\\JE-000001\\summary.txt",
    "attachments/JE-000001/../summary.txt",
    "attachments/JE-000001/./summary.txt",
    "attachments//JE-000001/summary.txt",
    "attachments/JE-000001/",
    "attachments/not-an-entry/summary.txt",
    "other/JE-000001/summary.txt",
    "attachments/JE-000001/sum\u0000mary.txt",
  ])("AttachmentRef rejects non-canonical path %j", (refPath) => {
    expect(
      AttachmentRef.safeParse({
        path: refPath,
        sha256: "a".repeat(64),
        size: 1,
      }).success,
    ).toBe(false);
  });

  test("AttachmentRef accepts canonical entry-owned and nested migration paths", () => {
    for (const refPath of [
      "attachments/JE-000001/summary.txt",
      "attachments/JE-000000/migration/state.json",
    ]) {
      expect(
        AttachmentRef.safeParse({
          path: refPath,
          sha256: "a".repeat(64),
          size: 1,
        }).success,
      ).toBe(true);
    }
  });

  test("LessonRecordedPayload@1 accepts only the strict lesson contract", () => {
    const valid = {
      id: "LSN-001",
      iteration: 2,
      reason: "captured during retry analysis",
      summary: "share the refresh lock across callers",
    };

    expect(LessonRecordedPayload.safeParse(valid).success).toBe(true);
    expect(LessonRecordedPayload.safeParse({ ...valid, id: "EV-000001" }).success).toBe(false);
    expect(LessonRecordedPayload.safeParse({ ...valid, id: "LSN-01" }).success).toBe(false);
    expect(LessonRecordedPayload.safeParse({ ...valid, actor: "human:tester" }).success).toBe(
      false,
    );
    expect(
      LessonRecordedPayload.safeParse({
        ...valid,
        summary: { mode: "inline", text: "x".repeat(9_000) },
      }).success,
    ).toBe(true);
  });
});
