// JournalEntry — the SSoT envelope (rev 5.0, ADR-0005 §3.2).
//
// Every line in `.loaf/<feature>/journal.jsonl` is one JournalEntry. The
// envelope carries identity & ordering, actor namespace, schema version, the
// kind discriminator, and an opaque payload. Per-kind payload schemas land
// progressively alongside the reducer (src/core/reducer/* — Stage 2+); Stage 1
// treats payload as z.unknown() and only enforces the envelope.
//
// Spec source: docs/schemas.ts §0a (Zod source of truth) + protocol.md §11.2.

import { z } from "zod";

// Hard byte ceiling per serialized JournalEntry. Mirrors §34
// entry_byte_limit_kb (64KB); enforced by appendEntry at step 5 final
// validate. Long fields exceeding sidecar_threshold_kb (8KB) MUST be
// promoted to attachments/<entry_id>/ via LongTextField sidecar form
// (Stage 4); Stage 1 simply rejects oversize entries outright.
export const ENTRY_BYTE_LIMIT = 64_000;

export const EntryId = z
  .string()
  .regex(/^JE-\d{6,}$/, {
    message: "entry_id must match /^JE-\\d{6,}$/ (e.g. JE-000123)",
  });
export type EntryId = z.infer<typeof EntryId>;

export const ActorString = z
  .string()
  .regex(/^(human|skill|ci|cli|migration):[^\s].*$/, {
    message:
      "actor must be of form '<prefix>:<id>' where prefix ∈ {human, skill, ci, cli, migration}",
  });
export type ActorString = z.infer<typeof ActorString>;

export const EntryKind = z.enum([
  // ── State machine transitions ──
  "event:phase_advanced",
  "event:ceremony_set",
  "event:tasks_planned",
  "event:tasks_amended",
  "event:task_claimed",
  "event:task_step_started",
  "event:task_step_done",
  "event:task_abandoned",
  "event:spec_req_added",
  "event:spec_scenario_added",
  "event:spec_visual_added",
  "event:spec_submitted",
  // ── Domain ledger entries ──
  "evidence:added",
  "finding:raised",
  "finding:closed",
  "pending:added",
  "pending:resolved",
  // ── Human gates ──
  "gate:decided",
  // ── Session lifecycle ──
  "session:started",
  "session:resumed",
  "session:delivered",
  "session:archived",
  "session:abandoned",
  // ── Spike branch closure ──
  "spike:converted",
  // ── Migration ──
  "migration:snapshot_imported",
]);
export type EntryKind = z.infer<typeof EntryKind>;

export const JournalEntry = z
  .object({
    seq: z.number().int().nonnegative(),
    entry_id: EntryId,
    at: z.string().datetime(),
    actor: ActorString,
    entry_schema_version: z.number().int().positive(),
    kind: EntryKind,
    payload: z.unknown(),
    batch_id: z.string().uuid().optional(),
    batch_index: z.number().int().nonnegative().optional(),
    batch_count: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (e) => {
      const present = [e.batch_id, e.batch_index, e.batch_count].filter(
        (v) => v !== undefined,
      ).length;
      return present === 0 || present === 3;
    },
    {
      message:
        "batch_id, batch_index, batch_count must be all-present or all-absent",
    },
  )
  .refine(
    (e) =>
      e.batch_index === undefined ||
      e.batch_count === undefined ||
      e.batch_index < e.batch_count,
    { message: "batch_index must be < batch_count" },
  );
export type JournalEntry = z.infer<typeof JournalEntry>;
