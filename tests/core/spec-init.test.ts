// Slice 4 SC4 — `loaf spec init` scaffold + Slice 4 e2e walk
// (init → submit → add-* → SPEC.design). Gate decide spec-lock approve
// is intentionally outside the SC4 scope; the trim is explained in the
// e2e describe-block header.
//
// RED first: every new-behavior assertion below fails on pre-SC4 main
// (no `loaf spec init` sub-command; SPEC_ALREADY_INITIALIZED unused).
//
// Scope per codex r74 sign-off:
//   - `loaf spec init` writes a parser-valid minimal spec.md scaffold
//     (no tutorial / sample REQ — placeholders tend to leak into real
//     submits). Empty arrays for requirements / scenarios /
//     visual_contracts / needs_clarification. Pure I/O — no journal
//     entry, no state mutation.
//   - Optional flags: --feature-id / --feature-name / --intent for
//     deeper scaffold. Defaults supply valid-but-obvious-placeholder
//     content (intent ≥20 chars so the file passes SpecFrontmatter
//     parsing without being auto-acceptable for a real submit).
//   - SPEC_ALREADY_INITIALIZED USAGE exit 2 if spec.md already exists.
//     No --force flag in SC4 (codex r74: "A. No --force in Slice 4").
//   - Slice 4 e2e: spec init → submit → add-req → add-scenario →
//     add-visual → advance SPEC.spec → SPEC.plan → SPEC.design.
//     gate decide spec-lock --approve is deferred to the spec.md
//     projection writer + tasks_planned binding slice (codex r80
//     scope confirmation; e2e describe-block header has the long
//     rationale).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import { mutate } from "../../src/core/journal-mutate.js";
import type { SubState } from "../../src/core/journal-entry.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-spec-init-"));
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

async function writeInput(dir: string, payload: unknown, name = "input.json"): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, JSON.stringify(payload));
  return p;
}

async function seedAtSpecProposal(): Promise<{ dir: string; feature: string }> {
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
  return { dir, feature };
}

describe("loaf spec init — SC4 scaffold", () => {
  test("happy: init writes parser-valid spec.md; no journal entry", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const before = await readJournalLines(dir);
    const specMdPath = path.join(dir, "spec.md");
    await expect(fs.access(specMdPath)).rejects.toBeDefined(); // doesn't exist yet

    const r = await runCli([
      "spec", "init", "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(0);

    // spec.md now exists and parses as SpecFrontmatter.
    const md = await fs.readFile(specMdPath, "utf8");
    const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    // Cheap YAML-ish parse: deserialize via simple regex extraction of
    // top-level keys we care about. SpecFrontmatter validation lives in
    // the schema; here we just confirm the canonical shape is present.
    const yaml = fmMatch![1]!;
    expect(yaml).toMatch(/schema_version:\s*2/);
    expect(yaml).toMatch(/spec_version:\s*1/);
    expect(yaml).toMatch(/feature:/);
    expect(yaml).toMatch(/intent:/);
    expect(yaml).toMatch(/requirements:\s*\[\]/);
    expect(yaml).toMatch(/scenarios:\s*\[\]/);
    expect(yaml).toMatch(/needs_clarification:\s*\[\]/);

    // Journal unchanged — pure I/O.
    expect(await readJournalLines(dir)).toEqual(before);
  });

  test("init JSON mode emits {ok, feature, spec_md_path}", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const r = await runCli([
      "spec", "init", "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.feature).toBe(feature);
    expect(out.spec_md_path).toMatch(/spec\.md$/);
  });

  test("init refuses to overwrite existing spec.md → SPEC_ALREADY_INITIALIZED", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    // Run init once.
    await runCli([
      "spec", "init", "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    const firstContent = await fs.readFile(path.join(dir, "spec.md"), "utf8");

    // Run init again — must refuse.
    const r = await runCli([
      "spec", "init", "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/SPEC_ALREADY_INITIALIZED/);

    // Original content preserved (no overwrite).
    const secondContent = await fs.readFile(path.join(dir, "spec.md"), "utf8");
    expect(secondContent).toBe(firstContent);
  });

  test("init accepts --feature-id / --feature-name / --intent overrides (round-trip via readSpecFrontmatter)", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const r = await runCli([
      "spec", "init",
      "--feature", feature, "--feature-dir", dir,
      "--feature-id", "F-001",
      "--feature-name", "OAuth token refresh",
      "--intent", "users should not perceive auth recovery flows in flight",
      "--format", "json",
    ]);
    expect(r.exit).toBe(0);
    const { readSpecFrontmatter } = await import("../../src/core/spec-frontmatter.js");
    const result = await readSpecFrontmatter(dir);
    if (!result.ok) {
      throw new Error(`readSpecFrontmatter rejected init scaffold: ${result.code} ${result.message}`);
    }
    expect(result.frontmatter.feature.id).toBe("F-001");
    expect(result.frontmatter.feature.name).toBe("OAuth token refresh");
    expect(result.frontmatter.intent).toBe("users should not perceive auth recovery flows in flight");
  });

  test("init's spec.md is accepted by production readSpecFrontmatter() YAML reader (codex r80 BLOCK)", async () => {
    // The earlier zod test reconstructs the object via regex — that
    // bypasses the production YAML reader's quoting rules. This test
    // calls readSpecFrontmatter() directly on the written file so we
    // catch any scalar-with-colon issues at the production parse path.
    const { dir, feature } = await seedAtSpecProposal();
    await runCli([
      "spec", "init", "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    const { readSpecFrontmatter } = await import("../../src/core/spec-frontmatter.js");
    const result = await readSpecFrontmatter(dir);
    if (!result.ok) {
      throw new Error(`readSpecFrontmatter rejected init scaffold: ${result.code} ${result.message}`);
    }
    expect(result.frontmatter.spec_version).toBe(1);
    expect(result.frontmatter.feature.id).toBe("F-000");
    expect(result.frontmatter.requirements).toEqual([]);
  });

  // Earlier zod-parse-from-regex test removed: redundant with the
  // production readSpecFrontmatter() test above, which already uses
  // SpecFrontmatter for the strict validation step internally and
  // catches placeholder drift on the actual YAML the production parser
  // sees (codex r80 BLOCK was caught by exactly this path).

  test("init rejects invalid override combo (--feature-id BAD --feature-name x --intent short) → SCHEMA_VALIDATION_FAILED, no spec.md (codex r81 BLOCK)", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const specMdPath = path.join(dir, "spec.md");
    const r = await runCli([
      "spec", "init",
      "--feature", feature, "--feature-dir", dir,
      "--feature-id", "BAD",      // fails FeatureIdPayload regex
      "--feature-name", "x",      // fails min(3)
      "--intent", "short",        // fails min(20)
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/SCHEMA_VALIDATION_FAILED/);
    // No spec.md should have landed on disk.
    await expect(fs.access(specMdPath)).rejects.toBeDefined();
  });

  test("init partial-invalid (just --intent short) → SCHEMA_VALIDATION_FAILED, no spec.md", async () => {
    const { dir, feature } = await seedAtSpecProposal();
    const specMdPath = path.join(dir, "spec.md");
    const r = await runCli([
      "spec", "init",
      "--feature", feature, "--feature-dir", dir,
      "--intent", "too short",
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/SCHEMA_VALIDATION_FAILED/);
    await expect(fs.access(specMdPath)).rejects.toBeDefined();
  });
});

describe("Slice 4 e2e — init → submit → add-* → SPEC.design", () => {
  // Slice 4 e2e is scoped to the SPEC content CLI surface itself.
  // Carrying the workflow through `gate decide spec-lock --approve`
  // requires spec.md projection rebuild on each submit/add-* (so
  // evaluateSpecLock's frontmatter read matches the snapshot's REQ/
  // SCEN/VIS arrays) PLUS a task graph emitted by `event:tasks_planned`
  // that drives REQ-AUTH-001 to clear spec-lock check 4. Both
  // dependencies live outside the SPEC content kind set (spec.md
  // rebuild is a derived-projection writer; tasks_planned is Slice 2
  // territory). Codex r74's "e2e ... spec-lock approve" target is
  // tracked as a follow-up alongside the spec.md projection writer.
  test("full SPEC content workflow lands at SPEC.design with spec_version=4 + populated projections", async () => {
    const { dir, feature } = await seedAtSpecProposal();

    // 1. init — write spec.md scaffold
    const initRes = await runCli([
      "spec", "init",
      "--feature", feature, "--feature-dir", dir,
      "--feature-id", "F-001",
      "--feature-name", "OAuth token refresh e2e",
      "--intent", "users should not perceive auth recovery flows in flight",
      "--format", "json",
    ]);
    expect(initRes.exit).toBe(0);

    // 2. submit — initial spec_version=1 (CLI fills); no companions
    //    (we'll add them via add-* to exercise SC2 path)
    const submitRes = await runCli([
      "spec", "submit", "--input", await writeInput(dir, {
        feature: { id: "F-001", name: "OAuth token refresh e2e" },
        intent: "users should not perceive auth recovery flows in flight",
        adr_refs: [],
        needs_clarification: [],
      }, "submit.json"),
      "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    expect(submitRes.exit).toBe(0);
    expect(JSON.parse(submitRes.stdout).spec_version).toBe(1);

    // 3. add-req — REQ-AUTH-001; spec_version 1→2
    const reqRes = await runCli([
      "spec", "add-req", "--input", await writeInput(dir, {
        id_namespace: "REQ-AUTH",
        type: "ubiquitous",
        response: "the system shall refresh access tokens silently",
        acceptance_na: true,
        acceptance_na_reason: "subjective UX validated via manual testing scope",
      }, "req.json"),
      "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    expect(reqRes.exit).toBe(0);
    expect(JSON.parse(reqRes.stdout)).toMatchObject({
      spec_version: 2, ids: ["REQ-AUTH-001"],
    });

    // 4. add-scenario — SCEN-LOGIN-001; spec_version 2→3
    const scenRes = await runCli([
      "spec", "add-scenario", "--input", await writeInput(dir, {
        id_namespace: "SCEN-LOGIN",
        name: "happy refresh",
        given: ["user has an expired access token"],
        when: ["a protected request is made"],
        then: ["session continues without user prompt"],
        acceptance_na: "covered by manual exploration",
      }, "scen.json"),
      "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    expect(scenRes.exit).toBe(0);
    expect(JSON.parse(scenRes.stdout)).toMatchObject({
      spec_version: 3, ids: ["SCEN-LOGIN-001"],
    });

    // 5. add-visual — VIS-DASH-001; spec_version 3→4
    const visRes = await runCli([
      "spec", "add-visual", "--input", await writeInput(dir, {
        id_namespace: "VIS-DASH",
        target: "dashboard header",
        checks: ["no auth retry banner visible during refresh"],
        visual_na: "skipped per fixture (no visual review yet)",
      }, "vis.json"),
      "--feature", feature, "--feature-dir", dir, "--format", "json",
    ]);
    expect(visRes.exit).toBe(0);
    expect(JSON.parse(visRes.stdout)).toMatchObject({
      spec_version: 4, ids: ["VIS-DASH-001"],
    });

    // 6. advance through SPEC.* sub-states.
    for (const [from, to] of [
      ["SPEC.proposal", "SPEC.spec"],
      ["SPEC.spec", "SPEC.plan"],
      ["SPEC.plan", "SPEC.design"],
    ] as Array<[SubState, SubState]>) {
      const adv = await runCli([
        "advance", to,
        "--feature", feature, "--feature-dir", dir, "--format", "json",
      ]);
      expect(adv.exit).toBe(0);
      const out = JSON.parse(adv.stdout);
      expect(out).toMatchObject({ from, to });
    }

    // Final state assertions: spec_version=4, all projections populated,
    // sub_state=SPEC.design (ready for tasks_planned + spec-lock approve,
    // which sit outside SC4 scope per the describe block header comment).
    const final = await loadSnapshot(dir);
    expect(final.snapshot.state.spec_version).toBe(4);
    expect(final.snapshot.state.spec_locked).toBe(false);
    expect(final.snapshot.state.sub_state).toBe("SPEC.design");
    expect(final.snapshot.requirements.map((r: any) => r.id)).toEqual(["REQ-AUTH-001"]);
    expect(final.snapshot.scenarios.map((s: any) => s.id)).toEqual(["SCEN-LOGIN-001"]);
    expect(final.snapshot.visual_contracts.map((v: any) => v.id)).toEqual(["VIS-DASH-001"]);
  });
});
