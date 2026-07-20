import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  CanonicalScopePaths,
  type JournalEntry,
  ScopeRecordedPayload,
} from "../../src/core/journal-entry.js";
import { checkScopeRecordedBatch, mutateBatch } from "../../src/core/journal-mutate.js";
import { KIND_REGISTRY } from "../../src/core/kind-registry.js";
import { initialSnapshot, applyValidated } from "../../src/core/reducer.js";
import { preflight } from "../../src/core/reducer/preflight.js";
import { deriveActualScope } from "../../src/core/scope-projection.js";
import { emptyMeta } from "../../src/core/snapshot.js";

const STANDARD = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip" as const,
  strict_drift_check: false,
};

function executeSnapshot(subState: "EXECUTE.work" | "EXECUTE.done" = "EXECUTE.work") {
  const snapshot = initialSnapshot();
  snapshot.state = {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    feature: "auth-refresh",
    phase: "EXECUTE",
    sub_state: subState,
    iteration: 2,
    spec_locked: true,
    verify_accepted: false,
    spec_version: 1,
    ceremony: STANDARD,
  };
  return snapshot;
}

function scopeEntry(
  seq: number,
  paths: unknown = ["src/auth.ts"],
  iteration = 2,
  actor = "cli:loaf",
): JournalEntry {
  return {
    seq,
    entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
    at: "2026-07-20T10:00:00.000Z",
    actor,
    entry_schema_version: 1,
    kind: "scope:recorded",
    payload: { iteration, paths },
  } as JournalEntry;
}

function executeDoneEntry(seq: number): JournalEntry {
  return {
    seq,
    entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
    at: "2026-07-20T10:00:01.000Z",
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind: "event:phase_advanced",
    payload: { from: "EXECUTE.work", to: "EXECUTE.done" },
  };
}

describe("scope:recorded payload contract", () => {
  test("accepts canonical concrete paths and the empty set", () => {
    expect(ScopeRecordedPayload.safeParse({ iteration: 1, paths: [] }).success).toBe(true);
    expect(
      ScopeRecordedPayload.safeParse({
        iteration: 1,
        paths: [".github/workflows/ci.yml", "src/auth.ts"],
      }).success,
    ).toBe(true);
  });

  test.each([
    ["absolute", ["/tmp/outside.ts"]],
    ["dot segment", ["src/./auth.ts"]],
    ["parent segment", ["src/../outside.ts"]],
    ["empty segment", ["src//auth.ts"]],
    ["backslash", ["src\\auth.ts"]],
    ["NUL", ["src/\0auth.ts"]],
    ["loaf root", [".loaf"]],
    ["loaf child", [".loaf/auth/state.json"]],
  ])("rejects %s paths", (_case, paths) => {
    expect(ScopeRecordedPayload.safeParse({ iteration: 1, paths }).success).toBe(false);
  });

  test("rejects malformed, unsorted, duplicate, non-positive, and unknown fields", () => {
    expect(ScopeRecordedPayload.safeParse({ iteration: 1, paths: "src/a.ts" }).success).toBe(
      false,
    );
    expect(
      ScopeRecordedPayload.safeParse({ iteration: 1, paths: ["src/b.ts", "src/a.ts"] })
        .success,
    ).toBe(false);
    expect(
      ScopeRecordedPayload.safeParse({ iteration: 1, paths: ["src/a.ts", "src/a.ts"] })
        .success,
    ).toBe(false);
    expect(ScopeRecordedPayload.safeParse({ iteration: 0, paths: [] }).success).toBe(false);
    expect(
      ScopeRecordedPayload.safeParse({ iteration: 1, paths: [], extra: true }).success,
    ).toBe(false);
  });

  test("LongTextField inline form carries exact canonical JSON", () => {
    const canonical = JSON.stringify(["src/a.ts", "src/b.ts"]);
    expect(
      ScopeRecordedPayload.safeParse({
        iteration: 1,
        paths: { mode: "inline", text: canonical },
      }).success,
    ).toBe(true);
    expect(
      ScopeRecordedPayload.safeParse({
        iteration: 1,
        paths: { mode: "inline", text: '["src/a.ts", "src/b.ts"]' },
      }).success,
    ).toBe(false);
  });
});

describe("scope:recorded registry and authority", () => {
  test("registry row is exact", () => {
    const row = KIND_REGISTRY["scope:recorded"];
    expect(row.payload).toBe(ScopeRecordedPayload);
    expect(row.reducerImplemented).toBe(true);
    expect(row.subStates).toEqual(new Set(["EXECUTE.work"]));
    expect(row.actors).toEqual(["cli"]);
    expect(row.emitsSpec).toBe(false);
  });

  test("non-cli actor is rejected", () => {
    const result = preflight(scopeEntry(1, ["src/a.ts"], 2, "skill:worker"), {
      snapshot: executeSnapshot(),
      tail_seq: 0,
    });
    expect(result).toMatchObject({ ok: false, code: "ACTOR_AUTHORITY_VIOLATION" });
  });

  test("wrong sub_state is rejected", () => {
    const snapshot = executeSnapshot();
    snapshot.state!.phase = "TRIAGE";
    snapshot.state!.sub_state = "TRIAGE.score";
    const result = preflight(scopeEntry(1), { snapshot, tail_seq: 0 });
    expect(result).toMatchObject({ ok: false, code: "SUB_STATE_AUTHORITY_VIOLATION" });
  });
});

describe("scope:recorded stable-core batch invariant", () => {
  test("standalone scope entry is rejected", () => {
    expect(checkScopeRecordedBatch([scopeEntry(1)], [])).toMatchObject({
      code: "SCOPE_RECORDED_BATCH_INVALID",
    });
  });

  test("more than one scope entry is rejected", () => {
    expect(
      checkScopeRecordedBatch(
        [scopeEntry(1, ["src/a.ts"]), scopeEntry(2, ["src/b.ts"]), executeDoneEntry(3)],
        [],
      ),
    ).toMatchObject({ code: "SCOPE_RECORDED_BATCH_INVALID" });
  });

  test("duplicate iteration against prior history is rejected", () => {
    expect(
      checkScopeRecordedBatch([scopeEntry(3), executeDoneEntry(4)], [scopeEntry(1)]),
    ).toMatchObject({ code: "SCOPE_RECORDED_ITERATION_DUPLICATE", detail: { iteration: 2 } });
  });

  test("correct adjacent two-entry closure batch is accepted", () => {
    expect(checkScopeRecordedBatch([scopeEntry(1), executeDoneEntry(2)], [])).toBeNull();
  });

  test("mutateBatch accepts the correct closure pair through the wired stable-core check", async () => {
    const featureDir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-scope-batch-"));
    const result = await mutateBatch(
      [
        {
          at: "2026-07-20T10:00:00.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "scope:recorded",
          payload: { iteration: 2, paths: ["src/auth.ts"] },
        },
        {
          at: "2026-07-20T10:00:01.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from: "EXECUTE.work", to: "EXECUTE.done" },
        },
      ],
      {
        feature_dir: featureDir,
        snapshot: executeSnapshot(),
        tail_seq: -1,
        entries: [],
        meta: emptyMeta(),
        dryRun: true,
        fsync: false,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.snapshot.state?.sub_state).toBe("EXECUTE.done");
  });
});

describe("scope:recorded reducer and entry-stream projection", () => {
  test("reducer is byte-equal no-op", () => {
    const before = executeSnapshot();
    const bytes = JSON.stringify(before);
    const result = applyValidated(before, scopeEntry(1));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected reducer success");
    expect(JSON.stringify(result.snapshot)).toBe(bytes);
  });

  test("deriveActualScope set-unions multiple entries in canonical byte order", async () => {
    const result = await deriveActualScope(
      [
        scopeEntry(1, ["src/a.ts", "src/shared.ts"], 1),
        scopeEntry(2, ["docs/readme.md", "src/shared.ts"], 2),
      ],
      "/unused",
    );
    expect(result).toEqual(["docs/readme.md", "src/a.ts", "src/shared.ts"]);
  });

  test("array, inline LongTextField, and verified sidecar have projection parity", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-scope-projection-"));
    const logical = ["src/a.ts", "src/b.ts"];
    const text = JSON.stringify(logical);
    const rel = "attachments/JE-000003/paths.txt";
    await fs.mkdir(path.join(dir, "attachments", "JE-000003"), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
    const ref = {
      path: rel,
      sha256: createHash("sha256").update(text).digest("hex"),
      size: Buffer.byteLength(text),
    };

    const arrayResult = await deriveActualScope([scopeEntry(1, logical)], dir);
    const inlineResult = await deriveActualScope(
      [scopeEntry(2, { mode: "inline", text })],
      dir,
    );
    const sidecarResult = await deriveActualScope(
      [scopeEntry(3, { mode: "sidecar", ref })],
      dir,
    );
    expect(inlineResult).toEqual(arrayResult);
    expect(sidecarResult).toEqual(arrayResult);
  });

  test("sidecar integrity mismatch fails loudly", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-scope-projection-"));
    const rel = "attachments/JE-000003/paths.txt";
    await fs.mkdir(path.join(dir, "attachments", "JE-000003"), { recursive: true });
    await fs.writeFile(path.join(dir, rel), JSON.stringify(["src/a.ts"]));

    await expect(
      deriveActualScope(
        [
          scopeEntry(3, {
            mode: "sidecar",
            ref: { path: rel, sha256: "0".repeat(64), size: 1 },
          }),
        ],
        dir,
      ),
    ).rejects.toThrow(/integrity mismatch/);
  });

  test("CanonicalScopePaths uses bytewise ordering", () => {
    expect(CanonicalScopePaths.safeParse(["z.ts", "é.ts"]).success).toBe(true);
    expect(CanonicalScopePaths.safeParse(["é.ts", "z.ts"]).success).toBe(false);
  });
});
