// Slice 1 — pure master-list model helpers for `loaf tui`.
//
// Keep this file free of Ink imports and IO. The Ink App owns selection and
// key handling; these helpers own deterministic filtering, grouping, sorting,
// and typed render-plan construction.

import type { SessionRow } from "../sessions-list.js";
import type { TuiStatusBucket } from "./types.js";

export type TuiSortMode = "time" | "status";
export type TuiDetailStatus = "unknown" | "loading" | "ready" | "stale" | "missing" | "error";
export type TuiMoveDirection = -1 | 1;

export interface TuiFeatureGroup {
  cwd: string;
  feature: string;
  visible_session_count: number;
  sessions: SessionRow[];
}

export interface TuiProjectGroup {
  cwd: string;
  visible_session_count: number;
  features: TuiFeatureGroup[];
}

export type TuiListItem =
  | {
      kind: "project";
      key: string;
      cwd: string;
      visible_session_count: number;
      collapsed: boolean;
    }
  | {
      kind: "feature";
      key: string;
      cwd: string;
      feature: string;
      visible_session_count: number;
      collapsed: boolean;
    }
  | {
      kind: "session";
      key: string;
      row: SessionRow;
      detail_status: TuiDetailStatus;
    };

export interface TuiTreeListItem {
  item: TuiListItem;
  prefix: string;
}

export interface BuildRenderPlanOptions {
  showAll: boolean;
  sortMode: TuiSortMode;
  collapsed: ReadonlySet<string>;
}

export interface TuiSelection {
  selectedKey: string | null;
  index: number;
}

export function projectKey(cwd: string): string {
  return `project:${cwd}`;
}

export function featureKey(cwd: string, feature: string): string {
  return `feature:${cwd}:${feature}`;
}

export function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

export function statusBucket(row: SessionRow): TuiStatusBucket {
  if (row.sub_state.startsWith("DONE.")) return "done";
  if (row.pending_queue_depth > 0) return "blocked";
  if (row.active_tasks.length > 0) return "running";
  return "idle";
}

export function filterActive(rows: ReadonlyArray<SessionRow>, showAll: boolean): SessionRow[] {
  if (showAll) return [...rows];
  return rows.filter((row) => !row.sub_state.startsWith("DONE."));
}

export function groupByProjectFeature(rows: ReadonlyArray<SessionRow>): TuiProjectGroup[] {
  const projects = new Map<string, TuiProjectGroup>();
  const featureIndexes = new Map<string, Map<string, TuiFeatureGroup>>();

  for (const row of rows) {
    let project = projects.get(row.cwd);
    if (project === undefined) {
      project = { cwd: row.cwd, visible_session_count: 0, features: [] };
      projects.set(row.cwd, project);
      featureIndexes.set(row.cwd, new Map());
    }

    // Invariant: every newly-created project installs its feature index in
    // the same block above.
    const projectFeatures = featureIndexes.get(row.cwd)!;

    let feature = projectFeatures.get(row.feature);
    if (feature === undefined) {
      feature = {
        cwd: row.cwd,
        feature: row.feature,
        visible_session_count: 0,
        sessions: [],
      };
      projectFeatures.set(row.feature, feature);
      project.features.push(feature);
    }

    feature.sessions.push(row);
    feature.visible_session_count += 1;
    project.visible_session_count += 1;
  }

  return Array.from(projects.values());
}

export function nextSelectableIndex(
  plan: ReadonlyArray<TuiListItem>,
  currentIndex: number,
  dir: TuiMoveDirection,
): number {
  if (plan.length === 0) return -1;
  if (currentIndex < 0) return 0;
  const next = currentIndex + dir;
  if (next < 0) return 0;
  if (next >= plan.length) return plan.length - 1;
  return next;
}

export function resolveSelectionAfterRebuild(
  plan: ReadonlyArray<TuiListItem>,
  prevSelectedKey: string | null,
): TuiSelection {
  if (plan.length === 0) return { selectedKey: null, index: -1 };
  if (prevSelectedKey !== null) {
    const index = plan.findIndex((item) => item.key === prevSelectedKey);
    if (index >= 0) return { selectedKey: prevSelectedKey, index };
  }
  return { selectedKey: plan[0]!.key, index: 0 };
}

export function toggleCollapsed(collapsed: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(collapsed);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function buildRenderPlan(
  rows: ReadonlyArray<SessionRow>,
  options: BuildRenderPlanOptions,
): TuiListItem[] {
  const groups = sortProjectGroups(groupByProjectFeature(filterActive(rows, options.showAll)), options.sortMode);
  const plan: TuiListItem[] = [];

  for (const project of groups) {
    const pKey = projectKey(project.cwd);
    const projectCollapsed = options.collapsed.has(pKey);
    plan.push({
      kind: "project",
      key: pKey,
      cwd: project.cwd,
      visible_session_count: project.visible_session_count,
      collapsed: projectCollapsed,
    });

    if (projectCollapsed) continue;

    for (const feature of project.features) {
      const fKey = featureKey(feature.cwd, feature.feature);
      const featureCollapsed = options.collapsed.has(fKey);
      plan.push({
        kind: "feature",
        key: fKey,
        cwd: feature.cwd,
        feature: feature.feature,
        visible_session_count: feature.visible_session_count,
        collapsed: featureCollapsed,
      });

      if (featureCollapsed) continue;

      for (const row of feature.sessions) {
        plan.push({
          kind: "session",
          key: sessionKey(row.session_id),
          row,
          detail_status: "unknown",
        });
      }
    }
  }

  return plan;
}

export function withTreePrefixes(plan: ReadonlyArray<TuiListItem>): TuiTreeListItem[] {
  return plan.map((item, index) => {
    switch (item.kind) {
      case "project":
        return { item, prefix: "" };
      case "feature":
        return { item, prefix: `${isLastFeature(plan, index) ? "└─" : "├─"} ` };
      case "session": {
        const parentFeatureIndex = findParentFeatureIndex(plan, index);
        const parentFeatureIsLast = parentFeatureIndex < 0 ? true : isLastFeature(plan, parentFeatureIndex);
        const vertical = parentFeatureIsLast ? "  " : "│ ";
        return { item, prefix: `${vertical}${isLastSession(plan, index) ? "└─" : "├─"} ` };
      }
    }
  });
}

function sortProjectGroups(groups: TuiProjectGroup[], sortMode: TuiSortMode): TuiProjectGroup[] {
  for (const project of groups) {
    for (const feature of project.features) {
      feature.sessions = [...feature.sessions].sort(compareSessions(sortMode));
    }
    project.features = [...project.features].sort(compareFeatures);
  }

  return [...groups].sort(compareProjects);
}

function compareProjects(a: TuiProjectGroup, b: TuiProjectGroup): number {
  return compareIsoDesc(latestAtForProject(a), latestAtForProject(b)) || a.cwd.localeCompare(b.cwd);
}

function compareFeatures(a: TuiFeatureGroup, b: TuiFeatureGroup): number {
  return compareIsoDesc(latestAtForFeature(a), latestAtForFeature(b)) || a.feature.localeCompare(b.feature);
}

function compareSessions(sortMode: TuiSortMode): (a: SessionRow, b: SessionRow) => number {
  return (a, b) => {
    if (sortMode === "status") {
      const byStatus = statusBucketRank(statusBucket(a)) - statusBucketRank(statusBucket(b));
      if (byStatus !== 0) return byStatus;
    }
    return compareIsoDesc(a.at, b.at) || a.session_id.localeCompare(b.session_id);
  };
}

function latestAtForProject(project: TuiProjectGroup): string {
  let latest = "";
  for (const feature of project.features) {
    const candidate = latestAtForFeature(feature);
    if (compareIsoDesc(candidate, latest) < 0) latest = candidate;
  }
  return latest;
}

function latestAtForFeature(feature: TuiFeatureGroup): string {
  let latest = "";
  for (const row of feature.sessions) {
    if (compareIsoDesc(row.at, latest) < 0) latest = row.at;
  }
  return latest;
}

function compareIsoDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

function statusBucketRank(bucket: TuiStatusBucket): number {
  switch (bucket) {
    case "blocked":
      return 0;
    case "running":
      return 1;
    case "idle":
      return 2;
    case "done":
      return 3;
  }
}

function isLastFeature(plan: ReadonlyArray<TuiListItem>, index: number): boolean {
  const item = plan[index];
  if (item?.kind !== "feature") return true;
  for (let cursor = index + 1; cursor < plan.length; cursor += 1) {
    const next = plan[cursor]!;
    if (next.kind === "project") return true;
    if (next.kind === "feature") return false;
  }
  return true;
}

function isLastSession(plan: ReadonlyArray<TuiListItem>, index: number): boolean {
  const item = plan[index];
  if (item?.kind !== "session") return true;
  for (let cursor = index + 1; cursor < plan.length; cursor += 1) {
    const next = plan[cursor]!;
    if (next.kind === "project" || next.kind === "feature") return true;
    if (next.kind === "session") return false;
  }
  return true;
}

function findParentFeatureIndex(plan: ReadonlyArray<TuiListItem>, index: number): number {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const item = plan[cursor]!;
    if (item.kind === "feature") return cursor;
    if (item.kind === "project") return -1;
  }
  return -1;
}
