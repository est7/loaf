// spec-lock-check — pure gate evaluator (all 8 checks).
//
// Slice 1.B sub-cycles 2 + 3b: check 1 is caller's responsibility;
// checks 2/3/4/5/6/7/8 land here. Failure ordering matches protocol
// §5.1 (2 → 3 → 4 → 5 → 6 → 7 → 8). Checks 4/6/7 are SUPPRESSED when
// check 3 fails to avoid false-positive coverage diagnostics against an
// absent/stale task graph (codex r26 constraint).

import { describe, expect, test } from "vitest";

import { specLockCheck } from "../../../src/core/gates/spec-lock-check.js";
import { initialSnapshot } from "../../../src/core/reducer.js";
import type { Snapshot, TaskState } from "../../../src/core/reducer.js";
import type { SpecFrontmatter } from "../../../src/core/spec-schema.js";

const REQ_VERIFIABLE: SpecFrontmatter["requirements"][number] = {
  id: "REQ-AUTH-001",
  type: "event-driven",
  trigger: "an API request returns 401",
  response: "the system shall refresh the access token before surfacing failure",
  verified_by_scenarios: ["SCEN-AUTH-E2E-001"],
};

const REQ_VERIFIABLE_2: SpecFrontmatter["requirements"][number] = {
  id: "REQ-AUTH-002",
  type: "ubiquitous",
  response: "the system shall respond within bounded latency under load",
  measurable: { metric: "p99_latency_ms", threshold: 500, direction: "lte" },
};

const REQ_UNVERIFIABLE: SpecFrontmatter["requirements"][number] = {
  id: "REQ-AUTH-099",
  type: "ubiquitous",
  response: "the system shall provide reasonable behavior here",
};

function makeFrontmatter(overrides: Partial<SpecFrontmatter> = {}): SpecFrontmatter {
  return {
    schema_version: 2,
    spec_version: 1,
    feature: { id: "F-001", name: "OAuth token refresh" },
    intent: "users should not perceive auth recovery flows in flight",
    adr_refs: [],
    requirements: [REQ_VERIFIABLE],
    scenarios: [],
    needs_clarification: [],
    ...overrides,
  };
}

function step(applicability: "must" | "optional" | "na", status: TaskState["steps"][string]["status"] = "pending") {
  return { applicability, status };
}

function behavioralTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "T-001",
    kind: "behavioral",
    status: "pending",
    steps: { red: step("must"), implement: step("must"), refactor: step("optional") },
    drives: [],
    depends_on: [],
    labels: [],
    ...overrides,
  };
}

function visualUiTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "T-200",
    kind: "visual-ui",
    status: "pending",
    steps: { mockup: step("must"), implement: step("must"), "screenshot-compare": step("must") },
    drives: [],
    depends_on: [],
    labels: [],
    visual_contract_refs: [],
    ...overrides,
  };
}

/**
 * Build a snapshot that auto-satisfies checks 3/4/6/7 for the given
 * frontmatter: tasks_based_on matches spec_version; one behavioral task
 * drives every REQ + every non-acceptance_na e2e scenario; one visual-ui
 * task carries refs to every non-visual_na visual_contract.
 */
function snapshotCoveringFrontmatter(frontmatter: SpecFrontmatter): Snapshot {
  const reqIds = frontmatter.requirements.map((r) => r.id);
  const e2eIds = frontmatter.scenarios
    .filter((s) => s.tag === "e2e" && s.acceptance_na === undefined)
    .map((s) => s.id);
  const visIds = (frontmatter.visual_contracts ?? [])
    .filter((v) => v.visual_na === undefined)
    .map((v) => v.id);

  const tasks: TaskState[] = [];
  if (reqIds.length > 0 || e2eIds.length > 0) {
    tasks.push(
      behavioralTask({
        id: "T-001",
        drives: [...reqIds, ...e2eIds],
        ...(e2eIds.length > 0 ? { requires_acceptance: true } : {}),
      }),
    );
  }
  if (visIds.length > 0) {
    tasks.push(visualUiTask({ id: "T-200", visual_contract_refs: visIds }));
  }
  return {
    ...initialSnapshot(),
    tasks,
    tasks_based_on: { spec: frontmatter.spec_version },
  };
}

describe("specLockCheck — happy path (Slice 1.B sub-cycle 3b)", () => {
  test("ok=true when frontmatter + snapshot pass all 8 checks", () => {
    const fm = makeFrontmatter();
    const result = specLockCheck(snapshotCoveringFrontmatter(fm), fm);
    expect(result.ok).toBe(true);
  });

  test("ok=true with e2e scenario bound by task + visual contract bound by visual-ui task", () => {
    const fm = makeFrontmatter({
      scenarios: [
        {
          id: "SCEN-AUTH-E2E-001",
          name: "Expired token recovered",
          tag: "e2e",
          requires_acceptance: true,
          given: ["valid refresh token"],
          when: ["user opens orders"],
          then: ["system refreshes the access token"],
        },
      ],
      visual_contracts: [
        {
          id: "VIS-AUTH-001",
          target: "Login primary button during refresh",
          checks: ["shows spinner inside button"],
          requires_visual: true,
        },
      ],
    });
    const result = specLockCheck(snapshotCoveringFrontmatter(fm), fm);
    expect(result.ok).toBe(true);
  });
});

describe("specLockCheck check 2 — needs_clarification", () => {
  test("fails when needs_clarification has unresolved entries", () => {
    const fm = makeFrontmatter({
      needs_clarification: [
        { id: "NC-001", question: "should we support OAuth 2.1?" },
      ],
    });
    const result = specLockCheck(snapshotCoveringFrontmatter(fm), fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const check2 = result.checks.find((c) => c.check === 2);
      expect(check2?.code).toBe("SPEC_HAS_UNCLARIFIED");
    }
  });
});

describe("specLockCheck check 3 — tasks_based_on", () => {
  test("TASKS_NOT_PLANNED when snapshot.tasks_based_on is null", () => {
    const fm = makeFrontmatter();
    const result = specLockCheck(initialSnapshot(), fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const check3 = result.checks.find((c) => c.check === 3);
      expect(check3?.code).toBe("TASKS_NOT_PLANNED");
    }
  });

  test("TASKS_BASED_ON_STALE when version mismatches frontmatter", () => {
    const fm = makeFrontmatter({ spec_version: 3 });
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks_based_on: { spec: 2 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const check3 = result.checks.find((c) => c.check === 3);
      expect(check3?.code).toBe("TASKS_BASED_ON_STALE");
      expect(check3?.detail).toMatchObject({
        tasks_based_on_spec: 2,
        current_spec_version: 3,
      });
    }
  });

  test("check 3 null/stale SUPPRESSES checks 4/6/7 cascade (codex r26 constraint)", () => {
    // frontmatter has uncovered REQ + unbound e2e + unbound visual,
    // but tasks_based_on is null. Expected: only check 3 + (independent)
    // check 2/5 if those would otherwise trigger. No 4/6/7 noise.
    const fm = makeFrontmatter({
      requirements: [REQ_VERIFIABLE], // no task drives it
      scenarios: [
        {
          id: "SCEN-AUTH-E2E-001",
          name: "Expired token recovered",
          tag: "e2e",
          requires_acceptance: true,
          given: ["x"],
          when: ["y"],
          then: ["z"],
        },
      ],
      visual_contracts: [
        {
          id: "VIS-AUTH-001",
          target: "Login button",
          checks: ["spinner"],
        },
      ],
    });
    const result = specLockCheck(initialSnapshot(), fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.checks.find((c) => c.check === 3)?.code).toBe("TASKS_NOT_PLANNED");
      expect(result.checks.some((c) => c.check === 4)).toBe(false);
      expect(result.checks.some((c) => c.check === 6)).toBe(false);
      expect(result.checks.some((c) => c.check === 7)).toBe(false);
    }
  });

  test("check 3 stale also suppresses 4/6/7 cascade", () => {
    const fm = makeFrontmatter({ spec_version: 3, requirements: [REQ_VERIFIABLE] });
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks_based_on: { spec: 2 },
      // task graph has no driver for REQ-AUTH-001, but cascade is suppressed
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.checks.find((c) => c.check === 3)?.code).toBe("TASKS_BASED_ON_STALE");
      expect(result.checks.some((c) => c.check === 4)).toBe(false);
    }
  });
});

describe("specLockCheck check 4 — REQ_NOT_DRIVEN", () => {
  test("fails when a REQ has no task driving it", () => {
    const fm = makeFrontmatter({
      requirements: [REQ_VERIFIABLE, REQ_VERIFIABLE_2],
    });
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [behavioralTask({ drives: ["REQ-AUTH-001"] })], // REQ-AUTH-002 unbound
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const check4 = result.checks.find((c) => c.check === 4);
      expect(check4?.code).toBe("REQ_NOT_DRIVEN");
      expect(check4?.detail?.req_id).toBe("REQ-AUTH-002");
    }
  });

  test("accumulates check 4 failures across multiple uncovered REQs", () => {
    const fm = makeFrontmatter({ requirements: [REQ_VERIFIABLE, REQ_VERIFIABLE_2] });
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [behavioralTask({ drives: [] })],
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const check4Failures = result.checks.filter((c) => c.check === 4);
      expect(check4Failures.map((c) => c.detail?.req_id)).toEqual([
        "REQ-AUTH-001",
        "REQ-AUTH-002",
      ]);
    }
  });
});

describe("specLockCheck check 5 — MISSING_VERIFIABILITY (regression)", () => {
  test("fails on unverifiable REQ even with covered task graph", () => {
    const fm = makeFrontmatter({ requirements: [REQ_UNVERIFIABLE] });
    const result = specLockCheck(snapshotCoveringFrontmatter(fm), fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.checks.find((c) => c.check === 5)?.code).toBe("MISSING_VERIFIABILITY");
    }
  });
});

describe("specLockCheck check 6 — E2E_SCENARIO_UNBOUND", () => {
  const E2E_SCENARIO: SpecFrontmatter["scenarios"][number] = {
    id: "SCEN-AUTH-E2E-001",
    name: "Expired token recovered",
    tag: "e2e",
    requires_acceptance: true,
    given: ["x"],
    when: ["y"],
    then: ["z"],
  };

  test("passes when same task has requires_acceptance=true AND drives the scenario", () => {
    const fm = makeFrontmatter({ scenarios: [E2E_SCENARIO] });
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [
        behavioralTask({
          drives: ["REQ-AUTH-001", "SCEN-AUTH-E2E-001"],
          requires_acceptance: true,
        }),
      ],
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(true);
  });

  test("passes when scenario has acceptance_na (escape hatch)", () => {
    const fm = makeFrontmatter({
      scenarios: [{ ...E2E_SCENARIO, acceptance_na: "subjective validation only" }],
    });
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [behavioralTask({ drives: ["REQ-AUTH-001"] })],
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(true);
  });

  test("fails when task drives scenario but requires_acceptance is missing (strict conjunction)", () => {
    const fm = makeFrontmatter({ scenarios: [E2E_SCENARIO] });
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [behavioralTask({ drives: ["REQ-AUTH-001", "SCEN-AUTH-E2E-001"] })],
      // requires_acceptance NOT set
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.checks.find((c) => c.check === 6)?.code).toBe("E2E_SCENARIO_UNBOUND");
    }
  });

  test("fails when task has requires_acceptance but does not drive the scenario", () => {
    const fm = makeFrontmatter({ scenarios: [E2E_SCENARIO] });
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [
        behavioralTask({ drives: ["REQ-AUTH-001"], requires_acceptance: true }),
      ],
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.checks.find((c) => c.check === 6)?.code).toBe("E2E_SCENARIO_UNBOUND");
    }
  });

  test("non-e2e scenario does not require binding", () => {
    const fm = makeFrontmatter({
      scenarios: [{ ...E2E_SCENARIO, tag: "happy" }],
    });
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [behavioralTask({ drives: ["REQ-AUTH-001"] })],
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(true);
  });
});

describe("specLockCheck check 7 — VISUAL_CONTRACT_UNBOUND", () => {
  const VISUAL: NonNullable<SpecFrontmatter["visual_contracts"]>[number] = {
    id: "VIS-AUTH-001",
    target: "Login button during refresh",
    checks: ["shows spinner inside button"],
    requires_visual: true,
  };

  test("passes when a visual-ui task carries visual_contract_refs", () => {
    const fm = makeFrontmatter({ visual_contracts: [VISUAL] });
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [
        behavioralTask({ drives: ["REQ-AUTH-001"] }),
        visualUiTask({ visual_contract_refs: ["VIS-AUTH-001"] }),
      ],
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(true);
  });

  test("passes when visual_contract has visual_na escape hatch", () => {
    const fm = makeFrontmatter({
      visual_contracts: [{ ...VISUAL, visual_na: "deferred to manual QA" }],
    });
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [behavioralTask({ drives: ["REQ-AUTH-001"] })],
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(true);
  });

  test("fails when behavioral task has requires_visual=true but no visual-ui task binds (strict visual-ui only)", () => {
    const fm = makeFrontmatter({ visual_contracts: [VISUAL] });
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [
        behavioralTask({ drives: ["REQ-AUTH-001"], requires_visual: true }),
      ],
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.checks.find((c) => c.check === 7)?.code).toBe("VISUAL_CONTRACT_UNBOUND");
    }
  });
});

describe("specLockCheck check 8 — TASK_KIND_SCHEMA_VIOLATION", () => {
  test("behavioral with labels.bug missing red_test_registered fails", () => {
    const fm = makeFrontmatter();
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [
        behavioralTask({
          drives: ["REQ-AUTH-001"],
          labels: ["bug"],
          // red_test_registered missing
        }),
      ],
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const check8 = result.checks.find((c) => c.check === 8);
      expect(check8?.code).toBe("TASK_KIND_SCHEMA_VIOLATION");
      expect(check8?.detail?.task_id).toBe("T-001");
      expect(check8?.detail?.reasons).toEqual([
        "behavioral task with labels=['bug'] requires red_test_registered=true",
      ]);
    }
  });

  test("behavioral with labels.bug and red_test_registered=true passes", () => {
    const fm = makeFrontmatter();
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [
        behavioralTask({
          drives: ["REQ-AUTH-001"],
          labels: ["bug"],
          red_test_registered: true,
        }),
      ],
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(true);
  });

  test("structural without no_test_rationale fails", () => {
    const fm = makeFrontmatter();
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [
        behavioralTask({ drives: ["REQ-AUTH-001"] }),
        {
          id: "T-099",
          kind: "structural",
          status: "pending",
          steps: { implement: step("must"), refactor: step("optional") },
          drives: [],
          depends_on: [],
          labels: [],
          // no_test_rationale missing
        },
      ],
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const check8 = result.checks.find((c) => c.check === 8);
      expect(check8?.code).toBe("TASK_KIND_SCHEMA_VIOLATION");
      expect(check8?.detail?.task_id).toBe("T-099");
    }
  });

  test("visual-ui without visual_contract_refs fails", () => {
    const fm = makeFrontmatter();
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [
        behavioralTask({ drives: ["REQ-AUTH-001"] }),
        visualUiTask({ id: "T-200", visual_contract_refs: [] }), // empty
      ],
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const check8 = result.checks.find((c) => c.check === 8);
      expect(check8?.code).toBe("TASK_KIND_SCHEMA_VIOLATION");
      expect(check8?.detail?.task_id).toBe("T-200");
    }
  });

  test("multiple tasks with kind violations produce separate FailedCheck entries", () => {
    const fm = makeFrontmatter();
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [
        behavioralTask({
          id: "T-001",
          drives: ["REQ-AUTH-001"],
          labels: ["bug"],
        }),
        {
          id: "T-099",
          kind: "structural",
          status: "pending",
          steps: { implement: step("must"), refactor: step("optional") },
          drives: [],
          depends_on: [],
          labels: [],
        },
      ],
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const check8Failures = result.checks.filter((c) => c.check === 8);
      expect(check8Failures).toHaveLength(2);
      expect(check8Failures.map((c) => c.detail?.task_id).sort()).toEqual([
        "T-001",
        "T-099",
      ]);
    }
  });

  test("check 8 runs even when check 3 fails (orthogonal — migration hygiene)", () => {
    const fm = makeFrontmatter();
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [
        behavioralTask({
          drives: ["REQ-AUTH-001"],
          labels: ["bug"],
          // red_test_registered missing
        }),
      ],
      tasks_based_on: null, // check 3 will fail TASKS_NOT_PLANNED
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.checks.find((c) => c.check === 3)?.code).toBe("TASKS_NOT_PLANNED");
      expect(result.checks.find((c) => c.check === 8)?.code).toBe("TASK_KIND_SCHEMA_VIOLATION");
      // No cascade into 4/6/7
      expect(result.checks.some((c) => c.check === 4)).toBe(false);
    }
  });

  test("FailedCheck.detail.reasons is always an array (shape contract)", () => {
    const fm = makeFrontmatter();
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [
        behavioralTask({
          drives: ["REQ-AUTH-001"],
          labels: ["bug"],
        }),
      ],
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const check8 = result.checks.find((c) => c.check === 8);
      expect(Array.isArray(check8?.detail?.reasons)).toBe(true);
    }
  });
});

describe("specLockCheck — accumulation across checks", () => {
  test("check 2 + check 5 + task-graph failures coexist (no cascade when check 3 passes)", () => {
    const fm = makeFrontmatter({
      needs_clarification: [{ id: "NC-001", question: "OAuth 2.1?" }],
      requirements: [REQ_VERIFIABLE, REQ_UNVERIFIABLE],
    });
    const snap: Snapshot = {
      ...initialSnapshot(),
      tasks: [behavioralTask({ drives: [] })], // both REQs unbound for check 4
      tasks_based_on: { spec: 1 },
    };
    const result = specLockCheck(snap, fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const byCheck = result.checks.map((c) => c.check).sort();
      expect(byCheck).toContain(2);
      expect(byCheck).toContain(4);
      expect(byCheck).toContain(5);
    }
  });
});
