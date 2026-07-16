// Projection-container schemas — runtime mirror for the `loaf doctor
// --rebuild` write path (Phase 14 SC1, ADR-0005 §3.6 / findings.md F-018).
//
// `loaf doctor --rebuild` replays the journal seq=0 and re-serializes the
// five fully-journal-derived projection files under `.loaf/<feature>/
// snapshots/`. The on-disk read contracts these schemas validate:
//
//   state.json     → StateProjection (Phase 15 SC1 — F-019)
//   tasks.json     → TasksJson
//   evidence.json  → EvidenceJson   (new container, codex r156 Q2)
//   findings.json  → FindingsJson   (new container — finding-state list)
//   pending.json   → PendingJson    (new container — projection entries)
//
// Phase 15 SC1 split the old monolithic `StateJson` into `StateProjection`
// (the journal-derived half, below) and `SessionRuntimeFile`
// (machine-local `cwd` / `debug` / `heartbeat_at`,
// never replay-derived, never written by `--rebuild`). `complexity_score`
// has no journal source yet and stays `null` in the projection (F-019).
//
// Layering mirrors the other neutral `*-schema.ts` modules: this module
// imports the per-domain payload shapes (TaskFullPayload / EvidenceFullShape)
// and composes the canonical container schemas.
//
// `EvidenceJson` / `FindingsJson` / `PendingJson` carry NO `version` field:
// only `TasksJson.version` is justified (whole-replacement task-plan
// contract — plan + amend entries are counted). Evidence / findings /
// pending are append-only ledgers with no equivalent counter (codex r156 Q2).

import { z } from "zod";

import { TaskFullPayload } from "./task-schema.js";
import { EvidenceFullShape, EvidenceKind, EvidenceResult } from "./evidence-schema.js";
import { FindingAction, FindingCategory } from "./finding-schema.js";
import { Ceremony, PendingId, PendingPromptKind, SubState } from "./journal-entry.js";

// Projection schema-version pin shared with snapshot.ts FEATURE_SCHEMA_VERSION.
export const PROJECTION_SCHEMA_VERSION = 2 as const;
const SchemaVersionLiteral = z.literal(PROJECTION_SCHEMA_VERSION);

export const SessionRuntimeFile = z
  .object({
    schema_version: SchemaVersionLiteral,
    session_id: z.string().min(1),
    cwd: z.string(),
    debug: z.boolean(),
    heartbeat_at: z.string().datetime(),
  })
  .strict();
export type SessionRuntimeFile = z.infer<typeof SessionRuntimeFile>;

// ── tasks.json — TasksJson ──────────────────────────────────────────────
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
// legacy `FindingsEvent` jsonl event schema: that is the per-event
// journal/jsonl form; this is the
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

// ── pending entries — PendingQueueEntry / PendingProjectionEntry ────────
//
// PendingQueueEntry = the documented §11 `PendingPromptEntry` fields
// (pending_id / kind / question / options? / blocks / raised_at /
// raised_by / at / raised_by_task_id?). It is the LIVE-queue shape, with
// NO `resolved` flag — `state.json` (§12 `StateProjection.pending`) carries
// exactly this: only unresolved blockers (codex r168 BLOCK 1 — `state.json`
// is a public read contract and must not leak `pending.json`'s tagged form).
//
// PendingProjectionEntry = PendingQueueEntry PLUS `resolved: boolean` —
// `pending.json`'s entry: the full append-only ledger, every `pending:added`
// tagged with whether a matching `pending:resolved` exists.
//
// The journal `pending:added` payload carries only id / kind / question
// (+ optional options / task_id) and ONE envelope timestamp + actor; the
// rich fields are collapsed onto journal truth:
//   - raised_at + at  ← the single envelope timestamp
//   - raised_by       ← the envelope actor
//   - blocks          ← the constant "advance" (never carried on payload)
//   - resolved        ← true iff a matching `pending:resolved` entry exists
export const PendingQueueEntry = z
  .object({
    pending_id: PendingId,
    kind: PendingPromptKind,
    question: z.string().min(3),
    options: z.array(z.string()).optional(),
    blocks: z.enum(["advance", "gate", "deliver", "all"]),
    raised_at: z.string().datetime(),
    raised_by: z.string().min(1),
    at: z.string().datetime(),
    raised_by_task_id: z
      .string()
      .regex(/^T-\d{3,}$/)
      .optional(),
  })
  .strict();
export type PendingQueueEntry = z.infer<typeof PendingQueueEntry>;

export const PendingProjectionEntry = PendingQueueEntry.extend({
  resolved: z.boolean(),
}).strict();
export type PendingProjectionEntry = z.infer<typeof PendingProjectionEntry>;

export const PendingJson = z
  .object({
    schema_version: SchemaVersionLiteral,
    pending: z.array(PendingProjectionEntry),
  })
  .strict();
export type PendingJson = z.infer<typeof PendingJson>;

// ── state.json — StateProjection (Phase 15 SC1, F-019) ──────────────────
//
// The journal-derived half of the rev-4.0 `StateJson` read contract
// `loaf doctor --rebuild` re-serializes this from
// journal truth alone; mutate step 8 (Phase 15 SC3) will maintain it live.
//
// The non-journal half of the old monolith — `cwd` / `debug` /
// `heartbeat_at` — split out to `SessionRuntimeFile`: machine-local liveness,
// never replay-derived, never written by
// `--rebuild` (codex r167 Q3).
//
// Bucket-C identity fields (`session_label` / `workspace` /
// `loaf_version_required` / `ceremony_label`) ride the widened
// `session:started` payload. A pre-SC1 (legacy) entry lacks them;
// `composeStateProjection` applies the documented fallback — `workspace`
// → "default", `ceremony_label` → "", `session_label` &
// `loaf_version_required` → null. `complexity_score` has no journal
// source at all (codex r167 Q2) so it is `null` until a future
// TRIAGE-scoring slice — nullable here, never invented.
const StateProjectionPhase = z.enum(["TRIAGE", "SPEC", "EXECUTE", "VERIFY", "SETTLE", "DONE"]);

// `pending` is the LIVE FIFO queue — only entries with no matching
// `pending:resolved`, carried as `PendingQueueEntry` (NO `resolved` flag —
// that tagged form belongs to `pending.json` alone; codex r168 BLOCK 1).
// The DONE.* refine below depends on the queue being empty once every
// blocker is resolved.
export const StateProjection = z
  .object({
    schema_version: SchemaVersionLiteral,
    // ── identity ──
    session_id: z.string().min(1),
    session_label: z.string().min(3).nullable(),
    workspace: z.string().min(1),
    loaf_version_required: z
      .string()
      // Mirrors SessionStartedPayload — accepts semver prerelease +
      // build-metadata pins (codex r181 → r182).
      .regex(/^[\^~]?\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/)
      .nullable(),
    // ── state machine ──
    phase: StateProjectionPhase,
    sub_state: SubState,
    iteration: z.number().int().positive(),
    // ── gate approval flags ──
    spec_locked: z.boolean(),
    verify_accepted: z.boolean(),
    // ── pending FIFO queue (live — unresolved only, no `resolved` flag) ──
    pending: z.array(PendingQueueEntry),
    // ── ceremony & scoring ──
    ceremony: Ceremony,
    ceremony_label: z.string(),
    complexity_score: z.number().int().min(0).max(100).nullable(),
    // ── version refs ──
    based_on: z
      .object({
        spec: z.number().int().nonnegative(),
        tasks: z.number().int().nonnegative(),
      })
      .strict(),
    spec_version: z.number().int().nonnegative(),
    // ── timestamps ──
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict()
  .refine((s) => s.sub_state.startsWith(s.phase + "."), {
    message: "sub_state must start with phase + '.'",
  })
  .refine((s) => !s.phase.startsWith("DONE") || s.pending.length === 0, {
    message: "DONE.* requires pending = [] (live queue empty at terminal)",
  });
export type StateProjection = z.infer<typeof StateProjection>;

// ── ~/.loaf/registry/<session_id>.json — RegistryFile (Phase 16 SC-7) ──
//
// Per-session TUI projection (protocol §4.12 + RegistryFile
// canonical). Atomic temp+rename write at `~/.loaf/registry/<id>.json`,
// mode 0o600. Best-effort derived projection — NEVER gate authority;
// readers (TUI / sessions list) tolerate stale, doctor --rebuild-registry
// reconstructs from canonical artifacts (future SC).
//
// Canonical RegistryFile runtime contract. Lives here to keep the
// runtime dependency boundary clean (no src/ imports from docs/, enforced by
// tests/scripts/sc7-runtime-import-gate.test.ts per codex r280 P1).
//
// Field derivation contract (mirrors composeStateProjection from
// projection-writer.ts):
//   - session_label = SessionStartedPayload.session_label ?? ""
//     (NOT nullable — empty-string fallback
//     is the narrowest schema-valid choice; codex r280 P2)
//   - workspace = SessionStartedPayload.workspace ?? "default"
//   - ceremony_label = SessionStartedPayload.ceremony_label ?? ""
//   - feature = SessionStartedPayload.feature (canonical journal source;
//     NOT path.basename(featureDir) — tmp featureDir paths in tests
//     don't carry the canonical name)
//   - active_tasks = snapshot.tasks.filter(t => t.status === "in_progress")
//   - pending = composePendingJson(entries).pending.filter(!resolved)
//     [0] with `resolved` stripped (head), null when empty
//   - pending_queue_depth = unresolved.length (NOT snapshot.pending.length
//     which includes resolved historical entries; codex r280 P3)
//   - cwd = process.cwd() at write time (best-effort; refresh overwrites)
export const RegistryFile = z
  .object({
    schema_version: SchemaVersionLiteral,
    at: z.string().datetime(),
    session_id: z.string().uuid(),
    // Non-nullable string with empty-string fallback (codex r280 P2).
    session_label: z.string(),
    // Phase 16 SC-7 (codex r281 P2):
    // `.min(1)` matches `SessionStartedPayload.feature`. Kebab-case is
    // convention for production users but not enforced at journal level,
    // so the registry projection accepts whatever the journal carries.
    feature: z.string().min(1),
    cwd: z.string(),
    workspace: z.string().min(1),
    phase: StateProjectionPhase,
    sub_state: SubState,
    iteration: z.number().int().positive(),
    active_tasks: z.array(z.string().regex(/^T-\d{3,}$/)).default([]),
    // Rich `PendingPromptEntry` (NOT slim Snapshot.pending shape) per
    // codex r280 P3. Head = unresolved[0]; null when queue is empty.
    pending: PendingQueueEntry.nullable(),
    pending_queue_depth: z.number().int().nonnegative().default(0),
    ceremony_label: z.string().default(""),
  })
  .strict();
export type RegistryFile = z.infer<typeof RegistryFile>;

// Re-export the enum types used by the schema, so a consumer of the
// container types does not have to also reach into evidence-schema.
export type { EvidenceKind, EvidenceResult };
