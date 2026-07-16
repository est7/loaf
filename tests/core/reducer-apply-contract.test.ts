import { describe, expect, test } from "vitest";

import { apply, initialSnapshot, type Snapshot } from "../../src/core/reducer.js";
import type { Ceremony, JournalEntry } from "../../src/core/journal-entry.js";

const STANDARD_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

function startedSnapshot(): Snapshot {
  return {
    ...initialSnapshot(),
    state: {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "auth-refresh",
      phase: "TRIAGE",
      sub_state: "TRIAGE.score",
      iteration: 1,
      spec_locked: false,
      verify_accepted: false,
      spec_version: 0,
      ceremony: STANDARD_CEREMONY,
    },
  };
}

function pendingAddedEntry(): JournalEntry {
  return {
    seq: 1,
    entry_id: "JE-000002",
    at: "2026-05-15T10:00:01.000Z",
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind: "pending:added",
    payload: {
      id: "PEND-0001",
      kind: "ask_user_question",
      question: "Which option should this fixture choose?",
    },
  };
}

function sessionStartedEntry(actor = "cli:loaf"): JournalEntry {
  return {
    seq: 0,
    entry_id: "JE-000001",
    at: "2026-05-15T10:00:00.000Z",
    actor,
    entry_schema_version: 1,
    kind: "session:started",
    payload: {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "auth-refresh",
      ceremony: STANDARD_CEREMONY,
    },
  };
}

describe("reducer.apply — consumed snapshot contract", () => {
  test("session:started bypasses preflight actor authority", () => {
    const result = apply(initialSnapshot(), sessionStartedEntry("migration:test"));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.state?.feature).toBe("auth-refresh");
  });

  test("NO_SESSION takes priority over preflight failures", () => {
    const entry = {
      ...pendingAddedEntry(),
      seq: 99,
      actor: "migration:test",
    } as JournalEntry;

    const result = apply(initialSnapshot(), entry);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NO_SESSION");
      expect(result.message).toBe("kind=pending:added requires a started session");
    }
  });

  test("clone-first callers keep the pre-apply snapshot while apply mutates the consumed snapshot", () => {
    const before = startedSnapshot();
    const working = structuredClone(before);

    const result = apply(working, pendingAddedEntry());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);

    expect(before.pending).toHaveLength(0);
    expect(working.pending).toEqual([
      { id: "PEND-0001", kind: "ask_user_question", resolved: false },
    ]);
    expect(result.snapshot.pending).toBe(working.pending);
  });
});
