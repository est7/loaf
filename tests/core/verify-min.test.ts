// Phase v0.1.1 — verify-min deliver gate (§3.2) preflight matrix.
//
// quick/light `loaf deliver` from EXECUTE.done runs verify-min: per done
// task, require the per-kind evidence COVERING it (codex Q2 lock):
//   behavioral / structural → local-check  (task-summary alone is NOT enough)
//   visual-ui               → visual-review | manual
//   docs                    → task-summary | manual
//   chore                   → local-check | manual | task-summary
//   waiver always satisfies; spike is hard-blocked upstream.

import { describe, expect, test } from "vitest";

import { preflight } from "../../src/core/reducer/preflight.js";
import { initialSnapshot, type Snapshot, type TaskState, type EvidenceState } from "../../src/core/reducer.js";
import type { Ceremony } from "../../src/core/journal-entry.js";

const QUICK: Ceremony = {
  spec_phase: false,
  verify_phase: false,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

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
  return {
    ...initialSnapshot(),
    state: {
      session_id: "s", feature: "f", phase: "EXECUTE", sub_state: "EXECUTE.done",
      iteration: 1, spec_locked: true, verify_accepted: false, spec_version: 1, ceremony: QUICK,
    },
    tasks,
    evidence,
  };
}

const deliverEntry = () => ({
  seq: 0, entry_id: "JE-000001", at: "2026-05-15T10:00:00.000Z",
  actor: "human:dev@test.invalid", entry_schema_version: 1,
  kind: "session:delivered", payload: { reason: "ship it now (verify-min)" },
}) as never;

function run(s: Snapshot) {
  return preflight(deliverEntry(), { snapshot: s, tail_seq: -1 });
}

describe("verify-min — per-task required evidence (§3.2)", () => {
  test("behavioral done + local-check covering → pass", () => {
    expect(run(snap([task("T-001", "behavioral")], [ev("EV-1", "local-check", ["T-001"])])).ok).toBe(true);
  });

  test("behavioral done + NO evidence → DELIVER_VERIFY_MIN_INCOMPLETE", () => {
    const r = run(snap([task("T-001", "behavioral")], []));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DELIVER_VERIFY_MIN_INCOMPLETE");
  });

  test("behavioral done + task-summary ONLY (no local-check) → INCOMPLETE (strict)", () => {
    const r = run(snap([task("T-001", "behavioral")], [ev("EV-1", "task-summary", ["T-001"])]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DELIVER_VERIFY_MIN_INCOMPLETE");
  });

  test("structural done + local-check → pass", () => {
    expect(run(snap([task("T-001", "structural")], [ev("EV-1", "local-check", ["T-001"])])).ok).toBe(true);
  });

  test("visual-ui done + local-check ONLY (no visual) → INCOMPLETE", () => {
    const r = run(snap([task("T-001", "visual-ui")], [ev("EV-1", "local-check", ["T-001"])]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DELIVER_VERIFY_MIN_INCOMPLETE");
  });

  test("visual-ui done + visual-review → pass", () => {
    expect(run(snap([task("T-001", "visual-ui")], [ev("EV-1", "visual-review", ["T-001"])])).ok).toBe(true);
  });

  test("visual-ui done + manual → pass", () => {
    expect(run(snap([task("T-001", "visual-ui")], [ev("EV-1", "manual", ["T-001"])])).ok).toBe(true);
  });

  test("docs done + task-summary → pass; docs + local-check only → INCOMPLETE", () => {
    expect(run(snap([task("T-001", "docs")], [ev("EV-1", "task-summary", ["T-001"])])).ok).toBe(true);
    expect(run(snap([task("T-001", "docs")], [ev("EV-1", "local-check", ["T-001"])])).ok).toBe(false);
  });

  test("chore done + local-check → pass", () => {
    expect(run(snap([task("T-001", "chore")], [ev("EV-1", "local-check", ["T-001"])])).ok).toBe(true);
  });

  test("waiver covering any kind → pass (human escape)", () => {
    expect(run(snap([task("T-001", "behavioral")], [ev("EV-1", "waiver", ["T-001"], "waived")])).ok).toBe(true);
  });

  test.each([
    {
      label: "behavioral local-check failed",
      taskKind: "behavioral",
      evidenceKind: "local-check",
      result: "failed",
    },
    {
      label: "behavioral local-check rejected",
      taskKind: "behavioral",
      evidenceKind: "local-check",
      result: "rejected",
    },
    {
      label: "visual-ui manual failed",
      taskKind: "visual-ui",
      evidenceKind: "manual",
      result: "failed",
    },
    {
      label: "visual-ui manual rejected",
      taskKind: "visual-ui",
      evidenceKind: "manual",
      result: "rejected",
    },
    {
      label: "visual-ui visual-review failed",
      taskKind: "visual-ui",
      evidenceKind: "visual-review",
      result: "failed",
    },
    {
      label: "visual-ui visual-review rejected",
      taskKind: "visual-ui",
      evidenceKind: "visual-review",
      result: "rejected",
    },
    {
      label: "behavioral waiver failed",
      taskKind: "behavioral",
      evidenceKind: "waiver",
      result: "failed",
    },
    {
      label: "behavioral waiver rejected",
      taskKind: "behavioral",
      evidenceKind: "waiver",
      result: "rejected",
    },
  ] as const)(
    "$label → DELIVER_VERIFY_MIN_INCOMPLETE",
    ({ taskKind, evidenceKind, result }) => {
      const r = run(snap(
        [task("T-001", taskKind)],
        [ev("EV-1", evidenceKind, ["T-001"], result)],
      ));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("DELIVER_VERIFY_MIN_INCOMPLETE");
    },
  );

  test("unsupported na-like evidence result does not satisfy verify-min", () => {
    const r = run(snap(
      [task("T-001", "behavioral")],
      [ev("EV-1", "local-check", ["T-001"], "na" as EvidenceState["result"])],
    ));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DELIVER_VERIFY_MIN_INCOMPLETE");
  });

  test("evidence covering a DIFFERENT task does NOT satisfy → INCOMPLETE", () => {
    const r = run(snap([task("T-001", "behavioral")], [ev("EV-1", "local-check", ["T-999"])]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DELIVER_VERIFY_MIN_INCOMPLETE");
  });

  test("abandoned task is skipped (no evidence needed)", () => {
    expect(run(snap([task("T-001", "behavioral", { status: "abandoned" })], [])).ok).toBe(true);
  });

  test("no tasks → vacuous pass", () => {
    expect(run(snap([], [])).ok).toBe(true);
  });

  test("behavioral bug done + RED not registered → BUG_TASK_RED_NOT_REGISTERED (not generic)", () => {
    const r = run(snap(
      [task("T-001", "behavioral", { labels: ["bug"], red_test_registered: false })],
      [ev("EV-1", "local-check", ["T-001"])],
    ));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BUG_TASK_RED_NOT_REGISTERED");
  });

  test("behavioral bug done + RED registered + local-check → pass", () => {
    expect(run(snap(
      [task("T-001", "behavioral", { labels: ["bug"], red_test_registered: true })],
      [ev("EV-1", "local-check", ["T-001"])],
    )).ok).toBe(true);
  });
});
