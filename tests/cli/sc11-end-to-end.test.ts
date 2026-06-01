// Phase 16 SC-11 — `loaf waive` + `loaf lessons add` CLI end-to-end.
//
// Covers (codex r322 + r324 + r326 lock):
//   - waive happy: emits evidence:added EV-NNN with kind=waiver
//   - waive invalid obligation regex → USAGE
//   - waive --reason <10 → USAGE
//   - waive NO_HUMAN_ACTOR via --no-input + no LOAF_USER
//   - lessons add --text happy
//   - lessons add --file happy <8KB
//   - lessons add --file happy >8KB → summary.mode==="sidecar" post-mutate
//   - lessons add --file >8KB + --dry-run → no journal write + no attachment
//   - lessons add --text + --file mutex → USAGE
//   - lessons add (neither) → USAGE
//   - lessons add --file ENOENT → INPUT_FILE_NOT_FOUND
//   - lessons add --reason <10 → USAGE
//   - cross-wrapper monotonic allocation: evidence add → waive → lessons add
//     emits sequential EV-ids

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main, type MainDeps } from "../../src/cli.js";

async function tmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc11-e2e-"));
}

async function runCli(
  argv: string[],
  opts: { env?: Record<string, string | undefined>; deps?: MainDeps; cwd?: string } = {},
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const origCwd = process.cwd();
  const envBackup: Record<string, string | undefined> = {};
  if (opts.env) {
    for (const k of Object.keys(opts.env)) {
      envBackup[k] = process.env[k];
      const v = opts.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  if (opts.cwd) process.chdir(opts.cwd);
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    stderrChunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await main(["node", "loaf", ...argv], opts.deps ?? {});
    return { exit, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
    if (opts.cwd) process.chdir(origCwd);
    for (const k of Object.keys(envBackup)) {
      const prev = envBackup[k];
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

const SEED_ENV = { LOAF_USER: "Dev <dev@example.com>" };

/** Seed a feature at EXECUTE.work via the CLI chain. Pattern mirrors
 *  `seedFeatureAtExecuteWork` in tests/core/cli.test.ts. */
async function seedAtExecuteWork(): Promise<{ featureDir: string }> {
  const tmp = await tmpDir();
  const featureDir = path.join(tmp, ".loaf", "auth-refresh");
  await fs.mkdir(featureDir, { recursive: true });

  // start
  const start = await runCli(
    ["start", "auth-refresh", "--ceremony", "standard",
     "--feature-dir", featureDir, "--format", "json"],
    { env: SEED_ENV },
  );
  if (start.exit !== 0) throw new Error(`seed start failed: ${start.stderr}`);

  // Write spec.md with one verifiable REQ + e2e SCEN + one task
  await fs.writeFile(
    path.join(featureDir, "spec.md"),
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
    response: the system shall do something measurably here
    acceptance_na: true
    acceptance_na_reason: covered by manual UX testing scope outside automation
scenarios: []
needs_clarification: []
---

## Why
prose
`,
  );

  // Walk: TRIAGE.score → TRIAGE.confirm → SPEC.proposal → spec submit
  // → advance SPEC.spec → spec add-req → advance SPEC.plan → advance
  // SPEC.design → tasks submit → gate decide spec-lock (auto-advances
  // to EXECUTE.plan) → advance EXECUTE.work (per LEGAL_TRANSITIONS in
  // src/core/reducer/transition.ts:61-82).
  const walkA: string[] = ["TRIAGE.confirm", "SPEC.proposal"];
  for (const sub of walkA) {
    const adv = await runCli(
      ["advance", sub, "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    if (adv.exit !== 0) throw new Error(`seed advance ${sub} failed: ${adv.stderr}`);
  }
  // spec submit (whole-replacement at SPEC.proposal)
  const submit = await runCli(
    ["spec", "submit", "--input",
     JSON.stringify({
       spec_version: 1,
       feature: { id: "F-001", name: "OAuth token refresh" },
       intent: "users should not perceive auth recovery flows in flight",
       adr_refs: [],
       needs_clarification: [],
     }),
     "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
    { env: SEED_ENV },
  );
  if (submit.exit !== 0) throw new Error(`seed spec submit failed: ${submit.stderr}`);
  // advance SPEC.proposal → SPEC.spec
  const advSpec = await runCli(
    ["advance", "SPEC.spec", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
    { env: SEED_ENV },
  );
  if (advSpec.exit !== 0) throw new Error(`seed advance SPEC.spec failed: ${advSpec.stderr}`);
  // add REQ at SPEC.spec
  const addReq = await runCli(
    ["spec", "add-req", "--input",
     JSON.stringify({
       id_namespace: "REQ-AUTH",
       type: "ubiquitous",
       response: "the system shall do something measurably here",
       acceptance_na: true,
       acceptance_na_reason: "covered by manual UX testing scope outside automation",
     }),
     "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
    { env: SEED_ENV },
  );
  if (addReq.exit !== 0) throw new Error(`seed add-req failed: ${addReq.stderr}`);
  // advance SPEC.spec → SPEC.plan → SPEC.design
  for (const sub of ["SPEC.plan", "SPEC.design"]) {
    const adv = await runCli(
      ["advance", sub, "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    if (adv.exit !== 0) throw new Error(`seed advance ${sub} failed: ${adv.stderr}`);
  }
  // tasks submit (whole-graph single object). Shape mirrors the
  // settle-seed pattern in tests/core/cli.test.ts:1287-1306 — id +
  // tests + execution all required.
  const submitTasks = await runCli(
    ["tasks", "submit", "--input",
     JSON.stringify({
       // spec_version is now 2 (spec submit=1 + spec add-req bumps to 2)
       based_on: { spec: 2 },
       tasks: [{
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
       }],
     }),
     "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
    { env: SEED_ENV },
  );
  if (submitTasks.exit !== 0) throw new Error(`seed tasks submit failed: ${submitTasks.stderr}`);
  // spec-lock approve at SPEC.design → auto-advances to EXECUTE.plan
  const lock = await runCli(
    ["gate", "decide", "spec-lock", "--approve", "--reason", "seed: spec ready for execution",
     "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
    { env: SEED_ENV },
  );
  if (lock.exit !== 0) throw new Error(`seed spec-lock failed: ${lock.stderr}`);
  // advance EXECUTE.plan → EXECUTE.work
  const advWork = await runCli(
    ["advance", "EXECUTE.work", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
    { env: SEED_ENV },
  );
  if (advWork.exit !== 0) throw new Error(`seed EXECUTE.work failed: ${advWork.stderr}`);

  return { featureDir };
}

async function readJournalEntries(featureDir: string): Promise<unknown[]> {
  const raw = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
  return raw.trim().split("\n").map((line) => JSON.parse(line));
}

// ───────────────────────────────────────────────────────────────────────
// waive — happy + error paths
// ───────────────────────────────────────────────────────────────────────
describe("SC-11 — loaf waive", () => {
  test("happy: emits evidence:added kind=waiver with EV-NNN allocated", async () => {
    const { featureDir } = await seedAtExecuteWork();
    const result = await runCli(
      ["waive", "REQ-AUTH-001", "--reason", "covered by manual UX testing scope",
       "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("waiver");
    expect(out.id).toMatch(/^EV-\d{6,}$/);
    expect(out.obligation_id).toBe("REQ-AUTH-001");

    // Verify journal carries Plan A: covers + waiver_obligation_id
    const entries = await readJournalEntries(featureDir);
    const waiverEntry = entries.find(
      (e: any) => e.kind === "evidence:added" && e.payload?.kind === "waiver",
    ) as any;
    expect(waiverEntry).toBeDefined();
    expect(waiverEntry.payload.covers).toEqual(["REQ-AUTH-001"]);
    expect(waiverEntry.payload.waiver_obligation_id).toBe("REQ-AUTH-001");
    expect(waiverEntry.payload.result).toBe("waived");
  });

  test("invalid obligation regex → USAGE", async () => {
    const { featureDir } = await seedAtExecuteWork();
    const result = await runCli(
      ["waive", "not-a-real-id", "--reason", "long enough reason here",
       "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.message).toContain("invalid obligation id");
  });

  test("--reason <10 chars → USAGE", async () => {
    const { featureDir } = await seedAtExecuteWork();
    const result = await runCli(
      ["waive", "REQ-AUTH-001", "--reason", "too short",
       "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.message).toContain("≥10");
  });

  test("NO_HUMAN_ACTOR via --no-input + no LOAF_USER", async () => {
    const { featureDir } = await seedAtExecuteWork();
    const result = await runCli(
      ["waive", "REQ-AUTH-001", "--no-input", "--reason", "long enough reason here",
       "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: { LOAF_USER: undefined } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("NO_HUMAN_ACTOR");
  });
});

// ───────────────────────────────────────────────────────────────────────
// lessons add — happy paths
// ───────────────────────────────────────────────────────────────────────
describe("SC-11 — loaf lessons add (happy)", () => {
  test("--text inline → exit 0, journal entry kind=manual", async () => {
    const { featureDir } = await seedAtExecuteWork();
    const result = await runCli(
      ["lessons", "add",
       "--text", "single-flight refresh requires global lock",
       "--reason", "diagnosed during retry storm post-mortem",
       "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.kind).toBe("manual");
    expect(out.id).toMatch(/^EV-\d{6,}$/);

    const entries = await readJournalEntries(featureDir);
    const lesson = entries.find(
      (e: any) => e.kind === "evidence:added" && e.payload?.kind === "manual",
    ) as any;
    expect(lesson).toBeDefined();
    expect(typeof lesson.payload.summary).toBe("string");
  });

  // ── F-024 (v0.1.1): lessons.md projection writer ──
  test("F-024: writes .loaf/<feature>/lessons.md with the lesson; advisory says updated, not deferred", async () => {
    const { featureDir } = await seedAtExecuteWork();
    const result = await runCli(
      ["lessons", "add",
       "--text", "single-flight refresh requires global lock",
       "--reason", "diagnosed during retry storm post-mortem",
       "--feature", "auth-refresh", "--feature-dir", featureDir],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(0);
    const md = await fs.readFile(path.join(featureDir, "lessons.md"), "utf8");
    expect(md).toMatch(/^## /);
    expect(md).toContain("- single-flight refresh requires global lock");
    // advisory wording flipped (F-024): no longer "deferred"
    const advisory = result.stdout + result.stderr;
    expect(advisory).toContain("lessons.md updated");
    expect(advisory).not.toContain("projection writer deferred");
  });

  test("F-024: >8KB sidecar lesson → lessons.md inlines the resolved sidecar body", async () => {
    const { featureDir } = await seedAtExecuteWork();
    const tmp = await tmpDir();
    const filePath = path.join(tmp, "big-lesson.md");
    const body = "SENTINEL_BODY " + "y".repeat(9 * 1024);
    await fs.writeFile(filePath, body);
    const result = await runCli(
      ["lessons", "add", "--file", filePath,
       "--reason", "deep retro of refresh storm",
       "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(0);
    const md = await fs.readFile(path.join(featureDir, "lessons.md"), "utf8");
    expect(md).toContain("SENTINEL_BODY"); // sidecar body resolved + inlined
  });

  test("F-024: no lesson entries → lessons.md is absent (not written empty)", async () => {
    const { featureDir } = await seedAtExecuteWork();
    // seed has task-step evidence but no kind=manual lesson → file must not exist
    await expect(fs.access(path.join(featureDir, "lessons.md"))).rejects.toThrow();
  });

  test("--file <8KB → reads file, journal stores plain string summary", async () => {
    const { featureDir } = await seedAtExecuteWork();
    const tmp = await tmpDir();
    const filePath = path.join(tmp, "lesson.md");
    await fs.writeFile(filePath, "## Insight\nsome short lesson body content here");
    const result = await runCli(
      ["lessons", "add",
       "--file", filePath,
       "--reason", "captured from triage review",
       "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(0);
    const entries = await readJournalEntries(featureDir);
    const lesson = entries.find(
      (e: any) => e.kind === "evidence:added" && e.payload?.kind === "manual",
    ) as any;
    expect(typeof lesson.payload.summary).toBe("string");
    expect((lesson.payload.summary as string)).toContain("Insight");
  });

  test("--file >8KB → summary.mode=sidecar (Pass 2 promoted)", async () => {
    const { featureDir } = await seedAtExecuteWork();
    const tmp = await tmpDir();
    const filePath = path.join(tmp, "big-lesson.md");
    await fs.writeFile(filePath, "x".repeat(9 * 1024)); // 9KB > 8KB threshold
    const result = await runCli(
      ["lessons", "add",
       "--file", filePath,
       "--reason", "deep retro of refresh storm",
       "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(0);
    const entries = await readJournalEntries(featureDir);
    const lesson = entries.find(
      (e: any) => e.kind === "evidence:added" && e.payload?.kind === "manual",
    ) as any;
    expect(typeof lesson.payload.summary).toBe("object");
    expect(lesson.payload.summary.mode).toBe("sidecar");
    // Verify attachment file actually written
    const attachmentDir = path.join(featureDir, "attachments");
    const dirs = await fs.readdir(attachmentDir);
    expect(dirs.length).toBeGreaterThan(0);
  });

  test(">8KB + --dry-run → no journal append + no attachment dir", async () => {
    const { featureDir } = await seedAtExecuteWork();
    const tmp = await tmpDir();
    const filePath = path.join(tmp, "big-lesson.md");
    await fs.writeFile(filePath, "x".repeat(9 * 1024));

    const journalBefore = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
    const result = await runCli(
      ["lessons", "add",
       "--file", filePath,
       "--reason", "deep retro of refresh storm",
       "--dry-run",
       "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.dry_run).toBe(true);

    // Journal byte count unchanged
    const journalAfter = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
    expect(journalAfter.length).toBe(journalBefore.length);

    // No attachments dir created (or empty)
    const attachDir = path.join(featureDir, "attachments");
    try {
      const dirs = await fs.readdir(attachDir);
      // If exists, must be empty (no JE-id subdir for the dry-run entry)
      expect(dirs.length).toBe(0);
    } catch (err) {
      // ENOENT is fine — no dir means definitely no write
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// lessons add — error paths
// ───────────────────────────────────────────────────────────────────────
describe("SC-11 — loaf lessons add (errors)", () => {
  test("--text + --file mutex → USAGE", async () => {
    const tmp = await tmpDir();
    const filePath = path.join(tmp, "f.md");
    await fs.writeFile(filePath, "body");
    const result = await runCli(
      ["lessons", "add",
       "--text", "inline body",
       "--file", filePath,
       "--reason", "covered by manual exploratory test",
       "--feature", "auth-refresh", "--feature-dir", "/tmp/none", "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.message).toContain("exactly one");
  });

  test("neither --text nor --file → USAGE", async () => {
    const result = await runCli(
      ["lessons", "add",
       "--reason", "covered by manual exploratory test",
       "--feature", "auth-refresh", "--feature-dir", "/tmp/none", "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
  });

  test("--file ENOENT → INPUT_FILE_NOT_FOUND", async () => {
    const result = await runCli(
      ["lessons", "add",
       "--file", "/tmp/does-not-exist-sc11",
       "--reason", "covered by manual exploratory test",
       "--feature", "auth-refresh", "--feature-dir", "/tmp/none", "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("INPUT_FILE_NOT_FOUND");
  });

  test("--reason <10 chars → USAGE", async () => {
    const result = await runCli(
      ["lessons", "add",
       "--text", "lesson body",
       "--reason", "short",
       "--feature", "auth-refresh", "--feature-dir", "/tmp/none", "--format", "json"],
      { env: SEED_ENV },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.message).toContain("≥10");
  });

  test("NO_HUMAN_ACTOR via --no-input + no LOAF_USER", async () => {
    const { featureDir } = await seedAtExecuteWork();
    const result = await runCli(
      ["lessons", "add",
       "--text", "lesson body",
       "--reason", "long enough reason here",
       "--no-input",
       "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: { LOAF_USER: undefined } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("NO_HUMAN_ACTOR");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Cross-wrapper monotonic allocation regression (codex r324 P1 tail)
// ───────────────────────────────────────────────────────────────────────
describe("SC-11 — cross-wrapper EV-id monotonic allocation", () => {
  test("waive then lessons add emits sequential EV-ids (single allocator source)", async () => {
    const { featureDir } = await seedAtExecuteWork();

    // (1) waive → EV-000001 (first evidence in fresh feature)
    const waive = await runCli(
      ["waive", "REQ-AUTH-001", "--reason", "covered by manual UX testing scope",
       "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(waive.exit).toBe(0);
    const waiveOut = JSON.parse(waive.stdout);
    const waiveId = waiveOut.id as string;

    // (2) lessons add → EV-000002 (next-after-waiver)
    const lesson = await runCli(
      ["lessons", "add",
       "--text", "lesson body content here",
       "--reason", "captured from triage review",
       "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(lesson.exit).toBe(0);
    const lessonOut = JSON.parse(lesson.stdout);
    const lessonId = lessonOut.id as string;

    // Both should match /EV-\d{6,}/ and lesson > waive sequentially
    expect(waiveId).toMatch(/^EV-\d{6,}$/);
    expect(lessonId).toMatch(/^EV-\d{6,}$/);
    const waiveNum = Number.parseInt(waiveId.slice(3), 10);
    const lessonNum = Number.parseInt(lessonId.slice(3), 10);
    expect(lessonNum).toBe(waiveNum + 1);
  });
});
