// E2E — full worker lifecycle driven purely through the CLI.
//
// task_plan.md §15 done-when 1+2: a feature must run start -> deliver
// end-to-end through `loaf` commands. Existing cli.test.ts seed helpers
// cheat — they emit `event:phase_advanced` via raw mutate and only use the
// CLI for tasks. This file uses ONLY runCli for every transition, so it is
// the first true integration proof of the worker workflow.
//
// Scenario inventory: docs/e2e-scenarios.md. This file implements the
// §15-close set (001-004) and the full inventory tier
// (005/006/007/009/014/015/019/024/025/026/031). Remaining: optional ×9
// + future ×6, which land as their command / back-edge slices ship.
//
// Smoke methodology: a failed `step()` throws with the step label, so the
// first gap is named precisely. Gaps get fixed sub-cycle by sub-cycle.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-e2e-"));
}

async function runCli(
  argv: string[],
  opts: { env?: Record<string, string | undefined> } = {},
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const envBackup: Record<string, string | undefined> = {};
  if (opts.env) {
    for (const k of Object.keys(opts.env)) {
      envBackup[k] = process.env[k];
      const v = opts.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await main(["node", "loaf", ...argv]);
    return { exit, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
    for (const k of Object.keys(envBackup)) {
      const prev = envBackup[k];
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

// Per-feature CLI driver. `step` runs a `loaf` command (always --format json, env
// injected) and throws a labelled error on non-zero exit so the failing
// scenario step is unambiguous; it returns parsed JSON stdout (or null).
// `writeInput` writes a JSON input file into the feature dir.
function makeCli(dir: string, env: Record<string, string | undefined>) {
  const step = async (label: string, argv: string[]): Promise<any> => {
    const r = await runCli([...argv, "--feature-dir", dir, "--format", "json"], { env });
    if (r.exit !== 0) {
      throw new Error(
        `STEP FAILED [${label}]: exit ${r.exit}\n` +
          `  argv: ${argv.join(" ")}\n` +
          `  stderr: ${r.stderr.trim()}\n` +
          `  stdout: ${r.stdout.trim()}`,
      );
    }
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  const writeInput = async (name: string, payload: unknown): Promise<string> => {
    const p = path.join(dir, name);
    await fs.writeFile(p, JSON.stringify(payload, null, 2));
    return p;
  };
  return { step, writeInput };
}

// Drives a standard-ceremony behavioral feature from `start` to VERIFY.accept:
// one acceptance_na REQ, one behavioral task taken through red + implement,
// the run + review evidence in place. The verify-accept gate is left
// undecided so callers can exercise approve / reject / settle from here.
// Used by scenarios that only differ in what happens AT VERIFY.accept.
async function seedToVerifyAccept(
  cli: ReturnType<typeof makeCli>,
  F: string,
  name: string,
  intent: string,
): Promise<void> {
  const { step, writeInput } = cli;
  await step("start", ["start", F, "--ceremony", "standard"]);
  await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
  await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
  await step("spec init", ["spec", "init", "--feature", F]);
  const submitInput = await writeInput("submit.json", {
    feature: { id: "F-001", name },
    intent,
    adr_refs: [],
    needs_clarification: [],
  });
  await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
  const reqInput = await writeInput("req.json", {
    id_namespace: "REQ-CORE",
    type: "ubiquitous",
    response: "the system shall complete the worker lifecycle smoke",
    acceptance_na: true,
    acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
  });
  await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
  await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
  await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
  await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
  const st = await step("status pre-tasks", ["status", "--feature", F]);
  const specVersion: number = st.state?.spec_version ?? st.spec_version;
  const tasksFile = await writeInput("tasks.json", {
    based_on: { spec: specVersion },
    tasks: [
      {
        id: "T-001",
        kind: "behavioral",
        drives: ["REQ-CORE-001"],
        tests: ["e2e.smoke"],
        status: "pending",
        depends_on: [],
        labels: [],
        execution: {
          red: { applicability: "must", status: "pending", evidence_refs: [] },
          implement: { applicability: "must", status: "pending", evidence_refs: [] },
          refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
        },
      },
    ],
  });
  await step("tasks submit", ["tasks", "submit", "--input", tasksFile, "--feature", F]);
  await step("gate spec-lock", [
    "gate", "decide", "spec-lock", "--approve",
    "--reason", "spec and task graph complete", "--feature", F,
  ]);
  await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);
  await step("tasks claim T-001", ["tasks", "claim", "T-001", "--feature", F]);
  for (const stp of ["red", "implement"]) {
    await step(`step start ${stp}`, [
      "tasks", "step", "start", "--task", "T-001", "--step", stp, "--feature", F,
    ]);
    await step(`step done ${stp}`, [
      "tasks", "step", "done", "--task", "T-001", "--step", stp, "--feature", F,
    ]);
  }
  await step("advance EXECUTE.done", ["advance", "EXECUTE.done", "--feature", F]);
  for (const ss of [
    "VERIFY.plan", "VERIFY.run", "VERIFY.review",
    "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept",
  ]) {
    await step(`advance ${ss}`, ["advance", ss, "--feature", F]);
  }
  const tsEvidence = await writeInput("ev-task-summary.json", {
    kind: "task-summary", iteration: 1, actor: "cli:loaf", result: "passed",
    summary: "unit tests pass for T-001", task_id: "T-001", covers: ["T-001"],
    cmd: "bun test", exit: 0,
  });
  await step("evidence add task-summary", ["evidence", "add", "--input", tsEvidence, "--feature", F]);
  const vrEvidence = await writeInput("ev-verify-review.json", {
    kind: "verify-review", iteration: 1, actor: "cli:loaf", result: "approved",
    summary: "spec-fit review passed", check: "review", covers: ["REQ-CORE-001"],
  });
  await step("evidence add verify-review", ["evidence", "add", "--input", vrEvidence, "--feature", F]);
}

// These scenarios drive 20-30 real `loaf` CLI subprocesses each. Phase 15
// SC2 added mutate step 8 — every mutation re-serializes the five
// snapshots/*.json projection files + _meta.json — so each subprocess does
// more fsync'd I/O. Under the full parallel `tests/core` run the longest
// lifecycle walks exceed the default 5s per-test timeout; 30s gives ample
// headroom (each test runs ~1-3s in isolation).
describe("E2E — full worker lifecycle (standard ceremony)", { timeout: 30_000 }, () => {
  // SCEN-E2E-001 — see docs/e2e-scenarios.md
  test("SCEN-E2E-001 — standard feature runs start -> deliver via the CLI", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-std";
    const ENV = { LOAF_USER: "e2e@test.invalid" };

    const { step, writeInput } = makeCli(dir, ENV);

    // ── TRIAGE ──────────────────────────────────────────────────────────
    const started = await step("start", ["start", F, "--ceremony", "standard"]);
    expect(started.sub_state).toBe("TRIAGE.score");
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);

    // ── SPEC content ────────────────────────────────────────────────────
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E standard lifecycle" },
      intent: "drive the worker lifecycle start to deliver through the CLI",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the worker lifecycle smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);

    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);

    // ── tasks plan (based_on.spec must equal the live spec_version) ──────
    const st = await step("status pre-tasks", ["status", "--feature", F]);
    const specVersion: number = st.state?.spec_version ?? st.spec_version;
    const tasksFile = await writeInput("tasks.json", {
      based_on: { spec: specVersion },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          drives: ["REQ-CORE-001"],
          tests: ["e2e.lifecycleSmoke"],
          status: "pending",
          depends_on: [],
          labels: [],
          execution: {
            red: { applicability: "must", status: "pending", evidence_refs: [] },
            implement: { applicability: "must", status: "pending", evidence_refs: [] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        },
      ],
    });
    await step("tasks submit", ["tasks", "submit", "--input", tasksFile, "--feature", F]);

    // ── gate spec-lock (flips spec_locked; does NOT move cursor) ─────────
    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "all spec-lock checks pass for the smoke feature",
      "--feature", F,
    ]);

    // ── EXECUTE ─────────────────────────────────────────────────────────
    // The spec-lock gate co-emits the SPEC.design -> EXECUTE.plan
    // phase_advanced in its batch, so the cursor is already at EXECUTE.plan
    // here (unlike the verify-accept gate, which does not move the cursor).
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);
    await step("tasks claim T-001", ["tasks", "claim", "T-001", "--feature", F]);
    // Only the `must` steps are driven: once red + implement are terminal,
    // the task auto-promotes to status=done (refactor is optional and never
    // runs — a step done after the last must-step cannot reopen the task).
    for (const stp of ["red", "implement"]) {
      await step(`tasks step start ${stp}`, [
        "tasks", "step", "start", "--task", "T-001", "--step", stp, "--feature", F,
      ]);
      await step(`tasks step done ${stp}`, [
        "tasks", "step", "done", "--task", "T-001", "--step", stp, "--feature", F,
      ]);
    }
    await step("advance EXECUTE.done", ["advance", "EXECUTE.done", "--feature", F]);

    // ── VERIFY ──────────────────────────────────────────────────────────
    for (const ss of [
      "VERIFY.plan", "VERIFY.run", "VERIFY.review",
      "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept",
    ]) {
      await step(`advance ${ss}`, ["advance", ss, "--feature", F]);
    }

    // Evidence for the verify-accept gate's 5 checks: the task-summary
    // satisfies check 4 (done task T-001 needs covering evidence) and
    // lane=run; the verify-review satisfies lane=review. Coverage check 3
    // skips REQ-CORE-001 (acceptance_na); check 5 is off for standard
    // ceremony (strict_spec_review=false).
    const tsEvidence = await writeInput("ev-task-summary.json", {
      kind: "task-summary",
      iteration: 1,
      actor: "cli:loaf",
      result: "passed",
      summary: "unit tests pass for T-001",
      task_id: "T-001",
      covers: ["T-001"],
      cmd: "bun test",
      exit: 0,
    });
    await step("evidence add task-summary", ["evidence", "add", "--input", tsEvidence, "--feature", F]);
    const vrEvidence = await writeInput("ev-verify-review.json", {
      kind: "verify-review",
      iteration: 1,
      actor: "cli:loaf",
      result: "approved",
      summary: "spec-fit review passed; no anti-pattern",
      check: "review",
      covers: ["REQ-CORE-001"],
    });
    await step("evidence add verify-review", ["evidence", "add", "--input", vrEvidence, "--feature", F]);

    await step("gate verify-accept", [
      "gate", "decide", "verify-accept", "--approve",
      "--reason", "all verify-accept checks pass for the smoke feature",
      "--feature", F,
    ]);

    // ── DELIVER ─────────────────────────────────────────────────────────
    const delivered = await step("deliver", ["deliver", "--feature", F]);
    expect(delivered.sub_state ?? delivered.state?.sub_state).toBe("DONE.delivered");
  });

  // SCEN-E2E-002 — see docs/e2e-scenarios.md (absorbs SCEN-010/017/018/029)
  test("SCEN-E2E-002 — standard structural + DAG built via tasks add", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-struct";
    const ENV = { LOAF_USER: "e2e@test.invalid" };

    const { step, writeInput } = makeCli(dir, ENV);

    // ── TRIAGE + SPEC ───────────────────────────────────────────────────
    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E structural DAG" },
      intent: "drive a structural-task DAG built incrementally via tasks add",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the structural DAG lifecycle smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);

    // ── tasks add — build the graph incrementally (no tasks submit) ──────
    const t1 = await writeInput("task1.json", {
      kind: "structural",
      drives: ["REQ-CORE-001"],
      no_test_rationale: "rename the internal token module; no behavior change",
    });
    await step("tasks add T-001", ["tasks", "add", "--input", t1, "--feature", F]);
    const t2 = await writeInput("task2.json", {
      kind: "structural",
      no_test_rationale: "extract a shared helper once T-001 lands; no behavior change",
      depends_on: ["T-001"],
    });
    await step("tasks add T-002", ["tasks", "add", "--input", t2, "--feature", F]);

    // ── gate spec-lock → EXECUTE.plan ───────────────────────────────────
    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "structural DAG feature passes spec-lock", "--feature", F,
    ]);

    // ── tasks amend --policy at EXECUTE.plan: narrow refactor must -> na ─
    // tasks add materializes every step at applicability=must; structural
    // refactor is narrowed to na so the task auto-promotes after implement.
    await step("tasks amend T-001", ["tasks", "amend", "T-001", "--policy", "refactor=na", "--feature", F]);
    await step("tasks amend T-002", ["tasks", "amend", "T-002", "--policy", "refactor=na", "--feature", F]);

    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);

    // ── DAG readiness: T-002 depends_on T-001 ───────────────────────────
    const next1 = await step("tasks next (pre)", ["tasks", "next", "--feature", F]);
    expect(JSON.stringify(next1)).toContain("T-001");
    expect(JSON.stringify(next1)).not.toContain("T-002");

    await step("tasks claim T-001", ["tasks", "claim", "T-001", "--feature", F]);
    await step("step start implement T-001", [
      "tasks", "step", "start", "--task", "T-001", "--step", "implement", "--feature", F,
    ]);
    await step("step done implement T-001", [
      "tasks", "step", "done", "--task", "T-001", "--step", "implement", "--feature", F,
    ]);

    const next2 = await step("tasks next (post)", ["tasks", "next", "--feature", F]);
    expect(JSON.stringify(next2)).toContain("T-002");

    await step("tasks claim T-002", ["tasks", "claim", "T-002", "--feature", F]);
    await step("step start implement T-002", [
      "tasks", "step", "start", "--task", "T-002", "--step", "implement", "--feature", F,
    ]);
    await step("step done implement T-002", [
      "tasks", "step", "done", "--task", "T-002", "--step", "implement", "--feature", F,
    ]);

    await step("advance EXECUTE.done", ["advance", "EXECUTE.done", "--feature", F]);

    // ── VERIFY ──────────────────────────────────────────────────────────
    for (const ss of [
      "VERIFY.plan", "VERIFY.run", "VERIFY.review",
      "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept",
    ]) {
      await step(`advance ${ss}`, ["advance", ss, "--feature", F]);
    }
    const tsEvidence = await writeInput("ev-task-summary.json", {
      kind: "task-summary",
      iteration: 1,
      actor: "cli:loaf",
      result: "passed",
      summary: "structural changes verified for T-001 and T-002",
      task_id: "T-001",
      covers: ["T-001", "T-002"],
      cmd: "bun test",
      exit: 0,
    });
    await step("evidence add task-summary", ["evidence", "add", "--input", tsEvidence, "--feature", F]);
    const vrEvidence = await writeInput("ev-verify-review.json", {
      kind: "verify-review",
      iteration: 1,
      actor: "cli:loaf",
      result: "approved",
      summary: "spec-fit review passed; no anti-pattern",
      check: "review",
      covers: ["REQ-CORE-001"],
    });
    await step("evidence add verify-review", ["evidence", "add", "--input", vrEvidence, "--feature", F]);

    await step("gate verify-accept", [
      "gate", "decide", "verify-accept", "--approve",
      "--reason", "all verify-accept checks pass for the structural DAG feature",
      "--feature", F,
    ]);
    const delivered = await step("deliver", ["deliver", "--feature", F]);
    expect(delivered.sub_state ?? delivered.state?.sub_state).toBe("DONE.delivered");
  });

  // SCEN-E2E-003 — see docs/e2e-scenarios.md (absorbs SCEN-011/012/013)
  test("SCEN-E2E-003 — standard visual-ui + docs + chore mixed kinds", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-mixed";
    const ENV = { LOAF_USER: "e2e@test.invalid" };

    const { step, writeInput } = makeCli(dir, ENV);

    // ── TRIAGE + SPEC content (add-req + add-scenario + add-visual) ──────
    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E mixed task kinds" },
      intent: "drive visual-ui, docs and chore task kinds end-to-end via the CLI",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the mixed-kind lifecycle smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
    const scenInput = await writeInput("scen.json", {
      id_namespace: "SCEN-CORE",
      name: "mixed-kind feature delivers",
      tag: "happy",
      given: ["a feature with visual-ui, docs and chore tasks"],
      when: ["every task step ladder completes"],
      then: ["verify-accept and deliver succeed"],
    });
    await step("spec add-scenario", ["spec", "add-scenario", "--input", scenInput, "--feature", F]);
    const visInput = await writeInput("vis.json", {
      id_namespace: "VIS-CORE",
      target: "the primary screen layout",
      checks: ["renders the header", "renders the content region"],
    });
    await step("spec add-visual", ["spec", "add-visual", "--input", visInput, "--feature", F]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);

    // ── tasks add — visual-ui + docs + chore ────────────────────────────
    const tVisual = await writeInput("task-visual.json", {
      kind: "visual-ui",
      visual_contract_refs: ["VIS-CORE-001"],
      drives: ["REQ-CORE-001"],
      no_test_rationale: "visual parity is verified by screenshot comparison, not unit tests",
    });
    await step("tasks add visual-ui", ["tasks", "add", "--input", tVisual, "--feature", F]);
    const tDocs = await writeInput("task-docs.json", {
      kind: "docs",
      no_test_rationale: "documentation task; correctness is verified by peer review",
    });
    await step("tasks add docs", ["tasks", "add", "--input", tDocs, "--feature", F]);
    const tChore = await writeInput("task-chore.json", {
      kind: "chore",
      no_test_rationale: "mechanical chore; no behavior change to test",
    });
    await step("tasks add chore", ["tasks", "add", "--input", tChore, "--feature", F]);

    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "mixed-kind feature passes spec-lock", "--feature", F,
    ]);
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);

    // ── EXECUTE — each kind's step ladder ───────────────────────────────
    const ladders: Array<[string, string[]]> = [
      ["T-001", ["mockup", "implement", "screenshot-compare"]],
      ["T-002", ["draft", "review"]],
      ["T-003", ["execute"]],
    ];
    for (const [task, steps] of ladders) {
      await step(`tasks claim ${task}`, ["tasks", "claim", task, "--feature", F]);
      for (const stp of steps) {
        await step(`step start ${task} ${stp}`, [
          "tasks", "step", "start", "--task", task, "--step", stp, "--feature", F,
        ]);
        await step(`step done ${task} ${stp}`, [
          "tasks", "step", "done", "--task", task, "--step", stp, "--feature", F,
        ]);
      }
    }
    await step("advance EXECUTE.done", ["advance", "EXECUTE.done", "--feature", F]);

    // ── VERIFY ──────────────────────────────────────────────────────────
    for (const ss of [
      "VERIFY.plan", "VERIFY.run", "VERIFY.review",
      "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept",
    ]) {
      await step(`advance ${ss}`, ["advance", ss, "--feature", F]);
    }
    // task-summary → check 4 (3 done tasks) + lane=run; verify-review →
    // lane=review; visual-review → lane=visual + check 3 (VIS-CORE-001).
    const tsEvidence = await writeInput("ev-task-summary.json", {
      kind: "task-summary",
      iteration: 1,
      actor: "cli:loaf",
      result: "passed",
      summary: "all mixed-kind tasks verified",
      task_id: "T-001",
      covers: ["T-001", "T-002", "T-003"],
      cmd: "bun test",
      exit: 0,
    });
    await step("evidence add task-summary", ["evidence", "add", "--input", tsEvidence, "--feature", F]);
    const vrEvidence = await writeInput("ev-verify-review.json", {
      kind: "verify-review",
      iteration: 1,
      actor: "cli:loaf",
      result: "approved",
      summary: "spec-fit review passed; no anti-pattern",
      check: "review",
      covers: ["REQ-CORE-001"],
    });
    await step("evidence add verify-review", ["evidence", "add", "--input", vrEvidence, "--feature", F]);
    const vsEvidence = await writeInput("ev-visual-review.json", {
      kind: "visual-review",
      iteration: 1,
      actor: "cli:loaf",
      result: "approved",
      summary: "visual contract VIS-CORE-001 matches the mockup",
      check: "visual",
      covers: ["VIS-CORE-001"],
      // visual-review requires >=1 pre-hashed attachment; the CLI does not
      // stat/hash/copy the file in this slice — it is passthrough metadata.
      attachments: [
        { path: "screenshots/vis-core-001.png", sha256: "a".repeat(64), mime: "image/png", bytes: 1024 },
      ],
    });
    await step("evidence add visual-review", ["evidence", "add", "--input", vsEvidence, "--feature", F]);

    await step("gate verify-accept", [
      "gate", "decide", "verify-accept", "--approve",
      "--reason", "all verify-accept checks pass for the mixed-kind feature",
      "--feature", F,
    ]);
    const delivered = await step("deliver", ["deliver", "--feature", F]);
    expect(delivered.sub_state ?? delivered.state?.sub_state).toBe("DONE.delivered");
  });

  // SCEN-E2E-004 — see docs/e2e-scenarios.md (absorbs SCEN-008)
  test("SCEN-E2E-004 — deep ceremony runs through settle to deliver", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-deep";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    // ── TRIAGE + SPEC ───────────────────────────────────────────────────
    await step("start", ["start", F, "--ceremony", "deep"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E deep ceremony" },
      intent: "drive a deep-ceremony feature through the SETTLE phase to deliver",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the deep-ceremony lifecycle smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);

    // ── tasks ───────────────────────────────────────────────────────────
    const st = await step("status pre-tasks", ["status", "--feature", F]);
    const specVersion: number = st.state?.spec_version ?? st.spec_version;
    const tasksFile = await writeInput("tasks.json", {
      based_on: { spec: specVersion },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          drives: ["REQ-CORE-001"],
          tests: ["e2e.deepSmoke"],
          status: "pending",
          depends_on: [],
          labels: [],
          execution: {
            red: { applicability: "must", status: "pending", evidence_refs: [] },
            implement: { applicability: "must", status: "pending", evidence_refs: [] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        },
      ],
    });
    await step("tasks submit", ["tasks", "submit", "--input", tasksFile, "--feature", F]);
    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "deep feature passes spec-lock", "--feature", F,
    ]);

    // ── EXECUTE ─────────────────────────────────────────────────────────
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);
    await step("tasks claim T-001", ["tasks", "claim", "T-001", "--feature", F]);
    for (const stp of ["red", "implement"]) {
      await step(`step start ${stp}`, [
        "tasks", "step", "start", "--task", "T-001", "--step", stp, "--feature", F,
      ]);
      await step(`step done ${stp}`, [
        "tasks", "step", "done", "--task", "T-001", "--step", stp, "--feature", F,
      ]);
    }
    await step("advance EXECUTE.done", ["advance", "EXECUTE.done", "--feature", F]);

    // ── VERIFY ──────────────────────────────────────────────────────────
    for (const ss of [
      "VERIFY.plan", "VERIFY.run", "VERIFY.review",
      "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept",
    ]) {
      await step(`advance ${ss}`, ["advance", ss, "--feature", F]);
    }
    // deep sets strict_spec_review → verify-accept check 5 fires. The
    // task-summary actor is a non-cli:* implementer (so the implementer set
    // is non-empty); the spec-review actor differs from it (so check 5's
    // actor∉implementer holds). spec-review also satisfies lane=review.
    const tsEvidence = await writeInput("ev-task-summary.json", {
      kind: "task-summary",
      iteration: 1,
      actor: "skill:loaf-cli/impl",
      result: "passed",
      summary: "unit tests pass for T-001",
      task_id: "T-001",
      covers: ["T-001"],
      cmd: "bun test",
      exit: 0,
    });
    await step("evidence add task-summary", ["evidence", "add", "--input", tsEvidence, "--feature", F]);
    const srEvidence = await writeInput("ev-spec-review.json", {
      kind: "spec-review",
      iteration: 1,
      actor: "human:reviewer@test.invalid",
      result: "approved",
      summary: "independent spec-fit review; implementation matches the spec",
      check: "review",
      covers: ["REQ-CORE-001"],
    });
    await step("evidence add spec-review", ["evidence", "add", "--input", srEvidence, "--feature", F]);

    await step("gate verify-accept", [
      "gate", "decide", "verify-accept", "--approve",
      "--reason", "all verify-accept checks pass for the deep feature",
      "--feature", F,
    ]);

    // ── deep deliver routing — SCEN-008: deliver cannot bypass settle ────
    const bypass = await runCli(
      ["deliver", "--feature", F, "--feature-dir", dir, "--format", "json"],
      { env: ENV },
    );
    expect(bypass.exit).toBe(2);
    expect(bypass.stderr + bypass.stdout).toContain("DELIVER_SETTLE_PHASE_BYPASS");

    // ── SETTLE ──────────────────────────────────────────────────────────
    await step("settle", ["settle", "--feature", F]);
    await step("advance SETTLE.lessons", ["advance", "SETTLE.lessons", "--feature", F]);

    const delivered = await step("deliver", ["deliver", "--feature", F]);
    expect(delivered.sub_state ?? delivered.state?.sub_state).toBe("DONE.delivered");
  });

  // SCEN-E2E-024 — see docs/e2e-scenarios.md
  test("SCEN-E2E-024 — spec-lock reject keeps cursor, approve advances", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-lock-reject";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E spec-lock reject" },
      intent: "exercise the spec-lock gate reject then approve path",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the spec-lock reject smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    const st = await step("status pre-tasks", ["status", "--feature", F]);
    const specVersion: number = st.state?.spec_version ?? st.spec_version;
    const tasksFile = await writeInput("tasks.json", {
      based_on: { spec: specVersion },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          drives: ["REQ-CORE-001"],
          tests: ["e2e.lockRejectSmoke"],
          status: "pending",
          depends_on: [],
          labels: [],
          execution: {
            red: { applicability: "must", status: "pending", evidence_refs: [] },
            implement: { applicability: "must", status: "pending", evidence_refs: [] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        },
      ],
    });
    await step("tasks submit", ["tasks", "submit", "--input", tasksFile, "--feature", F]);

    // ── reject — cursor stays SPEC.design, spec_locked stays false ──────
    await step("gate spec-lock reject", [
      "gate", "decide", "spec-lock", "--reject",
      "--reason", "hold for one more spec review pass", "--feature", F,
    ]);
    const afterReject = await step("status after reject", ["status", "--feature", F]);
    expect(afterReject.state.sub_state).toBe("SPEC.design");
    expect(afterReject.state.spec_locked).toBe(false);

    // ── approve — cursor advances to EXECUTE.plan ───────────────────────
    const approved = await step("gate spec-lock approve", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "spec and task graph are complete", "--feature", F,
    ]);
    expect(approved.sub_state ?? approved.state?.sub_state).toBe("EXECUTE.plan");
  });

  // SCEN-E2E-025 — see docs/e2e-scenarios.md
  test("SCEN-E2E-025 — verify-accept reject blocks deliver, approve unblocks", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-verify-reject";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    // ── drive a standard feature to VERIFY.accept with evidence ─────────
    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E verify-accept reject" },
      intent: "exercise the verify-accept gate reject then approve path",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the verify-accept reject smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    const st = await step("status pre-tasks", ["status", "--feature", F]);
    const specVersion: number = st.state?.spec_version ?? st.spec_version;
    const tasksFile = await writeInput("tasks.json", {
      based_on: { spec: specVersion },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          drives: ["REQ-CORE-001"],
          tests: ["e2e.verifyRejectSmoke"],
          status: "pending",
          depends_on: [],
          labels: [],
          execution: {
            red: { applicability: "must", status: "pending", evidence_refs: [] },
            implement: { applicability: "must", status: "pending", evidence_refs: [] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        },
      ],
    });
    await step("tasks submit", ["tasks", "submit", "--input", tasksFile, "--feature", F]);
    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "spec and task graph complete", "--feature", F,
    ]);
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);
    await step("tasks claim T-001", ["tasks", "claim", "T-001", "--feature", F]);
    for (const stp of ["red", "implement"]) {
      await step(`step start ${stp}`, [
        "tasks", "step", "start", "--task", "T-001", "--step", stp, "--feature", F,
      ]);
      await step(`step done ${stp}`, [
        "tasks", "step", "done", "--task", "T-001", "--step", stp, "--feature", F,
      ]);
    }
    await step("advance EXECUTE.done", ["advance", "EXECUTE.done", "--feature", F]);
    for (const ss of [
      "VERIFY.plan", "VERIFY.run", "VERIFY.review",
      "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept",
    ]) {
      await step(`advance ${ss}`, ["advance", ss, "--feature", F]);
    }
    const tsEvidence = await writeInput("ev-task-summary.json", {
      kind: "task-summary", iteration: 1, actor: "cli:loaf", result: "passed",
      summary: "unit tests pass for T-001", task_id: "T-001", covers: ["T-001"],
      cmd: "bun test", exit: 0,
    });
    await step("evidence add task-summary", ["evidence", "add", "--input", tsEvidence, "--feature", F]);
    const vrEvidence = await writeInput("ev-verify-review.json", {
      kind: "verify-review", iteration: 1, actor: "cli:loaf", result: "approved",
      summary: "spec-fit review passed", check: "review", covers: ["REQ-CORE-001"],
    });
    await step("evidence add verify-review", ["evidence", "add", "--input", vrEvidence, "--feature", F]);

    // ── reject — verify_accepted stays false, deliver is blocked ────────
    await step("gate verify-accept reject", [
      "gate", "decide", "verify-accept", "--reject",
      "--reason", "hold for one more verification pass", "--feature", F,
    ]);
    const afterReject = await step("status after reject", ["status", "--feature", F]);
    expect(afterReject.state.sub_state).toBe("VERIFY.accept");
    expect(afterReject.state.verify_accepted).toBe(false);

    const blocked = await runCli(
      ["deliver", "--feature", F, "--feature-dir", dir, "--format", "json"],
      { env: ENV },
    );
    expect(blocked.exit).toBe(2);
    expect(blocked.stderr + blocked.stdout).toContain("DELIVER_NOT_ACCEPTED");

    // ── approve — deliver unblocked ─────────────────────────────────────
    await step("gate verify-accept approve", [
      "gate", "decide", "verify-accept", "--approve",
      "--reason", "all verify-accept checks pass", "--feature", F,
    ]);
    const delivered = await step("deliver", ["deliver", "--feature", F]);
    expect(delivered.sub_state ?? delivered.state?.sub_state).toBe("DONE.delivered");
  });

  // SCEN-E2E-009 — see docs/e2e-scenarios.md
  test("SCEN-E2E-009 — behavioral bug task: implement gated by register-red", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-bug-red";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E bug RED gate" },
      intent: "exercise the bug-task RED registration runtime gate",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the bug-RED gate smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    const st = await step("status pre-tasks", ["status", "--feature", F]);
    const specVersion: number = st.state?.spec_version ?? st.spec_version;
    // A behavioral bug task is born unregistered — R2 dropped the
    // creation-time refine, so tasks_planned carries no red_test_registered.
    const tasksFile = await writeInput("tasks.json", {
      based_on: { spec: specVersion },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          labels: ["bug"],
          drives: ["REQ-CORE-001"],
          tests: ["e2e.bugRepro"],
          status: "pending",
          depends_on: [],
          execution: {
            red: { applicability: "must", status: "pending", evidence_refs: [] },
            implement: { applicability: "must", status: "pending", evidence_refs: [] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        },
      ],
    });
    await step("tasks submit", ["tasks", "submit", "--input", tasksFile, "--feature", F]);
    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "bug feature passes spec-lock", "--feature", F,
    ]);
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);
    await step("tasks claim T-001", ["tasks", "claim", "T-001", "--feature", F]);

    // ── implement is blocked until RED is registered ────────────────────
    const gated = await runCli(
      ["tasks", "step", "start", "--task", "T-001", "--step", "implement",
        "--feature", F, "--feature-dir", dir, "--format", "json"],
      { env: ENV },
    );
    expect(gated.exit).toBe(2);
    expect(gated.stderr + gated.stdout).toContain("BUG_TASK_REQUIRES_RED");

    // ── register-red unlocks implement ──────────────────────────────────
    await step("tasks register-red", ["tasks", "register-red", "T-001", "--feature", F]);
    await step("step start implement", [
      "tasks", "step", "start", "--task", "T-001", "--step", "implement", "--feature", F,
    ]);
    await step("step done implement", [
      "tasks", "step", "done", "--task", "T-001", "--step", "implement", "--feature", F,
    ]);

    // T-001 auto-promotes: red registered, implement done, refactor optional.
    const tasks = await step("tasks list", ["tasks", "list", "--feature", F]);
    expect(JSON.stringify(tasks)).toContain("done");
  });

  // SCEN-E2E-014 — see docs/e2e-scenarios.md
  test("SCEN-E2E-014 — a spike task blocks deliver (DELIVER_SPIKE_TASKS)", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-spike";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E spike no-deliver" },
      intent: "exercise the spike-task hard block on deliver",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the spike no-deliver smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    const st = await step("status pre-tasks", ["status", "--feature", F]);
    const specVersion: number = st.state?.spec_version ?? st.spec_version;
    const tasksFile = await writeInput("tasks.json", {
      based_on: { spec: specVersion },
      tasks: [
        {
          id: "T-001",
          kind: "spike",
          drives: ["REQ-CORE-001"],
          no_test_rationale: "explore the approach; a spike is not shipped",
          status: "pending",
          depends_on: [],
          labels: [],
          execution: {
            explore: { applicability: "must", status: "pending", evidence_refs: [] },
            prototype: { applicability: "must", status: "pending", evidence_refs: [] },
            record: { applicability: "must", status: "pending", evidence_refs: [] },
          },
        },
      ],
    });
    await step("tasks submit", ["tasks", "submit", "--input", tasksFile, "--feature", F]);
    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "spike feature passes spec-lock", "--feature", F,
    ]);
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);
    await step("tasks claim T-001", ["tasks", "claim", "T-001", "--feature", F]);
    for (const stp of ["explore", "prototype", "record"]) {
      await step(`step start ${stp}`, [
        "tasks", "step", "start", "--task", "T-001", "--step", stp, "--feature", F,
      ]);
      await step(`step done ${stp}`, [
        "tasks", "step", "done", "--task", "T-001", "--step", stp, "--feature", F,
      ]);
    }
    await step("advance EXECUTE.done", ["advance", "EXECUTE.done", "--feature", F]);
    for (const ss of [
      "VERIFY.plan", "VERIFY.run", "VERIFY.review",
      "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept",
    ]) {
      await step(`advance ${ss}`, ["advance", ss, "--feature", F]);
    }
    const tsEvidence = await writeInput("ev-task-summary.json", {
      kind: "task-summary", iteration: 1, actor: "cli:loaf", result: "passed",
      summary: "spike exploration recorded for T-001", task_id: "T-001", covers: ["T-001"],
      cmd: "bun test", exit: 0,
    });
    await step("evidence add task-summary", ["evidence", "add", "--input", tsEvidence, "--feature", F]);
    const vrEvidence = await writeInput("ev-verify-review.json", {
      kind: "verify-review", iteration: 1, actor: "cli:loaf", result: "approved",
      summary: "spec-fit review passed", check: "review", covers: ["REQ-CORE-001"],
    });
    await step("evidence add verify-review", ["evidence", "add", "--input", vrEvidence, "--feature", F]);
    await step("gate verify-accept", [
      "gate", "decide", "verify-accept", "--approve",
      "--reason", "verify-accept checks pass for the spike feature", "--feature", F,
    ]);

    // ── deliver is hard-blocked while a non-abandoned spike task exists ──
    const blocked = await runCli(
      ["deliver", "--feature", F, "--feature-dir", dir, "--format", "json"],
      { env: ENV },
    );
    expect(blocked.exit).toBe(2);
    expect(blocked.stderr + blocked.stdout).toContain("DELIVER_SPIKE_TASKS");
  });

  // SCEN-E2E-007 — see docs/e2e-scenarios.md
  test("SCEN-E2E-007 — settle is rejected for standard ceremony", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-settle-off";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const cli = makeCli(dir, ENV);
    await seedToVerifyAccept(
      cli, F, "E2E settle disabled", "exercise the standard-ceremony settle rejection",
    );

    // standard ceremony has settle_phase=false → settle is rejected.
    const rejected = await runCli(
      ["settle", "--feature", F, "--feature-dir", dir, "--format", "json"],
      { env: ENV },
    );
    expect(rejected.exit).toBe(2);
    expect(rejected.stderr + rejected.stdout).toContain("SETTLE_PHASE_DISABLED");
  });

  // SCEN-E2E-015 — see docs/e2e-scenarios.md
  test("SCEN-E2E-015 — spec add-* allocates per-namespace ids, bumps version once per call", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-spec-append";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E spec append" },
      intent: "exercise the incremental spec add-* id allocator and version bump",
      adr_refs: [],
      needs_clarification: [],
    });
    const submitted = await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    expect(submitted.spec_version).toBe(1);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);

    // ── single-item add-req — first id in the REQ-CORE namespace ─────────
    const req1 = await writeInput("req1.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall allocate the first requirement id",
      acceptance_na: true,
      acceptance_na_reason: "exercised structurally by this allocator integration test",
    });
    const r1 = await step("add-req single", ["spec", "add-req", "--input", req1, "--feature", F]);
    expect(r1.ids).toEqual(["REQ-CORE-001"]);
    expect(r1.spec_version).toBe(2);

    // ── batch add-req — two items, ONE invocation, ONE version bump ──────
    const reqBatch = await writeInput("req-batch.json", [
      {
        id_namespace: "REQ-CORE",
        type: "ubiquitous",
        response: "the system shall allocate the second requirement id",
        acceptance_na: true,
        acceptance_na_reason: "structural allocator coverage only",
      },
      {
        id_namespace: "REQ-CORE",
        type: "ubiquitous",
        response: "the system shall allocate the third requirement id",
        acceptance_na: true,
        acceptance_na_reason: "structural allocator coverage only",
      },
    ]);
    const r2 = await step("add-req batch", ["spec", "add-req", "--input", reqBatch, "--feature", F]);
    expect(r2.ids).toEqual(["REQ-CORE-002", "REQ-CORE-003"]);
    expect(r2.spec_version).toBe(3); // a two-item batch bumps the version exactly once

    // ── scenario namespace allocates independently of REQ ───────────────
    const scen1 = await writeInput("scen1.json", {
      id_namespace: "SCEN-CORE",
      name: "first scenario",
      tag: "happy",
      given: ["a feature with an incrementally appended spec"],
      when: ["a scenario is appended"],
      then: ["it receives the first SCEN id in its own namespace"],
    });
    const s1 = await step("add-scenario", ["spec", "add-scenario", "--input", scen1, "--feature", F]);
    expect(s1.ids).toEqual(["SCEN-CORE-001"]);
    expect(s1.spec_version).toBe(4);

    // ── visual namespace, batch — VIS ids start at 001 in their namespace
    const visBatch = await writeInput("vis-batch.json", [
      { id_namespace: "VIS-CORE", target: "the header region", checks: ["renders the title"] },
      { id_namespace: "VIS-CORE", target: "the footer region", checks: ["renders the status line"] },
    ]);
    const v1 = await step("add-visual batch", ["spec", "add-visual", "--input", visBatch, "--feature", F]);
    expect(v1.ids).toEqual(["VIS-CORE-001", "VIS-CORE-002"]);
    expect(v1.spec_version).toBe(5);

    // each namespace counted from 001; five invocations → five bumps.
    const st = await step("status", ["status", "--feature", F]);
    expect(st.state.spec_version).toBe(5);
    expect(st.state.spec_locked).toBe(false);
  });

  // SCEN-E2E-019 — see docs/e2e-scenarios.md
  test("SCEN-E2E-019 — amend-spec back-edge resets the lock, re-lock still reaches deliver", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-amend-spec";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    // behavioral task whose execution ladder is red + implement (+ optional
    // refactor). `drives` is overridden per submit so the re-plan covers the
    // requirement added after the back-edge.
    const tasksPayload = (specVersion: number, drives: string[]) => ({
      based_on: { spec: specVersion },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          drives,
          tests: ["e2e.amendSpec"],
          status: "pending",
          depends_on: [],
          labels: [],
          execution: {
            red: { applicability: "must", status: "pending", evidence_refs: [] },
            implement: { applicability: "must", status: "pending", evidence_refs: [] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        },
      ],
    });
    const reqInput = async (name: string, response: string) =>
      writeInput(name, {
        id_namespace: "REQ-CORE",
        type: "ubiquitous",
        response,
        acceptance_na: true,
        acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
      });

    // ── drive a standard feature to a locked EXECUTE.work ───────────────
    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E amend-spec back-edge" },
      intent: "exercise the amend-spec finding back-edge and the spec re-lock path",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    await step("spec add-req", [
      "spec", "add-req",
      "--input", await reqInput("req1.json", "the system shall complete the amend-spec smoke"),
      "--feature", F,
    ]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    await step("tasks submit", [
      "tasks", "submit", "--input",
      await writeInput("tasks-v2.json", tasksPayload(2, ["REQ-CORE-001"])),
      "--feature", F,
    ]);
    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "spec and task graph complete for the first lock", "--feature", F,
    ]);
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);

    // ── amend-spec back-edge: cursor → SPEC.spec, spec_locked → false ────
    const raised = await step("finding raise amend-spec", [
      "finding", "raise", "--category", "spec-gap", "--action", "amend-spec",
      "--summary", "the spec omits a requirement surfaced during execution",
      "--feature", F,
    ]);
    expect(raised.id).toMatch(/^FND-\d{3,}$/);
    expect(raised.back_edge.to).toBe("SPEC.spec");
    const afterBackEdge = await step("status after back-edge", ["status", "--feature", F]);
    expect(afterBackEdge.state.sub_state).toBe("SPEC.spec");
    expect(afterBackEdge.state.spec_locked).toBe(false);

    // ── amend the spec: a new requirement bumps spec_version ────────────
    await step("spec add-req (amended)", [
      "spec", "add-req",
      "--input", await reqInput("req2.json", "the system shall cover the requirement added post back-edge"),
      "--feature", F,
    ]);

    // ── re-plan against the bumped spec, then re-lock ───────────────────
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    await step("tasks submit (re-plan)", [
      "tasks", "submit", "--input",
      await writeInput("tasks-v3.json", tasksPayload(3, ["REQ-CORE-001", "REQ-CORE-002"])),
      "--feature", F,
    ]);
    const reLock = await step("gate spec-lock (re-lock)", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "amended spec and re-planned task graph are complete", "--feature", F,
    ]);
    expect(reLock.sub_state ?? reLock.state?.sub_state).toBe("EXECUTE.plan");

    // ── finish the lifecycle; the open amend-spec finding must be closed
    //    before verify-accept (open findings block the gate) ─────────────
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);
    await step("finding close", ["finding", "close", raised.id, "--feature", F]);
    await step("tasks claim T-001", ["tasks", "claim", "T-001", "--feature", F]);
    for (const stp of ["red", "implement"]) {
      await step(`step start ${stp}`, [
        "tasks", "step", "start", "--task", "T-001", "--step", stp, "--feature", F,
      ]);
      await step(`step done ${stp}`, [
        "tasks", "step", "done", "--task", "T-001", "--step", stp, "--feature", F,
      ]);
    }
    await step("advance EXECUTE.done", ["advance", "EXECUTE.done", "--feature", F]);
    for (const ss of [
      "VERIFY.plan", "VERIFY.run", "VERIFY.review",
      "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept",
    ]) {
      await step(`advance ${ss}`, ["advance", ss, "--feature", F]);
    }
    const tsEvidence = await writeInput("ev-task-summary.json", {
      kind: "task-summary", iteration: 1, actor: "cli:loaf", result: "passed",
      summary: "unit tests pass for T-001 against the amended spec", task_id: "T-001",
      covers: ["T-001"], cmd: "bun test", exit: 0,
    });
    await step("evidence add task-summary", ["evidence", "add", "--input", tsEvidence, "--feature", F]);
    const vrEvidence = await writeInput("ev-verify-review.json", {
      kind: "verify-review", iteration: 1, actor: "cli:loaf", result: "approved",
      summary: "spec-fit review passed against the amended spec", check: "review",
      covers: ["REQ-CORE-001", "REQ-CORE-002"],
    });
    await step("evidence add verify-review", ["evidence", "add", "--input", vrEvidence, "--feature", F]);
    await step("gate verify-accept", [
      "gate", "decide", "verify-accept", "--approve",
      "--reason", "all verify-accept checks pass after the amend-spec cycle", "--feature", F,
    ]);
    const delivered = await step("deliver", ["deliver", "--feature", F]);
    expect(delivered.sub_state ?? delivered.state?.sub_state).toBe("DONE.delivered");
  });

  // SCEN-E2E-026 — see docs/e2e-scenarios.md
  test("SCEN-E2E-026 — profile_escalation pending blocks advance; spec_clarification does not", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-pending-block";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step } = makeCli(dir, ENV);

    await step("start", ["start", F, "--ceremony", "standard"]);

    // ── a profile_escalation head blocks `loaf advance` ─────────────────
    const pe = await step("pending raise profile_escalation", [
      "pending", "raise", "--kind", "profile_escalation",
      "--question", "should this feature escalate to a deeper ceremony profile?",
      "--feature", F,
    ]);
    expect(pe.id).toMatch(/^PEND-\d{4,}$/);

    const blocked = await runCli(
      ["advance", "TRIAGE.confirm", "--feature", F, "--feature-dir", dir, "--format", "json"],
      { env: ENV },
    );
    expect(blocked.exit).toBe(2);
    expect(blocked.stderr + blocked.stdout).toContain("PENDING_BLOCKS_ADVANCE");

    // ── resolving the head clears the block ─────────────────────────────
    await step("pending resolve", [
      "pending", "resolve",
      "--answer", "no escalation needed; the standard ceremony profile stands",
      "--feature", F,
    ]);
    const advanced = await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    expect(advanced.sub_state).toBe("TRIAGE.confirm");

    // ── a spec_clarification head is FIFO-visible but never blocks ──────
    await step("pending raise spec_clarification", [
      "pending", "raise", "--kind", "spec_clarification",
      "--question", "which downstream module owns the projection write path?",
      "--feature", F,
    ]);
    const stillAdvances = await step("advance SPEC.proposal", [
      "advance", "SPEC.proposal", "--feature", F,
    ]);
    expect(stillAdvances.sub_state).toBe("SPEC.proposal");
  });

  // SCEN-E2E-031 — see docs/e2e-scenarios.md
  test("SCEN-E2E-031 — tasks step done co-emits EV- evidence in one CLI call", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-step-evidence";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E step-done evidence batch" },
      intent: "exercise the tasks step done co-emitted evidence batch path",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the step-evidence batch smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    const st = await step("status pre-tasks", ["status", "--feature", F]);
    const specVersion: number = st.state?.spec_version ?? st.spec_version;
    const tasksFile = await writeInput("tasks.json", {
      based_on: { spec: specVersion },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          drives: ["REQ-CORE-001"],
          tests: ["e2e.stepEvidence"],
          status: "pending",
          depends_on: [],
          labels: [],
          execution: {
            red: { applicability: "must", status: "pending", evidence_refs: [] },
            implement: { applicability: "must", status: "pending", evidence_refs: [] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        },
      ],
    });
    await step("tasks submit", ["tasks", "submit", "--input", tasksFile, "--feature", F]);
    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "spec and task graph complete", "--feature", F,
    ]);
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);
    await step("tasks claim T-001", ["tasks", "claim", "T-001", "--feature", F]);
    await step("step start red", [
      "tasks", "step", "start", "--task", "T-001", "--step", "red", "--feature", F,
    ]);

    // ── one CLI call closes the step AND registers its proof ────────────
    const done = await step("step done red + evidence", [
      "tasks", "step", "done", "--task", "T-001", "--step", "red",
      "--evidence-kind", "task-summary",
      "--evidence-summary", "the red test reproduces the targeted behavior gap",
      "--evidence-covers", "T-001",
      "--feature", F,
    ]);
    // the step is closed — its status reflects the terminal-positive result.
    expect(done.step_status).toBe("passed");
    expect(done.evidence_id).toMatch(/^EV-\d{6}$/);

    // the co-emitted evidence is in the projection — one batch, one EV.
    const afterDone = await step("status after step done", ["status", "--feature", F]);
    expect(afterDone.evidence_count).toBe(1);
  });

  // SCEN-E2E-005 — see docs/e2e-scenarios.md
  test("SCEN-E2E-005 — quick ceremony deliver from EXECUTE.done is fail-closed", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-quick";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step } = makeCli(dir, ENV);

    const started = await step("start", ["start", F, "--ceremony", "quick"]);
    expect(started.sub_state).toBe("TRIAGE.score");
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    // quick has spec_phase=false — TRIAGE.confirm forks straight to
    // EXECUTE.plan, skipping the whole SPEC.* ladder and the spec-lock gate.
    await step("advance EXECUTE.plan", ["advance", "EXECUTE.plan", "--feature", F]);
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);
    await step("advance EXECUTE.done", ["advance", "EXECUTE.done", "--feature", F]);

    // quick also skips VERIFY (verify_phase=false). The MVP has no
    // verify-min check, so deliver from EXECUTE.done is fail-closed rather
    // than silently shipping an unverified feature.
    const blocked = await runCli(
      ["deliver", "--feature", F, "--feature-dir", dir, "--format", "json"],
      { env: ENV },
    );
    expect(blocked.exit).toBe(2);
    expect(blocked.stderr + blocked.stdout).toContain("DELIVER_VERIFY_MIN_UNAVAILABLE");
  });

  // SCEN-E2E-006 — see docs/e2e-scenarios.md
  test("SCEN-E2E-006 — light ceremony deliver from EXECUTE.done is fail-closed", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-light";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    // light has spec_phase=true — it traverses SPEC.* and the spec-lock
    // gate exactly like standard; only VERIFY/SETTLE are skipped.
    await step("start", ["start", F, "--ceremony", "light"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E light ceremony" },
      intent: "exercise the light-ceremony fail-closed deliver boundary",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the light-ceremony smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    const st = await step("status pre-tasks", ["status", "--feature", F]);
    const specVersion: number = st.state?.spec_version ?? st.spec_version;
    const tasksFile = await writeInput("tasks.json", {
      based_on: { spec: specVersion },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          drives: ["REQ-CORE-001"],
          tests: ["e2e.lightSmoke"],
          status: "pending",
          depends_on: [],
          labels: [],
          execution: {
            red: { applicability: "must", status: "pending", evidence_refs: [] },
            implement: { applicability: "must", status: "pending", evidence_refs: [] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        },
      ],
    });
    await step("tasks submit", ["tasks", "submit", "--input", tasksFile, "--feature", F]);
    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "spec and task graph complete for the light feature", "--feature", F,
    ]);
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);
    await step("tasks claim T-001", ["tasks", "claim", "T-001", "--feature", F]);
    for (const stp of ["red", "implement"]) {
      await step(`step start ${stp}`, [
        "tasks", "step", "start", "--task", "T-001", "--step", stp, "--feature", F,
      ]);
      await step(`step done ${stp}`, [
        "tasks", "step", "done", "--task", "T-001", "--step", stp, "--feature", F,
      ]);
    }
    await step("advance EXECUTE.done", ["advance", "EXECUTE.done", "--feature", F]);

    // light skips VERIFY (verify_phase=false); deliver from EXECUTE.done is
    // fail-closed until the verify-min check lands.
    const blocked = await runCli(
      ["deliver", "--feature", F, "--feature-dir", dir, "--format", "json"],
      { env: ENV },
    );
    expect(blocked.exit).toBe(2);
    expect(blocked.stderr + blocked.stdout).toContain("DELIVER_VERIFY_MIN_UNAVAILABLE");
  });

  // SCEN-E2E-016 — see docs/e2e-scenarios.md
  test("SCEN-E2E-016 — spec add-* is rejected once the spec is locked", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-postlock";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E post-lock spec edit" },
      intent: "exercise the post-lock direct spec-edit rejection",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the post-lock rejection smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    const st = await step("status pre-tasks", ["status", "--feature", F]);
    const specVersion: number = st.state?.spec_version ?? st.spec_version;
    const tasksFile = await writeInput("tasks.json", {
      based_on: { spec: specVersion },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          drives: ["REQ-CORE-001"],
          tests: ["e2e.postLock"],
          status: "pending",
          depends_on: [],
          labels: [],
          execution: {
            red: { applicability: "must", status: "pending", evidence_refs: [] },
            implement: { applicability: "must", status: "pending", evidence_refs: [] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        },
      ],
    });
    await step("tasks submit", ["tasks", "submit", "--input", tasksFile, "--feature", F]);
    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "spec and task graph complete", "--feature", F,
    ]);

    // cursor is EXECUTE.plan, spec_locked=true — a direct spec append is
    // rejected. SPEC_LOCKED_NO_DIRECT_EDIT is defense-in-depth for the
    // abnormal spec_locked-while-in-SPEC.* case; in the normal flow the
    // spec-lock gate co-advances the cursor out of SPEC.*, so the reachable
    // rejection at EXECUTE.plan is the sub_state authority guard (the
    // e2e-scenarios.md SCEN-E2E-016 "or sub_state authority" branch). A
    // post-lock spec change must go through a finding amend-spec back-edge.
    const lateReq = await writeInput("late-req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall reject this post-lock requirement append",
      acceptance_na: true,
      acceptance_na_reason: "this requirement is never recorded; the append is expected to fail",
    });
    const rejected = await runCli(
      ["spec", "add-req", "--input", lateReq, "--feature", F, "--feature-dir", dir, "--format", "json"],
      { env: ENV },
    );
    expect(rejected.exit).toBe(2);
    expect(rejected.stderr + rejected.stdout).toContain("SUB_STATE_AUTHORITY_VIOLATION");
  });

  // SCEN-E2E-023 — see docs/e2e-scenarios.md
  test("SCEN-E2E-023 — an open defer finding blocks verify-accept until closed", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-open-finding";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const cli = makeCli(dir, ENV);
    const { step } = cli;
    await seedToVerifyAccept(
      cli, F, "E2E open finding gate", "exercise the open-finding block on verify-accept",
    );

    // a defer finding raised at VERIFY.accept is open and carries no back-edge.
    const fnd = await step("finding raise defer", [
      "finding", "raise", "--category", "risk-escalation", "--action", "defer",
      "--summary", "a follow-up risk is deferred to a later cycle",
      "--feature", F,
    ]);
    expect(fnd.id).toMatch(/^FND-\d{3,}$/);

    // verify-accept is blocked while the finding is open
    const blocked = await runCli(
      ["gate", "decide", "verify-accept", "--approve",
        "--reason", "attempting approval while an open finding is present",
        "--feature", F, "--feature-dir", dir, "--format", "json"],
      { env: ENV },
    );
    expect(blocked.exit).toBe(2);
    expect(blocked.stderr + blocked.stdout).toContain("OPEN_FINDINGS_PRESENT");

    // closing the finding unblocks the gate; the feature still delivers
    await step("finding close", ["finding", "close", fnd.id, "--feature", F]);
    await step("gate verify-accept", [
      "gate", "decide", "verify-accept", "--approve",
      "--reason", "all verify-accept checks pass once the finding is closed", "--feature", F,
    ]);
    const delivered = await step("deliver", ["deliver", "--feature", F]);
    expect(delivered.sub_state ?? delivered.state?.sub_state).toBe("DONE.delivered");
  });

  // SCEN-E2E-039 — see docs/e2e-scenarios.md (Phase 11 Item 3 SC4).
  // The full back-edge repair loop closing the lifecycle: SCEN-E2E-020/021/
  // 022 prove a back-edge LANDS (the finding stays open — they stop there);
  // SCEN-E2E-023 proves the open-finding verify-accept block for a
  // non-back-edge defer finding. This scenario is the distinct cross-cutting
  // proof — a `fix-impl` back-edge repair finding raised from VERIFY,
  // carried all the way through to delivery: the back-edge co-emits its
  // 3-entry batch, the reset `implement` step is rerun, verify-accept is
  // blocked OPEN_FINDINGS_PRESENT while the finding is open, `finding close`
  // unblocks it, and `deliver` reaches DONE.delivered.
  test("SCEN-E2E-039 — a fix-impl back-edge repair finding is carried through to DONE.delivered", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-fix-impl-repair";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const cli = makeCli(dir, ENV);
    const { step } = cli;

    // ── drive a standard feature to VERIFY.accept (REQ / task / evidence
    //    all in place so verify-accept CAN eventually pass) ──────────────
    await seedToVerifyAccept(
      cli, F, "E2E fix-impl repair loop",
      "carry a fix-impl back-edge repair finding through to delivery",
    );
    const iterBefore = (await step("status pre-back-edge", ["status", "--feature", F]))
      .state.iteration;

    // ── fix-impl back-edge raised from a VERIFY sub_state (VERIFY.accept) ─
    // co-emits [finding:raised, event:task_step_reset, event:phase_advanced(
    // back_edge → EXECUTE.work)]: cursor → EXECUTE.work, iteration +1, the
    // implement step resets to pending, the task reopens to in_progress.
    const raised = await step("finding raise fix-impl", [
      "finding", "raise", "--category", "impl-defect", "--action", "fix-impl",
      "--summary", "the implementation regressed against REQ-CORE-001",
      "--target-task", "T-001", "--target-step", "implement",
      "--feature", F,
    ]);
    expect(raised.id).toMatch(/^FND-\d{3,}$/);
    expect(raised.back_edge.to).toBe("EXECUTE.work");

    // ── the back-edge moved the cursor to EXECUTE.work and bumped iteration
    const afterBackEdge = await step("status post-back-edge", ["status", "--feature", F]);
    expect(afterBackEdge.state.sub_state).toBe("EXECUTE.work");
    expect(afterBackEdge.state.iteration).toBe(iterBefore + 1);

    // ── the target task reopened; the reset implement step is pending ────
    const reopenTasks = await step("tasks list post-back-edge", ["tasks", "list", "--feature", F]);
    const t001Reopened = reopenTasks.tasks.find((t: { id: string }) => t.id === "T-001");
    expect(t001Reopened.status).toBe("in_progress");
    expect(t001Reopened.steps.implement.status).toBe("pending");
    expect(t001Reopened.steps.red.status).toBe("passed"); // history not erased

    // ── re-run the reset implement step to a terminal status ─────────────
    await step("step start implement (rerun)", [
      "tasks", "step", "start", "--task", "T-001", "--step", "implement", "--feature", F,
    ]);
    await step("step done implement (rerun)", [
      "tasks", "step", "done", "--task", "T-001", "--step", "implement",
      "--result", "passed", "--feature", F,
    ]);
    const repairedTasks = await step("tasks list post-repair", ["tasks", "list", "--feature", F]);
    const t001Repaired = repairedTasks.tasks.find((t: { id: string }) => t.id === "T-001");
    expect(t001Repaired.status).toBe("done");

    // ── re-advance EXECUTE.work → EXECUTE.done → VERIFY.* → VERIFY.accept ─
    await step("advance EXECUTE.done", ["advance", "EXECUTE.done", "--feature", F]);
    for (const ss of [
      "VERIFY.plan", "VERIFY.run", "VERIFY.review",
      "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept",
    ]) {
      await step(`advance ${ss}`, ["advance", ss, "--feature", F]);
    }

    // ── verify-accept --approve is BLOCKED while the fix-impl finding is
    //    open — verify-accept check 2 surfaces OPEN_FINDINGS_PRESENT ──────
    const blocked = await runCli(
      ["gate", "decide", "verify-accept", "--approve",
        "--reason", "attempting approval while the fix-impl finding is open",
        "--feature", F, "--feature-dir", dir, "--format", "json"],
      { env: ENV },
    );
    expect(blocked.exit).toBe(2);
    expect(blocked.stderr + blocked.stdout).toContain("OPEN_FINDINGS_PRESENT");

    // ── close the fix-impl repair finding ───────────────────────────────
    await step("finding close", ["finding", "close", raised.id, "--feature", F]);

    // ── verify-accept --approve now succeeds ────────────────────────────
    await step("gate verify-accept", [
      "gate", "decide", "verify-accept", "--approve",
      "--reason", "all verify-accept checks pass once the fix-impl finding is closed",
      "--feature", F,
    ]);

    // ── deliver reaches DONE.delivered ──────────────────────────────────
    const delivered = await step("deliver", ["deliver", "--feature", F]);
    expect(delivered.sub_state ?? delivered.state?.sub_state).toBe("DONE.delivered");

    // ── final state: the back-edge bumped iteration, the finding is closed
    const finalStatus = await step("status final", ["status", "--feature", F]);
    expect(finalStatus.state.iteration).toBe(iterBefore + 1);
    const finalFindings = await step("finding list final", ["finding", "list", "--feature", F]);
    const fnd = finalFindings.findings.find((f: { id: string }) => f.id === raised.id);
    expect(fnd.status).toBe("closed");
  });

  // SCEN-E2E-027 — see docs/e2e-scenarios.md
  test("SCEN-E2E-027 — a gate_decision pending head is co-resolved by the gate batch", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-gate-pending";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E gate pending co-resolution" },
      intent: "exercise the gate-decide co-emitted pending resolution batch",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the gate-pending co-resolution smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    const st = await step("status pre-tasks", ["status", "--feature", F]);
    const specVersion: number = st.state?.spec_version ?? st.spec_version;
    const tasksFile = await writeInput("tasks.json", {
      based_on: { spec: specVersion },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          drives: ["REQ-CORE-001"],
          tests: ["e2e.gatePending"],
          status: "pending",
          depends_on: [],
          labels: [],
          execution: {
            red: { applicability: "must", status: "pending", evidence_refs: [] },
            implement: { applicability: "must", status: "pending", evidence_refs: [] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        },
      ],
    });
    await step("tasks submit", ["tasks", "submit", "--input", tasksFile, "--feature", F]);

    // a gate_decision pending head would block a bare `advance`; the gate
    // batch co-emits pending:resolved before its phase_advanced, so the
    // approve clears the head and advances the cursor in one transaction.
    const pend = await step("pending raise gate_decision", [
      "pending", "raise", "--kind", "gate_decision",
      "--question", "approve the spec-lock gate for this feature?",
      "--feature", F,
    ]);
    expect(pend.id).toMatch(/^PEND-\d{4,}$/);

    const approved = await step("gate spec-lock approve", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "spec and task graph complete; co-resolves the gate pending",
      "--feature", F,
    ]);
    expect(approved.sub_state ?? approved.state?.sub_state).toBe("EXECUTE.plan");

    // the gate_decision head was cleared by the co-emitted pending:resolved.
    const pendList = await step("pending list", ["pending", "list", "--feature", F]);
    const gatePend = pendList.pending.find((p: any) => p.id === pend.id);
    expect(gatePend.resolved).toBe(true);
    expect(pendList.pending.some((p: any) => !p.resolved)).toBe(false);
  });

  // SCEN-E2E-028 — see docs/e2e-scenarios.md
  test("SCEN-E2E-028 — pending resolve is strict FIFO with no skip-ahead", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-fifo";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step } = makeCli(dir, ENV);

    await step("start", ["start", F, "--ceremony", "standard"]);
    const p1 = await step("raise pending 1", [
      "pending", "raise", "--kind", "ask_user_question",
      "--question", "the first question raised into the queue?", "--feature", F,
    ]);
    const p2 = await step("raise pending 2", [
      "pending", "raise", "--kind", "ask_user_question",
      "--question", "the second question raised into the queue?", "--feature", F,
    ]);

    // FIFO: the first-raised entry is the head.
    const list0 = await step("pending list (initial)", ["pending", "list", "--feature", F]);
    expect(list0.pending.find((p: any) => p.head)?.id).toBe(p1.id);

    // `pending resolve` has no --id flag — it pops the head only.
    await step("resolve head", [
      "pending", "resolve", "--answer", "answering the first queued question", "--feature", F,
    ]);
    const list1 = await step("pending list (after first resolve)", ["pending", "list", "--feature", F]);
    expect(list1.pending.find((p: any) => p.id === p1.id)?.resolved).toBe(true);
    const second = list1.pending.find((p: any) => p.id === p2.id);
    expect(second?.resolved).toBe(false);
    expect(second?.head).toBe(true); // the second entry is now the head

    // resolving again pops the second; the queue drains in raise order.
    await step("resolve second", [
      "pending", "resolve", "--answer", "answering the second queued question", "--feature", F,
    ]);
    const list2 = await step("pending list (drained)", ["pending", "list", "--feature", F]);
    expect(list2.pending.every((p: any) => p.resolved)).toBe(true);
  });

  // SCEN-E2E-030 — see docs/e2e-scenarios.md
  test("SCEN-E2E-030 — two independent tasks fan out, both claimed concurrently", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-fanout";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E fan-out independent tasks" },
      intent: "exercise the worker active-set with two independent fan-out tasks",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the fan-out lifecycle smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    const st = await step("status pre-tasks", ["status", "--feature", F]);
    const specVersion: number = st.state?.spec_version ?? st.spec_version;
    // two behavioral tasks, no depends_on between them — independent.
    const behavioral = (id: string) => ({
      id,
      kind: "behavioral",
      drives: ["REQ-CORE-001"],
      tests: [`e2e.fanout.${id}`],
      status: "pending",
      depends_on: [],
      labels: [],
      execution: {
        red: { applicability: "must", status: "pending", evidence_refs: [] },
        implement: { applicability: "must", status: "pending", evidence_refs: [] },
        refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
      },
    });
    const tasksFile = await writeInput("tasks.json", {
      based_on: { spec: specVersion },
      tasks: [behavioral("T-001"), behavioral("T-002")],
    });
    await step("tasks submit", ["tasks", "submit", "--input", tasksFile, "--feature", F]);
    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "spec and independent task graph complete", "--feature", F,
    ]);
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);

    // fan-out: both independent tasks are claimed before either finishes —
    // the worker active set holds two in_progress tasks at once.
    await step("tasks claim T-001", ["tasks", "claim", "T-001", "--feature", F]);
    await step("tasks claim T-002", ["tasks", "claim", "T-002", "--feature", F]);
    const claimed = await step("tasks list (both claimed)", ["tasks", "list", "--feature", F]);
    const claimedById = Object.fromEntries(claimed.tasks.map((t: any) => [t.id, t.status]));
    expect(claimedById["T-001"]).toBe("in_progress");
    expect(claimedById["T-002"]).toBe("in_progress");

    // each task has an in-flight red step before either completes.
    await step("step start red T-001", [
      "tasks", "step", "start", "--task", "T-001", "--step", "red", "--feature", F,
    ]);
    await step("step start red T-002", [
      "tasks", "step", "start", "--task", "T-002", "--step", "red", "--feature", F,
    ]);

    // EXECUTE.done is legal only after every task is terminal (F-016) —
    // with both tasks still in_progress, `advance EXECUTE.done` is rejected.
    const blockedDone = await runCli(
      ["advance", "EXECUTE.done", "--feature", F, "--feature-dir", dir, "--format", "json"],
      { env: ENV },
    );
    expect(blockedDone.exit).toBe(2);
    expect(blockedDone.stderr + blockedDone.stdout).toContain("EXECUTE_DONE_TASKS_NOT_FINAL");

    // both tasks complete; EXECUTE.done is then reached with both terminal.
    for (const id of ["T-001", "T-002"]) {
      await step(`step done red ${id}`, [
        "tasks", "step", "done", "--task", id, "--step", "red", "--feature", F,
      ]);
      await step(`step start implement ${id}`, [
        "tasks", "step", "start", "--task", id, "--step", "implement", "--feature", F,
      ]);
      await step(`step done implement ${id}`, [
        "tasks", "step", "done", "--task", id, "--step", "implement", "--feature", F,
      ]);
    }
    const done = await step("tasks list (both done)", ["tasks", "list", "--feature", F]);
    const doneById = Object.fromEntries(done.tasks.map((t: any) => [t.id, t.status]));
    expect(doneById["T-001"]).toBe("done");
    expect(doneById["T-002"]).toBe("done");
    await step("advance EXECUTE.done", ["advance", "EXECUTE.done", "--feature", F]);
  });

  // SCEN-E2E-032 — see docs/e2e-scenarios.md
  test("SCEN-E2E-032 — visual-review evidence with a pre-hashed attachment satisfies VIS coverage", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-visual-evidence";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E visual evidence attachment" },
      intent: "exercise the visual-review evidence attachment path through verify-accept",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the visual-evidence lifecycle smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
    const visInput = await writeInput("vis.json", {
      id_namespace: "VIS-CORE",
      target: "the primary screen layout",
      checks: ["renders the header", "renders the content region"],
    });
    await step("spec add-visual", ["spec", "add-visual", "--input", visInput, "--feature", F]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);

    // one visual-ui task bound to VIS-CORE-001 via visual_contract_refs.
    const tVisual = await writeInput("task-visual.json", {
      kind: "visual-ui",
      visual_contract_refs: ["VIS-CORE-001"],
      drives: ["REQ-CORE-001"],
      no_test_rationale: "visual parity is verified by screenshot comparison, not unit tests",
    });
    await step("tasks add visual-ui", ["tasks", "add", "--input", tVisual, "--feature", F]);
    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "visual-ui feature passes spec-lock", "--feature", F,
    ]);
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);
    await step("tasks claim T-001", ["tasks", "claim", "T-001", "--feature", F]);
    for (const stp of ["mockup", "implement", "screenshot-compare"]) {
      await step(`step start ${stp}`, [
        "tasks", "step", "start", "--task", "T-001", "--step", stp, "--feature", F,
      ]);
      await step(`step done ${stp}`, [
        "tasks", "step", "done", "--task", "T-001", "--step", stp, "--feature", F,
      ]);
    }
    await step("advance EXECUTE.done", ["advance", "EXECUTE.done", "--feature", F]);
    for (const ss of [
      "VERIFY.plan", "VERIFY.run", "VERIFY.review",
      "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept",
    ]) {
      await step(`advance ${ss}`, ["advance", ss, "--feature", F]);
    }
    const tsEvidence = await writeInput("ev-task-summary.json", {
      kind: "task-summary", iteration: 1, actor: "cli:loaf", result: "passed",
      summary: "the visual-ui task is verified", task_id: "T-001", covers: ["T-001"],
      cmd: "bun test", exit: 0,
    });
    await step("evidence add task-summary", ["evidence", "add", "--input", tsEvidence, "--feature", F]);
    const vrEvidence = await writeInput("ev-verify-review.json", {
      kind: "verify-review", iteration: 1, actor: "cli:loaf", result: "approved",
      summary: "spec-fit review passed", check: "review", covers: ["REQ-CORE-001"],
    });
    await step("evidence add verify-review", ["evidence", "add", "--input", vrEvidence, "--feature", F]);
    // visual-review evidence carries a pre-hashed attachment payload — the
    // CLI does not stat/hash/copy the file in this slice, it is passthrough
    // metadata. The visual-review covers VIS-CORE-001 so VIS coverage holds.
    const vsEvidence = await writeInput("ev-visual-review.json", {
      kind: "visual-review", iteration: 1, actor: "cli:loaf", result: "approved",
      summary: "visual contract VIS-CORE-001 matches the mockup", check: "visual",
      covers: ["VIS-CORE-001"],
      attachments: [
        { path: "screenshots/vis-core-001.png", sha256: "b".repeat(64), mime: "image/png", bytes: 2048 },
      ],
    });
    await step("evidence add visual-review", ["evidence", "add", "--input", vsEvidence, "--feature", F]);

    // VIS coverage from the visual-review attachment satisfies verify-accept.
    await step("gate verify-accept", [
      "gate", "decide", "verify-accept", "--approve",
      "--reason", "visual evidence covers VIS-CORE-001; all verify-accept checks pass", "--feature", F,
    ]);
    const delivered = await step("deliver", ["deliver", "--feature", F]);
    expect(delivered.sub_state ?? delivered.state?.sub_state).toBe("DONE.delivered");
  });

  // SCEN-E2E-034 — see docs/e2e-scenarios.md
  test("SCEN-E2E-034 — human-only commands need a resolvable human actor", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-actor";
    // The session is driven with NO LOAF_USER — start/advance/spec/tasks
    // emit a cli: actor and do not need a human actor. Only `gate decide`
    // and `deliver` resolve a human: actor.
    const noUser = makeCli(dir, { LOAF_USER: undefined });
    const { step, writeInput } = noUser;

    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E human actor resolution" },
      intent: "exercise the human-only gate actor resolution boundary",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the actor-resolution smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    const st = await step("status pre-tasks", ["status", "--feature", F]);
    const specVersion: number = st.state?.spec_version ?? st.spec_version;
    const tasksFile = await writeInput("tasks.json", {
      based_on: { spec: specVersion },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          drives: ["REQ-CORE-001"],
          tests: ["e2e.actorSmoke"],
          status: "pending",
          depends_on: [],
          labels: [],
          execution: {
            red: { applicability: "must", status: "pending", evidence_refs: [] },
            implement: { applicability: "must", status: "pending", evidence_refs: [] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        },
      ],
    });
    await step("tasks submit", ["tasks", "submit", "--input", tasksFile, "--feature", F]);

    // gate decide is human-only. Non-TTY runCli + no LOAF_USER + no explicit
    // git fallback → NO_HUMAN_ACTOR (the CI-safety guard never derives a
    // human: actor from git config in a non-interactive context).
    const noActor = await runCli(
      ["gate", "decide", "spec-lock", "--approve", "--reason",
        "attempting the gate with no resolvable human actor",
        "--feature", F, "--feature-dir", dir, "--format", "json"],
      { env: { LOAF_USER: undefined } },
    );
    expect(noActor.exit).toBe(2);
    expect(noActor.stderr + noActor.stdout).toContain("NO_HUMAN_ACTOR");

    // with LOAF_USER set the gate resolves a human: actor and advances.
    const withActor = await runCli(
      ["gate", "decide", "spec-lock", "--approve", "--reason",
        "spec and task graph complete; human actor resolved from LOAF_USER",
        "--feature", F, "--feature-dir", dir, "--format", "json"],
      { env: { LOAF_USER: "reviewer@test.invalid" } },
    );
    expect(withActor.exit).toBe(0);
    const approved = JSON.parse(withActor.stdout);
    expect(approved.sub_state ?? approved.state?.sub_state).toBe("EXECUTE.plan");
    expect(approved.actor).toBe("human:reviewer@test.invalid");
  });

  // ── future tier — see docs/e2e-scenarios.md ─────────────────────────
  // Inert inventory anchors. Each scenario needs a CLI command or finding
  // back-edge that does not exist yet (amend-tasks / fix-impl / fix-test
  // back-edges; spike-convert terminal). Each `todo` becomes a real test
  // in the slice that implements its surface — do not build setup around
  // the absent commands. Item 2 promoted the archive / abandon terminals
  // out of this tier — SCEN-E2E-035/036 below are real tests now.
  // SCEN-E2E-020 — see docs/e2e-scenarios.md (Phase 11 Item 3 SC1).
  // Back-edge-only: `finding raise --action amend-tasks` co-emits the
  // atomic [finding:raised, event:phase_advanced(back_edge)] batch.
  // cursor → EXECUTE.work, iteration +1, the finding stays open, the
  // task graph is UNCHANGED (no event:tasks_amended — that is SC1b).
  test("SCEN-E2E-020 — amend-tasks back-edge moves the cursor and bumps iteration without amending the task graph", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-amend-tasks";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    const reqInput = async (name: string, response: string) =>
      writeInput(name, {
        id_namespace: "REQ-CORE",
        type: "ubiquitous",
        response,
        acceptance_na: true,
        acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
      });
    const tasksPayload = {
      based_on: { spec: 2 },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          drives: ["REQ-CORE-001"],
          tests: ["e2e.amendTasks"],
          status: "pending",
          depends_on: [],
          labels: [],
          execution: {
            red: { applicability: "must", status: "pending", evidence_refs: [] },
            implement: { applicability: "must", status: "pending", evidence_refs: [] },
            refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
          },
        },
      ],
    };

    // ── drive a standard feature to a locked EXECUTE.work ───────────────
    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E amend-tasks back-edge" },
      intent: "exercise the amend-tasks finding back-edge (back-edge-only)",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    await step("spec add-req", [
      "spec", "add-req",
      "--input", await reqInput("req1.json", "the system shall complete the amend-tasks smoke"),
      "--feature", F,
    ]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    await step("tasks submit", [
      "tasks", "submit", "--input",
      await writeInput("tasks-v2.json", tasksPayload),
      "--feature", F,
    ]);
    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "spec and task graph complete for the lock", "--feature", F,
    ]);
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);

    // ── snapshot the task graph before the back-edge ────────────────────
    const before = await step("status before back-edge", ["status", "--feature", F]);
    expect(before.state.sub_state).toBe("EXECUTE.work");
    const iterationBefore = before.state.iteration;
    const tasksBefore = await step("tasks list before", ["tasks", "list", "--feature", F]);

    // ── amend-tasks back-edge: cursor → EXECUTE.work, iteration +1 ───────
    const raised = await step("finding raise amend-tasks", [
      "finding", "raise", "--category", "new-scope", "--action", "amend-tasks",
      "--summary", "execution surfaced a missing task step", "--feature", F,
    ]);
    expect(raised.id).toMatch(/^FND-\d{3,}$/);
    expect(raised.back_edge.to).toBe("EXECUTE.work");

    const after = await step("status after back-edge", ["status", "--feature", F]);
    expect(after.state.sub_state).toBe("EXECUTE.work");
    expect(after.state.iteration).toBe(iterationBefore + 1);

    // ── the amend-tasks finding stays open (SC1 is back-edge-only) ───────
    const findings = await step("finding list", ["finding", "list", "--feature", F]);
    const fnd = findings.findings.find((f: { id: string }) => f.id === raised.id);
    expect(fnd.status).toBe("open");

    // ── the journal carries the atomic 2-entry back-edge batch ──────────
    const journal = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const entries = journal.trim().split("\n").map((l) => JSON.parse(l));
    const tail = entries.slice(-2);
    expect(tail[0].kind).toBe("finding:raised");
    expect(tail[0].payload.action).toBe("amend-tasks");
    expect(tail[1].kind).toBe("event:phase_advanced");
    expect(tail[1].payload.back_edge).toEqual({
      action: "amend-tasks",
      finding_id: raised.id,
    });
    expect(tail[1].payload.to).toBe("EXECUTE.work");
    expect(tail[0].batch_id).toBe(tail[1].batch_id);
    // No event:tasks_amended anywhere — SC1 does not amend the graph.
    expect(entries.some((e: { kind: string }) => e.kind === "event:tasks_amended")).toBe(false);

    // ── the task graph is UNCHANGED across the back-edge ────────────────
    const tasksAfter = await step("tasks list after", ["tasks", "list", "--feature", F]);
    expect(tasksAfter).toEqual(tasksBefore);
  });

  // SCEN-E2E-021 — see docs/e2e-scenarios.md (Phase 11 Item 3 SC2).
  // `finding raise --action fix-impl` co-emits the atomic 3-entry batch
  // [finding:raised, event:task_step_reset, event:phase_advanced(
  // back_edge → EXECUTE.work)]. The reset returns the target task's
  // implement step to `pending` and reopens the task to `in_progress`;
  // cursor → EXECUTE.work, iteration +1, the finding stays open, and
  // prior execution history (the passed red step) is not erased.
  test("SCEN-E2E-021 — fix-impl loop resets the implement step and reopens the task without erasing history", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-fix-impl";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    // ── drive a standard feature to a locked EXECUTE.work with a graph ──
    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E fix-impl back-edge" },
      intent: "exercise the fix-impl finding back-edge and step reset",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    await step("spec add-req", [
      "spec", "add-req",
      "--input", await writeInput("req.json", {
        id_namespace: "REQ-CORE",
        type: "ubiquitous",
        response: "the system shall complete the fix-impl smoke",
        acceptance_na: true,
        acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
      }),
      "--feature", F,
    ]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    await step("tasks submit", [
      "tasks", "submit", "--input",
      await writeInput("tasks.json", {
        based_on: { spec: 2 },
        tasks: [
          {
            id: "T-001",
            kind: "behavioral",
            drives: ["REQ-CORE-001"],
            tests: ["e2e.fixImpl"],
            status: "pending",
            depends_on: [],
            labels: [],
            execution: {
              red: { applicability: "must", status: "pending", evidence_refs: [] },
              implement: { applicability: "must", status: "pending", evidence_refs: [] },
              refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
            },
          },
        ],
      }),
      "--feature", F,
    ]);
    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "spec and task graph complete for the lock", "--feature", F,
    ]);
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);

    // ── run the task's must steps so it auto-promotes to done ───────────
    await step("claim T-001", ["tasks", "claim", "T-001", "--feature", F]);
    for (const stepName of ["red", "implement"]) {
      await step(`step start ${stepName}`, [
        "tasks", "step", "start", "--task", "T-001", "--step", stepName, "--feature", F,
      ]);
      await step(`step done ${stepName}`, [
        "tasks", "step", "done", "--task", "T-001", "--step", stepName,
        "--result", "passed", "--feature", F,
      ]);
    }
    const beforeTasks = await step("tasks list before", ["tasks", "list", "--feature", F]);
    const t001Before = beforeTasks.tasks.find((t: { id: string }) => t.id === "T-001");
    expect(t001Before.status).toBe("done");
    expect(t001Before.steps.red.status).toBe("passed");
    expect(t001Before.steps.implement.status).toBe("passed");
    const iterBefore = (await step("status before", ["status", "--feature", F])).state.iteration;

    // ── fix-impl back-edge: an open finding targeting {T-001, implement} ─
    const raised = await step("finding raise fix-impl", [
      "finding", "raise", "--category", "impl-defect", "--action", "fix-impl",
      "--summary", "the implementation regressed against REQ-CORE-001",
      "--target-task", "T-001", "--target-step", "implement",
      "--feature", F,
    ]);
    expect(raised.id).toMatch(/^FND-\d{3,}$/);
    expect(raised.back_edge.to).toBe("EXECUTE.work");

    // ── the journal carries the atomic 3-entry batch in order ───────────
    const journal = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const entries = journal.trim().split("\n").map((l) => JSON.parse(l));
    const tail = entries.slice(-3);
    expect(tail.map((e) => e.kind)).toEqual([
      "finding:raised",
      "event:task_step_reset",
      "event:phase_advanced",
    ]);
    expect(tail[0].payload.action).toBe("fix-impl");
    expect(tail[1].payload).toEqual({
      task_id: "T-001",
      step: "implement",
      finding_id: raised.id,
    });
    expect(tail[2].payload.to).toBe("EXECUTE.work");
    expect(tail[2].payload.back_edge).toEqual({ action: "fix-impl", finding_id: raised.id });
    expect(tail[0].batch_id).toBe(tail[1].batch_id);
    expect(tail[1].batch_id).toBe(tail[2].batch_id);

    // ── cursor → EXECUTE.work, iteration +1 ─────────────────────────────
    const after = await step("status after", ["status", "--feature", F]);
    expect(after.state.sub_state).toBe("EXECUTE.work");
    expect(after.state.iteration).toBe(iterBefore + 1);

    // ── the target task reopened to in_progress, implement step pending ─
    const afterTasks = await step("tasks list after", ["tasks", "list", "--feature", F]);
    const t001After = afterTasks.tasks.find((t: { id: string }) => t.id === "T-001");
    expect(t001After.status).toBe("in_progress");
    expect(t001After.steps.implement.status).toBe("pending");
    // prior execution history is NOT erased — the passed red step survives.
    expect(t001After.steps.red.status).toBe("passed");

    // ── the fix-impl finding stays open (it is a repair loop) ───────────
    const findings = await step("finding list", ["finding", "list", "--feature", F]);
    const fnd = findings.findings.find((f: { id: string }) => f.id === raised.id);
    expect(fnd.status).toBe("open");
  });

  // SCEN-E2E-022 — see docs/e2e-scenarios.md (Phase 11 Item 3 SC3).
  // `finding raise --action fix-test` co-emits the same atomic 3-entry batch
  // as fix-impl [finding:raised, event:task_step_reset, event:phase_advanced(
  // back_edge → EXECUTE.work)], reusing the SC2 event:task_step_reset kind
  // with step="red". The reset returns the target task's `red` step to
  // `pending` and reopens the task to `in_progress`; cursor → EXECUTE.work,
  // iteration +1, the finding stays open, and prior execution history (the
  // passed `implement` step) is not erased.
  test("SCEN-E2E-022 — fix-test loop resets the red step and reopens the task without erasing history", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-fix-test";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    // ── drive a standard feature to a locked EXECUTE.work with a graph ──
    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E fix-test back-edge" },
      intent: "exercise the fix-test finding back-edge and step reset",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    await step("spec add-req", [
      "spec", "add-req",
      "--input", await writeInput("req.json", {
        id_namespace: "REQ-CORE",
        type: "ubiquitous",
        response: "the system shall complete the fix-test smoke",
        acceptance_na: true,
        acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
      }),
      "--feature", F,
    ]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    await step("tasks submit", [
      "tasks", "submit", "--input",
      await writeInput("tasks.json", {
        based_on: { spec: 2 },
        tasks: [
          {
            id: "T-001",
            kind: "behavioral",
            drives: ["REQ-CORE-001"],
            tests: ["e2e.fixTest"],
            status: "pending",
            depends_on: [],
            labels: [],
            execution: {
              red: { applicability: "must", status: "pending", evidence_refs: [] },
              implement: { applicability: "must", status: "pending", evidence_refs: [] },
              refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
            },
          },
        ],
      }),
      "--feature", F,
    ]);
    await step("gate spec-lock", [
      "gate", "decide", "spec-lock", "--approve",
      "--reason", "spec and task graph complete for the lock", "--feature", F,
    ]);
    await step("advance EXECUTE.work", ["advance", "EXECUTE.work", "--feature", F]);

    // ── run the task's must steps so it auto-promotes to done ───────────
    await step("claim T-001", ["tasks", "claim", "T-001", "--feature", F]);
    for (const stepName of ["red", "implement"]) {
      await step(`step start ${stepName}`, [
        "tasks", "step", "start", "--task", "T-001", "--step", stepName, "--feature", F,
      ]);
      await step(`step done ${stepName}`, [
        "tasks", "step", "done", "--task", "T-001", "--step", stepName,
        "--result", "passed", "--feature", F,
      ]);
    }
    const beforeTasks = await step("tasks list before", ["tasks", "list", "--feature", F]);
    const t001Before = beforeTasks.tasks.find((t: { id: string }) => t.id === "T-001");
    expect(t001Before.status).toBe("done");
    expect(t001Before.steps.red.status).toBe("passed");
    expect(t001Before.steps.implement.status).toBe("passed");
    const iterBefore = (await step("status before", ["status", "--feature", F])).state.iteration;

    // ── fix-test back-edge: an open finding targeting {T-001, red} ──────
    const raised = await step("finding raise fix-test", [
      "finding", "raise", "--category", "test-defect", "--action", "fix-test",
      "--summary", "the red test asserts the wrong contract for REQ-CORE-001",
      "--target-task", "T-001", "--target-step", "red",
      "--feature", F,
    ]);
    expect(raised.id).toMatch(/^FND-\d{3,}$/);
    expect(raised.back_edge.to).toBe("EXECUTE.work");

    // ── the journal carries the atomic 3-entry batch in order ───────────
    const journal = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const entries = journal.trim().split("\n").map((l) => JSON.parse(l));
    const tail = entries.slice(-3);
    expect(tail.map((e) => e.kind)).toEqual([
      "finding:raised",
      "event:task_step_reset",
      "event:phase_advanced",
    ]);
    expect(tail[0].payload.action).toBe("fix-test");
    expect(tail[1].payload).toEqual({
      task_id: "T-001",
      step: "red",
      finding_id: raised.id,
    });
    expect(tail[2].payload.to).toBe("EXECUTE.work");
    expect(tail[2].payload.back_edge).toEqual({ action: "fix-test", finding_id: raised.id });
    expect(tail[0].batch_id).toBe(tail[1].batch_id);
    expect(tail[1].batch_id).toBe(tail[2].batch_id);

    // ── cursor → EXECUTE.work, iteration +1 ─────────────────────────────
    const after = await step("status after", ["status", "--feature", F]);
    expect(after.state.sub_state).toBe("EXECUTE.work");
    expect(after.state.iteration).toBe(iterBefore + 1);

    // ── the target task reopened to in_progress, red step pending ───────
    const afterTasks = await step("tasks list after", ["tasks", "list", "--feature", F]);
    const t001After = afterTasks.tasks.find((t: { id: string }) => t.id === "T-001");
    expect(t001After.status).toBe("in_progress");
    expect(t001After.steps.red.status).toBe("pending");
    // prior execution history is NOT erased — the passed implement step survives.
    expect(t001After.steps.implement.status).toBe("passed");

    // ── the fix-test finding stays open (it is a repair loop) ───────────
    const findings = await step("finding list", ["finding", "list", "--feature", F]);
    const fnd = findings.findings.find((f: { id: string }) => f.id === raised.id);
    expect(fnd.status).toBe("open");
  });

  // ── Item 2 — archive / abandon session-terminal commands ────────────
  test("SCEN-E2E-035 — archive terminal: started session → DONE.archived", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-archive";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step } = makeCli(dir, ENV);

    const started = await step("start", ["start", F, "--ceremony", "standard"]);
    expect(started.sub_state).toBe("TRIAGE.score");

    const archived = await step("archive", [
      "archive", "--reason", "spike concluded; nothing to deliver", "--feature", F,
    ]);
    expect(archived.ok).toBe(true);
    expect(archived.from).toBe("TRIAGE.score");
    expect(archived.to).toBe("DONE.archived");
    expect(archived.sub_state).toBe("DONE.archived");
    expect(archived.actor).toBe("human:e2e@test.invalid");

    const status = await step("status", ["status", "--feature", F]);
    expect(status.state?.sub_state ?? status.sub_state).toBe("DONE.archived");
  });

  test("SCEN-E2E-036 — abandon terminal: started session → DONE.abandoned", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-abandon";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step } = makeCli(dir, ENV);

    const started = await step("start", ["start", F, "--ceremony", "standard"]);
    expect(started.sub_state).toBe("TRIAGE.score");

    const abandoned = await step("abandon", [
      "abandon", "--reason", "no value; dropping the feature", "--feature", F,
    ]);
    expect(abandoned.ok).toBe(true);
    expect(abandoned.from).toBe("TRIAGE.score");
    expect(abandoned.to).toBe("DONE.abandoned");
    expect(abandoned.sub_state).toBe("DONE.abandoned");
    expect(abandoned.actor).toBe("human:e2e@test.invalid");

    const status = await step("status", ["status", "--feature", F]);
    expect(status.state?.sub_state ?? status.sub_state).toBe("DONE.abandoned");
  });

  test("SCEN-E2E-037 — spike convert archives the session and records to_feature", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-spike-convert";
    const ENV = { LOAF_USER: "e2e@test.invalid" };
    const { step, writeInput } = makeCli(dir, ENV);

    await step("start", ["start", F, "--ceremony", "standard"]);
    await step("advance TRIAGE.confirm", ["advance", "TRIAGE.confirm", "--feature", F]);
    await step("advance SPEC.proposal", ["advance", "SPEC.proposal", "--feature", F]);
    await step("spec init", ["spec", "init", "--feature", F]);
    const submitInput = await writeInput("submit.json", {
      feature: { id: "F-001", name: "E2E spike convert" },
      intent: "exercise the spike-to-feature conversion exit",
      adr_refs: [],
      needs_clarification: [],
    });
    await step("spec submit", ["spec", "submit", "--input", submitInput, "--feature", F]);
    const reqInput = await writeInput("req.json", {
      id_namespace: "REQ-CORE",
      type: "ubiquitous",
      response: "the system shall complete the spike convert smoke",
      acceptance_na: true,
      acceptance_na_reason: "exercised by this end-to-end lifecycle integration test",
    });
    await step("spec add-req", ["spec", "add-req", "--input", reqInput, "--feature", F]);
    await step("advance SPEC.spec", ["advance", "SPEC.spec", "--feature", F]);
    await step("advance SPEC.plan", ["advance", "SPEC.plan", "--feature", F]);
    await step("advance SPEC.design", ["advance", "SPEC.design", "--feature", F]);
    const st = await step("status pre-tasks", ["status", "--feature", F]);
    const specVersion: number = st.state?.spec_version ?? st.spec_version;
    const tasksFile = await writeInput("tasks.json", {
      based_on: { spec: specVersion },
      tasks: [
        {
          id: "T-001",
          kind: "spike",
          drives: ["REQ-CORE-001"],
          no_test_rationale: "explore the approach; a spike is not shipped",
          status: "pending",
          depends_on: [],
          labels: [],
          execution: {
            explore: { applicability: "must", status: "pending", evidence_refs: [] },
            prototype: { applicability: "must", status: "pending", evidence_refs: [] },
            record: { applicability: "must", status: "pending", evidence_refs: [] },
          },
        },
      ],
    });
    await step("tasks submit", ["tasks", "submit", "--input", tasksFile, "--feature", F]);

    // ── spike convert: record-only exit — archives the session, records to_feature ──
    const converted = await step("spike convert", [
      "spike", "convert",
      "--to-feature", "F-002",
      "--reason", "spike learnings carry forward to F-002",
      "--feature", F,
    ]);
    expect(converted.ok).toBe(true);
    expect(converted.from).toBe("SPEC.design");
    expect(converted.to).toBe("DONE.archived");
    expect(converted.to_feature).toBe("F-002");
    expect(converted.sub_state).toBe("DONE.archived");
    expect(converted.actor).toBe("human:e2e@test.invalid");

    const status = await step("status", ["status", "--feature", F]);
    expect(status.state?.sub_state ?? status.sub_state).toBe("DONE.archived");

    // The journal carries the spike:converted record entry, and the terminal
    // session:archived is the final entry (the cursor mover, ordered last).
    const journal = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const entries = journal.trim().split("\n").map((l) => JSON.parse(l));
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toContain("spike:converted");
    expect(kinds[kinds.length - 1]).toBe("session:archived");
    const convEntry = entries.find((e) => e.kind === "spike:converted");
    expect(convEntry.payload.to_feature).toBe("F-002");
    expect(convEntry.payload.reason).toBe("spike learnings carry forward to F-002");
    expect(convEntry.actor).toBe("human:e2e@test.invalid");
  });
});
