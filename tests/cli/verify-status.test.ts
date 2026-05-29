// Phase 16 SC-9a-1 — `loaf verify status` pure tests
//
// Covers evaluateAllChecks + deriveCheckApplicability (codex r303/r304 lock).
// 20 cases total:
//   - 1  all-pass
//   - 3  lane fail / multi-fail / na
//   - 2  open-findings fail / always-applicable invariant
//   - 2  coverage multi-fail / na
//   - 4  task_evidence: TASKS_NOT_PLANNED / TASKS_BASED_ON_STALE /
//        multi-fail-with-bug-RED / empty-planned-graph na
//   - 4  spec_review: missing / implementer-conflict / implementer-unknown /
//        strict=false na
//   - 1  task_evidence-na when graph present but 0 done
//   - 1  mixed multi-check failure
//   - 1  byte-equal invariant (verifyAcceptCheck === flatMap failures)
//   - 1  §7.4 envelope golden (shape parity)

import { describe, expect, test } from "vitest";

import {
  VERIFY_CHECK_IDS,
  deriveCheckApplicability,
  evaluateAllChecks,
  verifyAcceptCheck,
} from "../../src/core/gates/verify-accept-check.js";
import {
  buildEnvelope,
} from "../../src/cli/verify-status.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import type {
  EvidenceState,
  Snapshot,
  TaskState,
} from "../../src/core/reducer.js";
import type { SpecFrontmatter } from "../../src/core/spec-schema.js";

const SHA = "a".repeat(64);

const REQ_VERIFIABLE: SpecFrontmatter["requirements"][number] = {
  id: "REQ-AUTH-001",
  type: "event-driven",
  trigger: "an API request returns 401",
  response: "the system shall refresh the access token before surfacing failure",
  verified_by_scenarios: ["SCEN-AUTH-E2E-001"],
};

const SCEN_E2E: SpecFrontmatter["scenarios"][number] = {
  id: "SCEN-AUTH-E2E-001",
  name: "user refresh happy path",
  tag: "e2e",
  given: ["valid refresh token in cookie"],
  when: ["request to /protected returns 401"],
  then: ["refresh runs and original request retries"],
};

const VIS_001: NonNullable<SpecFrontmatter["visual_contracts"]>[number] = {
  id: "VIS-AUTH-001",
  target: "OAuth login button hover state",
  checks: ["pixel snapshot of hover variant"],
};

function makeFrontmatter(overrides: Partial<SpecFrontmatter> = {}): SpecFrontmatter {
  return {
    schema_version: 2,
    spec_version: 1,
    feature: { id: "F-001", name: "OAuth token refresh" },
    intent: "users should not perceive auth recovery flows in flight",
    adr_refs: [],
    requirements: [REQ_VERIFIABLE],
    scenarios: [SCEN_E2E],
    visual_contracts: [VIS_001],
    needs_clarification: [],
    ...overrides,
  };
}

function step(applicability: "must" | "optional" | "na" = "must", status: TaskState["steps"][string]["status"] = "passed") {
  return { applicability, status };
}

function doneTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "T-001",
    kind: "behavioral",
    status: "done",
    steps: { red: step("must"), implement: step("must"), refactor: step("optional") },
    drives: ["REQ-AUTH-001", "SCEN-AUTH-E2E-001"],
    depends_on: [],
    labels: [],
    requires_acceptance: true,
    red_test_registered: true,
    ...overrides,
  };
}

function visualDoneTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "T-200",
    kind: "visual-ui",
    status: "done",
    steps: { mockup: step("must"), implement: step("must"), "screenshot-compare": step("must") },
    drives: [],
    depends_on: [],
    labels: [],
    visual_contract_refs: ["VIS-AUTH-001"],
    ...overrides,
  };
}

function evidence(overrides: Partial<EvidenceState> = {}): EvidenceState {
  return {
    id: "EV-000001",
    kind: "task-summary",
    covers: [],
    actor: "human:dev@example.com",
    result: "passed",
    ...overrides,
  };
}

function happySnapshot(frontmatter: SpecFrontmatter): Snapshot {
  const base = initialSnapshot();
  return {
    ...base,
    state: {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "F-001",
      phase: "VERIFY",
      sub_state: "VERIFY.accept",
      iteration: 1,
      spec_locked: true,
      verify_accepted: false,
      spec_version: frontmatter.spec_version,
      ceremony: {
        spec_phase: true,
        verify_phase: true,
        settle_phase: false,
        strict_spec_review: false,
        lessons_required: "skip",
        strict_drift_check: false,
      },
    },
    tasks_based_on: { spec: frontmatter.spec_version },
    tasks: [doneTask(), visualDoneTask()],
    evidence: [
      evidence({ id: "EV-000001", kind: "task-summary", covers: ["T-001"], check: "run" }),
      evidence({ id: "EV-000002", kind: "task-summary", covers: ["T-200"], check: "run" }),
      evidence({ id: "EV-000003", kind: "verify-review", covers: ["REQ-AUTH-001"], check: "review", result: "approved" }),
      evidence({ id: "EV-000004", kind: "acceptance", covers: ["SCEN-AUTH-E2E-001"], check: "acceptance" }),
      evidence({
        id: "EV-000005",
        kind: "visual-review",
        covers: ["VIS-AUTH-001"],
        check: "visual",
        result: "approved",
        attachments: [{ path: "shot.png", sha256: SHA, mime: "image/png" }],
      }),
    ],
  };
}

// ───────────────────────────────────────────────────────────────────────
// Case 1 — all-pass: 5 rows, rows with obligations are "pass", others "na"
// ───────────────────────────────────────────────────────────────────────
describe("evaluateAllChecks — all-pass", () => {
  test("happy snapshot returns 5 rows; obligations pass; strict-off spec_review is na", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    const rows = evaluateAllChecks(snap, fm);

    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.check)).toEqual([...VERIFY_CHECK_IDS]);

    const byCheck = Object.fromEntries(rows.map((r) => [r.check, r] as const));
    expect(byCheck.lane_status!.status).toBe("pass");
    expect(byCheck.open_findings!.status).toBe("pass");
    expect(byCheck.coverage!.status).toBe("pass");
    expect(byCheck.task_evidence!.status).toBe("pass");
    expect(byCheck.spec_review!.status).toBe("na"); // strict_spec_review=false

    for (const r of rows) expect(r.failures).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Case 2-4 — lane_status: single-fail / multi-fail / na
// ───────────────────────────────────────────────────────────────────────
describe("evaluateAllChecks — lane_status", () => {
  test("single-fail: acceptance lane missing → 1 failure with detail.lane=acceptance", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.filter((e) => e.check !== "acceptance");
    const rows = evaluateAllChecks(snap, fm);
    const lane = rows.find((r) => r.check === "lane_status")!;
    expect(lane.status).toBe("fail");
    expect(lane.failures).toHaveLength(1);
    expect(lane.failures[0]!.code).toBe("VERIFY_LANE_NOT_PASSED");
    expect(lane.failures[0]!.detail?.lane).toBe("acceptance");
  });

  test("multi-fail: run + visual lanes both missing → 2+ failures with distinct detail.lane", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.filter(
      (e) => e.check !== "run" && e.check !== "visual",
    );
    const rows = evaluateAllChecks(snap, fm);
    const lane = rows.find((r) => r.check === "lane_status")!;
    expect(lane.status).toBe("fail");
    expect(lane.failures.length).toBeGreaterThanOrEqual(2);
    const lanes = new Set(lane.failures.map((f) => f.detail?.lane));
    expect(lanes.has("run")).toBe(true);
    expect(lanes.has("visual")).toBe(true);
  });

  test("na: deriveVerifyApplicability is ∅ → status=na, failures=[]", () => {
    // No requirements, no e2e scenarios, no VIS, no done tasks ⇒ ∅
    const fm = makeFrontmatter({
      requirements: [],
      scenarios: [],
      visual_contracts: [],
    });
    const snap = happySnapshot(fm);
    snap.tasks = []; // no done tasks
    const rows = evaluateAllChecks(snap, fm);
    const lane = rows.find((r) => r.check === "lane_status")!;
    expect(lane.status).toBe("na");
    expect(lane.failures).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Case 5-6 — open_findings: fail + always-applicable invariant
// ───────────────────────────────────────────────────────────────────────
describe("evaluateAllChecks — open_findings", () => {
  test("fail: 1 open finding → status=fail, code=OPEN_FINDINGS_PRESENT", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.findings = [
      {
        id: "FND-001",
        category: "spec_quality",
        action: "amend-spec",
        summary: "ambiguous REQ trigger",
        reason: "needs concrete condition",
        status: "open",
      },
    ];
    const rows = evaluateAllChecks(snap, fm);
    const open = rows.find((r) => r.check === "open_findings")!;
    expect(open.status).toBe("fail");
    expect(open.failures[0]!.code).toBe("OPEN_FINDINGS_PRESENT");
  });

  test("always-applicable invariant: empty findings → status=pass (NEVER na)", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.findings = [];
    const applicable = deriveCheckApplicability(snap, fm);
    expect(applicable.open_findings).toBe(true);
    const rows = evaluateAllChecks(snap, fm);
    const open = rows.find((r) => r.check === "open_findings")!;
    expect(open.status).toBe("pass");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Case 7-8 — coverage: multi-fail + na
// ───────────────────────────────────────────────────────────────────────
describe("evaluateAllChecks — coverage", () => {
  test("multi-fail: REQ + SCEN both uncovered → 2+ failures with distinct detail.covered_id", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.filter(
      (e) => !e.covers.includes("REQ-AUTH-001") && !e.covers.includes("SCEN-AUTH-E2E-001"),
    );
    const rows = evaluateAllChecks(snap, fm);
    const cov = rows.find((r) => r.check === "coverage")!;
    expect(cov.status).toBe("fail");
    expect(cov.failures.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(cov.failures.map((f) => f.detail?.covered_id));
    expect(ids.has("REQ-AUTH-001")).toBe(true);
    expect(ids.has("SCEN-AUTH-E2E-001")).toBe(true);
  });

  test("na: zero non-NA obligations → status=na", () => {
    const fm = makeFrontmatter({
      requirements: [],
      scenarios: [],
      visual_contracts: [],
    });
    const snap = happySnapshot(fm);
    const rows = evaluateAllChecks(snap, fm);
    const cov = rows.find((r) => r.check === "coverage")!;
    expect(cov.status).toBe("na");
    expect(cov.failures).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Case 9-12 — task_evidence: 4 sub-cases
// ───────────────────────────────────────────────────────────────────────
describe("evaluateAllChecks — task_evidence", () => {
  test("TASKS_NOT_PLANNED: tasks_based_on=null → check 4 fail (precondition runs even when unplanned)", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.tasks_based_on = null;
    snap.tasks = [];
    const rows = evaluateAllChecks(snap, fm);
    const te = rows.find((r) => r.check === "task_evidence")!;
    expect(te.status).toBe("fail");
    expect(te.failures[0]!.code).toBe("TASKS_NOT_PLANNED");
  });

  test("TASKS_BASED_ON_STALE: tasks_based_on.spec ≠ frontmatter.spec_version", () => {
    const fm = makeFrontmatter({ spec_version: 3 });
    const snap = happySnapshot(fm);
    snap.tasks_based_on = { spec: 2 };
    const rows = evaluateAllChecks(snap, fm);
    const te = rows.find((r) => r.check === "task_evidence")!;
    expect(te.status).toBe("fail");
    expect(te.failures[0]!.code).toBe("TASKS_BASED_ON_STALE");
  });

  test("multi-fail: TASK_DONE_NO_EVIDENCE + BUG_TASK_RED_NOT_REGISTERED in same evaluation", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    // Add a done bug task with no RED + no covering evidence
    snap.tasks.push({
      id: "T-300",
      kind: "behavioral",
      status: "done",
      steps: { red: step("must"), implement: step("must"), refactor: step("optional") },
      drives: [],
      depends_on: [],
      labels: ["bug"],
      requires_acceptance: false,
      red_test_registered: false,
    });
    const rows = evaluateAllChecks(snap, fm);
    const te = rows.find((r) => r.check === "task_evidence")!;
    expect(te.status).toBe("fail");
    const codes = te.failures.map((f) => f.code);
    expect(codes).toContain("TASK_DONE_NO_EVIDENCE");
    expect(codes).toContain("BUG_TASK_RED_NOT_REGISTERED");
  });

  test("empty planned graph na (codex r304 r303): tasks_based_on={spec}, tasks=[] → check 4 na, failures=[]", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.tasks = []; // empty planned graph
    // tasks_based_on stays {spec: fm.spec_version}
    const rows = evaluateAllChecks(snap, fm);
    const te = rows.find((r) => r.check === "task_evidence")!;
    expect(te.status).toBe("na");
    expect(te.failures).toEqual([]);
  });

  test("na when graph present + tasks exist but none done", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.tasks = [doneTask({ status: "pending" })];
    const rows = evaluateAllChecks(snap, fm);
    const te = rows.find((r) => r.check === "task_evidence")!;
    expect(te.status).toBe("na");
    expect(te.failures).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Case 13-16 — spec_review: 4 sub-cases (3 codes + strict=false na)
// ───────────────────────────────────────────────────────────────────────
describe("evaluateAllChecks — spec_review", () => {
  test("SPEC_REVIEW_MISSING: strict=true + no spec-review evidence", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.state!.ceremony.strict_spec_review = true;
    const rows = evaluateAllChecks(snap, fm);
    const sr = rows.find((r) => r.check === "spec_review")!;
    expect(sr.status).toBe("fail");
    expect(sr.failures[0]!.code).toBe("SPEC_REVIEW_MISSING");
  });

  test("SPEC_REVIEW_IMPLEMENTER_CONFLICT: every spec-review actor in implementer set", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.state!.ceremony.strict_spec_review = true;
    snap.evidence.push(
      evidence({
        id: "EV-000099",
        kind: "spec-review",
        covers: ["REQ-AUTH-001"],
        check: "review",
        result: "approved",
        actor: "human:dev@example.com", // SAME as task-summary implementer
      }),
    );
    const rows = evaluateAllChecks(snap, fm);
    const sr = rows.find((r) => r.check === "spec_review")!;
    expect(sr.status).toBe("fail");
    expect(sr.failures[0]!.code).toBe("SPEC_REVIEW_IMPLEMENTER_CONFLICT");
  });

  test("SPEC_REVIEW_IMPLEMENTER_UNKNOWN: strict=true + spec-review present + implementer set empty (cli:*)", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.state!.ceremony.strict_spec_review = true;
    // Convert all done-task evidence actors to cli:* so implementer set is empty
    snap.evidence = snap.evidence.map((e) =>
      e.kind === "task-summary" ? { ...e, actor: "cli:loaf" } : e,
    );
    snap.evidence.push(
      evidence({
        id: "EV-000099",
        kind: "spec-review",
        covers: ["REQ-AUTH-001"],
        check: "review",
        result: "approved",
        actor: "human:reviewer@example.com",
      }),
    );
    const rows = evaluateAllChecks(snap, fm);
    const sr = rows.find((r) => r.check === "spec_review")!;
    expect(sr.status).toBe("fail");
    expect(sr.failures[0]!.code).toBe("SPEC_REVIEW_IMPLEMENTER_UNKNOWN");
  });

  test("na: strict_spec_review=false → status=na, failures=[]", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.state!.ceremony.strict_spec_review = false;
    const rows = evaluateAllChecks(snap, fm);
    const sr = rows.find((r) => r.check === "spec_review")!;
    expect(sr.status).toBe("na");
    expect(sr.failures).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Case 17 — mixed: 2+ checks fail independently
// ───────────────────────────────────────────────────────────────────────
describe("evaluateAllChecks — mixed multi-check failure", () => {
  test("lane + coverage + findings all fail independently in same evaluation", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.filter((e) => e.check !== "acceptance"); // lane fail
    snap.evidence = snap.evidence.filter((e) => !e.covers.includes("REQ-AUTH-001")); // coverage fail
    snap.findings = [{
      id: "FND-001",
      category: "spec_quality",
      action: "amend-spec",
      summary: "x",
      reason: "y",
      status: "open",
    }]; // findings fail
    const rows = evaluateAllChecks(snap, fm);
    const failingChecks = rows.filter((r) => r.status === "fail").map((r) => r.check);
    expect(failingChecks).toContain("lane_status");
    expect(failingChecks).toContain("coverage");
    expect(failingChecks).toContain("open_findings");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Case 18 — invariant byte-equal:
//   verifyAcceptCheck(snap, fm).checks deep-equal
//     evaluateAllChecks(snap, fm).flatMap(r => r.failures)
// ───────────────────────────────────────────────────────────────────────
describe("invariant — verifyAcceptCheck === flatMap failures", () => {
  test("byte-equal for all-pass (empty failures)", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    const vac = verifyAcceptCheck(snap, fm);
    const all = evaluateAllChecks(snap, fm).flatMap((r) => r.failures);
    if (vac.ok) {
      expect(all).toEqual([]);
    } else {
      expect(vac.checks).toEqual(all);
    }
  });

  test("byte-equal for mixed multi-check failures (all 10 codes spectrum)", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    // Force lane + coverage + findings + task_evidence (no done evidence) +
    // spec_review (strict + missing) — exercises 5 distinct codes
    snap.state!.ceremony.strict_spec_review = true;
    snap.evidence = snap.evidence.filter((e) => e.check !== "acceptance");
    snap.evidence = snap.evidence.filter((e) => !e.covers.includes("REQ-AUTH-001"));
    snap.findings = [{
      id: "FND-001",
      category: "spec_quality",
      action: "amend-spec",
      summary: "x",
      reason: "y",
      status: "open",
    }];
    const vac = verifyAcceptCheck(snap, fm);
    const all = evaluateAllChecks(snap, fm).flatMap((r) => r.failures);
    if (vac.ok) {
      expect(all).toEqual([]);
    } else {
      expect(vac.checks).toEqual(all);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// Case 19 — §7.4 envelope golden: shape parity with docs/protocol.md
// ───────────────────────────────────────────────────────────────────────
describe("buildEnvelope — §7.4 shape parity", () => {
  test("envelope shape matches docs/protocol.md §7.4 example: ok/all_pass/checks[5 rows]", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.filter((e) => e.check !== "run"); // 1 lane fails
    snap.tasks.push({
      id: "T-002",
      kind: "behavioral",
      status: "done",
      steps: { red: step("must"), implement: step("must"), refactor: step("optional") },
      drives: [],
      depends_on: [],
      labels: [],
      requires_acceptance: false,
      red_test_registered: true,
    }); // T-002 has no covering evidence → check 4 fail

    const env = buildEnvelope(evaluateAllChecks(snap, fm));

    expect(env.ok).toBe(true);
    expect(env.all_pass).toBe(false);
    expect(env.checks).toHaveLength(5);
    expect(env.checks.map((r) => r.check)).toEqual([...VERIFY_CHECK_IDS]);

    // Per-row shape: { check: VerifyCheckId, status, failures: FailedCheck[] }
    for (const row of env.checks) {
      expect(typeof row.check).toBe("string");
      expect(["pass", "fail", "na"]).toContain(row.status);
      expect(Array.isArray(row.failures)).toBe(true);
    }

    // Specific assertions matching §7.4 example
    const lane = env.checks.find((r) => r.check === "lane_status")!;
    expect(lane.status).toBe("fail");
    expect(lane.failures[0]!.code).toBe("VERIFY_LANE_NOT_PASSED");
    expect(lane.failures[0]!.detail?.lane).toBeDefined();

    const te = env.checks.find((r) => r.check === "task_evidence")!;
    expect(te.status).toBe("fail");
    const teCodes = te.failures.map((f) => f.code);
    expect(teCodes).toContain("TASK_DONE_NO_EVIDENCE");

    const sr = env.checks.find((r) => r.check === "spec_review")!;
    expect(sr.status).toBe("na"); // strict_spec_review=false
    expect(sr.failures).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Case 20 — buildEnvelope all_pass derivation
// ───────────────────────────────────────────────────────────────────────
describe("buildEnvelope — all_pass semantics", () => {
  test("all_pass=true iff every row has status !== 'fail' (na rows do NOT block all_pass)", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    const env = buildEnvelope(evaluateAllChecks(snap, fm));
    expect(env.all_pass).toBe(true); // strict_spec_review off → spec_review=na, still all_pass

    snap.findings = [{
      id: "FND-001",
      category: "spec_quality",
      action: "amend-spec",
      summary: "x",
      reason: "y",
      status: "open",
    }];
    const env2 = buildEnvelope(evaluateAllChecks(snap, fm));
    expect(env2.all_pass).toBe(false);
  });
});
