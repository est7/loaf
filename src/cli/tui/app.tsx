// Phase 16 SC-14/15 — thin Ink TUI for `loaf tui`.
//
// Renders the master session list from `list-model.ts` pure helpers.
// Hotkeys:
//   - ↑ / ↓        → move selection
//   - Space        → fold/unfold project or feature headers
//   - `a`          → toggle active-only/all
//   - `s`          → toggle time/status sort
//   - `r`          → reload registry via injected `loadRows` closure
//   - `q` / Ctrl-C → exit
//
// Selection math, filtering, grouping, sorting, and render-plan construction
// sit in pure helpers — this component is intentionally thin per codex r355
// Q3 + r356 layering ack.

import { useState, useCallback, useEffect, useMemo, type ReactElement } from "react";
import { Box, Text, useApp, useInput } from "ink";

import type { SessionRow } from "../sessions-list.js";
import type { I18n } from "../i18n.js";
import type { DetailLoadResult, DetailViewModel } from "./detail-model.js";
import { formatIteration, formatPhaseSub, formatStatusBadge } from "./format-row.js";
import {
  formatTuiBoolean,
  formatTuiDetailBasedOn,
  formatTuiDetailEvidenceBadge,
  formatTuiDetailField,
  formatTuiDetailHelp,
  formatTuiDetailNone,
  formatTuiDetailSectionTitle,
  formatTuiListHelp,
  formatTuiListRowIteration,
  formatTuiListTitle,
  formatTuiSortLabel,
} from "./chrome.js";
import {
  buildRenderPlan,
  filterActive,
  nextSelectableIndex,
  resolveSelectionAfterRebuild,
  toggleCollapsed,
  withTreePrefixes,
  type TuiTreeListItem,
  type TuiSortMode,
} from "./list-model.js";

export interface AppProps {
  /** Initial rows captured at startup; r reloads via loadRows. */
  initialRows: ReadonlyArray<SessionRow>;
  /** Closure to re-read registry on [r] press. Preserves
   *  deps.registryDir / LOAF_REGISTRY_DIR per codex r357 guardrail 2 —
   *  the App does NOT silently fall back to the real user registry
   *  during tests. */
  loadRows: () => Promise<ReadonlyArray<SessionRow>>;
  /** Lazy detail loader injected by cli.tsx. App never imports or calls
   *  loadProjections directly. */
  loadDetail: (row: SessionRow) => Promise<DetailLoadResult>;
  /** Resolved CLI presentation locale. */
  i18n: I18n;
}

type AppMode = "list" | "detail";

interface DetailState {
  row: SessionRow;
  result: DetailLoadResult | null;
}

export function App({ initialRows, loadRows, loadDetail, i18n }: AppProps): ReactElement {
  const { exit } = useApp();
  const [rows, setRows] = useState<ReadonlyArray<SessionRow>>(initialRows);
  const [reloading, setReloading] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [sortMode, setSortMode] = useState<TuiSortMode>("time");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [mode, setMode] = useState<AppMode>("list");
  const [detail, setDetail] = useState<DetailState | null>(null);

  const plan = useMemo(
    () => buildRenderPlan(rows, { showAll, sortMode, collapsed }),
    [rows, showAll, sortMode, collapsed],
  );
  const selection = useMemo(
    () => resolveSelectionAfterRebuild(plan, selectedKey),
    [plan, selectedKey],
  );
  const treePlan = useMemo(() => withTreePrefixes(plan), [plan]);
  const activeCount = useMemo(() => filterActive(rows, false).length, [rows]);

  const handleReload = useCallback(async () => {
    if (reloading) return;
    setReloading(true);
    try {
      const next = await loadRows();
      setRows(next);
    } finally {
      setReloading(false);
    }
  }, [loadRows, reloading]);

  const handleOpenDetail = useCallback((row: SessionRow) => {
    setMode("detail");
    setDetail({ row, result: null });
    void loadDetail(row)
      .then((result) => {
        setDetail((current) => current?.row.session_id === row.session_id ? { row, result } : current);
      })
      .catch((error) => {
        setDetail((current) => current?.row.session_id === row.session_id
          ? { row, result: unexpectedDetailError(error) }
          : current);
      });
  }, [loadDetail]);

  useEffect(() => {
    if (selectedKey !== selection.selectedKey) {
      setSelectedKey(selection.selectedKey);
    }
  }, [selectedKey, selection.selectedKey]);

  useInput((input, key) => {
    if (input === "q" || key.ctrl && input === "c") {
      exit();
      return;
    }
    if (key.escape) {
      if (mode === "detail") {
        setMode("list");
        return;
      }
      exit();
      return;
    }
    if (mode === "detail") {
      return;
    }
    if (key.upArrow || key.downArrow) {
      const nextIndex = nextSelectableIndex(plan, selection.index, key.downArrow ? 1 : -1);
      const nextItem = nextIndex >= 0 ? plan[nextIndex] : undefined;
      setSelectedKey(nextItem?.key ?? null);
      return;
    }
    if (input === " " || key.return) {
      const selectedItem = selection.index >= 0 ? plan[selection.index] : undefined;
      if (selectedItem?.kind === "project" || selectedItem?.kind === "feature") {
        setCollapsed((prev) => toggleCollapsed(prev, selectedItem.key));
        setSelectedKey(selectedItem.key);
      }
      if (key.return && selectedItem?.kind === "session") {
        handleOpenDetail(selectedItem.row);
      }
      return;
    }
    if (input === "a") {
      setShowAll((current) => !current);
      return;
    }
    if (input === "s") {
      setSortMode((current) => current === "time" ? "status" : "time");
      return;
    }
    if (input === "r") {
      void handleReload();
    }
  });

  if (mode === "detail") {
    return (
      <Box flexDirection="column" padding={1} width="100%">
        <Box borderStyle="round" flexDirection="column" paddingX={1} width="100%">
          <Text bold>{i18n.t(CHROME_KEYS.tuiDetailTitle)}</Text>
          {renderDetail(detail, i18n)}
        </Box>
        <Box marginTop={1} paddingX={1}>
          <Text dimColor>{formatTuiDetailHelp(i18n)}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1} width="100%">
      <Box borderStyle="round" flexDirection="column" paddingX={1} width="100%">
        <Box>
          <Text bold>{formatTuiListTitle(i18n, activeCount, rows.length)}</Text>
          <Text dimColor>{` · ${formatTuiSortLabel(i18n, sortMode)}`}</Text>
          {reloading && <Text dimColor>{` · ${i18n.t(CHROME_KEYS.tuiListReloading)}`}</Text>}
        </Box>
        {plan.length === 0 ? (
          <Text dimColor>{i18n.t(CHROME_KEYS.tuiListEmpty)}</Text>
        ) : (
          treePlan.map((treeItem) => renderItem(treeItem, treeItem.item.key === selection.selectedKey, i18n))
        )}
      </Box>
      <Box marginTop={1} paddingX={1}>
        <Text dimColor>{formatTuiListHelp(i18n)}</Text>
      </Box>
    </Box>
  );
}

function renderItem(treeItem: TuiTreeListItem, selected: boolean, i18n: I18n): ReactElement {
  const { item, prefix } = treeItem;
  const marker = selected ? ">" : " ";
  switch (item.kind) {
    case "project":
      return (
        <Box key={item.key}>
          <Text inverse={selected}>{`${marker} ${caret(item.collapsed)} ${item.cwd} (${item.visible_session_count})`}</Text>
        </Box>
      );
    case "feature":
      return (
        <Box key={item.key}>
          <Text inverse={selected}>{`${marker} ${prefix}${caret(item.collapsed)} ${item.feature} (${item.visible_session_count})`}</Text>
        </Box>
      );
    case "session":
      return (
        <Box key={item.key}>
          <Text inverse={selected}>{`${marker} ${prefix}${formatPhaseSub(item.row, i18n)} · ${formatTuiListRowIteration(i18n, formatIteration(item.row))} · ${formatStatusBadge(item.row, i18n)}`}</Text>
        </Box>
      );
  }
}

function caret(collapsed: boolean): string {
  return collapsed ? "▸" : "▾";
}

function renderDetail(detail: DetailState | null, i18n: I18n): ReactElement {
  if (detail === null) {
    return <Text dimColor>{i18n.t(CHROME_KEYS.tuiDetailNoSelected)}</Text>;
  }

  if (detail.result === null) {
    return (
      <Box flexDirection="column">
        <Text bold>{i18n.t(CHROME_KEYS.tuiDetailTitle)}</Text>
        <Text dimColor>{i18n.t(CHROME_KEYS.tuiDetailLoading)}</Text>
      </Box>
    );
  }

  switch (detail.result.status) {
    case "ready":
      return renderReadyDetail(detail.result.vm, i18n);
    case "missing":
      return (
        <Box flexDirection="column">
          <Text bold>{i18n.t(CHROME_KEYS.tuiDetailMissingTitle, { feature: detail.row.feature })}</Text>
          <Text>{detail.result.message}</Text>
          {detail.result.fix !== null && <Text dimColor>{detail.result.fix}</Text>}
        </Box>
      );
    case "stale":
      return (
        <Box flexDirection="column">
          <Text bold>{i18n.t(CHROME_KEYS.tuiDetailStaleTitle, { feature: detail.row.feature })}</Text>
          <Text>{detail.result.message}</Text>
          {detail.result.fix !== null && <Text dimColor>{detail.result.fix}</Text>}
        </Box>
      );
    case "error":
      return (
        <Box flexDirection="column">
          <Text bold>{i18n.t(CHROME_KEYS.tuiDetailErrorTitle, { feature: detail.row.feature })}</Text>
          <Text>{detail.result.message}</Text>
        </Box>
      );
  }
}

function renderReadyDetail(vm: DetailViewModel, i18n: I18n): ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold>{formatTuiDetailField(i18n, "feature", vm.feature)}</Text>
      <Text>{formatTuiDetailField(i18n, "session", vm.session_id_short)}</Text>
      <Text>{formatTuiDetailField(i18n, "label", vm.session_label ?? "n/a")}</Text>
      <Text>{formatTuiDetailField(i18n, "workspace", vm.workspace)}</Text>
      <Text>{formatTuiDetailField(i18n, "ceremony", vm.ceremony_label)}</Text>
      <Text>{formatTuiDetailField(i18n, "phase", vm.sub_state)}</Text>
      <Text>{formatTuiDetailField(i18n, "iteration", vm.iteration)}</Text>
      <Text>{formatTuiDetailField(i18n, "complexity", vm.complexity_score)}</Text>
      <Text>{formatTuiDetailBasedOn(i18n, vm.based_on.spec, vm.based_on.tasks)}</Text>
      <Text>{formatTuiDetailField(i18n, "created", vm.created_at_relative)}</Text>
      <Text>{formatTuiDetailField(i18n, "updated", vm.updated_at_relative)}</Text>
      <Text>{formatTuiDetailField(i18n, "spec_locked", formatTuiBoolean(i18n, vm.spec_locked))}</Text>
      <Text>{formatTuiDetailField(i18n, "verify_accepted", formatTuiBoolean(i18n, vm.verify_accepted))}</Text>
      <Text>{formatTuiDetailField(i18n, "spec_version", vm.spec_version)}</Text>
      <Text>{formatTuiDetailField(i18n, "tail_seq", vm.tail_seq)}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>{formatTuiDetailSectionTitle(i18n, "tasks", vm.tasks.length)}</Text>
        {vm.tasks.length === 0
          ? <Text dimColor>{`  ${formatTuiDetailNone(i18n)}`}</Text>
          : vm.tasks.map((task) => (
            <Text key={task.id}>
              {`  ${task.id} ${task.status} ${task.kind}${task.title === null ? "" : ` ${task.title}`} · ${i18n.t(CHROME_KEYS.tuiDetailRowSteps, { value: task.step_summary })}`}
            </Text>
          ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>{formatTuiDetailSectionTitle(i18n, "evidence", vm.evidence.length)}</Text>
        {vm.evidence.length === 0
          ? <Text dimColor>{`  ${formatTuiDetailNone(i18n)}`}</Text>
          : vm.evidence.map((evidence) => (
            <Text key={evidence.id}>
              {`  ${evidence.id} [${formatTuiDetailEvidenceBadge(i18n, evidence.result_badge)}] ${evidence.kind} ${i18n.t(CHROME_KEYS.tuiDetailRowIteration, { value: evidence.iteration })}${evidence.task_id === null ? "" : ` ${i18n.t(CHROME_KEYS.tuiDetailRowTask, { value: evidence.task_id })}`} · ${evidence.summary}`}
            </Text>
          ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>{formatTuiDetailSectionTitle(i18n, "open_findings", vm.open_findings.length)}</Text>
        {vm.open_findings.length === 0
          ? <Text dimColor>{`  ${formatTuiDetailNone(i18n)}`}</Text>
          : vm.open_findings.map((finding) => (
            <Text key={finding.id}>
              {`  ${finding.id} ${finding.category}/${finding.action}${finding.target === null ? "" : ` ${i18n.t(CHROME_KEYS.tuiDetailRowTarget, { value: finding.target })}`}${finding.reason ? ` · ${finding.reason}` : ""}${finding.summary ? ` · ${finding.summary}` : ""}`}
            </Text>
          ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>{formatTuiDetailSectionTitle(i18n, "pending", vm.pending.length)}</Text>
        {vm.pending.length === 0
          ? <Text dimColor>{`  ${formatTuiDetailNone(i18n)}`}</Text>
          : vm.pending.map((pending) => (
            <Text key={pending.pending_id}>
              {`  ${pending.pending_id} ${pending.kind} ${i18n.t(CHROME_KEYS.tuiDetailRowBlocks, { value: pending.blocks })}${pending.options.length === 0 ? "" : ` ${i18n.t(CHROME_KEYS.tuiDetailRowOptions, { value: pending.options.join(",") })}`} · ${pending.question}`}
            </Text>
          ))}
      </Box>
    </Box>
  );
}

function unexpectedDetailError(error: unknown): DetailLoadResult {
  return {
    status: "error",
    message: error instanceof Error ? error.message : String(error),
  };
}
import { CHROME_KEYS } from "../runtime-i18n-keys.js";
