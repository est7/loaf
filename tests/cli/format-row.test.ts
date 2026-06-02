// Phase 16 SC-14 — pure tests for TUI column formatters.
//
// Carries the behavior contract for the `loaf tui` MVP per codex r355
// Q3 (option 3 boundary). Ink component (`src/cli/tui/app.tsx`) renders
// the strings these helpers produce; no Ink snapshot test elsewhere.

import { describe, expect, test } from "vitest";

import {
  COLUMN_MIN_WIDTHS,
  chooseLabelSource,
  computeColumnWidths,
  formatIteration,
  formatLabel,
  formatPhaseSub,
  formatStatus,
  formatStatusBadge,
} from "../../src/cli/tui/format-row.js";
import type { SessionRow } from "../../src/cli/sessions-list.js";

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    session_id_short: "550e8400",
    session_label: "",
    feature: "auth-refresh",
    phase: "EXECUTE",
    sub_state: "EXECUTE.work",
    at: "2026-05-29T07:00:00.000Z",
    cwd: "/Users/dev/proj",
    workspace: "default",
    iteration: 1,
    pending_queue_depth: 0,
    active_tasks: [],
    ceremony_label: "standard",
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────
// chooseLabelSource + formatLabel
// ───────────────────────────────────────────────────────────────────────
describe("chooseLabelSource — session_label fallback to feature", () => {
  test("non-empty session_label wins", () => {
    expect(chooseLabelSource(makeRow({ session_label: "popposhell · auth refresh" }))).toBe("popposhell · auth refresh");
  });

  test("empty session_label falls back to feature", () => {
    expect(chooseLabelSource(makeRow({ session_label: "" }))).toBe("auth-refresh");
  });

  test("whitespace-only session_label falls back to feature", () => {
    expect(chooseLabelSource(makeRow({ session_label: "   " }))).toBe("auth-refresh");
  });
});

describe("formatLabel — truncation with ellipsis", () => {
  test("shorter than maxWidth → no truncation", () => {
    expect(formatLabel(makeRow({ feature: "auth-refresh" }), 20)).toBe("auth-refresh");
  });

  test("exact maxWidth → no truncation", () => {
    expect(formatLabel(makeRow({ feature: "exactly-12ch" }), 12)).toBe("exactly-12ch");
  });

  test("longer than maxWidth → ellipsis truncate", () => {
    expect(formatLabel(makeRow({ feature: "very-long-feature-name" }), 10)).toBe("very-long…");
  });

  test("uses session_label when present", () => {
    expect(formatLabel(makeRow({ session_label: "popposhell · auth", feature: "auth-refresh" }), 20)).toBe("popposhell · auth");
  });
});

// ───────────────────────────────────────────────────────────────────────
// formatStatus — codex r354 P2 precedence
// ───────────────────────────────────────────────────────────────────────
describe("formatStatus — codex r354 P2 precedence order", () => {
  test("DONE.* wins over everything (✓ done)", () => {
    expect(formatStatus(makeRow({
      sub_state: "DONE.delivered",
      pending_queue_depth: 5,
      active_tasks: ["T-001", "T-002"],
    }))).toBe("✓ done");
  });

  test("DONE.archived also wins", () => {
    expect(formatStatus(makeRow({ sub_state: "DONE.archived" }))).toBe("✓ done");
  });

  test("pending depth 1 → '‖ ask' (no count badge for N=1)", () => {
    expect(formatStatus(makeRow({ pending_queue_depth: 1 }))).toBe("‖ ask");
  });

  test("pending depth 3 → '‖ ask [×3]'", () => {
    expect(formatStatus(makeRow({ pending_queue_depth: 3 }))).toBe("‖ ask [×3]");
  });

  test("pending wins over active_tasks (gate-blocking semantic)", () => {
    expect(formatStatus(makeRow({
      pending_queue_depth: 1,
      active_tasks: ["T-001", "T-002"],
    }))).toBe("‖ ask");
  });

  test("active_tasks 1 → '▶ run'", () => {
    expect(formatStatus(makeRow({ active_tasks: ["T-001"] }))).toBe("▶ run");
  });

  test("active_tasks 3 → '▶ run [×3]'", () => {
    expect(formatStatus(makeRow({ active_tasks: ["T-001", "T-002", "T-003"] }))).toBe("▶ run [×3]");
  });

  test("idle (no pending, no active, non-DONE) → raw sub_state", () => {
    expect(formatStatus(makeRow({ sub_state: "VERIFY.accept" }))).toBe("VERIFY.accept");
  });
});

describe("formatStatusBadge — display badge without idle sub_state duplication", () => {
  test.each([
    [
      "done",
      makeRow({ sub_state: "DONE.delivered", pending_queue_depth: 5, active_tasks: ["T-001"] }),
      "✓ done",
    ],
    [
      "blocked",
      makeRow({ pending_queue_depth: 3, active_tasks: ["T-001"] }),
      "‖ ask [×3]",
    ],
    [
      "running",
      makeRow({ active_tasks: ["T-001", "T-002"] }),
      "▶ run [×2]",
    ],
    [
      "idle",
      makeRow({ sub_state: "EXECUTE.work" }),
      "idle",
    ],
  ] as const)("%s badge", (_name, row, expected) => {
    expect(formatStatusBadge(row)).toBe(expected);
  });

  test("idle badge does not repeat sub_state", () => {
    expect(formatStatusBadge(makeRow({ sub_state: "VERIFY.accept" }))).not.toBe("VERIFY.accept");
  });
});

// ───────────────────────────────────────────────────────────────────────
// formatPhaseSub + formatIteration
// ───────────────────────────────────────────────────────────────────────
describe("formatPhaseSub + formatIteration", () => {
  test("formatPhaseSub returns sub_state literal", () => {
    expect(formatPhaseSub(makeRow({ sub_state: "EXECUTE.work" }))).toBe("EXECUTE.work");
  });

  test("formatIteration returns decimal string", () => {
    expect(formatIteration(makeRow({ iteration: 7 }))).toBe("7");
  });
});

// ───────────────────────────────────────────────────────────────────────
// computeColumnWidths
// ───────────────────────────────────────────────────────────────────────
describe("computeColumnWidths — sizing across rows", () => {
  test("empty rows → minimum widths", () => {
    expect(computeColumnWidths([])).toEqual({
      label: COLUMN_MIN_WIDTHS.label,
      phase_sub: COLUMN_MIN_WIDTHS.phase_sub,
      iter: COLUMN_MIN_WIDTHS.iter,
      status: COLUMN_MIN_WIDTHS.status,
    });
  });

  test("longer label expands the column up to maxLabelWidth", () => {
    const rows = [
      makeRow({ feature: "very-long-feature-name-here" }),
      makeRow({ feature: "short" }),
    ];
    const widths = computeColumnWidths(rows, 40);
    expect(widths.label).toBe("very-long-feature-name-here".length);
  });

  test("respects maxLabelWidth cap", () => {
    const rows = [
      makeRow({ feature: "a".repeat(100) }),
    ];
    const widths = computeColumnWidths(rows, 20);
    expect(widths.label).toBe(20);
  });

  test("status column expands to fit longest status text", () => {
    const rows = [
      makeRow({ active_tasks: Array.from({ length: 99 }, (_, i) => `T-${String(i + 1).padStart(3, "0")}`) }),
    ];
    const widths = computeColumnWidths(rows);
    // Status "▶ run [×99]" is longer than the min 12, but may still be
    // within bound. Just assert it's at least the literal length.
    expect(widths.status).toBeGreaterThanOrEqual("▶ run [×99]".length);
  });
});
