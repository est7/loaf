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

import {
  FeatureIdPayload,
  NeedsClarification,
  RequirementEarsVerifiable,
  ScenarioGherkin,
  VisualContract,
} from "./spec-schema.js";
import {
  TaskFullPayload,
  TaskIdPayload,
} from "./task-schema.js";
import { EvidenceFullPayload } from "./evidence-schema.js";
import {
  FindingAction,
  FindingCategory,
  FindingId,
  FindingTarget,
} from "./finding-schema.js";

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

// ── Per-kind payload schemas (audit r1 fix #4) ──────────────────────────
// Authoritative payload shapes for each EntryKind. Wired into preflight
// (§11.2 step 3) + appendEntry (step 5 final validate) so Gate #2 / Gate #3
// are real schema gates rather than envelope-only checks.

// Generic record fallback for kinds whose payload shape is not yet pinned —
// rejects literal strings / arrays / scalars (which is what Gate #3 needs)
// but accepts any nested object structure.
const RecordPayload = z.record(z.string(), z.unknown());

const CeremonyPayload = z
  .object({
    spec_phase: z.boolean(),
    verify_phase: z.boolean(),
    settle_phase: z.boolean(),
    strict_spec_review: z.boolean(),
    lessons_required: z.enum(["must", "may", "skip"]),
    strict_drift_check: z.boolean(),
  })
  .passthrough();

export const SessionStartedPayload = z
  .object({
    session_id: z.string().min(1),
    feature: z.string().min(1),
    ceremony: CeremonyPayload,
  })
  .passthrough();
export type SessionStartedPayload = z.infer<typeof SessionStartedPayload>;

// Slice B — back-edge sponsorship encoded on the payload (codex r94/r96).
// Authorization is journal-derivable / replay-safe: validateTransition,
// reducer.apply's internal preflight, journal-mutate Pass 1 / Pass 3,
// and replayJournal all re-derive the back-edge legality from
// `payload.back_edge` + `snapshot.findings` without batch context.
//
// Discriminated union on `action` so future amend-tasks / fix-impl /
// fix-test back-edges extend additively (codex r96 Q1 ack).
const BackEdgeAmendSpec = z
  .object({
    action: z.literal("amend-spec"),
    finding_id: FindingId,
  })
  .strict();

const BackEdge = z.discriminatedUnion("action", [BackEdgeAmendSpec]);

export const PhaseAdvancedPayload = z
  .object({
    from: SubState,
    to: SubState,
    /**
     * Back-edge sponsorship (Slice B). When set, `to` MUST be the
     * target dictated by `action` (amend-spec → SPEC.spec), and the
     * referenced finding MUST exist in snapshot.findings with
     * matching action and status="open" (preflight enforces).
     * Absent on forward transitions (the default).
     */
    back_edge: BackEdge.optional(),
  })
  .passthrough();
export type PhaseAdvancedPayload = z.infer<typeof PhaseAdvancedPayload>;

export const GateDecidedPayload = z
  .object({
    gate_kind: GateName,
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().min(1),
  })
  .passthrough();
export type GateDecidedPayload = z.infer<typeof GateDecidedPayload>;

// ── Per-kind strict payload schemas (audit r2 Blocker — pre-append validation) ──
// Each reducer-implemented kind has a strict schema that validates ALL the
// fields the reducer dereferences. PER_KIND_PAYLOAD is parsed at preflight
// (§11.2 step 3) AND at append (step 5 final validate), so any payload that
// would later cause reducer.apply to error is rejected BEFORE journal.append.
// Kinds that the reducer has not yet implemented fall to RecordPayload + a
// runtime "reducer-implemented" gate in journal-mutate.ts.

const TaskRefPayload = z
  .object({ task_id: TaskIdPayload })
  .passthrough();

const TaskStepRefPayload = z
  .object({
    task_id: TaskIdPayload,
    step: z.string().min(1),
  })
  .passthrough();

const TaskStepDonePayload = z
  .object({
    task_id: TaskIdPayload,
    step: z.string().min(1),
    result: z.enum(["passed", "failed", "waived", "na"]).optional(),
    // Slice C SC-C4 (R2): `loaf tasks register-red` emits a red-step
    // task_step_done carrying this flag — the reducer promotes it to
    // task-level red_test_registered. Typed (not accidental passthrough)
    // so preflight's BUG_TASK_FLAG_MISUSE gate sees a real field.
    red_test_registered: z.boolean().optional(),
  })
  .passthrough();

// Slice 1.B sub-cycle 3a (codex r23 BLOCK 1 fix): tasks_planned upgrades
// from `{ tasks: [{ id, kind? }] }` to the full TaskFull discriminated
// union so the reducer can seed per-kind execution steps + cross-cutting
// fields needed by spec-lock checks 3/4/6/7/8 (lands in sub-cycle 3b).
const TasksPlannedPayload = z
  .object({
    based_on: z.object({ spec: z.number().int().positive() }),
    tasks: z.array(TaskFullPayload),
  })
  .passthrough();

// Slice 1.B sub-cycle 3a (F-010 #1+#2): tasks_amended strict single-task
// replace. Batch amend lands as N journal entries via mutateBatch sharing
// batch_id (same pattern as spec add-*).
//
// Slice C SC-C2b: `mode` discriminator (codex r105 Q1=b). `replace`
// overwrites an existing task by id; `add` appends a task absent from the
// projection. `.default("replace")` keeps any pre-mode entry (hand-authored
// / migration / older fixture) replaying as the historical replace-only
// semantics; the CLI always sets `mode` explicitly.
const TasksAmendedPayload = z
  .object({
    mode: z.enum(["add", "replace"]).default("replace"),
    task: TaskFullPayload,
    reason: z.string().min(10).optional(),
  })
  .passthrough();

// Slice 1.C sub-cycle 1 (codex r34 BLOCK 2 fix): EvidenceAddedPayload is the
// strict, full mirror of docs/schemas.ts §16 EvidenceEntry (modulo
// schema_version + at which live on the envelope). `.strict()` rejects
// unknown keys at append time. Cross-field refines fire here:
//   - manual/waiver: actor must start with human:*, reason ≥10 chars
//   - visual-review: attachments[] must be non-empty
// All 17 documented EvidenceEntry payload fields are validated.
const EvidenceAddedPayload = EvidenceFullPayload;

// Slice 3 SC3 (codex r68): mirror docs/schemas.ts §5/§16 canonical shapes.
// Closed category/action enums + canonical FindingId regex catch typos
// at append time — preflight grid + target refines (see preflight.ts) run
// against the parsed typed payload. summary/reason/target are accepted as
// typed optional fields rather than passthrough so the projection can
// surface them via FindingState.
const FindingRaisedPayload = z
  .object({
    id: FindingId,
    category: FindingCategory,
    action: FindingAction,
    summary: z.string().min(3).optional(),
    reason: z.string().optional(),
    target: FindingTarget.optional(),
  })
  .passthrough();

const FindingClosedPayload = z
  .object({
    id: FindingId,
  })
  .passthrough();

// Slice 3 SC1 (codex r64 BLOCK 1+2+3 fix): mirror docs/schemas.ts canonical
// shapes for PendingId / PendingPromptKind / question min length. Closed
// schema at journal-append means a typo kind (e.g. "gate-decision" vs
// "gate_decision") or empty question never reach the projection — where
// they would silently bypass the head-block invariant in preflight.
export const PendingId = z.string().regex(/^PEND-\d{4,}$/);

export const PendingPromptKind = z.enum([
  "ask_user_question",
  "gate_decision",
  "spec_clarification",
  "finding_decision",
  "profile_escalation",
]);

const PendingAddedPayload = z
  .object({
    id: PendingId,
    kind: PendingPromptKind,
    question: z.string().min(3),
  })
  .passthrough();

const PendingResolvedPayload = z
  .object({
    id: PendingId,
  })
  .passthrough();

const SessionReasonPayload = z
  .object({
    reason: z.string().min(1).optional(),
  })
  .passthrough();

// ── SPEC content payload schemas (Slice 1.B sub-cycle 1, refactored r20) ──
// Structural shapes + verifiability refine live in `spec-schema.ts` so that
// (a) the verifiable variant gates journal append strict, and (b) the
// structural variant powers spec.md frontmatter parsing where missing
// verifiability is reachable as spec-lock check 5 (codex r20 BLOCK fix).

const BatchSpecVersion = z.number().int().positive();

export const SpecSubmittedPayload = z
  .object({
    spec_version: BatchSpecVersion,
    feature: z
      .object({
        id: FeatureIdPayload,
        name: z.string().min(3),
      })
      .passthrough(),
    intent: z.string().min(20),
    adr_refs: z.array(z.string()),
    needs_clarification: z.array(NeedsClarification),
  })
  .passthrough();
export type SpecSubmittedPayload = z.infer<typeof SpecSubmittedPayload>;

export const SpecReqAddedPayload = z
  .object({
    spec_version: BatchSpecVersion,
    req: RequirementEarsVerifiable,
  })
  .passthrough();
export type SpecReqAddedPayload = z.infer<typeof SpecReqAddedPayload>;

export const SpecScenarioAddedPayload = z
  .object({
    spec_version: BatchSpecVersion,
    scenario: ScenarioGherkin,
  })
  .passthrough();
export type SpecScenarioAddedPayload = z.infer<typeof SpecScenarioAddedPayload>;

export const SpecVisualAddedPayload = z
  .object({
    spec_version: BatchSpecVersion,
    visual: VisualContract,
  })
  .passthrough();
export type SpecVisualAddedPayload = z.infer<typeof SpecVisualAddedPayload>;

// PER_KIND_PAYLOAD — preflight + final validate parse the payload against
// the schema mapped here. Kinds with strict schemas (12 reducer-implemented
// + 1 gate + 1 migration) are validated to the field level. Kinds without
// a reducer handler fall to RecordPayload (just-an-object) and are caught
// by the REDUCER_IMPLEMENTED_KINDS gate in journal-mutate.ts before append.
export const PER_KIND_PAYLOAD: Record<EntryKind, z.ZodTypeAny> = {
  // State machine transitions
  "event:phase_advanced": PhaseAdvancedPayload,
  "event:ceremony_set": CeremonyPayload,
  "event:tasks_planned": TasksPlannedPayload,
  "event:tasks_amended": TasksAmendedPayload,
  "event:task_claimed": TaskRefPayload,
  "event:task_step_started": TaskStepRefPayload,
  "event:task_step_done": TaskStepDonePayload,
  "event:task_abandoned": TaskRefPayload,
  "event:spec_req_added": SpecReqAddedPayload,
  "event:spec_scenario_added": SpecScenarioAddedPayload,
  "event:spec_visual_added": SpecVisualAddedPayload,
  "event:spec_submitted": SpecSubmittedPayload,

  // Domain ledger entries
  "evidence:added": EvidenceAddedPayload,
  "finding:raised": FindingRaisedPayload,
  "finding:closed": FindingClosedPayload,
  "pending:added": PendingAddedPayload,
  "pending:resolved": PendingResolvedPayload,

  // Gates
  "gate:decided": GateDecidedPayload,

  // Session lifecycle
  "session:started": SessionStartedPayload,
  "session:resumed": RecordPayload,
  "session:delivered": SessionReasonPayload,
  "session:archived": SessionReasonPayload,
  "session:abandoned": SessionReasonPayload,

  // Spike + migration
  "spike:converted": RecordPayload,
  "migration:snapshot_imported": MigrationSnapshotImportedPayload,
};

// REDUCER_IMPLEMENTED_KINDS — audit r2 fix. journal-mutate gates on this
// BEFORE append; preflight + payload schema may pass but if the reducer
// can't apply the kind, the journal would otherwise grow + then reducer
// fail (`mutate()` returns error). Keep this set in sync with reducer.ts
// switch cases.
export const REDUCER_IMPLEMENTED_KINDS: ReadonlySet<EntryKind> = new Set([
  "session:started",
  "migration:snapshot_imported",
  "event:phase_advanced",
  "event:ceremony_set",
  "event:tasks_planned",
  "event:tasks_amended",
  "event:task_claimed",
  "event:task_step_started",
  "event:task_step_done",
  "event:task_abandoned",
  "event:spec_submitted",
  "event:spec_req_added",
  "event:spec_scenario_added",
  "event:spec_visual_added",
  "evidence:added",
  "finding:raised",
  "finding:closed",
  "pending:added",
  "pending:resolved",
  "gate:decided",
  "session:delivered",
  "session:archived",
  "session:abandoned",
]);
