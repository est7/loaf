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

describe("E2E — full worker lifecycle (standard ceremony)", () => {
  // SCEN-E2E-001 — see docs/e2e-scenarios.md
  test("SCEN-E2E-001 — standard feature runs start -> deliver via the CLI", async () => {
    const dir = await tmpFeatureDir();
    const F = "e2e-std";
    const ENV = { LOAF_USER: "e2e@test.invalid" };

    // Run a CLI step; throw a labelled error on non-zero exit so the first
    // gap is unambiguous. Returns parsed JSON stdout (or null).
    const step = async (label: string, argv: string[]): Promise<any> => {
      const r = await runCli([...argv, "--feature-dir", dir, "--json"], { env: ENV });
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
});
