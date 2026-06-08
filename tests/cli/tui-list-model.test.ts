// Slice 1 — pure list-model tests for the `loaf tui` master list.
//
// This file intentionally exercises pure helpers only. Ink/App wiring is
// deferred to Slice 2.

import { describe, expect, test } from "vitest";

import type { SessionRow } from "../../src/cli/sessions-list.js";
import {
  buildRenderPlan,
  filterActive,
  groupByProjectFeature,
  nextSelectableIndex,
  resolveSelectionAfterRebuild,
  statusBucket,
  toggleCollapsed,
  withTreePrefixes,
  type TuiListItem,
} from "../../src/cli/tui/list-model.js";

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

function itemKeys(items: ReadonlyArray<TuiListItem>): string[] {
  return items.map((item) => item.key);
}

describe("statusBucket", () => {
  test.each([
    [
      "done wins over pending and running",
      makeRow({ sub_state: "DONE.delivered", pending_queue_depth: 2, active_tasks: ["T-001"] }),
      "done",
    ],
    [
      "pending queue marks blocked",
      makeRow({ pending_queue_depth: 1, active_tasks: ["T-001"] }),
      "blocked",
    ],
    ["active tasks mark running", makeRow({ active_tasks: ["T-001"] }), "running"],
    [
      "non-terminal row with no pending or active work is idle",
      makeRow({ sub_state: "VERIFY.accept" }),
      "idle",
    ],
  ] as const)("%s", (_name, row, expected) => {
    expect(statusBucket(row)).toBe(expected);
  });
});

describe("filterActive", () => {
  const active = makeRow({
    session_id: "aaaaaaaa-0000-4000-8000-000000000001",
    sub_state: "EXECUTE.work",
  });
  const done = makeRow({
    session_id: "bbbbbbbb-0000-4000-8000-000000000002",
    sub_state: "DONE.delivered",
  });

  test("showAll=false removes DONE.* rows", () => {
    expect(filterActive([active, done], false).map((row) => row.session_id)).toEqual([
      active.session_id,
    ]);
  });

  test("showAll=true preserves active and DONE.* rows", () => {
    expect(filterActive([active, done], true).map((row) => row.session_id)).toEqual([
      active.session_id,
      done.session_id,
    ]);
  });
});

describe("groupByProjectFeature", () => {
  test("builds project -> feature groups without redefining SessionRow", () => {
    const rows = [
      makeRow({
        session_id: "aaaaaaaa-0000-4000-8000-000000000001",
        cwd: "/repo/a",
        feature: "alpha",
      }),
      makeRow({
        session_id: "bbbbbbbb-0000-4000-8000-000000000002",
        cwd: "/repo/a",
        feature: "beta",
      }),
      makeRow({
        session_id: "cccccccc-0000-4000-8000-000000000003",
        cwd: "/repo/b",
        feature: "alpha",
      }),
      makeRow({
        session_id: "dddddddd-0000-4000-8000-000000000004",
        cwd: "/repo/a",
        feature: "alpha",
      }),
    ];

    expect(groupByProjectFeature(rows)).toEqual([
      {
        cwd: "/repo/a",
        visible_session_count: 3,
        features: [
          {
            cwd: "/repo/a",
            feature: "alpha",
            visible_session_count: 2,
            sessions: [rows[0], rows[3]],
          },
          {
            cwd: "/repo/a",
            feature: "beta",
            visible_session_count: 1,
            sessions: [rows[1]],
          },
        ],
      },
      {
        cwd: "/repo/b",
        visible_session_count: 1,
        features: [
          {
            cwd: "/repo/b",
            feature: "alpha",
            visible_session_count: 1,
            sessions: [rows[2]],
          },
        ],
      },
    ]);
  });
});

describe("buildRenderPlan", () => {
  test("returns an empty plan for empty input", () => {
    expect(buildRenderPlan([], { showAll: false, sortMode: "time", collapsed: new Set() })).toEqual(
      [],
    );
  });

  test("uses stable keys for project, feature, and session items", () => {
    const row = makeRow({
      session_id: "aaaaaaaa-0000-4000-8000-000000000001",
      cwd: "/repo/a",
      feature: "alpha",
    });

    expect(
      itemKeys(buildRenderPlan([row], { showAll: false, sortMode: "time", collapsed: new Set() })),
    ).toEqual([
      "project:/repo/a",
      "feature:/repo/a:alpha",
      "session:aaaaaaaa-0000-4000-8000-000000000001",
    ]);
  });

  test("sortMode=time sorts projects, features, and sessions by latest visible session", () => {
    const rows = [
      makeRow({
        session_id: "aaaaaaaa-0000-4000-8000-000000000001",
        cwd: "/repo/old",
        feature: "old-feature",
        at: "2026-06-01T09:00:00.000Z",
      }),
      makeRow({
        session_id: "bbbbbbbb-0000-4000-8000-000000000002",
        cwd: "/repo/new",
        feature: "zeta",
        at: "2026-06-01T11:00:00.000Z",
      }),
      makeRow({
        session_id: "cccccccc-0000-4000-8000-000000000003",
        cwd: "/repo/new",
        feature: "alpha",
        at: "2026-06-01T12:00:00.000Z",
      }),
      makeRow({
        session_id: "dddddddd-0000-4000-8000-000000000004",
        cwd: "/repo/new",
        feature: "alpha",
        at: "2026-06-01T10:00:00.000Z",
      }),
    ];

    expect(
      itemKeys(buildRenderPlan(rows, { showAll: false, sortMode: "time", collapsed: new Set() })),
    ).toEqual([
      "project:/repo/new",
      "feature:/repo/new:alpha",
      "session:cccccccc-0000-4000-8000-000000000003",
      "session:dddddddd-0000-4000-8000-000000000004",
      "feature:/repo/new:zeta",
      "session:bbbbbbbb-0000-4000-8000-000000000002",
      "project:/repo/old",
      "feature:/repo/old:old-feature",
      "session:aaaaaaaa-0000-4000-8000-000000000001",
    ]);
  });

  test("showAll=false removes DONE.* rows before group counts and render items", () => {
    const active = makeRow({
      session_id: "aaaaaaaa-0000-4000-8000-000000000001",
      cwd: "/repo/a",
      feature: "alpha",
      sub_state: "EXECUTE.work",
    });
    const done = makeRow({
      session_id: "bbbbbbbb-0000-4000-8000-000000000002",
      cwd: "/repo/a",
      feature: "alpha",
      sub_state: "DONE.delivered",
    });

    const plan = buildRenderPlan([active, done], {
      showAll: false,
      sortMode: "time",
      collapsed: new Set(),
    });

    expect(plan).toEqual([
      {
        kind: "project",
        key: "project:/repo/a",
        cwd: "/repo/a",
        visible_session_count: 1,
        collapsed: false,
      },
      {
        kind: "feature",
        key: "feature:/repo/a:alpha",
        cwd: "/repo/a",
        feature: "alpha",
        visible_session_count: 1,
        collapsed: false,
      },
      {
        kind: "session",
        key: "session:aaaaaaaa-0000-4000-8000-000000000001",
        row: active,
        detail_status: "unknown",
      },
    ]);
  });

  test("sortMode=status sorts sessions by blocked, running, idle, done, then time descending", () => {
    const rows = [
      makeRow({
        session_id: "idle1111-0000-4000-8000-000000000001",
        at: "2026-06-01T13:00:00.000Z",
        sub_state: "VERIFY.accept",
      }),
      makeRow({
        session_id: "done1111-0000-4000-8000-000000000002",
        at: "2026-06-01T14:00:00.000Z",
        sub_state: "DONE.delivered",
      }),
      makeRow({
        session_id: "run11111-0000-4000-8000-000000000003",
        at: "2026-06-01T11:00:00.000Z",
        active_tasks: ["T-001"],
      }),
      makeRow({
        session_id: "block111-0000-4000-8000-000000000004",
        at: "2026-06-01T10:00:00.000Z",
        pending_queue_depth: 1,
      }),
      makeRow({
        session_id: "block222-0000-4000-8000-000000000005",
        at: "2026-06-01T12:00:00.000Z",
        pending_queue_depth: 2,
      }),
    ];

    expect(
      itemKeys(buildRenderPlan(rows, { showAll: true, sortMode: "status", collapsed: new Set() })),
    ).toEqual([
      "project:/Users/dev/project-a",
      "feature:/Users/dev/project-a:auth-refresh",
      "session:block222-0000-4000-8000-000000000005",
      "session:block111-0000-4000-8000-000000000004",
      "session:run11111-0000-4000-8000-000000000003",
      "session:idle1111-0000-4000-8000-000000000001",
      "session:done1111-0000-4000-8000-000000000002",
    ]);
  });

  test("collapsed project hides features and sessions", () => {
    const row = makeRow({
      session_id: "aaaaaaaa-0000-4000-8000-000000000001",
      cwd: "/repo/a",
      feature: "alpha",
    });

    const plan = buildRenderPlan([row], {
      showAll: false,
      sortMode: "time",
      collapsed: new Set(["project:/repo/a"]),
    });

    expect(itemKeys(plan)).toEqual(["project:/repo/a"]);
    expect(plan).toEqual([
      {
        kind: "project",
        key: "project:/repo/a",
        cwd: "/repo/a",
        visible_session_count: 1,
        collapsed: true,
      },
    ]);
  });

  test("collapsed feature hides only its sessions", () => {
    const row = makeRow({
      session_id: "aaaaaaaa-0000-4000-8000-000000000001",
      cwd: "/repo/a",
      feature: "alpha",
    });

    const plan = buildRenderPlan([row], {
      showAll: false,
      sortMode: "time",
      collapsed: new Set(["feature:/repo/a:alpha"]),
    });

    expect(itemKeys(plan)).toEqual(["project:/repo/a", "feature:/repo/a:alpha"]);
    expect(plan[1]).toEqual({
      kind: "feature",
      key: "feature:/repo/a:alpha",
      cwd: "/repo/a",
      feature: "alpha",
      visible_session_count: 1,
      collapsed: true,
    });
  });

  test("session items start with unknown detail status", () => {
    const row = makeRow({
      session_id: "aaaaaaaa-0000-4000-8000-000000000001",
      cwd: "/repo/a",
      feature: "alpha",
    });

    const plan = buildRenderPlan([row], { showAll: false, sortMode: "time", collapsed: new Set() });

    expect(plan[2]).toEqual({
      kind: "session",
      key: "session:aaaaaaaa-0000-4000-8000-000000000001",
      row,
      detail_status: "unknown",
    });
  });
});

describe("navigation helpers", () => {
  const plan: TuiListItem[] = [
    {
      kind: "project",
      key: "project:/repo/a",
      cwd: "/repo/a",
      visible_session_count: 1,
      collapsed: false,
    },
    {
      kind: "feature",
      key: "feature:/repo/a:alpha",
      cwd: "/repo/a",
      feature: "alpha",
      visible_session_count: 1,
      collapsed: false,
    },
    {
      kind: "session",
      key: "session:aaaaaaaa-0000-4000-8000-000000000001",
      row: makeRow({ session_id: "aaaaaaaa-0000-4000-8000-000000000001" }),
      detail_status: "unknown",
    },
  ];

  test.each([
    ["down from first moves to second", 0, 1, 1],
    ["down at end clamps", 2, 1, 2],
    ["up from last moves to second", 2, -1, 1],
    ["up at start clamps", 0, -1, 0],
    ["negative current index enters at start on down", -1, 1, 0],
    ["negative current index stays empty on up", -1, -1, 0],
  ] as const)("nextSelectableIndex — %s", (_name, currentIndex, dir, expected) => {
    expect(nextSelectableIndex(plan, currentIndex, dir)).toBe(expected);
  });

  test("nextSelectableIndex returns -1 for empty plans", () => {
    expect(nextSelectableIndex([], 0, 1)).toBe(-1);
  });

  test("resolveSelectionAfterRebuild keeps the selected key when it is still visible", () => {
    expect(resolveSelectionAfterRebuild(plan, "feature:/repo/a:alpha")).toEqual({
      selectedKey: "feature:/repo/a:alpha",
      index: 1,
    });
  });

  test("resolveSelectionAfterRebuild clamps to the first visible item when the previous key is gone", () => {
    expect(resolveSelectionAfterRebuild(plan, "session:missing")).toEqual({
      selectedKey: "project:/repo/a",
      index: 0,
    });
  });

  test("resolveSelectionAfterRebuild returns null selection for empty plans", () => {
    expect(resolveSelectionAfterRebuild([], "session:missing")).toEqual({
      selectedKey: null,
      index: -1,
    });
  });

  test("toggleCollapsed returns a new Set when adding or removing a key", () => {
    const before = new Set(["project:/repo/a"]);
    const added = toggleCollapsed(before, "feature:/repo/a:alpha");
    const removed = toggleCollapsed(before, "project:/repo/a");

    expect(added).not.toBe(before);
    expect(Array.from(added).sort()).toEqual(["feature:/repo/a:alpha", "project:/repo/a"]);
    expect(removed).not.toBe(before);
    expect(Array.from(removed)).toEqual([]);
    expect(Array.from(before)).toEqual(["project:/repo/a"]);
  });
});

describe("withTreePrefixes", () => {
  test("adds project -> feature -> session connector prefixes from the visible plan", () => {
    const rows = [
      makeRow({
        session_id: "aaaaaaaa-0000-4000-8000-000000000001",
        cwd: "/repo/a",
        feature: "alpha",
        at: "2026-06-01T12:00:00.000Z",
      }),
      makeRow({
        session_id: "bbbbbbbb-0000-4000-8000-000000000002",
        cwd: "/repo/a",
        feature: "alpha",
        at: "2026-06-01T11:00:00.000Z",
      }),
      makeRow({
        session_id: "cccccccc-0000-4000-8000-000000000003",
        cwd: "/repo/a",
        feature: "beta",
        at: "2026-06-01T10:00:00.000Z",
      }),
      makeRow({
        session_id: "dddddddd-0000-4000-8000-000000000004",
        cwd: "/repo/b",
        feature: "search",
        at: "2026-06-01T09:00:00.000Z",
      }),
    ];

    const plan = buildRenderPlan(rows, { showAll: false, sortMode: "time", collapsed: new Set() });

    expect(withTreePrefixes(plan).map(({ item, prefix }) => [item.key, prefix])).toEqual([
      ["project:/repo/a", ""],
      ["feature:/repo/a:alpha", "├─ "],
      ["session:aaaaaaaa-0000-4000-8000-000000000001", "│ ├─ "],
      ["session:bbbbbbbb-0000-4000-8000-000000000002", "│ └─ "],
      ["feature:/repo/a:beta", "└─ "],
      ["session:cccccccc-0000-4000-8000-000000000003", "  └─ "],
      ["project:/repo/b", ""],
      ["feature:/repo/b:search", "└─ "],
      ["session:dddddddd-0000-4000-8000-000000000004", "  └─ "],
    ]);
  });

  test("does not synthesize child prefixes for collapsed headers", () => {
    const row = makeRow({
      session_id: "aaaaaaaa-0000-4000-8000-000000000001",
      cwd: "/repo/a",
      feature: "alpha",
    });
    const plan = buildRenderPlan([row], {
      showAll: false,
      sortMode: "time",
      collapsed: new Set(["feature:/repo/a:alpha"]),
    });

    expect(withTreePrefixes(plan).map(({ item, prefix }) => [item.key, prefix])).toEqual([
      ["project:/repo/a", ""],
      ["feature:/repo/a:alpha", "└─ "],
    ]);
  });
});
