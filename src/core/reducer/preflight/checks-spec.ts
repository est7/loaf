import type { EntryKind } from "../../journal-entry.js";
import {
  checkSpecVersion as specVersionRule,
  findCollision,
  resolveSpecVersionMode,
} from "../invariants.js";
import type { PreflightCheckCtx, PreflightFailure } from "../preflight.js";

const SPEC_CONTENT_KINDS = new Set<EntryKind>([
  "event:spec_submitted",
  "event:spec_req_added",
  "event:spec_scenario_added",
  "event:spec_visual_added",
]);

const SPEC_VERSION_KINDS = new Set<EntryKind>([
  "event:spec_submitted",
  "event:spec_req_added",
  "event:spec_scenario_added",
  "event:spec_visual_added",
]);

export function checkSpecContentPhase(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, ctx } = c;
  if (SPEC_CONTENT_KINDS.has(entry.kind)) {
    if (ctx.snapshot.state?.spec_locked === true) {
      return {
        ok: false,
        code: "SPEC_LOCKED_NO_DIRECT_EDIT",
        message:
          `${entry.kind} blocked: spec_locked=true; ` +
          `walk back via \`loaf finding raise --category spec-gap --action amend-spec\` to re-enter SPEC.spec`,
        detail: { kind: entry.kind, spec_locked: true },
      };
    }
    if (entry.kind !== "event:spec_submitted" && (ctx.snapshot.state?.spec_version ?? 0) === 0) {
      return {
        ok: false,
        code: "SPEC_NOT_INITIALIZED",
        message:
          `${entry.kind} blocked: spec is not initialized (spec_version=0); ` +
          `run \`loaf spec submit --input <file>\` first to bump spec_version to 1`,
        detail: { kind: entry.kind, spec_version: ctx.snapshot.state?.spec_version ?? 0 },
      };
    }
  }
  return null;
}

// (5h) Slice 4 SC1 — DUPLICATE_REQ_ID / DUPLICATE_SCEN_ID /
// DUPLICATE_VIS_ID preflight promotion. Mirrors the DUPLICATE_TASK_ID
// pattern from Slice 2 SC4: reducer keeps its defensive message-string
// check as fallback for raw mutate paths, but the public surface code
// surfaces here so CLI can emit it directly (not wrapped as REDUCER_ERROR).
// Within a submit batch the second occurrence sees the first already in
// ctx.snapshot via mutateBatch dry-run accumulation; cross-invocation
// collisions hit the same path. Note: only entries with batch_index >= 1
// OR standalone add-* invocations should hit projection collision; the
// batch head (spec_submitted, batch_index=0) does not carry req/scen/vis
// payload, so this check only fires on the three add-* kinds.
export function checkSpecDuplicateIds(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, payloadData, ctx } = c;
  if (entry.kind === "event:spec_req_added") {
    const payload = payloadData as { req: { id: string } };
    if (findCollision(payload.req.id, ctx.snapshot.requirements, (r) => r.id)) {
      return {
        ok: false,
        code: "DUPLICATE_REQ_ID",
        message: `spec_req_added: REQ ${payload.req.id} already in projection`,
        detail: { id: payload.req.id },
      };
    }
  }
  if (entry.kind === "event:spec_scenario_added") {
    const payload = payloadData as { scenario: { id: string } };
    if (findCollision(payload.scenario.id, ctx.snapshot.scenarios, (s) => s.id)) {
      return {
        ok: false,
        code: "DUPLICATE_SCEN_ID",
        message: `spec_scenario_added: SCEN ${payload.scenario.id} already in projection`,
        detail: { id: payload.scenario.id },
      };
    }
  }
  if (entry.kind === "event:spec_visual_added") {
    const payload = payloadData as { visual: { id: string } };
    if (findCollision(payload.visual.id, ctx.snapshot.visual_contracts, (v) => v.id)) {
      return {
        ok: false,
        code: "DUPLICATE_VIS_ID",
        message: `spec_visual_added: VIS ${payload.visual.id} already in projection`,
        detail: { id: payload.visual.id },
      };
    }
  }
  return null;
}

// (5j) Slice E — SPEC_VERSION_NOT_MONOTONIC / SPEC_VERSION_BATCH_MISMATCH
// preflight promotion. Mirrors Slice 2 SC4 DUPLICATE_TASK_ID + Slice 4
// SC1 DUPLICATE_REQ_ID/SCEN/VIS pattern: reducer keeps its message-
// string checkSpecVersionHead/checkSpecVersion as defense-in-depth for
// raw apply paths; preflight surfaces the public code so CLI users
// see the actionable diagnostic instead of INVALID_PAYLOAD wrap.
//
// Ordering inside spec_submitted: batch_index gate (head must be 0)
// runs BEFORE the version check so a misplaced spec_submitted in the
// middle of a batch returns the structurally meaningful code.
export function checkSpecVersion(c: PreflightCheckCtx): PreflightFailure | null {
  const { entry, payloadData, ctx } = c;
  if (SPEC_VERSION_KINDS.has(entry.kind)) {
    const payload = payloadData as { spec_version: number };
    const payloadVersion = payload.spec_version;
    const currentVersion = ctx.snapshot.state?.spec_version ?? 0;

    if (entry.kind === "event:spec_submitted") {
      // spec_submitted is the whole-replacement entrypoint and ALWAYS
      // the batch head (batch_index undefined or 0). batch_index > 0
      // is structurally illegal.
      if (entry.batch_index !== undefined && entry.batch_index !== 0) {
        return {
          ok: false,
          code: "SPEC_VERSION_BATCH_MISMATCH",
          message: `spec_submitted must appear at batch_index=0 (got ${entry.batch_index}); it is the whole-replacement entrypoint`,
          detail: {
            kind: entry.kind,
            batch_index: entry.batch_index,
            expected_batch_index: 0,
          },
        };
      }
      const v = specVersionRule(payloadVersion, currentVersion, "head");
      if (!v.ok) {
        return {
          ok: false,
          code: "SPEC_VERSION_NOT_MONOTONIC",
          message: `spec_submitted: spec_version must be ${v.expected} (current+1), got ${payloadVersion}`,
          detail: {
            kind: entry.kind,
            payload_spec_version: payloadVersion,
            current_spec_version: currentVersion,
            expected_spec_version: v.expected,
          },
        };
      }
    } else {
      // spec_*_added: HEAD path bumps (must equal current+1);
      // CONTINUATION path tracks (must equal current — the head
      // already bumped state in mutateBatch's accumulator).
      const mode = resolveSpecVersionMode(entry.batch_index);
      const v = specVersionRule(payloadVersion, currentVersion, mode);
      if (!v.ok) {
        if (mode === "head") {
          return {
            ok: false,
            code: "SPEC_VERSION_NOT_MONOTONIC",
            message: `${entry.kind}: spec_version must be ${v.expected} (current+1) at batch head, got ${payloadVersion}`,
            detail: {
              kind: entry.kind,
              payload_spec_version: payloadVersion,
              current_spec_version: currentVersion,
              expected_spec_version: v.expected,
              batch_position: "head",
            },
          };
        }
        return {
          ok: false,
          code: "SPEC_VERSION_BATCH_MISMATCH",
          message: `${entry.kind}: spec_version must be ${v.expected} at batch_index=${entry.batch_index} (batch continuation), got ${payloadVersion}`,
          detail: {
            kind: entry.kind,
            payload_spec_version: payloadVersion,
            current_spec_version: currentVersion,
            batch_index: entry.batch_index,
            batch_position: "continuation",
          },
        };
      }
    }
  }
  return null;
}

// (5f) Transition (for kinds carrying a state-machine edge).
