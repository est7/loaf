import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { Ceremony, JournalEntry } from "../../src/core/journal-entry.js";
import { mutate } from "../../src/core/journal-mutate.js";
import { loadLegacyReconcileProjection } from "../../src/core/projection-loader.js";
import { ReconcileJson } from "../../src/core/reconcile-schema.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import { deriveActualScope } from "../../src/core/scope-projection.js";
import { emptyMeta } from "../../src/core/snapshot.js";

const STANDARD: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

function reconcile(actualScope: string[] = []) {
  return {
    schema_version: 2,
    based_on: { spec: 3, tasks: 5 },
    planned_scope: ["src/auth/**", "tests/auth/**"],
    actual_scope: actualScope,
    drift: [],
    ac_coverage: [],
    verify_checks_status: {
      run: { applicability: "must", status: "passed", evidence_refs: [] },
      review: { applicability: "must", status: "passed", evidence_refs: [] },
      acceptance: { applicability: "must", status: "passed", evidence_refs: [] },
      visual: { applicability: "must", status: "passed", evidence_refs: [] },
    },
    iteration_stats: {
      total: 2,
      findings_total: 0,
      findings_by_action: {
        "amend-spec": 0,
        "amend-tasks": 0,
        "fix-impl": 0,
        "fix-test": 0,
        defer: 0,
        backlog: 0,
      },
      findings_by_category: {
        "spec-gap": 0,
        "spec-defect": 0,
        "impl-defect": 0,
        "test-defect": 0,
        "new-scope": 0,
        "risk-escalation": 0,
      },
    },
    unusual_findings_count: 0,
  };
}

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

describe("ReconcileJson actual_scope contract", () => {
  test("rejects legacy duplicate/unsorted concrete paths without normalizing them", () => {
    const legacy = reconcile(["src/z.ts", "src/a.ts", "src/a.ts"]);
    expect(ReconcileJson.safeParse(legacy).success).toBe(false);
    expect(legacy.actual_scope).toEqual(["src/z.ts", "src/a.ts", "src/a.ts"]);
  });

  test("accepts empty actual scope, keeps planned globs, and leaves based_on at spec+tasks", () => {
    const parsed = ReconcileJson.parse(reconcile([]));
    expect(parsed.actual_scope).toEqual([]);
    expect(parsed.planned_scope).toEqual(["src/auth/**", "tests/auth/**"]);
    expect(Object.keys(parsed.based_on)).toEqual(["spec", "tasks"]);
  });

  test("fresh legacy reconcile leaf that only violates actual_scope is rebuild-required", async () => {
    const featureDir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-reconcile-reader-"));
    const seeded = await mutate(
      {
        at: "2026-07-20T12:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "reconcile-reader",
          ceremony: STANDARD,
        },
      },
      {
        feature_dir: featureDir,
        snapshot: initialSnapshot(),
        tail_seq: -1,
        entries: [],
        meta: emptyMeta(),
        fsync: false,
      },
    );
    if (!seeded.ok) throw new Error(seeded.message);
    const legacy = reconcile(["src/z.ts", "src/a.ts", "src/a.ts"]);
    await fs.writeFile(
      path.join(featureDir, "snapshots", "reconcile.json"),
      JSON.stringify(legacy),
    );

    await expect(
      loadLegacyReconcileProjection(featureDir),
    ).rejects.toMatchObject({
      code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
      reason: "projection_invalid",
      detail: {
        projection_kind: "reconcile",
        cause: "schema",
      },
    });
    expect(legacy.actual_scope).toEqual(["src/z.ts", "src/a.ts", "src/a.ts"]);
  });
});

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
