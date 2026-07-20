// Phase 16 SC-15b — pure composition unit tests for the hook read-side.
//
// composeSessionStartContext / runClosureWarnings are pure (no IO), so the
// composition matrix (findings present/absent, pending present/absent,
// orphan evidence, terminal sub_state) is covered here without on-disk
// fixtures. The cli.tsx e2e tests cover only the IO wiring + envelope.

import { describe, expect, test } from "vitest";

import type {
  EvidenceJson,
  FindingsJson,
  PendingQueueEntry,
  TasksJson,
} from "../../src/core/projection-schema.js";
import {
  composeSessionStartContext,
  runClosureWarnings,
  sessionStartHookOutput,
} from "../../src/core/hook-read.js";

function pending(id: string, question: string): PendingQueueEntry {
  return {
    pending_id: id as PendingQueueEntry["pending_id"],
    kind: "gate_decision",
    question,
    blocks: "advance",
    raised_at: "2026-05-15T10:00:00.000Z",
    raised_by: "cli:loaf",
    at: "2026-05-15T10:00:00.000Z",
  };
}

function finding(
  id: string,
  status: "open" | "closed",
  summary?: string,
  action: FindingsJson["findings"][number]["action"] = "amend-tasks",
): FindingsJson["findings"][number] {
  return {
    id,
    category: "impl-defect",
    action,
    status,
    ...(summary !== undefined ? { summary } : {}),
  } as FindingsJson["findings"][number];
}

function evidenceWithCovers(id: string, covers: string[]): EvidenceJson["evidence"][number] {
  return {
    schema_version: 2,
    at: "2026-05-15T10:00:00.000Z",
    id,
    kind: "local-check",
    iteration: 1,
    actor: "cli:loaf",
    result: "pass",
    summary: "x",
    covers,
  } as unknown as EvidenceJson["evidence"][number];
}

function tasksWith(ids: string[]): TasksJson {
  return {
    schema_version: 2,
    version: 1,
    based_on: { spec: 1 },
    tasks: ids.map((id) => ({ id })),
  } as unknown as TasksJson;
}

// ── composeSessionStartContext ──────────────────────────────────────────
describe("composeSessionStartContext", () => {
  test("banner + prompt_inject for a known sub_state", () => {
    const ctx = composeSessionStartContext({
      sub_state: "TRIAGE.score",
      iteration: 1,
      open_findings: [],
      pending: [],
    });
    expect(ctx).toContain("loaf session — TRIAGE.score (iteration 1)");
    expect(ctx).toContain("Next action: Score 0-100");
    expect(ctx).not.toContain("Open findings");
    expect(ctx).not.toContain("Pending:");
  });

  test("includes open findings + head pending when present", () => {
    const ctx = composeSessionStartContext({
      sub_state: "EXECUTE.work",
      iteration: 3,
      open_findings: [finding("FND-001", "open", "flaky test")],
      pending: [pending("PEND-0001", "approve gate?"), pending("PEND-0002", "second")],
    });
    expect(ctx).toContain("(iteration 3)");
    expect(ctx).toContain("Open findings (1): FND-001 [impl-defect/amend-tasks] flaky test");
    // head pending only (first in the live queue)
    expect(ctx).toContain("Pending: PEND-0001 [gate_decision] approve gate?");
    expect(ctx).not.toContain("PEND-0002");
  });

  test("terminal DONE.* renders banner with no Next action line", () => {
    const ctx = composeSessionStartContext({
      sub_state: "DONE.delivered",
      iteration: 1,
      open_findings: [],
      pending: [],
    });
    expect(ctx).toContain("loaf session — DONE.delivered");
    expect(ctx).not.toContain("Next action:");
  });

  test("sessionStartHookOutput wraps exactly in the Claude Code envelope", () => {
    const out = sessionStartHookOutput("hello");
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "hello" },
    });
  });
});

// ── runClosureWarnings ──────────────────────────────────────────────────
describe("runClosureWarnings", () => {
  const cleanFindings: FindingsJson = { schema_version: 2, findings: [] };
  const noEvidence: EvidenceJson = { schema_version: 2, evidence: [] };

  test("clean projections → no warnings", () => {
    const w = runClosureWarnings({
      state: {} as never,
      tasks: tasksWith(["T-001"]),
      evidence: noEvidence,
      findings: cleanFindings,
    });
    expect(w).toEqual([]);
  });

  test("orphan evidence (covers T-NNN absent from tasks.json) → warning", () => {
    const w = runClosureWarnings({
      state: {} as never,
      tasks: tasksWith(["T-001"]),
      evidence: { schema_version: 2, evidence: [evidenceWithCovers("EV-000001", ["T-999"])] },
      findings: cleanFindings,
    });
    expect(
      w.some((line) => line.includes("orphan evidence") && line.includes("EV-000001→T-999")),
    ).toBe(true);
  });

  test("covers a present task id → no orphan warning", () => {
    const w = runClosureWarnings({
      state: {} as never,
      tasks: tasksWith(["T-001"]),
      evidence: { schema_version: 2, evidence: [evidenceWithCovers("EV-000001", ["T-001"])] },
      findings: cleanFindings,
    });
    expect(w).toEqual([]);
  });

  test("REQ/SCEN/VIS covers are NOT flagged (deferred, not in MVP scope)", () => {
    const w = runClosureWarnings({
      state: {} as never,
      tasks: tasksWith([]),
      evidence: {
        schema_version: 2,
        evidence: [evidenceWithCovers("EV-000001", ["REQ-AUTH-001"])],
      },
      findings: cleanFindings,
    });
    expect(w).toEqual([]);
  });

  test("open findings → summary warning with ids; closed ignored", () => {
    const w = runClosureWarnings({
      state: {} as never,
      tasks: null,
      evidence: noEvidence,
      findings: {
        schema_version: 2,
        findings: [
          finding("FND-001", "open"),
          finding("FND-002", "closed"),
          finding("FND-003", "open"),
        ],
      },
    });
    const line = w.find((l) => l.includes("open actionable findings"));
    expect(line).toBeDefined();
    expect(line).toContain("FND-001");
    expect(line).toContain("FND-003");
    expect(line).not.toContain("FND-002");
  });

  test("deferred open findings are not closure warnings; mixed warnings name only actionable ids", () => {
    const deferredOnly = runClosureWarnings({
      state: {} as never,
      tasks: null,
      evidence: noEvidence,
      findings: {
        schema_version: 2,
        findings: [
          finding("FND-001", "open", undefined, "backlog"),
          finding("FND-002", "open", undefined, "defer"),
        ],
      },
    });
    expect(deferredOnly).toEqual([
      "deferred findings carried (2): FND-001 (backlog), FND-002 (defer)",
    ]);

    const mixed = runClosureWarnings({
      state: {} as never,
      tasks: null,
      evidence: noEvidence,
      findings: {
        schema_version: 2,
        findings: [
          finding("FND-001", "open", undefined, "backlog"),
          finding("FND-002", "open", undefined, "fix-impl"),
        ],
      },
    });
    expect(mixed).toEqual([
      "open actionable findings (1): FND-002",
      "deferred findings carried (1): FND-001 (backlog)",
    ]);
  });
});
