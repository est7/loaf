// Slice 4 SC2 — `loaf spec add-req` / `loaf spec add-scenario` /
// `loaf spec add-visual` + per-namespace id allocator + batch support
// (rev 4.3 ADR-0004 A4 + A5).
//
// RED first: every new-behavior assertion below fails on pre-SC2 main
// (no `loaf spec add-*` command tree; no id_namespace allocator).
//
// Scope per codex r74 sign-off:
//   - Three commands, each takes `--input <file>` (single object or array).
//   - Input shape: SpecAdd*Input — `id_namespace` instead of full `id`.
//     Namespace regex: REQ-[A-Z][A-Z0-9]* / SCEN-[A-Z][A-Z0-9-]* /
//     VIS-[A-Z][A-Z0-9-]*. CLI stamps full id `^<NS>-\d{3,}$`
//     (zero-pad ≥3, max-serial+1 per namespace).
//   - spec_version += 1 once per CLI invocation (CLI fills; caller
//     never supplies). Reducer enforces monotonic via existing
//     SPEC_VERSION_NOT_MONOTONIC check.
//   - Batch input (array of items in one invocation) emits one
//     mutateBatch with N entries sharing one spec_version. Allocator
//     advances the counter across batch entries within the invocation.
//   - DUPLICATE_REQ_ID / DUPLICATE_SCEN_ID / DUPLICATE_VIS_ID reuse the
//     SC1 preflight refine block (5h) — if caller picks a namespace
//     that already exists, the allocator skips past existing ids.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import { mutate } from "../../src/core/journal-mutate.js";
import type { SubState } from "../../src/core/journal-entry.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-spec-add-"));
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

async function writeInput(dir: string, payload: unknown, name = "spec-add-input.json"): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, JSON.stringify(payload));
  return p;
}

/**
 * Walk to SPEC.proposal then submit a minimal spec (header only) so the
 * session has spec_version=1 and is in SPEC.proposal post-submit. add-*
 * commands then bump from there.
 */
async function seedAtSpecPostSubmit(): Promise<{ dir: string; feature: string }> {
  const dir = await tmpFeatureDir();
  const feature = "F1";
  await runCli([
    "start", feature, "--ceremony", "standard",
    "--feature-dir", dir, "--format", "json",
  ]);
  for (const [from, to] of [
    ["TRIAGE.score", "TRIAGE.confirm"],
    ["TRIAGE.confirm", "SPEC.proposal"],
  ] as Array<[SubState, SubState]>) {
    const s = await loadSnapshot(dir);
    const r = await mutate(
      {
        at: new Date().toISOString(),
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from, to },
      },
      { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, entries: s.entries, meta: s.meta, fsync: false },
    );
    if (!r.ok) throw new Error(`walk ${from}→${to} failed: ${r.code} ${r.message}`);
  }
  // Run spec submit (SC1) to land spec_version=1; this also exercises the
  // SC1 path under SC2 tests, catching regression.
  const submitInput = await writeInput(dir, {
    feature: { id: "F-001", name: "SC2 add-* fixture" },
    intent: "exercise SC2 add-req/add-scenario/add-visual allocator",
    adr_refs: [],
    needs_clarification: [],
  }, "submit.json");
  const submit = await runCli([
    "spec", "submit", "--input", submitInput,
    "--feature", feature, "--feature-dir", dir, "--format", "json",
  ]);
  if (submit.exit !== 0) throw new Error(`seed submit fail: ${submit.stderr}`);
  return { dir, feature };
}

// Verifiability shortcut to keep REQ bodies in this test passing
// RequirementEarsVerifiable.refine at journal append.
const REQ_VERIFIABLE_TAIL = {
  acceptance_na: true,
  acceptance_na_reason: "subjective UX validated via manual testing scope",
};

const SCEN_VERIFIABLE_TAIL = {
  given: ["user is logged out"],
  when: ["user submits valid credentials"],
  then: ["session token issued"],
  acceptance_na: "covered by manual exploration in fixture",
};

describe("loaf spec add-req — SC2", () => {
  test("happy: single add-req → REQ-AUTH-001, spec_version bumps to 2", async () => {
    const { dir, feature } = await seedAtSpecPostSubmit();
    const input = await writeInput(dir, {
      id_namespace: "REQ-AUTH",
      type: "ubiquitous",
      response: "the system shall authenticate users with X",
      ...REQ_VERIFIABLE_TAIL,
    });
    const r = await runCli([
      "spec", "add-req", "--input", input,
      "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      ok: true,
      feature,
      spec_version: 2,
      ids: ["REQ-AUTH-001"],
    });
    const s = await loadSnapshot(dir);
    expect(s.snapshot.requirements.map((r: any) => r.id)).toEqual(["REQ-AUTH-001"]);
    expect(s.snapshot.state?.spec_version).toBe(2);
  });

  test("allocator monotonic: two add-req invocations same namespace → REQ-AUTH-001 then REQ-AUTH-002", async () => {
    const { dir, feature } = await seedAtSpecPostSubmit();
    const item = {
      id_namespace: "REQ-AUTH",
      type: "ubiquitous",
      response: "the system shall do thing one",
      ...REQ_VERIFIABLE_TAIL,
    };
    const r1 = await runCli([
      "spec", "add-req", "--input", await writeInput(dir, item, "r1.json"),
      "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    expect(JSON.parse(r1.stdout).ids).toEqual(["REQ-AUTH-001"]);
    const r2 = await runCli([
      "spec", "add-req", "--input", await writeInput(dir, {
        ...item, response: "the system shall do thing two",
      }, "r2.json"),
      "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    expect(JSON.parse(r2.stdout)).toMatchObject({
      spec_version: 3,
      ids: ["REQ-AUTH-002"],
    });
    const s = await loadSnapshot(dir);
    expect(s.snapshot.requirements.map((r: any) => r.id)).toEqual(["REQ-AUTH-001", "REQ-AUTH-002"]);
  });

  test("different namespaces have independent counters: REQ-AUTH-001 + REQ-USER-001 coexist", async () => {
    const { dir, feature } = await seedAtSpecPostSubmit();
    await runCli([
      "spec", "add-req", "--input", await writeInput(dir, {
        id_namespace: "REQ-AUTH",
        type: "ubiquitous",
        response: "the system shall authenticate",
        ...REQ_VERIFIABLE_TAIL,
      }, "auth.json"),
      "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    const r = await runCli([
      "spec", "add-req", "--input", await writeInput(dir, {
        id_namespace: "REQ-USER",
        type: "ubiquitous",
        response: "the system shall manage user profiles",
        ...REQ_VERIFIABLE_TAIL,
      }, "user.json"),
      "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    expect(JSON.parse(r.stdout).ids).toEqual(["REQ-USER-001"]);
  });

  test("batch input (array of items) → N entries sharing one spec_version + batch_id", async () => {
    const { dir, feature } = await seedAtSpecPostSubmit();
    const input = await writeInput(dir, [
      {
        id_namespace: "REQ-AUTH",
        type: "ubiquitous",
        response: "the system shall authenticate",
        ...REQ_VERIFIABLE_TAIL,
      },
      {
        id_namespace: "REQ-AUTH",
        type: "ubiquitous",
        response: "the system shall log auth events",
        ...REQ_VERIFIABLE_TAIL,
      },
      {
        id_namespace: "REQ-USER",
        type: "ubiquitous",
        response: "the system shall let users edit profiles",
        ...REQ_VERIFIABLE_TAIL,
      },
    ]);
    const before = await readJournalLines(dir);
    const r = await runCli([
      "spec", "add-req", "--input", input,
      "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      ok: true,
      spec_version: 2,
      ids: ["REQ-AUTH-001", "REQ-AUTH-002", "REQ-USER-001"],
    });
    const after = await readJournalLines(dir);
    expect(after.length - before.length).toBe(3); // 3 spec_req_added entries
    const newEntries = after.slice(-3).map((l) => JSON.parse(l));
    // All share batch_id; all share spec_version.
    expect(new Set(newEntries.map((e) => e.batch_id)).size).toBe(1);
    expect(new Set(newEntries.map((e) => e.payload.spec_version)).size).toBe(1);
  });

  test("malformed id_namespace (has numeric suffix) → SCHEMA_VALIDATION_FAILED", async () => {
    const { dir, feature } = await seedAtSpecPostSubmit();
    const before = await readJournalLines(dir);
    const input = await writeInput(dir, {
      id_namespace: "REQ-AUTH-001", // suffix not allowed in input regex
      type: "ubiquitous",
      response: "should fail",
      ...REQ_VERIFIABLE_TAIL,
    });
    const r = await runCli([
      "spec", "add-req", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SCHEMA_VALIDATION_FAILED/);
    expect(await readJournalLines(dir)).toEqual(before);
  });

  test("missing id_namespace → SCHEMA_VALIDATION_FAILED", async () => {
    const { dir, feature } = await seedAtSpecPostSubmit();
    const input = await writeInput(dir, {
      // no id_namespace
      type: "ubiquitous",
      response: "should fail",
      ...REQ_VERIFIABLE_TAIL,
    });
    const r = await runCli([
      "spec", "add-req", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SCHEMA_VALIDATION_FAILED/);
  });

  test("caller-supplied `id` rejected → SCHEMA_VALIDATION_FAILED, journal unchanged (codex r76 BLOCK)", async () => {
    const { dir, feature } = await seedAtSpecPostSubmit();
    const before = await readJournalLines(dir);
    // Input carries both id_namespace AND full id — caller tries to
    // bypass per-namespace allocator. Refine rejects before allocation.
    const input = await writeInput(dir, {
      id_namespace: "REQ-AUTH",
      id: "REQ-USER-999", // bypass attempt
      type: "ubiquitous",
      response: "the system shall do something",
      ...REQ_VERIFIABLE_TAIL,
    });
    const r = await runCli([
      "spec", "add-req", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SCHEMA_VALIDATION_FAILED/);
    expect(await readJournalLines(dir)).toEqual(before);
  });

  test("--input file missing → INPUT_FILE_NOT_FOUND, journal unchanged", async () => {
    const { dir, feature } = await seedAtSpecPostSubmit();
    const before = await readJournalLines(dir);
    const r = await runCli([
      "spec", "add-req", "--input", path.join(dir, "missing.json"),
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INPUT_FILE_NOT_FOUND/);
    expect(await readJournalLines(dir)).toEqual(before);
  });
});

describe("loaf spec add-scenario — SC2", () => {
  test("happy: single add-scenario → SCEN-LOGIN-001", async () => {
    const { dir, feature } = await seedAtSpecPostSubmit();
    const input = await writeInput(dir, {
      id_namespace: "SCEN-LOGIN",
      name: "happy login",
      ...SCEN_VERIFIABLE_TAIL,
    });
    const r = await runCli([
      "spec", "add-scenario", "--input", input,
      "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: true,
      spec_version: 2,
      ids: ["SCEN-LOGIN-001"],
    });
    const s = await loadSnapshot(dir);
    expect(s.snapshot.scenarios.map((s: any) => s.id)).toEqual(["SCEN-LOGIN-001"]);
  });

  test("caller-supplied `id` on add-scenario rejected → SCHEMA_VALIDATION_FAILED", async () => {
    const { dir, feature } = await seedAtSpecPostSubmit();
    const before = await readJournalLines(dir);
    const input = await writeInput(dir, {
      id_namespace: "SCEN-LOGIN",
      id: "SCEN-HACK-999",
      name: "happy login",
      ...SCEN_VERIFIABLE_TAIL,
    });
    const r = await runCli([
      "spec", "add-scenario", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SCHEMA_VALIDATION_FAILED/);
    expect(await readJournalLines(dir)).toEqual(before);
  });

  test("malformed SCEN id_namespace → SCHEMA_VALIDATION_FAILED", async () => {
    const { dir, feature } = await seedAtSpecPostSubmit();
    const input = await writeInput(dir, {
      id_namespace: "REQ-LOGIN", // wrong prefix for scenario
      name: "happy login",
      ...SCEN_VERIFIABLE_TAIL,
    });
    const r = await runCli([
      "spec", "add-scenario", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SCHEMA_VALIDATION_FAILED/);
  });
});

describe("loaf spec add-visual — SC2", () => {
  test("happy: single add-visual → VIS-DASH-001", async () => {
    const { dir, feature } = await seedAtSpecPostSubmit();
    const input = await writeInput(dir, {
      id_namespace: "VIS-DASH",
      target: "dashboard main panel",
      checks: ["header text matches brand"],
      visual_na: "skipped per fixture (no visual review yet)",
    });
    const r = await runCli([
      "spec", "add-visual", "--input", input,
      "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: true,
      spec_version: 2,
      ids: ["VIS-DASH-001"],
    });
  });

  test("caller-supplied `id` on add-visual rejected → SCHEMA_VALIDATION_FAILED", async () => {
    const { dir, feature } = await seedAtSpecPostSubmit();
    const before = await readJournalLines(dir);
    const input = await writeInput(dir, {
      id_namespace: "VIS-DASH",
      id: "VIS-HACK-999",
      target: "dashboard main panel",
      checks: ["header text matches brand"],
      visual_na: "skipped per fixture (no visual review yet)",
    });
    const r = await runCli([
      "spec", "add-visual", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SCHEMA_VALIDATION_FAILED/);
    expect(await readJournalLines(dir)).toEqual(before);
  });

  test("allocator independent across kinds: REQ + SCEN + VIS all at 001", async () => {
    const { dir, feature } = await seedAtSpecPostSubmit();
    await runCli([
      "spec", "add-req", "--input", await writeInput(dir, {
        id_namespace: "REQ-AUTH",
        type: "ubiquitous",
        response: "the system shall authenticate",
        ...REQ_VERIFIABLE_TAIL,
      }, "r.json"),
      "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    await runCli([
      "spec", "add-scenario", "--input", await writeInput(dir, {
        id_namespace: "SCEN-LOGIN",
        name: "happy login",
        ...SCEN_VERIFIABLE_TAIL,
      }, "s.json"),
      "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    const r = await runCli([
      "spec", "add-visual", "--input", await writeInput(dir, {
        id_namespace: "VIS-DASH",
        target: "dashboard main panel",
        checks: ["header text matches brand"],
        visual_na: "skipped per fixture (no visual review yet)",
      }, "v.json"),
      "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    expect(JSON.parse(r.stdout).ids).toEqual(["VIS-DASH-001"]);
    const s = await loadSnapshot(dir);
    expect(s.snapshot.requirements[0]!.id).toBe("REQ-AUTH-001");
    expect(s.snapshot.scenarios[0]!.id).toBe("SCEN-LOGIN-001");
    expect(s.snapshot.visual_contracts[0]!.id).toBe("VIS-DASH-001");
  });
});
