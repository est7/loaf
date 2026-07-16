// Phase 16 SC-13a — canonical ResumePack runtime contract.
//
// Stable-core layer does not import from docs/ directly (per project
// pattern). `tests/cli/resume-pack-schema.test.ts` pins this owner directly.
//
// PendingQueueEntry comes from projection-schema.ts and carries the public JSON shape.

import { z } from "zod";
import { PendingQueueEntry, StateProjection } from "./projection-schema.js";

/** Cap on `recent_evidence` / `recent_findings` arrays per ResumePack.
 *  Shared by both recent-id arrays below. */
export const RESUME_PACK_RECENT_CAP = 10;

/** TasksActiveSummary — resume-pack active-task projection.
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
    recent_evidence: z.array(z.string().regex(/^EV-\d{6,}$/)).max(RESUME_PACK_RECENT_CAP),
    recent_findings: z.array(z.string().regex(/^FND-\d{3,}$/)).max(RESUME_PACK_RECENT_CAP),
    open_pending: PendingQueueEntry.nullable(),
    notes: z.string().optional(),
  })
  .strict();
export type ResumePack = z.infer<typeof ResumePack>;
