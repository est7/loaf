// Reducer apply path — minimum viable Stage 2.
//
// preflight() (§11.2 step 3) validates authority + transition; apply() (step 7)
// narrows on kind and consumes prev while mutating the projection. Returns
// Result so callers can branch on typed error codes without try/catch.
//
// Stage 2 scope intentionally narrow: handle just enough kinds to demonstrate
// the apply path (`session:started`, `event:phase_advanced`, `gate:decided`).
// Remaining kinds — task lifecycle, evidence, findings, pending, settle, etc.
// — land incrementally in Stages 2-4 alongside their projections.

import type { Ceremony, EntryKind, JournalEntry, SubState } from "./journal-entry.js";
import { diagnostic } from "./error-catalog.js";
import { preflight } from "./reducer/preflight.js";
import type { PreflightFailureCode } from "./reducer/preflight.js";
import {
  checkSpecVersion as specVersionRule,
  findCollision,
  findDuplicateId,
  resolveSpecVersionMode,
} from "./reducer/invariants.js";
import { extractTaskSlim, shouldPromoteToDone } from "./task-schema.js";
import type { TaskFullProjection } from "./task-schema.js";
import type {
  AttachmentPayload,
  EvidenceKind,
  EvidenceResult,
  VerifyCheckKind,
} from "./evidence-schema.js";
import type { NeedsClarification } from "./spec-schema.js";
import type {
  EvidenceState,
  FindingState,
  PendingState,
  RequirementState,
  ScenarioState,
  SessionState,
  Snapshot,
  SpecHeader,
  TaskState,
  TaskStepStatus,
  VisualContractState,
} from "./projection-types.js";

// Compat re-export: the dozens of existing consumers continue importing the
// projection types from `reducer.js`; the canonical declarations now live in
// the leaf module `projection-types.js` (P2/SC-7).
export type {
  SessionState,
  TaskStepStatus,
  TaskStepApplicability,
  TaskKind,
  TaskState,
  EvidenceState,
  FindingState,
  PendingState,
  RequirementState,
  ScenarioState,
  VisualContractState,
  SpecHeader,
  Snapshot,
} from "./projection-types.js";

export function initialSnapshot(): Snapshot {
  return {
    state: null,
    tasks: [],
    evidence: [],
    findings: [],
    pending: [],
    spec_header: null,
    requirements: [],
    scenarios: [],
    visual_contracts: [],
    tasks_based_on: null,
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
        | "FINDING_NOT_FOUND"
        | "TASK_NOT_FOUND"
        | "TASK_STEP_NOT_FOUND";
      message: string;
      detail?: Record<string, unknown>;
    };

export type ApplyFailureCode = Extract<ApplyResult, { ok: false }>["code"];

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

/**
 * Applies one journal entry with the public validation order preserved:
 * bootstrap bypass, NO_SESSION, preflight, then projection mutation.
 */
export function apply(prev: Snapshot, entry: JournalEntry): ApplyResult {
  if (
    entry.kind === "migration:snapshot_imported" ||
    entry.kind === "session:started"
  ) {
    return applyValidated(prev, entry);
  }

  if (prev.state === null) {
    return {
      ok: false,
      code: "NO_SESSION",
      message: `kind=${entry.kind} requires a started session`,
    };
  }

  const pre = preflight(entry, { snapshot: prev });
  if (!pre.ok) {
    return { ok: false, code: pre.code, message: pre.message, detail: pre.detail ?? {} };
  }

  return applyValidated(prev, entry);
}

/**
 * Replay admission preserves journal shapes that were legal when written.
 *
 * New mutation paths go through `apply()` and cannot enter the retired
 * reconcile cursor. Historical journals may contain the former
 * VERIFY.accept → SETTLE.reconcile edge, so replay admits that one exact
 * transition after envelope validation and otherwise keeps current preflight.
 *
 * @internal Journal replay only.
 */
export function applyReplayed(prev: Snapshot, entry: JournalEntry): ApplyResult {
  const payload = entry.payload as { from?: unknown; to?: unknown };
  if (
    prev.state?.sub_state === "VERIFY.accept" &&
    entry.kind === "event:phase_advanced" &&
    payload.from === "VERIFY.accept" &&
    payload.to === "SETTLE.reconcile"
  ) {
    return applyValidated(prev, entry);
  }
  return apply(prev, entry);
}

/**
 * Applies an entry whose external validation has already succeeded.
 *
 * `prev` is consumed. Some cases mutate projection arrays in place and may
 * return the same snapshot object or array references.
 *
 * @internal Only validation-owning core paths may call this directly.
 */
export function applyValidated(prev: Snapshot, entry: JournalEntry): ApplyResult {
  // migration:snapshot_imported is also a bootstrap kind — it initializes
  // state from a v0.0.x legacy projection. Stage 5 MVP records the entry but
  // defers full projection rehydration (state stays at TRIAGE.score with a
  // default ceremony; the real state lives in attachments/JE-000000/migration/
  // and projection writers in later stages will rehydrate).
  if (entry.kind === "migration:snapshot_imported") {
    if (prev.state !== null) {
      return {
        ok: false,
        ...diagnostic("ALREADY_STARTED", { kind: entry.kind }),
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
        ...diagnostic("ALREADY_STARTED", { kind: entry.kind }),
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

  // applyValidated is an internal post-validation seam. Bootstrap kinds
  // returned above; validation-owning callers guarantee initialized state
  // for every remaining kind.
  const state = prev.state!;

  // Apply per-kind state mutations.
  switch (entry.kind) {
    case "event:phase_advanced": {
      const payload = entry.payload as { to: SubState; back_edge?: { action: string } };
      const next: SessionState = {
        ...state,
        sub_state: payload.to,
        phase: extractPhase(payload.to),
        // Slice B: reset spec_locked on any transition into SPEC.spec
        // (forward SPEC.proposal→SPEC.spec OR back-edge from EXECUTE.*
        // / VERIFY.* sponsored by an amend-spec finding). Forward case
        // is a no-op (spec_locked already false at SPEC.proposal);
        // back-edge case lifts the lock so subsequent spec_*_added
        // events can fire (SPEC_LOCKED_NO_DIRECT_EDIT preflight gates
        // those when locked).
        spec_locked: payload.to === "SPEC.spec" ? false : state.spec_locked,
        // Phase 11 Item 3 SC0: every finding back-edge increments
        // iteration by 1 (protocol.md §1 L210-212). A plain forward
        // `advance` carries no `back_edge` and leaves iteration alone.
        iteration:
          payload.back_edge !== undefined ? state.iteration + 1 : state.iteration,
      };
      return { ok: true, snapshot: { ...prev, state: next } };
    }

    case "event:ceremony_set": {
      const payload = entry.payload as Ceremony;
      return {
        ok: true,
        snapshot: { ...prev, state: { ...state, ceremony: payload } },
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
            snapshot: { ...prev, state: { ...state, spec_locked: true } },
          };
        }
        return { ok: true, snapshot: prev };
      }
      if (payload.gate_kind === "verify-accept") {
        if (payload.decision === "approved") {
          return {
            ok: true,
            snapshot: { ...prev, state: { ...state, verify_accepted: true } },
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
      // Slice 1.B sub-cycle 3a: full TaskFull payload + tasks_based_on.
      // Replaces the whole tasks projection (per protocol §624-626: tasks
      // submit is whole-replacement) and freezes the spec version this
      // task graph derives from. PER_KIND_PAYLOAD strict-validates the
      // payload shape before this handler runs (preflight gate), so
      // duplicate-id refines + kind-specific required fields are already
      // enforced; reducer adds a defense-in-depth duplicate-id sweep per
      // codex r24 note #5.
      const payload = entry.payload as {
        based_on?: { spec?: number };
        tasks?: ReadonlyArray<TaskFullProjection>;
      };
      if (typeof payload.based_on?.spec !== "number") {
        return invalidPayload(entry.kind, "missing based_on.spec");
      }
      const incoming = payload.tasks ?? [];
      const dup = findDuplicateId(incoming.map((t) => t.id));
      if (dup) {
        return invalidPayload(
          entry.kind,
          `DUPLICATE_TASK_ID: ${dup.id} appears more than once in tasks_planned payload`,
        );
      }
      const taskList: TaskState[] = incoming.map(extractTaskSlim);
      return {
        ok: true,
        snapshot: {
          ...prev,
          tasks: taskList,
          tasks_based_on: { spec: payload.based_on.spec },
        },
      };
    }

    case "event:tasks_amended": {
      // Slice 1.B sub-cycle 3a (F-010 #1+#2) + Slice C SC-C2b mode
      // discriminator. `mode` defaults to "replace" — absent on pre-mode
      // entries, which replay with the historical replace-only semantics.
      //   replace: overwrite an existing task by id; missing → TASK_NOT_FOUND.
      //   add:     append a task; id already present → DUPLICATE_TASK_ID.
      // §8.6 mutation-rights + add-authority gating live in preflight; this
      // handler keeps the existence checks as defense-in-depth for raw apply.
      const payload = entry.payload as {
        mode?: "add" | "replace";
        task?: TaskFullProjection;
        reason?: string;
      };
      if (!payload.task) return invalidPayload(entry.kind, "missing task");
      const mode = payload.mode ?? "replace";
      const idx = prev.tasks.findIndex((t) => t.id === payload.task!.id);
      if (mode === "add") {
        if (idx !== -1) {
          return {
            ok: false,
            code: "DUPLICATE_TASK_ID",
            message: `tasks_amended add: task ${payload.task.id} is already in the projection`,
            detail: { task_id: payload.task.id },
          };
        }
        const slim = extractTaskSlim(payload.task);
        return { ok: true, snapshot: { ...prev, tasks: [...prev.tasks, slim] } };
      }
      if (idx === -1) {
        return {
          ok: false,
          code: "TASK_NOT_FOUND",
          message: `tasks_amended: task ${payload.task.id} not in projection`,
          detail: { task_id: payload.task.id },
        };
      }
      const slim = extractTaskSlim(payload.task);
      const tasks = prev.tasks.map((t, i) => (i === idx ? slim : t));
      return { ok: true, snapshot: { ...prev, tasks } };
    }

    case "event:task_claimed": {
      // Slice 2 SC1 (codex r56 BLOCK 3a): defense-in-depth TASK_NOT_FOUND.
      // Preflight step 5e is authoritative — task existence + claimability +
      // deps_on satisfied are all gated there before reducer dry-run. This
      // fall-through fail-fast prevents the historical silent-no-op (where
      // an unknown task_id would skip the .map predicate without touching
      // the projection, returning ok=true).
      const payload = entry.payload as { task_id?: string };
      if (!payload.task_id) return invalidPayload(entry.kind, "missing task_id");
      const task = prev.tasks.find((t) => t.id === payload.task_id);
      if (!task) {
        return {
          ok: false,
          code: "TASK_NOT_FOUND",
          message: `task_claimed: task ${payload.task_id} not in projection`,
          detail: { task_id: payload.task_id },
        };
      }
      const tasks = prev.tasks.map((t) =>
        t.id === payload.task_id ? { ...t, status: "in_progress" as const } : t,
      );
      return { ok: true, snapshot: { ...prev, tasks } };
    }

    case "event:task_step_started": {
      // Slice 1.B sub-cycle 3a (codex r24 note #3): fail fast on missing
      // task or unseeded step so we don't silently add a step without
      // applicability metadata (which would later subvert auto-promote).
      const payload = entry.payload as { task_id?: string; step?: string };
      if (!payload.task_id || !payload.step)
        return invalidPayload(entry.kind, "missing task_id/step");
      const task = prev.tasks.find((t) => t.id === payload.task_id);
      if (!task) {
        return {
          ok: false,
          code: "TASK_NOT_FOUND",
          message: `task_step_started: task ${payload.task_id} not in projection`,
          detail: { task_id: payload.task_id },
        };
      }
      const seeded = task.steps[payload.step];
      if (!seeded) {
        return {
          ok: false,
          code: "TASK_STEP_NOT_FOUND",
          message: `task_step_started: step ${payload.step} not seeded on task ${payload.task_id}`,
          detail: { task_id: payload.task_id, step: payload.step },
        };
      }
      const tasks = prev.tasks.map((t) =>
        t.id === payload.task_id
          ? {
              ...t,
              steps: {
                ...t.steps,
                [payload.step!]: {
                  applicability: seeded.applicability,
                  status: "running" as const,
                },
              },
            }
          : t,
      );
      return { ok: true, snapshot: { ...prev, tasks } };
    }

    case "event:task_step_done": {
      // Slice 1.B sub-cycle 3a (F-010 #3 + codex r24 note #3):
      //   - fail fast on missing task / unseeded step
      //   - auto-promote task.status="done" when every must-applicable
      //     step is terminal-positive (passed|waived|na). optional steps
      //     never block; failed/running/pending must blocks promotion
      const payload = entry.payload as {
        task_id?: string;
        step?: string;
        result?: "passed" | "failed" | "waived" | "na";
        red_test_registered?: boolean;
      };
      if (!payload.task_id || !payload.step)
        return invalidPayload(entry.kind, "missing task_id/step");
      const task = prev.tasks.find((t) => t.id === payload.task_id);
      if (!task) {
        return {
          ok: false,
          code: "TASK_NOT_FOUND",
          message: `task_step_done: task ${payload.task_id} not in projection`,
          detail: { task_id: payload.task_id },
        };
      }
      const seeded = task.steps[payload.step];
      if (!seeded) {
        return {
          ok: false,
          code: "TASK_STEP_NOT_FOUND",
          message: `task_step_done: step ${payload.step} not seeded on task ${payload.task_id}`,
          detail: { task_id: payload.task_id, step: payload.step },
        };
      }
      const newStatus: TaskStepStatus = payload.result ?? "passed";
      const updatedSteps = {
        ...task.steps,
        [payload.step]: { applicability: seeded.applicability, status: newStatus },
      };
      const nextStatus: TaskState["status"] =
        task.status === "done" ? "done" : shouldPromoteToDone(updatedSteps) ? "done" : task.status;
      // Slice C SC-C4 (R2): a red-step task_step_done carrying
      // red_test_registered=true (emitted by `loaf tasks register-red`)
      // promotes the flag to task-level. preflight's BUG_TASK_FLAG_MISUSE
      // gate guarantees the flag only arrives on a legal red registration.
      const tasks = prev.tasks.map((t) =>
        t.id === payload.task_id
          ? {
              ...t,
              steps: updatedSteps,
              status: nextStatus,
              ...(payload.red_test_registered === true ? { red_test_registered: true } : {}),
            }
          : t,
      );
      return { ok: true, snapshot: { ...prev, tasks } };
    }

    case "event:task_step_reset": {
      // Phase 11 Item 3 SC2 (codex r139 Q5): `loaf finding raise --action
      // fix-impl` co-emits this inside its 3-entry back-edge batch. It
      // resets the target repair step to `pending` AND reopens the task to
      // `in_progress` — even a `done` task, because event:task_step_started
      // / task_step_done preflight require task.status==="in_progress" to
      // re-run the step. The reset is status-only: applicability is
      // preserved, and the body-only fields started_at /
      // reason are NOT erased (SC1b Q4 history-preservation rule — the slim
      // projection does not carry them anyway). Preflight is authoritative
      // for the sponsorship + target-authority refines; the fail-fast
      // checks here are defense-in-depth against a raw apply path.
      const payload = entry.payload as { task_id?: string; step?: string };
      if (!payload.task_id || !payload.step) {
        return invalidPayload(entry.kind, "missing task_id/step");
      }
      const task = prev.tasks.find((t) => t.id === payload.task_id);
      if (!task) {
        return {
          ok: false,
          code: "TASK_NOT_FOUND",
          message: `task_step_reset: task ${payload.task_id} not in projection`,
          detail: { task_id: payload.task_id },
        };
      }
      const seeded = task.steps[payload.step];
      if (!seeded) {
        return {
          ok: false,
          code: "TASK_STEP_NOT_FOUND",
          message: `task_step_reset: step ${payload.step} not seeded on task ${payload.task_id}`,
          detail: { task_id: payload.task_id, step: payload.step },
        };
      }
      const tasks = prev.tasks.map((t) =>
        t.id === payload.task_id
          ? {
              ...t,
              status: "in_progress" as const,
              steps: {
                ...t.steps,
                [payload.step!]: {
                  applicability: seeded.applicability,
                  status: "pending" as const,
                },
              },
            }
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
      // batch_index>=1. spec_submitted bumps state.spec_version, populates
      // spec_header from payload (Slice A SC1 widen), and resets the 3
      // projection arrays so companions repopulate from scratch within
      // the batch.
      //
      // apply() runs preflight() before this switch (~L287-295) for
      // non-bootstrap kinds, and preflight parses PER_KIND_PAYLOAD —
      // SpecSubmittedPayload is .strict and requires feature{id,name} /
      // intent / adr_refs / needs_clarification. We rely on that: no
      // defensive `?? "" / []` fallbacks (codex r88 — those would be
      // dead silent fallbacks masking a misuse). The `typeof spec_version
      // !== "number"` guard stays for consistency with sibling cases.
      const payload = entry.payload as {
        spec_version: number;
        feature: { id: string; name: string };
        intent: string;
        adr_refs: string[];
        needs_clarification: NeedsClarification[];
      };
      if (typeof payload.spec_version !== "number") {
        return invalidPayload(entry.kind, "missing spec_version");
      }
      const versionCheck = checkSpecVersionHead(
        entry,
        payload.spec_version,
        state.spec_version,
      );
      if (!versionCheck.ok) {
        return invalidPayload(entry.kind, versionCheck.message);
      }
      // structuredClone to isolate the snapshot's spec_header from
      // entry.payload aliasing (codex r88 — projection that SC-A2 will
      // re-serialize must not share pointers with caller-owned objects).
      const specHeader: SpecHeader = structuredClone({
        feature: { id: payload.feature.id, name: payload.feature.name },
        intent: payload.intent,
        adr_refs: payload.adr_refs,
        needs_clarification: payload.needs_clarification,
      });
      return {
        ok: true,
        snapshot: {
          ...prev,
          state: { ...state, spec_version: versionCheck.nextVersion },
          spec_header: specHeader,
          requirements: [],
          scenarios: [],
          visual_contracts: [],
        },
      };
    }

    case "event:spec_req_added": {
      const payload = entry.payload as { spec_version?: number; req?: RequirementState };
      if (typeof payload.spec_version !== "number" || !payload.req) {
        return invalidPayload(entry.kind, "missing spec_version or req");
      }
      const versionCheck = checkSpecVersion(entry, payload.spec_version, state.spec_version);
      if (!versionCheck.ok) {
        return invalidPayload(entry.kind, versionCheck.message);
      }
      if (findCollision(payload.req.id, prev.requirements, (r) => r.id)) {
        return invalidPayload(
          entry.kind,
          `DUPLICATE_REQ_ID: ${payload.req.id} already in projection`,
        );
      }
      // Slice A SC1 widen: push full payload.req (was extractRequirementSlim).
      // structuredClone isolates projection from caller-owned object
      // (codex r88 — mirrors extractTaskSlim's fresh-object discipline).
      prev.requirements.push(structuredClone(payload.req));
      return {
        ok: true,
        snapshot:
          versionCheck.nextVersion === state.spec_version
            ? prev
            : { ...prev, state: { ...state, spec_version: versionCheck.nextVersion } },
      };
    }

    case "event:spec_scenario_added": {
      const payload = entry.payload as { spec_version?: number; scenario?: ScenarioState };
      if (typeof payload.spec_version !== "number" || !payload.scenario) {
        return invalidPayload(entry.kind, "missing spec_version or scenario");
      }
      const versionCheck = checkSpecVersion(entry, payload.spec_version, state.spec_version);
      if (!versionCheck.ok) {
        return invalidPayload(entry.kind, versionCheck.message);
      }
      if (findCollision(payload.scenario.id, prev.scenarios, (s) => s.id)) {
        return invalidPayload(
          entry.kind,
          `DUPLICATE_SCEN_ID: ${payload.scenario.id} already in projection`,
        );
      }
      prev.scenarios.push(structuredClone(payload.scenario));
      return {
        ok: true,
        snapshot:
          versionCheck.nextVersion === state.spec_version
            ? prev
            : { ...prev, state: { ...state, spec_version: versionCheck.nextVersion } },
      };
    }

    case "event:spec_visual_added": {
      const payload = entry.payload as { spec_version?: number; visual?: VisualContractState };
      if (typeof payload.spec_version !== "number" || !payload.visual) {
        return invalidPayload(entry.kind, "missing spec_version or visual");
      }
      const versionCheck = checkSpecVersion(entry, payload.spec_version, state.spec_version);
      if (!versionCheck.ok) {
        return invalidPayload(entry.kind, versionCheck.message);
      }
      if (findCollision(payload.visual.id, prev.visual_contracts, (v) => v.id)) {
        return invalidPayload(
          entry.kind,
          `DUPLICATE_VIS_ID: ${payload.visual.id} already in projection`,
        );
      }
      prev.visual_contracts.push(structuredClone(payload.visual));
      return {
        ok: true,
        snapshot:
          versionCheck.nextVersion === state.spec_version
            ? prev
            : { ...prev, state: { ...state, spec_version: versionCheck.nextVersion } },
      };
    }

    case "evidence:added": {
      // Slice 1.C sub-cycle 1 (codex r33 Q2 + r34 BLOCK 2): payload is
      // strict-validated against EvidenceFullPayload at journal-mutate Pass 1
      // (PER_KIND_PAYLOAD lookup). EvidenceFullPayload is `.strict()` and
      // requires id/kind/iteration/actor/result/summary. Reducer extracts the
      // slim projection subset narrowed to EvidenceState fields; the full
      // payload (iteration/summary/cmd/exit/wall_ms/task_id/gate/decided_by/
      // based_on/waiver_obligation_id/external_ref) round-trips via the
      // journal itself, not projection. Defense-in-depth: id/kind presence
      // still checked here in case a future code path skips the schema gate.
      const payload = entry.payload as {
        id?: string;
        kind?: EvidenceKind;
        result?: EvidenceResult;
        covers?: string[];
        actor?: string;
        check?: VerifyCheckKind;
        reason?: string;
        attachments?: AttachmentPayload[];
      };
      if (!payload.id || !payload.kind) return invalidPayload(entry.kind, "missing id/kind");
      const ev: EvidenceState = {
        id: payload.id,
        kind: payload.kind,
        covers: payload.covers ?? [],
        actor: payload.actor ?? entry.actor,
      };
      if (payload.result !== undefined) ev.result = payload.result;
      if (payload.check !== undefined) ev.check = payload.check;
      if (payload.reason !== undefined) ev.reason = payload.reason;
      if (payload.attachments !== undefined) ev.attachments = payload.attachments;
      prev.evidence.push(ev);
      return { ok: true, snapshot: prev };
    }

    case "lesson:recorded": {
      // Lessons are projected directly from journal history. Keep this an
      // explicit no-op so they cannot leak into evidence-derived gates,
      // counts, board, TUI, or resume-pack surfaces.
      return { ok: true, snapshot: prev };
    }

    case "scope:recorded": {
      // Actual scope is audit-only journal data projected from the full entry
      // stream. It may be sidecar-backed, while applyValidated is synchronous;
      // keeping this an explicit no-op prevents it from leaking into gate state.
      return { ok: true, snapshot: prev };
    }

    case "finding:raised": {
      // Payload schema strict-validated at preflight (PER_KIND_PAYLOAD →
      // FindingRaisedPayload). Defense-in-depth id/category/action check
      // retained for raw mutate paths that bypass preflight.
      const payload = entry.payload as {
        id?: string;
        category?: string;
        action?: string;
        summary?: string;
        reason?: string;
        target?: { task_id: string; step: string };
      };
      if (!payload.id || !payload.category || !payload.action) {
        return invalidPayload(entry.kind, "missing id/category/action");
      }
      const f: FindingState = {
        id: payload.id,
        category: payload.category,
        action: payload.action,
        status: "open",
      };
      if (payload.summary !== undefined) f.summary = payload.summary;
      if (payload.reason !== undefined) f.reason = payload.reason;
      if (payload.target !== undefined) f.target = payload.target;
      prev.findings.push(f);
      return { ok: true, snapshot: prev };
    }

    case "finding:closed": {
      // Slice 3 SC3 (codex r68 #4): close is idempotent only at the
      // already-closed level — re-emitting finding:closed on a closed
      // finding returns FINDING_NOT_FOUND with detail.reason=already_closed
      // so the projection stays a single-source contract (one close per
      // finding, no silent retry that would re-emit an audit-trail entry).
      const payload = entry.payload as { id?: string };
      if (!payload.id) return invalidPayload(entry.kind, "missing id");
      const idx = prev.findings.findIndex((f) => f.id === payload.id);
      if (idx === -1) {
        return {
          ok: false,
          code: "FINDING_NOT_FOUND",
          message: `finding:closed references unknown finding id=${payload.id}`,
          detail: { id: payload.id, reason: "unknown" },
        };
      }
      const existing = prev.findings[idx]!;
      if (existing.status === "closed") {
        return {
          ok: false,
          code: "FINDING_NOT_FOUND",
          message: `finding:closed references finding id=${payload.id} that is already closed`,
          detail: { id: payload.id, reason: "already_closed" },
        };
      }
      const findings = prev.findings.map((f, i) =>
        i === idx ? { ...f, status: "closed" as const } : f,
      );
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
          ...diagnostic("PENDING_NOT_FOUND", { reason: "no pending head" }),
          message: `pending:resolved with no pending head`,
        };
      }
      const head = prev.pending[headIdx]!;
      if (head.id !== payload.id) {
        return {
          ok: false,
          ...diagnostic("PENDING_NOT_FOUND", {
            reason: `id=${payload.id} does not match head id=${head.id} (FIFO violation)`,
          }),
          message: `pending:resolved id=${payload.id} does not match head id=${head.id} (FIFO violation)`,
        };
      }
      const pending = prev.pending.map((p, i) => (i === headIdx ? { ...p, resolved: true } : p));
      return { ok: true, snapshot: { ...prev, pending } };
    }

    case "session:delivered": {
      return {
        ok: true,
        snapshot: {
          ...prev,
          state: { ...state, sub_state: "DONE.delivered", phase: "DONE" },
        },
      };
    }
    case "session:archived": {
      return {
        ok: true,
        snapshot: {
          ...prev,
          state: { ...state, sub_state: "DONE.archived", phase: "DONE" },
        },
      };
    }
    case "session:abandoned": {
      return {
        ok: true,
        snapshot: {
          ...prev,
          state: { ...state, sub_state: "DONE.abandoned", phase: "DONE" },
        },
      };
    }

    case "session:resumed": {
      // Phase 16 SC-13b — transparent no-op marker. `loaf resume`
      // records that a fresh session is continuing from a resume-pack
      // (typed payload `resumed_from_pack: {at, reason, session_id}`),
      // but the cursor / projection state stays exactly where it was.
      // Per codex r343 P3, an explicit case keeps the switch honest
      // with REDUCER_IMPLEMENTED_KINDS.
      return { ok: true, snapshot: prev };
    }

    case "spike:converted": {
      // Record-only audit entry (protocol §8.3, Phase 12). The terminal
      // cursor flip to DONE.archived rides the sponsored `session:archived`
      // emitted in the same `loaf spike convert` batch — this kind does not
      // move the cursor. An explicit no-op case (rather than falling through
      // to `default` → REDUCER_NOT_IMPLEMENTED) keeps the switch honest with
      // REDUCER_IMPLEMENTED_KINDS.
      return { ok: true, snapshot: prev };
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

type SpecVersionCheck = { ok: true; nextVersion: number } | { ok: false; message: string };

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
  // Structural guard above stays OUTSIDE the shared predicate (it has no
  // kind/batch_index); only the monotonic compare delegates (L3).
  const r = specVersionRule(payloadVersion, currentVersion, "head");
  return r.ok
    ? { ok: true, nextVersion: r.nextVersion }
    : {
        ok: false,
        message: `SPEC_VERSION_NOT_MONOTONIC: spec_version must be ${r.expected} (current+1), got ${payloadVersion}`,
      };
}

function checkSpecVersion(
  entry: JournalEntry,
  payloadVersion: number,
  currentVersion: number,
): SpecVersionCheck {
  const mode = resolveSpecVersionMode(entry.batch_index);
  const r = specVersionRule(payloadVersion, currentVersion, mode);
  if (r.ok) return { ok: true, nextVersion: r.nextVersion };
  return {
    ok: false,
    message:
      mode === "head"
        ? `SPEC_VERSION_NOT_MONOTONIC: spec_version must be ${r.expected} (current+1) at batch head, got ${payloadVersion}`
        : `SPEC_VERSION_BATCH_MISMATCH: spec_version must be ${r.expected} at batch_index=${entry.batch_index}, got ${payloadVersion}`,
  };
}

// Slice A SC1: slim extractors removed. RequirementState / ScenarioState /
// VisualContractState are now the full RequirementEarsShape / ScenarioGherkin
// / VisualContract z.infer types; reducer apply pushes the full payload
// directly. composeSpecMdFrontmatter (SC-A2) re-serializes from snapshot.
