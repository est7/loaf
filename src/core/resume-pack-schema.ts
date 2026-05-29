// Phase 16 SC-13a — runtime mirror of `docs/schemas.ts:ResumePack`.
//
// Stable-core layer does not import from docs/ directly (per project
// pattern). Drift between this mirror and docs is caught by
// `tests/cli/resume-pack-runtime-lockstep.test.ts` which feeds the same
// fixtures through both schemas.
//
// Field-level naming asymmetry preserved:
//   - docs uses `PendingPromptEntry` (defined in docs/schemas.ts)
//   - runtime uses `PendingQueueEntry` (from projection-schema.ts)
// Both have the same JSON shape; the lockstep test exercises that.

import { z } from "zod";
import { PendingQueueEntry, StateProjection } from "./projection-schema.js";

/** Cap on `recent_evidence` / `recent_findings` arrays per ResumePack.
 *  Mirrored in `docs/schemas.ts:RESUME_PACK_RECENT_CAP`. */
export const RESUME_PACK_RECENT_CAP = 10;

/** TasksActiveSummary — mirror of docs/schemas.ts §20.
 *  current_step is null when no step on the in_progress/ready task is
 *  currently running (i.e. between steps or paused). */
export const TasksActiveSummary = z
  .object({
    task_id: z.string().regex(/^T-\d{3,}$/),
    status: z.enum(["pending", "ready", "in_progress", "done", "abandoned"]),
    current_step: z.string().nullable(),
  })
  .strict();
export type TasksActiveSummary = z.infer<typeof TasksActiveSummary>;

export const ResumePack = z
  .object({
    schema_version: z.literal(2),
    at: z.string().datetime(),
    session_id: z.string().uuid(),
    reason: z.string().min(5),
    state_snapshot: StateProjection,
    tasks_active_summary: z.array(TasksActiveSummary).default([]),
    recent_evidence: z
      .array(z.string().regex(/^EV-\d{6,}$/))
      .max(RESUME_PACK_RECENT_CAP),
    recent_findings: z
      .array(z.string().regex(/^FND-\d{3,}$/))
      .max(RESUME_PACK_RECENT_CAP),
    open_pending: PendingQueueEntry.nullable(),
    notes: z.string().optional(),
  })
  .strict();
export type ResumePack = z.infer<typeof ResumePack>;
