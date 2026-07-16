// verify-accept-check — pure gate evaluator for protocol §5.2 (5 checks).
//
// Slice 1.C sub-cycle 3 (codex r33 lock):
//   - check 1: per-applicable-lane status via deriveVerifyApplicability +
//              EvidenceEntry.check primary linkage + narrow kind fallback
//   - check 2: no open findings
//   - check 3: every REQ/SCEN/VIS (non *_na) has ≥1 evidence passing
//              canSatisfy (delegates evidence-compat.ts)
//   - check 4: every done task has ≥1 passing evidence — WITH stale
//              tasks_based_on precondition (TASKS_NOT_PLANNED/
//              TASKS_BASED_ON_STALE before per-task scan, codex r33 Q1(d))
//   - check 5: deep spec-review evidence actor ≠ implementer ONLY when
//              ceremony.strict_spec_review === true (codex r33 Q4 NOT
//              settle_phase). Implementer fail-closed: cli:* actors excluded;
//              if no implementer can be established, check fails.
//
// No cascade rule (codex r33 Q3 lock + r34 confirm) — all 5 checks run
// independently; stale tasks_based_on only affects check 4 (its
// precondition), not other checks.

import { describe, expect, test } from "vitest";

import { verifyAcceptCheck } from "../../../src/core/gates/verify-accept-check.js";
import { apply, initialSnapshot } from "../../../src/core/reducer.js";
import type { JournalEntry } from "../../../src/core/journal-entry.js";
import type {
  Snapshot,
  TaskState,
  EvidenceState,
  FindingState,
} from "../../../src/core/reducer.js";
import type { SpecFrontmatter } from "../../../src/core/spec-schema.js";

const SHA = "a".repeat(64);

const REQ_VERIFIABLE: SpecFrontmatter["requirements"][number] = {
  id: "REQ-AUTH-001",
  type: "event-driven",
  trigger: "an API request returns 401",
  response: "the system shall refresh the access token before surfacing failure",
  verified_by_scenarios: ["SCEN-AUTH-E2E-001"],
};

const REQ_NA: SpecFrontmatter["requirements"][number] = {
  id: "REQ-AUTH-099",
  type: "ubiquitous",
  response: "the system shall behave reasonably here",
  acceptance_na: true,
  acceptance_na_reason: "covered by manual UX testing scope outside automation",
};

const SCEN_E2E: SpecFrontmatter["scenarios"][number] = {
  id: "SCEN-AUTH-E2E-001",
  name: "user refresh happy path",
  tag: "e2e",
  given: ["valid refresh token in cookie"],
  when: ["request to /protected returns 401"],
  then: ["refresh runs and original request retries"],
};

const SCEN_E2E_NA: SpecFrontmatter["scenarios"][number] = {
  id: "SCEN-AUTH-E2E-NA",
  name: "manual coverage path",
  tag: "e2e",
  given: ["see manual checklist"],
  when: ["unspecified"],
  then: ["unspecified"],
  acceptance_na: "covered by manual UX testing scope",
};

const VIS_001: NonNullable<SpecFrontmatter["visual_contracts"]>[number] = {
  id: "VIS-AUTH-001",
  target: "OAuth login button hover state",
  checks: ["pixel snapshot of hover variant"],
};

const VIS_NA: NonNullable<SpecFrontmatter["visual_contracts"]>[number] = {
  id: "VIS-AUTH-NA",
  target: "non-UI feature surface",
  checks: ["no visual surface"],
  visual_na: "non-UI feature; no screenshot path",
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

function step(
  applicability: "must" | "optional" | "na" = "must",
  status: TaskState["steps"][string]["status"] = "passed",
) {
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

/** Snapshot pre-positioned so all 5 checks pass against the default frontmatter. */
function happySnapshot(
  frontmatter: SpecFrontmatter,
  ceremonyOverrides: Partial<Snapshot["state"] & object> = {},
): Snapshot {
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
        ...((ceremonyOverrides as { ceremony?: Record<string, unknown> }).ceremony ?? {}),
      },
    },
    tasks_based_on: { spec: frontmatter.spec_version },
    tasks: [doneTask(), visualDoneTask()],
    evidence: [
      // task evidence (check 4)
      evidence({ id: "EV-000001", kind: "task-summary", covers: ["T-001"], check: "run" }),
      evidence({ id: "EV-000002", kind: "task-summary", covers: ["T-200"], check: "run" }),
      // REQ coverage (check 3)
      evidence({
        id: "EV-000003",
        kind: "verify-review",
        covers: ["REQ-AUTH-001"],
        check: "review",
        result: "approved",
      }),
      // SCEN coverage (check 3)
      evidence({
        id: "EV-000004",
        kind: "acceptance",
        covers: ["SCEN-AUTH-E2E-001"],
        check: "acceptance",
      }),
      // VIS coverage (check 3)
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
// Happy path — all 5 checks pass independently
// ───────────────────────────────────────────────────────────────────────

describe("verifyAcceptCheck — happy path (all 5 checks pass)", () => {
  test("ok=true when standard happySnapshot + frontmatter pass all 5 checks", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(true);
  });

  test("ok=true when ceremony.strict_spec_review=true + spec-review evidence from non-implementer", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.state!.ceremony.strict_spec_review = true;
    snap.evidence.push(
      evidence({
        id: "EV-000010",
        kind: "spec-review",
        covers: ["REQ-AUTH-001"],
        check: "review",
        result: "approved",
        actor: "human:reviewer@example.com", // different from implementer dev@
      }),
    );
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Check 1 — lane status (deriveVerifyApplicability + EvidenceEntry.check)
// ───────────────────────────────────────────────────────────────────────

describe("verifyAcceptCheck — check 1 lane status", () => {
  test("fails VERIFY_LANE_NOT_PASSED when ACCEPTANCE lane has no evidence", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.filter((e) => e.check !== "acceptance");
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const lane1Fails = result.checks.filter((c) => c.code === "VERIFY_LANE_NOT_PASSED");
    expect(lane1Fails.length).toBeGreaterThan(0);
    expect(lane1Fails[0]!.detail?.lane).toBe("acceptance");
  });

  test("fails VERIFY_LANE_NOT_PASSED when VISUAL lane has no evidence (VIS-* present)", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.filter((e) => e.check !== "visual");
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const lane1Fails = result.checks.filter(
      (c) => c.code === "VERIFY_LANE_NOT_PASSED" && c.detail?.lane === "visual",
    );
    expect(lane1Fails.length).toBeGreaterThan(0);
  });

  test("evidence with check=acceptance + result=failed does NOT count as lane pass", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.map((e) =>
      e.check === "acceptance" ? { ...e, result: "failed" } : e,
    );
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(
      result.checks.some(
        (c) => c.code === "VERIFY_LANE_NOT_PASSED" && c.detail?.lane === "acceptance",
      ),
    ).toBe(true);
  });

  test("evidence with check=acceptance + result=waived counts as lane pass", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.map((e) =>
      e.check === "acceptance" ? { ...e, result: "waived" } : e,
    );
    const result = verifyAcceptCheck(snap, fm);
    // check 1 should pass for acceptance lane (waived counts)
    if (!result.ok) {
      const lane1Fails = result.checks.filter(
        (c) => c.code === "VERIFY_LANE_NOT_PASSED" && c.detail?.lane === "acceptance",
      );
      expect(lane1Fails.length).toBe(0);
    }
  });

  test("kind-only fallback: local-check (no check field) counts for RUN lane", () => {
    const fm = makeFrontmatter({
      requirements: [REQ_VERIFIABLE],
      scenarios: [],
      visual_contracts: [],
    });
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.filter((e) => e.check !== "run");
    // Add a local-check WITHOUT check field — fallback should map to RUN.
    snap.evidence.push(
      evidence({
        id: "EV-000020",
        kind: "local-check",
        covers: ["T-001"],
        result: "passed",
      }),
    );
    const result = verifyAcceptCheck(snap, fm);
    // RUN lane should pass via fallback; if any LANE failure exists, it
    // shouldn't be about RUN.
    if (!result.ok) {
      const runFails = result.checks.filter(
        (c) => c.code === "VERIFY_LANE_NOT_PASSED" && c.detail?.lane === "run",
      );
      expect(runFails.length).toBe(0);
    }
  });

  test("task-summary alone does NOT count for REVIEW lane (not in narrow fallback map)", () => {
    const fm = makeFrontmatter({
      requirements: [REQ_VERIFIABLE],
      scenarios: [],
      visual_contracts: [],
    });
    const snap = happySnapshot(fm);
    // Strip all verify-review/spec-review evidence + check=review labels.
    snap.evidence = snap.evidence.filter(
      (e) => e.kind !== "verify-review" && e.kind !== "spec-review" && e.check !== "review",
    );
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(
      result.checks.some((c) => c.code === "VERIFY_LANE_NOT_PASSED" && c.detail?.lane === "review"),
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Check 2 — no open findings
// ───────────────────────────────────────────────────────────────────────

describe("verifyAcceptCheck — check 2 open findings", () => {
  test("ok when findings array empty", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    expect(snap.findings).toEqual([]);
    const result = verifyAcceptCheck(snap, fm);
    if (!result.ok) {
      expect(result.checks.filter((c) => c.code === "OPEN_FINDINGS_PRESENT")).toEqual([]);
    }
  });

  test("ok when all findings closed", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    const closed: FindingState = {
      id: "FND-001",
      category: "spec-gap",
      action: "amend-spec",
      status: "closed",
    };
    snap.findings.push(closed);
    const result = verifyAcceptCheck(snap, fm);
    if (!result.ok) {
      expect(result.checks.filter((c) => c.code === "OPEN_FINDINGS_PRESENT")).toEqual([]);
    }
  });

  test("fails OPEN_FINDINGS_PRESENT when ≥1 finding open", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    const open: FindingState = {
      id: "FND-001",
      category: "impl-defect",
      action: "fix-impl",
      status: "open",
    };
    snap.findings.push(open);
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const fails = result.checks.filter((c) => c.code === "OPEN_FINDINGS_PRESENT");
    expect(fails.length).toBe(1);
    expect(fails[0]!.detail?.open_ids as string[]).toContain("FND-001");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Check 3 — REQ/SCEN/VIS canSatisfy coverage
// ───────────────────────────────────────────────────────────────────────

describe("verifyAcceptCheck — check 3 coverage (canSatisfy)", () => {
  test("fails COVERAGE_NOT_SATISFIED when REQ has no evidence", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.filter((e) => !e.covers.includes("REQ-AUTH-001"));
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const cov = result.checks.filter(
      (c) => c.code === "COVERAGE_NOT_SATISFIED" && c.detail?.covered_id === "REQ-AUTH-001",
    );
    expect(cov.length).toBe(1);
  });

  test("lesson:recorded never satisfies REQ coverage", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.filter((e) => !e.covers.includes("REQ-AUTH-001"));
    const applied = apply(snap, {
      seq: 1,
      entry_id: "JE-000001",
      at: "2026-07-16T12:00:00.000Z",
      actor: "human:tester",
      entry_schema_version: 1,
      kind: "lesson:recorded",
      payload: {
        id: "LSN-001",
        iteration: 1,
        reason: "captured during coverage testing",
        summary: "a lesson is not verification evidence",
      },
    } as JournalEntry);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error("unreachable");

    const result = verifyAcceptCheck(applied.snapshot, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(
      result.checks.some(
        (check) =>
          check.code === "COVERAGE_NOT_SATISFIED" &&
          check.detail?.covered_id === "REQ-AUTH-001",
      ),
    ).toBe(true);
  });

  test("REQ with acceptance_na=true skips coverage", () => {
    const fm = makeFrontmatter({ requirements: [REQ_VERIFIABLE, REQ_NA] });
    const snap = happySnapshot(fm);
    // No evidence for REQ_NA — should NOT fail.
    const result = verifyAcceptCheck(snap, fm);
    if (!result.ok) {
      const naFails = result.checks.filter(
        (c) => c.code === "COVERAGE_NOT_SATISFIED" && c.detail?.covered_id === "REQ-AUTH-099",
      );
      expect(naFails).toEqual([]);
    }
  });

  test("SCEN with acceptance_na skips coverage", () => {
    const fm = makeFrontmatter({ scenarios: [SCEN_E2E, SCEN_E2E_NA] });
    const snap = happySnapshot(fm);
    const result = verifyAcceptCheck(snap, fm);
    if (!result.ok) {
      const naFails = result.checks.filter(
        (c) => c.code === "COVERAGE_NOT_SATISFIED" && c.detail?.covered_id === "SCEN-AUTH-E2E-NA",
      );
      expect(naFails).toEqual([]);
    }
  });

  test("VIS with visual_na skips coverage", () => {
    const fm = makeFrontmatter({ visual_contracts: [VIS_001, VIS_NA] });
    const snap = happySnapshot(fm);
    const result = verifyAcceptCheck(snap, fm);
    if (!result.ok) {
      const naFails = result.checks.filter(
        (c) => c.code === "COVERAGE_NOT_SATISFIED" && c.detail?.covered_id === "VIS-AUTH-NA",
      );
      expect(naFails).toEqual([]);
    }
  });

  test("evidence kind not in EVIDENCE_COMPAT for id-kind rejects coverage (local-check on REQ)", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.filter((e) => !e.covers.includes("REQ-AUTH-001"));
    snap.evidence.push(
      evidence({ id: "EV-000099", kind: "local-check", covers: ["REQ-AUTH-001"] }),
    );
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const cov = result.checks.filter(
      (c) => c.code === "COVERAGE_NOT_SATISFIED" && c.detail?.covered_id === "REQ-AUTH-001",
    );
    expect(cov.length).toBe(1);
  });

  // codex r38 BLOCK 1 fix: evidence with result=rejected/failed does NOT
  // satisfy coverage even when kind is allowed (protocol §1035 result
  // filter — was leaking through pre-r38).
  test("evidence kind allowed but result=rejected does NOT satisfy REQ coverage (§1035 filter)", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.filter((e) => !e.covers.includes("REQ-AUTH-001"));
    snap.evidence.push(
      evidence({
        id: "EV-000099",
        kind: "verify-review",
        covers: ["REQ-AUTH-001"],
        check: "review",
        result: "rejected",
      }),
    );
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const cov = result.checks.filter(
      (c) => c.code === "COVERAGE_NOT_SATISFIED" && c.detail?.covered_id === "REQ-AUTH-001",
    );
    expect(cov.length).toBe(1);
  });

  test("evidence kind allowed but result=failed does NOT satisfy SCEN coverage", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.filter((e) => !e.covers.includes("SCEN-AUTH-E2E-001"));
    snap.evidence.push(
      evidence({
        id: "EV-000098",
        kind: "acceptance",
        covers: ["SCEN-AUTH-E2E-001"],
        check: "acceptance",
        result: "failed",
      }),
    );
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const cov = result.checks.filter(
      (c) => c.code === "COVERAGE_NOT_SATISFIED" && c.detail?.covered_id === "SCEN-AUTH-E2E-001",
    );
    expect(cov.length).toBe(1);
  });

  test("evidence kind allowed but result=rejected does NOT satisfy VIS coverage", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.evidence = snap.evidence.filter((e) => !e.covers.includes("VIS-AUTH-001"));
    snap.evidence.push(
      evidence({
        id: "EV-000097",
        kind: "visual-review",
        covers: ["VIS-AUTH-001"],
        check: "visual",
        result: "rejected",
        attachments: [{ path: "shot.png", sha256: SHA, mime: "image/png" }],
      }),
    );
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const cov = result.checks.filter(
      (c) => c.code === "COVERAGE_NOT_SATISFIED" && c.detail?.covered_id === "VIS-AUTH-001",
    );
    expect(cov.length).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Check 4 — task done has evidence + stale tasks_based_on precondition
// ───────────────────────────────────────────────────────────────────────

describe("verifyAcceptCheck — check 4 task evidence + stale precondition", () => {
  test("fails TASKS_NOT_PLANNED when snapshot.tasks_based_on is null", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.tasks_based_on = null;
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const fails = result.checks.filter((c) => c.code === "TASKS_NOT_PLANNED");
    expect(fails.length).toBe(1);
  });

  test("fails TASKS_BASED_ON_STALE when tasks_based_on.spec !== frontmatter.spec_version", () => {
    const fm = makeFrontmatter({ spec_version: 3 });
    const snap = happySnapshot(fm);
    snap.tasks_based_on = { spec: 1 };
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const fails = result.checks.filter((c) => c.code === "TASKS_BASED_ON_STALE");
    expect(fails.length).toBe(1);
    expect(fails[0]!.detail?.tasks_based_on_spec).toBe(1);
    expect(fails[0]!.detail?.current_spec_version).toBe(3);
  });

  test("stale precondition skips per-task scan (no TASK_DONE_NO_EVIDENCE)", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.tasks_based_on = null;
    snap.evidence = []; // would normally trigger per-task fail
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const perTask = result.checks.filter((c) => c.code === "TASK_DONE_NO_EVIDENCE");
    expect(perTask).toEqual([]);
  });

  test("fails TASK_DONE_NO_EVIDENCE for done task with no evidence covers", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    // Remove all evidence covering T-001
    snap.evidence = snap.evidence.filter((e) => !e.covers.includes("T-001"));
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const fails = result.checks.filter(
      (c) => c.code === "TASK_DONE_NO_EVIDENCE" && c.detail?.task_id === "T-001",
    );
    expect(fails.length).toBe(1);
  });

  test("fails TASK_DONE_NO_EVIDENCE when multi-task lane evidence passes but one done task has only failed evidence", () => {
    const fm = makeFrontmatter({ scenarios: [], visual_contracts: [] });
    const snap = happySnapshot(fm);
    snap.tasks = [doneTask({ id: "T-001" }), doneTask({ id: "T-002" })];
    snap.evidence = [
      evidence({
        id: "EV-000101",
        kind: "local-check",
        covers: ["T-001"],
        check: "run",
        result: "failed",
      }),
      evidence({
        id: "EV-000102",
        kind: "local-check",
        covers: ["T-002"],
        check: "run",
        result: "passed",
      }),
      evidence({
        id: "EV-000103",
        kind: "verify-review",
        covers: ["REQ-AUTH-001"],
        check: "review",
        result: "approved",
      }),
    ];

    const result = verifyAcceptCheck(snap, fm);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.checks.filter((c) => c.code === "VERIFY_LANE_NOT_PASSED")).toEqual([]);
    const fails = result.checks.filter(
      (c) => c.check === 4 && c.code === "TASK_DONE_NO_EVIDENCE" && c.detail?.task_id === "T-001",
    );
    expect(fails.length).toBe(1);
  });

  test("fails TASK_DONE_NO_EVIDENCE for single done task covered only by failed evidence", () => {
    const fm = makeFrontmatter({ requirements: [], scenarios: [], visual_contracts: [] });
    const snap = happySnapshot(fm);
    snap.tasks = [doneTask({ id: "T-001", drives: [] })];
    snap.evidence = [
      evidence({
        id: "EV-000101",
        kind: "local-check",
        covers: ["T-001"],
        check: "run",
        result: "failed",
      }),
      evidence({
        id: "EV-000102",
        kind: "verify-review",
        covers: [],
        check: "review",
        result: "approved",
      }),
    ];

    const result = verifyAcceptCheck(snap, fm);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const fails = result.checks.filter(
      (c) => c.check === 4 && c.code === "TASK_DONE_NO_EVIDENCE" && c.detail?.task_id === "T-001",
    );
    expect(fails.length).toBe(1);
  });

  test("non-done task has no check 4 obligation", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.tasks.push({
      ...doneTask({ id: "T-099" }),
      status: "in_progress",
    });
    const result = verifyAcceptCheck(snap, fm);
    if (!result.ok) {
      const fails = result.checks.filter(
        (c) => c.code === "TASK_DONE_NO_EVIDENCE" && c.detail?.task_id === "T-099",
      );
      expect(fails).toEqual([]);
    }
  });

  test("done bug task with red_test_registered≠true → BUG_TASK_RED_NOT_REGISTERED (Slice C SC-C4)", () => {
    // R2 defense-in-depth: preflight protects new legal writes, but
    // verify-accept catches a done bug task that never registered RED —
    // migration / raw-API / pre-guard historical journals.
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    const t001 = snap.tasks.find((t) => t.id === "T-001")!;
    t001.labels = ["bug"];
    delete (t001 as { red_test_registered?: boolean }).red_test_registered;
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const fails = result.checks.filter(
      (c) => c.code === "BUG_TASK_RED_NOT_REGISTERED" && c.detail?.task_id === "T-001",
    );
    expect(fails.length).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Check 5 — deep spec-review (ceremony.strict_spec_review=true only)
// ───────────────────────────────────────────────────────────────────────

describe("verifyAcceptCheck — check 5 spec-review (deep / strict_spec_review)", () => {
  test("strict_spec_review=false: check 5 skips entirely (no spec-review evidence needed)", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.state!.ceremony.strict_spec_review = false;
    // No spec-review evidence — should NOT trigger SPEC_REVIEW_MISSING.
    const result = verifyAcceptCheck(snap, fm);
    if (!result.ok) {
      const c5 = result.checks.filter(
        (c) =>
          c.code === "SPEC_REVIEW_MISSING" ||
          c.code === "SPEC_REVIEW_IMPLEMENTER_CONFLICT" ||
          c.code === "SPEC_REVIEW_IMPLEMENTER_UNKNOWN",
      );
      expect(c5).toEqual([]);
    }
  });

  test("strict_spec_review=true + NO spec-review evidence → SPEC_REVIEW_MISSING", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.state!.ceremony.strict_spec_review = true;
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const fails = result.checks.filter((c) => c.code === "SPEC_REVIEW_MISSING");
    expect(fails.length).toBe(1);
  });

  test("strict_spec_review=true + spec-review actor === implementer actor → SPEC_REVIEW_IMPLEMENTER_CONFLICT", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.state!.ceremony.strict_spec_review = true;
    snap.evidence.push(
      evidence({
        id: "EV-000010",
        kind: "spec-review",
        covers: ["REQ-AUTH-001"],
        check: "review",
        result: "approved",
        actor: "human:dev@example.com", // SAME as implementer (default doneTask evidence actor)
      }),
    );
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const fails = result.checks.filter((c) => c.code === "SPEC_REVIEW_IMPLEMENTER_CONFLICT");
    expect(fails.length).toBe(1);
  });

  test("strict_spec_review=true + spec-review actor ≠ implementer → ok", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.state!.ceremony.strict_spec_review = true;
    snap.evidence.push(
      evidence({
        id: "EV-000010",
        kind: "spec-review",
        covers: ["REQ-AUTH-001"],
        check: "review",
        result: "approved",
        actor: "human:reviewer@example.com", // different
      }),
    );
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(true);
  });

  // codex r38 BLOCK 2 fix: a rejected spec-review is not an independent
  // sign-off. Filter to passing results before missing/conflict logic.
  test("strict_spec_review=true + spec-review result=rejected → SPEC_REVIEW_MISSING (§1035)", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.state!.ceremony.strict_spec_review = true;
    snap.evidence.push(
      evidence({
        id: "EV-000010",
        kind: "spec-review",
        covers: ["REQ-AUTH-001"],
        check: "review",
        result: "rejected",
        actor: "human:reviewer@example.com",
      }),
    );
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const fails = result.checks.filter((c) => c.code === "SPEC_REVIEW_MISSING");
    expect(fails.length).toBe(1);
  });

  // codex r40 BLOCK: spec-review with result=waived does NOT count as
  // sign-off — EvidenceFullPayload's actor+reason refine is kind-based
  // (manual/waiver only), not result-based, so `kind=spec-review,
  // result=waived, actor=skill:..., no reason` would otherwise pass.
  // Conservative policy: spec-review requires positive result.
  test("strict_spec_review=true + spec-review result=waived does NOT count (§r40 policy)", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.state!.ceremony.strict_spec_review = true;
    // Reproducer from codex r40 — skill actor + no reason + waived result.
    snap.evidence.push(
      evidence({
        id: "EV-000011",
        kind: "spec-review",
        covers: ["REQ-AUTH-001"],
        check: "review",
        result: "waived",
        actor: "skill:reviewer",
      }),
    );
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const fails = result.checks.filter((c) => c.code === "SPEC_REVIEW_MISSING");
    expect(fails.length).toBe(1);
  });

  test("strict_spec_review=true + spec-review result=waived even from human reviewer with reason does NOT count", () => {
    // Even the well-formed waiver-like payload is rejected — strict means
    // strict. Lane status still accepts waived (check 1), only spec-review
    // demands positive sign-off.
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.state!.ceremony.strict_spec_review = true;
    snap.evidence.push(
      evidence({
        id: "EV-000012",
        kind: "spec-review",
        covers: ["REQ-AUTH-001"],
        check: "review",
        result: "waived",
        actor: "human:reviewer@example.com",
        reason: "approved waiver after offline architecture discussion",
      }),
    );
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.checks.some((c) => c.code === "SPEC_REVIEW_MISSING")).toBe(true);
  });

  test("strict_spec_review=true + implementer set empty (fail-closed) → SPEC_REVIEW_IMPLEMENTER_UNKNOWN", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    snap.state!.ceremony.strict_spec_review = true;
    // All task evidence actor=cli:loaf (excluded from implementer set)
    snap.evidence = snap.evidence.map((e) =>
      e.covers.some((c) => c.startsWith("T-")) ? { ...e, actor: "cli:loaf" } : e,
    );
    snap.evidence.push(
      evidence({
        id: "EV-000010",
        kind: "spec-review",
        covers: ["REQ-AUTH-001"],
        check: "review",
        result: "approved",
        actor: "human:reviewer@example.com",
      }),
    );
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const fails = result.checks.filter((c) => c.code === "SPEC_REVIEW_IMPLEMENTER_UNKNOWN");
    expect(fails.length).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────
// No cascade rule — all 5 checks run independently
// ───────────────────────────────────────────────────────────────────────

describe("verifyAcceptCheck — no cascade (codex r33 Q3 lock)", () => {
  test("multiple checks fail in parallel — all reported", () => {
    const fm = makeFrontmatter();
    const snap = happySnapshot(fm);
    // Break lane (check 1), open finding (check 2), missing coverage (check 3),
    // and stale tasks_based_on (check 4 precondition).
    snap.evidence = []; // breaks 1/3
    snap.findings.push({
      id: "FND-001",
      category: "impl-defect",
      action: "fix-impl",
      status: "open",
    });
    snap.tasks_based_on = null;
    const result = verifyAcceptCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const codes = new Set(result.checks.map((c) => c.code));
    expect(codes.has("VERIFY_LANE_NOT_PASSED")).toBe(true);
    expect(codes.has("OPEN_FINDINGS_PRESENT")).toBe(true);
    expect(codes.has("COVERAGE_NOT_SATISFIED")).toBe(true);
    expect(codes.has("TASKS_NOT_PLANNED")).toBe(true);
  });
});
