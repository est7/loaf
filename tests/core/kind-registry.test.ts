// L2 — kind-registry preservation. Pins the four derived surfaces against
// EXPLICIT legacy fixtures transcribed from the pre-L2 source (NOT
// derived-vs-derived — codex's non-tautological requirement). Payload schemas
// are compared by reference identity (toBe); sub_state guards by sentinel
// identity / sorted members; actor + set surfaces by exact / sorted contents.
// The full command/preflight suite is the behavior-outcome proof; this file is
// the direct table-content lock.

import { describe, expect, expectTypeOf, test } from "vitest";

import {
  ActorString,
  EntryKind,
  SubState,
  CeremonyPayload,
  EvidenceAddedPayload,
  FindingClosedPayload,
  FindingRaisedPayload,
  GateDecidedPayload,
  LessonRecordedPayload,
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
  ENTRY_SCHEMA_VERSIONS,
  KIND_REGISTRY,
  isSubStateAllowed,
  PER_KIND_ACTOR,
  PER_KIND_PAYLOAD,
  PER_KIND_SUB_STATE,
  SPEC_EMITTING_KINDS,
} from "../../src/core/kind-registry.js";
import {
  actorPrefix,
  type ActorPrefix,
  ANY_NON_DONE,
  ANY_SUB_STATE,
} from "../../src/core/kind-guards.js";

const sorted = (s: Iterable<string>): string[] => [...s].sort();

describe("kind-registry — totality + invariants", () => {
  test("registry keys == the EntryKind enum (27 kinds)", () => {
    expect(sorted(Object.keys(KIND_REGISTRY))).toEqual(sorted(EntryKind.options));
    expect(Object.keys(KIND_REGISTRY)).toHaveLength(27);
  });
  test("current versions are total, registry-owned, and @1 for every current kind", () => {
    expect(ENTRY_SCHEMA_VERSIONS).toEqual(
      Object.fromEntries(EntryKind.options.map((kind) => [kind, 1])),
    );
    for (const kind of EntryKind.options) {
      expect(KIND_REGISTRY[kind].entrySchemaVersion, kind).toBe(1);
      expect(ENTRY_SCHEMA_VERSIONS[kind], kind).toBe(KIND_REGISTRY[kind].entrySchemaVersion);
    }
  });
});

describe("preservation — set surfaces (legacy fixtures)", () => {
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
  };
  test.each(Object.keys(EXPECTED))("%s → same schema const", (kind) => {
    expect(PER_KIND_PAYLOAD[kind as EntryKind]).toBe(EXPECTED[kind]);
  });
});

describe("preservation — PER_KIND_ACTOR (exact arrays, all 27)", () => {
  const ALL_ACTOR_PREFIXES = ["human", "skill", "ci", "cli"];
  const EXPECTED: Record<string, string[]> = {
    "event:phase_advanced": ALL_ACTOR_PREFIXES,
    "event:ceremony_set": ALL_ACTOR_PREFIXES,
    "event:tasks_planned": ALL_ACTOR_PREFIXES,
    "event:tasks_amended": ALL_ACTOR_PREFIXES,
    "event:task_claimed": ALL_ACTOR_PREFIXES,
    "event:task_step_started": ALL_ACTOR_PREFIXES,
    "event:task_step_done": ALL_ACTOR_PREFIXES,
    "event:task_step_reset": ["cli"],
    "event:task_abandoned": ALL_ACTOR_PREFIXES,
    "event:spec_req_added": ALL_ACTOR_PREFIXES,
    "event:spec_scenario_added": ALL_ACTOR_PREFIXES,
    "event:spec_visual_added": ALL_ACTOR_PREFIXES,
    "event:spec_submitted": ALL_ACTOR_PREFIXES,
    "evidence:added": ALL_ACTOR_PREFIXES,
    "lesson:recorded": ["human"],
    "finding:raised": ALL_ACTOR_PREFIXES,
    "finding:closed": ALL_ACTOR_PREFIXES,
    "pending:added": ALL_ACTOR_PREFIXES,
    "pending:resolved": ALL_ACTOR_PREFIXES,
    "gate:decided": ["human"],
    "session:started": ALL_ACTOR_PREFIXES,
    "session:resumed": ALL_ACTOR_PREFIXES,
    "session:delivered": ["human"],
    "session:archived": ["human"],
    "session:abandoned": ["human"],
    "spike:converted": ["human"],
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

// Literal policy oracles: shared derivation must not hide cross-owner drift.
const AMEND_SPEC_SOURCES: readonly SubState[] = [
  "EXECUTE.plan",
  "EXECUTE.work",
  "EXECUTE.done",
  "VERIFY.plan",
  "VERIFY.run",
  "VERIFY.review",
  "VERIFY.acceptance",
  "VERIFY.visual",
  "VERIFY.accept",
];
const FIX_SOURCES: readonly SubState[] = [
  "EXECUTE.work",
  "EXECUTE.done",
  "VERIFY.plan",
  "VERIFY.run",
  "VERIFY.review",
  "VERIFY.acceptance",
  "VERIFY.visual",
  "VERIFY.accept",
];

describe("back-edge source authority preservation", () => {
  test.each([
    "event:tasks_amended",
    "finding:raised",
    "finding:closed",
    "evidence:added",
  ] as const)("%s preserves the literal amend-spec band and its order", (kind) => {
    expect([...(PER_KIND_SUB_STATE[kind] as ReadonlySet<SubState>)]).toEqual(AMEND_SPEC_SOURCES);
    for (const source of SubState.options) {
      expect(isSubStateAllowed(kind, source), `${kind} from ${source}`).toBe(
        AMEND_SPEC_SOURCES.includes(source),
      );
    }
  });
  test("task_step_reset preserves the literal fix-impl/fix-test band and its order", () => {
    expect([...(PER_KIND_SUB_STATE["event:task_step_reset"] as ReadonlySet<SubState>)]).toEqual(
      FIX_SOURCES,
    );
    for (const source of SubState.options) {
      expect(isSubStateAllowed("event:task_step_reset", source), source).toBe(
        FIX_SOURCES.includes(source),
      );
    }
  });
});

test("permission prefixes exclude migration while the stable envelope still recognizes it", () => {
  expectTypeOf<ActorPrefix>().toEqualTypeOf<"human" | "skill" | "ci" | "cli">();
  expect(actorPrefix("migration:retired")).toBeNull();
  expect(ActorString.safeParse("migration:retired").success).toBe(true);
});
