// Projection-container schemas — runtime mirror for the `loaf doctor
// --rebuild` write path (Phase 14 SC1, ADR-0005 §3.6 / findings.md F-018).
//
// `loaf doctor --rebuild` replays the journal seq=0 and re-serializes the
// four fully-journal-derived projection files under `.loaf/<feature>/
// snapshots/`. The on-disk read contracts these schemas validate:
//
//   tasks.json     → TasksJson      (mirrors docs/schemas.ts §14)
//   evidence.json  → EvidenceJson   (new container, codex r156 Q2)
//   findings.json  → FindingsJson   (new container — finding-state list)
//   pending.json   → PendingJson    (new container — projection entries)
//
// `state.json` is intentionally absent: its `StateJson` contract carries
// fields with NO journal source (session_label / cwd / complexity_score …),
// so a faithful rebuild needs a schema-split — deferred (F-018, own slice).
//
// Layering mirrors the other neutral `*-schema.ts` modules: this module
// imports the per-domain payload shapes (TaskFullPayload / EvidenceFullShape)
// and composes the container schemas. The canonical mirror of these schemas
// lives in docs/schemas.ts §14/§16/§17 (Zod source-of-truth doc).
//
// `EvidenceJson` / `FindingsJson` / `PendingJson` carry NO `version` field:
// only `TasksJson.version` is justified (whole-replacement task-plan
// contract — plan + amend entries are counted). Evidence / findings /
// pending are append-only ledgers with no equivalent counter (codex r156 Q2).

import { z } from "zod";

import { TaskFullPayload } from "./task-schema.js";
import {
  EvidenceFullShape,
  EvidenceKind,
  EvidenceResult,
} from "./evidence-schema.js";
import { FindingAction, FindingCategory } from "./finding-schema.js";
import { PendingId, PendingPromptKind } from "./journal-entry.js";

// Projection schema-version pin — mirrors docs/schemas.ts:417-418
// (SchemaVersion = z.literal(2)) and snapshot.ts FEATURE_SCHEMA_VERSION.
export const PROJECTION_SCHEMA_VERSION = 2 as const;
const SchemaVersionLiteral = z.literal(PROJECTION_SCHEMA_VERSION);

// ── tasks.json — TasksJson (mirror docs/schemas.ts §14:1672-1678) ───────
//
// Whole-replacement task-plan contract: `version` counts the
// `event:tasks_planned` + `event:tasks_amended` entries on the journal.
// `based_on.spec` is `.positive()` — a tasks.json cannot exist without a
// task plan, which is why composeTasksJson returns null (file skipped)
// when no `tasks_planned` has landed.
export const TasksJson = z
  .object({
    schema_version: SchemaVersionLiteral,
    version: z.number().int().positive(),
    based_on: z.object({ spec: z.number().int().positive() }),
    tasks: z.array(TaskFullPayload),
  })
  .strict();
export type TasksJson = z.infer<typeof TasksJson>;

// ── evidence.json — EvidenceJson (new container, codex r156 Q2) ─────────
//
// Each projection item is the journal `evidence:added` payload
// (EvidenceFullShape) extended with the two envelope-owned fields the
// payload schema deliberately omits: `schema_version` + `at`. Together
// they reconstruct the documented §16 EvidenceEntry read contract.
export const EvidenceEntry = EvidenceFullShape.extend({
  schema_version: SchemaVersionLiteral,
  at: z.string().datetime(),
}).strict();
export type EvidenceEntry = z.infer<typeof EvidenceEntry>;

export const EvidenceJson = z
  .object({
    schema_version: SchemaVersionLiteral,
    evidence: z.array(EvidenceEntry),
  })
  .strict();
export type EvidenceJson = z.infer<typeof EvidenceJson>;

// ── findings.json — FindingsJson (new container) ────────────────────────
//
// The slim `FindingState` projection IS the findings.json item shape —
// the reducer already projects every field a reader needs (id / category /
// action / status + payload-derived summary / reason / target). NOT the
// legacy §17 `FindingsEvent` jsonl event schema (see docs/schemas.ts §17
// annotation): that is the per-event journal/jsonl form; this is the
// finding-STATE list a `--rebuild` materializes.
//
// category / action use the closed `FindingCategory` / `FindingAction`
// enums — the disk projection mirrors the public §5 contract, not the
// reducer's loose `string` field typing. `finding:raised` already
// validates the enums at append, so tightening here catches corrupt
// replay / migration output early (codex r158 F1).
const FindingStateShape = z
  .object({
    id: z.string().regex(/^FND-\d{3,}$/),
    category: FindingCategory,
    action: FindingAction,
    status: z.enum(["open", "closed"]),
    summary: z.string().optional(),
    reason: z.string().optional(),
    target: z
      .object({ task_id: z.string().regex(/^T-\d{3,}$/), step: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export const FindingsJson = z
  .object({
    schema_version: SchemaVersionLiteral,
    findings: z.array(FindingStateShape),
  })
  .strict();
export type FindingsJson = z.infer<typeof FindingsJson>;

// ── pending.json — PendingJson (new container) ──────────────────────────
//
// PendingProjectionEntry = the documented §11 `PendingPromptEntry` fields
// (pending_id / kind / question / options? / blocks / raised_at /
// raised_by / at / raised_by_task_id?) PLUS `resolved: boolean`.
//
// The journal `pending:added` payload carries only id / kind / question
// (+ optional options / task_id) and ONE envelope timestamp + actor; the
// rich `PendingPromptEntry` fields are collapsed onto journal truth:
//   - raised_at + at  ← the single envelope timestamp
//   - raised_by       ← the envelope actor
//   - blocks          ← the constant "advance" (never carried on payload)
//   - resolved        ← true iff a matching `pending:resolved` entry exists
export const PendingProjectionEntry = z
  .object({
    pending_id: PendingId,
    kind: PendingPromptKind,
    question: z.string().min(3),
    options: z.array(z.string()).optional(),
    blocks: z.enum(["advance", "gate", "deliver", "all"]),
    raised_at: z.string().datetime(),
    raised_by: z.string().min(1),
    at: z.string().datetime(),
    raised_by_task_id: z.string().regex(/^T-\d{3,}$/).optional(),
    resolved: z.boolean(),
  })
  .strict();
export type PendingProjectionEntry = z.infer<typeof PendingProjectionEntry>;

export const PendingJson = z
  .object({
    schema_version: SchemaVersionLiteral,
    pending: z.array(PendingProjectionEntry),
  })
  .strict();
export type PendingJson = z.infer<typeof PendingJson>;

// Re-export the enum types used by the schema, so a consumer of the
// container types does not have to also reach into evidence-schema.
export type { EvidenceKind, EvidenceResult };
