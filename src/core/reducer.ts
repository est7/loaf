// Reducer apply path — minimum viable Stage 2.
//
// preflight() (§11.2 step 3) validates authority + transition; apply() (step 7)
// narrows on kind and mutates the projection. Returns Result so callers can
// branch on typed error codes without try/catch.
//
// Stage 2 scope intentionally narrow: handle just enough kinds to demonstrate
// the apply path (`session:started`, `event:phase_advanced`, `gate:decided`).
// Remaining kinds — task lifecycle, evidence, findings, pending, settle, etc.
// — land incrementally in Stages 2-4 alongside their projections.

import type { Ceremony, EntryKind, JournalEntry, SubState } from "./journal-entry.js";
import { preflight } from "./reducer/preflight.js";
import type { PreflightFailureCode } from "./reducer/preflight.js";

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

export interface TaskState {
  id: string;
  kind?: string;
  status: "pending" | "in_progress" | "done" | "abandoned";
  steps: Record<string, { status: TaskStepStatus }>;
}

export interface EvidenceState {
  id: string;
  kind: string;
  result?: string;
  covers: string[];
  actor: string;
}

export interface FindingState {
  id: string;
  category: string;
  action: string;
  status: "open" | "closed";
}

export interface PendingState {
  id: string;
  kind: string;
  resolved: boolean;
}

// SPEC projection — slim mirror of spec.md frontmatter. Reducer extracts
// only the cross-cutting fields needed by spec-lock checks 4-7 (§5.1);
// the canonical full body (`trigger`/`response`/`given`/`when`/`then`/
// `target`/`checks`) lives in the journal payload (full replay source).
export interface RequirementState {
  id: string;
  type: "ubiquitous" | "event-driven" | "state-driven" | "optional" | "unwanted";
  measurable?: { metric: string; threshold: string | number; unit?: string; direction: "lte" | "gte" | "eq" };
  verified_by_scenarios?: string[];
  acceptance_na?: true;
  acceptance_na_reason?: string;
}

export interface ScenarioState {
  id: string;
  tag?: "happy" | "edge" | "error" | "e2e";
  requires_acceptance?: boolean;
  acceptance_na?: string;
}

export interface VisualContractState {
  id: string;
  requires_visual?: boolean;
  visual_na?: string;
}

export interface Snapshot {
  state: SessionState | null;
  tasks: TaskState[];
  evidence: EvidenceState[];
  findings: FindingState[];
  pending: PendingState[];
  requirements: RequirementState[];
  scenarios: ScenarioState[];
  visual_contracts: VisualContractState[];
}

export function initialSnapshot(): Snapshot {
  return {
    state: null,
    tasks: [],
    evidence: [],
    findings: [],
    pending: [],
    requirements: [],
    scenarios: [],
    visual_contracts: [],
  };
}

export type ApplyResult =
  | { ok: true; snapshot: Snapshot }
  | {
      ok: false;
      code:
        | PreflightFailureCode
        | "NO_SESSION"
        | "ALREADY_STARTED"
        | "INVALID_PAYLOAD"
        | "REDUCER_NOT_IMPLEMENTED"
        | "PENDING_NOT_FOUND"
        | "FINDING_NOT_FOUND";
      message: string;
      detail?: Record<string, unknown>;
    };

function extractPhase(sub: SubState): SessionState["phase"] {
  const idx = sub.indexOf(".");
  return sub.slice(0, idx) as SessionState["phase"];
}

// Default ceremony used by migration bootstrap when v0.0.x state.json's
// concrete ceremony is not yet rehydrated into the projection (Stage 5 MVP).
const MIGRATION_BOOTSTRAP_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

export function apply(prev: Snapshot, entry: JournalEntry): ApplyResult {
  // migration:snapshot_imported is also a bootstrap kind — it initializes
  // state from a v0.0.x legacy projection. Stage 5 MVP records the entry but
  // defers full projection rehydration (state stays at TRIAGE.score with a
  // default ceremony; the real state lives in attachments/JE-000000/migration/
  // and projection writers in later stages will rehydrate).
  if (entry.kind === "migration:snapshot_imported") {
    if (prev.state !== null) {
      return {
        ok: false,
        code: "ALREADY_STARTED",
        message: "migration:snapshot_imported after state already initialized",
      };
    }
    return {
      ok: true,
      snapshot: {
        ...prev,
        state: {
          session_id: "00000000-0000-0000-0000-000000000000",
          feature: "migrated",
          phase: "TRIAGE",
          sub_state: "TRIAGE.score",
          iteration: 1,
          spec_locked: false,
          verify_accepted: false,
          spec_version: 0,
          ceremony: MIGRATION_BOOTSTRAP_CEREMONY,
        },
      },
    };
  }

  // session:started is the bootstrap kind: it initializes state from null.
  if (entry.kind === "session:started") {
    if (prev.state !== null) {
      return {
        ok: false,
        code: "ALREADY_STARTED",
        message: "session:started after state already initialized",
      };
    }
    const payload = entry.payload as {
      session_id?: string;
      feature?: string;
      ceremony?: Ceremony;
    };
    if (!payload.session_id || !payload.feature || !payload.ceremony) {
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: "session:started payload requires session_id, feature, ceremony",
      };
    }
    return {
      ok: true,
      snapshot: {
        ...prev,
        state: {
          session_id: payload.session_id,
          feature: payload.feature,
          phase: "TRIAGE",
          sub_state: "TRIAGE.score",
          iteration: 1,
          spec_locked: false,
          verify_accepted: false,
          spec_version: 0,
          ceremony: payload.ceremony,
        },
      },
    };
  }

  // All other kinds require an initialized session.
  if (prev.state === null) {
    return {
      ok: false,
      code: "NO_SESSION",
      message: `kind=${entry.kind} requires a started session`,
    };
  }

  // Preflight (authority + transition) before mutation.
  const pre = preflight(entry, {
    sub_state: prev.state.sub_state,
    tail_seq: entry.seq - 1, // sequence already validated by journal-append
    ceremony: prev.state.ceremony,
  });
  if (!pre.ok) {
    return { ok: false, code: pre.code, message: pre.message, detail: pre.detail ?? {} };
  }

  // Apply per-kind state mutations.
  switch (entry.kind) {
    case "event:phase_advanced": {
      const payload = entry.payload as { to: SubState };
      const next: SessionState = {
        ...prev.state,
        sub_state: payload.to,
        phase: extractPhase(payload.to),
      };
      return { ok: true, snapshot: { ...prev, state: next } };
    }

    case "event:ceremony_set": {
      const payload = entry.payload as Ceremony;
      return {
        ok: true,
        snapshot: { ...prev, state: { ...prev.state, ceremony: payload } },
      };
    }

    case "gate:decided": {
      // Slice 1.A normalization: gate:decided records approval flags only.
      // It does NOT move the cursor — `event:phase_advanced` owns cursor
      // movement so the protocol-batch [gate:decided, phase_advanced] reads
      // a consistent sub_state at each step. Rejected gate decisions are
      // recorded in the journal but produce no projection flag change
      // (caller can read the journal for audit; future iteration may add a
      // rejected counter).
      const payload = entry.payload as {
        gate_kind: "spec-lock" | "verify-accept";
        decision: "approved" | "rejected";
      };
      if (payload.gate_kind === "spec-lock") {
        if (payload.decision === "approved") {
          return {
            ok: true,
            snapshot: { ...prev, state: { ...prev.state, spec_locked: true } },
          };
        }
        return { ok: true, snapshot: prev };
      }
      if (payload.gate_kind === "verify-accept") {
        if (payload.decision === "approved") {
          return {
            ok: true,
            snapshot: { ...prev, state: { ...prev.state, verify_accepted: true } },
          };
        }
        return { ok: true, snapshot: prev };
      }
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: `gate:decided has unknown gate_kind: ${String(payload.gate_kind)}`,
      };
    }

    case "event:tasks_planned": {
      // payload: { tasks: TaskSummary[] }
      const payload = entry.payload as { tasks?: Array<{ id: string; kind?: string }> };
      const taskList: TaskState[] = (payload.tasks ?? []).map((t) => {
        const base: TaskState = { id: t.id, status: "pending", steps: {} };
        return t.kind !== undefined ? { ...base, kind: t.kind } : base;
      });
      return { ok: true, snapshot: { ...prev, tasks: taskList } };
    }

    case "event:task_claimed": {
      // payload: { task_id }
      const payload = entry.payload as { task_id?: string };
      if (!payload.task_id) return invalidPayload(entry.kind, "missing task_id");
      const tasks = prev.tasks.map((t) =>
        t.id === payload.task_id ? { ...t, status: "in_progress" as const } : t,
      );
      return { ok: true, snapshot: { ...prev, tasks } };
    }

    case "event:task_step_started": {
      // payload: { task_id, step }
      const payload = entry.payload as { task_id?: string; step?: string };
      if (!payload.task_id || !payload.step) return invalidPayload(entry.kind, "missing task_id/step");
      const tasks = prev.tasks.map((t) =>
        t.id === payload.task_id
          ? { ...t, steps: { ...t.steps, [payload.step!]: { status: "running" as const } } }
          : t,
      );
      return { ok: true, snapshot: { ...prev, tasks } };
    }

    case "event:task_step_done": {
      // payload: { task_id, step, result? }
      const payload = entry.payload as { task_id?: string; step?: string; result?: "passed" | "failed" | "waived" | "na" };
      if (!payload.task_id || !payload.step) return invalidPayload(entry.kind, "missing task_id/step");
      const result = payload.result ?? "passed";
      const tasks = prev.tasks.map((t) =>
        t.id === payload.task_id
          ? { ...t, steps: { ...t.steps, [payload.step!]: { status: result } } }
          : t,
      );
      return { ok: true, snapshot: { ...prev, tasks } };
    }

    case "event:task_abandoned": {
      const payload = entry.payload as { task_id?: string };
      if (!payload.task_id) return invalidPayload(entry.kind, "missing task_id");
      const tasks = prev.tasks.map((t) =>
        t.id === payload.task_id ? { ...t, status: "abandoned" as const } : t,
      );
      return { ok: true, snapshot: { ...prev, tasks } };
    }

    case "event:spec_submitted": {
      // Whole-replacement entrypoint (protocol §576-587). `loaf spec submit`
      // emits this as batch_index=0 with companion add-* entries at
      // batch_index>=1. spec_submitted bumps state.spec_version and resets
      // the 3 projection arrays; companions repopulate within the batch.
      const payload = entry.payload as {
        spec_version?: number;
        feature?: { id?: string; name?: string };
        intent?: string;
      };
      if (typeof payload.spec_version !== "number") {
        return invalidPayload(entry.kind, "missing spec_version");
      }
      const versionCheck = checkSpecVersionHead(entry, payload.spec_version, prev.state.spec_version);
      if (!versionCheck.ok) {
        return invalidPayload(entry.kind, versionCheck.message);
      }
      return {
        ok: true,
        snapshot: {
          ...prev,
          state: { ...prev.state, spec_version: versionCheck.nextVersion },
          requirements: [],
          scenarios: [],
          visual_contracts: [],
        },
      };
    }

    case "event:spec_req_added": {
      const payload = entry.payload as { spec_version?: number; req?: RequirementPayload };
      if (typeof payload.spec_version !== "number" || !payload.req) {
        return invalidPayload(entry.kind, "missing spec_version or req");
      }
      const versionCheck = checkSpecVersion(entry, payload.spec_version, prev.state.spec_version);
      if (!versionCheck.ok) {
        return invalidPayload(entry.kind, versionCheck.message);
      }
      if (prev.requirements.some((r) => r.id === payload.req!.id)) {
        return invalidPayload(entry.kind, `DUPLICATE_REQ_ID: ${payload.req.id} already in projection`);
      }
      const slim = extractRequirementSlim(payload.req);
      prev.requirements.push(slim);
      return {
        ok: true,
        snapshot:
          versionCheck.nextVersion === prev.state.spec_version
            ? prev
            : { ...prev, state: { ...prev.state, spec_version: versionCheck.nextVersion } },
      };
    }

    case "event:spec_scenario_added": {
      const payload = entry.payload as { spec_version?: number; scenario?: ScenarioPayload };
      if (typeof payload.spec_version !== "number" || !payload.scenario) {
        return invalidPayload(entry.kind, "missing spec_version or scenario");
      }
      const versionCheck = checkSpecVersion(entry, payload.spec_version, prev.state.spec_version);
      if (!versionCheck.ok) {
        return invalidPayload(entry.kind, versionCheck.message);
      }
      if (prev.scenarios.some((s) => s.id === payload.scenario!.id)) {
        return invalidPayload(entry.kind, `DUPLICATE_SCEN_ID: ${payload.scenario.id} already in projection`);
      }
      const slim = extractScenarioSlim(payload.scenario);
      prev.scenarios.push(slim);
      return {
        ok: true,
        snapshot:
          versionCheck.nextVersion === prev.state.spec_version
            ? prev
            : { ...prev, state: { ...prev.state, spec_version: versionCheck.nextVersion } },
      };
    }

    case "event:spec_visual_added": {
      const payload = entry.payload as { spec_version?: number; visual?: VisualPayload };
      if (typeof payload.spec_version !== "number" || !payload.visual) {
        return invalidPayload(entry.kind, "missing spec_version or visual");
      }
      const versionCheck = checkSpecVersion(entry, payload.spec_version, prev.state.spec_version);
      if (!versionCheck.ok) {
        return invalidPayload(entry.kind, versionCheck.message);
      }
      if (prev.visual_contracts.some((v) => v.id === payload.visual!.id)) {
        return invalidPayload(entry.kind, `DUPLICATE_VIS_ID: ${payload.visual.id} already in projection`);
      }
      const slim = extractVisualSlim(payload.visual);
      prev.visual_contracts.push(slim);
      return {
        ok: true,
        snapshot:
          versionCheck.nextVersion === prev.state.spec_version
            ? prev
            : { ...prev, state: { ...prev.state, spec_version: versionCheck.nextVersion } },
      };
    }

    case "evidence:added": {
      const payload = entry.payload as { id?: string; kind?: string; result?: string; covers?: string[]; actor?: string };
      if (!payload.id || !payload.kind) return invalidPayload(entry.kind, "missing id/kind");
      const evBase: EvidenceState = {
        id: payload.id,
        kind: payload.kind,
        covers: payload.covers ?? [],
        actor: payload.actor ?? entry.actor,
      };
      const ev: EvidenceState = payload.result !== undefined ? { ...evBase, result: payload.result } : evBase;
      prev.evidence.push(ev);
      return { ok: true, snapshot: prev };
    }

    case "finding:raised": {
      const payload = entry.payload as { id?: string; category?: string; action?: string };
      if (!payload.id || !payload.category || !payload.action) {
        return invalidPayload(entry.kind, "missing id/category/action");
      }
      const f: FindingState = {
        id: payload.id,
        category: payload.category,
        action: payload.action,
        status: "open",
      };
      prev.findings.push(f);
      return { ok: true, snapshot: prev };
    }

    case "finding:closed": {
      const payload = entry.payload as { id?: string };
      if (!payload.id) return invalidPayload(entry.kind, "missing id");
      const idx = prev.findings.findIndex((f) => f.id === payload.id);
      if (idx === -1) {
        return {
          ok: false,
          code: "FINDING_NOT_FOUND",
          message: `finding:closed references unknown finding id=${payload.id}`,
        };
      }
      const findings = prev.findings.map((f, i) => (i === idx ? { ...f, status: "closed" as const } : f));
      return { ok: true, snapshot: { ...prev, findings } };
    }

    case "pending:added": {
      const payload = entry.payload as { id?: string; kind?: string };
      if (!payload.id || !payload.kind) return invalidPayload(entry.kind, "missing id/kind");
      const p: PendingState = { id: payload.id, kind: payload.kind, resolved: false };
      // Mutating push (apply is the SSoT for snapshot evolution; callers
      // treat the prev reference as consumed). Avoids O(N²) replay cost
      // for long pending queues.
      prev.pending.push(p);
      return { ok: true, snapshot: prev };
    }

    case "pending:resolved": {
      // FIFO: only the head (first unresolved) may be marked resolved per §10.7.
      const payload = entry.payload as { id?: string };
      if (!payload.id) return invalidPayload(entry.kind, "missing id");
      const headIdx = prev.pending.findIndex((p) => !p.resolved);
      if (headIdx === -1) {
        return {
          ok: false,
          code: "PENDING_NOT_FOUND",
          message: `pending:resolved with no pending head`,
        };
      }
      const head = prev.pending[headIdx]!;
      if (head.id !== payload.id) {
        return {
          ok: false,
          code: "PENDING_NOT_FOUND",
          message: `pending:resolved id=${payload.id} does not match head id=${head.id} (FIFO violation)`,
        };
      }
      const pending = prev.pending.map((p, i) =>
        i === headIdx ? { ...p, resolved: true } : p,
      );
      return { ok: true, snapshot: { ...prev, pending } };
    }

    case "session:delivered": {
      return {
        ok: true,
        snapshot: {
          ...prev,
          state: { ...prev.state, sub_state: "DONE.delivered", phase: "DONE" },
        },
      };
    }
    case "session:archived": {
      return {
        ok: true,
        snapshot: {
          ...prev,
          state: { ...prev.state, sub_state: "DONE.archived", phase: "DONE" },
        },
      };
    }
    case "session:abandoned": {
      return {
        ok: true,
        snapshot: {
          ...prev,
          state: { ...prev.state, sub_state: "DONE.abandoned", phase: "DONE" },
        },
      };
    }

    default: {
      // Audit r1 fix #5 — silent no-op was a "pass-through reducer" bug;
      // preflight passed but projection was never mutated. Unimplemented
      // kinds now fail-fast with REDUCER_NOT_IMPLEMENTED so the gap is
      // visible to CI and to the journal-mutate caller.
      const _exhaustive: EntryKind = entry.kind;
      return {
        ok: false,
        code: "REDUCER_NOT_IMPLEMENTED",
        message: `reducer.apply has no handler for kind=${_exhaustive}`,
        detail: { kind: _exhaustive },
      };
    }
  }
}

function invalidPayload(kind: string, reason: string): ApplyResult {
  return {
    ok: false,
    code: "INVALID_PAYLOAD",
    message: `${kind}: ${reason}`,
  };
}

// ── SPEC content reducer helpers (Slice 1.B sub-cycle 1) ─────────────────
// spec_version monotonic invariant + slim projection extraction.
//
// `loaf spec submit` is a batch: spec_submitted at batch_index=0 followed
// by companion add-* entries at index>=1, all sharing batch_id and
// spec_version. Standalone `loaf spec add-req|add-scenario|add-visual` is
// also a batch (single entry or N entries) sharing one spec_version.
//
// Reducer disambiguates new-invocation head vs continuation via
// entry.batch_index:
//   - undefined | 0 → must bump (payload.spec_version === current + 1)
//   - >0            → must equal current (already bumped by batch head)

type RequirementPayload = {
  id: string;
  type: RequirementState["type"];
  measurable?: RequirementState["measurable"];
  verified_by_scenarios?: string[];
  acceptance_na?: true;
  acceptance_na_reason?: string;
};

type ScenarioPayload = {
  id: string;
  tag?: ScenarioState["tag"];
  requires_acceptance?: boolean;
  acceptance_na?: string;
};

type VisualPayload = {
  id: string;
  requires_visual?: boolean;
  visual_na?: string;
};

type SpecVersionCheck =
  | { ok: true; nextVersion: number }
  | { ok: false; message: string };

function checkSpecVersionHead(
  entry: JournalEntry,
  payloadVersion: number,
  currentVersion: number,
): SpecVersionCheck {
  // spec_submitted is always batch head — either standalone (no envelope)
  // or batch_index=0. batch_index>0 is illegal for spec_submitted.
  if (entry.batch_index !== undefined && entry.batch_index !== 0) {
    return {
      ok: false,
      message: `SPEC_VERSION_BATCH_MISMATCH: spec_submitted must appear at batch_index=0, got ${entry.batch_index}`,
    };
  }
  if (payloadVersion !== currentVersion + 1) {
    return {
      ok: false,
      message: `SPEC_VERSION_NOT_MONOTONIC: spec_version must be ${currentVersion + 1} (current+1), got ${payloadVersion}`,
    };
  }
  return { ok: true, nextVersion: payloadVersion };
}

function checkSpecVersion(
  entry: JournalEntry,
  payloadVersion: number,
  currentVersion: number,
): SpecVersionCheck {
  const isHead = entry.batch_index === undefined || entry.batch_index === 0;
  if (isHead) {
    if (payloadVersion !== currentVersion + 1) {
      return {
        ok: false,
        message: `SPEC_VERSION_NOT_MONOTONIC: spec_version must be ${currentVersion + 1} (current+1) at batch head, got ${payloadVersion}`,
      };
    }
    return { ok: true, nextVersion: payloadVersion };
  }
  // batch continuation — head already bumped state.
  if (payloadVersion !== currentVersion) {
    return {
      ok: false,
      message: `SPEC_VERSION_BATCH_MISMATCH: spec_version must be ${currentVersion} at batch_index=${entry.batch_index}, got ${payloadVersion}`,
    };
  }
  return { ok: true, nextVersion: currentVersion };
}

function extractRequirementSlim(req: RequirementPayload): RequirementState {
  const slim: RequirementState = { id: req.id, type: req.type };
  if (req.measurable !== undefined) slim.measurable = req.measurable;
  if (req.verified_by_scenarios !== undefined) slim.verified_by_scenarios = req.verified_by_scenarios;
  if (req.acceptance_na !== undefined) slim.acceptance_na = req.acceptance_na;
  if (req.acceptance_na_reason !== undefined) slim.acceptance_na_reason = req.acceptance_na_reason;
  return slim;
}

function extractScenarioSlim(scenario: ScenarioPayload): ScenarioState {
  const slim: ScenarioState = { id: scenario.id };
  if (scenario.tag !== undefined) slim.tag = scenario.tag;
  if (scenario.requires_acceptance !== undefined) slim.requires_acceptance = scenario.requires_acceptance;
  if (scenario.acceptance_na !== undefined) slim.acceptance_na = scenario.acceptance_na;
  return slim;
}

function extractVisualSlim(visual: VisualPayload): VisualContractState {
  const slim: VisualContractState = { id: visual.id };
  if (visual.requires_visual !== undefined) slim.requires_visual = visual.requires_visual;
  if (visual.visual_na !== undefined) slim.visual_na = visual.visual_na;
  return slim;
}
