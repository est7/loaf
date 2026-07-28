// Evidence schema — canonical Zod owner for evidence journal payloads.
//
// Slice 1.C introduced the runtime module; wayfinder #6 dissolved the docs
// mirror into this canonical domain home so:
//
//   - journal-entry.ts imports EvidenceFullPayload for PER_KIND_PAYLOAD
//   - evidence-compat.ts (Slice 1.C sub-cycle 2) imports
//     EvidenceKind / VerifyCheckKind / CoversRefPayload for canSatisfy()
//   - gates/verify-accept-check.ts (Slice 1.C sub-cycle 3) imports
//     VerifyCheckKind for the deriveVerifyApplicability helper
//   - reducer.ts imports the type unions for EvidenceState projection ext
//
// No reverse dependency: this module imports from spec-schema + task-schema
// but does NOT import from reducer / journal-entry / gates. Parallels
// spec-schema.ts (Slice 1.B sub-cycle 2) + task-schema.ts (Slice 1.B
// sub-cycle 3a) neutral module placement.
//
// EvidenceFullPayload is the **full** strict mirror of docs §16:1702-1751
// EvidenceEntry, modulo the two envelope fields (`schema_version`, `at`)
// which live on the JournalEntry envelope, not the per-kind payload.
// `.strict()` rejects unknown keys (codex r34 BLOCK 2 — default
// z.object()s would let extra fields slip through with garbage types).
//
// Cross-field refines (mirror docs §16 + protocol §5.4):
//   - manual / waiver: actor MUST start with "human:" + reason ≥ 10 chars
//   - visual-review: attachments[] MUST be non-empty
//
// Reducer extract narrows to the slim projection subset; refines are not
// re-checked at reducer time because the payload is already strict-validated
// at journal-mutate Pass 1 (PER_KIND_PAYLOAD lookup).

import { z } from "zod";

import { ReqIdPayload, ScenIdPayload, VisIdPayload } from "./spec-schema.js";
import { TaskIdPayload } from "./task-schema.js";
import {
  InlineLongTextField,
  LongTextField,
  type LongTextField as LongTextFieldValue,
} from "./attachment-ref.js";

// ── EvidenceKind / EvidenceResult enums ─────────────────────────────────

export const EvidenceKind = z.enum([
  "task-summary", // per-task closing summary
  "verify-review", // emitted during VERIFY.review
  "spec-review", // deep profile: independent spec reviewer
  "acceptance", // emitted during VERIFY.acceptance (Gherkin E2E)
  "visual-review", // emitted during VERIFY.visual
  "gate-decision", // human gate approval/rejection
  "local-check", // local test/lint/typecheck run
  "manual", // human verification (kind=manual implies result≠waived)
  "waiver", // human waiver; actor MUST start with "human:"; reason required
  "spike-finding", // spike task: explore/prototype output
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

export const EvidenceResult = z.enum(["passed", "failed", "approved", "rejected", "waived"]);
export type EvidenceResult = z.infer<typeof EvidenceResult>;

// ── VerifyCheckKind ─────────────────────────────────────────────────────

export const VerifyCheckKind = z.enum([
  "run", // test + lint + type-check
  "review", // quality reviewer (spec_fit + quality_fit)
  "acceptance", // selected Gherkin E2E scenarios
  "visual", // visual contract verification
]);
export type VerifyCheckKind = z.infer<typeof VerifyCheckKind>;

// ── GateName (colocated protocol enum) ──────────────────────────────────
//
// journal-entry.ts also exports a GateName enum. We colocate here to avoid
// a journal-entry → evidence-schema reverse import cycle. The two enums
// must stay in lockstep; if a third gate kind lands, update both.

export const GateNamePayload = z.enum(["spec-lock", "verify-accept"]);
export type GateNamePayload = z.infer<typeof GateNamePayload>;

// ── Attachment ──────────────────────────────────────────────────────────

export const AttachmentPayload = z
  .object({
    path: z.string().min(3), // relative to feature dir
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mime: z.string().min(3),
    bytes: z.number().int().positive().optional(),
  })
  .strict();
export type AttachmentPayload = z.infer<typeof AttachmentPayload>;

// ── LongTextField ───────────────────────────────────────────────────────
//
// Inline values stay below sidecar threshold; oversized inline values are
// promoted to sidecar form by `promoteSidecars()` during Pass 2 of
// journal-mutate. Pass 1 (strict schema validate) sees inline form; Pass 3
// (post-promote dry-run) sees sidecar form — both must pass the union.

export const LongTextFieldPayload = LongTextField;
export type LongTextFieldPayload = LongTextFieldValue;

// SummaryField — string for short summaries, LongTextField for long ones
// that may need sidecar promotion. Plain string is the typical case for
// `loaf evidence add --summary "..."`; LongTextField is used when a caller
// feeds a >sidecar-threshold body that Pass 2 promotes to a sidecar file.
const SummaryField = z.union([z.string().min(3), LongTextFieldPayload]);

// ── ID + CoversRef ──────────────────────────────────────────────────────

export const EvidenceIdPayload = z.string().regex(/^EV-\d{6,}$/);

export const CoversRefPayload = z.union([ReqIdPayload, ScenIdPayload, VisIdPayload, TaskIdPayload]);
export type CoversRefPayload = z.infer<typeof CoversRefPayload>;

// ── EvidenceFullPayload — strict full mirror of docs EvidenceEntry ──────
//
// Skipped fields (envelope-owned, not payload): schema_version + at.
// Everything else from §16:1702-1751 is mirrored verbatim.

// Exported (Phase 14 SC1): the projection container `EvidenceJson` extends
// this raw ZodObject with the two envelope-owned fields (`schema_version`,
// `at`). `EvidenceFullPayload` below is a refined `ZodEffects` and cannot
// be `.extend()`'d — projection-schema.ts needs the unrefined shape.
export const EvidenceFullShape = z
  .object({
    // Required core (docs §16 lines 1704-1712).
    id: EvidenceIdPayload, // = docs evidence_id
    kind: EvidenceKind,
    iteration: z.number().int().positive(),
    actor: z.string().min(1),
    result: EvidenceResult,
    summary: SummaryField,

    // Coverage assertion (line 1715).
    covers: z.array(CoversRefPayload).default([]),

    // Task linkage (line 1718).
    task_id: TaskIdPayload.optional(),

    // Verify-check linkage (line 1721).
    check: VerifyCheckKind.optional(),

    // Command details (lines 1724-1726).
    cmd: z.string().optional(),
    exit: z.number().int().optional(),
    wall_ms: z.number().int().optional(),

    // Gate-decision specifics (lines 1729-1737).
    gate: GateNamePayload.optional(),
    decided_by: z.string().optional(),
    reason: z.string().optional(),
    based_on: z
      .object({
        spec: z.number().int().nonnegative(),
        tasks: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),

    // Visual-review attachments (line 1740).
    attachments: z.array(AttachmentPayload).optional(),

    // Waiver-specifics (line 1744).
    waiver_obligation_id: z.string().optional(),

    // Caller correlation (line 1750).
    external_ref: z.string().optional(),
  })
  .strict();

export const EvidenceFullPayload = EvidenceFullShape.refine(
  (e) => {
    if (e.kind === "manual" || e.kind === "waiver") {
      if (!e.actor.startsWith("human:")) return false;
      if (!e.reason || e.reason.length < 10) return false;
    }
    return true;
  },
  {
    message: "evidence kind=manual/waiver requires actor=human:* and reason ≥10 chars (per §5.4)",
  },
)
  .refine((e) => !(e.kind === "manual" && e.result === "waived"), {
    message: "evidence kind=manual must not carry result=waived; use kind=waiver",
  })
  .refine(
    (e) => {
      if (e.kind === "visual-review") {
        if (!e.attachments || e.attachments.length === 0) return false;
      }
      return true;
    },
    {
      message: "evidence kind=visual-review requires ≥1 attachment (per §5.4 + §1695-1700)",
    },
  );

export type EvidenceFull = z.infer<typeof EvidenceFullPayload>;

// ── EvidenceAddInput[Batched] — Phase 16 SC-4c runtime mirror ───────
//
// Canonical input for src/cli/input-schemas.ts INPUT_SCHEMAS["evidence:add"]. Used by
// `loaf evidence add --input <src>` to validate caller payload BEFORE
// CLI allocates EV-id. After id injection, the full payload is re-
// validated through EvidenceFullPayload so the kind-specific refines
// (manual/waiver actor=human:* + reason≥10, visual-review ≥1 attachment)
// still run.
//
// Built from EvidenceFullShape (NOT EvidenceFullPayload) because the
// latter is .refine()'d and Zod can't .omit() a ZodEffects. .strict()
// rejects caller-supplied `id` / unknown keys at the contract layer.
// Attachments require full metadata (path/sha256/mime/bytes?) until
// ADR-0004 A6 auto-hash materialization lands in a future SC. Internal
// LongTextField sidecar refs are persistence state: callers may submit only a
// string or inline text and let the mutation pipeline materialize any sidecar.
const EvidenceAuthoringSummary = z.union([z.string().min(3), InlineLongTextField]);
export const EvidenceAddInput = EvidenceFullShape.extend({ summary: EvidenceAuthoringSummary })
  .omit({ id: true })
  .strict();
export type EvidenceAddInput = z.infer<typeof EvidenceAddInput>;

// Batch wrapper per protocol §10.7 INPUT_SCHEMAS contract (codex r230
// PATCH B + r236 GO): callers may submit single object or non-empty
// array. mutateBatch atomically emits N event:evidence_added entries
// sharing one batch_id.
export const EvidenceAddInputBatched = z.union([
  EvidenceAddInput,
  z.array(EvidenceAddInput).nonempty(),
]);
export type EvidenceAddInputBatched = z.infer<typeof EvidenceAddInputBatched>;
