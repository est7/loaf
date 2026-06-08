// Phase 16 SC-11 — pure tests for the shared EV-id allocator.
//
// Covers (codex r324 P1 lock):
//   - empty snapshot → EV-000001 .. EV-NNN
//   - existing evidence → max-serial + 1 .. + N
//   - 6-digit zero-padding
//   - count=0 → []
//   - allocateNextEvidenceId(1) convenience

import { describe, expect, test } from "vitest";

import {
  allocateNextEvidenceId,
  allocateNextEvidenceIds,
} from "../../src/cli/evidence-id-allocator.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import type { EvidenceState, Snapshot } from "../../src/core/reducer.js";

function makeEvidence(id: string): EvidenceState {
  return {
    id,
    kind: "task-summary",
    actor: "human:dev@example.com",
    result: "passed",
    covers: [],
  };
}

function snapshotWith(evidenceIds: string[]): Snapshot {
  const snap = initialSnapshot();
  snap.evidence = evidenceIds.map(makeEvidence);
  return snap;
}

describe("allocateNextEvidenceIds — single + batch allocation", () => {
  test("empty snapshot + count=1 → ['EV-000001']", () => {
    expect(allocateNextEvidenceIds(snapshotWith([]), 1)).toEqual(["EV-000001"]);
  });

  test("empty snapshot + count=3 → 6-digit padded sequence", () => {
    expect(allocateNextEvidenceIds(snapshotWith([]), 3)).toEqual([
      "EV-000001",
      "EV-000002",
      "EV-000003",
    ]);
  });

  test("existing EV-000007 + count=2 → ['EV-000008', 'EV-000009']", () => {
    expect(allocateNextEvidenceIds(snapshotWith(["EV-000007"]), 2)).toEqual([
      "EV-000008",
      "EV-000009",
    ]);
  });

  test("max-serial from middle of list (not sorted) → next-after-max", () => {
    expect(
      allocateNextEvidenceIds(snapshotWith(["EV-000003", "EV-000010", "EV-000005"]), 1),
    ).toEqual(["EV-000011"]);
  });

  test("count=0 → empty array (no allocation)", () => {
    expect(allocateNextEvidenceIds(snapshotWith([]), 0)).toEqual([]);
  });

  test("non-conforming ids skipped from max calc", () => {
    // ids that don't match /^EV-\d+$/ shouldn't count toward max
    expect(allocateNextEvidenceIds(snapshotWith(["EV-foo", "EV-000004"]), 1)).toEqual([
      "EV-000005",
    ]);
  });
});

describe("allocateNextEvidenceId — single-shot convenience", () => {
  test("delegates to allocateNextEvidenceIds(snap, 1)[0]", () => {
    expect(allocateNextEvidenceId(snapshotWith(["EV-000099"]))).toBe("EV-000100");
  });
});
