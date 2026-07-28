// JournalEntry — the SSoT envelope (rev 5.0, ADR-0005 §3.2).
//
// Every line in `.loaf/<feature>/journal.jsonl` is one JournalEntry. The
// envelope carries identity & ordering, actor namespace, schema version, the
// kind discriminator, and an opaque payload. Per-kind payload schemas land
// progressively alongside the reducer (src/core/reducer/* — Stage 2+); Stage 1
// treats payload as z.unknown() and only enforces the envelope.
//
// This module is the canonical runtime owner; protocol.md §11.2 defines the
// observable transaction contract.

import path from "node:path";

import { z } from "zod";

import {
  FeatureIdPayload,
  NeedsClarification,
  RequirementEarsVerifiable,
  ScenarioGherkin,
  VisualContract,
} from "./spec-schema.js";
import { TaskFullPayload, TaskIdPayload } from "./task-schema.js";
import { EvidenceFullPayload } from "./evidence-schema.js";
import { FindingAction, FindingCategory, FindingId, FindingTarget } from "./finding-schema.js";
import {
  AttachmentRef as AttachmentRefSchema,
  LongTextField as LongTextFieldSchema,
  SIDECAR_THRESHOLD_BYTES,
  type AttachmentRef as AttachmentRefValue,
  type LongTextField as LongTextFieldValue,
} from "./attachment-ref.js";

// Hard byte ceiling per serialized JournalEntry. Mirrors §34
// entry_byte_limit_kb (64KB); enforced by appendEntry at step 5 final
// validate. Long fields exceeding sidecar_threshold_kb (8KB) MUST be
// promoted to attachments/<entry_id>/ via LongTextField sidecar form
// (Stage 4); Stage 1 simply rejects oversize entries outright.
export const ENTRY_BYTE_LIMIT = 64_000;

export const EntryId = z.string().regex(/^JE-\d{6,}$/, {
  message: "entry_id must match /^JE-\\d{6,}$/ (e.g. JE-000123)",
});
export type EntryId = z.infer<typeof EntryId>;

export const BatchId = z.string().uuid();
export type BatchId = z.infer<typeof BatchId>;

export const ActorString = z.string().regex(/^(human|skill|ci|cli|migration):[^\s].*$/, {
  message:
    "actor must be of form '<prefix>:<id>' where prefix ∈ {human, skill, ci, cli, migration}",
});
export type ActorString = z.infer<typeof ActorString>;

// Re-export the neutral sidecar vocabulary for compatibility with existing
// journal-domain imports.
export const AttachmentRef = AttachmentRefSchema;
export type AttachmentRef = AttachmentRefValue;

// LongTextField — text fields that may exceed the 8KB sidecar threshold. The
// inline form survives until step 4 (sidecar finalize). The sidecar form is
// what lands in journal-appended payloads after promotion.
export { SIDECAR_THRESHOLD_BYTES };
export const LongTextField = LongTextFieldSchema;
export type LongTextField = LongTextFieldValue;

/** One concrete repo-relative POSIX path recorded for actual-scope audit. */
export const ScopePath = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    if (value.includes("\0")) {
      ctx.addIssue({ code: "custom", message: "scope path must not contain NUL" });
    }
    if (value.includes("\\")) {
      ctx.addIssue({ code: "custom", message: "scope path must use POSIX separators" });
    }
    if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
      ctx.addIssue({ code: "custom", message: "scope path must be repo-relative" });
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      ctx.addIssue({
        code: "custom",
        message: "scope path must not contain empty, '.' or '..' segments",
      });
    }
    if (segments[0] === ".loaf") {
      ctx.addIssue({ code: "custom", message: "scope path must not target .loaf" });
    }
  });
export type ScopePath = z.infer<typeof ScopePath>;

/** UTF-8 byte ordering is the canonical cross-runtime scope-path order. */
export function compareScopePathBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export const CanonicalScopePaths = z.array(ScopePath).superRefine((paths, ctx) => {
  for (let index = 1; index < paths.length; index += 1) {
    if (compareScopePathBytes(paths[index - 1]!, paths[index]!) >= 0) {
      ctx.addIssue({
        code: "custom",
        path: [index],
        message: "scope paths must be strictly bytewise-sorted and duplicate-free",
      });
    }
  }
});
export type CanonicalScopePaths = z.infer<typeof CanonicalScopePaths>;

const CanonicalScopePathsLongText = LongTextField.superRefine((field, ctx) => {
  if (field.mode === "sidecar") return;
  let decoded: unknown;
  try {
    decoded = JSON.parse(field.text);
  } catch {
    ctx.addIssue({ code: "custom", message: "inline scope paths must be valid JSON" });
    return;
  }
  const parsed = CanonicalScopePaths.safeParse(decoded);
  if (!parsed.success) {
    ctx.addIssue({ code: "custom", message: "inline scope paths must be canonical" });
    return;
  }
  if (field.text !== JSON.stringify(parsed.data)) {
    ctx.addIssue({
      code: "custom",
      message: "inline scope paths must use the canonical JSON encoding",
    });
  }
});

/**
 * Reserved signature payload shape. JournalEntry does not accept a signature
 * field until a future envelope-version ADR activates it.
 */
export const SignatureEnvelope = z
  .object({
    alg: z.string().min(1),
    key_id: z.string().min(1),
    sig: z.string().min(1),
    signed_at: z.string().datetime(),
  })
  .strict();
export type SignatureEnvelope = z.infer<typeof SignatureEnvelope>;

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

export const Phase = z.enum(["TRIAGE", "SPEC", "EXECUTE", "VERIFY", "SETTLE", "DONE"]);
export type Phase = z.infer<typeof Phase>;

// SubState — closed set per protocol.md §2.1 (20 sub-states across 6 phases).
// State machine cursor; reducer projects this from `event:phase_advanced` /
// `gate:decided` entries via the shared validateTransition helper (Gate #1).
export const SubState = z.enum([
  "TRIAGE.score",
  "TRIAGE.confirm",
  "SPEC.proposal",
  "SPEC.spec",
  "SPEC.plan",
  "SPEC.design",
  "EXECUTE.plan",
  "EXECUTE.work",
  "EXECUTE.done",
  "VERIFY.plan",
  "VERIFY.run",
  "VERIFY.review",
  "VERIFY.acceptance",
  "VERIFY.visual",
  "VERIFY.accept",
  "SETTLE.reconcile",
  "SETTLE.lessons",
  "DONE.delivered",
  "DONE.archived",
  "DONE.abandoned",
]);
export type SubState = z.infer<typeof SubState>;

// Ceremony — six-flag schema from protocol.md §3 (rev 5.x PRESETS quick /
// light / standard / deep). Drives phase activation + strict-mode gates +
// VERIFY.accept fork (settle_phase decides SETTLE.lessons vs DONE.delivered).
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

/** Cosmetic preset label; runtime never interprets its value. */
export const CeremonyLabel = z.string();
export type CeremonyLabel = z.infer<typeof CeremonyLabel>;

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
  "event:task_step_reset",
  "event:task_abandoned",
  "event:spec_req_added",
  "event:spec_scenario_added",
  "event:spec_visual_added",
  "event:spec_submitted",
  // ── Domain ledger entries ──
  "evidence:added",
  "lesson:recorded",
  "scope:recorded",
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
    batch_id: BatchId.optional(),
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
      message: "batch_id, batch_index, batch_count must be all-present or all-absent",
    },
  )
  .refine(
    (e) =>
      e.batch_index === undefined || e.batch_count === undefined || e.batch_index < e.batch_count,
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
// Phase 16 SC-13b — typed session:resumed payload (codex r343/r345 lock).
// Replaces the loose RecordPayload mapping for `session:resumed`. CLI
// `loaf resume` constructs this from the loaded ResumePack header
// fields; reducer treats it as a transparent no-op marker.
export const SessionResumedPayload = z
  .object({
    resumed_from_pack: z
      .object({
        at: z.string().datetime(),
        reason: z.string().min(5),
        session_id: z.string().uuid(),
      })
      .strict(),
  })
  .strict();
export type SessionResumedPayload = z.infer<typeof SessionResumedPayload>;

export const CeremonyPayload = z
  .object({
    spec_phase: z.boolean(),
    verify_phase: z.boolean(),
    settle_phase: z.boolean(),
    strict_spec_review: z.boolean(),
    lessons_required: z.enum(["must", "may", "skip"]),
    strict_drift_check: z.boolean(),
  })
  .passthrough();

// Phase 15 SC1 (F-019): bucket-C identity fields widened onto the payload
// so `state.json` becomes a fully journal-derived projection. All four are
// `.optional()` — a pre-SC1 (legacy) `session:started` entry lacks them,
// and `composeStateProjection` applies the documented fallback (workspace
// → "default", ceremony_label → "", session_label / loaf_version_required
// → null). `complexity_score` is deliberately NOT widened here: it is a
// TRIAGE-phase score with no value at `loaf start` time and no journal
// source yet (codex r167 Q2) — the projection field stays `null` until a
// future TRIAGE-scoring slice.
export const SessionStartedPayload = z
  .object({
    session_id: z.string().min(1),
    feature: z.string().min(1),
    ceremony: CeremonyPayload,
    session_label: z.string().min(3).optional(),
    ceremony_label: z.string().optional(),
    workspace: z.string().min(1).optional(),
    // Widened to accept semver prerelease + build-metadata pins
    // (codex r181 → r182): the CLI auto-derives this as
    // `^${packageJson.version}`, so an RC / alpha / build-tagged
    // package version must round-trip through the journal.
    // Backward-compatible — old `^0.1.0` / `~1.0` pins still parse.
    loaf_version_required: z
      .string()
      .regex(/^[\^~]?\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/)
      .optional(),
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

// Phase 11 Item 3 SC1 — amend-tasks back-edge. Identical shape to
// BackEdgeAmendSpec (codex r134 Q3): no `target` / `task_id` on the
// payload — the target (EXECUTE.work) is dictated by `action` and
// re-derived by validateTransition.
const BackEdgeAmendTasks = z
  .object({
    action: z.literal("amend-tasks"),
    finding_id: FindingId,
  })
  .strict();

// Phase 11 Item 3 SC2 — fix-impl back-edge. Identical shape to
// BackEdgeAmendSpec / BackEdgeAmendTasks (codex r139 Q6): no `target` /
// `task_id` on the back_edge payload — the target (EXECUTE.work) is
// dictated by `action`, and the step reset travels as a sibling
// `event:task_step_reset` entry in the same batch.
const BackEdgeFixImpl = z
  .object({
    action: z.literal("fix-impl"),
    finding_id: FindingId,
  })
  .strict();

// Phase 11 Item 3 SC3 — fix-test back-edge. Identical shape to
// BackEdgeFixImpl (codex r142): no `target` / `task_id` on the back_edge
// payload — the target (EXECUTE.work) is dictated by `action`, and the
// step reset (step="red") travels as a sibling `event:task_step_reset`
// entry in the same batch.
const BackEdgeFixTest = z
  .object({
    action: z.literal("fix-test"),
    finding_id: FindingId,
  })
  .strict();

const BackEdge = z.discriminatedUnion("action", [
  BackEdgeAmendSpec,
  BackEdgeAmendTasks,
  BackEdgeFixImpl,
  BackEdgeFixTest,
]);

export const PhaseAdvancedPayload = z
  .object({
    from: SubState,
    to: SubState,
    /**
     * Back-edge sponsorship (Slice B / Phase 11 Item 3). When set, `to`
     * MUST be the target dictated by `action` (amend-spec → SPEC.spec;
     * amend-tasks / fix-impl / fix-test → EXECUTE.work), and the referenced
     * finding MUST exist in snapshot.findings with matching action and
     * status="open" (preflight enforces). Absent on forward transitions
     * (the default).
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

export const TaskRefPayload = z.object({ task_id: TaskIdPayload }).passthrough();

export const TaskStepRefPayload = z
  .object({
    task_id: TaskIdPayload,
    step: z.string().min(1),
  })
  .passthrough();

// Item 1 — `loaf tasks abandon <T-N> --reason "..."`. The journal payload
// carries the why (reason) even though the reducer projection stays
// minimal (status→abandoned only). `.passthrough()` mirrors the sibling
// TaskRefPayload / TaskStepRefPayload.
export const TaskAbandonedPayload = z
  .object({
    task_id: TaskIdPayload,
    reason: z.string().min(1),
  })
  .passthrough();

export const TaskStepDonePayload = z
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

// Phase 11 Item 3 SC2/SC3 — `event:task_step_reset` (codex r139 Q1, r142).
// Co-emitted by `loaf finding raise --action fix-impl|fix-test` inside the
// 3-entry back-edge batch. Resets a task's repair step to `pending` so the
// fix loop can re-run it. `step` is explicit on the payload — fix-impl resets
// "implement", fix-test resets "red" (FIX_ACTION_STEP). `.strict()` — the
// payload carries a finding_id authority reference, so a typo'd key must fail
// at append, not be silently dropped. The reset's authorization (the finding
// must be open with action ∈ {fix-impl, fix-test}, and the finding's target
// must equal {task_id, step}) is verified by the per-kind preflight refine.
export const TaskStepResetPayload = z
  .object({
    task_id: TaskIdPayload,
    step: z.string().min(1),
    finding_id: FindingId,
  })
  .strict();
export type TaskStepResetPayload = z.infer<typeof TaskStepResetPayload>;

// Slice 1.B sub-cycle 3a (codex r23 BLOCK 1 fix): tasks_planned upgrades
// from `{ tasks: [{ id, kind? }] }` to the full TaskFull discriminated
// union so the reducer can seed per-kind execution steps + cross-cutting
// fields needed by spec-lock checks 3/4/6/7/8 (lands in sub-cycle 3b).
export const TasksPlannedPayload = z
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
//
// Phase 11 Item 3 SC1b (codex r136 Q1): `sponsored_by_finding_id` is the
// journal-derivable sponsorship marker that authorizes a post-back-edge
// `tasks amend` / `tasks add` at EXECUTE.work — preflight §8.6 reads it to
// relax the unsponsored mutation-rights rejections after verifying the
// referenced finding is open with action=amend-tasks. The schema is
// `.strict()` (not `.passthrough()`): this is an authority-bearing payload,
// so a typo'd top-level key (e.g. `sponsored_by_findng_id`) must fail at
// append time, not be silently dropped and read as unsponsored.
export const TasksAmendedPayload = z
  .object({
    mode: z.enum(["add", "replace"]).default("replace"),
    task: TaskFullPayload,
    reason: z.string().min(10).optional(),
    sponsored_by_finding_id: FindingId.optional(),
  })
  .strict();

// Slice 1.C sub-cycle 1 (codex r34 BLOCK 2 fix): EvidenceAddedPayload is the
// strict, full evidence-entry payload shape (modulo
// schema_version + at which live on the envelope). `.strict()` rejects
// unknown keys at append time. Cross-field refines fire here:
//   - manual/waiver: actor must start with human:*, reason ≥10 chars
//   - visual-review: attachments[] must be non-empty
// All 17 documented EvidenceEntry payload fields are validated.
export const EvidenceAddedPayload = EvidenceFullPayload;

/**
 * `lesson:recorded` payload v1. The actor belongs to the journal envelope;
 * keeping it out of this strict payload prevents the two authority sources
 * from drifting. Long summaries use the shared sidecar-capable field shape.
 */
export const LessonRecordedPayload = z
  .object({
    id: z.string().regex(/^LSN-\d{3,}$/),
    iteration: z.number().int().positive(),
    reason: z.string().min(10),
    summary: z.union([z.string().min(3), LongTextField]),
  })
  .strict();
export type LessonRecordedPayload = z.infer<typeof LessonRecordedPayload>;

/**
 * `scope:recorded` payload v1. Small sets remain a canonical array; large
 * sets use canonical JSON in LongTextField so the shared sidecar pipeline can
 * keep the journal entry below its byte ceiling.
 */
export const ScopeRecordedPayload = z
  .object({
    iteration: z.number().int().positive(),
    paths: z.union([CanonicalScopePaths, CanonicalScopePathsLongText]),
  })
  .strict();
export type ScopeRecordedPayload = z.infer<typeof ScopeRecordedPayload>;

// Slice 3 SC3 (codex r68): canonical finding/evidence payload shapes.
// Closed category/action enums + canonical FindingId regex catch typos
// at append time — preflight grid + target refines (see preflight.ts) run
// against the parsed typed payload. summary/reason/target are accepted as
// typed optional fields rather than passthrough so the projection can
// surface them via FindingState.
export const FindingRaisedPayload = z
  .object({
    id: FindingId,
    category: FindingCategory,
    action: FindingAction,
    summary: z.string().min(3).optional(),
    reason: z.string().optional(),
    target: FindingTarget.optional(),
  })
  .passthrough();

export const FindingClosedPayload = z
  .object({
    id: FindingId,
  })
  .passthrough();

// Slice 3 SC1 (codex r64 BLOCK 1+2+3 fix): canonical
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

export const PendingAddedPayload = z
  .object({
    id: PendingId,
    kind: PendingPromptKind,
    question: z.string().min(3),
  })
  .passthrough();

export const PendingResolvedPayload = z
  .object({
    id: PendingId,
  })
  .passthrough();

export const SessionReasonPayload = z
  .object({
    reason: z.string().min(1).optional(),
  })
  .passthrough();

// `spike:converted` — Phase 12. Record-only spike exit (protocol §8.3): the
// `loaf spike convert` command emits this audit entry, then archives the
// session via a sponsored `session:archived` in the same batch. `to_feature`
// is the F-NNN id the spike learnings carry into — the new feature itself is
// opened by a separate `loaf start`. `.strict()` (the kind was a loose
// RecordPayload pre-SC2): caller-side payload typos must fail Gate #3, not
// pass silently.
export const SpikeConvertedPayload = z
  .object({
    to_feature: FeatureIdPayload,
    reason: z.string().min(1),
  })
  .strict();

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

// PER_KIND_PAYLOAD + REDUCER_IMPLEMENTED_KINDS moved to kind-registry.ts (L2):
// they are now derived from the single per-kind metadata registry. The payload
// schema consts above are exported and imported by name from kind-registry.ts.
