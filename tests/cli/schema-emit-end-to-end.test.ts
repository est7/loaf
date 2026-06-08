// Phase 16 SC-10 — `loaf <mutator> --schema` + `loaf <kind> schema` e2e.
//
// Covers (codex r316 lock):
//   - 5 mutator --schema CLI invocations: stdout = valid JSON Schema
//   - 5 artifact `<kind> schema` CLI invocations: stdout = valid JSON Schema
//   - --schema bypass succeeds WITHOUT --input + WITHOUT session resolution
//   - --schema + --dry-run → DRY_RUN_NOT_APPLICABLE
//   - <kind> schema + --dry-run → DRY_RUN_NOT_APPLICABLE
//   - mutator --schema + --feature/--feature-dir/--session/$LOAF_FEATURE → USAGE conflict
//   - <kind> schema + same selectors → USAGE conflict
//   - mutator WITHOUT --schema and WITHOUT --input → MISSING_INPUT
//   - mutator WITHOUT --schema + --feature still accepted (negative — selectors
//     only rejected in --schema mode)

import { describe, expect, test } from "vitest";
import { main, type MainDeps } from "../../src/cli.js";

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

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

// ───────────────────────────────────────────────────────────────────────
// 5 mutator --schema happy paths
// ───────────────────────────────────────────────────────────────────────
describe("SC-10 — mutator --schema happy paths (no --input, no session)", () => {
  for (const args of [
    ["spec", "add-req"],
    ["spec", "add-scenario"],
    ["spec", "add-visual"],
    ["tasks", "add"],
    ["evidence", "add"],
  ] as const) {
    test(`loaf ${args.join(" ")} --schema --format=json → exit 0, valid JSON Schema (root anyOf), no session`, async () => {
      const result = await runCli([...args, "--schema", "--format=json"]);
      expect(result.exit).toBe(0);
      const schema = JSON.parse(result.stdout);
      expect(schema.$schema).toBe(DRAFT);
      // batchOrSingle wrapper → root anyOf
      expect(Array.isArray(schema.anyOf)).toBe(true);
    });
  }
});

// ───────────────────────────────────────────────────────────────────────
// 5 artifact <kind> schema happy paths
// ───────────────────────────────────────────────────────────────────────
describe("SC-10 — `<kind> schema` artifact happy paths", () => {
  for (const kind of ["spec", "tasks", "evidence", "finding", "state"] as const) {
    test(`loaf ${kind} schema --format=json → exit 0, root type=object`, async () => {
      const result = await runCli([kind, "schema", "--format=json"]);
      expect(result.exit).toBe(0);
      const schema = JSON.parse(result.stdout);
      expect(schema.$schema).toBe(DRAFT);
      expect(schema.type).toBe("object");
      expect(typeof schema.properties).toBe("object");
    });
  }
});

// ───────────────────────────────────────────────────────────────────────
// --dry-run rejection (both surfaces)
// ───────────────────────────────────────────────────────────────────────
describe("SC-10 — --dry-run rejection", () => {
  test("loaf spec add-req --schema --dry-run → DRY_RUN_NOT_APPLICABLE", async () => {
    const result = await runCli(["spec", "add-req", "--schema", "--dry-run", "--format=json"]);
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("DRY_RUN_NOT_APPLICABLE");
  });

  test("loaf tasks schema --dry-run → DRY_RUN_NOT_APPLICABLE", async () => {
    const result = await runCli(["tasks", "schema", "--dry-run", "--format=json"]);
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("DRY_RUN_NOT_APPLICABLE");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Selector rejection (both surfaces)
// ───────────────────────────────────────────────────────────────────────
describe("SC-10 — selector rejection (--feature / $LOAF_FEATURE)", () => {
  test("mutator --schema + --feature → USAGE conflicting", async () => {
    const result = await runCli([
      "spec",
      "add-req",
      "--schema",
      "--feature",
      "foo",
      "--format=json",
    ]);
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.detail.conflicting).toContain("--feature");
  });

  test("mutator --schema + $LOAF_FEATURE env → USAGE conflicting", async () => {
    const result = await runCli(["tasks", "add", "--schema", "--format=json"], {
      env: { LOAF_FEATURE: "foo" },
    });
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.detail.conflicting).toContain("$LOAF_FEATURE");
  });

  test("<kind> schema + --feature → USAGE conflicting", async () => {
    const result = await runCli(["evidence", "schema", "--feature", "foo", "--format=json"]);
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.detail.conflicting).toContain("--feature");
  });

  test("<kind> schema + $LOAF_FEATURE env → USAGE conflicting", async () => {
    const result = await runCli(["state", "schema", "--format=json"], {
      env: { LOAF_FEATURE: "foo" },
    });
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("USAGE");
    expect(err.detail.conflicting).toContain("$LOAF_FEATURE");
  });
});

// ───────────────────────────────────────────────────────────────────────
// MISSING_INPUT — normal mutator path without --schema and without --input
// ───────────────────────────────────────────────────────────────────────
describe("SC-10 — mutator without --schema and without --input → MISSING_INPUT", () => {
  test("spec add-req → MISSING_INPUT", async () => {
    const result = await runCli(["spec", "add-req", "--format=json"]);
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("MISSING_INPUT");
  });

  test("evidence add → MISSING_INPUT", async () => {
    const result = await runCli(["evidence", "add", "--format=json"]);
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    expect(err.code).toBe("MISSING_INPUT");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Negative — normal mutator (no --schema) still accepts --feature
// ───────────────────────────────────────────────────────────────────────
describe("SC-10 — selector guard scoped to --schema mode only", () => {
  test("normal `tasks add --input ... --feature foo` does NOT hit SC-10 selector guard", async () => {
    // Without --schema, --feature is the normal dispatch path — must not
    // be rejected by SC-10's pre-parse guard. Will fail downstream
    // (no .loaf/foo or no input shape), but NOT with SC-10's "schema
    // does not accept --feature" wording.
    const result = await runCli([
      "tasks",
      "add",
      "--input",
      "{}",
      "--feature",
      "fooX",
      "--format=json",
    ]);
    expect(result.exit).toBe(2);
    const err = JSON.parse(result.stderr);
    // Must NOT be the SC-10 USAGE conflict message
    expect(err.message ?? "").not.toContain("schema dumps are feature-agnostic");
    // Negative codes — accept either flow downstream (schema validation,
    // file not found, feature lookup, etc.). Key: NOT the SC-10 selector
    // USAGE.
  });
});
