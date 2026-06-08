// Phase 16 SC-4c — `loaf evidence add` --input modality + batch.
//
// Closes the SC-4 series. Migrates the 6th source-resolution consumer
// + enables array (batch) input per EvidenceAddInputBatched. After
// SC-4c, all 6 source-resolution consumers + all 5 batch-capable
// INPUT_SCHEMAS commands are on the unified --input <src> contract.
//
// codex r229 → r236 plan-amend cycles locked:
//   - hard-cut: --input <src> (was --input <file>)
//   - batch: array input enabled (was USAGE reject)
//   - runtime mirror: src/core/evidence-schema.ts EvidenceAddInput[Batched]
//     via EvidenceFullShape.omit({id:true}).strict() — full attachment
//     metadata required (ADR-0004 A6 auto-hash materialization deferred)
//   - docs/schemas.ts EvidenceAddInput: omit {schema_version,
//     evidence_id, at} + .strict() — machine schema honest
//   - caller-supplied id: SCHEMA_VALIDATION_FAILED + detail.index
//     (not USAGE; codex r230 PATCH D consistency with tasks add strict)

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import { mutate } from "../../src/core/journal-mutate.js";
import type { SubState } from "../../src/core/journal-entry.js";

type RunCliOpts = {
  stdin?: string;
  isStdinTty?: boolean;
};

async function tmpFeatureDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc4c-"));
}

async function runCli(
  argv: string[],
  opts: RunCliOpts = {},
): Promise<{ exit: number; stdout: string; stderr: string }> {
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
    const deps: {
      readStdin?: () => Promise<string>;
      isStdinTty?: () => boolean;
    } = {};
    if (opts.stdin !== undefined) deps.readStdin = async () => opts.stdin!;
    if (opts.isStdinTty !== undefined) deps.isStdinTty = () => opts.isStdinTty!;
    const exit = await main(["node", "loaf", ...argv], deps);
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

async function seedQuickAtExecuteWork(): Promise<{ dir: string; feature: string }> {
  const dir = await tmpFeatureDir();
  const feature = "F1";
  await runCli(["start", feature, "--ceremony", "quick", "--feature-dir", dir, "--format", "json"]);
  const edges: Array<[SubState, SubState]> = [
    ["TRIAGE.score", "TRIAGE.confirm"],
    ["TRIAGE.confirm", "EXECUTE.plan"],
    ["EXECUTE.plan", "EXECUTE.work"],
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
    if (!r.ok) throw new Error(`seed walk ${from}→${to} failed: ${r.code} ${r.message}`);
  }
  return { dir, feature };
}

function baseInput(kind = "local-check"): Record<string, unknown> {
  return {
    kind,
    iteration: 1,
    actor: "cli:loaf",
    result: "passed",
    summary: "SC-4c stub evidence summary",
  };
}

describe("Phase 16 SC-4c — `loaf evidence add` --input source lanes", () => {
  test("stdin happy (single) → exit 0 + EV-000001", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const r = await runCli(
      ["evidence", "add", "--input", "-", "--feature", feature, "--feature-dir", dir],
      { stdin: JSON.stringify(baseInput()) },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout.trim()).toBe("EV-000001");
  });

  test("inline happy (single) → exit 0 + EV-000001", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const r = await runCli([
      "evidence",
      "add",
      "--input",
      JSON.stringify(baseInput()),
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(0);
    expect(r.stdout.trim()).toBe("EV-000001");
  });

  test("file lane (existing) still works → exit 0 (regression)", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const filePath = path.join(dir, "evidence.json");
    await fs.writeFile(filePath, JSON.stringify(baseInput()));
    const r = await runCli([
      "evidence",
      "add",
      "--input",
      filePath,
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(0);
    expect(r.stdout.trim()).toBe("EV-000001");
  });
});

describe("Phase 16 SC-4c — `loaf evidence add` batch (array) input", () => {
  test("inline array happy (2 items) → 2 EV-ids allocated sequentially", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const r = await runCli([
      "evidence",
      "add",
      "--input",
      JSON.stringify([
        { ...baseInput(), summary: "first batch entry" },
        { ...baseInput(), summary: "second batch entry" },
      ]),
      "--feature",
      feature,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ev_ids).toEqual(["EV-000001", "EV-000002"]);
    expect(out.count).toBe(2);
  });

  test("stdin array happy (3 items) → 3 EV-ids allocated sequentially", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const r = await runCli(
      [
        "evidence",
        "add",
        "--input",
        "-",
        "--feature",
        feature,
        "--feature-dir",
        dir,
        "--format",
        "json",
      ],
      {
        stdin: JSON.stringify([
          { ...baseInput(), summary: "stdin batch #1" },
          { ...baseInput(), summary: "stdin batch #2" },
          { ...baseInput(), summary: "stdin batch #3" },
        ]),
      },
    );
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ev_ids).toEqual(["EV-000001", "EV-000002", "EV-000003"]);
    expect(out.count).toBe(3);
  });
});

describe("Phase 16 SC-4c — `loaf evidence add` error paths", () => {
  test("TTY guard: --input - + stdin TTY → exit 2 USAGE", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const r = await runCli(
      ["evidence", "add", "--input", "-", "--feature", feature, "--feature-dir", dir],
      { isStdinTty: true, stdin: JSON.stringify(baseInput()) },
    );
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/USAGE|stdin|TTY|pipe/i);
  });

  test("stdin malformed JSON → exit 2 SCHEMA_VALIDATION_FAILED", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const r = await runCli(
      ["evidence", "add", "--input", "-", "--feature", feature, "--feature-dir", dir],
      { stdin: "{not json}" },
    );
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("SCHEMA_VALIDATION_FAILED");
  });

  test("inline malformed JSON → exit 2 SCHEMA_VALIDATION_FAILED", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const r = await runCli([
      "evidence",
      "add",
      "--input",
      "{badjson",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("SCHEMA_VALIDATION_FAILED");
  });

  test("caller-supplied id at item[1] in array → SCHEMA_VALIDATION_FAILED + detail.index=1", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const r = await runCli([
      "evidence",
      "add",
      "--input",
      JSON.stringify([
        baseInput(),
        { ...baseInput(), id: "EV-DEADBEEF" }, // caller-supplied id at index 1
      ]),
      "--feature",
      feature,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(r.exit).toBe(2);
    const lines = r.stderr.split("\n").filter((l) => l.startsWith("{"));
    const obj = JSON.parse(lines[0]!);
    expect(obj.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(obj.detail).toMatchObject({ index: 1 });
  });

  test("empty array → SCHEMA_VALIDATION_FAILED with 'empty array' message", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const r = await runCli([
      "evidence",
      "add",
      "--input",
      "[]",
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("SCHEMA_VALIDATION_FAILED");
    expect(r.stderr).toMatch(/empty array|non-empty/i);
  });

  test("attachment-shape regression: {path}-only attachment → SCHEMA_VALIDATION_FAILED (full metadata required)", async () => {
    // Phase 16 SC-4c retains the full attachment metadata requirement
    // (codex r230 PATCH B + r232 confirmation): ADR-0004 A6 auto-hash
    // materialization is deferred to a future SC; runtime input still
    // requires {path, sha256, mime, bytes?}. This test proves the
    // runtime EvidenceAddInput mirror keeps the contract.
    const { dir, feature } = await seedQuickAtExecuteWork();
    const r = await runCli([
      "evidence",
      "add",
      "--input",
      JSON.stringify({
        ...baseInput("visual-review"),
        actor: "human:tester@example.invalid",
        attachments: [{ path: "screenshot.png" }], // {path}-only — missing sha256/mime
      }),
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("SCHEMA_VALIDATION_FAILED");
  });

  test("manual + result=waived → exit 2 INVALID_PAYLOAD (preflight, not input-mirror)", async () => {
    // End-to-end lock for the evidence-schema refine `kind=manual must not
    // carry result=waived` (src/core/evidence-schema.ts). The refine lives on
    // EvidenceFullPayload, NOT the EvidenceAddInput mirror (which is built from
    // the un-refined EvidenceFullShape) — so the input mirror passes and the
    // rejection surfaces at the preflight PER_KIND_PAYLOAD parse as
    // INVALID_PAYLOAD, the same stable-core code as its sibling evidence
    // semantic refines (no presentation-layer localization — see
    // docs/references/loaf-cli-i18n.md). actor=human:* + reason≥10 isolate the
    // waived refine from the manual/waiver human-actor refine.
    const { dir, feature } = await seedQuickAtExecuteWork();
    const r = await runCli(
      [
        "evidence",
        "add",
        "--input",
        JSON.stringify({
          ...baseInput("manual"),
          actor: "human:tester@example.invalid",
          result: "waived",
          reason: "manual review intentionally waived with sufficient justification",
        }),
        "--feature",
        feature,
        "--feature-dir",
        dir,
        "--format",
        "json",
      ],
    );
    expect(r.exit).toBe(2);
    const lines = r.stderr.split("\n").filter((l) => l.startsWith("{"));
    const obj = JSON.parse(lines[0]!);
    expect(obj.code).toBe("INVALID_PAYLOAD");
    // Prove it is the waived refine specifically (detail.issues carries the
    // Zod refine message), not the human-actor or visual-review refine.
    expect(JSON.stringify(obj)).toContain("must not carry result=waived");
  });
});

describe("Phase 16 SC-4c — machine-schema regression (docs/schemas.ts INPUT_SCHEMAS['evidence:add'])", () => {
  // Codex r232 + r234: docs/schemas.ts is the surface --schema --json
  // dumps to callers. The published contract MUST match runtime SC-4c
  // discipline. These 5 assertions catch the false-close risk where
  // docs schema drifts from runtime.

  test("docs INPUT_SCHEMAS['evidence:add'] accepts minimal valid input (no schema_version / id / evidence_id)", async () => {
    const docsSchema: any = await import("../../docs/schemas.js");
    const schema = docsSchema.INPUT_SCHEMAS["evidence:add"];
    const r = schema.safeParse({
      kind: "local-check",
      iteration: 1,
      actor: "cli:loaf",
      result: "passed",
      summary: "minimal valid input",
    });
    expect(r.success).toBe(true);
  });

  test("docs schema REJECTS {attachments:[{path:...}]} without sha256/mime (full metadata required)", async () => {
    const docsSchema: any = await import("../../docs/schemas.js");
    const schema = docsSchema.INPUT_SCHEMAS["evidence:add"];
    const r = schema.safeParse({
      kind: "visual-review",
      iteration: 1,
      actor: "human:tester@example.invalid",
      result: "passed",
      summary: "visual review attempt",
      attachments: [{ path: "x.png" }],
    });
    expect(r.success).toBe(false);
  });

  test("docs schema REJECTS caller-supplied runtime `id`", async () => {
    const docsSchema: any = await import("../../docs/schemas.js");
    const schema = docsSchema.INPUT_SCHEMAS["evidence:add"];
    const r = schema.safeParse({
      ...baseInput(),
      id: "EV-DEADBEEF",
    });
    expect(r.success).toBe(false);
  });

  test("docs schema REJECTS caller-supplied docs `evidence_id` (alias path)", async () => {
    const docsSchema: any = await import("../../docs/schemas.js");
    const schema = docsSchema.INPUT_SCHEMAS["evidence:add"];
    const r = schema.safeParse({
      ...baseInput(),
      evidence_id: "EV-DEADBEEF",
    });
    expect(r.success).toBe(false);
  });

  test("docs schema REJECTS unknown keys (.strict() public contract)", async () => {
    const docsSchema: any = await import("../../docs/schemas.js");
    const schema = docsSchema.INPUT_SCHEMAS["evidence:add"];
    const r = schema.safeParse({
      ...baseInput(),
      bogus_field: "should be rejected",
    });
    expect(r.success).toBe(false);
  });
});
