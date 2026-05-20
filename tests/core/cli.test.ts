// Stage 5+ / audit r1 Blocker #7 — CLI smoke tests.
//
// Drives the loaf CLI through the start / advance / status surface to
// verify the full transactional path end-to-end (CLI → mutate → journal).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import { LOAF_DOCS_URL, LOAF_ISSUE_URL } from "../../src/core/cli-runtime.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-cli-test-"));
}

async function runCli(
  argv: string[],
  opts: { env?: Record<string, string | undefined> } = {},
): Promise<{ exit: number; stdout: string; stderr: string }> {
  // Capture stdout / stderr writes during main(); restore after.
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  // Scoped env injection for actor-resolver tests. Only touched keys are
  // backed up + restored so the global process.env is not wholesale
  // replaced (codex r31 Q5.1). Tests must not be marked concurrent —
  // process.env is global.
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

describe("loaf CLI — Blocker #7 MVP surface", () => {
  test("loaf start <feature> emits session:started + JSON output", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli([
      "start", "auth-refresh",
      "--ceremony", "standard",
      "--feature-dir", dir,
      "--json",
    ]);
    expect(result.exit).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; ceremony_label: string; sub_state: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.ceremony_label).toBe("standard");
    expect(parsed.sub_state).toBe("TRIAGE.score");

    // Journal landed on disk.
    const journal = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    expect(journal.trim().split("\n")).toHaveLength(1);
  });

  test("loaf advance moves the cursor (TRIAGE.score → TRIAGE.confirm)", async () => {
    const dir = await tmpFeatureDir();
    const startRes = await runCli([
      "start", "auth-refresh",
      "--ceremony", "standard",
      "--feature-dir", dir,
      "--json",
    ]);
    expect(startRes.exit).toBe(0);

    const adv = await runCli([
      "advance", "TRIAGE.confirm",
      "--feature", "auth-refresh",
      "--feature-dir", dir,
      "--json",
    ]);
    expect(adv.exit).toBe(0);
    const parsed = JSON.parse(adv.stdout) as { sub_state: string };
    expect(parsed.sub_state).toBe("TRIAGE.confirm");
  });

  test("loaf advance with illegal edge → exit 2 + TRANSITION_ILLEGAL", async () => {
    const dir = await tmpFeatureDir();
    await runCli([
      "start", "auth-refresh",
      "--ceremony", "standard",
      "--feature-dir", dir,
      "--json",
    ]);

    const adv = await runCli([
      "advance", "DONE.delivered",
      "--feature", "auth-refresh",
      "--feature-dir", dir,
      "--json",
    ]);
    expect(adv.exit).toBe(2);
    expect(adv.stderr).toMatch(/TRANSITION_ILLEGAL/);
  });

  test("loaf status reads the current cursor + projection counts", async () => {
    const dir = await tmpFeatureDir();
    await runCli([
      "start", "auth-refresh",
      "--ceremony", "standard",
      "--feature-dir", dir,
      "--json",
    ]);

    const status = await runCli([
      "status",
      "--feature", "auth-refresh",
      "--feature-dir", dir,
      "--json",
    ]);
    expect(status.exit).toBe(0);
    const parsed = JSON.parse(status.stdout) as { state: { sub_state: string }; tail_seq: number };
    expect(parsed.state.sub_state).toBe("TRIAGE.score");
    expect(parsed.tail_seq).toBe(0);
  });

  test("URL stamps are non-empty (build-time define applied or fallback sentinel)", () => {
    expect(LOAF_DOCS_URL.length).toBeGreaterThan(0);
    expect(LOAF_ISSUE_URL.length).toBeGreaterThan(0);
    // In dev/test runs the sentinel ends in `.invalid`; in production
    // builds tsdown rewrites it. Either way, must not be empty.
  });

  test("invalid ceremony preset → exit 2 + INVALID_PRESET", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli([
      "start", "bogus",
      "--ceremony", "unicorn",
      "--feature-dir", dir,
    ]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toMatch(/INVALID_PRESET/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 1.B sub-cycle 4 — loaf gate decide spec-lock (MVP, codex r31 Option B)
// ─────────────────────────────────────────────────────────────────────────

import { mutate as mutateRaw, mutateBatch as mutateBatchRaw } from "../../src/core/journal-mutate.js";
import { promises as fsP } from "node:fs";
import type { Ceremony } from "../../src/core/journal-entry.js";
import type { Snapshot } from "../../src/core/reducer.js";

const STANDARD_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip" as const,
  strict_drift_check: false,
};

/**
 * Seed a feature dir to SPEC.design with a parser-valid spec.md and a
 * planned task graph (matching the gate-passing setup in journal-mutate
 * test H). Uses raw mutate/mutateBatch (CLI surface for spec/tasks
 * commands lands in later slices). Returns the feature dir path.
 *
 * Slice 1.D sub-cycle 4: accepts an optional ceremony override so the
 * E2E lifecycle tests can drive a deep walk from the same shared
 * fixture. Default stays STANDARD_CEREMONY for the 9 pre-existing
 * callers (backward compatible).
 */
async function seedFeatureAtSpecDesign(
  dir: string,
  ceremony: Ceremony = STANDARD_CEREMONY,
): Promise<void> {
  // Write spec.md to disk first — evaluateSpecLock reads from this.
  await fsP.writeFile(
    path.join(dir, "spec.md"),
    `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: OAuth token refresh
intent: users should not perceive auth recovery flows in flight
adr_refs: []
requirements:
  - id: REQ-AUTH-001
    type: ubiquitous
    response: the system shall do something measurable here
    acceptance_na: true
    acceptance_na_reason: subjective UX validated via manual testing scope
scenarios: []
needs_clarification: []
---

## Why
prose body here
`,
  );

  // Boot session via raw mutate (CLI start does this for us, but we want
  // explicit control over the actor and intermediate state).
  let snapshot = (await import("../../src/core/reducer.js")).initialSnapshot();
  let tailSeq = -1;
  const boot = await mutateRaw(
    {
      at: "2026-05-15T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "auth-refresh",
        ceremony,
      },
    },
    { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
  );
  if (!boot.ok) throw new Error(`seed boot failed: ${boot.message}`);
  snapshot = boot.snapshot;
  tailSeq++;

  // Walk to SPEC.proposal.
  for (const [from, to] of [
    ["TRIAGE.score", "TRIAGE.confirm"],
    ["TRIAGE.confirm", "SPEC.proposal"],
  ] as Array<[string, string]>) {
    const r = await mutateRaw(
      {
        at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: from as any, to: to as any },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!r.ok) throw new Error(`seed walk failed: ${r.message}`);
    snapshot = r.snapshot;
    tailSeq++;
  }

  // Emit spec_submitted + companion REQ batch.
  const submitBatch = await mutateBatchRaw(
    [
      {
        at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
        actor: "human:seed@test.invalid",
        entry_schema_version: 1,
        kind: "event:spec_submitted",
        payload: {
          spec_version: 1,
          feature: { id: "F-001", name: "OAuth token refresh" },
          intent: "users should not perceive auth recovery flows in flight",
          adr_refs: [],
          needs_clarification: [],
        },
      },
      {
        at: new Date(2026, 4, 15, 10, 0, tailSeq + 2).toISOString(),
        actor: "human:seed@test.invalid",
        entry_schema_version: 1,
        kind: "event:spec_req_added",
        payload: {
          spec_version: 1,
          req: {
            id: "REQ-AUTH-001",
            type: "ubiquitous",
            response: "the system shall do something measurable here",
            acceptance_na: true,
            acceptance_na_reason: "subjective UX validated via manual testing scope",
          },
        },
      },
    ],
    { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
  );
  if (!submitBatch.ok) throw new Error(`seed submit failed: ${submitBatch.message}`);
  snapshot = submitBatch.snapshot;
  tailSeq += 2;

  // Walk to SPEC.design.
  for (const [from, to] of [
    ["SPEC.proposal", "SPEC.spec"],
    ["SPEC.spec", "SPEC.plan"],
    ["SPEC.plan", "SPEC.design"],
  ] as Array<[string, string]>) {
    const r = await mutateRaw(
      {
        at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: from as any, to: to as any },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!r.ok) throw new Error(`seed walk2 failed: ${r.message}`);
    snapshot = r.snapshot;
    tailSeq++;
  }

  // Plan tasks at SPEC.design via `loaf tasks submit` CLI (Slice 2 SC2 —
  // closes raw-mutate gap for the initial task graph; codex r57 NB1
  // continuation of "stop coupling to internal mutate walks").
  const tasksFile = path.join(dir, ".tasks-seed.json");
  await fsP.writeFile(
    tasksFile,
    JSON.stringify({
      based_on: { spec: 1 },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          drives: ["REQ-AUTH-001"],
          tests: ["TokenCoord.refreshOnce"],
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
  );
  const submitResult = await runCli(
    [
      "tasks", "submit", tasksFile,
      "--feature", "auth-refresh",
      "--feature-dir", dir,
      "--json",
    ],
  );
  if (submitResult.exit !== 0) {
    throw new Error(`seed loaf tasks submit failed: ${submitResult.stderr || submitResult.stdout}`);
  }
  await fsP.unlink(tasksFile).catch(() => {}); // ignore cleanup errors
}

describe("loaf gate decide spec-lock — Slice 1.B sub-cycle 4 (MVP)", () => {
  test("approve happy path: dual-entry batch + spec_locked + cursor → EXECUTE.plan", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);

    const result = await runCli(
      [
        "gate", "decide", "spec-lock",
        "--approve",
        "--reason", "ready to execute",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.gate).toBe("spec-lock");
    expect(out.decision).toBe("approved");
    expect(out.from).toBe("SPEC.design");
    expect(out.to).toBe("EXECUTE.plan");
    expect(out.actor).toBe("human:tester@example.invalid");
    expect(out.sub_state).toBe("EXECUTE.plan");
    expect(out.spec_locked).toBe(true);

    // Journal sanity: last two entries share a batch_id, kinds correct.
    const journal = await fsP.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lines = journal.trim().split("\n").map((l) => JSON.parse(l));
    const tail2 = lines.slice(-2);
    expect(tail2[0].kind).toBe("gate:decided");
    expect(tail2[1].kind).toBe("event:phase_advanced");
    expect(tail2[0].batch_id).toBeDefined();
    expect(tail2[0].batch_id).toBe(tail2[1].batch_id);
  });

  test("reject happy path: single entry + spec_locked stays false", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);

    const result = await runCli(
      [
        "gate", "decide", "spec-lock",
        "--reject",
        "--reason", "needs more clarification",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.decision).toBe("rejected");
    expect(out.spec_locked).toBe(false);
    expect(out.sub_state).toBe("SPEC.design");
  });

  test("--approve + --reject (mutex fail) → USAGE error, stdout empty", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli(
      [
        "gate", "decide", "spec-lock",
        "--approve", "--reject",
        "--reason", "x",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/USAGE/);
  });

  test("neither --approve nor --reject (mutex fail) → USAGE error", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli(
      [
        "gate", "decide", "spec-lock",
        "--reason", "x",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );
    expect(result.exit).toBe(2);
    expect(result.stderr).toMatch(/USAGE/);
  });

  test("approve fails when spec.md missing — JSON failure goes to stderr, stdout empty (codex r31 Q4.1)", async () => {
    const dir = await tmpFeatureDir();
    // Seed a session at SPEC.design WITHOUT writing spec.md so the gate
    // evaluator's check 1 fires SPEC_NOT_FOUND. We can't fully reuse
    // seedFeatureAtSpecDesign because it writes spec.md; build a minimal
    // path that walks to SPEC.design without spec_submitted (spec-lock
    // check 3 will hit TASKS_NOT_PLANNED first, then short-circuit).
    let snapshot = (await import("../../src/core/reducer.js")).initialSnapshot();
    let tailSeq = -1;
    const boot = await mutateRaw(
      {
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!boot.ok) throw new Error(`boot: ${boot.message}`);
    snapshot = boot.snapshot;
    tailSeq++;
    for (const [from, to] of [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
    ] as Array<[string, string]>) {
      const r = await mutateRaw(
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: from as any, to: to as any },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
      );
      if (!r.ok) throw new Error(`walk: ${r.message}`);
      snapshot = r.snapshot;
      tailSeq++;
    }

    const result = await runCli(
      [
        "gate", "decide", "spec-lock",
        "--approve",
        "--reason", "trying",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe(""); // codex r31 Q4.1 pin
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.ok).toBe(false);
    expect(errJson.code).toBe("GATE_PRECONDITION_VIOLATION");
    expect(errJson.detail.gate).toBe("spec-lock");
    expect(Array.isArray(errJson.detail.checks)).toBe(true);
    // check 1 SPEC_FRONTMATTER_INVALID is the first failure since spec.md missing
    const check1 = errJson.detail.checks.find((c: { check: number }) => c.check === 1);
    expect(check1?.code).toBe("SPEC_FRONTMATTER_INVALID");
    expect(check1?.detail?.subcode).toBe("SPEC_NOT_FOUND");
  });

  test("unknown gate name (deploy-lock) → GATE_NOT_IMPLEMENTED, stdout empty", async () => {
    // Slice 1.C sub-cycle 6 update: verify-accept is now wired (was the
    // unsupported probe pre-1.C). The closed GateName enum {spec-lock,
    // verify-accept} for v0.1.0 means any third name (e.g. a hypothetical
    // future deploy-lock) still triggers GATE_NOT_IMPLEMENTED here.
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);

    const result = await runCli(
      [
        "gate", "decide", "deploy-lock",
        "--approve",
        "--reason", "x",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("GATE_NOT_IMPLEMENTED");
    expect(errJson.detail.gate).toBe("deploy-lock");
  });

  test("LOAF_USER unset + non-interactive → NO_HUMAN_ACTOR, stdout empty", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);

    // Don't set LOAF_USER. vitest runs with non-interactive stdin so
    // actor-resolver's interactive-git fallback is disabled.
    const result = await runCli(
      [
        "gate", "decide", "spec-lock",
        "--approve",
        "--reason", "x",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env: { LOAF_USER: undefined } },
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("NO_HUMAN_ACTOR");
  });

  test("text-mode failure renders per-check lines on stderr, stdout empty", async () => {
    const dir = await tmpFeatureDir();
    // Same minimal-no-spec.md path as the JSON failure test
    let snapshot = (await import("../../src/core/reducer.js")).initialSnapshot();
    let tailSeq = -1;
    const boot = await mutateRaw(
      {
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!boot.ok) throw new Error(`boot: ${boot.message}`);
    snapshot = boot.snapshot;
    tailSeq++;
    for (const [from, to] of [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
    ] as Array<[string, string]>) {
      const r = await mutateRaw(
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: from as any, to: to as any },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
      );
      if (!r.ok) throw new Error(`walk: ${r.message}`);
      snapshot = r.snapshot;
      tailSeq++;
    }

    const result = await runCli(
      [
        "gate", "decide", "spec-lock",
        "--approve",
        "--reason", "x",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/GATE_PRECONDITION_VIOLATION/);
    expect(result.stderr).toMatch(/\[check 1\] SPEC_FRONTMATTER_INVALID/);
  });

  test("missing --reason → CommanderError USAGE-style fail (exit 2)", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli(
      [
        "gate", "decide", "spec-lock",
        "--approve",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );
    expect(result.exit).toBe(2);
    expect(result.stderr).toMatch(/--reason|reason/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Slice 1.C sub-cycle 6 — loaf gate decide verify-accept MVP
// ────────────────────────────────────────────────────────────────────────

/**
 * Extend seedFeatureAtSpecDesign + advance through spec-lock approve to
 * EXECUTE.plan, then walk through EXECUTE.{work, done} + VERIFY.{plan,
 * run, review, acceptance, visual, accept} so verify-accept gate:decided
 * is sub_state-legal. Builds on the spec-lock seed (which also writes
 * spec.md + plans tasks) so the verify-accept happy path can find both.
 */
// F-016: abandon every non-final planted task so the EXECUTE.work →
// EXECUTE.done edge passes the all-tasks-final preflight guard. These
// seeds are minimal fixtures for gate / deliver / settle command
// mechanics — they do not exercise task execution, so the cheapest
// terminal status that keeps verify-accept vacuously passing (abandoned
// tasks are skipped by both deriveVerifyApplicability and check 4) is
// `abandoned`. Raw-mutate channel; caller must be at EXECUTE.work.
async function seedAbandonPlantedTasks(
  dir: string,
  snapshot: Snapshot,
  tailSeq: number,
): Promise<{ snapshot: Snapshot; tailSeq: number }> {
  for (const task of snapshot.tasks) {
    if (task.status === "done" || task.status === "abandoned") continue;
    const r = await mutateRaw(
      {
        at: new Date(2026, 4, 15, 11, 0, tailSeq + 1).toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:task_abandoned",
        payload: { task_id: task.id },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!r.ok) throw new Error(`seed task abandon ${task.id} failed: ${r.message}`);
    snapshot = r.snapshot;
    tailSeq++;
  }
  return { snapshot, tailSeq };
}

// F-016: drive ONE planted task to status=done — event:task_claimed +
// an event:task_step_done for each `must` step. Used where a seed needs
// a non-abandoned terminal task (the spike-block fixture, whose spike
// must stay non-abandoned to trigger DELIVER_SPIKE_TASKS). Raw-mutate
// channel; caller must be at EXECUTE.work.
async function seedCompleteTask(
  dir: string,
  snapshot: Snapshot,
  tailSeq: number,
  taskId: string,
): Promise<{ snapshot: Snapshot; tailSeq: number }> {
  const task = snapshot.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`seedCompleteTask: task ${taskId} not in snapshot`);
  const claim = await mutateRaw(
    {
      at: new Date(2026, 4, 15, 11, 0, tailSeq + 1).toISOString(),
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "event:task_claimed",
      payload: { task_id: taskId },
    },
    { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
  );
  if (!claim.ok) throw new Error(`seedCompleteTask claim ${taskId} failed: ${claim.message}`);
  snapshot = claim.snapshot;
  tailSeq++;
  for (const [stepName, step] of Object.entries(task.steps)) {
    if (step.applicability !== "must") continue;
    const done = await mutateRaw(
      {
        at: new Date(2026, 4, 15, 11, 0, tailSeq + 1).toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:task_step_done",
        payload: { task_id: taskId, step: stepName, result: "passed" },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!done.ok) throw new Error(`seedCompleteTask step ${taskId}/${stepName} failed: ${done.message}`);
    snapshot = done.snapshot;
    tailSeq++;
  }
  return { snapshot, tailSeq };
}

async function seedFeatureAtVerifyAccept(dir: string): Promise<void> {
  await seedFeatureAtSpecDesign(dir);
  // Read current state — seedFeatureAtSpecDesign leaves cursor at SPEC.design
  // with tasks_planned emitted (tasks_based_on=1). spec_locked is still
  // false (no gate decided yet). For verify-accept we don't need spec_locked
  // (verify-accept gate doesn't read that flag), so just walk the cursor
  // forward.
  const { loadSession } = await import("../../src/core/cli-runtime.js");
  let { snapshot, tail_seq } = await loadSession(dir);
  let tailSeq = tail_seq;
  for (const [from, to] of [
    ["SPEC.design", "EXECUTE.plan"],
    ["EXECUTE.plan", "EXECUTE.work"],
    ["EXECUTE.work", "EXECUTE.done"],
    ["EXECUTE.done", "VERIFY.plan"],
    ["VERIFY.plan", "VERIFY.run"],
    ["VERIFY.run", "VERIFY.review"],
    ["VERIFY.review", "VERIFY.acceptance"],
    ["VERIFY.acceptance", "VERIFY.visual"],
    ["VERIFY.visual", "VERIFY.accept"],
  ] as Array<[string, string]>) {
    const r = await mutateRaw(
      {
        at: new Date(2026, 4, 15, 11, 0, tailSeq + 1).toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: from as any, to: to as any },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!r.ok) throw new Error(`seed-verify walk ${from}->${to} failed: ${r.message}`);
    snapshot = r.snapshot;
    tailSeq++;
    // F-016: once at EXECUTE.work, abandon the planted task graph so the
    // next step (EXECUTE.work → EXECUTE.done) passes the all-tasks-final
    // preflight guard.
    if (to === "EXECUTE.work") {
      ({ snapshot, tailSeq } = await seedAbandonPlantedTasks(dir, snapshot, tailSeq));
    }
  }
}

describe("loaf gate decide verify-accept — Slice 1.C sub-cycle 6 (MVP)", () => {
  test("approve happy path: single-entry batch, flag flipped, cursor stays at VERIFY.accept", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtVerifyAccept(dir);

    const result = await runCli(
      [
        "gate", "decide", "verify-accept",
        "--approve",
        "--reason", "all 5 checks pass",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.gate).toBe("verify-accept");
    expect(out.decision).toBe("approved");
    expect(out.from).toBe("VERIFY.accept");
    expect(out.actor).toBe("human:tester@example.invalid");
    expect(out.sub_state).toBe("VERIFY.accept"); // gate does NOT move cursor
    expect(out.verify_accepted).toBe(true);
    // Journal sanity: last entry is gate:decided (single-entry, no companion).
    const journal = await fsP.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lines = journal.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[lines.length - 1].kind).toBe("gate:decided");
    expect(lines[lines.length - 1].payload.gate_kind).toBe("verify-accept");
  });

  test("reject happy path: single entry, verify_accepted stays false", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtVerifyAccept(dir);

    const result = await runCli(
      [
        "gate", "decide", "verify-accept",
        "--reject",
        "--reason", "open finding pending resolution",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.gate).toBe("verify-accept");
    expect(out.decision).toBe("rejected");
    expect(out.verify_accepted).toBe(false);
    expect(out.sub_state).toBe("VERIFY.accept");
  });

  test("text-mode approve renders human-readable message on stdout", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtVerifyAccept(dir);

    const result = await runCli(
      [
        "gate", "decide", "verify-accept",
        "--approve",
        "--reason", "all checks pass",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/gate verify-accept approved/);
    expect(result.stdout).toMatch(/verify_accepted=true/);
    expect(result.stdout).toMatch(/cursor stays at VERIFY.accept/);
  });

  test("approve fails when spec.md missing — JSON failure to stderr, stdout empty", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtVerifyAccept(dir);
    // Remove spec.md to trigger Pass 1.5 evaluateVerifyAccept failure.
    await fsP.unlink(path.join(dir, "spec.md"));

    const result = await runCli(
      [
        "gate", "decide", "verify-accept",
        "--approve",
        "--reason", "trying without spec",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("GATE_PRECONDITION_VIOLATION");
    expect(errJson.detail.gate).toBe("verify-accept");
    expect(errJson.detail.failure_count).toBe(1);
    const check1 = (errJson.detail.checks as Array<{ check: number; code: string; detail?: { subcode?: string } }>)[0];
    expect(check1?.check).toBe(1);
    expect(check1?.code).toBe("SPEC_FRONTMATTER_INVALID");
    expect(check1?.detail?.subcode).toBe("SPEC_NOT_FOUND");
  });

  test("text-mode failure renders per-check lines on stderr (verify-accept)", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtVerifyAccept(dir);
    await fsP.unlink(path.join(dir, "spec.md"));

    const result = await runCli(
      [
        "gate", "decide", "verify-accept",
        "--approve",
        "--reason", "trying without spec",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/GATE_PRECONDITION_VIOLATION/);
    expect(result.stderr).toMatch(/\[check 1\] SPEC_FRONTMATTER_INVALID/);
  });

  test("--approve + --reject (verify-accept mutex fail) → USAGE error, stdout empty", async () => {
    const dir = await tmpFeatureDir();
    const result = await runCli(
      [
        "gate", "decide", "verify-accept",
        "--approve", "--reject",
        "--reason", "x",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );
    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/USAGE/);
  });

  test("LOAF_USER unset (verify-accept) → NO_HUMAN_ACTOR, stdout empty", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtVerifyAccept(dir);

    const result = await runCli(
      [
        "gate", "decide", "verify-accept",
        "--approve",
        "--reason", "x",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env: { LOAF_USER: undefined } },
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("NO_HUMAN_ACTOR");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 1.D sub-cycle 2 — loaf deliver CLI (MVP)
//
// Seeds extend the existing verify-accept seed: approve the verify-accept
// gate so verify_accepted=true (deliver preflight step 5c gate), then
// (deep variant) walk through SETTLE.* via raw event:phase_advanced so
// the cursor reaches SETTLE.lessons.
// ─────────────────────────────────────────────────────────────────────────

const DEEP_NO_STRICT_REVIEW_CEREMONY = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: true,
  // strict_spec_review intentionally false: with true, verify-accept check 5
  // would require kind=spec-review evidence with actor ≠ implementer, and the
  // seed does not stage any. Slice 1.D deliver tests focus on the deliver
  // gate, not strict-spec-review enforcement (that has dedicated coverage in
  // gates/verify-accept-check.test.ts). Real deep ceremony in production
  // keeps strict_spec_review=true; this seed-specific variant is documented
  // here and not exported beyond cli.test.ts.
  strict_spec_review: false,
  lessons_required: "must" as const,
  strict_drift_check: true,
};

/**
 * Extend seedFeatureAtVerifyAccept by running gate decide verify-accept
 * --approve via raw mutate (Pass 1.5 evaluates with the seeded state's
 * vacuous-pass profile: no done tasks, no findings, acceptance_na REQ).
 * After this returns, snapshot.state.verify_accepted=true and the cursor
 * stays at VERIFY.accept.
 */
async function seedFeatureAtVerifyAcceptApproved(dir: string): Promise<void> {
  await seedFeatureAtVerifyAccept(dir);
  const { loadSession } = await import("../../src/core/cli-runtime.js");
  const { snapshot, tail_seq } = await loadSession(dir);
  const result = await mutateRaw(
    {
      at: new Date(2026, 4, 15, 11, 30, 0).toISOString(),
      actor: "human:seed@test.invalid",
      entry_schema_version: 1,
      kind: "gate:decided",
      payload: { gate_kind: "verify-accept", decision: "approved", reason: "seed approval" },
    },
    { feature_dir: dir, snapshot, tail_seq, fsync: false },
  );
  if (!result.ok) throw new Error(`seed verify-accept approve failed: ${result.message}`);
}

/**
 * Sub-cycle 3 refactor: extracted from seedFeatureAtSettleLessons so the
 * `loaf settle` describe block can land at VERIFY.accept (deep + approved)
 * and call settle CLI directly. Seeds session:started (deep, non-strict)
 * → walk to SPEC.design → spec-lock approve → walk to VERIFY.accept →
 * verify-accept approve via raw mutate. Returns with cursor at
 * VERIFY.accept, verify_accepted=true, ceremony deep+settle_phase=true.
 */
async function seedFeatureAtVerifyAcceptApprovedDeep(dir: string): Promise<void> {
  // Step 1: write spec.md (same shape as seedFeatureAtSpecDesign).
  await fsP.writeFile(
    path.join(dir, "spec.md"),
    `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: OAuth token refresh
intent: users should not perceive auth recovery flows in flight
adr_refs: []
requirements:
  - id: REQ-AUTH-001
    type: ubiquitous
    response: the system shall do something measurable here
    acceptance_na: true
    acceptance_na_reason: subjective UX validated via manual testing scope
scenarios: []
needs_clarification: []
---

## Why
prose body here
`,
  );

  // Step 2: boot session with deep ceremony.
  let snapshot = (await import("../../src/core/reducer.js")).initialSnapshot();
  let tailSeq = -1;
  const boot = await mutateRaw(
    {
      at: "2026-05-15T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "auth-refresh",
        ceremony: DEEP_NO_STRICT_REVIEW_CEREMONY,
      },
    },
    { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
  );
  if (!boot.ok) throw new Error(`settle-seed boot failed: ${boot.message}`);
  snapshot = boot.snapshot;
  tailSeq++;

  // Step 3: walk TRIAGE → SPEC.proposal.
  for (const [from, to] of [
    ["TRIAGE.score", "TRIAGE.confirm"],
    ["TRIAGE.confirm", "SPEC.proposal"],
  ] as Array<[string, string]>) {
    const r = await mutateRaw(
      {
        at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: from as any, to: to as any },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!r.ok) throw new Error(`settle-seed walk1 ${from}->${to} failed: ${r.message}`);
    snapshot = r.snapshot;
    tailSeq++;
  }

  // Step 4: spec_submitted + req batch.
  const submitBatch = await mutateBatchRaw(
    [
      {
        at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
        actor: "human:seed@test.invalid",
        entry_schema_version: 1,
        kind: "event:spec_submitted",
        payload: {
          spec_version: 1,
          feature: { id: "F-001", name: "OAuth token refresh" },
          intent: "users should not perceive auth recovery flows in flight",
          adr_refs: [],
          needs_clarification: [],
        },
      },
      {
        at: new Date(2026, 4, 15, 10, 0, tailSeq + 2).toISOString(),
        actor: "human:seed@test.invalid",
        entry_schema_version: 1,
        kind: "event:spec_req_added",
        payload: {
          spec_version: 1,
          req: {
            id: "REQ-AUTH-001",
            type: "ubiquitous",
            response: "the system shall do something measurable here",
            acceptance_na: true,
            acceptance_na_reason: "subjective UX validated via manual testing scope",
          },
        },
      },
    ],
    { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
  );
  if (!submitBatch.ok) throw new Error(`settle-seed submit failed: ${submitBatch.message}`);
  snapshot = submitBatch.snapshot;
  tailSeq += 2;

  // Step 5: walk SPEC.proposal → SPEC.design.
  for (const [from, to] of [
    ["SPEC.proposal", "SPEC.spec"],
    ["SPEC.spec", "SPEC.plan"],
    ["SPEC.plan", "SPEC.design"],
  ] as Array<[string, string]>) {
    const r = await mutateRaw(
      {
        at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: from as any, to: to as any },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!r.ok) throw new Error(`settle-seed walk2 ${from}->${to} failed: ${r.message}`);
    snapshot = r.snapshot;
    tailSeq++;
  }

  // Step 6: plan tasks via `loaf tasks submit` CLI (Slice 2 SC2).
  const settleTasksFile = path.join(dir, ".tasks-settle-seed.json");
  await fsP.writeFile(
    settleTasksFile,
    JSON.stringify({
      based_on: { spec: 1 },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          drives: ["REQ-AUTH-001"],
          tests: ["TokenCoord.refreshOnce"],
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
  );
  const planSubmit = await runCli(
    [
      "tasks", "submit", settleTasksFile,
      "--feature", "auth-refresh",
      "--feature-dir", dir,
      "--json",
    ],
  );
  if (planSubmit.exit !== 0) {
    throw new Error(`settle-seed loaf tasks submit failed: ${planSubmit.stderr || planSubmit.stdout}`);
  }
  await fsP.unlink(settleTasksFile).catch(() => {});
  // Reload session state after CLI mutate.
  ({ snapshot, tail_seq: tailSeq } = await (await import("../../src/core/cli-runtime.js")).loadSession(dir));

  // Step 7: spec-lock approve (dual-entry batch with phase_advanced).
  const specLockBatch = await mutateBatchRaw(
    [
      {
        at: new Date(2026, 4, 15, 11, 0, tailSeq + 1).toISOString(),
        actor: "human:seed@test.invalid",
        entry_schema_version: 1,
        kind: "gate:decided",
        payload: { gate_kind: "spec-lock", decision: "approved", reason: "seed approval" },
      },
      {
        at: new Date(2026, 4, 15, 11, 0, tailSeq + 2).toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: "SPEC.design", to: "EXECUTE.plan" },
      },
    ],
    { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
  );
  if (!specLockBatch.ok) throw new Error(`settle-seed spec-lock failed: ${specLockBatch.message}`);
  snapshot = specLockBatch.snapshot;
  tailSeq += 2;

  // Step 8: walk EXECUTE → VERIFY.accept.
  for (const [from, to] of [
    ["EXECUTE.plan", "EXECUTE.work"],
    ["EXECUTE.work", "EXECUTE.done"],
    ["EXECUTE.done", "VERIFY.plan"],
    ["VERIFY.plan", "VERIFY.run"],
    ["VERIFY.run", "VERIFY.review"],
    ["VERIFY.review", "VERIFY.acceptance"],
    ["VERIFY.acceptance", "VERIFY.visual"],
    ["VERIFY.visual", "VERIFY.accept"],
  ] as Array<[string, string]>) {
    const r = await mutateRaw(
      {
        at: new Date(2026, 4, 15, 11, 0, tailSeq + 1).toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: from as any, to: to as any },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!r.ok) throw new Error(`settle-seed walk3 ${from}->${to} failed: ${r.message}`);
    snapshot = r.snapshot;
    tailSeq++;
    // F-016: abandon the planted task graph at EXECUTE.work before the
    // EXECUTE.work → EXECUTE.done step (all-tasks-final preflight guard).
    if (to === "EXECUTE.work") {
      ({ snapshot, tailSeq } = await seedAbandonPlantedTasks(dir, snapshot, tailSeq));
    }
  }

  // Step 9: verify-accept approve.
  const verifyApprove = await mutateRaw(
    {
      at: new Date(2026, 4, 15, 12, 0, tailSeq + 1).toISOString(),
      actor: "human:seed@test.invalid",
      entry_schema_version: 1,
      kind: "gate:decided",
      payload: { gate_kind: "verify-accept", decision: "approved", reason: "seed approval" },
    },
    { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
  );
  if (!verifyApprove.ok) throw new Error(`settle-seed verify-accept failed: ${verifyApprove.message}`);
}

/**
 * Compose seedFeatureAtVerifyAcceptApprovedDeep + walk through SETTLE.* so
 * the cursor reaches SETTLE.lessons (the source sub_state used by the
 * deliver-from-SETTLE test). Sub-cycle 3 closes codex r53 NB2: the
 * VERIFY.accept → SETTLE.reconcile leg now runs through the public
 * `loaf settle` CLI; SETTLE.reconcile → SETTLE.lessons uses raw mutate
 * because there is no public CLI for that intermediate advance yet
 * (would be `loaf advance SETTLE.lessons`).
 */
async function seedFeatureAtSettleLessons(dir: string): Promise<void> {
  await seedFeatureAtVerifyAcceptApprovedDeep(dir);

  // Run `loaf settle` to make the VERIFY.accept → SETTLE.reconcile leg
  // go through the production CLI (codex r53 NB2 closure).
  const settleResult = await runCli(
    [
      "settle",
      "--feature", "auth-refresh",
      "--feature-dir", dir,
      "--json",
    ],
  );
  if (settleResult.exit !== 0) {
    throw new Error(`settle-seed loaf settle failed: ${settleResult.stderr || settleResult.stdout}`);
  }

  // SETTLE.reconcile → SETTLE.lessons via `loaf advance` CLI (sub-cycle 4
  // closes codex r54 NB2 fully: every cursor advance in the seed now goes
  // through a public CLI command, eliminating the last raw-mutate transition).
  const advanceResult = await runCli(
    [
      "advance", "SETTLE.lessons",
      "--feature", "auth-refresh",
      "--feature-dir", dir,
      "--json",
    ],
  );
  if (advanceResult.exit !== 0) {
    throw new Error(`settle-seed loaf advance SETTLE.lessons failed: ${advanceResult.stderr || advanceResult.stdout}`);
  }
}

describe("loaf deliver — Slice 1.D sub-cycle 2 (MVP)", () => {
  test("happy path: VERIFY.accept standard + verify_accepted=true → DONE.delivered", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtVerifyAcceptApproved(dir);

    const result = await runCli(
      [
        "deliver",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--reason", "ready to ship",
        "--json",
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.feature).toBe("auth-refresh");
    expect(out.from).toBe("VERIFY.accept");
    expect(out.to).toBe("DONE.delivered");
    expect(out.sub_state).toBe("DONE.delivered");
    expect(out.actor).toBe("human:tester@example.invalid");
    expect(Array.isArray(out.advisory)).toBe(true);
    expect(out.advisory.length).toBeGreaterThan(0);

    // Journal sanity: last entry is session:delivered.
    const journal = await fsP.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lines = journal.trim().split("\n").map((l) => JSON.parse(l));
    const last = lines[lines.length - 1];
    expect(last.kind).toBe("session:delivered");
    expect(last.actor).toBe("human:tester@example.invalid");
    expect(last.payload.reason).toBe("ready to ship");
  });

  test("happy path: SETTLE.lessons deep + verify_accepted=true → DONE.delivered", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSettleLessons(dir);

    const result = await runCli(
      [
        "deliver",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.from).toBe("SETTLE.lessons");
    expect(out.to).toBe("DONE.delivered");
    expect(out.sub_state).toBe("DONE.delivered");
  });

  test("text-mode output renders advisory hint on stdout", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtVerifyAcceptApproved(dir);

    const result = await runCli(
      [
        "deliver",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/delivered auth-refresh/);
    expect(result.stdout).toMatch(/DONE\.delivered/);
    expect(result.stdout).toMatch(/^next: /m);
  });

  test("fail: VERIFY.accept + verify_accepted=false → DELIVER_NOT_ACCEPTED", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtVerifyAccept(dir); // no gate approve → verify_accepted=false

    const result = await runCli(
      [
        "deliver",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("DELIVER_NOT_ACCEPTED");
  });

  test("fail: EXECUTE.done attempt (quick path) → DELIVER_VERIFY_MIN_UNAVAILABLE", async () => {
    // Build a custom seed that ends at EXECUTE.done (no VERIFY.* walk).
    // Use STANDARD ceremony for simplicity — preflight rejects EXECUTE.done
    // deliver regardless of ceremony per Slice 1.D fail-closed gate.
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);

    // Approve spec-lock + walk to EXECUTE.done via raw mutate.
    const { loadSession } = await import("../../src/core/cli-runtime.js");
    let { snapshot, tail_seq } = await loadSession(dir);
    let tailSeq = tail_seq;
    const lockBatch = await mutateBatchRaw(
      [
        {
          at: new Date(2026, 4, 15, 11, 0, tailSeq + 1).toISOString(),
          actor: "human:seed@test.invalid",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "spec-lock", decision: "approved", reason: "seed approval" },
        },
        {
          at: new Date(2026, 4, 15, 11, 0, tailSeq + 2).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: "SPEC.design", to: "EXECUTE.plan" },
        },
      ],
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!lockBatch.ok) throw new Error(`spec-lock seed failed: ${lockBatch.message}`);
    snapshot = lockBatch.snapshot;
    tailSeq += 2;
    for (const [from, to] of [
      ["EXECUTE.plan", "EXECUTE.work"],
      ["EXECUTE.work", "EXECUTE.done"],
    ] as Array<[string, string]>) {
      const r = await mutateRaw(
        {
          at: new Date(2026, 4, 15, 11, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: from as any, to: to as any },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
      );
      if (!r.ok) throw new Error(`walk failed: ${r.message}`);
      snapshot = r.snapshot;
      tailSeq++;
      // F-016: abandon the planted task graph at EXECUTE.work before the
      // EXECUTE.work → EXECUTE.done step (all-tasks-final preflight guard).
      if (to === "EXECUTE.work") {
        ({ snapshot, tailSeq } = await seedAbandonPlantedTasks(dir, snapshot, tailSeq));
      }
    }

    const result = await runCli(
      [
        "deliver",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("DELIVER_VERIFY_MIN_UNAVAILABLE");
  });

  test("fail: non-abandoned spike task present → DELIVER_SPIKE_TASKS", async () => {
    // Plant a spike task in the original tasks_planned at SPEC.design so it
    // rides the projection through to VERIFY.accept. event:tasks_amended at
    // VERIFY.* expects an existing task — adding new ones requires
    // tasks_planned which is only legal at SPEC.design / EXECUTE.plan. So we
    // duplicate the SPEC seed inline here with T-002 added.
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir); // sets cursor at SPEC.design with T-001 planned + tasks_based_on=1

    // Re-submit with spike task injected via `loaf tasks submit` CLI (Slice 2 SC2).
    // tasks_planned is whole-replacement at SPEC.design; the new submit
    // supersedes the prior seed's T-001-only plan with T-001 + T-002 (spike).
    const replanFile = path.join(dir, ".tasks-spike-replan.json");
    await fsP.writeFile(
      replanFile,
      JSON.stringify({
        based_on: { spec: 1 },
        tasks: [
          {
            id: "T-001",
            kind: "behavioral",
            drives: ["REQ-AUTH-001"],
            tests: ["TokenCoord.refreshOnce"],
            status: "pending",
            depends_on: [],
            labels: [],
            execution: {
              red: { applicability: "must", status: "pending", evidence_refs: [] },
              implement: { applicability: "must", status: "pending", evidence_refs: [] },
              refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
            },
          },
          {
            id: "T-002",
            kind: "spike",
            no_test_rationale: "exploratory spike task: no behavioral assertions required",
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
      }),
    );
    const replanSubmit = await runCli(
      [
        "tasks", "submit", replanFile,
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );
    if (replanSubmit.exit !== 0) {
      throw new Error(`spike replan submit failed: ${replanSubmit.stderr || replanSubmit.stdout}`);
    }
    await fsP.unlink(replanFile).catch(() => {});
    const { loadSession } = await import("../../src/core/cli-runtime.js");
    let { snapshot, tail_seq } = await loadSession(dir);
    let tailSeq = tail_seq;

    // Now spec-lock approve + walk to VERIFY.accept + verify-accept approve.
    const lockBatch = await mutateBatchRaw(
      [
        {
          at: new Date(2026, 4, 15, 11, 0, tailSeq + 1).toISOString(),
          actor: "human:seed@test.invalid",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "spec-lock", decision: "approved", reason: "seed approval" },
        },
        {
          at: new Date(2026, 4, 15, 11, 0, tailSeq + 2).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: "SPEC.design", to: "EXECUTE.plan" },
        },
      ],
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!lockBatch.ok) throw new Error(`spike spec-lock seed failed: ${lockBatch.message}`);
    snapshot = lockBatch.snapshot;
    tailSeq += 2;

    // F-016: walk to EXECUTE.work, drive the spike task T-002 to done (it
    // must stay non-abandoned to trigger DELIVER_SPIKE_TASKS) and abandon
    // the behavioral T-001, then cross EXECUTE.done. The spike hard block
    // is source-agnostic (protocol §703 / §1298), so deliver is exercised
    // from EXECUTE.done — no VERIFY walk needed.
    {
      const r = await mutateRaw(
        {
          at: new Date(2026, 4, 15, 11, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: "EXECUTE.plan", to: "EXECUTE.work" },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
      );
      if (!r.ok) throw new Error(`spike walk EXECUTE.work failed: ${r.message}`);
      snapshot = r.snapshot;
      tailSeq++;
    }
    ({ snapshot, tailSeq } = await seedCompleteTask(dir, snapshot, tailSeq, "T-002"));
    ({ snapshot, tailSeq } = await seedAbandonPlantedTasks(dir, snapshot, tailSeq));
    {
      const r = await mutateRaw(
        {
          at: new Date(2026, 4, 15, 11, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: "EXECUTE.work", to: "EXECUTE.done" },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
      );
      if (!r.ok) throw new Error(`spike walk EXECUTE.done failed: ${r.message}`);
      snapshot = r.snapshot;
      tailSeq++;
    }

    const result = await runCli(
      [
        "deliver",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env: { LOAF_USER: "tester@example.invalid" } },
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("DELIVER_SPIKE_TASKS");
    expect(errJson.detail).toMatchObject({ task_id: "T-002", status: "done" });
  });

  test("fail: LOAF_USER unset (no tty) → NO_HUMAN_ACTOR, stdout empty", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtVerifyAcceptApproved(dir);

    const result = await runCli(
      [
        "deliver",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env: { LOAF_USER: undefined } },
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("NO_HUMAN_ACTOR");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 1.D sub-cycle 3 — loaf settle CLI (MVP)
//
// VERIFY.accept → SETTLE.reconcile via event:phase_advanced with cli:
// actor. All preconditions (settle_phase / verify_accepted / cursor edge
// legality) are enforced by sub-cycle 1's transition validator —
// CLI is a thin wrapper that emits a single entry and renders advisory.
// ─────────────────────────────────────────────────────────────────────────

describe("loaf settle — Slice 1.D sub-cycle 3 (MVP)", () => {
  test("happy: deep + verify_accepted=true → SETTLE.reconcile", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtVerifyAcceptApprovedDeep(dir);

    const result = await runCli(
      [
        "settle",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.feature).toBe("auth-refresh");
    expect(out.from).toBe("VERIFY.accept");
    expect(out.to).toBe("SETTLE.reconcile");
    expect(out.sub_state).toBe("SETTLE.reconcile");
    expect(Array.isArray(out.advisory)).toBe(true);
    expect(out.advisory.length).toBeGreaterThan(0);

    // Journal sanity: last entry is event:phase_advanced VERIFY.accept→SETTLE.reconcile.
    const journal = await fsP.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lines = journal.trim().split("\n").map((l) => JSON.parse(l));
    const last = lines[lines.length - 1];
    expect(last.kind).toBe("event:phase_advanced");
    expect(last.payload.from).toBe("VERIFY.accept");
    expect(last.payload.to).toBe("SETTLE.reconcile");
    // cli: actor (not human — settle is machine cursor advance per codex r49 Q6).
    expect(last.actor.startsWith("cli:")).toBe(true);
  });

  test("text-mode output renders advisory hint on stdout", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtVerifyAcceptApprovedDeep(dir);

    const result = await runCli(
      [
        "settle",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
      ],
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/settled auth-refresh/);
    expect(result.stdout).toMatch(/VERIFY\.accept → SETTLE\.reconcile/);
    expect(result.stdout).toMatch(/^next: /m);
    // codex r49 Q4: must NOT claim reconcile.json rebuilt — deferred slice.
    expect(result.stdout).not.toMatch(/reconcile\.json/);
  });

  test("fail: standard ceremony (settle_phase=false) → SETTLE_PHASE_DISABLED", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtVerifyAcceptApproved(dir); // standard + verify_accepted=true

    const result = await runCli(
      [
        "settle",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("SETTLE_PHASE_DISABLED");
  });

  test("fail: deep ceremony + verify_accepted=false → SETTLE_NOT_ACCEPTED", async () => {
    // Build a deep walk to VERIFY.accept WITHOUT verify-accept approval.
    // Inline because no shared helper covers "deep at VERIFY.accept, no
    // approve" — the existing seedFeatureAtVerifyAcceptApprovedDeep adds the
    // approval, which we explicitly want to skip here.
    const dir = await tmpFeatureDir();
    await fsP.writeFile(
      path.join(dir, "spec.md"),
      `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: OAuth token refresh
intent: users should not perceive auth recovery flows in flight
adr_refs: []
requirements:
  - id: REQ-AUTH-001
    type: ubiquitous
    response: the system shall do something measurable here
    acceptance_na: true
    acceptance_na_reason: subjective UX validated via manual testing scope
scenarios: []
needs_clarification: []
---

## Why
`,
    );
    let snapshot = (await import("../../src/core/reducer.js")).initialSnapshot();
    let tailSeq = -1;
    const boot = await mutateRaw(
      {
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: DEEP_NO_STRICT_REVIEW_CEREMONY,
        },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!boot.ok) throw new Error(`no-approve seed boot failed: ${boot.message}`);
    snapshot = boot.snapshot;
    tailSeq++;

    for (const [from, to] of [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
    ] as Array<[string, string]>) {
      const r = await mutateRaw(
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: from as any, to: to as any },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
      );
      if (!r.ok) throw new Error(`walk failed: ${r.message}`);
      snapshot = r.snapshot;
      tailSeq++;
    }
    const submitBatch = await mutateBatchRaw(
      [
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "human:seed@test.invalid",
          entry_schema_version: 1,
          kind: "event:spec_submitted",
          payload: {
            spec_version: 1,
            feature: { id: "F-001", name: "OAuth token refresh" },
            intent: "users should not perceive auth recovery flows in flight",
            adr_refs: [],
            needs_clarification: [],
          },
        },
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 2).toISOString(),
          actor: "human:seed@test.invalid",
          entry_schema_version: 1,
          kind: "event:spec_req_added",
          payload: {
            spec_version: 1,
            req: {
              id: "REQ-AUTH-001",
              type: "ubiquitous",
              response: "the system shall do something measurable here",
              acceptance_na: true,
              acceptance_na_reason: "subjective UX validated via manual testing scope",
            },
          },
        },
      ],
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!submitBatch.ok) throw new Error(`submit failed: ${submitBatch.message}`);
    snapshot = submitBatch.snapshot;
    tailSeq += 2;
    for (const [from, to] of [
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
    ] as Array<[string, string]>) {
      const r = await mutateRaw(
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: from as any, to: to as any },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
      );
      if (!r.ok) throw new Error(`walk2 failed: ${r.message}`);
      snapshot = r.snapshot;
      tailSeq++;
    }
    // Plan tasks via `loaf tasks submit` CLI (Slice 2 SC2 sweep).
    const noApproveTasksFile = path.join(dir, ".tasks-no-approve.json");
    await fsP.writeFile(
      noApproveTasksFile,
      JSON.stringify({
        based_on: { spec: 1 },
        tasks: [
          {
            id: "T-001",
            kind: "behavioral",
            drives: ["REQ-AUTH-001"],
            tests: ["TokenCoord.refreshOnce"],
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
    );
    const planSubmit = await runCli(
      [
        "tasks", "submit", noApproveTasksFile,
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );
    if (planSubmit.exit !== 0) {
      throw new Error(`no-approve plan submit failed: ${planSubmit.stderr || planSubmit.stdout}`);
    }
    await fsP.unlink(noApproveTasksFile).catch(() => {});
    // Reload snapshot/tail after CLI mutate.
    ({ snapshot, tail_seq: tailSeq } = await (await import("../../src/core/cli-runtime.js")).loadSession(dir));
    const lockBatch = await mutateBatchRaw(
      [
        {
          at: new Date(2026, 4, 15, 11, 0, tailSeq + 1).toISOString(),
          actor: "human:seed@test.invalid",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "spec-lock", decision: "approved", reason: "seed approval" },
        },
        {
          at: new Date(2026, 4, 15, 11, 0, tailSeq + 2).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: "SPEC.design", to: "EXECUTE.plan" },
        },
      ],
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!lockBatch.ok) throw new Error(`lock failed: ${lockBatch.message}`);
    snapshot = lockBatch.snapshot;
    tailSeq += 2;
    for (const [from, to] of [
      ["EXECUTE.plan", "EXECUTE.work"],
      ["EXECUTE.work", "EXECUTE.done"],
      ["EXECUTE.done", "VERIFY.plan"],
      ["VERIFY.plan", "VERIFY.run"],
      ["VERIFY.run", "VERIFY.review"],
      ["VERIFY.review", "VERIFY.acceptance"],
      ["VERIFY.acceptance", "VERIFY.visual"],
      ["VERIFY.visual", "VERIFY.accept"],
    ] as Array<[string, string]>) {
      const r = await mutateRaw(
        {
          at: new Date(2026, 4, 15, 11, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: from as any, to: to as any },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
      );
      if (!r.ok) throw new Error(`walk3 failed: ${r.message}`);
      snapshot = r.snapshot;
      tailSeq++;
      // F-016: abandon the planted task graph at EXECUTE.work before the
      // EXECUTE.work → EXECUTE.done step (all-tasks-final preflight guard).
      if (to === "EXECUTE.work") {
        ({ snapshot, tailSeq } = await seedAbandonPlantedTasks(dir, snapshot, tailSeq));
      }
    }
    // NO verify-accept approval — verify_accepted stays false at VERIFY.accept.

    const result = await runCli(
      [
        "settle",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("SETTLE_NOT_ACCEPTED");
  });

  test("fail: wrong sub_state (SPEC.design) → TRANSITION_ILLEGAL", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir); // cursor at SPEC.design

    const result = await runCli(
      [
        "settle",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("TRANSITION_ILLEGAL");
  });

  test("fail: no session → NO_SESSION", async () => {
    const dir = await tmpFeatureDir();
    // No seed — empty feature dir.

    const result = await runCli(
      [
        "settle",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("NO_SESSION");
  });
});

// ── Slice 1.D sub-cycle 1 — negative coverage for `loaf advance DONE.delivered` ──
//
// Codex r50 residual C: the 3 `→ DONE.delivered` edges were removed from
// LEGAL_TRANSITIONS in Slice 1.D; `loaf advance DONE.delivered` must now
// return TRANSITION_ILLEGAL from every source. This pins the invariant at
// the CLI surface alongside the core change, before deliver CLI lands in
// sub-cycle 2.
describe("loaf advance DONE.delivered — Slice 1.D edge removal", () => {
  test("from VERIFY.accept → TRANSITION_ILLEGAL (was OK pre-Slice-1.D)", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtVerifyAccept(dir);

    const result = await runCli([
      "advance", "DONE.delivered",
      "--feature", "auth-refresh",
      "--feature-dir", dir,
    ]);

    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("TRANSITION_ILLEGAL");
    // Cursor unchanged on disk.
    const journal = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lines = journal.trim().split("\n").map((l) => JSON.parse(l));
    // No new event:phase_advanced past VERIFY.accept arrival.
    expect(lines[lines.length - 1].payload.to).toBe("VERIFY.accept");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 2 SC2 — loaf tasks submit CLI (MVP)
//
// Reads JSON { based_on: { spec }, tasks: [...] } from file (or `-` for
// stdin) → emits event:tasks_planned at SPEC.design. Preflight validates
// TasksPlannedPayload + sub_state + duplicate task ids. CLI surfaces:
//   - INPUT_FILE_NOT_FOUND (file missing)
//   - SCHEMA_VALIDATION_FAILED (JSON parse fail)
//   - INVALID_PAYLOAD (TasksPlannedPayload mismatch; preflight)
//   - SUB_STATE_AUTHORITY_VIOLATION (wrong cursor; preflight)
//   - DUPLICATE_TASK_ID (duplicate ids in tasks[]; reducer)
//   - NO_SESSION (no session started)
// ─────────────────────────────────────────────────────────────────────────

describe("loaf tasks submit — Slice 2 SC2 (MVP)", () => {
  // Seed helper that walks to SPEC.design via raw mutate WITHOUT planning tasks
  // (so tests can drive the submit CLI). Mirrors seedFeatureAtSpecDesign minus
  // the final tasks_planned step.
  async function seedAtSpecDesignNoTasks(dir: string): Promise<void> {
    await fsP.writeFile(
      path.join(dir, "spec.md"),
      `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: OAuth token refresh
intent: users should not perceive auth recovery flows in flight
adr_refs: []
requirements:
  - id: REQ-AUTH-001
    type: ubiquitous
    response: the system shall do something measurable here
    acceptance_na: true
    acceptance_na_reason: subjective UX validated via manual testing scope
scenarios: []
needs_clarification: []
---
`,
    );
    let snapshot = (await import("../../src/core/reducer.js")).initialSnapshot();
    let tailSeq = -1;
    const boot = await mutateRaw(
      {
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!boot.ok) throw new Error(`no-tasks seed boot failed: ${boot.message}`);
    snapshot = boot.snapshot;
    tailSeq++;
    for (const [from, to] of [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
    ] as Array<[string, string]>) {
      const r = await mutateRaw(
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: from as any, to: to as any },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
      );
      if (!r.ok) throw new Error(`walk failed: ${r.message}`);
      snapshot = r.snapshot;
      tailSeq++;
    }
    const submitBatch = await mutateBatchRaw(
      [
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "human:seed@test.invalid",
          entry_schema_version: 1,
          kind: "event:spec_submitted",
          payload: {
            spec_version: 1,
            feature: { id: "F-001", name: "OAuth token refresh" },
            intent: "users should not perceive auth recovery flows in flight",
            adr_refs: [],
            needs_clarification: [],
          },
        },
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 2).toISOString(),
          actor: "human:seed@test.invalid",
          entry_schema_version: 1,
          kind: "event:spec_req_added",
          payload: {
            spec_version: 1,
            req: {
              id: "REQ-AUTH-001",
              type: "ubiquitous",
              response: "the system shall do something measurable here",
              acceptance_na: true,
              acceptance_na_reason: "subjective UX validated via manual testing scope",
            },
          },
        },
      ],
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!submitBatch.ok) throw new Error(`submit failed: ${submitBatch.message}`);
    snapshot = submitBatch.snapshot;
    tailSeq += 2;
    for (const [from, to] of [
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
    ] as Array<[string, string]>) {
      const r = await mutateRaw(
        {
          at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: from as any, to: to as any },
        },
        { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
      );
      if (!r.ok) throw new Error(`walk2 failed: ${r.message}`);
      snapshot = r.snapshot;
      tailSeq++;
    }
  }

  const validTasksPayload = {
    based_on: { spec: 1 },
    tasks: [
      {
        id: "T-001",
        kind: "behavioral",
        drives: ["REQ-AUTH-001"],
        tests: ["TokenCoord.refreshOnce"],
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

  test("happy path: valid JSON file → event:tasks_planned + tasks_count + task_ids", async () => {
    const dir = await tmpFeatureDir();
    await seedAtSpecDesignNoTasks(dir);
    const tasksFile = path.join(dir, ".tasks-test.json");
    await fsP.writeFile(tasksFile, JSON.stringify(validTasksPayload));

    const result = await runCli(
      [
        "tasks", "submit", tasksFile,
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.feature).toBe("auth-refresh");
    expect(out.sub_state).toBe("SPEC.design"); // tasks_planned does not move cursor
    expect(out.tasks_count).toBe(1);
    expect(out.task_ids).toEqual(["T-001"]);
    expect(out.tasks_based_on).toEqual({ spec: 1 });

    // Journal: last entry is event:tasks_planned with full payload.
    const journal = await fsP.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lines = journal.trim().split("\n").map((l) => JSON.parse(l));
    const last = lines[lines.length - 1];
    expect(last.kind).toBe("event:tasks_planned");
    expect(last.payload.tasks[0].id).toBe("T-001");
  });

  test("text-mode output renders task ids", async () => {
    const dir = await tmpFeatureDir();
    await seedAtSpecDesignNoTasks(dir);
    const tasksFile = path.join(dir, ".tasks-text.json");
    await fsP.writeFile(tasksFile, JSON.stringify(validTasksPayload));

    const result = await runCli(
      [
        "tasks", "submit", tasksFile,
        "--feature", "auth-refresh",
        "--feature-dir", dir,
      ],
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/submitted 1 task: T-001/);
  });

  test("fail: file does not exist → INPUT_FILE_NOT_FOUND", async () => {
    const dir = await tmpFeatureDir();
    await seedAtSpecDesignNoTasks(dir);

    const result = await runCli(
      [
        "tasks", "submit", path.join(dir, "nonexistent.json"),
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("INPUT_FILE_NOT_FOUND");
    expect(errJson.detail).toMatchObject({ path: expect.stringContaining("nonexistent.json") });
  });

  test("fail: malformed JSON → SCHEMA_VALIDATION_FAILED", async () => {
    const dir = await tmpFeatureDir();
    await seedAtSpecDesignNoTasks(dir);
    const tasksFile = path.join(dir, ".tasks-bad-json.json");
    await fsP.writeFile(tasksFile, "{ not valid json");

    const result = await runCli(
      [
        "tasks", "submit", tasksFile,
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(errJson.message).toMatch(/JSON/i);
  });

  test("fail: missing based_on → INVALID_PAYLOAD (preflight)", async () => {
    const dir = await tmpFeatureDir();
    await seedAtSpecDesignNoTasks(dir);
    const tasksFile = path.join(dir, ".tasks-no-based-on.json");
    await fsP.writeFile(
      tasksFile,
      JSON.stringify({ tasks: validTasksPayload.tasks }), // missing based_on
    );

    const result = await runCli(
      [
        "tasks", "submit", tasksFile,
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("INVALID_PAYLOAD");
  });

  test("fail: wrong sub_state (TRIAGE.score) → SUB_STATE_AUTHORITY_VIOLATION", async () => {
    const dir = await tmpFeatureDir();
    // Seed with only session:started (cursor at TRIAGE.score).
    const snapshot0 = (await import("../../src/core/reducer.js")).initialSnapshot();
    const boot = await mutateRaw(
      {
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      },
      { feature_dir: dir, snapshot: snapshot0, tail_seq: -1, fsync: false },
    );
    if (!boot.ok) throw new Error(`boot failed: ${boot.message}`);
    const tasksFile = path.join(dir, ".tasks-triage.json");
    await fsP.writeFile(tasksFile, JSON.stringify(validTasksPayload));

    const result = await runCli(
      [
        "tasks", "submit", tasksFile,
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("SUB_STATE_AUTHORITY_VIOLATION");
  });

  test("fail: duplicate task ids in tasks[] → DUPLICATE_TASK_ID (preflight; codex r59 P2.1 closure in SC4)", async () => {
    const dir = await tmpFeatureDir();
    await seedAtSpecDesignNoTasks(dir);
    const tasksFile = path.join(dir, ".tasks-dup.json");
    await fsP.writeFile(
      tasksFile,
      JSON.stringify({
        based_on: { spec: 1 },
        tasks: [validTasksPayload.tasks[0], validTasksPayload.tasks[0]], // same id twice
      }),
    );

    const result = await runCli(
      [
        "tasks", "submit", tasksFile,
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    // SC4 (codex r59 P2.1 closure): preflight step 5d.1 catches duplicate
    // task ids and surfaces DUPLICATE_TASK_ID top-level. Reducer's
    // defensive sweep is now fallback for raw paths that bypass preflight.
    expect(errJson.code).toBe("DUPLICATE_TASK_ID");
    expect(errJson.detail).toMatchObject({ task_id: "T-001" });
  });

  test("fail: no session → NO_SESSION", async () => {
    const dir = await tmpFeatureDir();
    // No seed — empty feature dir.
    const tasksFile = path.join(dir, ".tasks-empty.json");
    await fsP.writeFile(tasksFile, JSON.stringify(validTasksPayload));

    const result = await runCli(
      [
        "tasks", "submit", tasksFile,
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );

    expect(result.exit).toBe(2);
    expect(result.stdout).toBe("");
    const errJson = JSON.parse(result.stderr.trim());
    expect(errJson.code).toBe("NO_SESSION");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 2 SC3 — loaf tasks claim + step start + step done CLI (MVP)
//
// All 3 commands wire over SC1 preflight step 5e + existing reducer
// handlers. Source sub_state: EXECUTE.work. Tests use SC2 seedFeatureAt
// SpecDesign (which now invokes loaf tasks submit) + a SC3-local helper
// that walks to EXECUTE.work via loaf gate decide + loaf advance.
// ─────────────────────────────────────────────────────────────────────────

async function seedFeatureAtExecuteWork(dir: string): Promise<void> {
  await seedFeatureAtSpecDesign(dir);
  // spec-lock approve (cursor → EXECUTE.plan)
  const lockResult = await runCli(
    [
      "gate", "decide", "spec-lock",
      "--approve", "--reason", "sc3-seed: spec ready",
      "--feature", "auth-refresh",
      "--feature-dir", dir,
      "--json",
    ],
    { env: { LOAF_USER: "sc3-seed@test.invalid" } },
  );
  if (lockResult.exit !== 0) {
    throw new Error(`sc3-seed spec-lock failed: ${lockResult.stderr}`);
  }
  // advance EXECUTE.plan → EXECUTE.work
  const advResult = await runCli(
    [
      "advance", "EXECUTE.work",
      "--feature", "auth-refresh",
      "--feature-dir", dir,
      "--json",
    ],
  );
  if (advResult.exit !== 0) {
    throw new Error(`sc3-seed advance failed: ${advResult.stderr}`);
  }
}

describe("loaf tasks claim + step start + step done — Slice 2 SC3 (MVP)", () => {
  test("happy: claim → step start red → step done red passed (no auto-promote yet)", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);

    // claim T-001
    let r = await runCli(
      [
        "tasks", "claim", "T-001",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );
    expect(r.exit).toBe(0);
    let out = JSON.parse(r.stdout);
    expect(out.task_id).toBe("T-001");
    expect(out.status).toBe("in_progress");

    // step start red
    r = await runCli(
      [
        "tasks", "step", "start",
        "--task", "T-001", "--step", "red",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );
    expect(r.exit).toBe(0);
    out = JSON.parse(r.stdout);
    expect(out.task_id).toBe("T-001");
    expect(out.step).toBe("red");
    expect(out.step_status).toBe("running");

    // step done red passed
    r = await runCli(
      [
        "tasks", "step", "done",
        "--task", "T-001", "--step", "red", "--result", "passed",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );
    expect(r.exit).toBe(0);
    out = JSON.parse(r.stdout);
    expect(out.step_status).toBe("passed");
    expect(out.task_status).toBe("in_progress"); // implement still pending → no auto-promote
  });

  test("happy: full step lifecycle → task auto-promotes to done", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);

    // claim
    await runCli(["tasks", "claim", "T-001", "--feature", "auth-refresh", "--feature-dir", dir]);
    // run red + implement (both must); skip refactor (optional)
    for (const step of ["red", "implement"]) {
      await runCli([
        "tasks", "step", "start",
        "--task", "T-001", "--step", step,
        "--feature", "auth-refresh", "--feature-dir", dir,
      ]);
      const r = await runCli([
        "tasks", "step", "done",
        "--task", "T-001", "--step", step, "--result", "passed",
        "--feature", "auth-refresh", "--feature-dir", dir,
        "--json",
      ]);
      const out = JSON.parse(r.stdout);
      if (step === "implement") {
        // After implement passes, all must steps terminal-positive → auto-promote.
        expect(out.task_status).toBe("done");
      }
    }
  });

  test("text-mode renders state-change line + auto-promote hint when fires", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);
    await runCli(["tasks", "claim", "T-001", "--feature", "auth-refresh", "--feature-dir", dir]);
    await runCli([
      "tasks", "step", "start",
      "--task", "T-001", "--step", "red",
      "--feature", "auth-refresh", "--feature-dir", dir,
    ]);
    await runCli([
      "tasks", "step", "done",
      "--task", "T-001", "--step", "red", "--result", "passed",
      "--feature", "auth-refresh", "--feature-dir", dir,
    ]);
    await runCli([
      "tasks", "step", "start",
      "--task", "T-001", "--step", "implement",
      "--feature", "auth-refresh", "--feature-dir", dir,
    ]);
    // Final step_done → auto-promote.
    const r = await runCli([
      "tasks", "step", "done",
      "--task", "T-001", "--step", "implement", "--result", "passed",
      "--feature", "auth-refresh", "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toMatch(/done T-001 step=implement result=passed/);
    expect(r.stdout).toMatch(/auto-promoted to done/);
  });

  test("fail claim: unknown task → TASK_NOT_FOUND", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);
    const r = await runCli(
      [
        "tasks", "claim", "T-999",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );
    expect(r.exit).toBe(2);
    expect(r.stdout).toBe("");
    const errJson = JSON.parse(r.stderr.trim());
    expect(errJson.code).toBe("TASK_NOT_FOUND");
  });

  test("fail claim: already claimed → TASK_ALREADY_CLAIMED", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);
    await runCli(["tasks", "claim", "T-001", "--feature", "auth-refresh", "--feature-dir", dir]);
    const r = await runCli(
      [
        "tasks", "claim", "T-001",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );
    expect(r.exit).toBe(2);
    const errJson = JSON.parse(r.stderr.trim());
    expect(errJson.code).toBe("TASK_ALREADY_CLAIMED");
  });

  test("fail step start: task not claimed → TASK_NOT_CLAIMED", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);
    // no claim — try step start directly
    const r = await runCli(
      [
        "tasks", "step", "start",
        "--task", "T-001", "--step", "red",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );
    expect(r.exit).toBe(2);
    const errJson = JSON.parse(r.stderr.trim());
    expect(errJson.code).toBe("TASK_NOT_CLAIMED");
  });

  test("fail step done: bad --result → USAGE", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);
    const r = await runCli(
      [
        "tasks", "step", "done",
        "--task", "T-001", "--step", "red", "--result", "BOGUS",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/USAGE/);
  });

  test("fail step start: wrong sub_state (SPEC.design) → SUB_STATE_AUTHORITY_VIOLATION", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir); // cursor at SPEC.design, no claim
    const r = await runCli(
      [
        "tasks", "step", "start",
        "--task", "T-001", "--step", "red",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );
    expect(r.exit).toBe(2);
    const errJson = JSON.parse(r.stderr.trim());
    expect(errJson.code).toBe("SUB_STATE_AUTHORITY_VIOLATION");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 2 SC4 — loaf tasks list + tasks next + P2 closures + E2E
//
// Read-only commands wire over `snapshot.tasks` projection. `ready` is
// derived (Option C arch per codex r57): status=pending + deps_on all
// done. No journal entries emitted.
//
// Plus three follow-up closures from earlier SC2/SC3 reviews:
//   - r59 P2.3 — tasks_planned legal at EXECUTE.plan for replanning
//   - r59 P2.1 — DUPLICATE_TASK_ID surface promotion (pinned in submit test)
//   - r60 P2.3 — step start idempotency contract pinned
// ─────────────────────────────────────────────────────────────────────────

describe("loaf tasks list — Slice 2 SC4 (MVP)", () => {
  test("happy: list empty projection (no tasks) → 0 count, hint message", async () => {
    const dir = await tmpFeatureDir();
    // Seed without tasks (uses SC2's seedAtSpecDesignNoTasks via inline
    // recreation since it's local to that describe; replicate boot only).
    const snapshot0 = (await import("../../src/core/reducer.js")).initialSnapshot();
    const boot = await mutateRaw(
      {
        at: "2026-05-15T10:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      },
      { feature_dir: dir, snapshot: snapshot0, tail_seq: -1, fsync: false },
    );
    if (!boot.ok) throw new Error(`boot failed: ${boot.message}`);

    const r = await runCli(
      [
        "tasks", "list",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );
    expect(r.exit).toBe(0);
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.count).toBe(0);
    expect(out.tasks).toEqual([]);
  });

  test("happy: list after submit shows T-001 with ready=true (no deps)", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir); // T-001 planned, no deps, status=pending

    const r = await runCli(
      [
        "tasks", "list",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.count).toBe(1);
    expect(out.tasks[0].id).toBe("T-001");
    expect(out.tasks[0].status).toBe("pending");
    expect(out.tasks[0].ready).toBe(true);
  });

  test("text-mode renders T-id + kind + status + ready columns", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);
    const r = await runCli(
      [
        "tasks", "list",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
      ],
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toMatch(/^T-001 behavioral pending \[ready\]$/m);
  });

  test("--status filter: pending matches; --status ready matches derived", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);

    // pending filter
    const rPending = await runCli(
      [
        "tasks", "list", "--status", "pending",
        "--feature", "auth-refresh", "--feature-dir", dir, "--json",
      ],
    );
    expect(JSON.parse(rPending.stdout).count).toBe(1);

    // ready filter (derived; T-001 is pending+no deps → ready=true → match)
    const rReady = await runCli(
      [
        "tasks", "list", "--status", "ready",
        "--feature", "auth-refresh", "--feature-dir", dir, "--json",
      ],
    );
    expect(JSON.parse(rReady.stdout).count).toBe(1);

    // done filter (no done tasks)
    const rDone = await runCli(
      [
        "tasks", "list", "--status", "done",
        "--feature", "auth-refresh", "--feature-dir", dir, "--json",
      ],
    );
    expect(JSON.parse(rDone.stdout).count).toBe(0);
  });

  test("--status invalid → USAGE", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);
    const r = await runCli(
      [
        "tasks", "list", "--status", "BOGUS",
        "--feature", "auth-refresh", "--feature-dir", dir, "--json",
      ],
    );
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/USAGE/);
  });

  test("ready=false when deps_on incomplete", async () => {
    const dir = await tmpFeatureDir();
    // Plant a 2-task graph: T-002 depends on T-001. T-001 pending → T-002 not ready.
    await seedAtSpecDesignNoTasksSC4(dir);
    const tasksFile = path.join(dir, ".tasks-deps.json");
    await fsP.writeFile(
      tasksFile,
      JSON.stringify({
        based_on: { spec: 1 },
        tasks: [
          {
            id: "T-001",
            kind: "behavioral",
            drives: ["REQ-AUTH-001"],
            tests: ["TokenCoord.refreshOnce"],
            status: "pending",
            depends_on: [],
            labels: [],
            execution: {
              red: { applicability: "must", status: "pending", evidence_refs: [] },
              implement: { applicability: "must", status: "pending", evidence_refs: [] },
              refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
            },
          },
          {
            id: "T-002",
            kind: "behavioral",
            drives: ["REQ-AUTH-001"],
            tests: ["TokenCoord.refreshTwice"],
            status: "pending",
            depends_on: ["T-001"],
            labels: [],
            execution: {
              red: { applicability: "must", status: "pending", evidence_refs: [] },
              implement: { applicability: "must", status: "pending", evidence_refs: [] },
              refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
            },
          },
        ],
      }),
    );
    const submit = await runCli([
      "tasks", "submit", tasksFile,
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(submit.exit).toBe(0);

    const r = await runCli(
      [
        "tasks", "list",
        "--feature", "auth-refresh", "--feature-dir", dir, "--json",
      ],
    );
    const out = JSON.parse(r.stdout);
    expect(out.count).toBe(2);
    const t1 = out.tasks.find((t: any) => t.id === "T-001");
    const t2 = out.tasks.find((t: any) => t.id === "T-002");
    expect(t1.ready).toBe(true); // no deps
    expect(t2.ready).toBe(false); // T-001 not done yet
  });
});

// Local helper for SC4 tests (mirrors SC2's seedAtSpecDesignNoTasks which is
// scoped to that describe block; SC4 reuses the same shape for list/next
// fixtures).
async function seedAtSpecDesignNoTasksSC4(dir: string): Promise<void> {
  await fsP.writeFile(
    path.join(dir, "spec.md"),
    `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: OAuth token refresh
intent: users should not perceive auth recovery flows in flight
adr_refs: []
requirements:
  - id: REQ-AUTH-001
    type: ubiquitous
    response: the system shall do something measurable here
    acceptance_na: true
    acceptance_na_reason: subjective UX validated via manual testing scope
scenarios: []
needs_clarification: []
---
`,
  );
  let snapshot = (await import("../../src/core/reducer.js")).initialSnapshot();
  let tailSeq = -1;
  const boot = await mutateRaw(
    {
      at: "2026-05-15T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "auth-refresh",
        ceremony: STANDARD_CEREMONY,
      },
    },
    { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
  );
  if (!boot.ok) throw new Error(`SC4 no-tasks seed boot failed: ${boot.message}`);
  snapshot = boot.snapshot;
  tailSeq++;
  for (const [from, to] of [
    ["TRIAGE.score", "TRIAGE.confirm"],
    ["TRIAGE.confirm", "SPEC.proposal"],
  ] as Array<[string, string]>) {
    const r = await mutateRaw(
      {
        at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: from as any, to: to as any },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!r.ok) throw new Error(`SC4 seed walk failed: ${r.message}`);
    snapshot = r.snapshot;
    tailSeq++;
  }
  const submitBatch = await mutateBatchRaw(
    [
      {
        at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
        actor: "human:seed@test.invalid",
        entry_schema_version: 1,
        kind: "event:spec_submitted",
        payload: {
          spec_version: 1,
          feature: { id: "F-001", name: "OAuth token refresh" },
          intent: "users should not perceive auth recovery flows in flight",
          adr_refs: [],
          needs_clarification: [],
        },
      },
      {
        at: new Date(2026, 4, 15, 10, 0, tailSeq + 2).toISOString(),
        actor: "human:seed@test.invalid",
        entry_schema_version: 1,
        kind: "event:spec_req_added",
        payload: {
          spec_version: 1,
          req: {
            id: "REQ-AUTH-001",
            type: "ubiquitous",
            response: "the system shall do something measurable here",
            acceptance_na: true,
            acceptance_na_reason: "subjective UX validated via manual testing scope",
          },
        },
      },
    ],
    { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
  );
  if (!submitBatch.ok) throw new Error(`SC4 seed submit failed: ${submitBatch.message}`);
  snapshot = submitBatch.snapshot;
  tailSeq += 2;
  for (const [from, to] of [
    ["SPEC.proposal", "SPEC.spec"],
    ["SPEC.spec", "SPEC.plan"],
    ["SPEC.plan", "SPEC.design"],
  ] as Array<[string, string]>) {
    const r = await mutateRaw(
      {
        at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: from as any, to: to as any },
      },
      { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
    );
    if (!r.ok) throw new Error(`SC4 seed walk2 failed: ${r.message}`);
    snapshot = r.snapshot;
    tailSeq++;
  }
}

describe("loaf tasks next — Slice 2 SC4 (MVP)", () => {
  test("happy: first ready task (T-001 no deps) → prints id", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);
    const r = await runCli(
      [
        "tasks", "next",
        "--feature", "auth-refresh", "--feature-dir", dir, "--json",
      ],
    );
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.task_id).toBe("T-001");
    expect(out.kind).toBe("behavioral");
  });

  test("text-mode prints bare T-id (or empty if none)", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);
    const r = await runCli(
      [
        "tasks", "next",
        "--feature", "auth-refresh", "--feature-dir", dir,
      ],
    );
    expect(r.exit).toBe(0);
    expect(r.stdout.trim()).toBe("T-001");
  });

  test("no ready tasks (T-001 in_progress) → null/empty", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);
    await runCli(["tasks", "claim", "T-001", "--feature", "auth-refresh", "--feature-dir", dir]);

    const r = await runCli(
      [
        "tasks", "next",
        "--feature", "auth-refresh", "--feature-dir", dir, "--json",
      ],
    );
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.task_id).toBeNull();
  });
});

// ─── r59 P2.3 closure: tasks_planned legal at EXECUTE.plan ───────────────
describe("loaf tasks submit at EXECUTE.plan — replan path (r59 P2.3 closure)", () => {
  test("submit re-plans tasks at EXECUTE.plan (per PER_KIND_SUB_STATE: tasks_planned allowed in both SPEC.design and EXECUTE.plan)", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);
    // Approve spec-lock to advance to EXECUTE.plan.
    const lock = await runCli(
      [
        "gate", "decide", "spec-lock",
        "--approve", "--reason", "re-plan path test",
        "--feature", "auth-refresh", "--feature-dir", dir, "--json",
      ],
      { env: { LOAF_USER: "replan@test.invalid" } },
    );
    expect(lock.exit).toBe(0);
    expect(JSON.parse(lock.stdout).sub_state).toBe("EXECUTE.plan");

    // Now re-submit tasks at EXECUTE.plan (e.g. via finding-amend replan).
    const replanFile = path.join(dir, ".tasks-replan.json");
    await fsP.writeFile(
      replanFile,
      JSON.stringify({
        based_on: { spec: 1 }, // same spec_version
        tasks: [
          {
            id: "T-001",
            kind: "behavioral",
            drives: ["REQ-AUTH-001"],
            tests: ["TokenCoord.refreshOnce"],
            status: "pending",
            depends_on: [],
            labels: [],
            execution: {
              red: { applicability: "must", status: "pending", evidence_refs: [] },
              implement: { applicability: "must", status: "pending", evidence_refs: [] },
              refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
            },
          },
          {
            id: "T-002", // new task added on re-plan
            kind: "behavioral",
            drives: ["REQ-AUTH-001"],
            tests: ["TokenCoord.refreshExtra"],
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
    );

    const r = await runCli(
      [
        "tasks", "submit", replanFile,
        "--feature", "auth-refresh", "--feature-dir", dir, "--json",
      ],
    );
    expect(r.exit).toBe(0);
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout);
    expect(out.tasks_count).toBe(2);
    expect(out.task_ids).toEqual(["T-001", "T-002"]);
    expect(out.sub_state).toBe("EXECUTE.plan"); // cursor unchanged
  });
});

// ─── r60 P2.3 closure: step start idempotency contract ──────────────────
describe("loaf tasks step start idempotency — Slice 2 SC4 (r60 P2.3 closure)", () => {
  test("re-running step start on same task+step succeeds; emits redundant journal entry", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);
    await runCli(["tasks", "claim", "T-001", "--feature", "auth-refresh", "--feature-dir", dir]);

    // First step start.
    const r1 = await runCli([
      "tasks", "step", "start",
      "--task", "T-001", "--step", "red",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r1.exit).toBe(0);
    expect(JSON.parse(r1.stdout).step_status).toBe("running");

    // Second step start on the same step — current contract: accepted
    // audit-trail redundancy. Reducer rewrites step.status=running.
    const r2 = await runCli([
      "tasks", "step", "start",
      "--task", "T-001", "--step", "red",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r2.exit).toBe(0);
    expect(JSON.parse(r2.stdout).step_status).toBe("running");

    // Journal grows by 2 event:task_step_started entries (idempotent state,
    // non-idempotent log).
    const journal = await fsP.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lines = journal.trim().split("\n").map((l) => JSON.parse(l));
    const startEntries = lines.filter((l) => l.kind === "event:task_step_started");
    expect(startEntries).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 1.D sub-cycle 4 — End-to-end lifecycle CLI tests
//
// Validates the full feature lifecycle from SPEC.design through DONE.delivered
// using the CLI surface exposed in Slices 1.A–1.D. SPEC content + tasks_planned
// still go through raw mutate seeds (their CLI surfaces are Slice 4 territory),
// but every transition / gate / cursor move from spec-lock onward runs
// through `loaf advance` / `loaf gate decide` / `loaf settle` / `loaf deliver`.
//
// These tests are the contract that §15 done-when items 1+2 hold end-to-end:
//   - Standard ceremony reaches DONE.delivered via spec-lock + verify-accept + deliver.
//   - Deep ceremony reaches DONE.delivered via spec-lock + verify-accept + settle + advance + deliver.
// ─────────────────────────────────────────────────────────────────────────

describe("End-to-end lifecycle CLI — Slice 1.D sub-cycle 4", () => {
  test("standard ceremony: SPEC.design → DONE.delivered through full CLI chain", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir, STANDARD_CEREMONY);
    const env = { LOAF_USER: "e2e@test.invalid" };

    // CLI 1: spec-lock approve (cursor → EXECUTE.plan).
    let r = await runCli(
      [
        "gate", "decide", "spec-lock",
        "--approve", "--reason", "e2e: spec ready",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env },
    );
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout).sub_state).toBe("EXECUTE.plan");

    // CLI 2: walk EXECUTE.plan → VERIFY.accept via loaf advance.
    for (const target of [
      "EXECUTE.work", "EXECUTE.done",
      "VERIFY.plan", "VERIFY.run", "VERIFY.review",
      "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept",
    ]) {
      r = await runCli(
        [
          "advance", target,
          "--feature", "auth-refresh",
          "--feature-dir", dir,
          "--json",
        ],
      );
      expect(r.exit, `advance to ${target} failed: ${r.stderr}`).toBe(0);
      // F-016: abandon the seed task graph at EXECUTE.work before the next
      // advance crosses EXECUTE.done (all-tasks-final preflight guard). The
      // task abandon rides the raw-mutate channel — consistent with this
      // test's SPEC + tasks_planned seed, which is already raw-mutate.
      if (target === "EXECUTE.work") {
        const sess = await (await import("../../src/core/cli-runtime.js")).loadSession(dir);
        await seedAbandonPlantedTasks(dir, sess.snapshot, sess.tail_seq);
      }
    }

    // CLI 3: verify-accept approve (verify_accepted=true, cursor stays at VERIFY.accept).
    r = await runCli(
      [
        "gate", "decide", "verify-accept",
        "--approve", "--reason", "e2e: all checks pass",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env },
    );
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout).verify_accepted).toBe(true);

    // CLI 4: deliver (cursor → DONE.delivered).
    r = await runCli(
      [
        "deliver",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--reason", "e2e standard lifecycle complete",
        "--json",
      ],
      { env },
    );
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.sub_state).toBe("DONE.delivered");
    expect(out.from).toBe("VERIFY.accept");

    // Journal sanity: ends with session:delivered.
    const journal = await fsP.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lines = journal.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[lines.length - 1].kind).toBe("session:delivered");
  });

  test("deep ceremony: SPEC.design → DONE.delivered via settle + advance + deliver", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir, DEEP_NO_STRICT_REVIEW_CEREMONY);
    const env = { LOAF_USER: "e2e@test.invalid" };

    // CLI 1: spec-lock approve.
    let r = await runCli(
      [
        "gate", "decide", "spec-lock",
        "--approve", "--reason", "e2e deep: spec ready",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env },
    );
    expect(r.exit).toBe(0);

    // CLI 2: walk to VERIFY.accept.
    for (const target of [
      "EXECUTE.work", "EXECUTE.done",
      "VERIFY.plan", "VERIFY.run", "VERIFY.review",
      "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept",
    ]) {
      r = await runCli(
        [
          "advance", target,
          "--feature", "auth-refresh",
          "--feature-dir", dir,
          "--json",
        ],
      );
      expect(r.exit, `deep advance to ${target} failed: ${r.stderr}`).toBe(0);
      // F-016: abandon the seed task graph at EXECUTE.work before the next
      // advance crosses EXECUTE.done (all-tasks-final preflight guard). The
      // task abandon rides the raw-mutate channel — consistent with this
      // test's SPEC + tasks_planned seed, which is already raw-mutate.
      if (target === "EXECUTE.work") {
        const sess = await (await import("../../src/core/cli-runtime.js")).loadSession(dir);
        await seedAbandonPlantedTasks(dir, sess.snapshot, sess.tail_seq);
      }
    }

    // CLI 3: verify-accept approve.
    r = await runCli(
      [
        "gate", "decide", "verify-accept",
        "--approve", "--reason", "e2e deep: all checks pass",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
      { env },
    );
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout).verify_accepted).toBe(true);

    // CLI 4: settle (VERIFY.accept → SETTLE.reconcile).
    r = await runCli(
      [
        "settle",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout).sub_state).toBe("SETTLE.reconcile");

    // CLI 5: advance SETTLE.reconcile → SETTLE.lessons.
    r = await runCli(
      [
        "advance", "SETTLE.lessons",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--json",
      ],
    );
    expect(r.exit).toBe(0);

    // CLI 6: deliver (cursor → DONE.delivered).
    r = await runCli(
      [
        "deliver",
        "--feature", "auth-refresh",
        "--feature-dir", dir,
        "--reason", "e2e deep lifecycle complete",
        "--json",
      ],
      { env },
    );
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.sub_state).toBe("DONE.delivered");
    expect(out.from).toBe("SETTLE.lessons");

    // Journal sanity: ends with session:delivered.
    const journal = await fsP.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lines = journal.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[lines.length - 1].kind).toBe("session:delivered");

    // §15 done-when item 2: the deep lifecycle journey is fully CLI-driven
    // (every event:phase_advanced + gate:decided + session:delivered after
    // the SPEC content seed lands via a CLI command, not raw mutate).
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 2 SC4 — End-to-end task lifecycle CLI test
//
// Closes Slice 2 by chaining all task CLI surfaces (submit / claim / step
// start / step done / list / next) into a complete worker workflow.
// Extends Slice 1.D's E2E with the task lifecycle CLI commands — proves
// that after `loaf tasks submit`, a worker can claim + execute + auto-
// promote a task entirely through the public CLI, without any raw mutate
// in the test body.
// ─────────────────────────────────────────────────────────────────────────

describe("End-to-end task lifecycle CLI — Slice 2 SC4", () => {
  test("submit → claim → step lifecycle → auto-promote done → list/next reflect state", async () => {
    const dir = await tmpFeatureDir();
    await seedAtSpecDesignNoTasksSC4(dir);

    // Helper to keep the test body concise.
    const cli = (args: string[], env?: Record<string, string | undefined>) =>
      runCli(args.concat(["--feature", "auth-refresh", "--feature-dir", dir]),
        env ? { env } : {});

    // CLI 1: tasks submit (single task T-001 with red+implement must steps).
    const tasksFile = path.join(dir, ".tasks-e2e.json");
    await fsP.writeFile(
      tasksFile,
      JSON.stringify({
        based_on: { spec: 1 },
        tasks: [
          {
            id: "T-001",
            kind: "behavioral",
            drives: ["REQ-AUTH-001"],
            tests: ["TokenCoord.refreshOnce"],
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
    );
    let r = await cli(["tasks", "submit", tasksFile, "--json"]);
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout).task_ids).toEqual(["T-001"]);

    // CLI 2: tasks next at SPEC.design → T-001 (ready, no deps).
    r = await cli(["tasks", "next", "--json"]);
    expect(JSON.parse(r.stdout).task_id).toBe("T-001");

    // CLI 3: spec-lock approve → EXECUTE.plan.
    r = await cli(
      ["gate", "decide", "spec-lock", "--approve", "--reason", "e2e"],
      { LOAF_USER: "e2e@test.invalid" },
    );
    expect(r.exit).toBe(0);

    // CLI 4: advance EXECUTE.plan → EXECUTE.work.
    r = await cli(["advance", "EXECUTE.work"]);
    expect(r.exit).toBe(0);

    // CLI 5: tasks claim T-001 → in_progress.
    r = await cli(["tasks", "claim", "T-001", "--json"]);
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe("in_progress");

    // CLI 6: tasks list (T-001 in_progress, ready=false since no longer pending).
    r = await cli(["tasks", "list", "--json"]);
    let listOut = JSON.parse(r.stdout);
    expect(listOut.tasks[0].status).toBe("in_progress");
    expect(listOut.tasks[0].ready).toBe(false);

    // CLI 7: tasks next at this point → null (no pending tasks).
    r = await cli(["tasks", "next", "--json"]);
    expect(JSON.parse(r.stdout).task_id).toBeNull();

    // CLI 8: run red step (start + done passed).
    r = await cli(["tasks", "step", "start", "--task", "T-001", "--step", "red"]);
    expect(r.exit).toBe(0);
    r = await cli(["tasks", "step", "done", "--task", "T-001", "--step", "red", "--result", "passed", "--json"]);
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout).task_status).toBe("in_progress"); // implement still pending

    // CLI 9: run implement step (start + done passed → auto-promote).
    r = await cli(["tasks", "step", "start", "--task", "T-001", "--step", "implement"]);
    expect(r.exit).toBe(0);
    r = await cli(["tasks", "step", "done", "--task", "T-001", "--step", "implement", "--result", "passed", "--json"]);
    expect(r.exit).toBe(0);
    const doneOut = JSON.parse(r.stdout);
    expect(doneOut.step_status).toBe("passed");
    expect(doneOut.task_status).toBe("done"); // auto-promote fired

    // CLI 10: tasks list (T-001 done now).
    r = await cli(["tasks", "list", "--json"]);
    listOut = JSON.parse(r.stdout);
    expect(listOut.tasks[0].status).toBe("done");

    // CLI 11: advance EXECUTE.work → EXECUTE.done (manual advance; future
    // slice may auto-derive when all tasks done).
    r = await cli(["advance", "EXECUTE.done"]);
    expect(r.exit).toBe(0);

    // Journal sanity: a sequence of CLI-driven entries from submit through
    // step_done auto-promote.
    const journal = await fsP.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lines = journal.trim().split("\n").map((l) => JSON.parse(l));
    const cliEntries = lines.filter((l) =>
      ["event:tasks_planned", "event:task_claimed", "event:task_step_started",
        "event:task_step_done"].includes(l.kind),
    );
    // 1 tasks_planned + 1 task_claimed + 2 task_step_started + 2 task_step_done = 6
    expect(cliEntries.length).toBe(6);
    expect(cliEntries[cliEntries.length - 1].kind).toBe("event:task_step_done");
    expect(cliEntries[cliEntries.length - 1].payload.step).toBe("implement");

    // Slice 2 done-when: planning + execution lifecycle commands all
    // landed through public CLI. SC4 final.
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice A SC-A2 — spec.md projection writer e2e unlock.
//
// Proves the full TRIAGE → SPEC → EXECUTE.plan chain walks through the
// public CLI WITHOUT any hand-written spec.md. spec.md is produced
// exclusively by Pass 5 (post-appendMany projection writer) from
// Snapshot.spec_header + .requirements / .scenarios / .visual_contracts.
//
// Closes Slice 4 SC4 deferred e2e (`gate decide spec-lock --approve`
// previously blocked because evaluateSpecLock reads spec.md from disk
// and no reducer apply wrote it; Slice A widens Snapshot + Pass 5
// renders the projection).
// ─────────────────────────────────────────────────────────────────────────

describe("End-to-end SPEC content → spec-lock approve (Slice A SC-A2)", () => {
  test("init → submit → add-req → tasks submit → advance → gate decide spec-lock --approve walks through", async () => {
    const dir = await tmpFeatureDir();
    const cli = (args: string[], env?: Record<string, string | undefined>) =>
      runCli(
        args.concat(["--feature", "auth-refresh", "--feature-dir", dir]),
        env ? { env } : {},
      );

    // 1. start session (TRIAGE.score). Uses runCli directly because
    // `loaf start` takes the feature as a positional arg and does not
    // accept the helper's --feature flag.
    let r = await runCli(
      ["start", "auth-refresh", "--ceremony", "standard", "--feature-dir", dir],
    );
    expect(r.exit).toBe(0);

    // 2. spec init — scaffold spec.md template. Pass 5 hasn't fired yet
    // because no spec_*_added events have flowed.
    r = await cli([
      "spec", "init",
      "--feature-id", "F-001",
      "--feature-name", "OAuth token refresh",
      "--intent", "users should not perceive auth recovery flows in flight",
    ]);
    expect(r.exit).toBe(0);

    // 3. Walk TRIAGE → SPEC.proposal so spec submit is legal.
    r = await cli(["advance", "TRIAGE.confirm"]);
    expect(r.exit).toBe(0);
    r = await cli(["advance", "SPEC.proposal"]);
    expect(r.exit).toBe(0);

    // 4. spec submit — whole-replacement entry. Pass 5 NOW writes spec.md
    // from snapshot (overwrites the init scaffold).
    const submitFile = path.join(dir, ".submit.json");
    await fsP.writeFile(
      submitFile,
      JSON.stringify({
        feature: { id: "F-001", name: "OAuth token refresh" },
        intent: "users should not perceive auth recovery flows in flight",
        adr_refs: [],
        requirements: [],
        scenarios: [],
        visual_contracts: [],
        needs_clarification: [],
      }),
    );
    r = await cli(["spec", "submit", "--input", submitFile]);
    expect(r.exit).toBe(0);

    // After submit, spec.md must be readable + Pass 5 wrote feature.id=F-001.
    const specAfterSubmit = await fsP.readFile(path.join(dir, "spec.md"), "utf8");
    expect(specAfterSubmit).toMatch(/^---/);
    expect(specAfterSubmit).toContain("F-001");
    expect(specAfterSubmit).toContain("OAuth token refresh");

    // 5. spec add-req — adds REQ-AUTH-001 (full body, e.g. event-driven).
    const addReqFile = path.join(dir, ".add-req.json");
    await fsP.writeFile(
      addReqFile,
      JSON.stringify({
        id_namespace: "REQ-AUTH",
        type: "ubiquitous",
        response: "the system shall do something measurable here",
        acceptance_na: true,
        acceptance_na_reason: "subjective UX validated via manual testing scope",
      }),
    );
    r = await cli(["spec", "add-req", "--input", addReqFile]);
    expect(r.exit).toBe(0);

    // After add-req, Pass 5 rewrote spec.md including REQ-AUTH-001.
    const specAfterAddReq = await fsP.readFile(path.join(dir, "spec.md"), "utf8");
    expect(specAfterAddReq).toContain("REQ-AUTH-001");

    // 6. Walk SPEC.proposal → SPEC.spec → SPEC.plan → SPEC.design.
    for (const to of ["SPEC.spec", "SPEC.plan", "SPEC.design"]) {
      r = await cli(["advance", to]);
      expect(r.exit).toBe(0);
    }

    // 7. tasks submit — task graph at SPEC.design, drives REQ-AUTH-001.
    // Required for spec-lock check 3 (tasks_based_on.spec) + check 4
    // (REQ_NOT_DRIVEN).
    const tasksFile = path.join(dir, ".tasks.json");
    await fsP.writeFile(
      tasksFile,
      JSON.stringify({
        based_on: { spec: 2 },  // spec_version is 2 after add-req
        tasks: [
          {
            id: "T-001",
            kind: "behavioral",
            drives: ["REQ-AUTH-001"],
            tests: ["TokenCoord.refreshOnce"],
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
    );
    r = await cli(["tasks", "submit", tasksFile, "--json"]);
    expect(r.exit).toBe(0);

    // 8. THE UNLOCK — gate decide spec-lock --approve walks through.
    // evaluateSpecLock reads spec.md (Pass-5-rendered) + parses
    // SpecFrontmatter + runs 8 checks. Returns ok → batch [gate:decided,
    // phase_advanced SPEC.design → EXECUTE.plan] appends.
    //
    // Note: this batch contains NO kinds from SPEC_EMITTING_KINDS so
    // Pass 5 does NOT run here — the final state flip
    // (spec_locked=true + cursor=EXECUTE.plan) comes from the reducer
    // apply of the batch + the next `loaf status` projection read.
    // Pass 5 was already exercised by steps 4 (spec submit) and 5
    // (spec add-req); evaluateSpecLock now reads what those writes
    // produced.
    r = await cli(
      ["gate", "decide", "spec-lock", "--approve", "--reason", "e2e unlock SC-A2", "--json"],
      { LOAF_USER: "e2e@test.invalid" },
    );
    expect(r.exit).toBe(0);
    const gateOut = JSON.parse(r.stdout);
    expect(gateOut.ok).toBe(true);

    // 9. Verify final state via status.
    r = await cli(["status", "--json"]);
    expect(r.exit).toBe(0);
    const status = JSON.parse(r.stdout);
    expect(status.state.sub_state).toBe("EXECUTE.plan");
    expect(status.state.spec_locked).toBe(true);

    // Slice A SC-A2 done-when: full CLI walk with spec.md produced
    // entirely by Pass 5 projection writer.
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice B — CLI shell test for `loaf finding raise --action amend-spec`
// (codex r98 §1 fix: text-mode stdout MUST stay bare FND-id; r98 added
// CLI-level coverage gap callout. Raw mutateBatch tests in
// amend-spec-back-edge.test.ts prove the stable core; this test proves
// the public command branch + stdout contract).
// ─────────────────────────────────────────────────────────────────────────

describe("loaf finding raise --action amend-spec — Slice B CLI shell", () => {
  test("post-lock EXECUTE.work amend-spec: bare FND-id stdout + journal back-edge + snapshot SPEC.spec/!spec_locked", async () => {
    const dir = await tmpFeatureDir();
    const cli = (args: string[], env?: Record<string, string | undefined>) =>
      runCli(
        args.concat(["--feature", "auth-refresh", "--feature-dir", dir]),
        env ? { env } : {},
      );

    // Seed: SPEC.design with spec.md + planned tasks (Slice 4 fixture).
    await seedFeatureAtSpecDesign(dir);

    // Approve spec-lock → EXECUTE.plan with spec_locked=true. Walk
    // forward to EXECUTE.work where finding:raised is authorized.
    let r = await cli(
      ["gate", "decide", "spec-lock", "--approve", "--reason", "slice-b cli shell test"],
      { LOAF_USER: "engineer@test.invalid" },
    );
    expect(r.exit).toBe(0);
    r = await cli(["advance", "EXECUTE.work"]);
    expect(r.exit).toBe(0);

    // The actual SUT call: amend-spec back-edge in text mode.
    r = await cli(
      ["finding", "raise", "--category", "spec-gap", "--action", "amend-spec",
       "--summary", "missed REQ-XXX coverage"],
      { LOAF_USER: "engineer@test.invalid" },
    );

    // Assertion 1: exit 0.
    expect(r.exit).toBe(0);

    // Assertion 2: text stdout exactly `FND-001\n` (codex r98 §1 fix —
    // no decorated "back-edge ..." annotation; pipeable contract).
    expect(r.stdout).toBe("FND-001\n");

    // Assertion 3: journal tail has [finding:raised, event:phase_advanced]
    // with payload.back_edge.finding_id="FND-001".
    const journal = await fsP.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lines = journal.trim().split("\n").map((l) => JSON.parse(l));
    const tail = lines.slice(-2);
    expect(tail[0]!.kind).toBe("finding:raised");
    expect(tail[0]!.payload.id).toBe("FND-001");
    expect(tail[0]!.payload.action).toBe("amend-spec");
    expect(tail[1]!.kind).toBe("event:phase_advanced");
    expect(tail[1]!.payload.from).toBe("EXECUTE.work");
    expect(tail[1]!.payload.to).toBe("SPEC.spec");
    expect(tail[1]!.payload.back_edge).toEqual({
      action: "amend-spec",
      finding_id: "FND-001",
    });
    // Batch envelope: both entries share batch_id with index 0/1, count 2.
    expect(tail[0]!.batch_id).toBe(tail[1]!.batch_id);
    expect(tail[0]!.batch_index).toBe(0);
    expect(tail[1]!.batch_index).toBe(1);
    expect(tail[0]!.batch_count).toBe(2);
    // Actor split: finding:raised uses the CLI's default actor
    // (cli:loaf@<user> at cli.tsx:91, since finding raise does NOT
    // call resolveHumanActor); the back-edge phase_advanced is
    // explicitly bare "cli:loaf" (derived, no user attribution).
    expect(tail[0]!.actor).toMatch(/^cli:loaf/);
    expect(tail[1]!.actor).toBe("cli:loaf");

    // Assertion 4: status snapshot post-back-edge.
    r = await cli(["status", "--json"]);
    expect(r.exit).toBe(0);
    const status = JSON.parse(r.stdout);
    expect(status.state.sub_state).toBe("SPEC.spec");
    expect(status.state.spec_locked).toBe(false);
  });

  test("amend-spec JSON mode emits structured back_edge field (back_edge from/to)", async () => {
    const dir = await tmpFeatureDir();
    const cli = (args: string[], env?: Record<string, string | undefined>) =>
      runCli(
        args.concat(["--feature", "auth-refresh", "--feature-dir", dir]),
        env ? { env } : {},
      );
    await seedFeatureAtSpecDesign(dir);
    let r = await cli(
      ["gate", "decide", "spec-lock", "--approve", "--reason", "slice-b json"],
      { LOAF_USER: "engineer@test.invalid" },
    );
    expect(r.exit).toBe(0);
    r = await cli(["advance", "EXECUTE.work"]);
    expect(r.exit).toBe(0);
    r = await cli(
      ["finding", "raise", "--category", "spec-gap", "--action", "amend-spec",
       "--json"],
      { LOAF_USER: "engineer@test.invalid" },
    );
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      feature: "auth-refresh",
      id: "FND-001",
      category: "spec-gap",
      action: "amend-spec",
      back_edge: { from: "EXECUTE.work", to: "SPEC.spec" },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// loaf tasks complete — Slice C SC-C1
//
// `tasks complete <T-id>` is a NO-OP confirmation command (codex r101 Q2=a):
// it emits NO journal entry. event:task_step_done already auto-promotes a
// task to status=done when every must-applicable step is terminal-positive
// (passed|waived|na), so `tasks complete` confirms that invariant and exits
// 0 — or fails TASK_COMPLETE_PRECONDITION_VIOLATED exit 2, listing the
// must-applicable steps still not terminal. Read-only: no journal append,
// no sub_state gate.
// ─────────────────────────────────────────────────────────────────────────

describe("loaf tasks complete — Slice C SC-C1 (NO-OP confirmation)", () => {
  async function driveTaskToDone(dir: string): Promise<void> {
    await runCli(["tasks", "claim", "T-001", "--feature", "auth-refresh", "--feature-dir", dir]);
    for (const step of ["red", "implement"]) {
      await runCli([
        "tasks", "step", "start", "--task", "T-001", "--step", step,
        "--feature", "auth-refresh", "--feature-dir", dir,
      ]);
      await runCli([
        "tasks", "step", "done", "--task", "T-001", "--step", step, "--result", "passed",
        "--feature", "auth-refresh", "--feature-dir", dir,
      ]);
    }
  }

  test("happy: task with all must steps passed → exit 0, status=done", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);
    await driveTaskToDone(dir);

    const r = await runCli([
      "tasks", "complete", "T-001",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      feature: "auth-refresh",
      task_id: "T-001",
      status: "done",
    });
  });

  test("happy text mode: prints confirmation line", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);
    await driveTaskToDone(dir);

    const r = await runCli([
      "tasks", "complete", "T-001",
      "--feature", "auth-refresh", "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(0);
    // Exact stdout match — pins the text-mode confirmation as a
    // composition contract (codex r104 note 1).
    expect(r.stdout).toBe("T-001 complete (status=done)\n");
  });

  test("NO-OP: emits no journal entry — journal line count unchanged", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);
    await driveTaskToDone(dir);

    const journalPath = path.join(dir, "journal.jsonl");
    const before = (await fs.readFile(journalPath, "utf8")).trimEnd().split("\n").length;
    const r = await runCli([
      "tasks", "complete", "T-001",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(0);
    const after = (await fs.readFile(journalPath, "utf8")).trimEnd().split("\n").length;
    expect(after).toBe(before);
  });

  test("fail: a must step still pending → TASK_COMPLETE_PRECONDITION_VIOLATED exit 2", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);
    // claim + only `red` done; `implement` (must) stays pending → no auto-promote.
    await runCli(["tasks", "claim", "T-001", "--feature", "auth-refresh", "--feature-dir", dir]);
    await runCli([
      "tasks", "step", "start", "--task", "T-001", "--step", "red",
      "--feature", "auth-refresh", "--feature-dir", dir,
    ]);
    await runCli([
      "tasks", "step", "done", "--task", "T-001", "--step", "red", "--result", "passed",
      "--feature", "auth-refresh", "--feature-dir", dir,
    ]);

    const r = await runCli([
      "tasks", "complete", "T-001",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(r.stdout).toBe("");
    const err = JSON.parse(r.stderr.trim());
    expect(err.code).toBe("TASK_COMPLETE_PRECONDITION_VIOLATED");
    expect(err.detail.task_id).toBe("T-001");
    expect(err.detail.blocking_steps).toContain("implement");
    expect(err.detail.blocking_steps).not.toContain("red");
  });

  test("fail: untouched task → exit 2, blocking_steps lists every must step", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);

    const r = await runCli([
      "tasks", "complete", "T-001",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    const err = JSON.parse(r.stderr.trim());
    expect(err.code).toBe("TASK_COMPLETE_PRECONDITION_VIOLATED");
    expect(err.detail.blocking_steps).toEqual(
      expect.arrayContaining(["red", "implement"]),
    );
  });

  test("fail: unknown task → TASK_NOT_FOUND exit 2", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);

    const r = await runCli([
      "tasks", "complete", "T-999",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(r.stdout).toBe("");
    const err = JSON.parse(r.stderr.trim());
    expect(err.code).toBe("TASK_NOT_FOUND");
    expect(err.detail.task_id).toBe("T-999");
  });

  test("fail text mode: renders error line", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir);

    const r = await runCli([
      "tasks", "complete", "T-001",
      "--feature", "auth-refresh", "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/error: TASK_COMPLETE_PRECONDITION_VIOLATED/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// loaf tasks amend — Slice C SC-C2c
//
// `tasks amend <T-id> --policy <step>=<applicability>` narrowly mutates a
// task's execution[].applicability at EXECUTE.plan (protocol §1822 / §8.6).
// The CLI reconstructs the whole-task event:tasks_amended payload from the
// canonical journal body (latestCanonicalTaskBody) overlaid with live
// runtime state (materializeTaskForAmend), then applies the --policy
// deltas — so body-only fields (tests / evidence_refs / …) survive.
// ─────────────────────────────────────────────────────────────────────────

describe("loaf tasks amend — Slice C SC-C2c (--policy applicability mutation)", () => {
  async function seedFeatureAtExecutePlan(dir: string): Promise<void> {
    await seedFeatureAtSpecDesign(dir);
    const lock = await runCli(
      [
        "gate", "decide", "spec-lock", "--approve",
        "--reason", "sc2c-seed: spec ready",
        "--feature", "auth-refresh", "--feature-dir", dir, "--json",
      ],
      { env: { LOAF_USER: "sc2c-seed@test.invalid" } },
    );
    if (lock.exit !== 0) throw new Error(`sc2c-seed spec-lock failed: ${lock.stderr}`);
  }

  test("happy: --policy refactor=na flips the step applicability at EXECUTE.plan", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecutePlan(dir);

    const r = await runCli([
      "tasks", "amend", "T-001", "--policy", "refactor=na",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.task_id).toBe("T-001");

    const list = await runCli([
      "tasks", "list", "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    const listed = JSON.parse(list.stdout);
    const t001 = listed.tasks.find((t: { id: string }) => t.id === "T-001");
    expect(t001.steps.refactor.applicability).toBe("na");
  });

  test("happy: multiple --policy flags apply in one amend", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecutePlan(dir);

    const r = await runCli([
      "tasks", "amend", "T-001",
      "--policy", "refactor=na", "--policy", "red=optional",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(0);

    const list = await runCli([
      "tasks", "list", "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    const t001 = JSON.parse(list.stdout).tasks.find((t: { id: string }) => t.id === "T-001");
    expect(t001.steps.refactor.applicability).toBe("na");
    expect(t001.steps.red.applicability).toBe("optional");
  });

  test("preserves canonical body fields the slim projection drops", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecutePlan(dir);
    await runCli([
      "tasks", "amend", "T-001", "--policy", "refactor=na",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    // The emitted event:tasks_amended must carry the canonical `tests`
    // field — materializeTaskForAmend recovers it from the journal body.
    const journal = await fsP.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lastAmend = journal
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.kind === "event:tasks_amended")
      .at(-1);
    expect(lastAmend.payload.task.tests).toEqual(["TokenCoord.refreshOnce"]);
  });

  test("fail: unknown task → TASK_NOT_FOUND", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecutePlan(dir);
    const r = await runCli([
      "tasks", "amend", "T-404", "--policy", "refactor=na",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("TASK_NOT_FOUND");
  });

  test("fail: unknown step in --policy → TASK_STEP_NOT_FOUND", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecutePlan(dir);
    const r = await runCli([
      "tasks", "amend", "T-001", "--policy", "bogus=na",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("TASK_STEP_NOT_FOUND");
  });

  test("fail: invalid applicability value → SCHEMA_VALIDATION_FAILED", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecutePlan(dir);
    const r = await runCli([
      "tasks", "amend", "T-001", "--policy", "refactor=sometimes",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  test("fail: malformed --policy (no '=') → SCHEMA_VALIDATION_FAILED", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecutePlan(dir);
    const r = await runCli([
      "tasks", "amend", "T-001", "--policy", "refactor",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  test("fail: no --policy flag → SCHEMA_VALIDATION_FAILED", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecutePlan(dir);
    const r = await runCli([
      "tasks", "amend", "T-001",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  test("fail: duplicate step in --policy → SCHEMA_VALIDATION_FAILED", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecutePlan(dir);
    const r = await runCli([
      "tasks", "amend", "T-001",
      "--policy", "refactor=na", "--policy", "refactor=optional",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  test("fail: amend outside EXECUTE.plan → MUTATION_OUT_OF_RIGHTS", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir); // cursor at EXECUTE.work
    const r = await runCli([
      "tasks", "amend", "T-001", "--policy", "refactor=na",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("MUTATION_OUT_OF_RIGHTS");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// loaf tasks add — Slice C SC-C3
//
// `tasks add --input <src>` appends id-less task(s) to the graph at
// SPEC.design (protocol §1818 / emit table L1866). It is the append
// variant of `tasks submit`: it emits ONE whole-replacement
// event:tasks_planned whose payload.tasks is the re-materialized existing
// graph plus the newly seeded tasks. The CLI allocates each T-id
// (max-serial+1, zero-pad ≥3); the input must not carry `id` (§706).
// EXECUTE-phase add is the future finding amend-tasks flow, not this path
// (codex r111 Q3).
// ─────────────────────────────────────────────────────────────────────────

describe("loaf tasks add — Slice C SC-C3 (SPEC.design append)", () => {
  // Protocol-shaped TaskInput: omits id / status / execution (all
  // CLI-owned, codex r113). The CLI allocates the id, sets status=pending,
  // and initializes the per-kind execution map.
  function taskInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kind: "behavioral",
      drives: ["REQ-AUTH-002"],
      tests: ["NewFeature.spec"],
      ...overrides,
    };
  }

  async function writeInput(dir: string, content: unknown): Promise<string> {
    const p = path.join(dir, ".add-input.json");
    await fsP.writeFile(p, JSON.stringify(content));
    return p;
  }

  test("happy: append a single task at SPEC.design → CLI allocates id + execution", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir); // cursor at SPEC.design, T-001 submitted
    const input = await writeInput(dir, taskInput());

    const r = await runCli([
      "tasks", "add", input,
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.task_ids).toEqual(["T-002"]);

    const list = await runCli([
      "tasks", "list", "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    const listed = JSON.parse(list.stdout).tasks;
    expect(listed.map((t: { id: string }) => t.id)).toEqual(["T-001", "T-002"]);
    // CLI-initialized execution: every behavioral step seeded must/pending.
    const t002 = listed.find((t: { id: string }) => t.id === "T-002");
    expect(t002.status).toBe("pending");
    expect(Object.keys(t002.steps).sort()).toEqual(["implement", "red", "refactor"]);
    expect(t002.steps.refactor.applicability).toBe("must");
  });

  test("happy: batch add allocates consecutive T-ids", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);
    const input = await writeInput(dir, [taskInput(), taskInput()]);

    const r = await runCli([
      "tasks", "add", input,
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout).task_ids).toEqual(["T-002", "T-003"]);
  });

  test("re-emit preserves the existing graph's task bodies", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);
    const input = await writeInput(dir, taskInput());
    await runCli([
      "tasks", "add", input,
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    // The emitted tasks_planned must carry T-001 with its canonical body.
    const journal = await fsP.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lastPlan = journal
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.kind === "event:tasks_planned")
      .at(-1);
    const t001 = lastPlan.payload.tasks.find((t: { id: string }) => t.id === "T-001");
    expect(t001.tests).toEqual(["TokenCoord.refreshOnce"]);
    expect(lastPlan.payload.tasks.map((t: { id: string }) => t.id)).toEqual(["T-001", "T-002"]);
  });

  test("fail: input carrying `id` is rejected (§706 — id is CLI-allocated)", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);
    const input = await writeInput(dir, taskInput({ id: "T-099" }));

    const r = await runCli([
      "tasks", "add", input,
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  test("fail: input carrying `execution` is rejected (CLI initializes it)", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);
    const input = await writeInput(
      dir,
      taskInput({
        execution: {
          red: { applicability: "must", status: "pending", evidence_refs: [] },
          implement: { applicability: "must", status: "pending", evidence_refs: [] },
          refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
        },
      }),
    );

    const r = await runCli([
      "tasks", "add", input,
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  test("fail: input carrying `status` is rejected (CLI sets it to pending)", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);
    const input = await writeInput(dir, taskInput({ status: "ready" }));

    const r = await runCli([
      "tasks", "add", input,
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  test("fail: malformed JSON input → SCHEMA_VALIDATION_FAILED", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);
    const p = path.join(dir, ".bad-input.json");
    await fsP.writeFile(p, "{ not json");

    const r = await runCli([
      "tasks", "add", p,
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  test("fail: missing input file → INPUT_FILE_NOT_FOUND", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtSpecDesign(dir);

    const r = await runCli([
      "tasks", "add", path.join(dir, "nonexistent.json"),
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("INPUT_FILE_NOT_FOUND");
  });

  test("fail: tasks add outside SPEC.design → SUB_STATE_AUTHORITY_VIOLATION", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir); // cursor at EXECUTE.work
    const input = await writeInput(dir, taskInput());

    const r = await runCli([
      "tasks", "add", input,
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("SUB_STATE_AUTHORITY_VIOLATION");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// loaf tasks register-red — Slice C SC-C4 (R2)
//
// `tasks register-red <T-N>` records that the failing RED test for a
// behavioral+bug task is in place — it emits one
// event:task_step_done {step:"red", result:"passed", red_test_registered:true}.
// Until then the bug task's `implement` step is gated by
// BUG_TASK_REQUIRES_RED. Ordering: claim → register-red → step implement.
// ─────────────────────────────────────────────────────────────────────────

describe("loaf tasks register-red — Slice C SC-C4 (R2)", () => {
  // Seed a claimed behavioral+bug task (T-002) at EXECUTE.work: add it at
  // SPEC.design via `tasks add`, lock the spec, advance, claim it.
  async function seedClaimedBugTask(dir: string): Promise<void> {
    await seedFeatureAtSpecDesign(dir);
    const input = path.join(dir, ".bug-seed.json");
    await fsP.writeFile(
      input,
      JSON.stringify({ kind: "behavioral", drives: ["REQ-AUTH-001"], tests: ["Bug.repro"], labels: ["bug"] }),
    );
    let r = await runCli([
      "tasks", "add", input, "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    if (r.exit !== 0) throw new Error(`seed tasks add failed: ${r.stderr}`);
    r = await runCli(
      ["gate", "decide", "spec-lock", "--approve", "--reason", "sc4-seed", "--feature", "auth-refresh", "--feature-dir", dir, "--json"],
      { env: { LOAF_USER: "sc4-seed@test.invalid" } },
    );
    if (r.exit !== 0) throw new Error(`seed spec-lock failed: ${r.stderr}`);
    r = await runCli(["advance", "EXECUTE.work", "--feature", "auth-refresh", "--feature-dir", dir]);
    if (r.exit !== 0) throw new Error(`seed advance failed: ${r.stderr}`);
    r = await runCli(["tasks", "claim", "T-002", "--feature", "auth-refresh", "--feature-dir", dir]);
    if (r.exit !== 0) throw new Error(`seed claim failed: ${r.stderr}`);
  }

  test("happy: register-red on a claimed bug task → exit 0", async () => {
    const dir = await tmpFeatureDir();
    await seedClaimedBugTask(dir);
    const r = await runCli([
      "tasks", "register-red", "T-002",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout).task_id).toBe("T-002");
  });

  test("register-red opens the implement gate (BUG_TASK_REQUIRES_RED before, OK after)", async () => {
    const dir = await tmpFeatureDir();
    await seedClaimedBugTask(dir);

    // Before register-red — implement is gated.
    let r = await runCli([
      "tasks", "step", "start", "--task", "T-002", "--step", "implement",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("BUG_TASK_REQUIRES_RED");

    // Register RED, then implement starts.
    r = await runCli([
      "tasks", "register-red", "T-002",
      "--feature", "auth-refresh", "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(0);
    r = await runCli([
      "tasks", "step", "start", "--task", "T-002", "--step", "implement",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(0);
  });

  test("fail: register-red on a non-bug task → BUG_TASK_FLAG_MISUSE", async () => {
    const dir = await tmpFeatureDir();
    await seedFeatureAtExecuteWork(dir); // T-001 is a non-bug behavioral task
    await runCli(["tasks", "claim", "T-001", "--feature", "auth-refresh", "--feature-dir", dir]);
    const r = await runCli([
      "tasks", "register-red", "T-001",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("BUG_TASK_FLAG_MISUSE");
  });

  test("fail: register-red on an unknown task → TASK_NOT_FOUND", async () => {
    const dir = await tmpFeatureDir();
    await seedClaimedBugTask(dir);
    const r = await runCli([
      "tasks", "register-red", "T-404",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("TASK_NOT_FOUND");
  });

  test("fail: register-red on an unclaimed task → TASK_NOT_CLAIMED", async () => {
    const dir = await tmpFeatureDir();
    await seedClaimedBugTask(dir);
    // T-001 (from seedFeatureAtSpecDesign) was never claimed.
    const r = await runCli([
      "tasks", "register-red", "T-001",
      "--feature", "auth-refresh", "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("TASK_NOT_CLAIMED");
  });
});
