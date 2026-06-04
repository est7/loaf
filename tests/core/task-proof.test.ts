// L6 — evaluateTaskProof unit matrix. The kernel = done-task iteration +
// 3-clause evidence predicate (passing + covering + accepted-kind) + bug-RED +
// waiver-as-universal-escape. The POLICY (accepted kinds per task) is the
// variant: verify-accept is kind-UNIFORM, verify-min is kind-PER-task. These
// two policies MUST diverge on the same input (else it would collapse to a
// single hasProof — exactly the debt L6 removes).

import { describe, expect, test } from "vitest";

import {
  evaluateTaskProof,
  verifyAcceptPolicy,
  verifyMinPolicy,
  type TaskProofGap,
} from "../../src/core/gates/task-proof.js";
import { initialSnapshot, type Snapshot, type TaskState, type EvidenceState } from "../../src/core/reducer.js";

function task(id: string, kind: TaskState["kind"], overrides: Partial<TaskState> = {}): TaskState {
  return { id, kind, status: "done", steps: {}, drives: [], depends_on: [], labels: [], ...overrides };
}

function ev(
  id: string,
  kind: EvidenceState["kind"],
  covers: string[],
  result: EvidenceState["result"] = "passed",
): EvidenceState {
  return { id, kind, covers, actor: "human:dev@test.invalid", result };
}

function snap(tasks: TaskState[], evidence: EvidenceState[]): Snapshot {
  return { ...initialSnapshot(), tasks, evidence };
}

/** gaps for the single done task in a one-task snapshot under a policy. */
function gapsOf(t: TaskState, evidence: EvidenceState[], policy: typeof verifyMinPolicy): TaskProofGap[] {
  const findings = evaluateTaskProof(snap([t], evidence), policy);
  return findings.length === 0 ? [] : findings[0]!.gaps;
}

describe("evaluateTaskProof — evidence proof", () => {
  test("proven task (passing + covering + accepted kind) → no finding", () => {
    const findings = evaluateTaskProof(
      snap([task("T-001", "behavioral")], [ev("EV-1", "local-check", ["T-001"])]),
      verifyMinPolicy,
    );
    expect(findings).toEqual([]);
  });

  test("done task, no covering evidence → [no-passing-evidence]", () => {
    expect(gapsOf(task("T-001", "behavioral"), [], verifyMinPolicy)).toEqual(["no-passing-evidence"]);
  });

  test("evidence covers but result not passing → [no-passing-evidence]", () => {
    expect(
      gapsOf(task("T-001", "behavioral"), [ev("EV-1", "local-check", ["T-001"], "failed")], verifyMinPolicy),
    ).toEqual(["no-passing-evidence"]);
  });

  test("evidence covers, passing, but kind NOT accepted by policy → [no-passing-evidence]", () => {
    // task-summary is NOT in verify-min's behavioral accepted set (local-check only).
    expect(
      gapsOf(task("T-001", "behavioral"), [ev("EV-1", "task-summary", ["T-001"])], verifyMinPolicy),
    ).toEqual(["no-passing-evidence"]);
  });

  test("session-wide evidence (covers another task) does NOT prove this task", () => {
    expect(
      gapsOf(task("T-001", "behavioral"), [ev("EV-1", "local-check", ["T-999"])], verifyMinPolicy),
    ).toEqual(["no-passing-evidence"]);
  });

  test("non-done task is ignored entirely", () => {
    const findings = evaluateTaskProof(snap([task("T-001", "behavioral", { status: "pending" })], []), verifyMinPolicy);
    expect(findings).toEqual([]);
  });
});

describe("evaluateTaskProof — policy DIVERGENCE (the whole point of L6)", () => {
  test("behavioral + task-summary only: verify-min FAILS, verify-accept PASSES", () => {
    const t = task("T-001", "behavioral");
    const evidence = [ev("EV-1", "task-summary", ["T-001"])];
    // verify-min is kind-stricter — task-summary alone is not local-check.
    expect(gapsOf(t, evidence, verifyMinPolicy)).toEqual(["no-passing-evidence"]);
    // verify-accept's uniform allow-list includes task-summary.
    expect(gapsOf(t, evidence, verifyAcceptPolicy)).toEqual([]);
  });
});

describe("evaluateTaskProof — waiver is a universal escape", () => {
  test("waiver evidence proves a task under BOTH policies", () => {
    const t = task("T-001", "behavioral");
    const evidence = [ev("EV-1", "waiver", ["T-001"], "waived")];
    expect(gapsOf(t, evidence, verifyMinPolicy)).toEqual([]);
    expect(gapsOf(t, evidence, verifyAcceptPolicy)).toEqual([]);
  });

  test("verify-min acceptedKinds is waiver-free (waiver is evaluator-owned, not policy)", () => {
    expect(verifyMinPolicy.acceptedKinds(task("T-001", "behavioral"))).not.toContain("waiver");
    expect(verifyAcceptPolicy.acceptedKinds(task("T-001", "behavioral"))).not.toContain("waiver");
  });
});

describe("evaluateTaskProof — bug-RED gap", () => {
  const bug = (overrides: Partial<TaskState> = {}) =>
    task("T-001", "behavioral", { labels: ["bug"], ...overrides });

  test("behavioral bug, red unregistered, otherwise proven → [bug-red-unregistered] only", () => {
    expect(gapsOf(bug({ red_test_registered: false }), [ev("EV-1", "local-check", ["T-001"])], verifyMinPolicy)).toEqual([
      "bug-red-unregistered",
    ]);
  });

  test("behavioral bug, red unregistered, NO evidence → [no-passing-evidence, bug-red-unregistered] in that order", () => {
    // Fixed gap order mirrors verify-accept check 4's push order (evidence THEN bug-red).
    expect(gapsOf(bug({ red_test_registered: false }), [], verifyMinPolicy)).toEqual([
      "no-passing-evidence",
      "bug-red-unregistered",
    ]);
  });

  test("behavioral bug, red REGISTERED, proven → no finding", () => {
    expect(
      gapsOf(bug({ red_test_registered: true }), [ev("EV-1", "local-check", ["T-001"])], verifyMinPolicy),
    ).toEqual([]);
  });

  test("non-bug behavioral never raises bug-red gap even when red unregistered", () => {
    expect(gapsOf(task("T-001", "behavioral"), [ev("EV-1", "local-check", ["T-001"])], verifyMinPolicy)).toEqual([]);
  });
});

describe("evaluateTaskProof — snapshot iteration order preserved", () => {
  test("findings follow snapshot.tasks order (site2 early-exit depends on this)", () => {
    const findings = evaluateTaskProof(
      snap(
        [
          task("T-001", "behavioral"), // missing evidence
          task("T-002", "behavioral", { labels: ["bug"], red_test_registered: false }), // bug-red
        ],
        [],
      ),
      verifyMinPolicy,
    );
    expect(findings.map((f) => f.task.id)).toEqual(["T-001", "T-002"]);
  });
});
