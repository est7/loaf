import { describe, expect, test } from "vitest";

import { ResumePack } from "../../src/core/resume-pack-schema.js";

const VALID_FIXTURE = {
  schema_version: 2,
  at: "2026-05-29T08:00:00.000Z",
  session_id: "550e8400-e29b-41d4-a716-446655440000",
  reason: "context overflow approaching at EXECUTE.work",
  state_snapshot: {
    schema_version: 2,
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    session_label: null,
    workspace: "default",
    loaf_version_required: null,
    phase: "EXECUTE" as const,
    sub_state: "EXECUTE.work" as const,
    iteration: 1,
    spec_locked: true,
    verify_accepted: false,
    pending: [],
    ceremony: {
      spec_phase: true,
      verify_phase: true,
      settle_phase: false,
      strict_spec_review: false,
      lessons_required: "skip" as const,
      strict_drift_check: false,
    },
    ceremony_label: "standard",
    complexity_score: null,
    based_on: { spec: 1, tasks: 1 },
    spec_version: 1,
    created_at: "2026-05-29T06:00:00.000Z",
    updated_at: "2026-05-29T07:00:00.000Z",
  },
  tasks_active_summary: [],
  recent_evidence: [],
  recent_findings: [],
  open_pending: null,
};

describe("ResumePack machine contract", () => {
  test("accepts the canonical fixture", () => {
    expect(ResumePack.safeParse(VALID_FIXTURE).success).toBe(true);
  });

  test("requires schema_version", () => {
    const invalid: Record<string, unknown> = { ...VALID_FIXTURE };
    delete invalid["schema_version"];
    expect(ResumePack.safeParse(invalid).success).toBe(false);
  });

  test("caps recent evidence and findings at ten", () => {
    expect(
      ResumePack.safeParse({
        ...VALID_FIXTURE,
        recent_evidence: Array.from(
          { length: 11 },
          (_, index) => `EV-${String(index + 1).padStart(6, "0")}`,
        ),
      }).success,
    ).toBe(false);
    expect(
      ResumePack.safeParse({
        ...VALID_FIXTURE,
        recent_findings: Array.from(
          { length: 11 },
          (_, index) => `FND-${String(index + 1).padStart(3, "0")}`,
        ),
      }).success,
    ).toBe(false);
  });

  test("accepts pending and active-task projection shapes", () => {
    expect(
      ResumePack.safeParse({
        ...VALID_FIXTURE,
        open_pending: {
          pending_id: "PEND-0001",
          kind: "gate_decision",
          question: "approve spec-lock?",
          blocks: "advance",
          raised_at: "2026-05-29T07:55:00.000Z",
          raised_by: "human:dev@example.com",
          at: "2026-05-29T07:55:00.000Z",
        },
        tasks_active_summary: [
          { task_id: "T-001", status: "in_progress", current_step: "implement" },
          { task_id: "T-002", status: "ready", current_step: null },
        ],
      }).success,
    ).toBe(true);
  });
});
