// Phase 16 SC-13a — ResumePack runtime/docs lockstep drift gate.
//
// Codex r346 P3 / r348 P1+P2. Catches drift between
// `docs/schemas.ts:ResumePack` (canonical contract) and
// `src/core/resume-pack-schema.ts:ResumePack` (runtime mirror) on the
// 4 fields most likely to skew:
//   - schema_version
//   - tasks_active_summary shape
//   - recent_* caps (RESUME_PACK_RECENT_CAP = 10)
//   - open_pending PendingPromptEntry/PendingQueueEntry shape

import { describe, expect, test } from "vitest";

import { ResumePack as DocsResumePack } from "../../docs/schemas.js";
import { ResumePack as RuntimeResumePack } from "../../src/core/resume-pack-schema.js";

const VALID_STATE_PROJECTION = {
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
};

const VALID_FIXTURE = {
  schema_version: 2,
  at: "2026-05-29T08:00:00.000Z",
  session_id: "550e8400-e29b-41d4-a716-446655440000",
  reason: "context overflow approaching at EXECUTE.work",
  state_snapshot: VALID_STATE_PROJECTION,
  tasks_active_summary: [],
  recent_evidence: [],
  recent_findings: [],
  open_pending: null,
};

describe("ResumePack runtime/docs lockstep", () => {
  test("valid fixture parses through BOTH schemas", () => {
    expect(DocsResumePack.safeParse(VALID_FIXTURE).success).toBe(true);
    expect(RuntimeResumePack.safeParse(VALID_FIXTURE).success).toBe(true);
  });

  test("invalid: missing schema_version rejected by BOTH", () => {
    const bad: Record<string, unknown> = { ...VALID_FIXTURE };
    delete bad["schema_version"];
    expect(DocsResumePack.safeParse(bad).success).toBe(false);
    expect(RuntimeResumePack.safeParse(bad).success).toBe(false);
  });

  test("cap exceeded: 11 evidence IDs rejected by BOTH (RESUME_PACK_RECENT_CAP=10)", () => {
    const bad = {
      ...VALID_FIXTURE,
      recent_evidence: Array.from({ length: 11 }, (_, i) =>
        `EV-${String(i + 1).padStart(6, "0")}`,
      ),
    };
    expect(DocsResumePack.safeParse(bad).success).toBe(false);
    expect(RuntimeResumePack.safeParse(bad).success).toBe(false);
  });

  test("cap exceeded: 11 finding IDs rejected by BOTH", () => {
    const bad = {
      ...VALID_FIXTURE,
      recent_findings: Array.from({ length: 11 }, (_, i) =>
        `FND-${String(i + 1).padStart(3, "0")}`,
      ),
    };
    expect(DocsResumePack.safeParse(bad).success).toBe(false);
    expect(RuntimeResumePack.safeParse(bad).success).toBe(false);
  });

  test("open_pending PendingPromptEntry/PendingQueueEntry shape: pending_id + kind + question parsed by both", () => {
    const withPending = {
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
    };
    expect(DocsResumePack.safeParse(withPending).success).toBe(true);
    expect(RuntimeResumePack.safeParse(withPending).success).toBe(true);
  });

  test("tasks_active_summary entry shape: task_id / status / current_step", () => {
    const withActive = {
      ...VALID_FIXTURE,
      tasks_active_summary: [
        { task_id: "T-001", status: "in_progress", current_step: "implement" },
        { task_id: "T-002", status: "ready", current_step: null },
      ],
    };
    expect(DocsResumePack.safeParse(withActive).success).toBe(true);
    expect(RuntimeResumePack.safeParse(withActive).success).toBe(true);
  });
});
