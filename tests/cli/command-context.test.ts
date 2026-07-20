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

import { createCommandContext, type CommandContext } from "../../src/cli/command-context.js";
import { createI18n, BUILTIN_BUNDLES, type I18n } from "../../src/cli/i18n.js";
import { CHROME_KEYS, FAILURE_SITE_KEYS, SUCCESS_KEYS } from "../../src/cli/runtime-i18n-keys.js";

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

  test("text renderer receives i18n in text mode", () => {
    const { ctx, stdout } = makeCtx(["loaf", "status"], {
      i18n: {
        locale: "en",
        t: (key: string) => `translated:${key}`,
      },
    });
    ctx.success({ ok: true }, (i18n) => i18n.t("status.ready"));
    expect(stdout.join("")).toBe("translated:status.ready");
  });

  test("JSON mode does not invoke i18n text renderer", () => {
    let called = false;
    const { ctx, stdout } = makeCtx(["loaf", "status", "--format", "json"], {
      i18n: {
        locale: "en",
        t: (key: string) => `translated:${key}`,
      },
    });
    ctx.success({ ok: true }, (i18n) => {
      called = true;
      return i18n.t("status.ready");
    });
    expect(called).toBe(false);
    expect(stdout.join("")).toBe('{"ok":true}\n');
  });

  test("lazy advisories receive i18n and still emit in JSON mode stderr", () => {
    const { ctx, stdout, stderr } = makeCtx(["loaf", "start", "--format", "json"], {
      i18n: {
        locale: "en",
        t: (key: string) => `translated:${key}`,
      },
    });

    ctx.success(
      { ok: true },
      () => "not used",
      (i18n) => ({
        stateChange: i18n.t("advisory.state"),
        next: i18n.t("advisory.next"),
      }),
    );

    expect(stdout.join("")).toBe('{"ok":true}\n');
    expect(stderr.join("")).toBe("translated:advisory.state\nnext: translated:advisory.next\n");
  });

  test("success text/advisory renderers use P3a localized keys in zh text mode", () => {
    const { ctx, stdout, stderr } = makeCtx(["loaf", "start"], {
      i18n: createI18n("zh", BUILTIN_BUNDLES),
    });

    ctx.success(
      { ok: true, session_id: "session-1" },
      () => "session-1\n",
      (i18n) => ({
        stateChange: i18n.t(SUCCESS_KEYS.startStateChange, {
          feature: "auth-refresh",
        }),
        next: "loaf advance TRIAGE.confirm --feature auth-refresh",
      }),
    );

    expect(stdout.join("")).toBe("session-1\n");
    expect(stderr.join("")).toBe(
      "start: 'auth-refresh' 已创建 → TRIAGE.score\n" +
        "next: loaf advance TRIAGE.confirm --feature auth-refresh\n",
    );
  });

  test("success text renderer uses P3a localized task-submit key", () => {
    const { ctx, stdout, stderr } = makeCtx(["loaf", "tasks", "submit"], {
      i18n: createI18n("zh", BUILTIN_BUNDLES),
    });

    ctx.success(
      { ok: true, tasks_count: 2, task_ids: ["T-001", "T-002"] },
      (i18n) =>
        i18n.t(SUCCESS_KEYS.tasksSubmitTextMany, {
          count: 2,
          task_ids: "T-001, T-002",
        }) + "\n",
      (i18n) => ({
        stateChange: i18n.t(SUCCESS_KEYS.tasksSubmitStateChange, { count: 2 }),
        next: i18n.t(SUCCESS_KEYS.nextFullCommandPointer, {
          command: "loaf next --feature auth-refresh --format json",
        }),
      }),
    );

    expect(stdout.join("")).toBe("已提交 2 个 task:T-001, T-002\n");
    expect(stderr.join("")).toBe(
      "tasks submit: 2 tasks\n" +
        "next: 运行 `loaf next --feature auth-refresh --format json` 获取完整命令\n",
    );
  });

  test("success JSON payload stays byte-stable under zh locale", () => {
    const payload = { ok: true, feature: "auth-refresh", task_ids: ["T-001"], tasks_count: 1 };
    const en = makeCtx(["loaf", "tasks", "submit", "--format", "json"], {
      i18n: createI18n("en", BUILTIN_BUNDLES),
    });
    const zh = makeCtx(["loaf", "tasks", "submit", "--format", "json"], {
      i18n: createI18n("zh", BUILTIN_BUNDLES),
    });
    const renderText = (i18n: I18n) =>
      i18n.t(SUCCESS_KEYS.tasksSubmitTextOne, {
        count: 1,
        task_ids: "T-001",
      }) + "\n";
    const renderAdvisory = (i18n: I18n) => ({
      stateChange: i18n.t(SUCCESS_KEYS.tasksSubmitStateChange, { count: 1 }),
      next: i18n.t(SUCCESS_KEYS.nextFullCommandPointer, {
        command: "loaf next --feature auth-refresh --format json",
      }),
    });

    en.ctx.success(payload, renderText, renderAdvisory);
    zh.ctx.success(payload, renderText, renderAdvisory);

    expect(zh.stdout.join("")).toBe(en.stdout.join(""));
  });

  test("P3b success text/advisory keys localize representative zh text", () => {
    const { ctx, stdout, stderr } = makeCtx(["loaf", "doctor", "--rebuild"], {
      i18n: createI18n("zh", BUILTIN_BUNDLES),
    });

    ctx.success(
      { ok: true, rebuilt: ["state.json", "tasks.json"] },
      (i18n) =>
        i18n.t(SUCCESS_KEYS.doctorRebuildTextMany, {
          count: 2,
          feature: "auth-refresh",
        }) +
        "\n" +
        ["state.json", "tasks.json"].map((f) => `  snapshots/${f}\n`).join("") +
        i18n.t(SUCCESS_KEYS.snapshotAsOfSeq, { seq: 7 }) +
        "\n",
      (i18n) => ({
        stateChange: i18n.t(SUCCESS_KEYS.doctorRebuildStateChangeMany, {
          count: 2,
          feature: "auth-refresh",
        }),
      }),
    );

    expect(stdout.join("")).toBe(
      "已为 auth-refresh 重建 2 个 projection file:\n" +
        "  snapshots/state.json\n" +
        "  snapshots/tasks.json\n" +
        "# snapshot as-of seq=7\n",
    );
    expect(stderr.join("")).toBe("doctor rebuild: 已为 auth-refresh 重建 2 个 projection file\n");
  });

  test("P3b success JSON payload stays byte-stable under zh locale", () => {
    const payload = {
      ok: true,
      feature: "auth-refresh",
      from: "VERIFY.accept",
      to: "SETTLE.reconcile",
    };
    const en = makeCtx(["loaf", "settle", "--format", "json"], {
      i18n: createI18n("en", BUILTIN_BUNDLES),
    });
    const zh = makeCtx(["loaf", "settle", "--format", "json"], {
      i18n: createI18n("zh", BUILTIN_BUNDLES),
    });
    const renderText = (i18n: I18n) => i18n.t(SUCCESS_KEYS.settleText) + "\n";
    const renderAdvisory = (i18n: I18n) => ({
      stateChange: i18n.t(SUCCESS_KEYS.settleStateChange, { from: "VERIFY.accept" }),
      next: i18n.t(SUCCESS_KEYS.nextDeliver),
    });

    en.ctx.success(payload, renderText, renderAdvisory);
    zh.ctx.success(payload, renderText, renderAdvisory);

    expect(zh.stdout.join("")).toBe(en.stdout.join(""));
  });

  test("P3c read-only chrome keys localize representative zh text", () => {
    const { ctx, stdout } = makeCtx(["loaf", "status"], {
      i18n: createI18n("zh", BUILTIN_BUNDLES),
    });

    ctx.success(
      { ok: true, feature: "auth-refresh", phase: "EXECUTE", task_kind: "behavioral" },
      (i18n) =>
        i18n.t(CHROME_KEYS.statusFeature, { feature: "auth-refresh" }) +
        "\n" +
        i18n.t(CHROME_KEYS.statusPhase, { phase: "执行 / 任务进行中" }) +
        "\n" +
        i18n.t(CHROME_KEYS.tasksListRowReady, {
          task_id: "T-001",
          kind: "行为",
          status: "待处理",
          ready: "就绪",
        }) +
        "\n",
    );

    expect(stdout.join("")).toBe(
      "功能: auth-refresh\n" + "阶段: 执行 / 任务进行中\n" + "T-001 行为 待处理 [就绪]\n",
    );
  });

  test("P3c read-only JSON payload stays byte-stable under zh locale", () => {
    const payload = {
      ok: true,
      feature: "auth-refresh",
      tasks: [{ id: "T-001", kind: "behavioral" }],
    };
    const en = makeCtx(["loaf", "tasks", "list", "--format", "json"], {
      i18n: createI18n("en", BUILTIN_BUNDLES),
    });
    const zh = makeCtx(["loaf", "tasks", "list", "--format", "json"], {
      i18n: createI18n("zh", BUILTIN_BUNDLES),
    });
    const renderText = (i18n: I18n) => i18n.t(CHROME_KEYS.tasksListEmpty) + "\n";

    en.ctx.success(payload, renderText);
    zh.ctx.success(payload, renderText);

    expect(zh.stdout.join("")).toBe(en.stdout.join(""));
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
    const lines = stderr
      .join("")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const obj = JSON.parse(lines[0]!);
    expect(obj).toEqual({
      ok: false,
      code: "USAGE",
      message: "missing --task",
      detail: { foo: "bar" },
    });
  });

  // Phase 16 SC-9c — detail.errors[] rendering for schema validation
  // failures (codex r309 B1). Shared renderer mirrors detail.checks[]
  // pattern but uses `[path] CODE: message` row shape.
  test("failure() text mode renders detail.errors[] as nested rows", () => {
    const { ctx, stderr } = makeCtx(["loaf", "check", "tasks.json"]);
    ctx.failure("SCHEMA_VALIDATION_FAILED", "tasks failed (2 errors)", {
      kind: "tasks",
      path: "/tmp/tasks.json",
      subcode: "zod",
      errors: [
        { path: "version", code: "invalid_type", message: "expected number" },
        { path: "tasks.0.id", code: "invalid_string", message: "must match /T-/" },
      ],
      truncated: false,
      error_count: 2,
    });
    const out = stderr.join("");
    expect(out).toContain("error: SCHEMA_VALIDATION_FAILED — tasks failed (2 errors)");
    expect(out).toContain("  [version] invalid_type: expected number");
    expect(out).toContain("  [tasks.0.id] invalid_string: must match /T-/");
    // No truncation suffix when truncated=false
    expect(out).not.toContain("errors total; first");
  });

  test("failure() JSON mode preserves detail.errors[] verbatim", () => {
    const { ctx, stderr } = makeCtx(["loaf", "check", "tasks.json", "--format", "json"]);
    ctx.failure("SCHEMA_VALIDATION_FAILED", "tasks failed", {
      errors: [{ path: "version", code: "invalid_type", message: "expected number" }],
      error_count: 1,
      truncated: false,
    });
    const lines = stderr
      .join("")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const obj = JSON.parse(lines[0]!);
    expect(obj.detail.errors).toEqual([
      { path: "version", code: "invalid_type", message: "expected number" },
    ]);
    expect(obj.detail.error_count).toBe(1);
    expect(obj.detail.truncated).toBe(false);
  });

  test("failure() text mode renders truncation suffix when truncated=true", () => {
    const { ctx, stderr } = makeCtx(["loaf", "check", "spec.md"]);
    const fakeErrors = Array.from({ length: 20 }, (_, i) => ({
      path: `requirements.${i}.id`,
      code: "invalid_string",
      message: "must match REQ regex",
    }));
    ctx.failure("SCHEMA_VALIDATION_FAILED", "spec failed (50 errors)", {
      kind: "spec",
      path: "/tmp/spec.md",
      subcode: "zod",
      errors: fakeErrors,
      truncated: true,
      error_count: 50,
    });
    const out = stderr.join("");
    expect(out).toContain("... (50 errors total; first 20 shown)");
  });

  test("failureKeyed() localizes text mode with injected i18n", () => {
    const { ctx, stderr } = makeCtx(["loaf", "status"], {
      i18n: createI18n("zh", BUILTIN_BUNDLES),
    });
    ctx.failureKeyed(
      "DRY_RUN_NOT_APPLICABLE",
      "diagnostic.DRY_RUN_NOT_APPLICABLE",
      { command_type: "read-only", command: "status" },
      { command_type: "read-only", command: "status" },
    );

    expect(ctx.exitCode).toBe(2);
    expect(stderr.join("")).toContain(
      "error: DRY_RUN_NOT_APPLICABLE — --dry-run 不适用于read-only命令 `status`",
    );
  });

  test("failureKeyed() JSON mode keeps canonical English message", () => {
    const { ctx, stderr } = makeCtx(["loaf", "status", "--format", "json"], {
      i18n: createI18n("zh", BUILTIN_BUNDLES),
    });
    ctx.failureKeyed(
      "DRY_RUN_NOT_APPLICABLE",
      "diagnostic.DRY_RUN_NOT_APPLICABLE",
      { command_type: "read-only", command: "status" },
      { command_type: "read-only", command: "status" },
    );

    expect(JSON.parse(stderr.join(""))).toEqual({
      ok: false,
      code: "DRY_RUN_NOT_APPLICABLE",
      message: "--dry-run not applicable to read-only command `status`",
      detail: { command_type: "read-only", command: "status" },
    });
  });

  test("failureKeyed() supports broad NO_SESSION site keys", () => {
    const { ctx, stderr } = makeCtx(["loaf", "status"], {
      i18n: createI18n("zh", BUILTIN_BUNDLES),
    });
    ctx.failureKeyed(
      "NO_SESSION",
      FAILURE_SITE_KEYS.noSessionStatus,
      { feature: "auth-refresh" },
      { feature: "auth-refresh", feature_dir: ".loaf/auth-refresh" },
    );

    expect(stderr.join("")).toContain("error: NO_SESSION — 先跑 `loaf start auth-refresh`");
  });

  test("failureKeyed() keeps broad NO_SESSION JSON message in English", () => {
    const { ctx, stderr } = makeCtx(["loaf", "status", "--format", "json"], {
      i18n: createI18n("zh", BUILTIN_BUNDLES),
    });
    ctx.failureKeyed(
      "NO_SESSION",
      FAILURE_SITE_KEYS.noSessionStatus,
      { feature: "auth-refresh" },
      { feature: "auth-refresh", feature_dir: ".loaf/auth-refresh" },
    );

    expect(JSON.parse(stderr.join(""))).toEqual({
      ok: false,
      code: "NO_SESSION",
      message: "run `loaf start auth-refresh` first",
      detail: { feature: "auth-refresh", feature_dir: ".loaf/auth-refresh" },
    });
  });

  test("failureKeyed() keeps P2c broad site JSON messages byte-stable under zh", () => {
    const cases = [
      {
        code: "SCHEMA_VALIDATION_FAILED",
        key: FAILURE_SITE_KEYS.hookStdinParseFailed,
        vars: { reason: "hook stdin is not valid JSON" },
        detail: { source: "hook-stdin" },
      },
      {
        code: "INPUT_FILE_NOT_FOUND",
        key: FAILURE_SITE_KEYS.profileInputFileMissing,
        vars: { path: "/tmp/missing.json" },
        detail: { path: "/tmp/missing.json" },
      },
      {
        code: "SCHEMA_VALIDATION_FAILED",
        key: FAILURE_SITE_KEYS.tasksAddEmptyArray,
        vars: {},
        detail: {},
      },
      {
        code: "SCHEMA_VALIDATION_FAILED",
        key: FAILURE_SITE_KEYS.handoffPackValidationFailed,
        vars: {},
        detail: { subcode: "zod" },
      },
      {
        code: "USAGE",
        key: FAILURE_SITE_KEYS.lessonsTextFileMutex,
        vars: { provided_state: "both provided" },
        detail: { text_provided: true, file_provided: true },
      },
      {
        code: "INPUT_FILE_NOT_FOUND",
        key: FAILURE_SITE_KEYS.lessonsFileMissing,
        vars: { path: "/tmp/missing-lesson.md" },
        detail: { path: "/tmp/missing-lesson.md" },
      },
      {
        code: "SCHEMA_VALIDATION_FAILED",
        key: FAILURE_SITE_KEYS.writeGuardConfigInvalid,
        vars: { reason: "invalid json" },
        detail: { source: "loaf.config.json", reason: "invalid json" },
      },
    ] as const;

    for (const c of cases) {
      const en = makeCtx(["loaf", "status", "--format", "json"], {
        i18n: createI18n("en", BUILTIN_BUNDLES),
      });
      const zh = makeCtx(["loaf", "status", "--format", "json"], {
        i18n: createI18n("zh", BUILTIN_BUNDLES),
      });
      en.ctx.failureKeyed(c.code, c.key, c.vars, c.detail);
      zh.ctx.failureKeyed(c.code, c.key, c.vars, c.detail);
      expect(zh.stderr.join(""), c.key).toBe(en.stderr.join(""));
    }
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
      loadSession: async () =>
        ({
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
