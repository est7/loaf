// spec-lock gate evaluator (protocol §5.1, all 8 checks).
//
// Slice 1.B sub-cycles 2 + 3b land the full 8-check surface:
//   - check 2: needs_clarification === []
//   - check 3: snapshot.tasks_based_on.spec === frontmatter.spec_version
//             (TASKS_NOT_PLANNED when tasks_based_on is null;
//              TASKS_BASED_ON_STALE on version mismatch)
//   - check 4: every REQ-* referenced by ≥1 task.drives[]
//   - check 5: every REQ satisfies the three-way verifiability rule
//   - check 6: every e2e scenario is bound by a task with
//             requires_acceptance=true AND drives.includes(scenario.id),
//             OR scenario carries acceptance_na+reason
//   - check 7: every visual_contract is bound by a visual-ui task with
//             visual_contract_refs.includes(visual.id),
//             OR visual_contract carries visual_na+reason
//   - check 8: projected kind-specific obligations on each task
//             (behavioral+bug → red_test_registered=true;
//              structural/docs/spike/chore → no_test_rationale;
//              visual-ui → visual_contract_refs[])
//
// Check 1 (frontmatter passes SpecFrontmatter schema) is the CALLER's
// responsibility — when a parsed SpecFrontmatter reaches this function,
// the caller has already established check 1 passed.
//
// Cascade rule (codex r26 constraint #1): when check 3 fails (missing or
// stale task graph), checks 4/6/7 are SUPPRESSED to avoid false-positive
// coverage noise against an absent/stale graph. Checks 2/5 still run
// (frontmatter-only) and check 8 still runs when tasks exist (orthogonal
// projection invariant + migration hygiene).
//
// Pure, zero-IO. Tests inject parsed SpecFrontmatter + Snapshot fixtures.

import type { Snapshot, TaskState } from "../reducer.js";
import { hasVerifiability } from "../spec-schema.js";
import type { SpecFrontmatter } from "../spec-schema.js";

export type FailedCheck = {
  check: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  code:
    | "SPEC_FRONTMATTER_INVALID"
    | "SPEC_HAS_UNCLARIFIED"
    | "TASKS_NOT_PLANNED"
    | "TASKS_BASED_ON_STALE"
    | "REQ_NOT_DRIVEN"
    | "MISSING_VERIFIABILITY"
    | "E2E_SCENARIO_UNBOUND"
    | "VISUAL_CONTRACT_UNBOUND"
    | "TASK_KIND_SCHEMA_VIOLATION";
  message: string;
  detail?: Record<string, unknown>;
};

export type SpecLockResult =
  | { ok: true }
  | { ok: false; checks: FailedCheck[] };

const KINDS_REQUIRING_RATIONALE: ReadonlyArray<TaskState["kind"]> = [
  "structural",
  "docs",
  "spike",
  "chore",
];

export function specLockCheck(
  snapshot: Snapshot,
  frontmatter: SpecFrontmatter,
): SpecLockResult {
  const failures: FailedCheck[] = [];

  // Failure ordering follows protocol §5.1: 2 → 3 → 4 → 5 → 6 → 7 → 8.
  // Check 1 is the caller's responsibility (see module header).

  // ── check 2: needs_clarification === [] ────────────────────────────
  if (frontmatter.needs_clarification.length > 0) {
    failures.push({
      check: 2,
      code: "SPEC_HAS_UNCLARIFIED",
      message: `spec has ${frontmatter.needs_clarification.length} unresolved needs_clarification entries; resolve or remove them before spec-lock`,
      detail: {
        ids: frontmatter.needs_clarification.map((nc) => nc.id),
      },
    });
  }

  // ── check 3: tasks_based_on.spec === frontmatter.spec_version ──────
  let check3Failed = false;
  if (snapshot.tasks_based_on === null) {
    failures.push({
      check: 3,
      code: "TASKS_NOT_PLANNED",
      message: `tasks have not been planned yet; spec-lock requires a task graph (tasks_based_on=null in snapshot)`,
    });
    check3Failed = true;
  } else if (snapshot.tasks_based_on.spec !== frontmatter.spec_version) {
    failures.push({
      check: 3,
      code: "TASKS_BASED_ON_STALE",
      message: `tasks_based_on.spec=${snapshot.tasks_based_on.spec} does not match frontmatter.spec_version=${frontmatter.spec_version}; the task graph was planned against an older spec`,
      detail: {
        tasks_based_on_spec: snapshot.tasks_based_on.spec,
        current_spec_version: frontmatter.spec_version,
      },
    });
    check3Failed = true;
  }

  // ── check 4: REQ_NOT_DRIVEN — suppressed when check 3 fails ────────
  if (!check3Failed) {
    for (const req of frontmatter.requirements) {
      const driven = snapshot.tasks.some((t) => t.drives.includes(req.id));
      if (!driven) {
        failures.push({
          check: 4,
          code: "REQ_NOT_DRIVEN",
          message: `${req.id} is not referenced by any task.drives[]; add a task that drives this requirement before spec-lock`,
          detail: { req_id: req.id },
        });
      }
    }
  }

  // ── check 5: REQ three-way verifiability ───────────────────────────
  for (const req of frontmatter.requirements) {
    if (!hasVerifiability(req)) {
      failures.push({
        check: 5,
        code: "MISSING_VERIFIABILITY",
        message: `${req.id} must declare measurable, verified_by_scenarios[], or acceptance_na+acceptance_na_reason (≥10 chars)`,
        detail: { req_id: req.id, req_type: req.type },
      });
    }
  }

  // ── check 6: e2e scenario binding — suppressed when check 3 fails ──
  // Binding = same task with requires_acceptance=true AND
  // drives.includes(scenario.id), OR scenario carries acceptance_na.
  if (!check3Failed) {
    for (const scenario of frontmatter.scenarios) {
      if (scenario.tag !== "e2e") continue;
      if (scenario.acceptance_na !== undefined) continue;
      const bound = snapshot.tasks.some(
        (t) =>
          t.requires_acceptance === true && t.drives.includes(scenario.id),
      );
      if (!bound) {
        failures.push({
          check: 6,
          code: "E2E_SCENARIO_UNBOUND",
          message: `e2e scenario ${scenario.id} has no binding task (requires_acceptance=true AND drives includes ${scenario.id}); either add a binding task or mark scenario with acceptance_na+reason`,
          detail: { scenario_id: scenario.id },
        });
      }
    }
  }

  // ── check 7: visual_contract binding — suppressed when check 3 fails
  // Binding = visual-ui task with visual_contract_refs.includes(visual.id),
  // OR visual_contract carries visual_na.
  if (!check3Failed) {
    for (const visual of frontmatter.visual_contracts ?? []) {
      if (visual.visual_na !== undefined) continue;
      const bound = snapshot.tasks.some(
        (t) =>
          t.kind === "visual-ui" &&
          (t.visual_contract_refs ?? []).includes(visual.id),
      );
      if (!bound) {
        failures.push({
          check: 7,
          code: "VISUAL_CONTRACT_UNBOUND",
          message: `visual_contract ${visual.id} has no visual-ui task with visual_contract_refs containing it; add a binding visual-ui task or mark contract with visual_na+reason`,
          detail: { visual_id: visual.id },
        });
      }
    }
  }

  // ── check 8: projected kind-specific obligations (defense-in-depth)
  // Runs whenever tasks exist regardless of check 3 status; catches
  // migration:snapshot_imported corruption (no zod refine at import time)
  // and any other projection drift from journal append invariants.
  // This is a PROJECTION-LEVEL kind obligation check, not a literal full
  // TaskFull schema validation (codex r26 phrasing) — full schema runs
  // at journal append for non-migrated entries.
  if (snapshot.tasks.length > 0) {
    for (const task of snapshot.tasks) {
      const reasons: string[] = [];
      if (task.kind === "behavioral") {
        if (task.labels.includes("bug") && task.red_test_registered !== true) {
          reasons.push("behavioral task with labels=['bug'] requires red_test_registered=true");
        }
      } else if (task.kind === "visual-ui") {
        if (!task.visual_contract_refs || task.visual_contract_refs.length === 0) {
          reasons.push("visual-ui task requires visual_contract_refs[] with ≥1 entry");
        }
      } else if (KINDS_REQUIRING_RATIONALE.includes(task.kind)) {
        if (!task.no_test_rationale || task.no_test_rationale.length < 10) {
          reasons.push(`kind=${task.kind} requires no_test_rationale string ≥10 chars`);
        }
      }
      if (reasons.length > 0) {
        failures.push({
          check: 8,
          code: "TASK_KIND_SCHEMA_VIOLATION",
          message: `task ${task.id} (kind=${task.kind}) violates projected kind-specific obligations: ${reasons.join("; ")}`,
          detail: { task_id: task.id, kind: task.kind, reasons },
        });
      }
    }
  }

  if (failures.length === 0) return { ok: true };
  return { ok: false, checks: failures };
}
