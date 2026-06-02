// verify-accept gate evaluator (protocol §5.2, all 5 checks).
//
// Slice 1.C sub-cycle 3 (codex r33 lock):
//
//   - check 1: per-applicable-lane status via `deriveVerifyApplicability`
//              + EvidenceEntry.check primary linkage + narrow kind fallback.
//              Lane is "passed" if any covering evidence with check=<lane>
//              has result ∈ {passed, approved, waived}, OR (fallback) any
//              evidence with kind in the narrow per-lane map has the same
//              result. Otherwise "missing".
//
//   - check 2: snapshot.findings has no entry with status=open.
//
//   - check 3: every non-na REQ / SCEN / VIS has ≥1 evidence whose covers[]
//              contains the id AND canSatisfy(ev, id) is true. Delegates
//              to evidence-compat.ts (sub-cycle 2).
//
//   - check 4: every task.status=done has ≥1 evidence with a passing result,
//              covers contains task.id, AND ev.kind in T-allowed set. PRECONDITION:
//              snapshot.tasks_based_on must equal frontmatter.spec_version
//              (TASKS_NOT_PLANNED if null, TASKS_BASED_ON_STALE if mismatch
//              — same code as spec-lock-check; codex r33 Q1(d) lock).
//              If precondition fails, per-task scan is skipped (only the
//              precondition diagnostic surfaces); other checks still run.
//
//   - check 5: ONLY when ceremony.strict_spec_review === true (codex r33
//              Q4 lock — NOT settle_phase). Require at least one
//              evidence.kind=spec-review whose actor is NOT in the
//              implementer set. Implementer = actors on done-task
//              task-summary / local-check evidence, EXCLUDING cli:* prefix
//              actors. Empty implementer set → SPEC_REVIEW_IMPLEMENTER_UNKNOWN
//              (fail-closed, codex r33 Q4 lock).
//
// No cascade (codex r33 Q3 lock): all 5 checks run independently; stale
// tasks_based_on only affects check 4's per-task scan, not the other
// checks' execution.
//
// Pure, zero-IO. Tests inject parsed SpecFrontmatter + Snapshot fixtures.
// IO boundary (read spec.md frontmatter) lands in sub-cycle 4
// (verify-accept-eval.ts).

import type { EvidenceState, Snapshot } from "../reducer.js";
import type { SpecFrontmatter } from "../spec-schema.js";
import type { VerifyCheckKind } from "../evidence-schema.js";
import { canSatisfy } from "../evidence-compat.js";

export type FailedCheck = {
  check: 1 | 2 | 3 | 4 | 5;
  code:
    // Slice 1.C sub-cycle 4: caller's responsibility (spec.md read failures
    // map to check 1 via verify-accept-eval.ts), parallel to spec-lock-check
    // structure. Pure verifyAcceptCheck() never returns this code itself.
    | "SPEC_FRONTMATTER_INVALID"
    | "VERIFY_LANE_NOT_PASSED"
    | "OPEN_FINDINGS_PRESENT"
    | "COVERAGE_NOT_SATISFIED"
    | "TASKS_NOT_PLANNED"
    | "TASKS_BASED_ON_STALE"
    | "TASK_DONE_NO_EVIDENCE"
    // Slice C SC-C4 (R2) — defense-in-depth: a done behavioral bug task
    // that never registered its RED test. Preflight's BUG_TASK_REQUIRES_RED
    // protects new legal writes; this catches migration / raw-API / pre-
    // guard historical journals at the verify-accept gate.
    | "BUG_TASK_RED_NOT_REGISTERED"
    | "SPEC_REVIEW_MISSING"
    | "SPEC_REVIEW_IMPLEMENTER_CONFLICT"
    | "SPEC_REVIEW_IMPLEMENTER_UNKNOWN";
  message: string;
  detail?: Record<string, unknown>;
};

export type VerifyAcceptResult =
  | { ok: true }
  | { ok: false; checks: FailedCheck[] };

// SC-9a-1: named per-check axis exposed by `loaf verify status`. Kept
// separate from VerifyCheckKind (the lane enum) because checks 2/3/4/5 are
// not lanes. Numeric 1..5 stays on FailedCheck.check for byte-equivalence
// with verifyAcceptCheck output; the named id rides PerCheckResult.check.
export type VerifyCheckId =
  | "lane_status"   // check 1
  | "open_findings" // check 2
  | "coverage"      // check 3
  | "task_evidence" // check 4 (multi-code: TASKS_NOT_PLANNED / TASKS_BASED_ON_STALE / TASK_DONE_NO_EVIDENCE / BUG_TASK_RED_NOT_REGISTERED)
  | "spec_review";  // check 5 (multi-code: SPEC_REVIEW_MISSING / SPEC_REVIEW_IMPLEMENTER_CONFLICT / SPEC_REVIEW_IMPLEMENTER_UNKNOWN)

export const VERIFY_CHECK_IDS = [
  "lane_status",
  "open_findings",
  "coverage",
  "task_evidence",
  "spec_review",
] as const satisfies ReadonlyArray<VerifyCheckId>;

export type PerCheckResult = {
  check: VerifyCheckId;
  status: "pass" | "fail" | "na";
  failures: FailedCheck[]; // empty iff status ∈ {pass, na}
};

// Narrow kind → lane fallback per codex r33 Q1(b). Used only when an
// evidence entry omits the `check` field (legacy or new without explicit
// lane tag). Strict mapping — task-summary maps to RUN here even though
// task-summary also satisfies REQ/T coverage (check 3); these are
// orthogonal questions per codex r33 Q1(c).
const KIND_TO_LANE_FALLBACK: Partial<Record<EvidenceState["kind"], VerifyCheckKind>> = {
  "local-check": "run",
  "task-summary": "run",
  "verify-review": "review",
  "spec-review": "review",
  acceptance: "acceptance",
  "visual-review": "visual",
};

export const PASSING_RESULTS = new Set(["passed", "approved", "waived"]);

/** Lanes that pass an evidence result-check filter. */
export function isPassingResult(result?: EvidenceState["result"]): boolean {
  return result !== undefined && PASSING_RESULTS.has(result);
}

/**
 * Derive the set of "must" lanes from the snapshot + frontmatter.
 *
 * Policy (codex r33 Q1(a)) — protocol does NOT cite a literal lane
 * derivation table, so this is explicit policy made by reading §5.2 +
 * §7 + §1196-1199:
 *   - any non-acceptance_na SCEN.tag=e2e ⇒ ACCEPTANCE lane is must
 *   - any non-visual_na VIS ⇒ VISUAL lane is must
 *   - any done task ⇒ RUN + REVIEW lanes are must (default lanes for
 *     any implementation)
 *   - any non-acceptance_na REQ ⇒ REVIEW lane is must (reviewer signs off
 *     on REQ-level spec_fit + quality_fit)
 *
 * Future protocol clarification may move some of these into spec.frontmatter
 * directly (e.g. per-feature opt-out of REVIEW lane); for now the policy
 * is conservative.
 */
export function deriveVerifyApplicability(
  snapshot: Snapshot,
  frontmatter: SpecFrontmatter,
): Set<VerifyCheckKind> {
  const lanes = new Set<VerifyCheckKind>();
  // REQ ⇒ REVIEW
  for (const req of frontmatter.requirements) {
    if (req.acceptance_na === true) continue;
    lanes.add("review");
  }
  // SCEN.tag=e2e (non acceptance_na) ⇒ ACCEPTANCE
  for (const scen of frontmatter.scenarios) {
    if (scen.tag !== "e2e") continue;
    if (scen.acceptance_na !== undefined) continue;
    lanes.add("acceptance");
  }
  // VIS (non visual_na) ⇒ VISUAL
  for (const vis of frontmatter.visual_contracts ?? []) {
    if (vis.visual_na !== undefined) continue;
    lanes.add("visual");
  }
  // done task ⇒ RUN + REVIEW
  for (const task of snapshot.tasks) {
    if (task.status === "done") {
      lanes.add("run");
      lanes.add("review");
    }
  }
  return lanes;
}

/**
 * Map an EvidenceState to its lane. Primary linkage = `evidence.check`
 * (per codex r33 Q1(b)); fallback = narrow kind → lane map. Returns
 * undefined if the evidence isn't relevant to any lane.
 */
function evidenceLane(ev: EvidenceState): VerifyCheckKind | undefined {
  if (ev.check !== undefined) return ev.check;
  return KIND_TO_LANE_FALLBACK[ev.kind];
}

/**
 * Lane status: returns true iff any evidence is on this lane with a
 * passing/waived/approved result.
 */
function laneIsPassed(lane: VerifyCheckKind, evidence: ReadonlyArray<EvidenceState>): boolean {
  for (const ev of evidence) {
    if (evidenceLane(ev) !== lane) continue;
    if (isPassingResult(ev.result)) return true;
  }
  return false;
}

/**
 * Implementer set for check 5: actors on done-task task-summary /
 * local-check evidence, EXCLUDING cli:* prefix (codex r33 Q4: cli:loaf
 * local-check is not implementer). Returns empty set if no human / non-cli
 * implementer can be established — caller must fail-closed.
 */
function deriveImplementers(snapshot: Snapshot): Set<string> {
  const doneTaskIds = new Set(
    snapshot.tasks.filter((t) => t.status === "done").map((t) => t.id),
  );
  const implementers = new Set<string>();
  for (const ev of snapshot.evidence) {
    if (ev.kind !== "task-summary" && ev.kind !== "local-check") continue;
    if (!ev.covers.some((c) => doneTaskIds.has(c))) continue;
    if (ev.actor.startsWith("cli:")) continue;
    implementers.add(ev.actor);
  }
  return implementers;
}

const TASK_ALLOWED_EVIDENCE_KINDS: ReadonlyArray<EvidenceState["kind"]> = [
  "task-summary",
  "local-check",
  "manual",
  "waiver",
];

// SC-9a-1: per-check failure walks, extracted from the original
// verifyAcceptCheck body. Each returns the FailedCheck rows the check
// would push when applicable (empty when applicable + no failure). NA
// gating happens at the evaluateAllChecks layer via
// `deriveCheckApplicability`; these walkers do NOT re-check applicability.

function evalLaneStatus(snapshot: Snapshot, frontmatter: SpecFrontmatter): FailedCheck[] {
  const failures: FailedCheck[] = [];
  const applicableLanes = deriveVerifyApplicability(snapshot, frontmatter);
  for (const lane of applicableLanes) {
    if (!laneIsPassed(lane, snapshot.evidence)) {
      failures.push({
        check: 1,
        code: "VERIFY_LANE_NOT_PASSED",
        message: `applicable VERIFY lane=${lane} has no evidence with passing/approved/waived result; add evidence with check=${lane} or a matching kind`,
        detail: { lane },
      });
    }
  }
  return failures;
}

function evalOpenFindings(snapshot: Snapshot): FailedCheck[] {
  const open = snapshot.findings.filter((f) => f.status === "open");
  if (open.length === 0) return [];
  return [{
    check: 2,
    code: "OPEN_FINDINGS_PRESENT",
    message: `${open.length} finding(s) still open; resolve or close before verify-accept`,
    detail: { count: open.length, open_ids: open.map((f) => f.id) },
  }];
}

function evalCoverage(snapshot: Snapshot, frontmatter: SpecFrontmatter): FailedCheck[] {
  const satisfiesCoverage = (ev: EvidenceState, id: string): boolean =>
    isPassingResult(ev.result) && ev.covers.includes(id) && canSatisfy(ev, id);
  const failures: FailedCheck[] = [];
  for (const req of frontmatter.requirements) {
    if (req.acceptance_na === true) continue;
    if (!snapshot.evidence.some((ev) => satisfiesCoverage(ev, req.id))) {
      failures.push({
        check: 3,
        code: "COVERAGE_NOT_SATISFIED",
        message: `${req.id} has no evidence passing canSatisfy() + result ∈ {passed, approved, waived} — add evidence with kind in REQ-allowed list (task-summary/verify-review/spec-review/manual/waiver) covering this id`,
        detail: { covered_id: req.id, covered_kind: "REQ" },
      });
    }
  }
  for (const scen of frontmatter.scenarios) {
    if (scen.acceptance_na !== undefined) continue;
    if (scen.tag !== "e2e") continue;
    if (!snapshot.evidence.some((ev) => satisfiesCoverage(ev, scen.id))) {
      failures.push({
        check: 3,
        code: "COVERAGE_NOT_SATISFIED",
        message: `${scen.id} has no evidence passing canSatisfy() + result ∈ {passed, approved, waived} — add evidence with kind=acceptance / manual+reason / waiver+reason covering this id`,
        detail: { covered_id: scen.id, covered_kind: "SCEN" },
      });
    }
  }
  for (const vis of frontmatter.visual_contracts ?? []) {
    if (vis.visual_na !== undefined) continue;
    if (!snapshot.evidence.some((ev) => satisfiesCoverage(ev, vis.id))) {
      failures.push({
        check: 3,
        code: "COVERAGE_NOT_SATISFIED",
        message: `${vis.id} has no evidence passing canSatisfy() + result ∈ {passed, approved, waived} — add evidence with kind=visual-review+attachment / manual+reason / waiver+reason covering this id`,
        detail: { covered_id: vis.id, covered_kind: "VIS" },
      });
    }
  }
  return failures;
}

function evalTaskEvidence(snapshot: Snapshot, frontmatter: SpecFrontmatter): FailedCheck[] {
  const failures: FailedCheck[] = [];
  if (snapshot.tasks_based_on === null) {
    failures.push({
      check: 4,
      code: "TASKS_NOT_PLANNED",
      message: `tasks have not been planned yet; verify-accept check 4 requires a task graph (tasks_based_on=null in snapshot)`,
    });
    return failures;
  }
  if (snapshot.tasks_based_on.spec !== frontmatter.spec_version) {
    failures.push({
      check: 4,
      code: "TASKS_BASED_ON_STALE",
      message: `tasks_based_on.spec=${snapshot.tasks_based_on.spec} does not match frontmatter.spec_version=${frontmatter.spec_version}; verify-accept check 4 cannot evaluate a stale task graph`,
      detail: {
        tasks_based_on_spec: snapshot.tasks_based_on.spec,
        current_spec_version: frontmatter.spec_version,
      },
    });
    return failures;
  }
  for (const task of snapshot.tasks) {
    if (task.status !== "done") continue;
    const satisfied = snapshot.evidence.some(
      (ev) =>
        isPassingResult(ev.result) &&
        ev.covers.includes(task.id) &&
        TASK_ALLOWED_EVIDENCE_KINDS.includes(ev.kind),
    );
    if (!satisfied) {
      failures.push({
        check: 4,
        code: "TASK_DONE_NO_EVIDENCE",
        message: `task ${task.id} is status=done but has no PASSING evidence (result ∈ {passed, approved, waived}; kind ∈ {task-summary, local-check, manual, waiver}) covering it`,
        detail: { task_id: task.id },
      });
    }
    // Slice C SC-C4 (R2) — defense-in-depth for bug-RED invariant.
    if (
      task.kind === "behavioral" &&
      task.labels.includes("bug") &&
      task.red_test_registered !== true
    ) {
      failures.push({
        check: 4,
        code: "BUG_TASK_RED_NOT_REGISTERED",
        message: `behavioral bug task ${task.id} is status=done but never registered its RED test (red_test_registered≠true)`,
        detail: { task_id: task.id },
      });
    }
  }
  return failures;
}

function evalSpecReview(snapshot: Snapshot): FailedCheck[] {
  // codex r38 BLOCK 2 + r40 BLOCK refine: spec-review sign-off requires
  // explicit positive result (`passed` or `approved`) — NOT `waived`.
  const isPassingSpecReview = (r?: EvidenceState["result"]): boolean =>
    r === "passed" || r === "approved";
  const specReviews = snapshot.evidence.filter(
    (ev) => ev.kind === "spec-review" && isPassingSpecReview(ev.result),
  );
  if (specReviews.length === 0) {
    return [{
      check: 5,
      code: "SPEC_REVIEW_MISSING",
      message: `ceremony.strict_spec_review=true requires ≥1 evidence kind=spec-review from an actor ≠ implementer; none found`,
    }];
  }
  const implementers = deriveImplementers(snapshot);
  if (implementers.size === 0) {
    return [{
      check: 5,
      code: "SPEC_REVIEW_IMPLEMENTER_UNKNOWN",
      message: `ceremony.strict_spec_review=true requires actor ≠ implementer comparison, but no implementer actor can be established (done-task evidence actors all cli:*); fail-closed`,
    }];
  }
  const conflicts = specReviews.filter((ev) => implementers.has(ev.actor));
  if (conflicts.length > 0 && conflicts.length === specReviews.length) {
    return [{
      check: 5,
      code: "SPEC_REVIEW_IMPLEMENTER_CONFLICT",
      message: `every spec-review evidence has actor ∈ implementer set; require ≥1 spec-review from an actor that did not implement done tasks`,
      detail: {
        spec_review_actors: specReviews.map((ev) => ev.actor),
        implementers: [...implementers],
      },
    }];
  }
  return [];
}

/**
 * SC-9a-1: deterministic NA applicability rules per VerifyCheckId.
 * Result feeds `evaluateAllChecks` to set PerCheckResult.status. Pure +
 * fixture-friendly; same inputs as the per-check walkers above.
 *
 * Rules (codex r303 lock):
 *   - lane_status:   na iff deriveVerifyApplicability returns ∅
 *   - open_findings: ALWAYS applicable (never na)
 *   - coverage:      na iff 0 non-NA REQ/SCEN/VIS obligations
 *   - task_evidence: precondition runs when graph is unplanned (so
 *                    `tasks_based_on === null` is still applicable, fires
 *                    TASKS_NOT_PLANNED). When graph present, na iff no
 *                    done task exists.
 *   - spec_review:   na iff ceremony.strict_spec_review !== true
 */
export function deriveCheckApplicability(
  snapshot: Snapshot,
  frontmatter: SpecFrontmatter,
): Record<VerifyCheckId, boolean> {
  const laneStatusApplicable = deriveVerifyApplicability(snapshot, frontmatter).size > 0;

  const coverageObligationCount =
    frontmatter.requirements.filter((r) => r.acceptance_na !== true).length +
    frontmatter.scenarios.filter((s) => s.acceptance_na === undefined && s.tag === "e2e").length +
    (frontmatter.visual_contracts ?? []).filter((v) => v.visual_na === undefined).length;
  const coverageApplicable = coverageObligationCount > 0;

  // task_evidence: graph unplanned ⇒ applicable (precondition fires).
  // graph planned ⇒ applicable iff ≥1 done task. Empty planned graph or
  // graph with no done tasks ⇒ na, no precondition / per-task walk.
  let taskEvidenceApplicable: boolean;
  if (snapshot.tasks_based_on === null) {
    taskEvidenceApplicable = true;
  } else {
    taskEvidenceApplicable = snapshot.tasks.some((t) => t.status === "done");
  }

  const specReviewApplicable = snapshot.state?.ceremony.strict_spec_review === true;

  return {
    lane_status: laneStatusApplicable,
    open_findings: true,
    coverage: coverageApplicable,
    task_evidence: taskEvidenceApplicable,
    spec_review: specReviewApplicable,
  };
}

/**
 * SC-9a-1: walk all 5 checks independently, return one PerCheckResult per
 * VerifyCheckId in the canonical VERIFY_CHECK_IDS order. NA rows have
 * empty `failures`. Behavior-preserving invariant:
 *
 *   verifyAcceptCheck(snap, fm).checks  // when ok=false
 *     deep-equal to
 *   evaluateAllChecks(snap, fm).flatMap(r => r.failures)
 *
 * — covers all 10 per-check codes. SPEC_FRONTMATTER_INVALID stays at the
 * IO boundary (see verify-accept-eval.ts).
 */
export function evaluateAllChecks(
  snapshot: Snapshot,
  frontmatter: SpecFrontmatter,
): PerCheckResult[] {
  const applicable = deriveCheckApplicability(snapshot, frontmatter);

  const walkers: Record<VerifyCheckId, () => FailedCheck[]> = {
    lane_status: () => evalLaneStatus(snapshot, frontmatter),
    open_findings: () => evalOpenFindings(snapshot),
    coverage: () => evalCoverage(snapshot, frontmatter),
    task_evidence: () => evalTaskEvidence(snapshot, frontmatter),
    spec_review: () => evalSpecReview(snapshot),
  };

  return VERIFY_CHECK_IDS.map((id) => {
    if (!applicable[id]) {
      return { check: id, status: "na" as const, failures: [] };
    }
    const failures = walkers[id]();
    return {
      check: id,
      status: failures.length > 0 ? ("fail" as const) : ("pass" as const),
      failures,
    };
  });
}

export function verifyAcceptCheck(
  snapshot: Snapshot,
  frontmatter: SpecFrontmatter,
): VerifyAcceptResult {
  const failures = evaluateAllChecks(snapshot, frontmatter).flatMap((r) => r.failures);
  if (failures.length === 0) return { ok: true };
  return { ok: false, checks: failures };
}
