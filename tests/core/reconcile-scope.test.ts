import { describe, expect, test } from "vitest";
import type { JournalEntry } from "../../src/core/journal-entry.js";
import { deriveActualScope } from "../../src/core/scope-projection.js";

function entry(
  seq: number,
  kind: JournalEntry["kind"],
  payload: Record<string, unknown>,
  batchId: string,
  batchIndex: number,
): JournalEntry {
  return {
    seq,
    entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
    at: "2026-07-20T12:00:00.000Z",
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind,
    payload,
    batch_id: batchId,
    batch_index: batchIndex,
    batch_count: 2,
  } as JournalEntry;
}

function closurePair(
  seq: number,
  iteration: number,
  paths: string[],
  batchId: string,
): JournalEntry[] {
  return [
    entry(seq, "scope:recorded", { iteration, paths }, batchId, 0),
    entry(
      seq + 1,
      "event:phase_advanced",
      { from: "EXECUTE.work", to: "EXECUTE.done" },
      batchId,
      1,
    ),
  ];
}

describe("actual scope history derivation", () => {
  test("pre-F-027 closure without same-batch scope marker reports incomplete history", async () => {
    const legacyClosure = entry(
      0,
      "event:phase_advanced",
      { from: "EXECUTE.work", to: "EXECUTE.done" },
      "legacy-batch",
      1,
    );
    await expect(deriveActualScope([legacyClosure], "/tmp/unused")).rejects.toMatchObject({
      code: "ACTUAL_SCOPE_HISTORY_INCOMPLETE",
      detail: { transition_seqs: [0] },
    });
  });

  test("full replay unions multiple closures in canonical byte order", async () => {
    const entries = [
      ...closurePair(0, 1, ["src/Z.ts", "src/a.ts"], "batch-one"),
      ...closurePair(2, 2, ["src/a.ts", "src/é.ts"], "batch-two"),
    ];
    await expect(deriveActualScope(entries, "/tmp/unused")).resolves.toEqual([
      "src/Z.ts",
      "src/a.ts",
      "src/é.ts",
    ]);
  });
});
