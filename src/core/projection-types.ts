// Leaf module holding the reducer's projection types, extracted to break the
// reducer↔preflight/gates type cycle (P2/SC-7).

import type { Ceremony, SubState } from "./journal-entry.js";
import type {
  AttachmentPayload,
  EvidenceKind,
  EvidenceResult,
  VerifyCheckKind,
} from "./evidence-schema.js";
import type {
  NeedsClarification,
  RequirementEarsShape,
  ScenarioGherkin,
  VisualContract,
} from "./spec-schema.js";

export interface SessionState {
  session_id: string;
  feature: string;
  phase: "TRIAGE" | "SPEC" | "EXECUTE" | "VERIFY" | "SETTLE" | "DONE";
  sub_state: SubState;
  iteration: number;
  /** Set true by `gate:decided spec-lock approved`. gate does NOT move cursor; `event:phase_advanced` owns cursor movement. */
  spec_locked: boolean;
  /** Set true by `gate:decided verify-accept approved`. Parallel to spec_locked: flag only, no cursor move. */
  verify_accepted: boolean;
  /** Live spec-projection counter. Bumped +1 per `loaf spec submit` / `add-*` invocation
   *  (protocol §586). 0 before first submission. spec-lock check 3 compares
   *  `tasks.based_on.spec === state.spec_version`. */
  spec_version: number;
  ceremony: Ceremony;
}

// Per-projection state — reducer mutates these alongside SessionState as
// domain entries (tasks, evidence, findings, pending) land on the journal.

export type TaskStepStatus = "pending" | "running" | "passed" | "failed" | "waived" | "na";

export type TaskStepApplicability = "must" | "optional" | "na";

export type TaskKind = "behavioral" | "structural" | "visual-ui" | "docs" | "spike" | "chore";

// Slim TaskState projection (Slice 1.B sub-cycle 3a). Mirrors only the
// cross-cutting fields needed by spec-lock checks 3/4/6/7/8 + auto-promote;
// the canonical body (tests/test_layer, execution.reason/
// started_at, etc.) lives in the journal payload and round-trips via
// `loaf doctor --rebuild`. steps carry applicability so the auto-promote
// helper distinguishes must vs optional vs na (codex r23 BLOCK 2 fix).
export interface TaskState {
  id: string;
  kind: TaskKind;
  status: "pending" | "ready" | "in_progress" | "done" | "abandoned";
  steps: Record<string, { status: TaskStepStatus; applicability: TaskStepApplicability }>;
  drives: string[];
  depends_on: string[];
  labels: string[];
  red_test_registered?: boolean;
  no_test_rationale?: string;
  visual_contract_refs?: string[];
  requires_acceptance?: boolean;
  requires_visual?: boolean;
}

// Slice 1.C sub-cycle 1: 3 new projection fields (check / reason /
// attachments) back verify-accept gate check 1 (lane status via
// EvidenceEntry.check) + check 3 (canSatisfy reason/attachments) without
// re-reading journal payload at gate time.
//
// EvidenceState is the SLIM projection — not a 1:1 mirror of the full
// EvidenceFullPayload journal payload. The full payload also carries
// iteration / summary / cmd / exit / wall_ms / task_id / gate / decided_by
// / based_on / waiver_obligation_id / external_ref; those live on the
// journal entry and round-trip via doctor --rebuild but do not need to
// surface in the snapshot projection for verify-accept gate evaluation.
//
// `test_layer` intentionally NOT mirrored even at the full-payload layer:
// codex r33 confirmed §5.4 canSatisfy doesn't require it for current MVP.
export interface EvidenceState {
  id: string;
  kind: EvidenceKind;
  result?: EvidenceResult;
  covers: string[];
  actor: string;
  check?: VerifyCheckKind;
  reason?: string;
  attachments?: AttachmentPayload[];
}

export interface FindingState {
  id: string;
  category: string;
  action: string;
  status: "open" | "closed";
  // Slice 3 SC3 — payload-derived fields projected so `finding list` /
  // `status --format json` surface user-input without re-replaying the
  // journal.
  summary?: string;
  reason?: string;
  target?: { task_id: string; step: string };
}

export interface PendingState {
  id: string;
  kind: string;
  resolved: boolean;
}

// SPEC projection — full mirror of spec.md frontmatter (Slice A SC1 widen).
// Prior to Slice A this was a slim id+verifiability mirror; widened to the
// full EARS body / Gherkin / VisualContract z.infer types so the SC-A2
// spec.md projection writer can re-serialize from snapshot alone (codex
// r84 BLOCK absorb).
//
// spec-lock-check.ts:64-214 reads parsed frontmatter from
// readSpecFrontmatter(), NOT these arrays — so the widening is type/test
// fallout only, no gate-eval behavior change. Snapshot arrays are only
// consumed for `.id`-only duplicate checks at:
//   - reducer.ts cases for spec_*_added (DUPLICATE_*_ID surface)
//   - preflight.ts spec_*_added refines (top-level DUPLICATE promotion)
export type RequirementState = RequirementEarsShape;
export type ScenarioState = ScenarioGherkin;
export type VisualContractState = VisualContract;

// SpecHeader — the non-array portion of spec.md frontmatter
// (feature / intent / adr_refs / needs_clarification). Populated by
// `event:spec_submitted` apply; reset on each submit (whole-replacement).
// null until first submit lands. Slice A SC1 introduces this projection
// so SC-A2's writeDerivedSpecMd can render the full frontmatter from
// snapshot without re-reading the journal.
export interface SpecHeader {
  /** Protocol F-NNN feature id from spec.md frontmatter — distinct from
   *  `SessionState.feature` (the loaf-internal session feature key). */
  feature: { id: string; name: string };
  intent: string;
  adr_refs: string[];
  needs_clarification: NeedsClarification[];
}

export interface Snapshot {
  state: SessionState | null;
  tasks: TaskState[];
  evidence: EvidenceState[];
  findings: FindingState[];
  pending: PendingState[];
  spec_header: SpecHeader | null;
  requirements: RequirementState[];
  scenarios: ScenarioState[];
  visual_contracts: VisualContractState[];
  /** Set by `event:tasks_planned`. spec-lock check 3 compares
   *  `tasks_based_on.spec === state.spec_version`. null until first
   *  tasks_planned lands. NOT a mirror of state.spec_version: this is the
   *  frozen spec version at the moment tasks were planned, while
   *  state.spec_version is the live counter. */
  tasks_based_on: { spec: number } | null;
}
