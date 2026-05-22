// Slice 3 SC1 — pending CLI minimal FIFO surface + PENDING_BLOCKS_ADVANCE
// preflight. RED first: every assertion below fails on pre-SC1 main (no
// `loaf pending` command tree; advance has no pending-head check).
//
// Scope per codex r62/r63 sign-off (thread review/cli-lifecycle-plan):
//   - 4 CLI verbs: raise / list / status / resolve
//   - PENDING_BLOCKS_ADVANCE in stable-core preflight at event:phase_advanced
//   - GATE_NOT_PENDING / ESCALATION_NOT_PENDING + gate decide pending:resolved
//     co-emission DEFERRED to SC4.
//   - PendingState projection unchanged ({id, kind, resolved}); --question /
//     --options / --task-id round-trip via journal payload passthrough only.
//   - resolve is strict FIFO pop; no --id flag.
//   - --question is required for ALL kinds (Strict over Postel; codex r63 a).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import { mutate } from "../../src/core/journal-mutate.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-pending-test-"));
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

async function startFresh(): Promise<{ dir: string; feature: string }> {
  const dir = await tmpFeatureDir();
  const feature = "F1";
  const r = await runCli([
    "start", feature,
    "--ceremony", "quick",
    "--feature-dir", dir, "--json",
  ]);
  if (r.exit !== 0) throw new Error(`start failed: exit=${r.exit} stderr=${r.stderr}`);
  return { dir, feature };
}

async function loadSnapshot(
  dir: string,
): Promise<{ snapshot: any; tail_seq: number; entries: any; meta: any }> {
  const { loadSession } = await import("../../src/core/cli-runtime.js");
  return await loadSession(dir);
}

// Direct journal injection — used to seed a pending head before testing
// preflight's PENDING_BLOCKS_ADVANCE, since the CLI surface itself is
// under test in the same file.
async function injectPending(
  dir: string,
  id: string,
  kind: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const s = await loadSnapshot(dir);
  const r = await mutate(
    {
      at: new Date().toISOString(),
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "pending:added",
      payload: {
        id,
        kind,
        question: "seeded test pending (≥3 chars)",
        ...extra,
      },
    },
    { feature_dir: dir, snapshot: s.snapshot, tail_seq: s.tail_seq, entries: s.entries, meta: s.meta },
  );
  if (!r.ok) throw new Error(`injectPending failed: ${r.code} ${r.message}`);
}

describe("loaf pending — SC1 raise/list", () => {
  test("raise --kind ask_user_question emits pending:added; list shows it as head", async () => {
    const { dir, feature } = await startFresh();
    const raised = await runCli([
      "pending", "raise",
      "--kind", "ask_user_question",
      "--question", "Should we adopt approach X?",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(raised.exit).toBe(0);
    // codex review focus #1: stdout is bare PEND-id (scriptable)
    expect(raised.stdout.trim()).toBe("PEND-0001");

    const listed = await runCli([
      "pending", "list", "--json",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(listed.exit).toBe(0);
    const parsed = JSON.parse(listed.stdout) as {
      ok: boolean;
      feature: string;
      count: number;
      pending: Array<{ id: string; kind: string; resolved: boolean; head: boolean }>;
    };
    expect(parsed).toMatchObject({ ok: true, feature, count: 1 });
    expect(parsed.pending).toHaveLength(1);
    expect(parsed.pending[0]).toEqual({
      id: "PEND-0001",
      kind: "ask_user_question",
      resolved: false,
      head: true,
    });
  });

  test("raise twice → FIFO order preserved; only first is head", async () => {
    const { dir, feature } = await startFresh();
    const r1 = await runCli([
      "pending", "raise", "--kind", "ask_user_question",
      "--question", "Q1?", "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r1.stdout.trim()).toBe("PEND-0001");
    const r2 = await runCli([
      "pending", "raise", "--kind", "gate_decision",
      "--question", "Approve spec-lock?", "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r2.stdout.trim()).toBe("PEND-0002");

    const listed = await runCli([
      "pending", "list", "--json",
      "--feature", feature, "--feature-dir", dir,
    ]);
    const parsed = JSON.parse(listed.stdout);
    expect(parsed.pending.map((p: any) => p.id)).toEqual(["PEND-0001", "PEND-0002"]);
    expect(parsed.pending[0].head).toBe(true);
    expect(parsed.pending[1].head).toBe(false);
  });

  test("raise without --question rejected as USAGE (Strict over Postel; codex r63 a)", async () => {
    const { dir, feature } = await startFresh();
    const r = await runCli([
      "pending", "raise", "--kind", "ask_user_question",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    // commander's required-option failure or our USAGE diagnostic
    expect(r.stderr).toMatch(/question/i);
  });

  test("raise --question \"\" rejected (PendingAddedPayload.question min length; codex r64 fix 3)", async () => {
    const { dir, feature } = await startFresh();
    const r = await runCli([
      "pending", "raise", "--kind", "ask_user_question",
      "--question", "",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INVALID_PAYLOAD/);
  });

  test("raise --kind <typo> rejected (PendingPromptKind closed enum; codex r64 fix 1)", async () => {
    const { dir, feature } = await startFresh();
    // Hyphen variant of canonical gate_decision — must NOT slip past schema
    // because preflight's PENDING_BLOCKS_ADVANCE only matches the exact
    // enum value, so a typo would silently bypass the head-block invariant.
    const r = await runCli([
      "pending", "raise", "--kind", "gate-decision",
      "--question", "Approve spec-lock?",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/INVALID_PAYLOAD/);
  });

  test("list text mode shows 4 fixed columns: <PEND-id> <kind> <open|resolved> <head|->", async () => {
    const { dir, feature } = await startFresh();
    await runCli([
      "pending", "raise", "--kind", "ask_user_question",
      "--question", "stub question for test", "--feature", feature, "--feature-dir", dir,
    ]);
    await runCli([
      "pending", "raise", "--kind", "gate_decision",
      "--question", "stub gate question", "--feature", feature, "--feature-dir", dir,
    ]);

    const listed = await runCli([
      "pending", "list",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(listed.exit).toBe(0);
    const lines = listed.stdout.trim().split("\n");
    // Two rows, four whitespace-separated columns each. Head marker `*` is
    // a non-empty char in column 4 for the first row only.
    expect(lines).toHaveLength(2);
    const row1 = lines[0]!.split(/\s+/);
    const row2 = lines[1]!.split(/\s+/);
    expect(row1).toEqual(["PEND-0001", "ask_user_question", "open", "head"]);
    expect(row2).toEqual(["PEND-0002", "gate_decision", "open", "-"]);
  });
});

describe("loaf pending — SC1 resolve (strict FIFO)", () => {
  test("resolve --answer X marks head resolved; next entry promotes to head", async () => {
    const { dir, feature } = await startFresh();
    await runCli([
      "pending", "raise", "--kind", "ask_user_question",
      "--question", "Q1?", "--feature", feature, "--feature-dir", dir,
    ]);
    await runCli([
      "pending", "raise", "--kind", "gate_decision",
      "--question", "stub gate question", "--feature", feature, "--feature-dir", dir,
    ]);

    const resolved = await runCli([
      "pending", "resolve", "--answer", "yes",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(resolved.exit).toBe(0);

    // Codex r63: assert "first unresolved head promotes", NOT array removal.
    // Reducer keeps resolved history; head is the first unresolved entry.
    const s = await loadSnapshot(dir);
    expect(s.snapshot.pending).toHaveLength(2);
    expect(s.snapshot.pending[0]).toMatchObject({ id: "PEND-0001", resolved: true });
    expect(s.snapshot.pending[1]).toMatchObject({ id: "PEND-0002", resolved: false });

    // List reflects projection: PEND-0001 resolved, PEND-0002 new head.
    const listed = await runCli([
      "pending", "list", "--json",
      "--feature", feature, "--feature-dir", dir,
    ]);
    const parsed = JSON.parse(listed.stdout);
    expect(parsed.pending[0]).toMatchObject({ id: "PEND-0001", resolved: true, head: false });
    expect(parsed.pending[1]).toMatchObject({ id: "PEND-0002", resolved: false, head: true });
  });

  test("resolve --id PEND-N rejected as USAGE (FIFO strict; codex r63 RED #4)", async () => {
    const { dir, feature } = await startFresh();
    await runCli([
      "pending", "raise", "--kind", "ask_user_question",
      "--question", "stub question for test", "--feature", feature, "--feature-dir", dir,
    ]);
    const r = await runCli([
      "pending", "resolve", "--id", "PEND-0001", "--answer", "yes",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/--id|unknown option/i);
  });

  test("resolve on empty queue → PENDING_NOT_FOUND (codex r63 RED #7 replacement)", async () => {
    const { dir, feature } = await startFresh();
    const r = await runCli([
      "pending", "resolve", "--answer", "yes",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/PENDING_NOT_FOUND/);
  });
});

describe("loaf pending — SC1 status", () => {
  test("status default returns head projection", async () => {
    const { dir, feature } = await startFresh();
    await runCli([
      "pending", "raise", "--kind", "ask_user_question",
      "--question", "stub question for test", "--feature", feature, "--feature-dir", dir,
    ]);
    const r = await runCli([
      "pending", "status", "--json",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.pending).toMatchObject({
      id: "PEND-0001",
      kind: "ask_user_question",
      resolved: false,
      head: true,
    });
  });

  test("status --id PEND-N returns that specific entry", async () => {
    const { dir, feature } = await startFresh();
    await runCli([
      "pending", "raise", "--kind", "ask_user_question",
      "--question", "Q1?", "--feature", feature, "--feature-dir", dir,
    ]);
    await runCli([
      "pending", "raise", "--kind", "gate_decision",
      "--question", "stub gate question", "--feature", feature, "--feature-dir", dir,
    ]);
    const r = await runCli([
      "pending", "status", "--id", "PEND-0002", "--json",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.pending).toMatchObject({
      id: "PEND-0002",
      kind: "gate_decision",
      head: false,
    });
  });

  test("status --id miss → PENDING_NOT_FOUND (codex r63 d, reuse code)", async () => {
    const { dir, feature } = await startFresh();
    await runCli([
      "pending", "raise", "--kind", "ask_user_question",
      "--question", "stub question for test", "--feature", feature, "--feature-dir", dir,
    ]);
    const r = await runCli([
      "pending", "status", "--id", "PEND-0099",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toMatch(/PENDING_NOT_FOUND/);
  });

  test("status default on empty queue → null head (script-friendly)", async () => {
    const { dir, feature } = await startFresh();
    const r = await runCli([
      "pending", "status", "--json",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toEqual({ ok: true, feature, pending: null });
  });
});

describe("PENDING_BLOCKS_ADVANCE — preflight gate", () => {
  test("advance with pending head kind=gate_decision → exit 2 PENDING_BLOCKS_ADVANCE", async () => {
    const { dir, feature } = await startFresh();
    await injectPending(dir, "PEND-0001", "gate_decision");
    const r = await runCli([
      "advance", "TRIAGE.confirm",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/PENDING_BLOCKS_ADVANCE/);
    expect(r.stderr).toMatch(/PEND-0001/);
    expect(r.stderr).toMatch(/gate_decision/);
  });

  test("advance with pending head kind=profile_escalation → exit 2 PENDING_BLOCKS_ADVANCE", async () => {
    const { dir, feature } = await startFresh();
    await injectPending(dir, "PEND-0001", "profile_escalation");
    const r = await runCli([
      "advance", "TRIAGE.confirm",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/PENDING_BLOCKS_ADVANCE/);
  });

  test("advance with pending head kind=ask_user_question → succeeds (kind not in block set)", async () => {
    const { dir, feature } = await startFresh();
    await injectPending(dir, "PEND-0001", "ask_user_question");
    const r = await runCli([
      "advance", "TRIAGE.confirm",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(0);
  });

  test("advance with resolved head only (rest queue) → succeeds", async () => {
    // Resolved entries do not count as the head; the first UNRESOLVED entry
    // is the head. If the only entry is resolved, the queue effectively has
    // no head and advance is unblocked.
    const { dir, feature } = await startFresh();
    await injectPending(dir, "PEND-0001", "gate_decision");
    // Resolve via CLI (this also exercises resolve's FIFO pop).
    const resolved = await runCli([
      "pending", "resolve", "--answer", "approved",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(resolved.exit).toBe(0);
    const r = await runCli([
      "advance", "TRIAGE.confirm",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(r.exit).toBe(0);
  });
});

describe("loaf pending — E2E head promotion + advance gating", () => {
  test("raise ask + gate, resolve ask → gate becomes head → advance blocked", async () => {
    const { dir, feature } = await startFresh();
    // Raise non-blocking head (ask_user_question), then blocking entry (gate).
    await runCli([
      "pending", "raise", "--kind", "ask_user_question",
      "--question", "Confirm scope?", "--feature", feature, "--feature-dir", dir,
    ]);
    await runCli([
      "pending", "raise", "--kind", "gate_decision",
      "--question", "Approve spec-lock?", "--feature", feature, "--feature-dir", dir,
    ]);

    // Initial head is ask_user_question — advance allowed.
    const adv1 = await runCli([
      "advance", "TRIAGE.confirm",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(adv1.exit).toBe(0);

    // Resolve the asking head; gate_decision promotes to new head.
    const resolved = await runCli([
      "pending", "resolve", "--answer", "yes",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(resolved.exit).toBe(0);

    // Now head is gate_decision — next advance must be blocked.
    const adv2 = await runCli([
      "advance", "SPEC.proposal",
      "--feature", feature, "--feature-dir", dir,
    ]);
    expect(adv2.exit).toBe(2);
    expect(adv2.stderr).toMatch(/PENDING_BLOCKS_ADVANCE/);
    expect(adv2.stderr).toMatch(/PEND-0002/);
  });
});
