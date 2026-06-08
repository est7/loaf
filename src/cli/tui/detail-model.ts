// Slice 3 — pure detail model helpers for `loaf tui`.
//
// This module classifies projection-loader results/errors and shapes loaded
// projections into plain data for the Ink component. It performs no IO.

import type { SessionRow } from "../sessions-list.js";
import { formatAtRelative } from "../sessions-list.js";
import type { I18n } from "../i18n.js";
import {
  CHROME_KEYS,
  evidenceKindKey,
  findingActionKey,
  findingCategoryKey,
  pendingKindKey,
  phaseKey,
  subStateKey,
  taskKindKey,
  taskStatusKey,
} from "../runtime-i18n-keys.js";
import { formatTuiDetailSidecarSummary, formatTuiDetailStepSummary } from "./chrome.js";
import {
  NoSessionError,
  SnapshotStaleError,
  type LoadResult,
} from "../../core/projection-loader.js";

export const DETAIL_PROJECTION_KINDS = [
  "state",
  "tasks",
  "evidence",
  "findings",
  "pending",
] as const;
export type DetailProjectionKind = (typeof DETAIL_PROJECTION_KINDS)[number];
export type DetailProjectionLoad = LoadResult<DetailProjectionKind>;
export type DetailResultBadge = "pass" | "fail" | "waived";

export interface DetailTaskLine {
  id: string;
  kind: string;
  status: string;
  title: string | null;
  step_summary: string;
}

export interface DetailEvidenceLine {
  id: string;
  kind: string;
  result: string;
  result_badge: DetailResultBadge;
  summary: string;
  iteration: number;
  task_id: string | null;
}

export interface DetailFindingLine {
  id: string;
  category: string;
  action: string;
  summary: string;
  reason: string;
  target: string | null;
}

export interface DetailPendingLine {
  pending_id: string;
  kind: string;
  question: string;
  blocks: string;
  options: string[];
}

export interface DetailViewModel {
  feature: string;
  session_id_short: string;
  session_label: string | null;
  workspace: string;
  ceremony_label: string;
  phase: string;
  sub_state: string;
  iteration: number;
  complexity_score: string;
  based_on: { spec: number; tasks: number };
  created_at_relative: string;
  updated_at_relative: string;
  spec_locked: boolean;
  verify_accepted: boolean;
  spec_version: number;
  tail_seq: number;
  tasks: DetailTaskLine[];
  evidence: DetailEvidenceLine[];
  open_findings: DetailFindingLine[];
  pending: DetailPendingLine[];
}

export type DetailLoadResult =
  | { status: "ready"; vm: DetailViewModel }
  | { status: "missing"; message: string; fix: string | null }
  | { status: "stale"; reason: string; message: string; fix: string | null }
  | { status: "error"; message: string };

export type DetailOutcomeInput =
  | { ok: true; loaded: DetailProjectionLoad }
  | { ok: false; error: unknown };

export function classifyDetailOutcome(
  row: SessionRow,
  input: DetailOutcomeInput,
  now: Date,
  i18n: I18n,
): DetailLoadResult {
  if (input.ok) {
    return { status: "ready", vm: shapeDetailViewModel(row, input.loaded, now, i18n) };
  }

  const { error } = input;
  if (error instanceof NoSessionError) {
    return {
      status: "missing",
      message: i18n.t(CHROME_KEYS.tuiDetailMissingMessage, { feature: row.feature }),
      fix: detailFix(error.detail),
    };
  }

  if (error instanceof SnapshotStaleError) {
    return {
      status: "stale",
      reason: error.reason,
      message: i18n.t(CHROME_KEYS.tuiDetailStaleMessage, { reason: error.reason }),
      fix: detailFix(error.detail),
    };
  }

  return {
    status: "error",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function shapeDetailViewModel(
  row: SessionRow,
  loaded: DetailProjectionLoad,
  now: Date,
  i18n: I18n,
): DetailViewModel {
  const { state, tasks, evidence, findings, pending, meta } = loaded;
  return {
    feature: row.feature,
    session_id_short: row.session_id_short,
    session_label: state.session_label,
    workspace: state.workspace,
    ceremony_label: state.ceremony_label,
    phase: i18n.t(phaseKey(state.phase)),
    sub_state: i18n.t(subStateKey(state.sub_state)),
    iteration: state.iteration,
    complexity_score: state.complexity_score === null ? "n/a" : String(state.complexity_score),
    based_on: state.based_on,
    created_at_relative: formatAtRelative(state.created_at, now, i18n),
    updated_at_relative: formatAtRelative(state.updated_at, now, i18n),
    spec_locked: state.spec_locked,
    verify_accepted: state.verify_accepted,
    spec_version: state.spec_version,
    tail_seq: meta.last_applied_seq,
    tasks:
      tasks === null
        ? []
        : tasks.tasks.map((task) => ({
            id: task.id,
            kind: i18n.t(taskKindKey(task.kind)),
            status: i18n.t(taskStatusKey(task.status)),
            title: optionalStringField(task, "title"),
            step_summary: formatStepSummary(task.execution, i18n),
          })),
    evidence: evidence.evidence.map((entry) => ({
      id: entry.id,
      kind: i18n.t(evidenceKindKey(entry.kind)),
      result: entry.result,
      result_badge: resultBadge(entry.result),
      summary: truncateHighSignal(summaryText(entry.summary, i18n)),
      iteration: entry.iteration,
      task_id: entry.task_id ?? null,
    })),
    open_findings: findings.findings
      .filter((finding) => finding.status === "open")
      .map((finding) => ({
        id: finding.id,
        category: i18n.t(findingCategoryKey(finding.category)),
        action: i18n.t(findingActionKey(finding.action)),
        summary: truncateHighSignal(finding.summary ?? ""),
        reason: truncateHighSignal(finding.reason ?? ""),
        target:
          finding.target === undefined ? null : `${finding.target.task_id}/${finding.target.step}`,
      })),
    pending: pending.pending
      .filter((entry) => !entry.resolved)
      .map((entry) => ({
        pending_id: entry.pending_id,
        kind: i18n.t(pendingKindKey(entry.kind)),
        question: entry.question,
        blocks: entry.blocks,
        options: entry.options ?? [],
      })),
  };
}

function detailFix(detail: Record<string, unknown>): string | null {
  return typeof detail["fix"] === "string" ? detail["fix"] : null;
}

function resultBadge(result: string): DetailResultBadge {
  switch (result) {
    case "passed":
    case "approved":
      return "pass";
    case "failed":
    case "rejected":
      return "fail";
    case "waived":
      return "waived";
    default:
      throw new Error(`unexpected evidence result: ${result}`);
  }
}

function summaryText(
  summary: DetailProjectionLoad["evidence"]["evidence"][number]["summary"],
  i18n: I18n,
): string {
  if (typeof summary === "string") return summary;
  if (summary.mode === "inline") return summary.text;
  return formatTuiDetailSidecarSummary(i18n, summary.ref.path);
}

function truncateHighSignal(value: string): string {
  const limit = 75;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

function formatStepSummary(execution: Record<string, { status: string }>, i18n: I18n): string {
  const steps = Object.values(execution);
  const done = steps.filter((step) => step.status === "passed" || step.status === "waived").length;
  return formatTuiDetailStepSummary(i18n, done, steps.length);
}

function optionalStringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}
