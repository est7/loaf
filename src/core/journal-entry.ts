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

// AttachmentRef — per-entry sidecar pointer (ADR-0005 §3.2 / Stage 4).
// `path` is relative to `.loaf/<feature>/` (e.g. "attachments/JE-000123/summary.txt").
// The reducer verifies `sha256` matches the on-disk file when applying.
export const AttachmentRef = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
  })
  .strict();
export type AttachmentRef = z.infer<typeof AttachmentRef>;

// LongTextField — text fields that may exceed the 8KB sidecar threshold. The
// inline form survives until step 4 (sidecar finalize). The sidecar form is
// what lands in journal-appended payloads after promotion.
export const SIDECAR_THRESHOLD_BYTES = 8 * 1024;

export const LongTextField = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inline"), text: z.string() }).strict(),
  z.object({ mode: z.literal("sidecar"), ref: AttachmentRef }).strict(),
]);
export type LongTextField = z.infer<typeof LongTextField>;

// migration:snapshot_imported payload (Stage 5, ADR-0005 §5.2).
// Gate #3 — schema is .strict() with ONLY AttachmentRef manifest fields.
// Inline artifact bodies are rejected at Zod parse, preventing a v0.0.x
// migration entry from ballooning past 64KB.
export const MigrationSnapshotImportedPayload = z
  .object({
    source_schema_version: z.number().int().positive(),
    migrated_at: z.string().datetime(),
    artifacts: z
      .object({
        state: AttachmentRef,
        tasks: AttachmentRef,
        spec_md: AttachmentRef,
        evidence: AttachmentRef,
        findings: AttachmentRef,
        pending: AttachmentRef,
      })
      .strict(),
  })
  .strict();
export type MigrationSnapshotImportedPayload = z.infer<typeof MigrationSnapshotImportedPayload>;

// SubState — closed set per protocol.md §2.1 (20 sub-states across 6 phases).
// State machine cursor; reducer projects this from `event:phase_advanced` /
// `gate:decided` entries via the shared validateTransition helper (Gate #1).
export const SubState = z.enum([
  "TRIAGE.score", "TRIAGE.confirm",
  "SPEC.proposal", "SPEC.spec", "SPEC.plan", "SPEC.design",
  "EXECUTE.plan", "EXECUTE.work", "EXECUTE.done",
  "VERIFY.plan", "VERIFY.run", "VERIFY.review", "VERIFY.acceptance",
  "VERIFY.visual", "VERIFY.accept",
  "SETTLE.reconcile", "SETTLE.lessons",
  "DONE.delivered", "DONE.archived", "DONE.abandoned",
]);
export type SubState = z.infer<typeof SubState>;

// Ceremony — six-flag schema from protocol.md §3 (rev 5.x PRESETS quick /
// light / standard / deep). Drives phase activation + strict-mode gates +
// VERIFY.accept fork (settle_phase decides SETTLE.reconcile vs DONE.delivered).
export const Ceremony = z
  .object({
    spec_phase: z.boolean(),
    verify_phase: z.boolean(),
    settle_phase: z.boolean(),
    strict_spec_review: z.boolean(),
    lessons_required: z.enum(["must", "may", "skip"]),
    strict_drift_check: z.boolean(),
  })
  .refine((c) => !c.settle_phase || c.verify_phase, {
    message: "settle_phase=true requires verify_phase=true",
  })
  .refine((c) => !c.strict_spec_review || c.spec_phase, {
    message: "strict_spec_review=true requires spec_phase=true",
  })
  .refine((c) => c.lessons_required === "skip" || c.settle_phase, {
    message: "lessons_required!=skip requires settle_phase=true",
  })
  .refine((c) => !c.strict_drift_check || c.settle_phase, {
    message: "strict_drift_check=true requires settle_phase=true",
  });
export type Ceremony = z.infer<typeof Ceremony>;

// GateName — closed set per protocol.md §5 (two human gates).
export const GateName = z.enum(["spec-lock", "verify-accept"]);
export type GateName = z.infer<typeof GateName>;

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
