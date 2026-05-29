// Phase 16 SC-12a-2 — `loaf spec edit` CLI end-to-end.
//
// Uses MainDeps.runEditor stub injection — tests NEVER spawn a real
// editor (codex r331 P3 lock). Stubs simulate noop / mutate / abort /
// signal / spawn-error to assert work-copy semantics + no-op skip +
// frontmatter subcode taxonomy.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main, type MainDeps } from "../../src/cli.js";
import type { RunEditor, RunEditorResult } from "../../src/cli/run-editor.js";

async function tmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc12-edit-e2e-"));
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

const VALID_SPEC_MD = `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: OAuth token refresh
intent: users should not perceive auth recovery flows in flight
adr_refs: []
requirements: []
scenarios: []
needs_clarification: []
---

## Why
prose
`;

async function seedFeatureWithSpecMd(): Promise<{ featureDir: string }> {
  const tmp = await tmpDir();
  const featureDir = path.join(tmp, ".loaf", "auth-refresh");
  await fs.mkdir(featureDir, { recursive: true });
  // start to bootstrap journal at TRIAGE.score
  const start = await runCli(
    ["start", "auth-refresh", "--ceremony", "standard",
     "--feature-dir", featureDir, "--format", "json"],
    { env: SEED_ENV },
  );
  if (start.exit !== 0) throw new Error(`seed start failed: ${start.stderr}`);
  // walk to SPEC.proposal (where event:spec_submitted is allowed)
  for (const sub of ["TRIAGE.confirm", "SPEC.proposal"]) {
    const adv = await runCli(
      ["advance", sub, "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    if (adv.exit !== 0) throw new Error(`seed advance ${sub} failed: ${adv.stderr}`);
  }
  await fs.writeFile(path.join(featureDir, "spec.md"), VALID_SPEC_MD);
  return { featureDir };
}

/** runEditor stub that writes `newContent` to filePath before resolving. */
function stubEditor(newContent: string | null, exit: { code: number; signal: string | null; error?: string }): RunEditor {
  return async (args): Promise<RunEditorResult> => {
    if (newContent !== null) {
      await fs.writeFile(args.filePath, newContent);
    }
    return exit;
  };
}

const NOOP_EDITOR: RunEditor = async () => ({ code: 0, signal: null });

// ───────────────────────────────────────────────────────────────────────
// Happy paths
// ───────────────────────────────────────────────────────────────────────
describe("SC-12a-2 — spec edit happy paths", () => {
  test("noop editor (no content change) → exit 0, no_op:true, NO journal write", async () => {
    const { featureDir } = await seedFeatureWithSpecMd();
    const journalBefore = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
    const result = await runCli(
      ["spec", "edit", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV, deps: { runEditor: NOOP_EDITOR } },
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.no_op).toBe(true);
    // Journal byte count unchanged
    const journalAfter = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
    expect(journalAfter.length).toBe(journalBefore.length);
  });

  test("modified spec → exit 0, spec_version bumped, journal appended", async () => {
    const { featureDir } = await seedFeatureWithSpecMd();
    const journalBefore = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
    // Editor stub writes a slightly different content (different intent)
    const modified = VALID_SPEC_MD.replace("auth recovery flows in flight", "auth recovery flows in flight (revised)");
    const result = await runCli(
      ["spec", "edit", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV, deps: { runEditor: stubEditor(modified, { code: 0, signal: null }) } },
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.spec_version).toBe(1); // first spec_submitted at SPEC.proposal stamps version=1
    const journalAfter = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
    expect(journalAfter.length).toBeGreaterThan(journalBefore.length);
    // Verify the new entry is event:spec_submitted
    const lastLine = journalAfter.trim().split("\n").pop()!;
    const entry = JSON.parse(lastLine);
    expect(entry.kind).toBe("event:spec_submitted");
  });

  test("user edits spec_version: 99 — CLI stamps current+1 (1), NOT 99", async () => {
    const { featureDir } = await seedFeatureWithSpecMd();
    const stale = VALID_SPEC_MD.replace("spec_version: 1", "spec_version: 99");
    const result = await runCli(
      ["spec", "edit", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV, deps: { runEditor: stubEditor(stale, { code: 0, signal: null }) } },
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    // CLI ignores user-edited spec_version, stamps snapshot.state.spec_version (0) + 1
    expect(out.spec_version).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Editor exit codes / signal split (codex r333 P3)
// ───────────────────────────────────────────────────────────────────────
describe("SC-12a-2 — editor exit semantics", () => {
  test("signal abort (SIGINT) → exit 130, no journal write", async () => {
    const { featureDir } = await seedFeatureWithSpecMd();
    const journalBefore = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
    const result = await runCli(
      ["spec", "edit", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV, deps: { runEditor: async () => ({ code: 130, signal: "SIGINT" }) } },
    );
    expect(result.exit).toBe(130);
    const journalAfter = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
    expect(journalAfter.length).toBe(journalBefore.length);
  });

  test("non-zero exit (no signal) → exit 2 USAGE, no journal write", async () => {
    const { featureDir } = await seedFeatureWithSpecMd();
    const result = await runCli(
      ["spec", "edit", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV, deps: { runEditor: async () => ({ code: 1, signal: null }) } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.detail.editor_exit).toBe(1);
  });

  test("spawn error → exit 2 USAGE + detail.spawn_error", async () => {
    const { featureDir } = await seedFeatureWithSpecMd();
    const result = await runCli(
      ["spec", "edit", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV, deps: { runEditor: async () => ({ code: 127, signal: null, error: "ENOENT" }) } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.detail.spawn_error).toBe("ENOENT");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Frontmatter validation subcodes (codex r336 P3)
// ───────────────────────────────────────────────────────────────────────
describe("SC-12a-2 — frontmatter subcode taxonomy", () => {
  test("missing frontmatter → SCHEMA_VALIDATION_FAILED subcode=missing-frontmatter; work copy preserved", async () => {
    const { featureDir } = await seedFeatureWithSpecMd();
    const specPath = path.join(featureDir, "spec.md");
    const noFrontmatter = "no frontmatter here\nprose only\n";
    const result = await runCli(
      ["spec", "edit", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV, deps: { runEditor: stubEditor(noFrontmatter, { code: 0, signal: null }) } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(err.detail.subcode).toBe("missing-frontmatter");
    // Work copy preserved
    const on_disk = await fs.readFile(specPath, "utf8");
    expect(on_disk).toBe(noFrontmatter);
  });

  test("invalid YAML → subcode=invalid-yaml; work copy preserved", async () => {
    const { featureDir } = await seedFeatureWithSpecMd();
    const specPath = path.join(featureDir, "spec.md");
    const brokenYaml = "---\n: : not valid yaml @ :\n---\nbody\n";
    const result = await runCli(
      ["spec", "edit", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV, deps: { runEditor: stubEditor(brokenYaml, { code: 0, signal: null }) } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(err.detail.subcode).toBe("invalid-yaml");
    const on_disk = await fs.readFile(specPath, "utf8");
    expect(on_disk).toBe(brokenYaml);
  });

  test("Zod schema fail → subcode=zod; work copy preserved + errors array", async () => {
    const { featureDir } = await seedFeatureWithSpecMd();
    const specPath = path.join(featureDir, "spec.md");
    // Valid YAML but doesn't match SpecFrontmatter (missing required fields)
    const zodFail = "---\nschema_version: 2\n---\nbody\n";
    const result = await runCli(
      ["spec", "edit", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV, deps: { runEditor: stubEditor(zodFail, { code: 0, signal: null }) } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(err.detail.subcode).toBe("zod");
    expect(Array.isArray(err.detail.errors)).toBe(true);
    const on_disk = await fs.readFile(specPath, "utf8");
    expect(on_disk).toBe(zodFail);
  });

  test("spec.md deleted before edit → spec-not-found subcode", async () => {
    const { featureDir } = await seedFeatureWithSpecMd();
    await fs.unlink(path.join(featureDir, "spec.md"));
    const result = await runCli(
      ["spec", "edit", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV, deps: { runEditor: NOOP_EDITOR } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(err.detail.subcode).toBe("spec-not-found");
  });

  test("spec.md deleted DURING edit → spec-not-found", async () => {
    const { featureDir } = await seedFeatureWithSpecMd();
    const specPath = path.join(featureDir, "spec.md");
    const deletingEditor: RunEditor = async () => {
      await fs.unlink(specPath);
      return { code: 0, signal: null };
    };
    const result = await runCli(
      ["spec", "edit", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV, deps: { runEditor: deletingEditor } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(err.detail.subcode).toBe("spec-not-found");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Flags (--dry-run / post-lock / NO_HUMAN_ACTOR)
// ───────────────────────────────────────────────────────────────────────
describe("SC-12a-2 — flags + actor", () => {
  test("--dry-run rejected BEFORE editor spawn (codex r336 P5)", async () => {
    const { featureDir } = await seedFeatureWithSpecMd();
    let editorCalled = false;
    const trackingEditor: RunEditor = async () => {
      editorCalled = true;
      return { code: 0, signal: null };
    };
    const result = await runCli(
      ["spec", "edit", "--dry-run", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV, deps: { runEditor: trackingEditor } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("DRY_RUN_NOT_APPLICABLE");
    expect(err.detail.command_type).toBe("wrapping");
    expect(editorCalled).toBe(false);
  });

  test("malformed $EDITOR (unmatched quote) → exit 2 USAGE + tokenize_error detail, no journal write (codex r339 P1)", async () => {
    const { featureDir } = await seedFeatureWithSpecMd();
    const journalBefore = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
    const result = await runCli(
      ["spec", "edit", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: { ...SEED_ENV, EDITOR: `node "<unmatched` } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.detail.spawn_error).toBe("EDITOR_TOKENIZE_ERROR");
    const journalAfter = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
    expect(journalAfter.length).toBe(journalBefore.length);
  });

  test("post-lock reject (codex r339 P2): spec_locked=true → SPEC_LOCKED_NO_DIRECT_EDIT BEFORE editor spawn", async () => {
    const { featureDir } = await seedFeatureWithSpecMd();
    // Walk further to lock: this is a heavyweight seed. Instead, fake
    // the lock by appending a synthetic gate:decided + phase_advanced
    // batch IS too complex inline. Reuse a simpler approach: drive
    // the lock via CLI: spec submit + add-req + tasks submit + gate
    // decide spec-lock.
    // ... but this would duplicate the SC-11 seed. For the regression
    // RED to be reliable, we use a lighter-touch trick: spawn a session
    // already at SPEC.proposal with NO editor invocation expected.
    //
    // Lock the session by running the full SPEC walk + spec-lock approve
    // via existing CLI surface (mirror tests/cli/sc11-end-to-end.ts
    // seedAtExecuteWork pattern, abridged to just the lock).
    const advSpec = await runCli(
      ["advance", "SPEC.spec", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(advSpec.exit).toBe(0);
    // The seedFeatureWithSpecMd path already lands at SPEC.proposal with
    // spec_locked=false. To reach spec_locked=true requires the full SPEC
    // walk → gate decide. Heavy.
    // Lighter alt: assert post-lock reject indirectly via the SC-11 e2e
    // pattern. The cheapest path that exercises the gate check is:
    //   - submit spec
    //   - add-req (bumps spec_version)
    //   - advance SPEC.plan, SPEC.design
    //   - tasks submit
    //   - gate decide spec-lock approve → spec_locked=true
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
    expect(submit.exit).toBe(0);
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
    expect(addReq.exit).toBe(0);
    for (const sub of ["SPEC.plan", "SPEC.design"]) {
      const adv = await runCli(
        ["advance", sub, "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
        { env: SEED_ENV },
      );
      expect(adv.exit).toBe(0);
    }
    const submitTasks = await runCli(
      ["tasks", "submit", "--input",
       JSON.stringify({
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
    expect(submitTasks.exit).toBe(0);
    const lock = await runCli(
      ["gate", "decide", "spec-lock", "--approve", "--reason", "seed: spec ready for execution",
       "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV },
    );
    expect(lock.exit).toBe(0);
    // Now spec_locked=true at EXECUTE.plan. Attempt spec edit — must
    // reject BEFORE spawning $EDITOR.
    let editorCalled = false;
    const trackingEditor: RunEditor = async () => {
      editorCalled = true;
      return { code: 0, signal: null };
    };
    const journalBefore = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
    const specBefore = await fs.readFile(path.join(featureDir, "spec.md"), "utf8");
    const result = await runCli(
      ["spec", "edit", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: SEED_ENV, deps: { runEditor: trackingEditor } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("SPEC_LOCKED_NO_DIRECT_EDIT");
    expect(editorCalled).toBe(false);
    const journalAfter = await fs.readFile(path.join(featureDir, "journal.jsonl"), "utf8");
    expect(journalAfter.length).toBe(journalBefore.length);
    const specAfter = await fs.readFile(path.join(featureDir, "spec.md"), "utf8");
    expect(specAfter).toBe(specBefore);
  });

  test("NO_HUMAN_ACTOR via --no-input + no LOAF_USER", async () => {
    const { featureDir } = await seedFeatureWithSpecMd();
    const result = await runCli(
      ["spec", "edit", "--no-input", "--feature", "auth-refresh", "--feature-dir", featureDir, "--format", "json"],
      { env: { LOAF_USER: undefined }, deps: { runEditor: NOOP_EDITOR } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("NO_HUMAN_ACTOR");
  });
});
