// Slice 4 SC3 — SPEC_NOT_INITIALIZED + SPEC_LOCKED_NO_DIRECT_EDIT
// preflight refines (rev 4.3 ADR-0004 A4 / protocol §10.8 phase gating).
//
// RED first: every new-behavior assertion below fails on pre-SC3 main
// (no SPEC_NOT_INITIALIZED / SPEC_LOCKED_NO_DIRECT_EDIT preflight codes).
//
// Scope per codex r74 sign-off:
//   - SPEC_NOT_INITIALIZED: state.spec_version === 0 AND kind ∈
//     {spec_req_added, spec_scenario_added, spec_visual_added} → reject.
//     Catches "user runs spec add-* at SPEC.proposal without first
//     running spec submit". `event:spec_submitted` is the init step;
//     it bypasses this check (it's how state.spec_version becomes 1).
//   - SPEC_LOCKED_NO_DIRECT_EDIT: state.spec_locked === true AND kind
//     ∈ {spec_submitted, spec_req_added, spec_scenario_added,
//     spec_visual_added} → reject. Defense-in-depth post-lock guard.
//     In normal workflow, gate spec-lock approve advances cursor out
//     of ALL_SPEC, so PER_KIND_SUB_STATE catches it first. This refine
//     fires when a raw / back-edge path leaves spec_locked=true while
//     sub_state ∈ ALL_SPEC.
//   - SPEC_NOT_INITIALIZED keys on state.spec_version === 0 (codex r74:
//     "spec.md is a derived projection in rev 5.0; mutator truth is
//     journal/snapshot state, not file existence").

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import { mutate } from "../../src/core/journal-mutate.js";
import { apply, initialSnapshot, type Snapshot } from "../../src/core/reducer.js";
import type { SubState } from "../../src/core/journal-entry.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-spec-preflight-"));
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

async function writeInput(dir: string, payload: unknown, name = "input.json"): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, JSON.stringify(payload));
  return p;
}

// Walk to SPEC.proposal under standard ceremony — pre-submit (so
// state.spec_version stays 0).
async function seedAtSpecProposalNoSubmit(): Promise<{ dir: string; feature: string }> {
  const dir = await tmpFeatureDir();
  const feature = "F1";
  await runCli([
    "start", feature, "--ceremony", "standard",
    "--feature-dir", dir, "--json",
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
      { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, fsync: false },
    );
    if (!r.ok) throw new Error(`walk ${from}→${to} failed: ${r.code} ${r.message}`);
  }
  return { dir, feature };
}

describe("SPEC_NOT_INITIALIZED — state.spec_version === 0 blocks spec_*_added", () => {
  test("spec add-req at SPEC.proposal pre-submit → SPEC_NOT_INITIALIZED, journal unchanged", async () => {
    const { dir, feature } = await seedAtSpecProposalNoSubmit();
    const before = await readJournalLines(dir);
    const input = await writeInput(dir, {
      id_namespace: "REQ-AUTH",
      type: "ubiquitous",
      response: "the system shall authenticate users",
      acceptance_na: true,
      acceptance_na_reason: "subjective UX validated via manual testing scope",
    });
    const r = await runCli([
      "spec", "add-req", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/SPEC_NOT_INITIALIZED/);
    expect(r.stderr).toMatch(/spec submit/i);
    expect(await readJournalLines(dir)).toEqual(before);
  });

  test("spec add-scenario pre-submit → SPEC_NOT_INITIALIZED", async () => {
    const { dir, feature } = await seedAtSpecProposalNoSubmit();
    const input = await writeInput(dir, {
      id_namespace: "SCEN-LOGIN",
      name: "happy login",
      given: ["user is logged out"],
      when: ["user submits credentials"],
      then: ["session token issued"],
      acceptance_na: "covered by manual exploration",
    });
    const r = await runCli([
      "spec", "add-scenario", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/SPEC_NOT_INITIALIZED/);
  });

  test("spec add-visual pre-submit → SPEC_NOT_INITIALIZED", async () => {
    const { dir, feature } = await seedAtSpecProposalNoSubmit();
    const input = await writeInput(dir, {
      id_namespace: "VIS-DASH",
      target: "dashboard main panel",
      checks: ["header text matches brand"],
      visual_na: "skipped per fixture (no visual review yet)",
    });
    const r = await runCli([
      "spec", "add-visual", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/SPEC_NOT_INITIALIZED/);
  });

  test("spec submit at SPEC.proposal pre-submit → succeeds (submit IS the init)", async () => {
    const { dir, feature } = await seedAtSpecProposalNoSubmit();
    const input = await writeInput(dir, {
      feature: { id: "F-001", name: "SC3 fixture" },
      intent: "exercise SC3 preflight: submit bypasses SPEC_NOT_INITIALIZED",
      adr_refs: [],
      needs_clarification: [],
    });
    const r = await runCli([
      "spec", "submit", "--input", input,
      "--feature", feature, "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(0);
    const s = await loadSnapshot(dir);
    expect(s.snapshot.state?.spec_version).toBe(1);
  });

  test("after submit, spec add-* succeeds → SPEC_NOT_INITIALIZED only blocks pre-submit", async () => {
    const { dir, feature } = await seedAtSpecProposalNoSubmit();
    // Submit first to bump spec_version to 1.
    await runCli([
      "spec", "submit", "--input", await writeInput(dir, {
        feature: { id: "F-001", name: "SC3 fixture" },
        intent: "exercise SC3 preflight: submit allows subsequent add-*",
        adr_refs: [],
        needs_clarification: [],
      }, "submit.json"),
      "--feature", feature, "--feature-dir", dir, "--json",
    ]);
    // Now add-req should pass (spec_version=1, SPEC_NOT_INITIALIZED doesn't fire).
    const r = await runCli([
      "spec", "add-req", "--input", await writeInput(dir, {
        id_namespace: "REQ-AUTH",
        type: "ubiquitous",
        response: "the system shall authenticate",
        acceptance_na: true,
        acceptance_na_reason: "subjective UX validated via manual testing scope",
      }, "add.json"),
      "--feature", feature, "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(0);
  });
});

describe("SPEC_LOCKED_NO_DIRECT_EDIT — state.spec_locked === true blocks SPEC content", () => {
  // SPEC_LOCKED_NO_DIRECT_EDIT requires an unnatural state (spec_locked=true
  // AND sub_state ∈ ALL_SPEC) since the normal post-lock workflow
  // immediately advances cursor out of ALL_SPEC. Test via apply()-direct
  // reducer-level path with constructed snapshot, mirroring the
  // tests/core/preflight-validation.test.ts pattern.

  function mustApply(prev: Snapshot, seq: number, entry: any): Snapshot {
    const r = apply(prev, {
      seq,
      entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
      at: "2026-05-15T10:00:00.000Z",
      entry_schema_version: 1,
      ...entry,
    });
    if (!r.ok) throw new Error(`mustApply: ${r.code} ${r.message}`);
    return r.snapshot;
  }

  function constructLockedAtSpecSpec(): Snapshot {
    let snap = initialSnapshot();
    let seq = 0;
    snap = mustApply(snap, seq++, {
      actor: "cli:loaf",
      kind: "session:started",
      payload: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "F1",
        ceremony: {
          spec_phase: true,
          verify_phase: true,
          settle_phase: false,
          strict_spec_review: false,
          lessons_required: "skip",
          strict_drift_check: false,
        },
      },
    });
    for (const [from, to] of [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "SPEC.proposal"],
      ["SPEC.proposal", "SPEC.spec"],
    ] as Array<[SubState, SubState]>) {
      snap = mustApply(snap, seq++, {
        actor: "cli:loaf",
        kind: "event:phase_advanced",
        payload: { from, to },
      });
    }
    // Force spec_locked=true by mutating state directly. This is artificial
    // (production cannot reach this combination: gate:decided spec-lock
    // approve sets spec_locked=true AND advances cursor out of ALL_SPEC).
    // The defensive preflight refine should still fire against raw mutate
    // / hand-edited journal that breaks the invariant.
    return { ...snap, state: { ...snap.state!, spec_locked: true } };
  }

  test("spec_req_added with spec_locked=true (constructed) → SPEC_LOCKED_NO_DIRECT_EDIT", () => {
    const snap = constructLockedAtSpecSpec();
    // Use apply() direct — it calls preflight internally. Preflight sees
    // ctx.snapshot.state.spec_locked === true and rejects the kind.
    const r = apply(snap, {
      seq: 100,
      entry_id: "JE-000100",
      at: "2026-05-15T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "event:spec_req_added",
      payload: {
        spec_version: 1,
        req: {
          id: "REQ-AUTH-001",
          type: "ubiquitous",
          response: "the system shall authenticate users",
          acceptance_na: true,
          acceptance_na_reason: "subjective UX validated via manual testing scope",
        },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("SPEC_LOCKED_NO_DIRECT_EDIT");
      expect(r.message).toMatch(/finding raise/);
    }
  });

  test("spec_submitted with spec_locked=true → SPEC_LOCKED_NO_DIRECT_EDIT", () => {
    const snap = constructLockedAtSpecSpec();
    const r = apply(snap, {
      seq: 100,
      entry_id: "JE-000100",
      at: "2026-05-15T10:00:00.000Z",
      actor: "human:test@invalid",
      entry_schema_version: 1,
      kind: "event:spec_submitted",
      payload: {
        spec_version: 2,
        feature: { id: "F-001", name: "Locked re-submit attempt" },
        intent: "this should be rejected because spec_locked=true blocks direct edits",
        adr_refs: [],
        needs_clarification: [],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("SPEC_LOCKED_NO_DIRECT_EDIT");
    }
  });
});
