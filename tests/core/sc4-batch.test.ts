// Slice 3 SC4 — gate decide pending:resolved co-emission (soft) +
// tasks step done --evidence-* batch path + GATE_NOT_PENDING preflight.
//
// RED first: every new-behavior assertion below fails on pre-SC4 main
// (gate decide currently does not co-emit pending:resolved even with a
// matching head; tasks step done has no --evidence-* flag; no
// GATE_NOT_PENDING preflight).
//
// Scope per codex r71 proposal (sign-off pending at time of writing —
// adjust if r71 chooses strict over soft binding):
//   - Soft gate↔pending binding: gate decide does NOT require a pending
//     head; if one exists and kind=gate_decision, co-emit pending:resolved
//     in the same batch. Otherwise unchanged.
//   - GATE_NOT_PENDING fires when a pending head exists AND
//     kind != gate_decision (head is ask_user_question / spec_clarification
//     / finding_decision / profile_escalation blocker). Suggests resolve
//     non-gate head first.
//   - tasks step done --evidence-kind / --result / --summary / --covers
//     batch path: when any --evidence-* flag present, mutateBatch emits
//     [event:task_step_done, evidence:added] with a single CLI-allocated
//     EV-NNNNNN; task_id auto-filled from --task.
//   - Deferred: profile escalate CLI + ESCALATION_NOT_PENDING; strict
//     gate_name binding (needs PendingAddedPayload schema upgrade);
//     finding amend-* back-edge batches.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import { mutate } from "../../src/core/journal-mutate.js";
import type { SubState } from "../../src/core/journal-entry.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc4-test-"));
}

async function runCli(
  argv: string[],
  opts: { env?: Record<string, string | undefined> } = {},
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  const envBackup: Record<string, string | undefined> = {};
  if (opts.env) {
    for (const k of Object.keys(opts.env)) {
      envBackup[k] = process.env[k];
      const v = opts.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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
    for (const k of Object.keys(envBackup)) {
      const prev = envBackup[k];
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

// Standard env wrapper for gate decide tests — provides the human actor
// (gate:decided is HUMAN_ONLY per PER_KIND_ACTOR) without polluting the
// global process.env outside the test.
const HUMAN_ENV = { LOAF_USER: "sc4-test@invalid.example" };

async function loadSnapshot(dir: string): Promise<{ snapshot: any; tail_seq: number }> {
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
 * Walks a standard-ceremony session through TRIAGE → SPEC.design via raw
 * mutate, emitting a parser-valid spec_submitted + behavioral task graph
 * along the way. Returns the feature dir + name + at SPEC.design (where
 * spec-lock gate is legal). Used for gate-decide-related SC4 tests.
 */
async function seedAtSpecDesignWithTask(): Promise<{ dir: string; feature: string }> {
  const dir = await tmpFeatureDir();
  const feature = "F1";
  // Write a parser-valid spec.md so evaluateSpecLock (gate-decide Pass 1.5)
  // can read it. REQ-AUTH-001 uses acceptance_na=true to pass spec-lock
  // check 2 (verifiability) without needing scenarios. Mirrors the
  // seedFeatureAtSpecDesign helper in cli.test.ts.
  await fs.writeFile(
    path.join(dir, "spec.md"),
    `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: SC4 batch fixture
intent: exercise SC4 batch retrofits
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
SC4 fixture body.
`,
  );
  const startRes = await runCli([
    "start", feature, "--ceremony", "standard",
    "--feature-dir", dir, "--json",
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
      { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, fsync: false },
    );
    if (!r.ok) throw new Error(`walk ${from}→${to} failed: ${r.code} ${r.message}`);
  }
  // spec_submitted + REQ-AUTH-001 in one batch (mirrors loaf spec submit
  // semantics: header + companion adds share batch_id + spec_version).
  const { mutateBatch } = await import("../../src/core/journal-mutate.js");
  let s = await loadSnapshot(dir);
  const submitted = await mutateBatch(
    [
      {
        at: new Date().toISOString(),
        actor: "human:seed@test.invalid",
        entry_schema_version: 1,
        kind: "event:spec_submitted",
        payload: {
          spec_version: 1,
          feature: { id: "F-001", name: "SC4 batch fixture" },
          intent: "exercise SC4 batch retrofits",
          adr_refs: [],
          needs_clarification: [],
        },
      },
      {
        at: new Date().toISOString(),
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
    { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, fsync: false },
  );
  if (!submitted.ok) throw new Error(`spec_submitted batch failed: ${submitted.message}`);
  // tasks_planned with one behavioral task driving REQ-AUTH-001.
  s = await loadSnapshot(dir);
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
              red: { applicability: "must", status: "pending", evidence_refs: [] },
              implement: { applicability: "must", status: "pending", evidence_refs: [] },
              refactor: { applicability: "optional", status: "pending", evidence_refs: [] },
            },
          },
        ],
      },
    },
    { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, fsync: false },
  );
  if (!planned.ok) throw new Error(`tasks_planned failed: ${planned.message}`);
  return { dir, feature };
}

/**
 * Continue from SPEC.design through spec-lock + advance to EXECUTE.work
 * with T-001 claimed + step "red" started — ready for tasks step done
 * tests. Uses raw mutate to bypass gate-decide's SC4 pending coupling
 * (we want a deterministic seed for the step-done tests, not exercise
 * gate decide itself here).
 */
async function seedAtExecuteWorkRedRunning(): Promise<{ dir: string; feature: string }> {
  const { dir, feature } = await seedAtSpecDesignWithTask();
  // spec-lock approve via raw mutateBatch — emits gate:decided +
  // event:phase_advanced SPEC.design → EXECUTE.plan.
  const { mutateBatch } = await import("../../src/core/journal-mutate.js");
  let s = await loadSnapshot(dir);
  const lock = await mutateBatch(
    [
      {
        at: new Date().toISOString(),
        actor: "human:seed@test.invalid",
        entry_schema_version: 1,
        kind: "gate:decided",
        payload: { gate_kind: "spec-lock", decision: "approved", reason: "sc4 seed approve" },
      },
      {
        at: new Date().toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from: "SPEC.design", to: "EXECUTE.plan" },
      },
    ],
    { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, fsync: false },
  );
  if (!lock.ok) throw new Error(`spec-lock failed: ${lock.code} ${lock.message}`);
  // advance EXECUTE.plan → EXECUTE.work
  s = await loadSnapshot(dir);
  const adv = await mutate(
    {
      at: new Date().toISOString(),
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "event:phase_advanced",
      payload: { from: "EXECUTE.plan", to: "EXECUTE.work" },
    },
    { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, fsync: false },
  );
  if (!adv.ok) throw new Error(`advance EXECUTE.work failed: ${adv.message}`);
  // claim T-001
  s = await loadSnapshot(dir);
  const claim = await mutate(
    {
      at: new Date().toISOString(),
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "event:task_claimed",
      payload: { task_id: "T-001" },
    },
    { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, fsync: false },
  );
  if (!claim.ok) throw new Error(`task_claimed failed: ${claim.message}`);
  // step start red
  s = await loadSnapshot(dir);
  const stepStart = await mutate(
    {
      at: new Date().toISOString(),
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "event:task_step_started",
      payload: { task_id: "T-001", step: "red" },
    },
    { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, fsync: false },
  );
  if (!stepStart.ok) throw new Error(`step_started failed: ${stepStart.message}`);
  return { dir, feature };
}

// Helper for raw pending raise — used by gate-decide co-emission tests
// without going through CLI (deterministic seed).
async function rawRaisePending(
  dir: string,
  id: string,
  kind: string,
  question = "seeded pending question",
): Promise<void> {
  const s = await loadSnapshot(dir);
  const r = await mutate(
    {
      at: new Date().toISOString(),
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "pending:added",
      payload: { id, kind, question },
    },
    { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, fsync: false },
  );
  if (!r.ok) throw new Error(`raise pending failed: ${r.code} ${r.message}`);
}

// ─────────────────────────────────────────────────────────────────────────
// tasks step done --evidence-* batch path
// ─────────────────────────────────────────────────────────────────────────

describe("loaf tasks step done — SC4 --evidence-* batch", () => {
  test("no --evidence-* flag → single event:task_step_done (additive: existing behavior)", async () => {
    const { dir, feature } = await seedAtExecuteWorkRedRunning();
    const before = await readJournalLines(dir);
    const r = await runCli([
      "tasks", "step", "done",
      "--task", "T-001", "--step", "red", "--result", "passed",
      "--feature", feature, "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(0);
    const after = await readJournalLines(dir);
    // Single entry appended (no evidence:added).
    expect(after.length - before.length).toBe(1);
    const s = await loadSnapshot(dir);
    expect(s.snapshot.evidence).toHaveLength(0);
  });

  test("--evidence-kind local-check + --evidence-summary → batch [task_step_done, evidence:added]", async () => {
    const { dir, feature } = await seedAtExecuteWorkRedRunning();
    const before = await readJournalLines(dir);
    const r = await runCli([
      "tasks", "step", "done",
      "--task", "T-001", "--step", "red", "--result", "passed",
      "--evidence-kind", "local-check",
      "--evidence-summary", "red test failed as expected for T-001",
      "--feature", feature, "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(0);
    const after = await readJournalLines(dir);
    // Two entries appended in a batch.
    expect(after.length - before.length).toBe(2);
    const s = await loadSnapshot(dir);
    expect(s.snapshot.evidence).toHaveLength(1);
    expect(s.snapshot.evidence[0]).toMatchObject({
      id: "EV-000001",
      kind: "local-check",
      result: "passed",
    });
    // actor is the CLI's user-stamped form `cli:loaf@<USER>` (cli.tsx
    // module-level actor), not the bare `cli:loaf`.
    expect(s.snapshot.evidence[0].actor).toMatch(/^cli:loaf/);
    // Both entries share batch_id (mutateBatch atomicity invariant).
    const lastTwo = after.slice(-2).map((l) => JSON.parse(l));
    expect(lastTwo[0]!.batch_id).toBeDefined();
    expect(lastTwo[0]!.batch_id).toBe(lastTwo[1]!.batch_id);
  });

  test("JSON output includes evidence_id when batch path fired", async () => {
    const { dir, feature } = await seedAtExecuteWorkRedRunning();
    const r = await runCli([
      "tasks", "step", "done",
      "--task", "T-001", "--step", "red",
      "--evidence-kind", "local-check",
      "--evidence-summary", "T-001 red step pass",
      "--feature", feature, "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.evidence_id).toBe("EV-000001");
  });

  test("--evidence-kind without --evidence-summary → USAGE before mutate", async () => {
    const { dir, feature } = await seedAtExecuteWorkRedRunning();
    const before = await readJournalLines(dir);
    const r = await runCli([
      "tasks", "step", "done",
      "--task", "T-001", "--step", "red",
      "--evidence-kind", "local-check",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/USAGE/);
    expect(await readJournalLines(dir)).toEqual(before);
  });

  test("--evidence-kind invalid → INVALID_PAYLOAD (closed EvidenceKind enum), no journal change", async () => {
    const { dir, feature } = await seedAtExecuteWorkRedRunning();
    const before = await readJournalLines(dir);
    const r = await runCli([
      "tasks", "step", "done",
      "--task", "T-001", "--step", "red",
      "--evidence-kind", "not-a-kind",
      "--evidence-summary", "this should reject the whole batch",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INVALID_PAYLOAD/);
    // Batch atomicity: neither entry landed.
    expect(await readJournalLines(dir)).toEqual(before);
  });

  test("--evidence-kind=manual without human:* actor → INVALID_PAYLOAD (schema refine)", async () => {
    const { dir, feature } = await seedAtExecuteWorkRedRunning();
    const r = await runCli([
      "tasks", "step", "done",
      "--task", "T-001", "--step", "red",
      "--evidence-kind", "manual",
      "--evidence-summary", "manual check passes",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INVALID_PAYLOAD/);
  });

  test("--evidence-actor human:* overrides payload.actor only; journal envelope actor stays CLI (codex r72)", async () => {
    const { dir, feature } = await seedAtExecuteWorkRedRunning();
    const r = await runCli([
      "tasks", "step", "done",
      "--task", "T-001", "--step", "red", "--result", "passed",
      "--evidence-kind", "manual",
      "--evidence-actor", "human:reviewer@invalid.example",
      "--evidence-reason", "manual review passed per QA checklist",
      "--evidence-summary", "T-001 red verified manually",
      "--feature", feature, "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(0);
    // Payload actor (snapshot projection) is the human override.
    const snap = await loadSnapshot(dir);
    expect(snap.snapshot.evidence[0].actor).toBe("human:reviewer@invalid.example");
    // Journal envelope actor for the evidence:added entry stays
    // CLI-injected (`cli:loaf@<USER>`), preserving command provenance.
    const lines = await readJournalLines(dir);
    const lastEntry = JSON.parse(lines[lines.length - 1]!);
    expect(lastEntry.kind).toBe("evidence:added");
    expect(lastEntry.actor).toMatch(/^cli:loaf/);
    // And the step_done envelope actor in the same batch also stays cli.
    const stepEntry = JSON.parse(lines[lines.length - 2]!);
    expect(stepEntry.kind).toBe("event:task_step_done");
    expect(stepEntry.actor).toMatch(/^cli:loaf/);
    expect(stepEntry.batch_id).toBe(lastEntry.batch_id);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// gate decide soft pending:resolved co-emission + GATE_NOT_PENDING
// ─────────────────────────────────────────────────────────────────────────

describe("loaf gate decide — SC4 soft pending:resolved co-emission", () => {
  test("spec-lock --approve without pending head → 2-entry batch (unchanged behavior)", async () => {
    const { dir, feature } = await seedAtSpecDesignWithTask();
    const before = await readJournalLines(dir);
    const r = await runCli(
      [
        "gate", "decide", "spec-lock",
        "--approve", "--reason", "sc4-approve: no pending head",
        "--feature", feature, "--feature-dir", dir, "--json",
      ],
      { env: HUMAN_ENV },
    );
    expect(r.exit).toBe(0);
    const after = await readJournalLines(dir);
    expect(after.length - before.length).toBe(2); // gate:decided + phase_advanced
    const s = await loadSnapshot(dir);
    expect(s.snapshot.state?.spec_locked).toBe(true);
  });

  test("spec-lock --approve with gate_decision pending head → 3-entry batch + head resolved", async () => {
    const { dir, feature } = await seedAtSpecDesignWithTask();
    await rawRaisePending(dir, "PEND-0001", "gate_decision", "approve spec-lock?");
    const before = await readJournalLines(dir);
    const r = await runCli([
      "gate", "decide", "spec-lock",
      "--approve", "--reason", "sc4-approve: with pending head co-emit",
      "--feature", feature, "--feature-dir", dir, "--json",
    ], { env: HUMAN_ENV });
    expect(r.exit).toBe(0);
    const after = await readJournalLines(dir);
    expect(after.length - before.length).toBe(3); // gate:decided + pending:resolved + phase_advanced
    const s = await loadSnapshot(dir);
    expect(s.snapshot.state?.spec_locked).toBe(true);
    expect(s.snapshot.pending[0]).toMatchObject({ id: "PEND-0001", resolved: true });
  });

  test("verify-accept --approve with gate_decision pending head → 2-entry batch + head resolved", async () => {
    // Walk to VERIFY.accept by stuffing the snapshot via raw mutate
    // (re-using the spec-lock path then advancing through EXECUTE.* + VERIFY.*).
    const { dir, feature } = await seedAtSpecDesignWithTask();
    const { mutateBatch } = await import("../../src/core/journal-mutate.js");
    let s = await loadSnapshot(dir);
    const lock = await mutateBatch(
      [
        {
          at: new Date().toISOString(),
          actor: "human:seed@test.invalid",
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "spec-lock", decision: "approved", reason: "seed" },
        },
        {
          at: new Date().toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: "SPEC.design", to: "EXECUTE.plan" },
        },
      ],
      { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, fsync: false },
    );
    if (!lock.ok) throw new Error(`seed lock fail: ${lock.message}`);
    const walk: Array<[SubState, SubState]> = [
      ["EXECUTE.plan", "EXECUTE.work"],
      ["EXECUTE.work", "EXECUTE.done"],
      ["EXECUTE.done", "VERIFY.plan"],
      ["VERIFY.plan", "VERIFY.run"],
      ["VERIFY.run", "VERIFY.accept"],
    ];
    for (const [from, to] of walk) {
      s = await loadSnapshot(dir);
      const r = await mutate(
        {
          at: new Date().toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from, to },
        },
        { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, fsync: false },
      );
      if (!r.ok) throw new Error(`walk ${from}→${to}: ${r.message}`);
      if (to === "EXECUTE.work") {
        // F-016: abandon the seed task T-001 before crossing EXECUTE.done
        // (all-tasks-final preflight guard). This fixture exercises the
        // gate-pending co-emission, not task execution — an abandoned task
        // keeps verify-accept vacuously passing.
        s = await loadSnapshot(dir);
        const ab = await mutate(
          {
            at: new Date().toISOString(),
            actor: "cli:loaf",
            entry_schema_version: 1,
            kind: "event:task_abandoned",
            payload: { task_id: "T-001", reason: "seed fixture: gate-pending test, no task execution" },
          },
          { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, fsync: false },
        );
        if (!ab.ok) throw new Error(`seed task abandon: ${ab.message}`);
      }
    }
    await rawRaisePending(dir, "PEND-0001", "gate_decision", "approve verify-accept?");
    const before = await readJournalLines(dir);
    const r = await runCli([
      "gate", "decide", "verify-accept",
      "--approve", "--reason", "sc4 verify-accept with pending",
      "--feature", feature, "--feature-dir", dir, "--json",
    ], { env: HUMAN_ENV });
    expect(r.exit).toBe(0);
    const after = await readJournalLines(dir);
    expect(after.length - before.length).toBe(2); // gate:decided + pending:resolved
    const sFinal = await loadSnapshot(dir);
    expect(sFinal.snapshot.state?.verify_accepted).toBe(true);
    expect(sFinal.snapshot.pending[0]).toMatchObject({ id: "PEND-0001", resolved: true });
  });

  test("--reject with pending head → no co-emission, head stays unresolved", async () => {
    const { dir, feature } = await seedAtSpecDesignWithTask();
    await rawRaisePending(dir, "PEND-0001", "gate_decision", "approve spec-lock?");
    const before = await readJournalLines(dir);
    const r = await runCli([
      "gate", "decide", "spec-lock",
      "--reject", "--reason", "spec needs more work",
      "--feature", feature, "--feature-dir", dir, "--json",
    ], { env: HUMAN_ENV });
    expect(r.exit).toBe(0);
    const after = await readJournalLines(dir);
    expect(after.length - before.length).toBe(1); // gate:decided only
    const s = await loadSnapshot(dir);
    expect(s.snapshot.pending[0]).toMatchObject({ id: "PEND-0001", resolved: false });
  });

  test("non-gate_decision pending head (ask_user_question) → GATE_NOT_PENDING exit 2", async () => {
    const { dir, feature } = await seedAtSpecDesignWithTask();
    await rawRaisePending(dir, "PEND-0001", "ask_user_question", "Should we use approach X?");
    const before = await readJournalLines(dir);
    const r = await runCli([
      "gate", "decide", "spec-lock",
      "--approve", "--reason", "sc4: non-matching head must block",
      "--feature", feature, "--feature-dir", dir, "--json",
    ], { env: HUMAN_ENV });
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/GATE_NOT_PENDING/);
    // Journal unchanged — preflight rejects before any append.
    expect(await readJournalLines(dir)).toEqual(before);
  });

  test("already-resolved gate_decision head → treated as no head (2-entry batch)", async () => {
    const { dir, feature } = await seedAtSpecDesignWithTask();
    // Raise + resolve via reducer to set resolved=true.
    await rawRaisePending(dir, "PEND-0001", "gate_decision", "first prompt");
    const s1 = await loadSnapshot(dir);
    const resolved = await mutate(
      {
        at: new Date().toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "pending:resolved",
        payload: { id: "PEND-0001", answer: "approved-via-test" },
      },
      { feature_dir: dir, snapshot: s1.snapshot, tail_seq: s1.tail_seq, fsync: false },
    );
    if (!resolved.ok) throw new Error(`seed resolve fail: ${resolved.message}`);
    const before = await readJournalLines(dir);
    const r = await runCli([
      "gate", "decide", "spec-lock",
      "--approve", "--reason", "approve after stale head",
      "--feature", feature, "--feature-dir", dir, "--json",
    ], { env: HUMAN_ENV });
    expect(r.exit).toBe(0);
    expect((await readJournalLines(dir)).length - before.length).toBe(2);
  });
});
