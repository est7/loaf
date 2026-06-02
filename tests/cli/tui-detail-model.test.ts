// Slice 3 — pure detail-model tests for `loaf tui` detail drill-down.

import { describe, expect, test } from "vitest";

import type { SessionRow } from "../../src/cli/sessions-list.js";
import {
  classifyDetailOutcome,
  shapeDetailViewModel,
  type DetailProjectionLoad,
} from "../../src/cli/tui/detail-model.js";
import { NoSessionError, SnapshotStaleError } from "../../src/core/projection-loader.js";
import { BUILTIN_BUNDLES, createI18n, DEFAULT_I18N } from "../../src/cli/i18n.js";

const FIXED_NOW = new Date("2026-06-01T11:00:00.000Z");
const ZH_I18N = createI18n("zh", BUILTIN_BUNDLES);

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  const sessionId = overrides.session_id ?? "550e8400-e29b-41d4-a716-446655440000";
  return {
    session_id: sessionId,
    session_id_short: sessionId.slice(0, 8),
    session_label: "",
    feature: "auth-refresh",
    phase: "EXECUTE",
    sub_state: "EXECUTE.work",
    at: "2026-06-01T10:00:00.000Z",
    cwd: "/Users/dev/project-a",
    workspace: "default",
    iteration: 1,
    pending_queue_depth: 0,
    active_tasks: [],
    ceremony_label: "standard",
    ...overrides,
  };
}

function makeLoaded(): DetailProjectionLoad {
  return {
    state: {
      schema_version: 2,
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      session_label: null,
      workspace: "default",
      loaf_version_required: null,
      phase: "EXECUTE",
      sub_state: "EXECUTE.work",
      iteration: 2,
      spec_locked: true,
      verify_accepted: false,
      pending: [],
      ceremony: {
        spec_phase: true,
        verify_phase: true,
        settle_phase: true,
        strict_spec_review: false,
        lessons_required: "may",
        strict_drift_check: false,
      },
      ceremony_label: "standard",
      complexity_score: null,
      based_on: { spec: 1, tasks: 1 },
      spec_version: 3,
      created_at: "2026-06-01T09:00:00.000Z",
      updated_at: "2026-06-01T10:00:00.000Z",
    },
    tasks: {
      schema_version: 2,
      version: 1,
      based_on: { spec: 1 },
      tasks: [
        {
          id: "T-001",
          kind: "behavioral",
          status: "in_progress",
          depends_on: [],
          labels: [],
          drives: ["REQ-AUTH-001"],
          tests: ["keeps the user session fresh"],
          execution: {
            red: { applicability: "must", status: "passed", evidence_refs: [] },
            implement: { applicability: "must", status: "running", evidence_refs: [] },
            refactor: { applicability: "optional", status: "na", evidence_refs: [] },
          },
        },
        {
          id: "T-002",
          kind: "chore",
          status: "done",
          depends_on: [],
          labels: [],
          no_test_rationale: "routine operational task",
          execution: { execute: { applicability: "must", status: "passed", evidence_refs: [] } },
        },
      ],
    },
    evidence: {
      schema_version: 2,
      evidence: [
        {
          schema_version: 2,
          at: "2026-06-01T10:30:00.000Z",
          id: "EV-000001",
          kind: "local-check",
          iteration: 2,
          actor: "agent:codex",
          result: "passed",
          summary:
            "typecheck and vitest passed with a long enough summary that the TUI detail model must truncate it",
          covers: [],
          task_id: "T-001",
        },
        {
          schema_version: 2,
          at: "2026-06-01T10:35:00.000Z",
          id: "EV-000002",
          kind: "verify-review",
          iteration: 2,
          actor: "agent:reviewer",
          result: "failed",
          summary: { mode: "inline", text: "review found a detail rendering regression" },
          covers: [],
        },
      ],
    },
    findings: {
      schema_version: 2,
      findings: [
        {
          id: "FND-001",
          category: "impl-defect",
          action: "fix-impl",
          status: "open",
          summary: "needs repair",
          reason: "detail evidence projection was dropped before rendering",
          target: { task_id: "T-001", step: "implement" },
        },
        { id: "FND-002", category: "test-defect", action: "fix-test", status: "closed", summary: "already closed" },
      ],
    },
    pending: {
      schema_version: 2,
      pending: [
        {
          pending_id: "PEND-0001",
          kind: "gate_decision",
          question: "approve the gate?",
          options: ["approve", "reject"],
          blocks: "gate",
          raised_at: "2026-06-01T10:00:00.000Z",
          raised_by: "human:est9",
          at: "2026-06-01T10:00:00.000Z",
          resolved: false,
        },
        {
          pending_id: "PEND-0002",
          kind: "spec_clarification",
          question: "old question",
          blocks: "advance",
          raised_at: "2026-06-01T09:00:00.000Z",
          raised_by: "human:est9",
          at: "2026-06-01T09:00:00.000Z",
          resolved: true,
        },
      ],
    },
    meta: {
      last_applied_seq: 7,
      last_entry_offset: 123,
      last_entry_line_hash: "a".repeat(64),
      rolling_checksum: "b".repeat(64),
      feature_schema_version: 2,
      written_at: "2026-06-01T10:00:00.000Z",
    },
  };
}

describe("shapeDetailViewModel", () => {
  test("projects loaded state into the TUI detail view model", () => {
    const row = makeRow({ session_id_short: "550e8400", feature: "auth-refresh" });
    expect(shapeDetailViewModel(row, makeLoaded(), FIXED_NOW, DEFAULT_I18N)).toEqual({
      feature: "auth-refresh",
      session_id_short: "550e8400",
      session_label: null,
      workspace: "default",
      ceremony_label: "standard",
      phase: "Execute",
      sub_state: "Execute / running task",
      iteration: 2,
      complexity_score: "n/a",
      based_on: { spec: 1, tasks: 1 },
      created_at_relative: "2 hours ago",
      updated_at_relative: "1 hour ago",
      spec_locked: true,
      verify_accepted: false,
      spec_version: 3,
      tail_seq: 7,
      tasks: [
        { id: "T-001", kind: "Behavioral", status: "in_progress", title: null, step_summary: "1/3 done" },
        { id: "T-002", kind: "Chore", status: "done", title: null, step_summary: "1/1 done" },
      ],
      evidence: [
        {
          id: "EV-000001",
          kind: "Local check",
          result: "passed",
          result_badge: "pass",
          summary: "typecheck and vitest passed with a long enough summary that the TUI detail…",
          iteration: 2,
          task_id: "T-001",
        },
        {
          id: "EV-000002",
          kind: "Code review",
          result: "failed",
          result_badge: "fail",
          summary: "review found a detail rendering regression",
          iteration: 2,
          task_id: null,
        },
      ],
      open_findings: [
        {
          id: "FND-001",
          category: "Implementation defect",
          action: "Fix implementation",
          summary: "needs repair",
          reason: "detail evidence projection was dropped before rendering",
          target: "T-001/implement",
        },
      ],
      pending: [
        {
          pending_id: "PEND-0001",
          kind: "Gate awaiting human decision",
          question: "approve the gate?",
          blocks: "gate",
          options: ["approve", "reject"],
        },
      ],
    });
  });

  test("handles absent tasks projection as an empty task list", () => {
    const loaded = { ...makeLoaded(), tasks: null };
    expect(shapeDetailViewModel(makeRow(), loaded, FIXED_NOW, DEFAULT_I18N).tasks).toEqual([]);
  });

  test("fills optional finding and pending display fields with explicit empty values", () => {
    const loaded: DetailProjectionLoad = {
      ...makeLoaded(),
      findings: {
        schema_version: 2 as const,
        findings: [
          { id: "FND-003", category: "spec-gap", action: "amend-spec", status: "open" },
        ],
      },
      pending: {
        schema_version: 2 as const,
        pending: [
          {
            pending_id: "PEND-0003",
            kind: "spec_clarification",
            question: "which behavior should the spec require?",
            blocks: "advance",
            raised_at: "2026-06-01T10:00:00.000Z",
            raised_by: "human:est9",
            at: "2026-06-01T10:00:00.000Z",
            resolved: false,
          },
        ],
      },
    };

    const vm = shapeDetailViewModel(makeRow(), loaded, FIXED_NOW, DEFAULT_I18N);

    expect(vm.open_findings).toEqual([
      {
        id: "FND-003",
        category: "Spec gap",
        action: "Amend spec",
        summary: "",
        reason: "",
        target: null,
      },
    ]);
    expect(vm.pending).toEqual([
      {
        pending_id: "PEND-0003",
        kind: "Spec clarification needed",
        question: "which behavior should the spec require?",
        blocks: "advance",
        options: [],
      },
    ]);
  });

  test("localizes enum labels in zh", () => {
    const vm = shapeDetailViewModel(makeRow(), makeLoaded(), FIXED_NOW, ZH_I18N);
    expect(vm.phase).toBe("执行");
    expect(vm.sub_state).toBe("执行 / 任务进行中");
    expect(vm.tasks[0]!.kind).toBe("行为");
    expect(vm.tasks[0]!.status).toBe("进行中");
    expect(vm.tasks[0]!.step_summary).toBe("1/3 已完成");
    expect(vm.created_at_relative).toBe("2 小时前");
    expect(vm.updated_at_relative).toBe("1 小时前");
    expect(vm.evidence[0]!.kind).toBe("本地检查");
    expect(vm.open_findings[0]!.category).toBe("实现缺陷");
    expect(vm.open_findings[0]!.action).toBe("修实现");
    expect(vm.pending[0]!.kind).toBe("Gate 等待人工决策");
  });

  test("localizes sidecar summary prefix in zh", () => {
    const loaded = makeLoaded();
    loaded.evidence.evidence[0]!.summary = {
      mode: "sidecar",
      ref: { path: "evidence/local-check.txt", sha256: "a".repeat(64), size: 123 },
    };

    const vm = shapeDetailViewModel(makeRow(), loaded, FIXED_NOW, ZH_I18N);
    expect(vm.evidence[0]!.summary).toBe("旁载:evidence/local-check.txt");
  });
});

describe("classifyDetailOutcome", () => {
  const row = makeRow();

  test("success maps to ready with a view model", () => {
    const result = classifyDetailOutcome(row, { ok: true, loaded: makeLoaded() }, FIXED_NOW, DEFAULT_I18N);
    expect(result.status).toBe("ready");
    expect(result.status === "ready" ? result.vm.tail_seq : null).toBe(7);
  });

  test("NoSessionError maps to missing", () => {
    expect(classifyDetailOutcome(row, {
      ok: false,
      error: new NoSessionError({ feature_dir: "/repo/.loaf/auth-refresh", fix: "run `loaf start <feature>` first" }),
    }, FIXED_NOW, DEFAULT_I18N)).toEqual({
      status: "missing",
      message: "run `loaf start auth-refresh` first",
      fix: "run `loaf start <feature>` first",
    });
  });

  test("NoSessionError localizes missing message in zh", () => {
    expect(classifyDetailOutcome(row, {
      ok: false,
      error: new NoSessionError({ feature_dir: "/repo/.loaf/auth-refresh", fix: "run `loaf start <feature>` first" }),
    }, FIXED_NOW, ZH_I18N)).toEqual({
      status: "missing",
      message: "先运行 `loaf start auth-refresh`",
      fix: "run `loaf start <feature>` first",
    });
  });

  test("SnapshotStaleError maps to stale", () => {
    expect(classifyDetailOutcome(row, {
      ok: false,
      error: new SnapshotStaleError("tail_offset_mismatch", { fix: "run `loaf doctor --rebuild --feature auth-refresh`" }),
    }, FIXED_NOW, DEFAULT_I18N)).toEqual({
      status: "stale",
      reason: "tail_offset_mismatch",
      message: "snapshot stale (reason=tail_offset_mismatch)",
      fix: "run `loaf doctor --rebuild --feature auth-refresh`",
    });
  });

  test("SnapshotStaleError localizes stale message in zh", () => {
    expect(classifyDetailOutcome(row, {
      ok: false,
      error: new SnapshotStaleError("tail_offset_mismatch", { fix: "run `loaf doctor --rebuild --feature auth-refresh`" }),
    }, FIXED_NOW, ZH_I18N)).toEqual({
      status: "stale",
      reason: "tail_offset_mismatch",
      message: "快照过期(reason=tail_offset_mismatch)",
      fix: "run `loaf doctor --rebuild --feature auth-refresh`",
    });
  });

  test("unexpected errors map to error", () => {
    expect(classifyDetailOutcome(row, {
      ok: false,
      error: new Error("boom"),
    }, FIXED_NOW, DEFAULT_I18N)).toEqual({
      status: "error",
      message: "boom",
    });
  });
});
