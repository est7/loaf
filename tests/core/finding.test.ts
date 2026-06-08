// Slice 3 SC3 — `loaf finding raise/list/close` + FINDING_ACTION_GRID +
// target_payload preflight promotion.
//
// RED first: every new-behavior assertion below fails on pre-SC3 main
// (no `loaf finding` command tree; FindingRaisedPayload still loose
// `{id: min(1), category: min(1), action: min(1)}`; grid + target
// invariants not enforced; reducer close-on-closed silently succeeds).
//
// Scope per codex r68 conditional sign-off (thread review/cli-lifecycle-plan):
//   - 3 CLI verbs: raise / list / close (positional <FND-id>).
//   - Schema tighten: FindingId `^FND-\d{3,}$`, FindingCategory (6 enum),
//     FindingAction (6 enum), summary/reason/target as typed optional
//     payload fields (mirror docs/schemas.ts §5/§37).
//   - FINDING_ACTION_GRID 6×6 (typical/unusual/incoherent per
//     FindingActionRisk; rev 4.3 ADR-0004 A7); incoherent block →
//     FINDING_ACTION_INCOHERENT; unusual requires --reason ≥20 →
//     FINDING_ACTION_UNUSUAL_REASON_REQUIRED.
//   - target_payload preflight: fix-impl needs `{task_id, step:"implement"}`,
//     fix-test needs `{task_id, step:"red"}`, amend-tasks accepts
//     optional `{task_id, step}` but validates if present. Reuse
//     FINDING_TARGET_REQUIRED with detail.reason ∈ {missing,
//     task_not_found, step_mismatch, step_not_found}.
//   - Projection: FindingState extended with optional summary/reason/target
//     so `finding list --json` surfaces user-input rounds.
//   - Close: repeated close on already-closed finding → FINDING_NOT_FOUND
//     with detail.reason="already_closed" (reducer searches open-only).
//   - Defer to SC4: back-edge batches (amend-spec → SPEC.spec advance,
//     amend-tasks → tasks_amended + EXECUTE.work, fix-impl/fix-test →
//     tasks.execution.<step>.status="running" mutation).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import { mutate } from "../../src/core/journal-mutate.js";
import { appendEntry } from "../../src/core/journal-append.js";
import type { SubState } from "../../src/core/journal-entry.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-finding-test-"));
}

async function runCli(argv: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    err.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await main(["node", "loaf", ...argv]);
    return { exit, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

async function loadSnapshot(
  dir: string,
): Promise<{ snapshot: any; tail_seq: number; entries: any; meta: any }> {
  const { loadSession } = await import("../../src/core/cli-runtime.js");
  return await loadSession(dir);
}

async function readJournalLines(dir: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    return raw.trim() === "" ? [] : raw.trim().split("\n");
  } catch {
    return [];
  }
}

/**
 * Quick-ceremony walk to EXECUTE.plan via raw mutate.
 * finding:raised is legal at all VERIFY_OR_POST_LOCK_EXECUTE substates,
 * which includes EXECUTE.plan — no tasks needed for basic raise/list/close.
 */
async function seedQuickAtExecutePlan(): Promise<{ dir: string; feature: string }> {
  const dir = await tmpFeatureDir();
  const feature = "F1";
  const startRes = await runCli([
    "start",
    feature,
    "--ceremony",
    "quick",
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  if (startRes.exit !== 0) throw new Error(`start failed: ${startRes.stderr}`);
  const edges: Array<[SubState, SubState]> = [
    ["TRIAGE.score", "TRIAGE.confirm"],
    ["TRIAGE.confirm", "EXECUTE.plan"],
  ];
  for (const [from, to] of edges) {
    const s = await loadSnapshot(dir);
    const r = await mutate(
      {
        at: new Date().toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from, to },
      },
      {
        feature_dir: dir,
        snapshot: s.snapshot,
        tail_seq: s.tail_seq,
        entries: s.entries,
        meta: s.meta,
        fsync: false,
      },
    );
    if (!r.ok) throw new Error(`walk ${from}→${to} failed: ${r.code} ${r.message}`);
  }
  return { dir, feature };
}

/**
 * As seedQuickAtExecutePlan, plus one more forward edge to EXECUTE.work.
 * Phase 11 Item 3 SC1 made `finding raise --action amend-tasks` co-emit a
 * back-edge to EXECUTE.work; EXECUTE.plan is deliberately excluded from
 * the amend-tasks from-set (the planning surface uses the plain forward
 * edge), so amend-tasks grid-enforcement tests must seed at EXECUTE.work.
 */
async function seedQuickAtExecuteWork(): Promise<{ dir: string; feature: string }> {
  const { dir, feature } = await seedQuickAtExecutePlan();
  const s = await loadSnapshot(dir);
  const r = await mutate(
    {
      at: new Date().toISOString(),
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "event:phase_advanced",
      payload: { from: "EXECUTE.plan", to: "EXECUTE.work" },
    },
    {
      feature_dir: dir,
      snapshot: s.snapshot,
      tail_seq: s.tail_seq,
      entries: s.entries,
      meta: s.meta,
      fsync: false,
    },
  );
  if (!r.ok) throw new Error(`walk EXECUTE.plan→EXECUTE.work failed: ${r.code} ${r.message}`);
  return { dir, feature };
}

/**
 * Light-ceremony walk to EXECUTE.work with a behavioral task T-001 seeded
 * into the projection via event:tasks_planned. Needed for target_payload
 * tests where preflight must verify task.id and task.steps[step] exist.
 *
 * Walk: TRIAGE.score → TRIAGE.confirm → SPEC.proposal → SPEC.spec →
 * SPEC.plan → SPEC.design → emit spec_submitted (spec_version=1) →
 * emit tasks_planned (based_on.spec=1, one behavioral task) → EXECUTE.plan
 * → EXECUTE.work. spec_phase=true on light enables the SPEC.* fork.
 */
async function seedLightAtExecuteWorkWithTask(): Promise<{ dir: string; feature: string }> {
  const dir = await tmpFeatureDir();
  const feature = "F1";
  const startRes = await runCli([
    "start",
    feature,
    "--ceremony",
    "light",
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  if (startRes.exit !== 0) throw new Error(`start failed: ${startRes.stderr}`);
  const edges: Array<[SubState, SubState]> = [
    ["TRIAGE.score", "TRIAGE.confirm"],
    ["TRIAGE.confirm", "SPEC.proposal"],
    ["SPEC.proposal", "SPEC.spec"],
    ["SPEC.spec", "SPEC.plan"],
    ["SPEC.plan", "SPEC.design"],
  ];
  for (const [from, to] of edges) {
    const s = await loadSnapshot(dir);
    const r = await mutate(
      {
        at: new Date().toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from, to },
      },
      {
        feature_dir: dir,
        snapshot: s.snapshot,
        tail_seq: s.tail_seq,
        entries: s.entries,
        meta: s.meta,
        fsync: false,
      },
    );
    if (!r.ok) throw new Error(`walk ${from}→${to} failed: ${r.code} ${r.message}`);
  }
  // spec_submitted at SPEC.design (legal — ALL_SPEC sub_state authority).
  const s1 = await loadSnapshot(dir);
  const submitted = await mutate(
    {
      at: new Date().toISOString(),
      actor: "human:seed@test.invalid",
      entry_schema_version: 1,
      kind: "event:spec_submitted",
      payload: {
        spec_version: 1,
        feature: { id: "F-001", name: "Finding test fixture" },
        intent: "exercise SC3 finding target_payload preflight",
        adr_refs: [],
        needs_clarification: [],
      },
    },
    {
      feature_dir: dir,
      snapshot: s1.snapshot,
      tail_seq: s1.tail_seq,
      entries: s1.entries,
      meta: s1.meta,
      fsync: false,
    },
  );
  if (!submitted.ok)
    throw new Error(`spec_submitted failed: ${submitted.code} ${submitted.message}`);
  // tasks_planned with one behavioral task that has implement + red steps.
  const s2 = await loadSnapshot(dir);
  const planned = await mutate(
    {
      at: new Date().toISOString(),
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "event:tasks_planned",
      payload: {
        based_on: { spec: 1 },
        tasks: [
          {
            id: "T-001",
            kind: "behavioral",
            status: "pending",
            depends_on: [],
            labels: [],
            drives: ["REQ-AUTH-001"],
            tests: ["tests/sample.test.ts"],
            execution: {
              red: {
                applicability: "must",
                status: "pending",
                evidence_refs: [],
              },
              implement: {
                applicability: "must",
                status: "pending",
                evidence_refs: [],
              },
              refactor: {
                applicability: "optional",
                status: "pending",
                evidence_refs: [],
              },
            },
          },
        ],
      },
    },
    {
      feature_dir: dir,
      snapshot: s2.snapshot,
      tail_seq: s2.tail_seq,
      entries: s2.entries,
      meta: s2.meta,
      fsync: false,
    },
  );
  if (!planned.ok) throw new Error(`tasks_planned failed: ${planned.code} ${planned.message}`);
  // Approve spec-lock so SPEC.design → EXECUTE.plan passes the guard.
  // appendEntry bypasses Pass 1.5 (evaluateSpecLock); spec_locked=true on
  // replay is all the guard needs when the advance is later replayed.
  {
    const sg = await loadSnapshot(dir);
    const gateSeq = sg.tail_seq + 1;
    await appendEntry(
      path.join(dir, "journal.jsonl"),
      {
        seq: gateSeq,
        entry_id: `JE-${String(gateSeq + 1).padStart(6, "0")}`,
        at: new Date().toISOString(),
        actor: "human:est9",
        entry_schema_version: 1,
        kind: "gate:decided",
        payload: { gate_kind: "spec-lock", decision: "approved", reason: "seed" },
      },
      sg.meta,
      { fsync: false },
    );
  }
  // Walk to EXECUTE.work for finding tests.
  const advanceEdges: Array<[SubState, SubState]> = [
    ["SPEC.design", "EXECUTE.plan"],
    ["EXECUTE.plan", "EXECUTE.work"],
  ];
  for (const [from, to] of advanceEdges) {
    const s = await loadSnapshot(dir);
    const r = await mutate(
      {
        at: new Date().toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from, to },
      },
      {
        feature_dir: dir,
        snapshot: s.snapshot,
        tail_seq: s.tail_seq,
        entries: s.entries,
        meta: s.meta,
        fsync: false,
      },
    );
    if (!r.ok) throw new Error(`walk ${from}→${to} failed: ${r.code} ${r.message}`);
  }
  return { dir, feature };
}

describe("loaf finding raise — SC3 happy paths + schema tighten", () => {
  // Slice B note: these tests use action=defer (typical for spec-gap;
  // no back-edge / lock implications) so the quick-ceremony seed at
  // EXECUTE.plan with spec_locked=false still produces a happy raise.
  // amend-spec-specific assertions live in tests/core/amend-spec-back-edge.test.ts
  // (Slice B introduced FINDING_AMEND_SPEC_NOT_LOCKED to reject
  // pre-lock amend-spec; that's covered there, not here).
  test("raise typical (spec-gap × defer) → FND-001 stdout bare; projection populated", async () => {
    const { dir, feature } = await seedQuickAtExecutePlan();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "spec-gap",
      "--action",
      "defer",
      "--summary",
      "spec missing field X",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(0);
    expect(r.stdout.trim()).toBe("FND-001");

    const s = await loadSnapshot(dir);
    expect(s.snapshot.findings).toHaveLength(1);
    expect(s.snapshot.findings[0]).toMatchObject({
      id: "FND-001",
      category: "spec-gap",
      action: "defer",
      status: "open",
      summary: "spec missing field X",
    });
  });

  test("raise twice → FND-001 + FND-002 (allocator monotonic)", async () => {
    const { dir, feature } = await seedQuickAtExecutePlan();
    const r1 = await runCli([
      "finding",
      "raise",
      "--category",
      "spec-gap",
      "--action",
      "defer",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r1.stdout.trim()).toBe("FND-001");
    const r2 = await runCli([
      "finding",
      "raise",
      "--category",
      "impl-defect",
      "--action",
      "backlog",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r2.stdout.trim()).toBe("FND-002");
  });

  test("JSON mode emits {ok, feature, id, category, action}", async () => {
    const { dir, feature } = await seedQuickAtExecutePlan();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "spec-gap",
      "--action",
      "defer",
      "--feature",
      feature,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      feature,
      id: "FND-001",
      category: "spec-gap",
      action: "defer",
    });
  });

  test("raise with invalid category → INVALID_PAYLOAD (closed enum)", async () => {
    const { dir, feature } = await seedQuickAtExecutePlan();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "not-a-category",
      "--action",
      "amend-spec",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INVALID_PAYLOAD/);
  });

  test("raise with invalid action → INVALID_PAYLOAD (closed enum)", async () => {
    const { dir, feature } = await seedQuickAtExecutePlan();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "spec-gap",
      "--action",
      "not-an-action",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INVALID_PAYLOAD/);
  });

  test("raise at TRIAGE.score → SUB_STATE_AUTHORITY_VIOLATION (finding:raised needs VERIFY_OR_POST_LOCK_EXECUTE)", async () => {
    const dir = await tmpFeatureDir();
    const feature = "F1";
    await runCli([
      "start",
      feature,
      "--ceremony",
      "quick",
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "spec-gap",
      "--action",
      "amend-spec",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SUB_STATE_AUTHORITY_VIOLATION/);
  });
});

describe("loaf finding raise — FINDING_ACTION_GRID enforcement", () => {
  test("incoherent cell (spec-gap × fix-impl) → FINDING_ACTION_INCOHERENT", async () => {
    const { dir, feature } = await seedQuickAtExecutePlan();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "spec-gap",
      "--action",
      "fix-impl",
      "--target-task",
      "T-001",
      "--target-step",
      "implement",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/FINDING_ACTION_INCOHERENT/);
  });

  test("incoherent cell (new-scope × fix-test) → FINDING_ACTION_INCOHERENT", async () => {
    const { dir, feature } = await seedQuickAtExecutePlan();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "new-scope",
      "--action",
      "fix-test",
      "--target-task",
      "T-001",
      "--target-step",
      "red",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/FINDING_ACTION_INCOHERENT/);
  });

  test("unusual cell (spec-gap × amend-tasks) without --reason → FINDING_ACTION_UNUSUAL_REASON_REQUIRED", async () => {
    const { dir, feature } = await seedQuickAtExecutePlan();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "spec-gap",
      "--action",
      "amend-tasks",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/FINDING_ACTION_UNUSUAL_REASON_REQUIRED/);
  });

  test("unusual cell (spec-gap × amend-tasks) with --reason <20 chars → FINDING_ACTION_UNUSUAL_REASON_REQUIRED", async () => {
    const { dir, feature } = await seedQuickAtExecutePlan();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "spec-gap",
      "--action",
      "amend-tasks",
      "--reason",
      "short",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/FINDING_ACTION_UNUSUAL_REASON_REQUIRED/);
  });

  test("unusual cell with --reason ≥20 chars → succeeds", async () => {
    // SC1: amend-tasks co-emits a back-edge to EXECUTE.work, so the seed
    // must sit in the amend-tasks from-set (EXECUTE.plan is excluded).
    const { dir, feature } = await seedQuickAtExecuteWork();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "spec-gap",
      "--action",
      "amend-tasks",
      "--reason",
      "this reason is at least twenty characters long",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(0);
    expect(r.stdout.trim()).toBe("FND-001");
  });

  test("typical cell (impl-defect × amend-tasks) without --reason → succeeds", async () => {
    // SC1: see note above — seed at EXECUTE.work, not EXECUTE.plan.
    const { dir, feature } = await seedQuickAtExecuteWork();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "impl-defect",
      "--action",
      "amend-tasks",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(0);
  });
});

describe("loaf finding raise — target_payload preflight", () => {
  test("fix-impl with valid target {task_id, step:implement} → succeeds", async () => {
    const { dir, feature } = await seedLightAtExecuteWorkWithTask();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "impl-defect",
      "--action",
      "fix-impl",
      "--target-task",
      "T-001",
      "--target-step",
      "implement",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(0);
    expect(r.stdout.trim()).toBe("FND-001");

    const s = await loadSnapshot(dir);
    expect(s.snapshot.findings[0].target).toEqual({
      task_id: "T-001",
      step: "implement",
    });
  });

  test("fix-test with valid target {task_id, step:red} → succeeds", async () => {
    const { dir, feature } = await seedLightAtExecuteWorkWithTask();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "test-defect",
      "--action",
      "fix-test",
      "--target-task",
      "T-001",
      "--target-step",
      "red",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(0);
  });

  test("fix-impl with wrong step (red) → FINDING_TARGET_REQUIRED (step_mismatch)", async () => {
    const { dir, feature } = await seedLightAtExecuteWorkWithTask();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "impl-defect",
      "--action",
      "fix-impl",
      "--target-task",
      "T-001",
      "--target-step",
      "red",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/FINDING_TARGET_REQUIRED/);
  });

  test("fix-test with wrong step (implement) → FINDING_TARGET_REQUIRED", async () => {
    const { dir, feature } = await seedLightAtExecuteWorkWithTask();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "test-defect",
      "--action",
      "fix-test",
      "--target-task",
      "T-001",
      "--target-step",
      "implement",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/FINDING_TARGET_REQUIRED/);
  });

  test("fix-impl with unknown task → FINDING_TARGET_REQUIRED (task_not_found)", async () => {
    const { dir, feature } = await seedLightAtExecuteWorkWithTask();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "impl-defect",
      "--action",
      "fix-impl",
      "--target-task",
      "T-999",
      "--target-step",
      "implement",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/FINDING_TARGET_REQUIRED/);
  });

  test("fix-impl without target → FINDING_TARGET_REQUIRED (missing)", async () => {
    const { dir, feature } = await seedLightAtExecuteWorkWithTask();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "impl-defect",
      "--action",
      "fix-impl",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/FINDING_TARGET_REQUIRED/);
  });

  test("amend-tasks without target → succeeds (target_id_optional)", async () => {
    const { dir, feature } = await seedLightAtExecuteWorkWithTask();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "impl-defect",
      "--action",
      "amend-tasks",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(0);
  });

  test("amend-tasks with unknown task → FINDING_TARGET_REQUIRED (task_not_found)", async () => {
    const { dir, feature } = await seedLightAtExecuteWorkWithTask();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "impl-defect",
      "--action",
      "amend-tasks",
      "--target-task",
      "T-999",
      "--target-step",
      "implement",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/FINDING_TARGET_REQUIRED/);
  });

  test("partial --target-step without --target-task → USAGE before mutate", async () => {
    const { dir, feature } = await seedLightAtExecuteWorkWithTask();
    const before = await readJournalLines(dir);
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "impl-defect",
      "--action",
      "fix-impl",
      "--target-step",
      "implement",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/USAGE/);
    expect(await readJournalLines(dir)).toEqual(before);
  });

  test("partial --target-task without --target-step for fix-impl → USAGE", async () => {
    const { dir, feature } = await seedLightAtExecuteWorkWithTask();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "impl-defect",
      "--action",
      "fix-impl",
      "--target-task",
      "T-001",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/USAGE/);
  });

  test("none-mode action (amend-spec) with target → FINDING_TARGET_REQUIRED (target_not_allowed; codex r69 BLOCK 1)", async () => {
    const { dir, feature } = await seedLightAtExecuteWorkWithTask();
    const before = await readJournalLines(dir);
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "spec-gap",
      "--action",
      "amend-spec",
      "--target-task",
      "T-001",
      "--target-step",
      "implement",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/FINDING_TARGET_REQUIRED/);
    expect(r.stderr).toMatch(/target_not_allowed|target_payload/);
    expect(await readJournalLines(dir)).toEqual(before);
  });

  test("none-mode action (defer) with target → FINDING_TARGET_REQUIRED", async () => {
    const { dir, feature } = await seedLightAtExecuteWorkWithTask();
    const r = await runCli([
      "finding",
      "raise",
      "--category",
      "spec-gap",
      "--action",
      "defer",
      "--target-task",
      "T-001",
      "--target-step",
      "implement",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/FINDING_TARGET_REQUIRED/);
  });
});

describe("loaf finding list", () => {
  test("list text mode shows raised findings; --status filters open/closed", async () => {
    const { dir, feature } = await seedQuickAtExecutePlan();
    await runCli([
      "finding",
      "raise",
      "--category",
      "spec-gap",
      "--action",
      "defer",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    await runCli([
      "finding",
      "raise",
      "--category",
      "impl-defect",
      "--action",
      "backlog",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    const all = await runCli(["finding", "list", "--feature", feature, "--feature-dir", dir]);
    expect(all.exit).toBe(0);
    const lines = all.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    // Expect 4 columns: <FND-id> <category> <action> <status>
    expect(lines[0]!.split(/\s+/)).toEqual(["FND-001", "spec-gap", "defer", "open"]);

    await runCli(["finding", "close", "FND-001", "--feature", feature, "--feature-dir", dir]);
    const open = await runCli([
      "finding",
      "list",
      "--status",
      "open",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(
      open.stdout
        .trim()
        .split("\n")
        .map((l) => l.split(/\s+/)[0]),
    ).toEqual(["FND-002"]);
    const closed = await runCli([
      "finding",
      "list",
      "--status",
      "closed",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(
      closed.stdout
        .trim()
        .split("\n")
        .map((l) => l.split(/\s+/)[0]),
    ).toEqual(["FND-001"]);
  });

  test("list --json surfaces summary/reason/target from raise (projection contract)", async () => {
    const { dir, feature } = await seedLightAtExecuteWorkWithTask();
    await runCli([
      "finding",
      "raise",
      "--category",
      "impl-defect",
      "--action",
      "fix-impl",
      "--target-task",
      "T-001",
      "--target-step",
      "implement",
      "--summary",
      "auth flow regression",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    const r = await runCli([
      "finding",
      "list",
      "--format",
      "json",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toMatchObject({ ok: true, feature, count: 1 });
    expect(parsed.findings[0]).toMatchObject({
      id: "FND-001",
      category: "impl-defect",
      action: "fix-impl",
      status: "open",
      summary: "auth flow regression",
      target: { task_id: "T-001", step: "implement" },
    });
  });
});

describe("loaf finding close", () => {
  test("close FND-001 marks status closed", async () => {
    const { dir, feature } = await seedQuickAtExecutePlan();
    await runCli([
      "finding",
      "raise",
      "--category",
      "spec-gap",
      "--action",
      "defer",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    const r = await runCli([
      "finding",
      "close",
      "FND-001",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(0);

    const s = await loadSnapshot(dir);
    expect(s.snapshot.findings[0].status).toBe("closed");
  });

  test("close unknown id → FINDING_NOT_FOUND", async () => {
    const { dir, feature } = await seedQuickAtExecutePlan();
    const r = await runCli([
      "finding",
      "close",
      "FND-999",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/FINDING_NOT_FOUND/);
  });

  test("close already-closed finding → FINDING_NOT_FOUND (detail.reason=already_closed)", async () => {
    const { dir, feature } = await seedQuickAtExecutePlan();
    await runCli([
      "finding",
      "raise",
      "--category",
      "spec-gap",
      "--action",
      "defer",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    await runCli(["finding", "close", "FND-001", "--feature", feature, "--feature-dir", dir]);
    const r = await runCli([
      "finding",
      "close",
      "FND-001",
      "--feature",
      feature,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(r.exit).not.toBe(0);
    const err = r.stderr;
    expect(err).toMatch(/FINDING_NOT_FOUND/);
    expect(err).toMatch(/already_closed/);
  });

  test("close FND-1 (non-canonical) → INVALID_PAYLOAD (FindingId regex tightened)", async () => {
    const { dir, feature } = await seedQuickAtExecutePlan();
    const r = await runCli([
      "finding",
      "close",
      "FND-1",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INVALID_PAYLOAD/);
  });
});
