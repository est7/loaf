// Slice 4 SC1 — `loaf spec submit --input <file>` whole-replacement entry
// + DUPLICATE_REQ_ID / DUPLICATE_SCEN_ID / DUPLICATE_VIS_ID preflight
// promotion.
//
// RED first: every new-behavior assertion below fails on pre-SC1 main
// (no `loaf spec` command tree; DUPLICATE_* are reducer-side message
// strings, not preflight codes).
//
// Scope per codex r74 sign-off (thread review/cli-lifecycle-plan):
//   - Single command: `loaf spec submit --input <file> --feature <name>`.
//   - Input shape mirrors SpecFrontmatter (full ids, NOT id_namespace —
//     id_namespace allocator is SC2 add-* territory).
//   - input.spec_version optional: CLI fills with current+1 when absent;
//     if present, must equal current+1 (else SPEC_VERSION_NOT_MONOTONIC).
//   - Batch shape: [spec_submitted at batch_index=0, ...
//     spec_req_added*, spec_scenario_added*, spec_visual_added*] all
//     sharing one batch_id + spec_version. Empty companion arrays → 1-entry.
//   - DUPLICATE_REQ_ID / DUPLICATE_SCEN_ID / DUPLICATE_VIS_ID promote
//     from reducer-side message string to PreflightFailureCode, mirror
//     Slice 2 SC4 DUPLICATE_TASK_ID pattern. Two cases caught:
//       (a) within same submit batch (two REQ-AUTH-001 entries)
//       (b) against existing projection (re-submit same id)

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import { mutate } from "../../src/core/journal-mutate.js";
import type { SubState } from "../../src/core/journal-entry.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-spec-submit-"));
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
 * Walk a standard-ceremony session to SPEC.proposal (where spec_submitted
 * is legal). 3 advances after start. Returns dir + feature.
 */
async function seedAtSpecProposal(): Promise<{ dir: string; feature: string }> {
  const dir = await tmpFeatureDir();
  const feature = "F1";
  const startRes = await runCli([
    "start",
    feature,
    "--ceremony",
    "standard",
    "--feature-dir",
    dir,
    "--format",
    "json",
  ]);
  if (startRes.exit !== 0) throw new Error(`start failed: ${startRes.stderr}`);
  const edges: Array<[SubState, SubState]> = [
    ["TRIAGE.score", "TRIAGE.confirm"],
    ["TRIAGE.confirm", "SPEC.proposal"],
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

async function writeInput(dir: string, payload: unknown): Promise<string> {
  const p = path.join(dir, "spec-submit-input.json");
  await fs.writeFile(p, JSON.stringify(payload));
  return p;
}

function baseHeader(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    feature: { id: "F-001", name: "OAuth token refresh fixture" },
    intent: "users should not perceive auth recovery flows in flight",
    adr_refs: [],
    needs_clarification: [],
    ...overrides,
  };
}

const VALID_REQ = {
  id: "REQ-AUTH-001",
  type: "ubiquitous" as const,
  response: "the system shall do something measurable here",
  acceptance_na: true,
  acceptance_na_reason: "subjective UX validated via manual testing scope",
};
const VALID_SCEN = {
  id: "SCEN-LOGIN-001",
  name: "happy login",
  given: ["user is logged out"],
  when: ["user submits valid credentials"],
  then: ["session token issued"],
  acceptance_na: "covered by manual exploration in fixture",
};
const VALID_VIS = {
  id: "VIS-DASH-001",
  target: "dashboard main panel",
  checks: ["header text matches brand"],
  visual_na: "skipped per fixture (no visual review yet)",
};

describe("loaf spec submit — SC1 happy paths", () => {
  test("minimal submit (header only, no companions) → 1-entry batch; spec_version=1", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const before = await readJournalLines(dir);
    const input = await writeInput(dir, baseHeader());
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      input,
      "--feature",
      feature,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(r.exit).toBe(0);
    const after = await readJournalLines(dir);
    expect(after.length - before.length).toBe(1);
    const s = await loadSnapshot(dir);
    expect(s.snapshot.state?.spec_version).toBe(1);
    expect(s.snapshot.requirements).toEqual([]);
    expect(s.snapshot.scenarios).toEqual([]);
    expect(s.snapshot.visual_contracts).toEqual([]);
  });

  test("submit with REQ+SCEN+VIS arrays → N+1-entry batch sharing batch_id; projections populated", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const before = await readJournalLines(dir);
    const input = await writeInput(
      dir,
      baseHeader({
        requirements: [VALID_REQ],
        scenarios: [VALID_SCEN],
        visual_contracts: [VALID_VIS],
      }),
    );
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      input,
      "--feature",
      feature,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(r.exit).toBe(0);
    const after = await readJournalLines(dir);
    expect(after.length - before.length).toBe(4); // submit + req + scen + vis
    const newEntries = after.slice(-4).map((l) => JSON.parse(l));
    // All share batch_id; spec_submitted at batch_index=0.
    expect(new Set(newEntries.map((e) => e.batch_id)).size).toBe(1);
    expect(newEntries[0].kind).toBe("event:spec_submitted");
    expect(newEntries[0].batch_index).toBe(0);
    expect(
      newEntries.slice(1).every((e) => typeof e.batch_index === "number" && e.batch_index >= 1),
    ).toBe(true);
    const s = await loadSnapshot(dir);
    expect(s.snapshot.state?.spec_version).toBe(1);
    expect(s.snapshot.requirements.map((r: any) => r.id)).toEqual(["REQ-AUTH-001"]);
    expect(s.snapshot.scenarios.map((sc: any) => sc.id)).toEqual(["SCEN-LOGIN-001"]);
    expect(s.snapshot.visual_contracts.map((v: any) => v.id)).toEqual(["VIS-DASH-001"]);
  });

  test("CLI fills spec_version when input omits it (= current+1)", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const input = await writeInput(dir, baseHeader()); // no spec_version field
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      input,
      "--feature",
      feature,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(r.exit).toBe(0);
    const s = await loadSnapshot(dir);
    expect(s.snapshot.state?.spec_version).toBe(1);
  });

  test("input.spec_version=2 when current=0 → SPEC_VERSION_NOT_MONOTONIC (must equal current+1)", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const input = await writeInput(dir, baseHeader({ spec_version: 2 }));
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      input,
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).not.toBe(0);
    // Slice E promotion: SPEC_VERSION_NOT_MONOTONIC surfaces directly
    // (was wrapped as INVALID_PAYLOAD by reducer pre-promotion).
    expect(r.stderr).toMatch(/SPEC_VERSION_NOT_MONOTONIC/);
  });

  test("JSON output emits {ok, feature, spec_version, req_ids, scen_ids, vis_ids}", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const input = await writeInput(
      dir,
      baseHeader({
        requirements: [VALID_REQ],
        scenarios: [VALID_SCEN],
      }),
    );
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      input,
      "--feature",
      feature,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      ok: true,
      feature,
      spec_version: 1,
      req_ids: ["REQ-AUTH-001"],
      scen_ids: ["SCEN-LOGIN-001"],
    });
  });
});

describe("loaf spec submit — DUPLICATE_*_ID preflight promotion (SC1)", () => {
  test("two REQ-AUTH-001 in same submit batch → DUPLICATE_REQ_ID preflight; journal unchanged", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const before = await readJournalLines(dir);
    const input = await writeInput(
      dir,
      baseHeader({
        requirements: [VALID_REQ, { ...VALID_REQ }], // same id twice
      }),
    );
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      input,
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/DUPLICATE_REQ_ID/);
    expect(r.stderr).toMatch(/REQ-AUTH-001/);
    expect(await readJournalLines(dir)).toEqual(before);
  });

  test("raw spec_req_added duplicate against projection → DUPLICATE_REQ_ID (preflight, not REDUCER_ERROR)", async () => {
    // Duplicate-against-projection without a fresh spec_submitted reset
    // can only be triggered via raw mutate in SC1 (no add-* CLI yet —
    // that lands in SC2). A second `spec submit` would reset
    // requirements=[] via the reducer's whole-replacement semantics, so
    // re-adding the same id in a new submit is by-design allowed. The
    // preflight DUPLICATE_REQ_ID check fires when raw / future add-* re-emits
    // spec_req_added without a reset between.
    const { dir, feature } = await seedAtSpecProposal();
    await runCli([
      "spec",
      "submit",
      "--input",
      await writeInput(
        dir,
        baseHeader({
          requirements: [VALID_REQ],
        }),
      ),
      "--feature",
      feature,
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    // Raw mutate: emit a second spec_req_added with the same id, sharing
    // the existing spec_version=1 (would be a standalone add-req
    // invocation pattern in SC2).
    const s = await loadSnapshot(dir);
    const r = await mutate(
      {
        at: new Date().toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:spec_req_added",
        payload: { spec_version: 1, req: { ...VALID_REQ } },
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
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("DUPLICATE_REQ_ID");
      expect((r.detail as { id?: string } | undefined)?.id).toBe("REQ-AUTH-001");
    }
    // Feature dir + feature unused after this point but referenced for
    // helper clarity.
    expect(feature).toBe("F1");
  });

  test("two SCEN-LOGIN-001 → DUPLICATE_SCEN_ID", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const input = await writeInput(
      dir,
      baseHeader({
        scenarios: [VALID_SCEN, { ...VALID_SCEN }],
      }),
    );
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      input,
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/DUPLICATE_SCEN_ID/);
  });

  test("two VIS-DASH-001 → DUPLICATE_VIS_ID", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const input = await writeInput(
      dir,
      baseHeader({
        visual_contracts: [VALID_VIS, { ...VALID_VIS }],
      }),
    );
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      input,
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/DUPLICATE_VIS_ID/);
  });

  test("DUPLICATE_REQ_ID fires as preflight code (not wrapped as REDUCER_ERROR)", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const input = await writeInput(
      dir,
      baseHeader({
        requirements: [VALID_REQ, { ...VALID_REQ }],
      }),
    );
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      input,
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/DUPLICATE_REQ_ID/);
    // Top-level code surface (not REDUCER_ERROR — preflight promotion intent).
    expect(r.stderr).not.toMatch(/REDUCER_ERROR/);
  });
});

describe("loaf spec submit — input + sub_state boundary", () => {
  test("--input file missing → INPUT_FILE_NOT_FOUND, journal unchanged", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const before = await readJournalLines(dir);
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      path.join(dir, "missing.json"),
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INPUT_FILE_NOT_FOUND/);
    expect(await readJournalLines(dir)).toEqual(before);
  });

  test("--input invalid JSON → SCHEMA_VALIDATION_FAILED", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const p = path.join(dir, "bad.json");
    await fs.writeFile(p, "{not json");
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      p,
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SCHEMA_VALIDATION_FAILED/);
  });

  test("submit at TRIAGE.score → SUB_STATE_AUTHORITY_VIOLATION", async () => {
    const dir = await tmpFeatureDir();
    const feature = "F1";
    await runCli([
      "start",
      feature,
      "--ceremony",
      "standard",
      "--feature-dir",
      dir,
      "--format",
      "json",
    ]);
    const input = await writeInput(dir, baseHeader());
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      input,
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SUB_STATE_AUTHORITY_VIOLATION/);
  });

  test("--input spec_version is a string (codex r75 BLOCK repro) → SCHEMA_VALIDATION_FAILED, journal unchanged", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const before = await readJournalLines(dir);
    const input = await writeInput(dir, { ...baseHeader(), spec_version: "2" });
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      input,
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SCHEMA_VALIDATION_FAILED/);
    expect(await readJournalLines(dir)).toEqual(before);
  });

  test("--input requirements is a string → SCHEMA_VALIDATION_FAILED (must be array)", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const before = await readJournalLines(dir);
    const input = await writeInput(dir, { ...baseHeader(), requirements: "oops" });
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      input,
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SCHEMA_VALIDATION_FAILED/);
    expect(await readJournalLines(dir)).toEqual(before);
  });

  test("--input scenarios is an object → SCHEMA_VALIDATION_FAILED", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const input = await writeInput(dir, { ...baseHeader(), scenarios: {} });
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      input,
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SCHEMA_VALIDATION_FAILED/);
  });

  test("--input visual_contracts is a string → SCHEMA_VALIDATION_FAILED", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const input = await writeInput(dir, { ...baseHeader(), visual_contracts: "oops" });
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      input,
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SCHEMA_VALIDATION_FAILED/);
  });

  test("submit batch atomicity — invalid REQ payload mid-batch → all-or-nothing (CLI boundary catch)", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const before = await readJournalLines(dir);
    // Second REQ has no verifiability (missing measurable / scenarios /
    // acceptance_na) → RequirementEarsVerifiable refine fails. Codex r75
    // BLOCK fix routes this through SpecSubmitInput at the CLI boundary
    // (SCHEMA_VALIDATION_FAILED), strictly earlier than mutateBatch.
    // Atomicity proof still holds — no entries appended.
    const input = await writeInput(
      dir,
      baseHeader({
        requirements: [
          VALID_REQ,
          {
            id: "REQ-AUTH-002",
            type: "ubiquitous",
            response: "the system shall do something else here",
            // no acceptance_na, no measurable, no scenarios → fails verifiability
          },
        ],
      }),
    );
    const r = await runCli([
      "spec",
      "submit",
      "--input",
      input,
      "--feature",
      feature,
      "--feature-dir",
      dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SCHEMA_VALIDATION_FAILED/);
    // Atomicity: no entries appended.
    expect(await readJournalLines(dir)).toEqual(before);
  });
});
