// Slice 3 SC2 — `loaf evidence add` minimal --input surface.
// RED first: every new-behavior assertion below fails on pre-SC2 main
// (no `loaf evidence` command tree; EV-id allocator + USAGE guards absent).
//
// Scope per codex r62 → r64 → r65 → r66 sign-off (thread review/cli-lifecycle-plan):
//   - Single-entry --input only; array input -> USAGE deterministic reject.
//   - Caller-supplied `id` -> USAGE exit 2, NO journal-change.
//   - Source schema is enforced via CLI boundary guards (no `id` in
//     input + reject arrays) + reuse of EvidenceFullPayload at
//     mutate() / preflight — no separate Omit schema in this slice.
//     EvidenceFullPayload already enforces manual/waiver actor=human:*
//     + reason ≥10, visual-review attachments ≥1 (per docs §5.4 +
//     §16:1695-1700).
//   - Attachments are PRE-HASHED passthrough only: input attachments must
//     match runtime AttachmentPayload {path, sha256(64 lowercase hex),
//     mime, bytes?}. CLI does NOT stat / hash / copy / verify files in
//     this slice — file existence + canonical path bucketing land in SC2b
//     (protocol rev 4.3 / ADR-0004 A6 auto-hash workflow).
//   - No `--external-ref` flag; `external_ref` allowed only via --input
//     (passthrough in EvidenceFullPayload).
//   - EV-id allocator: scan snapshot.evidence[] for canonical `^EV-\d+$`,
//     take max numeric part, +1, zero-pad to ≥6 digits.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import { mutate } from "../../src/core/journal-mutate.js";
import type { SubState } from "../../src/core/journal-entry.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-evidence-test-"));
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

/**
 * Walk a quick-ceremony session through to EXECUTE.work via raw mutate.
 * Quick path is the shortest sub_state walk where evidence:added is legal:
 *   TRIAGE.score → TRIAGE.confirm → EXECUTE.plan → EXECUTE.work
 * spec_phase=false enables the TRIAGE.confirm → EXECUTE.plan fork.
 */
async function seedQuickAtExecuteWork(): Promise<{ dir: string; feature: string }> {
  const dir = await tmpFeatureDir();
  const feature = "F1";
  const startRes = await runCli([
    "start", feature, "--ceremony", "quick",
    "--feature-dir", dir, "--json",
  ]);
  if (startRes.exit !== 0) throw new Error(`start failed: ${startRes.stderr}`);
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
      { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, fsync: false },
    );
    if (!r.ok) throw new Error(`seed walk ${from}→${to} failed: ${r.code} ${r.message}`);
  }
  return { dir, feature };
}

/**
 * Build a minimal valid EvidenceFullPayload-minus-id object for a given
 * kind. Tests override fields per scenario via spread.
 */
function baseInput(kind = "local-check"): Record<string, unknown> {
  return {
    kind,
    iteration: 1,
    actor: "cli:loaf",
    result: "passed",
    summary: "stub evidence summary",
  };
}

async function writeInput(dir: string, payload: unknown): Promise<string> {
  const p = path.join(dir, "evidence-input.json");
  await fs.writeFile(p, JSON.stringify(payload));
  return p;
}

describe("loaf evidence add — SC2 happy paths", () => {
  test("add local-check at EXECUTE.work emits evidence:added; stdout = bare EV-000001", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const input = await writeInput(dir, baseInput("local-check"));
    const r = await runCli([
      "evidence", "add", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(0);
    expect(r.stdout.trim()).toBe("EV-000001");

    const s = await loadSnapshot(dir);
    expect(s.snapshot.evidence).toHaveLength(1);
    expect(s.snapshot.evidence[0]).toMatchObject({
      id: "EV-000001",
      kind: "local-check",
      result: "passed",
      actor: "cli:loaf",
    });
  });

  test("JSON mode emits {ok, feature, id, kind}", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const input = await writeInput(dir, baseInput("task-summary"));
    const r = await runCli([
      "evidence", "add", "--input", input,
      "--feature", feature, "--feature-dir", dir, "--json",
    ]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toEqual({
      ok: true,
      feature,
      id: "EV-000001",
      kind: "task-summary",
    });
  });

  test("allocator monotonic: two adds → EV-000001, EV-000002", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const input1 = await writeInput(dir, baseInput("local-check"));
    const r1 = await runCli([
      "evidence", "add", "--input", input1,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r1.stdout.trim()).toBe("EV-000001");

    // Need a fresh input file because we'll rewrite — but content is same.
    const input2 = await writeInput(dir, baseInput("local-check"));
    const r2 = await runCli([
      "evidence", "add", "--input", input2,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r2.stdout.trim()).toBe("EV-000002");
  });

  test("visual-review with pre-hashed attachment succeeds", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const input = await writeInput(dir, {
      ...baseInput("visual-review"),
      attachments: [
        {
          path: "screenshots/login.png",
          sha256: "a".repeat(64),
          mime: "image/png",
          bytes: 1024,
        },
      ],
    });
    const r = await runCli([
      "evidence", "add", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(0);
    expect(r.stdout.trim()).toBe("EV-000001");

    const s = await loadSnapshot(dir);
    expect(s.snapshot.evidence[0].attachments).toHaveLength(1);
    expect(s.snapshot.evidence[0].attachments[0]).toMatchObject({
      path: "screenshots/login.png",
      sha256: "a".repeat(64),
      mime: "image/png",
    });
  });

  test("manual evidence with human:* actor + reason ≥10 succeeds", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const input = await writeInput(dir, {
      ...baseInput("manual"),
      actor: "human:reviewer@test.invalid",
      result: "passed",
      reason: "reviewed manually per QA checklist",
    });
    const r = await runCli([
      "evidence", "add", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(0);
  });
});

describe("loaf evidence add — SC2 schema refines (EvidenceFullPayload)", () => {
  test("manual without reason → INVALID_PAYLOAD (refine: reason ≥10)", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const input = await writeInput(dir, {
      ...baseInput("manual"),
      actor: "human:reviewer@test.invalid",
      // reason omitted
    });
    const r = await runCli([
      "evidence", "add", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INVALID_PAYLOAD/);
  });

  test("manual with cli:* actor → INVALID_PAYLOAD (refine: actor must be human:*)", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const input = await writeInput(dir, {
      ...baseInput("manual"),
      actor: "cli:loaf",
      reason: "this reason is long enough to pass",
    });
    const r = await runCli([
      "evidence", "add", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INVALID_PAYLOAD/);
  });

  test("waiver with cli:* actor → INVALID_PAYLOAD", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const input = await writeInput(dir, {
      ...baseInput("waiver"),
      actor: "cli:loaf",
      result: "waived",
      reason: "waiver reason text long enough",
    });
    const r = await runCli([
      "evidence", "add", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INVALID_PAYLOAD/);
  });

  test("visual-review without attachments → INVALID_PAYLOAD (refine: ≥1 attachment)", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const input = await writeInput(dir, baseInput("visual-review"));
    const r = await runCli([
      "evidence", "add", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INVALID_PAYLOAD/);
  });

  test("attachment with non-hex sha256 → INVALID_PAYLOAD", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const input = await writeInput(dir, {
      ...baseInput("visual-review"),
      attachments: [
        { path: "x.png", sha256: "NOT-HEX-SHA", mime: "image/png" },
      ],
    });
    const r = await runCli([
      "evidence", "add", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INVALID_PAYLOAD/);
  });
});

describe("loaf evidence add — SC2 input boundary guards", () => {
  test("missing --input file → INPUT_FILE_NOT_FOUND, no journal change", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const before = await readJournalLines(dir);
    const r = await runCli([
      "evidence", "add", "--input", path.join(dir, "does-not-exist.json"),
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INPUT_FILE_NOT_FOUND/);
    const after = await readJournalLines(dir);
    expect(after).toEqual(before);
  });

  test("invalid JSON input → SCHEMA_VALIDATION_FAILED", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const p = path.join(dir, "bad.json");
    await fs.writeFile(p, "{not valid json");
    const r = await runCli([
      "evidence", "add", "--input", p,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SCHEMA_VALIDATION_FAILED/);
  });

  test("input includes id → USAGE exit 2, journal unchanged (codex r66 Q2)", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const before = await readJournalLines(dir);
    const input = await writeInput(dir, { ...baseInput("local-check"), id: "EV-999999" });
    const r = await runCli([
      "evidence", "add", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/USAGE/);
    expect(r.stderr).toMatch(/id/i);
    const after = await readJournalLines(dir);
    expect(after).toEqual(before);
  });

  test("input is JSON array → USAGE exit 2, journal unchanged (codex r66 Q4)", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const before = await readJournalLines(dir);
    const input = await writeInput(dir, [baseInput("local-check")]);
    const r = await runCli([
      "evidence", "add", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/USAGE/);
    const after = await readJournalLines(dir);
    expect(after).toEqual(before);
  });

  test("--input missing required field (no `kind`) → INVALID_PAYLOAD", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    const { kind: _kind, ...without } = baseInput("local-check") as any;
    const input = await writeInput(dir, without);
    const r = await runCli([
      "evidence", "add", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INVALID_PAYLOAD/);
  });
});

describe("loaf evidence add — SC2 sub_state authority", () => {
  test("add at TRIAGE.score → SUB_STATE_AUTHORITY_VIOLATION", async () => {
    const dir = await tmpFeatureDir();
    const feature = "F1";
    await runCli([
      "start", feature, "--ceremony", "quick",
      "--feature-dir", dir, "--json",
    ]);
    const input = await writeInput(dir, baseInput("local-check"));
    const r = await runCli([
      "evidence", "add", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/SUB_STATE_AUTHORITY_VIOLATION/);
  });

  test("add at EXECUTE.plan (legal) succeeds", async () => {
    const dir = await tmpFeatureDir();
    const feature = "F1";
    await runCli([
      "start", feature, "--ceremony", "quick",
      "--feature-dir", dir, "--json",
    ]);
    for (const [from, to] of [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "EXECUTE.plan"],
    ] as Array<[SubState, SubState]>) {
      const s = await loadSnapshot(dir);
      const m = await mutate(
        {
          at: new Date().toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from, to },
        },
        { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, fsync: false },
      );
      if (!m.ok) throw new Error(`walk failed: ${m.message}`);
    }
    const input = await writeInput(dir, baseInput("local-check"));
    const r = await runCli([
      "evidence", "add", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(0);
  });
});

describe("loaf evidence add — SC2 EV-id allocator edge cases", () => {
  test("allocator picks max-serial+1 over existing canonical ids", async () => {
    const { dir, feature } = await seedQuickAtExecuteWork();
    // Seed three EV-NNNNNN journal entries via raw mutate, in non-monotonic
    // allocation order to confirm allocator scans for max, not count.
    for (const id of ["EV-000001", "EV-000005", "EV-000003"]) {
      const s = await loadSnapshot(dir);
      const r = await mutate(
        {
          at: new Date().toISOString(),
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "evidence:added",
          payload: { ...baseInput("local-check"), id },
        },
        { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, fsync: false },
      );
      if (!r.ok) throw new Error(`seed failed: ${r.code} ${r.message}`);
    }
    const input = await writeInput(dir, baseInput("local-check"));
    const r = await runCli([
      "evidence", "add", "--input", input,
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(0);
    // Max existing serial is 5 → next is 6.
    expect(r.stdout.trim()).toBe("EV-000006");
  });
});
