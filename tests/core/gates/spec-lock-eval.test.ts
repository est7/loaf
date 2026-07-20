// spec-lock-eval — IO boundary tests for evaluateSpecLock(snapshot, featureDir).
//
// Ticket #12B keeps spec-lock's spec.md IO boundary for gate compatibility,
// while semantic checks run through the shared replay constructor. These tests
// pin the gate-only check-1 mapping and all eight check outputs.

import { describe, expect, test } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";

import { evaluateSpecLock } from "../../../src/core/gates/spec-lock-eval.js";
import { initialSnapshot } from "../../../src/core/reducer.js";
import type { Snapshot, TaskState } from "../../../src/core/reducer.js";
import type { SpecFrontmatter } from "../../../src/core/spec-schema.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-spec-lock-eval-"));
}

function specDesignSnapshot(): Snapshot {
  const base = initialSnapshot();
  return {
    ...base,
    state: {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "F-001",
      phase: "SPEC",
      sub_state: "SPEC.design",
      iteration: 1,
      spec_locked: false,
      verify_accepted: false,
      spec_version: 1,
      ceremony: {
        spec_phase: true,
        verify_phase: true,
        settle_phase: false,
        strict_spec_review: false,
        lessons_required: "skip",
        strict_drift_check: false,
      },
    },
  };
}

const VERIFIABLE_REQ: SpecFrontmatter["requirements"][number] = {
  id: "REQ-AUTH-001",
  type: "event-driven",
  trigger: "an API request returns 401",
  response: "the system shall refresh the access token before surfacing failure",
  verified_by_scenarios: ["SCEN-AUTH-E2E-001"],
};

function frontmatter(overrides: Partial<SpecFrontmatter> = {}): SpecFrontmatter {
  return {
    schema_version: 2,
    spec_version: 1,
    feature: { id: "F-001", name: "OAuth token refresh" },
    intent: "users should not perceive auth recovery flows in flight",
    adr_refs: [],
    requirements: [VERIFIABLE_REQ],
    scenarios: [],
    visual_contracts: [],
    needs_clarification: [],
    ...overrides,
  };
}

function step(applicability: "must" | "optional" | "na") {
  return { applicability, status: "pending" as const };
}

function behavioralTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "T-001",
    kind: "behavioral",
    status: "pending",
    steps: { red: step("must"), implement: step("must"), refactor: step("optional") },
    drives: ["REQ-AUTH-001"],
    depends_on: [],
    labels: [],
    ...overrides,
  };
}

function replaySnapshot(fm: SpecFrontmatter, overrides: Partial<Snapshot> = {}): Snapshot {
  const base = specDesignSnapshot();
  return {
    ...base,
    spec_header: {
      feature: fm.feature,
      intent: fm.intent,
      adr_refs: fm.adr_refs,
      needs_clarification: fm.needs_clarification,
    },
    requirements: fm.requirements,
    scenarios: fm.scenarios,
    visual_contracts: fm.visual_contracts ?? [],
    tasks: [behavioralTask()],
    tasks_based_on: { spec: fm.spec_version },
    ...overrides,
  };
}

async function writeSpecFrontmatter(dir: string, fm: SpecFrontmatter): Promise<void> {
  await fs.writeFile(path.join(dir, "spec.md"), `---\n${yamlStringify(fm)}---\n`);
}

describe("evaluateSpecLock — gate IO boundary mapping", () => {
  test("SPEC_NOT_FOUND → check:1 FailedCheck with subcode detail", async () => {
    const dir = await tmpFeatureDir();
    // No spec.md created.
    const result = await evaluateSpecLock(specDesignSnapshot(), dir);
    const specPath = path.join(dir, "spec.md");
    expect(result).toEqual({
      ok: false,
      checks: [
        {
          check: 1,
          code: "SPEC_FRONTMATTER_INVALID",
          message: `spec.md not found at ${specPath}`,
          detail: { subcode: "SPEC_NOT_FOUND", path: specPath },
        },
      ],
    });
  });

  test("SPEC_YAML_INVALID → check:1 FailedCheck preserves subcode", async () => {
    const dir = await tmpFeatureDir();
    await fs.writeFile(path.join(dir, "spec.md"), "---\n[: bogus yaml :]\n---\n");
    const result = await evaluateSpecLock(specDesignSnapshot(), dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.checks[0]!.code).toBe("SPEC_FRONTMATTER_INVALID");
    expect(result.checks[0]!.detail?.subcode).toBe("SPEC_YAML_INVALID");
  });

  test("SPEC_FRONTMATTER_INVALID (schema-invalid) → check:1 preserves subcode", async () => {
    const dir = await tmpFeatureDir();
    await fs.writeFile(
      path.join(dir, "spec.md"),
      "---\nschema_version: 99\nspec_version: 1\n---\n",
    );
    const result = await evaluateSpecLock(specDesignSnapshot(), dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.checks[0]!.code).toBe("SPEC_FRONTMATTER_INVALID");
    expect(result.checks[0]!.detail?.subcode).toBe("SPEC_FRONTMATTER_INVALID");
  });
});

describe("evaluateSpecLock — eight-check characterization before replay-input extraction", () => {
  test("clean replay returns the exact pass shape", async () => {
    const dir = await tmpFeatureDir();
    const fm = frontmatter();
    await writeSpecFrontmatter(dir, fm);

    await expect(evaluateSpecLock(replaySnapshot(fm), dir)).resolves.toEqual({ ok: true });
  });

  test("check 3 failure has the exact shape and suppresses checks 4, 6, and 7", async () => {
    const dir = await tmpFeatureDir();
    const fm = frontmatter();
    await writeSpecFrontmatter(dir, fm);

    await expect(
      evaluateSpecLock(replaySnapshot(fm, { tasks_based_on: null }), dir),
    ).resolves.toEqual({
      ok: false,
      checks: [
        {
          check: 3,
          code: "TASKS_NOT_PLANNED",
          message:
            "tasks have not been planned yet; spec-lock requires a task graph (tasks_based_on=null in snapshot)",
        },
      ],
    });
  });

  test("checks 2, 4, 5, 6, 7, and 8 retain exact failure ordering and shapes", async () => {
    const dir = await tmpFeatureDir();
    const unverifiableReq: SpecFrontmatter["requirements"][number] = {
      id: "REQ-AUTH-099",
      type: "ubiquitous",
      response: "the system shall provide reasonable behavior here",
    };
    const fm = frontmatter({
      requirements: [unverifiableReq],
      scenarios: [
        {
          id: "SCEN-AUTH-E2E-001",
          name: "Expired token recovered",
          tag: "e2e",
          requires_acceptance: true,
          given: ["a valid refresh token"],
          when: ["the user opens orders"],
          then: ["the access token is refreshed"],
        },
      ],
      visual_contracts: [
        {
          id: "VIS-AUTH-001",
          target: "Login button during refresh",
          checks: ["shows a spinner"],
          requires_visual: true,
        },
      ],
      needs_clarification: [{ id: "NC-001", question: "should OAuth 2.1 be required?" }],
    });
    const invalidVisualTask: TaskState = {
      id: "T-200",
      kind: "visual-ui",
      status: "pending",
      steps: {
        mockup: step("must"),
        implement: step("must"),
        "screenshot-compare": step("must"),
      },
      drives: [],
      depends_on: [],
      labels: [],
      visual_contract_refs: [],
    };
    await writeSpecFrontmatter(dir, fm);

    await expect(
      evaluateSpecLock(replaySnapshot(fm, { tasks: [invalidVisualTask] }), dir),
    ).resolves.toEqual({
      ok: false,
      checks: [
        {
          check: 2,
          code: "SPEC_HAS_UNCLARIFIED",
          message:
            "spec has 1 unresolved needs_clarification entries; resolve or remove them before spec-lock",
          detail: { count: 1, ids: ["NC-001"] },
        },
        {
          check: 4,
          code: "REQ_NOT_DRIVEN",
          message:
            "REQ-AUTH-099 is not referenced by any task.drives[]; add a task that drives this requirement before spec-lock",
          detail: { req_id: "REQ-AUTH-099" },
        },
        {
          check: 5,
          code: "MISSING_VERIFIABILITY",
          message:
            "REQ-AUTH-099 must declare measurable, verified_by_scenarios[], or acceptance_na+acceptance_na_reason (≥10 chars)",
          detail: { req_id: "REQ-AUTH-099", req_type: "ubiquitous" },
        },
        {
          check: 6,
          code: "E2E_SCENARIO_UNBOUND",
          message:
            "e2e scenario SCEN-AUTH-E2E-001 has no binding task (requires_acceptance=true AND drives includes SCEN-AUTH-E2E-001); either add a binding task or mark scenario with acceptance_na+reason",
          detail: { scenario_id: "SCEN-AUTH-E2E-001" },
        },
        {
          check: 7,
          code: "VISUAL_CONTRACT_UNBOUND",
          message:
            "visual_contract VIS-AUTH-001 has no visual-ui task with visual_contract_refs containing it; add a binding visual-ui task or mark contract with visual_na+reason",
          detail: { visual_id: "VIS-AUTH-001" },
        },
        {
          check: 8,
          code: "TASK_KIND_SCHEMA_VIOLATION",
          message:
            "task T-200 (kind=visual-ui) violates projected kind-specific obligations: visual-ui task requires visual_contract_refs[] with ≥1 entry",
          detail: {
            task_id: "T-200",
            kind: "visual-ui",
            reasons: ["visual-ui task requires visual_contract_refs[] with ≥1 entry"],
          },
        },
      ],
    });
  });
});
