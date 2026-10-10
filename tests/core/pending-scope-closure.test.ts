import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { JournalEntry, ScopeRecordedPayload } from "../../src/core/journal-entry.js";
import type { SessionRuntimeFile } from "../../src/core/projection-schema.js";
import {
  preparePendingScopeClosure,
  settlePendingScope,
  type PendingScopeClosureContext,
  type PendingScopeSettlementPhase,
} from "../../src/core/pending-scope.js";

const oldAt = "2026-07-20T12:00:00.000Z";
const at = "2026-07-20T12:02:00.000Z";
const identity = { session_id: "pending-closure", cwd: "/unused" };
type Pending = SessionRuntimeFile["pending_scope"];

function runtime(pending: Pending): SessionRuntimeFile {
  return {
    schema_version: 2,
    ...identity,
    debug: true,
    heartbeat_at: oldAt,
    pending_scope: pending,
  };
}

// Explicit canonical batch fixture, independent of the production batch builder.
function fact(iteration: number, paths: ScopeRecordedPayload["paths"]): JournalEntry[] {
  return [
    {
      seq: 0,
      entry_id: "JE-000001",
      at: oldAt,
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "scope:recorded",
      payload: { iteration, paths },
      batch_id: "closure-fixture",
      batch_index: 0,
      batch_count: 2,
    },
    {
      seq: 1,
      entry_id: "JE-000002",
      at: oldAt,
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "event:phase_advanced",
      payload: { from: "EXECUTE.work", to: "EXECUTE.done" },
      batch_id: "closure-fixture",
      batch_index: 1,
      batch_count: 2,
    },
  ];
}

function context(entries: JournalEntry[] = [], featureDir = "/unused"): PendingScopeClosureContext {
  return { identity, debug: false, heartbeatAt: at, iteration: 2, entries, featureDir };
}

const prior = { iteration: 1, paths: ["src/a.ts", "src/late.ts"] };
const preparationCases: Array<{
  name: string;
  current: SessionRuntimeFile | null;
  entries: JournalEntry[];
  paths: string[];
}> = [
  { name: "absent runtime initializes", current: null, entries: [], paths: [] },
  { name: "null pending preserves runtime", current: runtime(null), entries: [], paths: [] },
  {
    name: "current iteration copies all paths even with a recorded fact",
    current: runtime({ ...prior, iteration: 2 }),
    entries: fact(2, ["src/a.ts"]),
    paths: prior.paths,
  },
  {
    name: "older pending without fact carries all",
    current: runtime(prior),
    entries: [],
    paths: prior.paths,
  },
  {
    name: "incomplete marker is not coverage",
    current: runtime(prior),
    entries: fact(1, ["src/a.ts"]).slice(0, 1),
    paths: prior.paths,
  },
  {
    name: "wrong iteration fact is not coverage",
    current: runtime(prior),
    entries: fact(2, prior.paths),
    paths: prior.paths,
  },
  {
    name: "partly covered prior scope carries only uncovered",
    current: runtime(prior),
    entries: fact(1, ["src/a.ts"]),
    paths: ["src/late.ts"],
  },
  {
    name: "fully covered prior scope carries nothing",
    current: runtime(prior),
    entries: fact(1, prior.paths),
    paths: [],
  },
  {
    name: "uncovered prior scope carries all",
    current: runtime(prior),
    entries: fact(1, ["src/other.ts"]),
    paths: prior.paths,
  },
  {
    name: "empty prior pending remains empty",
    current: runtime({ iteration: 1, paths: [] }),
    entries: [],
    paths: [],
  },
];

describe("pending scope closure preparation", () => {
  test.each(preparationCases)("$name", async (row) => {
    const before = JSON.stringify(row.current);
    const result = await preparePendingScopeClosure(row.current, context(row.entries));
    expect(result).toEqual({
      ok: true,
      runtime: row.current ?? {
        schema_version: 2,
        ...identity,
        debug: false,
        heartbeat_at: at,
        pending_scope: null,
      },
      paths: row.paths,
    });
    expect(JSON.stringify(row.current)).toBe(before);
    if (result.ok && row.current?.pending_scope)
      expect(result.paths).not.toBe(row.current.pending_scope.paths);
  });

  test("future pending returns the preparing failure without mutation", async () => {
    const current = runtime({ iteration: 3, paths: ["src/future.ts"] });
    const before = JSON.stringify(current);
    expect(await preparePendingScopeClosure(current, context())).toEqual({
      ok: false,
      failure: {
        code: "EXECUTE_CLOSURE_STATE_CHANGED",
        message: "runtime pending scope is from future iteration 3, ahead of journal iteration 2",
        detail: { pending_iteration: 3, current_iteration: 2 },
      },
    });
    expect(JSON.stringify(current)).toBe(before);
  });
});

const settlementCases: Array<{
  name: string;
  phase: PendingScopeSettlementPhase;
  current: SessionRuntimeFile | null;
  entries: JournalEntry[];
  expected: Pending | "ambiguous";
}> = [
  {
    name: "committed initializes absent runtime",
    phase: "committed",
    current: null,
    entries: [],
    expected: null,
  },
  {
    name: "committed clears uncovered prior paths",
    phase: "committed",
    current: runtime(prior),
    entries: fact(2, prior.paths),
    expected: null,
  },
  {
    name: "recovery initializes absent runtime",
    phase: "recovered",
    current: null,
    entries: [],
    expected: null,
  },
  {
    name: "recovery keeps null pending",
    phase: "recovered",
    current: runtime(null),
    entries: [],
    expected: null,
  },
  {
    name: "recovery clears current covered paths",
    phase: "recovered",
    current: runtime({ ...prior, iteration: 2 }),
    entries: fact(2, prior.paths),
    expected: null,
  },
  {
    name: "recovery preserves partly covered late paths",
    phase: "recovered",
    current: runtime(prior),
    entries: fact(1, ["src/a.ts"]),
    expected: prior,
  },
  {
    name: "recovery clears only with origin iteration coverage",
    phase: "recovered",
    current: runtime(prior),
    entries: fact(1, prior.paths),
    expected: null,
  },
  {
    name: "recovery ignores current iteration coverage for prior pending",
    phase: "recovered",
    current: runtime(prior),
    entries: fact(2, prior.paths),
    expected: prior,
  },
  {
    name: "recovery preserves absent origin fact",
    phase: "recovered",
    current: runtime(prior),
    entries: [],
    expected: prior,
  },
  {
    name: "recovery preserves empty pending without fact",
    phase: "recovered",
    current: runtime({ iteration: 1, paths: [] }),
    entries: [],
    expected: { iteration: 1, paths: [] },
  },
  {
    name: "recovery rejects an incomplete fact as coverage",
    phase: "recovered",
    current: runtime(prior),
    entries: fact(1, prior.paths).slice(0, 1),
    expected: prior,
  },
  {
    name: "committed failure clears null pending",
    phase: "committed-failure",
    current: runtime(null),
    entries: [],
    expected: null,
  },
  {
    name: "committed failure clears current covered paths",
    phase: "committed-failure",
    current: runtime({ ...prior, iteration: 2 }),
    entries: fact(2, prior.paths),
    expected: null,
  },
  {
    name: "committed failure clears prior covered paths",
    phase: "committed-failure",
    current: runtime(prior),
    entries: fact(1, prior.paths),
    expected: null,
  },
  {
    name: "committed failure refuses partial origin coverage",
    phase: "committed-failure",
    current: runtime(prior),
    entries: fact(1, ["src/a.ts"]),
    expected: "ambiguous",
  },
  // Extraction baseline: success clears carried paths; a committed failure
  // checks their origin iteration and refuses when that proof is incomplete.
  {
    name: "committed failure refuses current-only coverage of prior pending",
    phase: "committed-failure",
    current: runtime(prior),
    entries: fact(2, prior.paths),
    expected: "ambiguous",
  },
  {
    name: "committed failure refuses absent origin fact",
    phase: "committed-failure",
    current: runtime(prior),
    entries: [],
    expected: "ambiguous",
  },
];

describe("pending scope settlement", () => {
  test.each(settlementCases)("$name", async (row) => {
    const before = JSON.stringify(row.current);
    const result = await settlePendingScope(row.current, context(row.entries), row.phase);
    if (row.expected === "ambiguous") {
      expect(result).toEqual({
        ok: false,
        failure: {
          code: "EXECUTE_CLOSURE_COMMIT_AMBIGUOUS",
          message:
            "post-append journal proof does not cover all pending scope paths; refusing to clear",
          detail: { iteration: 2 },
        },
      });
    } else {
      expect(result).toEqual({
        ok: true,
        runtime: {
          ...(row.current ?? { schema_version: 2, ...identity, debug: false }),
          heartbeat_at: at,
          pending_scope: row.expected,
        },
      });
    }
    expect(JSON.stringify(row.current)).toBe(before);
  });

  test("future pending returns the recovery failure without mutation", async () => {
    const current = runtime({ iteration: 3, paths: ["src/future.ts"] });
    const before = JSON.stringify(current);
    expect(await settlePendingScope(current, context(), "recovered")).toEqual({
      ok: false,
      failure: {
        code: "EXECUTE_CLOSURE_STATE_CHANGED",
        message:
          "runtime pending scope is ahead of the committed journal iteration; refusing to rewrite causal order",
        detail: { pending_iteration: 3, iteration: 2 },
      },
    });
    expect(JSON.stringify(current)).toBe(before);
  });
});

describe("pending scope attachment coverage", () => {
  test.each([
    "array",
    "inline",
    "sidecar",
  ])("%s paths have the same preparation and settlement semantics", async (encoding) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-pending-closure-"));
    try {
      const paths = ["src/a.ts"];
      const text = JSON.stringify(paths);
      const relative = "attachments/JE-000001/paths.txt";
      await fs.mkdir(path.join(dir, "attachments", "JE-000001"), { recursive: true });
      await fs.writeFile(path.join(dir, relative), text);
      const encoded: ScopeRecordedPayload["paths"] =
        encoding === "array"
          ? paths
          : encoding === "inline"
            ? { mode: "inline", text }
            : {
                mode: "sidecar",
                ref: {
                  path: relative,
                  sha256: createHash("sha256").update(text).digest("hex"),
                  size: Buffer.byteLength(text),
                },
              };
      const ctx = context(fact(1, encoded), dir);
      const current = runtime(prior);
      expect(await preparePendingScopeClosure(current, ctx)).toEqual({
        ok: true,
        runtime: current,
        paths: ["src/late.ts"],
      });
      expect(await settlePendingScope(current, ctx, "recovered")).toEqual({
        ok: true,
        runtime: { ...current, heartbeat_at: at },
      });
      expect(await settlePendingScope(current, ctx, "committed-failure")).toMatchObject({
        ok: false,
        failure: { code: "EXECUTE_CLOSURE_COMMIT_AMBIGUOUS" },
      });
      const covered = runtime({ iteration: 1, paths });
      for (const phase of ["recovered", "committed-failure"] as const) {
        expect(await settlePendingScope(covered, ctx, phase)).toEqual({
          ok: true,
          runtime: { ...covered, heartbeat_at: at, pending_scope: null },
        });
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test.each([
    "missing",
    "corrupt",
  ])("%s sidecar errors propagate and never fabricate coverage", async (fault) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-pending-closure-"));
    try {
      const relative = "attachments/JE-000001/paths.txt";
      const text = JSON.stringify(["src/a.ts"]);
      await fs.mkdir(path.join(dir, "attachments", "JE-000001"), { recursive: true });
      if (fault === "corrupt") await fs.writeFile(path.join(dir, relative), "corrupted");
      const ctx = context(
        fact(1, {
          mode: "sidecar",
          ref: {
            path: relative,
            sha256: createHash("sha256").update(text).digest("hex"),
            size: Buffer.byteLength(text),
          },
        }),
        dir,
      );
      const current = runtime(prior);
      const before = JSON.stringify(current);
      const error = { code: fault === "missing" ? "ATTACHMENT_MISSING" : "ATTACHMENT_INTEGRITY" };
      await expect(preparePendingScopeClosure(current, ctx)).rejects.toMatchObject(error);
      await expect(settlePendingScope(current, ctx, "recovered")).rejects.toMatchObject(error);
      await expect(settlePendingScope(current, ctx, "committed-failure")).rejects.toMatchObject(
        error,
      );
      expect(JSON.stringify(current)).toBe(before);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
