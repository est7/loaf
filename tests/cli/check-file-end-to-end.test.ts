// Phase 16 SC-9c — `loaf check <path>` CLI end-to-end.
//
// Covers:
//   - JSON envelope happy (success line)
//   - Text mode happy
//   - SCHEMA_VALIDATION_FAILED with detail.errors[] rendering
//   - SCHEMA_VALIDATION_FAILED with truncation suffix (codex r309 B2)
//   - INPUT_FILE_NOT_FOUND
//   - did-you-mean: `loaf check tasks` → USAGE + suggestion
//   - did-you-mean negative: `loaf check evidence` → INPUT_FILE_NOT_FOUND, NO suggestion
//   - did-you-mean negative: `loaf check spec` → INPUT_FILE_NOT_FOUND, NO suggestion
//   - did-you-mean negative: `loaf check ./tasks` → NOT the suggestion
//   - Pre-parse guard rejects --feature / --session / --feature-dir
//   - --dry-run reject DRY_RUN_NOT_APPLICABLE
//   - --kind override works
//   - --kind invalid value → USAGE
//   - text-mode failure renders nested error lines + truncation suffix

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main, type MainDeps } from "../../src/cli.js";

async function tmp(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc9c-e2e-"));
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

const VALID_TASKS_JSON = JSON.stringify({
  schema_version: 2,
  version: 1,
  based_on: { spec: 1 },
  tasks: [],
});

describe("SC-9c — `check` happy paths", () => {
  test("JSON mode: valid tasks.json → exit 0, ok=true, kind=tasks, absolute path", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    await fs.writeFile(file, VALID_TASKS_JSON);
    const result = await runCli(["check", file, "--format", "json"], {});
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("tasks");
    expect(out.path).toBe(file);
  });

  test("text mode: valid tasks.json → exit 0, stdout starts with 'ok: tasks at '", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    await fs.writeFile(file, VALID_TASKS_JSON);
    const result = await runCli(["check", file], {});
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("ok: tasks at ");
  });
});

describe("SC-9c — schema failure rendering", () => {
  test("JSON mode: Zod fail emits detail.errors[] + detail.subcode", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    await fs.writeFile(file, JSON.stringify({ wrong: "shape" }));
    const result = await runCli(["check", file, "--format", "json"], {});
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.ok).toBe(false);
    expect(err.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(err.detail.subcode).toBe("zod");
    expect(Array.isArray(err.detail.errors)).toBe(true);
    expect(err.detail.errors.length).toBeGreaterThan(0);
    expect(typeof err.detail.error_count).toBe("number");
  });

  test("LOAF_LANG=zh leaves schema validation JSON message byte-stable", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    await fs.writeFile(file, JSON.stringify({ wrong: "shape" }));
    const argv = ["check", file, "--format", "json"];
    const enResult = await runCli(argv);
    const zhResult = await runCli(argv, { env: { LOAF_LANG: "zh" } });
    expect(enResult.exit).toBe(2);
    expect(zhResult.exit).toBe(2);
    expect(zhResult.stderr).toBe(enResult.stderr);
  });

  test("text mode: Zod fail renders top line + nested [path] CODE: message rows", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    await fs.writeFile(file, JSON.stringify({ wrong: "shape" }));
    const result = await runCli(["check", file], {});
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("error: SCHEMA_VALIDATION_FAILED — ");
    // Nested error lines render as `  [path] CODE: message`
    expect(result.stderr).toMatch(/\n {2}\[[^\]]*\] [A-Za-z_]+: /);
  });

  test("LOAF_LANG=zh localizes schema validation top text while keeping raw detail rows", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    await fs.writeFile(file, JSON.stringify({ wrong: "shape" }));
    const result = await runCli(["check", file], { env: { LOAF_LANG: "zh" } });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("error: SCHEMA_VALIDATION_FAILED — tasks at ");
    expect(result.stderr).toContain("校验失败");
    expect(result.stderr).toMatch(/\n {2}\[[^\]]*\] [A-Za-z_]+: /);
  });

  test("text mode: truncation suffix renders when error_count > MAX_CHECK_ERRORS (20)", async () => {
    const dir = await tmp();
    const file = path.join(dir, "spec.md");
    // Build a spec.md with 25 invalid REQ ids — SpecFrontmatter regex
    // enforcement at requirements[*].id triggers a Zod issue per invalid.
    const badReqs = Array.from({ length: 25 }, (_, i) =>
      `  - id: not-a-valid-req-id-${i}\n    type: ubiquitous\n    response: the system shall do something here measurably\n    acceptance_na: true\n    acceptance_na_reason: subjective UX validated`,
    ).join("\n");
    const fm = `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: Bulk fail spec
intent: synthetic fixture for SC-9c truncation
adr_refs: []
requirements:
${badReqs}
scenarios: []
needs_clarification: []
---

prose
`;
    await fs.writeFile(file, fm);
    const result = await runCli(["check", file], {});
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("errors total; first ");
  });
});

describe("SC-9c — file not found", () => {
  test("non-tasks basename + no file → INPUT_FILE_NOT_FOUND, NO did-you-mean", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    const result = await runCli(["check", file, "--format", "json"], {});
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("INPUT_FILE_NOT_FOUND");
    expect(err.message).not.toContain("'loaf tasks check'");
  });

  test("LOAF_LANG=zh localizes check missing-path text failure", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    const result = await runCli(["check", file], { env: { LOAF_LANG: "zh" } });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("input file 不存在");
  });

  test("LOAF_LANG=zh leaves check missing-path JSON message byte-stable", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    const argv = ["check", file, "--format", "json"];
    const enResult = await runCli(argv);
    const zhResult = await runCli(argv, { env: { LOAF_LANG: "zh" } });
    expect(enResult.exit).toBe(2);
    expect(zhResult.exit).toBe(2);
    expect(zhResult.stderr).toBe(enResult.stderr);
  });
});

describe("SC-9c — did-you-mean for `loaf check tasks` (§1899)", () => {
  test("positive: `loaf check tasks` with no file → USAGE + suggestion", async () => {
    const dir = await tmp();
    const result = await runCli(["check", "tasks", "--format", "json"], { cwd: dir });
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    // SC-17: suggestion now points at the v0.1.0-real path-based check.
    expect(err.message).toContain("--kind tasks");
    expect(err.message).not.toContain("did you mean 'loaf tasks check'?");
    expect(err.detail.suggestion).toBe("loaf check <path>/tasks.json --kind tasks");
  });

  test("LOAF_LANG=zh localizes check kind-required text failure", async () => {
    const dir = await tmp();
    const result = await runCli(["check", "tasks"], { cwd: dir, env: { LOAF_LANG: "zh" } });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("需要显式路径");
    expect(result.stderr).toContain("--kind tasks");
  });

  test("negative `evidence` (no file) → INPUT_FILE_NOT_FOUND, NO did-you-mean (codex r311)", async () => {
    const dir = await tmp();
    const result = await runCli(["check", "evidence", "--format", "json"], { cwd: dir });
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("INPUT_FILE_NOT_FOUND");
    expect(err.message).not.toContain("'loaf evidence check'");
    expect(err.message).not.toContain("'loaf tasks check'");
  });

  test("negative `spec` (no file) → INPUT_FILE_NOT_FOUND (codex r311)", async () => {
    const dir = await tmp();
    const result = await runCli(["check", "spec", "--format", "json"], { cwd: dir });
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("INPUT_FILE_NOT_FOUND");
    expect(err.message).not.toContain("'loaf spec check'");
    expect(err.message).not.toContain("'loaf tasks check'");
  });

  test("negative `./tasks` (explicit dot-slash, no file) → INPUT_FILE_NOT_FOUND (codex r311)", async () => {
    const dir = await tmp();
    const result = await runCli(["check", "./tasks", "--format", "json"], { cwd: dir });
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("INPUT_FILE_NOT_FOUND");
    expect(err.message).not.toContain("'loaf tasks check'");
  });
});

describe("SC-9c — pre-parse guard rejects feature selectors", () => {
  test("--feature → USAGE conflicting", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    await fs.writeFile(file, VALID_TASKS_JSON);
    const result = await runCli(["check", file, "--feature", "foo", "--format", "json"], {});
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.detail.conflicting).toContain("--feature");
  });

  test("--feature-dir → USAGE conflicting", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    await fs.writeFile(file, VALID_TASKS_JSON);
    const result = await runCli(
      ["check", file, "--feature-dir", "/tmp/x", "--format", "json"],
      {},
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.detail.conflicting).toContain("--feature-dir");
  });

  test("--session → USAGE conflicting", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    await fs.writeFile(file, VALID_TASKS_JSON);
    const result = await runCli(
      ["check", file, "--session", "abcdefgh", "--format", "json"],
      {},
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.detail.conflicting).toContain("--session");
  });

  test("$LOAF_FEATURE env → USAGE conflicting (parity with SC-9b)", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    await fs.writeFile(file, VALID_TASKS_JSON);
    const result = await runCli(
      ["check", file, "--format", "json"],
      { env: { LOAF_FEATURE: "foo" } },
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.detail.conflicting).toContain("$LOAF_FEATURE");
  });
});

describe("SC-9c — flags", () => {
  test("--dry-run rejected: exit 2 DRY_RUN_NOT_APPLICABLE", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    await fs.writeFile(file, VALID_TASKS_JSON);
    const result = await runCli(["check", file, "--dry-run", "--format", "json"], {});
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("DRY_RUN_NOT_APPLICABLE");
  });

  test("--kind override: scratch.json + --kind tasks → ok", async () => {
    const dir = await tmp();
    const file = path.join(dir, "scratch.json");
    await fs.writeFile(file, VALID_TASKS_JSON);
    const result = await runCli(
      ["check", file, "--kind", "tasks", "--format", "json"],
      {},
    );
    expect(result.exit).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.kind).toBe("tasks");
  });

  test("--kind invalid value → USAGE", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    await fs.writeFile(file, VALID_TASKS_JSON);
    const result = await runCli(
      ["check", file, "--kind", "nonsense", "--format", "json"],
      {},
    );
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
  });

  test("LOAF_LANG=zh localizes invalid --kind text failure", async () => {
    const dir = await tmp();
    const file = path.join(dir, "tasks.json");
    await fs.writeFile(file, VALID_TASKS_JSON);
    const result = await runCli(
      ["check", file, "--kind", "nonsense"],
      { env: { LOAF_LANG: "zh" } },
    );
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("--kind 必须是");
  });
});
