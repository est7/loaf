// Phase 16 SC-3 — CommandContext factory + lifecycle tests.
//
// CommandContext is the presentation-layer plumbing per r188 + r205/r206:
//
//   - Resolves output channel (text|json) from argv
//   - Lazy session resolution; cache keyed by (featureDir, method) tuple
//   - resolveActor pass-through
//   - success(payload, textRenderer?) routes to stdout per mode
//   - failure(code, message, detail?) routes to stderr per mode + sets
//     mutable exitCode (mutable per codex r196 PATCH A — escape-only is
//     boundary)
//   - snapshotCrashContext() emits {phase, sub_state, feature, last_command}
//     for crash log enrichment (SC-2 deferred)
//   - ctx.failure code parameter is type-strict — only DiagnosticCode
//     literals compile (defense-in-depth alongside inventory extension)

import { describe, expect, test } from "vitest";

import {
  createCommandContext,
  type CommandContext,
} from "../../src/cli/command-context.js";

function makeCtx(
  argv: string[],
  overrides: Partial<Parameters<typeof createCommandContext>[1]> = {},
): {
  ctx: CommandContext;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createCommandContext(argv, {
    writeStdout: (s) => stdout.push(s),
    writeStderr: (s) => stderr.push(s),
    ...overrides,
  });
  return { ctx, stdout, stderr };
}

describe("Phase 16 SC-3 — CommandContext: construction + output mode", () => {
  test("argv without --format → output mode = 'text' (default); success writes the text renderer output to stdout", () => {
    const { ctx, stdout, stderr } = makeCtx(["loaf", "status"]);
    expect(ctx.output).toBe("text");
    ctx.success({ ok: true, foo: 1 }, () => "human line\n");
    expect(stdout.join("")).toBe("human line\n");
    expect(stderr.join("")).toBe("");
  });

  test("argv with --format json → output mode = 'json'; success writes JSON.stringify(payload) + \\n", () => {
    const { ctx, stdout } = makeCtx(["loaf", "status", "--format", "json"]);
    expect(ctx.output).toBe("json");
    ctx.success({ ok: true, foo: 1 }, () => "this should not appear");
    expect(stdout.join("")).toBe('{"ok":true,"foo":1}\n');
  });

  test("text renderer is LAZY — not invoked in JSON mode", () => {
    const { ctx } = makeCtx(["loaf", "status", "--format", "json"]);
    let called = false;
    ctx.success({ ok: true }, () => {
      called = true;
      return "expensive";
    });
    expect(called).toBe(false);
  });

  test("text mode + missing textRenderer → THROWS (codex r208 PATCH 1 — no silent JSON fallback)", () => {
    const { ctx } = makeCtx(["loaf", "status"]);
    expect(() => ctx.success({ ok: true } as never)).toThrow(/text renderer required/i);
  });

  test("JSON mode + missing textRenderer → OK (lazy contract preserved; renderer optional in JSON)", () => {
    const { ctx, stdout } = makeCtx(["loaf", "status", "--format", "json"]);
    ctx.success({ ok: true, foo: 1 } as never);
    expect(stdout.join("")).toBe('{"ok":true,"foo":1}\n');
  });
});

describe("Phase 16 SC-3 — CommandContext: failure routing + exitCode", () => {
  test("failure() sets exitCode := 2 + writes stderr per text mode", () => {
    const { ctx, stderr } = makeCtx(["loaf", "tasks", "claim"]);
    ctx.failure("USAGE", "missing --task");
    expect(ctx.exitCode).toBe(2);
    expect(stderr.join("")).toContain("USAGE");
    expect(stderr.join("")).toContain("missing --task");
  });

  test("failure() in JSON mode writes single-line JSON to stderr", () => {
    const { ctx, stderr } = makeCtx(["loaf", "tasks", "claim", "--format", "json"]);
    ctx.failure("USAGE", "missing --task", { foo: "bar" });
    const lines = stderr.join("").split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const obj = JSON.parse(lines[0]!);
    expect(obj).toEqual({
      ok: false,
      code: "USAGE",
      message: "missing --task",
      detail: { foo: "bar" },
    });
  });
});

describe("Phase 16 SC-3 — CommandContext: lazy session cache by (featureDir, method)", () => {
  test("resolveSession is lazy — never invoked unless caller asks", async () => {
    let loadCount = 0;
    const { ctx } = makeCtx(["loaf", "status"], {
      loadSession: async (_dir) => {
        loadCount++;
        return { snapshot: { state: { sub_state: "EXECUTE.work" as const } } } as never;
      },
    });
    // construct without touching session
    expect(loadCount).toBe(0);
    void ctx; // unused
  });

  test("resolveSession caches results by featureDir — same dir twice = one load", async () => {
    let loadCount = 0;
    const { ctx } = makeCtx(["loaf", "status"], {
      loadSession: async (_dir) => {
        loadCount++;
        return {
          snapshot: { state: { sub_state: "EXECUTE.work" as const } },
          tail_seq: 0,
          entries: [],
          meta: null,
        } as never;
      },
    });
    await ctx.resolveSession("/tmp/feat-a");
    await ctx.resolveSession("/tmp/feat-a");
    expect(loadCount).toBe(1);
  });

  test("resolveSession + resolveProjections are independently cached (different methods, same dir = 2 loads)", async () => {
    let sessionLoads = 0;
    let projectionLoads = 0;
    const { ctx } = makeCtx(["loaf", "status"], {
      loadSession: async () => {
        sessionLoads++;
        return { snapshot: { state: {} }, tail_seq: 0, entries: [], meta: null } as never;
      },
      loadProjections: async () => {
        projectionLoads++;
        return { kind: "ok" } as never;
      },
    });
    await ctx.resolveSession("/tmp/x");
    await ctx.resolveProjections("/tmp/x", ["state" as never]);
    expect(sessionLoads).toBe(1);
    expect(projectionLoads).toBe(1);
  });
});

describe("Phase 16 SC-3 — CommandContext: snapshotCrashContext for SC-2 boundary enrichment", () => {
  test("before any session resolve: {phase: null, sub_state: null, feature: null, last_command}", () => {
    const { ctx } = makeCtx(["loaf", "advance", "EXECUTE.work", "--feature", "F-042"]);
    const ctxSnap = ctx.snapshotCrashContext();
    expect(ctxSnap.phase).toBeNull();
    expect(ctxSnap.sub_state).toBeNull();
    expect(ctxSnap.feature).toBe("F-042"); // best-effort from argv parse, like crash-log.ts
    expect(ctxSnap.last_command).toMatch(/loaf advance EXECUTE\.work --feature F-042/);
  });

  test("after resolveSession: phase + sub_state populated from cached snapshot.state.sub_state", async () => {
    const { ctx } = makeCtx(["loaf", "deliver", "--feature", "F-042"], {
      loadSession: async () => ({
        snapshot: { state: { sub_state: "VERIFY.accept" as const } },
        tail_seq: 0,
        entries: [],
        meta: null,
      }) as never,
    });
    await ctx.resolveSession("/tmp/feat");
    const snap = ctx.snapshotCrashContext();
    expect(snap.sub_state).toBe("VERIFY.accept");
    expect(snap.phase).toBe("VERIFY"); // derived: split on "."
  });
});
