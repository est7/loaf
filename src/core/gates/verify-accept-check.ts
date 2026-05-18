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
//   - check 4: every task.status=done has ≥1 evidence with covers contains
//              task.id AND ev.kind in T-allowed set. PRECONDITION:
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
    | "SPEC_REVIEW_MISSING"
    | "SPEC_REVIEW_IMPLEMENTER_CONFLICT"
    | "SPEC_REVIEW_IMPLEMENTER_UNKNOWN";
  message: string;
  detail?: Record<string, unknown>;
};

export type VerifyAcceptResult =
  | { ok: true }
  | { ok: false; checks: FailedCheck[] };

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

const PASSING_RESULTS = new Set(["passed", "approved", "waived"]);

/** Lanes that pass an evidence result-check filter. */
function isPassingResult(result?: EvidenceState["result"]): boolean {
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

export function verifyAcceptCheck(
  snapshot: Snapshot,
  frontmatter: SpecFrontmatter,
): VerifyAcceptResult {
  const failures: FailedCheck[] = [];

  // ── check 1: per-lane status ─────────────────────────────────────────
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

  // ── check 2: no open findings ────────────────────────────────────────
  const open = snapshot.findings.filter((f) => f.status === "open");
  if (open.length > 0) {
    failures.push({
      check: 2,
      code: "OPEN_FINDINGS_PRESENT",
      message: `${open.length} finding(s) still open; resolve or close before verify-accept`,
      // codex r45 fix: count was previously only in the human message,
      // not in structured detail. ERROR_CATALOG OPEN_FINDINGS_PRESENT
      // template uses {count} placeholder, which now resolves correctly.
      detail: { count: open.length, open_ids: open.map((f) => f.id) },
    });
  }

  // ── check 3: REQ/SCEN/VIS canSatisfy coverage ───────────────────────
  // Per protocol §1035: evidence MUST also have result ∈ {passed, approved,
  // waived}. canSatisfy is compatibility-only (kind/actor/attachments
  // shape); the result-filter is part of the gate aggregation layer (codex
  // r37 scope split + r38 BLOCK 1 fix). isPassingResult predicate is
  // shared with check 1 + check 5 for consistency.
  const satisfiesCoverage = (ev: EvidenceState, id: string): boolean =>
    isPassingResult(ev.result) && ev.covers.includes(id) && canSatisfy(ev, id);

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

  // ── check 4: done-task evidence + stale tasks_based_on precondition ─
  let check4PreconditionFailed = false;
  if (snapshot.tasks_based_on === null) {
    failures.push({
      check: 4,
      code: "TASKS_NOT_PLANNED",
      message: `tasks have not been planned yet; verify-accept check 4 requires a task graph (tasks_based_on=null in snapshot)`,
    });
    check4PreconditionFailed = true;
  } else if (snapshot.tasks_based_on.spec !== frontmatter.spec_version) {
    failures.push({
      check: 4,
      code: "TASKS_BASED_ON_STALE",
      message: `tasks_based_on.spec=${snapshot.tasks_based_on.spec} does not match frontmatter.spec_version=${frontmatter.spec_version}; verify-accept check 4 cannot evaluate a stale task graph`,
      detail: {
        tasks_based_on_spec: snapshot.tasks_based_on.spec,
        current_spec_version: frontmatter.spec_version,
      },
    });
    check4PreconditionFailed = true;
  }

  if (!check4PreconditionFailed) {
    for (const task of snapshot.tasks) {
      if (task.status !== "done") continue;
      const satisfied = snapshot.evidence.some(
        (ev) =>
          ev.covers.includes(task.id) &&
          TASK_ALLOWED_EVIDENCE_KINDS.includes(ev.kind),
      );
      if (!satisfied) {
        failures.push({
          check: 4,
          code: "TASK_DONE_NO_EVIDENCE",
          message: `task ${task.id} is status=done but has no evidence (kind ∈ {task-summary, local-check, manual, waiver}) covering it`,
          detail: { task_id: task.id },
        });
      }
    }
  }

  // ── check 5: deep spec-review (ceremony.strict_spec_review only) ─────
  if (snapshot.state?.ceremony.strict_spec_review === true) {
    // codex r38 BLOCK 2 + r40 BLOCK refine: spec-review sign-off requires
    // explicit positive result (`passed` or `approved`) — NOT `waived`.
    //
    // Rationale (codex r40): EvidenceFullPayload's actor=human:* + reason ≥10
    // refine is keyed on `kind ∈ {manual, waiver}`, NOT `result === waived`.
    // So a `kind=spec-review, result=waived, actor=skill:reviewer, no reason`
    // payload is schema-valid but would be a non-human "waived" sign-off
    // with no rationale — clearly not the intent of strict_spec_review.
    // Conservative choice: spec-review must be a real positive sign-off,
    // not a waiver. Lane status (check 1) keeps waived because lane-level
    // waiver is a coarser approval signal; spec-review is the stricter
    // independent-reviewer requirement.
    const isPassingSpecReview = (r?: EvidenceState["result"]): boolean =>
      r === "passed" || r === "approved";
    const specReviews = snapshot.evidence.filter(
      (ev) => ev.kind === "spec-review" && isPassingSpecReview(ev.result),
    );
    if (specReviews.length === 0) {
      failures.push({
        check: 5,
        code: "SPEC_REVIEW_MISSING",
        message: `ceremony.strict_spec_review=true requires ≥1 evidence kind=spec-review from an actor ≠ implementer; none found`,
      });
    } else {
      const implementers = deriveImplementers(snapshot);
      if (implementers.size === 0) {
        failures.push({
          check: 5,
          code: "SPEC_REVIEW_IMPLEMENTER_UNKNOWN",
          message: `ceremony.strict_spec_review=true requires actor ≠ implementer comparison, but no implementer actor can be established (done-task evidence actors all cli:*); fail-closed`,
        });
      } else {
        const conflicts = specReviews.filter((ev) => implementers.has(ev.actor));
        if (conflicts.length > 0 && conflicts.length === specReviews.length) {
          // Every spec-review came from an implementer — no independent
          // reviewer signed off.
          failures.push({
            check: 5,
            code: "SPEC_REVIEW_IMPLEMENTER_CONFLICT",
            message: `every spec-review evidence has actor ∈ implementer set; require ≥1 spec-review from an actor that did not implement done tasks`,
            detail: {
              spec_review_actors: specReviews.map((ev) => ev.actor),
              implementers: [...implementers],
            },
          });
        }
      }
    }
  }

  if (failures.length === 0) return { ok: true };
  return { ok: false, checks: failures };
}
