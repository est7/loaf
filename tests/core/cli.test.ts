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

const STANDARD_CEREMONY = {
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
 */
async function seedFeatureAtSpecDesign(dir: string): Promise<void> {
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
        ceremony: STANDARD_CEREMONY,
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

  // Plan tasks at SPEC.design (sub-cycle 3c per-kind expansion).
  const planResult = await mutateRaw(
    {
      at: new Date(2026, 4, 15, 10, 0, tailSeq + 1).toISOString(),
      actor: "human:seed@test.invalid",
      entry_schema_version: 1,
      kind: "event:tasks_planned",
      payload: {
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
      },
    },
    { feature_dir: dir, snapshot, tail_seq: tailSeq, fsync: false },
  );
  if (!planResult.ok) throw new Error(`seed plan failed: ${planResult.message}`);
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
