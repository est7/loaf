// L2 — kind-registry preservation. Pins the five derived surfaces against
// EXPLICIT legacy fixtures transcribed from the pre-L2 source (NOT
// derived-vs-derived — codex's non-tautological requirement). Payload schemas
// are compared by reference identity (toBe); sub_state guards by sentinel
// identity / sorted members; actor + set surfaces by exact / sorted contents.
// The full command/preflight suite is the behavior-outcome proof; this file is
// the direct table-content lock.

import { describe, expect, test } from "vitest";

import {
  EntryKind,
  CeremonyPayload,
  EvidenceAddedPayload,
  FindingClosedPayload,
  FindingRaisedPayload,
  GateDecidedPayload,
  LessonRecordedPayload,
  MigrationSnapshotImportedPayload,
  PendingAddedPayload,
  PendingResolvedPayload,
  PhaseAdvancedPayload,
  SessionReasonPayload,
  SessionResumedPayload,
  SessionStartedPayload,
  SpecReqAddedPayload,
  SpecScenarioAddedPayload,
  SpecSubmittedPayload,
  SpecVisualAddedPayload,
  SpikeConvertedPayload,
  TaskAbandonedPayload,
  TaskRefPayload,
  TaskStepDonePayload,
  TaskStepRefPayload,
  TaskStepResetPayload,
  TasksAmendedPayload,
  TasksPlannedPayload,
} from "../../src/core/journal-entry.js";
import {
  KIND_REGISTRY,
  PER_KIND_ACTOR,
  PER_KIND_PAYLOAD,
  PER_KIND_SUB_STATE,
  REDUCER_IMPLEMENTED_KINDS,
  SPEC_EMITTING_KINDS,
} from "../../src/core/kind-registry.js";
import { ANY_NON_DONE, ANY_SUB_STATE } from "../../src/core/kind-guards.js";

const sorted = (s: Iterable<string>): string[] => [...s].sort();

describe("kind-registry — totality + invariants", () => {
  test("registry keys == the EntryKind enum (27 kinds)", () => {
    expect(sorted(Object.keys(KIND_REGISTRY))).toEqual(sorted(EntryKind.options));
    expect(Object.keys(KIND_REGISTRY)).toHaveLength(27);
  });

  test("every emitsSpec kind is reducerImplemented", () => {
    for (const [kind, meta] of Object.entries(KIND_REGISTRY)) {
      if (meta.emitsSpec) expect(meta.reducerImplemented, kind).toBe(true);
    }
  });
});

describe("preservation — set surfaces (legacy fixtures)", () => {
  test("REDUCER_IMPLEMENTED_KINDS == all 27 kinds", () => {
    expect(sorted(REDUCER_IMPLEMENTED_KINDS)).toEqual(
      sorted([
        "event:phase_advanced",
        "event:ceremony_set",
        "event:tasks_planned",
        "event:tasks_amended",
        "event:task_claimed",
        "event:task_step_started",
        "event:task_step_done",
        "event:task_step_reset",
        "event:task_abandoned",
        "event:spec_req_added",
        "event:spec_scenario_added",
        "event:spec_visual_added",
        "event:spec_submitted",
        "evidence:added",
        "lesson:recorded",
        "finding:raised",
        "finding:closed",
        "pending:added",
        "pending:resolved",
        "gate:decided",
        "session:started",
        "session:resumed",
        "session:delivered",
        "session:archived",
        "session:abandoned",
        "spike:converted",
        "migration:snapshot_imported",
      ]),
    );
  });

  test("SPEC_EMITTING_KINDS == the 4 spec_* kinds", () => {
    expect(sorted(SPEC_EMITTING_KINDS)).toEqual([
      "event:spec_req_added",
      "event:spec_scenario_added",
      "event:spec_submitted",
      "event:spec_visual_added",
    ]);
  });
});

describe("preservation — PER_KIND_PAYLOAD reference identity (all 27)", () => {
  // Each entry must reuse the SAME journal-entry schema const (===), not a clone.
  const EXPECTED: Record<string, unknown> = {
    "event:phase_advanced": PhaseAdvancedPayload,
    "event:ceremony_set": CeremonyPayload,
    "event:tasks_planned": TasksPlannedPayload,
    "event:tasks_amended": TasksAmendedPayload,
    "event:task_claimed": TaskRefPayload,
    "event:task_step_started": TaskStepRefPayload,
    "event:task_step_done": TaskStepDonePayload,
    "event:task_step_reset": TaskStepResetPayload,
    "event:task_abandoned": TaskAbandonedPayload,
    "event:spec_req_added": SpecReqAddedPayload,
    "event:spec_scenario_added": SpecScenarioAddedPayload,
    "event:spec_visual_added": SpecVisualAddedPayload,
    "event:spec_submitted": SpecSubmittedPayload,
    "evidence:added": EvidenceAddedPayload,
    "lesson:recorded": LessonRecordedPayload,
    "finding:raised": FindingRaisedPayload,
    "finding:closed": FindingClosedPayload,
    "pending:added": PendingAddedPayload,
    "pending:resolved": PendingResolvedPayload,
    "gate:decided": GateDecidedPayload,
    "session:started": SessionStartedPayload,
    "session:resumed": SessionResumedPayload,
    "session:delivered": SessionReasonPayload,
    "session:archived": SessionReasonPayload,
    "session:abandoned": SessionReasonPayload,
    "spike:converted": SpikeConvertedPayload,
    "migration:snapshot_imported": MigrationSnapshotImportedPayload,
  };
  test.each(Object.keys(EXPECTED))("%s → same schema const", (kind) => {
    expect(PER_KIND_PAYLOAD[kind as EntryKind]).toBe(EXPECTED[kind]);
  });
});

describe("preservation — PER_KIND_ACTOR (exact arrays, all 27)", () => {
  const ALL_NON_MIGRATION = ["human", "skill", "ci", "cli"];
  const EXPECTED: Record<string, string[]> = {
    "event:phase_advanced": ALL_NON_MIGRATION,
    "event:ceremony_set": ALL_NON_MIGRATION,
    "event:tasks_planned": ALL_NON_MIGRATION,
    "event:tasks_amended": ALL_NON_MIGRATION,
    "event:task_claimed": ALL_NON_MIGRATION,
    "event:task_step_started": ALL_NON_MIGRATION,
    "event:task_step_done": ALL_NON_MIGRATION,
    "event:task_step_reset": ["cli"],
    "event:task_abandoned": ALL_NON_MIGRATION,
    "event:spec_req_added": ALL_NON_MIGRATION,
    "event:spec_scenario_added": ALL_NON_MIGRATION,
    "event:spec_visual_added": ALL_NON_MIGRATION,
    "event:spec_submitted": ALL_NON_MIGRATION,
    "evidence:added": ALL_NON_MIGRATION,
    "lesson:recorded": ["human"],
    "finding:raised": ALL_NON_MIGRATION,
    "finding:closed": ALL_NON_MIGRATION,
    "pending:added": ALL_NON_MIGRATION,
    "pending:resolved": ALL_NON_MIGRATION,
    "gate:decided": ["human"],
    "session:started": ALL_NON_MIGRATION,
    "session:resumed": ALL_NON_MIGRATION,
    "session:delivered": ["human"],
    "session:archived": ["human"],
    "session:abandoned": ["human"],
    "spike:converted": ["human"],
    "migration:snapshot_imported": ["migration"],
  };
  test.each(Object.keys(EXPECTED))("%s actor whitelist", (kind) => {
    expect(PER_KIND_ACTOR[kind as EntryKind]).toEqual(EXPECTED[kind]);
  });
});

describe("preservation — PER_KIND_SUB_STATE (sentinels + sorted members)", () => {
  test("ANY_SUB_STATE sentinels", () => {
    for (const k of [
      "event:phase_advanced",
      "pending:added",
      "pending:resolved",
      "session:started",
      "session:resumed",
      "migration:snapshot_imported",
    ] as const) {
      expect(PER_KIND_SUB_STATE[k], k).toBe(ANY_SUB_STATE);
    }
  });
  test("ANY_NON_DONE sentinels", () => {
    for (const k of [
      "lesson:recorded",
      "session:archived",
      "session:abandoned",
      "spike:converted",
    ] as const) {
      expect(PER_KIND_SUB_STATE[k], k).toBe(ANY_NON_DONE);
    }
  });
  test("concrete sets (sorted members)", () => {
    const set = (k: EntryKind) => sorted(PER_KIND_SUB_STATE[k] as ReadonlySet<string>);
    expect(set("event:tasks_planned")).toEqual(["EXECUTE.plan", "SPEC.design"]);
    expect(set("event:task_claimed")).toEqual(["EXECUTE.work"]);
    expect(set("event:task_step_reset")).toEqual([
      "EXECUTE.done",
      "EXECUTE.work",
      "VERIFY.accept",
      "VERIFY.acceptance",
      "VERIFY.plan",
      "VERIFY.review",
      "VERIFY.run",
      "VERIFY.visual",
    ]);
    expect(set("event:spec_submitted")).toEqual([
      "SPEC.design",
      "SPEC.plan",
      "SPEC.proposal",
      "SPEC.spec",
    ]);
    expect(set("gate:decided")).toEqual(["SPEC.design", "VERIFY.accept"]);
    expect(set("session:delivered")).toEqual(["EXECUTE.done", "SETTLE.lessons", "VERIFY.accept"]);
    expect(set("evidence:added")).toEqual([
      "EXECUTE.done",
      "EXECUTE.plan",
      "EXECUTE.work",
      "VERIFY.accept",
      "VERIFY.acceptance",
      "VERIFY.plan",
      "VERIFY.review",
      "VERIFY.run",
      "VERIFY.visual",
    ]);
  });
});
