import { describe, expect, test } from "vitest";

import {
  BatchId,
  Ceremony,
  CeremonyLabel,
  JournalEntry,
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
});
