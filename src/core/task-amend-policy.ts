import type { TaskState } from "./projection-types.js";
import type { TaskFullProjection } from "./task-schema.js";

export interface FrozenViolation {
  field: string;
  from: unknown;
  to: unknown;
}

function arraysEqual(
  a: readonly unknown[] | undefined,
  b: readonly unknown[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function firstFrozenViolation(
  current: TaskState,
  incoming: TaskState,
): FrozenViolation | null {
  // status: unchanged, or the single legal advance pending → ready.
  if (incoming.status !== current.status) {
    const legalAdvance = current.status === "pending" && incoming.status === "ready";
    if (!legalAdvance) {
      return { field: "status", from: current.status, to: incoming.status };
    }
  }
  if (incoming.kind !== current.kind) {
    return { field: "kind", from: current.kind, to: incoming.kind };
  }
  // Array graph fields — exact deep equality (codex r108: no set-normalize).
  if (!arraysEqual(current.drives, incoming.drives)) {
    return { field: "drives", from: current.drives, to: incoming.drives };
  }
  if (!arraysEqual(current.depends_on, incoming.depends_on)) {
    return { field: "depends_on", from: current.depends_on, to: incoming.depends_on };
  }
  if (!arraysEqual(current.labels, incoming.labels)) {
    return { field: "labels", from: current.labels, to: incoming.labels };
  }
  if (!arraysEqual(current.visual_contract_refs, incoming.visual_contract_refs)) {
    return {
      field: "visual_contract_refs",
      from: current.visual_contract_refs,
      to: incoming.visual_contract_refs,
    };
  }
  // Scalar kind-flag fields (undefined-safe via ===).
  for (const f of [
    "red_test_registered",
    "no_test_rationale",
    "requires_acceptance",
    "requires_visual",
  ] as const) {
    if (current[f] !== incoming[f]) {
      return { field: f, from: current[f], to: incoming[f] };
    }
  }
  // Execution step set frozen; per-step status frozen; applicability free.
  const curSteps = Object.keys(current.steps).sort();
  const incSteps = Object.keys(incoming.steps).sort();
  if (!arraysEqual(curSteps, incSteps)) {
    return { field: "execution.steps", from: curSteps, to: incSteps };
  }
  for (const stepName of curSteps) {
    const c = current.steps[stepName];
    const i = incoming.steps[stepName];
    if (c && i && c.status !== i.status) {
      return {
        field: `execution.${stepName}.status`,
        from: c.status,
        to: i.status,
      };
    }
  }
  return null;
}

// Phase 11 Item 3 SC1b — frozen-field check for a SPONSORED `mode=replace`
// `event:tasks_amended` at EXECUTE.work (codex r136 Q4, HARD GATE). Both
// arguments are slim TaskState projections. Sponsorship widens the EXECUTE.plan
// rule: graph / definition fields (kind / drives / depends_on / labels /
// visual_contract_refs / scalar kind-flags) and the execution step SET become
// mutable — the worker is restructuring the task graph in response to a
// finding. What stays FROZEN is identity + execution PROGRESS:
//   - task `status` — replacing a graph definition must not rewind or fast-
//     forward where the task is in its lifecycle.
//   - per-RETAINED-step `status` — a step kept across the replace keeps its
//     current status; the new graph definition cannot erase its progress.
//   - new steps must be born `pending` (unstarted) — a replace cannot fabricate
//     completed work.
//   - a step whose current status is non-`pending` (progress-bearing) must NOT
//     be removed — dropping it from the graph erases execution history.
// codex's red-line: no sponsored path may erase / rewrite execution progress
// under the name of a graph amend. (`id` is verified by the caller's
// TASK_NOT_FOUND lookup, not here.) Body-only progress fields — `started_at`
// / step `reason` — are NOT in the slim projection; stable-core
// preflight does not independently re-verify them (see the §8.6 enforcement
// note at the sponsored branch below).
export function firstSponsoredFrozenViolation(
  current: TaskState,
  incoming: TaskState,
): FrozenViolation | null {
  // Task-level status is frozen — unconditionally (no pending→ready latitude:
  // a sponsored replace at EXECUTE.work is not the planning surface).
  if (incoming.status !== current.status) {
    return { field: "status", from: current.status, to: incoming.status };
  }
  // Step-set MAY change. For each RETAINED step (present in both), status is
  // frozen. For each step REMOVED by the replace, reject if it carries
  // progress (status !== "pending"). For each NEW step, reject if it is born
  // with a non-`pending` status.
  for (const [stepName, cur] of Object.entries(current.steps)) {
    const inc = incoming.steps[stepName];
    if (inc === undefined) {
      // Removed step — only legal when it has no execution progress.
      if (cur.status !== "pending") {
        return {
          field: `execution.${stepName}.status`,
          from: cur.status,
          to: undefined,
        };
      }
      continue;
    }
    if (cur.status !== inc.status) {
      return {
        field: `execution.${stepName}.status`,
        from: cur.status,
        to: inc.status,
      };
    }
  }
  for (const [stepName, inc] of Object.entries(incoming.steps)) {
    if (current.steps[stepName] === undefined && inc.status !== "pending") {
      return {
        field: `execution.${stepName}.status`,
        from: undefined,
        to: inc.status,
      };
    }
  }
  return null;
}

// Phase 11 Item 3 SC1b — freshness check for a SPONSORED `mode=add`
// event:tasks_amended (codex r137 BLOCK 1). A sponsored add introduces a
// task MISSING from the graph; it must be born fresh / unstarted. The
// reducer dry-run rejects a duplicate id, but nothing else stops a raw
// journal caller from supplying a full TaskFullPayload that smuggles
// completed work — task.status=`done`, a step `passed`, or a runtime
// `red_test_registered` flag. codex r136 Q4: a sponsored amend
// may not fabricate execution progress. The CLI `tasks add --finding` path
// builds the task via `materializeTaskInput` (always fresh), so this guards
// the stable-core journal path against raw callers. Operates on the full
// incoming payload (not the slim projection) — `started_at` / `reason` ride
// the payload even though the projection
// drops them.
export function firstAddFreshnessViolation(
  task: TaskFullProjection,
): { field: string; value: unknown } | null {
  if (task.status !== "pending") {
    return { field: "status", value: task.status };
  }
  if (task.red_test_registered === true) {
    return { field: "red_test_registered", value: true };
  }
  for (const [stepName, step] of Object.entries(task.execution)) {
    if (step.status !== "pending") {
      return { field: `execution.${stepName}.status`, value: step.status };
    }
    if (step.started_at !== undefined) {
      return { field: `execution.${stepName}.started_at`, value: step.started_at };
    }
    if (step.reason !== undefined) {
      return { field: `execution.${stepName}.reason`, value: step.reason };
    }
  }
  return null;
}
