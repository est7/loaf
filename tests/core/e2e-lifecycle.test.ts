// E2E — full worker lifecycle driven purely through the CLI.
//
// task_plan.md §15 done-when 1+2: a feature must run start -> deliver
// end-to-end through `loaf` commands. Existing cli.test.ts seed helpers
// cheat — they emit `event:phase_advanced` via raw mutate and only use the
// CLI for tasks. This file uses ONLY runCli for every transition, so it is
// the first true integration proof of the worker workflow.
//
// Scenario inventory: docs/e2e-scenarios.md. This file currently implements
// SCEN-E2E-001 (the §15-close standard happy path).
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

// Per-feature CLI driver. `step` runs a `loaf` command (always --json, env
// injected) and throws a labelled error on non-zero exit so the failing
// scenario step is unambiguous; it returns parsed JSON stdout (or null).
// `writeInput` writes a JSON input file into the feature dir.
function makeCli(dir: string, env: Record<string, string | undefined>) {
  const step = async (label: string, argv: string[]): Promise<any> => {
    const r = await runCli([...argv, "--feature-dir", dir, "--json"], { env });
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

describe("E2E — full worker lifecycle (standard ceremony)", () => {
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
    await step("tasks submit", ["tasks", "submit", tasksFile, "--feature", F]);

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
    await step("tasks add T-001", ["tasks", "add", t1, "--feature", F]);
    const t2 = await writeInput("task2.json", {
      kind: "structural",
      no_test_rationale: "extract a shared helper once T-001 lands; no behavior change",
      depends_on: ["T-001"],
    });
    await step("tasks add T-002", ["tasks", "add", t2, "--feature", F]);

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
    await step("tasks add visual-ui", ["tasks", "add", tVisual, "--feature", F]);
    const tDocs = await writeInput("task-docs.json", {
      kind: "docs",
      no_test_rationale: "documentation task; correctness is verified by peer review",
    });
    await step("tasks add docs", ["tasks", "add", tDocs, "--feature", F]);
    const tChore = await writeInput("task-chore.json", {
      kind: "chore",
      no_test_rationale: "mechanical chore; no behavior change to test",
    });
    await step("tasks add chore", ["tasks", "add", tChore, "--feature", F]);

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
    await step("tasks submit", ["tasks", "submit", tasksFile, "--feature", F]);
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
      ["deliver", "--feature", F, "--feature-dir", dir, "--json"],
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
    await step("tasks submit", ["tasks", "submit", tasksFile, "--feature", F]);

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
});
