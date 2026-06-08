import path from "node:path";
import { promises as fs } from "node:fs";

import { listSessions, type ListSessionsWarning, type SessionRow } from "../sessions-list.js";
import {
  loadProjections,
  NoSessionError,
  SnapshotStaleError,
  type LoadResult,
} from "../../core/projection-loader.js";

const BOARD_DETAIL_PROJECTION_KINDS = [
  "state",
  "tasks",
  "evidence",
  "findings",
  "pending",
] as const;

type BoardDetailProjectionKind = (typeof BOARD_DETAIL_PROJECTION_KINDS)[number];
type BoardDetailProjectionLoad = LoadResult<BoardDetailProjectionKind>;

export type BoardScope = "all" | "cwd";
export type BoardStatusBucket = "done" | "blocked" | "running" | "idle";

export interface BoardSessionSummary extends SessionRow {
  label: string;
  status_bucket: BoardStatusBucket;
}

export interface BoardSnapshot {
  ok: true;
  generated_at: string;
  scope: BoardScope;
  cwd: string;
  totals: {
    sessions: number;
    active: number;
    blocked: number;
    running: number;
    done: number;
    warnings: number;
  };
  sessions: BoardSessionSummary[];
  warnings: ListSessionsWarning[];
}

export type BoardDetailResult =
  | {
      ok: true;
      status: "ready";
      session: BoardSessionSummary;
      detail: BoardSessionDetail;
    }
  | {
      ok: true;
      status: "missing";
      session: BoardSessionSummary;
      message: string;
      fix: string | null;
    }
  | {
      ok: true;
      status: "stale";
      session: BoardSessionSummary;
      reason: string;
      message: string;
      fix: string | null;
    }
  | {
      ok: true;
      status: "error";
      session: BoardSessionSummary;
      message: string;
    }
  | {
      ok: false;
      code: "SESSION_NOT_FOUND";
      message: string;
    };

export interface BoardSessionDetail {
  state: {
    phase: string;
    sub_state: string;
    iteration: number;
    ceremony_label: string;
    spec_locked: boolean;
    verify_accepted: boolean;
    spec_version: number;
    based_on: { spec: number; tasks: number };
    created_at: string;
    updated_at: string;
    tail_seq: number;
  };
  tasks: BoardTaskLine[];
  evidence: BoardEvidenceLine[];
  open_findings: BoardFindingLine[];
  pending: BoardPendingLine[];
  proof: {
    tasks_total: number;
    tasks_done: number;
    evidence_total: number;
    passing_evidence: number;
    open_findings: number;
    pending: number;
  };
}

export interface BoardTaskLine {
  id: string;
  kind: string;
  status: string;
  title: string | null;
  drives: string[];
  depends_on: string[];
  labels: string[];
  steps: { total: number; done: number; running: number; failed: number };
}

export interface BoardEvidenceLine {
  id: string;
  kind: string;
  result: string;
  summary: string;
  iteration: number;
  task_id: string | null;
  covers: string[];
  at: string;
}

export interface BoardFindingLine {
  id: string;
  category: string;
  action: string;
  summary: string;
  reason: string;
  target: string | null;
}

export interface BoardPendingLine {
  pending_id: string;
  kind: string;
  question: string;
  blocks: string;
  options: string[];
}

export interface BuildBoardSnapshotInput {
  registryDir?: string;
  scope: BoardScope;
  cwd?: string;
  now?: Date;
}

export interface BuildBoardSessionDetailInput {
  registryDir?: string;
  sessionId: string;
}

export async function buildBoardSnapshot(input: BuildBoardSnapshotInput): Promise<BoardSnapshot> {
  const cwd = input.cwd ?? process.cwd();
  const filterCwd = input.scope === "cwd" ? await canonicalCwd(cwd) : undefined;
  const listed = await listSessions({
    ...(input.registryDir !== undefined && { registryDir: input.registryDir }),
    ...(filterCwd !== undefined && { filterCwd }),
  });
  const sessions = listed.rows.map(toBoardSessionSummary);
  const totals = summarizeSessions(sessions, listed.warnings.length);
  return {
    ok: true,
    generated_at: (input.now ?? new Date()).toISOString(),
    scope: input.scope,
    cwd,
    totals,
    sessions,
    warnings: listed.warnings,
  };
}

export async function buildBoardSessionDetail(
  input: BuildBoardSessionDetailInput,
): Promise<BoardDetailResult> {
  const listed = await listSessions(
    input.registryDir !== undefined ? { registryDir: input.registryDir } : {},
  );
  const row = listed.rows.find((candidate) => candidate.session_id === input.sessionId);
  if (row === undefined) {
    return {
      ok: false,
      code: "SESSION_NOT_FOUND",
      message: `session ${input.sessionId} was not found in the loaf registry`,
    };
  }
  const session = toBoardSessionSummary(row);
  const featureDir = path.join(row.cwd, ".loaf", row.feature);
  try {
    const loaded = await loadProjections({
      feature_dir: featureDir,
      kinds: BOARD_DETAIL_PROJECTION_KINDS,
    });
    return {
      ok: true,
      status: "ready",
      session,
      detail: shapeBoardSessionDetail(loaded),
    };
  } catch (error) {
    if (error instanceof NoSessionError) {
      return {
        ok: true,
        status: "missing",
        session,
        message: `feature ${row.feature} no longer has a valid loaf session`,
        fix: detailFix(error.detail),
      };
    }
    if (error instanceof SnapshotStaleError) {
      return {
        ok: true,
        status: "stale",
        session,
        reason: error.reason,
        message: `snapshot is stale: ${error.reason}`,
        fix: detailFix(error.detail),
      };
    }
    return {
      ok: true,
      status: "error",
      session,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function toBoardSessionSummary(row: SessionRow): BoardSessionSummary {
  return {
    ...row,
    label: row.session_label.length > 0 ? row.session_label : row.feature,
    status_bucket: statusBucket(row),
  };
}

export function statusBucket(row: SessionRow): BoardStatusBucket {
  if (row.sub_state.startsWith("DONE.")) return "done";
  if (row.pending_queue_depth > 0) return "blocked";
  if (row.active_tasks.length > 0) return "running";
  return "idle";
}

export function shapeBoardSessionDetail(
  loaded: BoardDetailProjectionLoad,
): BoardSessionDetail {
  const tasks = loaded.tasks === null ? [] : loaded.tasks.tasks.map(shapeTaskLine);
  const evidence = loaded.evidence.evidence.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    result: entry.result,
    summary: summaryText(entry.summary),
    iteration: entry.iteration,
    task_id: entry.task_id ?? null,
    covers: entry.covers,
    at: entry.at,
  }));
  const openFindings = loaded.findings.findings
    .filter((finding) => finding.status === "open")
    .map((finding) => ({
      id: finding.id,
      category: finding.category,
      action: finding.action,
      summary: finding.summary ?? "",
      reason: finding.reason ?? "",
      target: finding.target === undefined ? null : `${finding.target.task_id}/${finding.target.step}`,
    }));
  const pending = loaded.pending.pending
    .filter((entry) => !entry.resolved)
    .map((entry) => ({
      pending_id: entry.pending_id,
      kind: entry.kind,
      question: entry.question,
      blocks: entry.blocks,
      options: entry.options ?? [],
    }));

  return {
    state: {
      phase: loaded.state.phase,
      sub_state: loaded.state.sub_state,
      iteration: loaded.state.iteration,
      ceremony_label: loaded.state.ceremony_label,
      spec_locked: loaded.state.spec_locked,
      verify_accepted: loaded.state.verify_accepted,
      spec_version: loaded.state.spec_version,
      based_on: loaded.state.based_on,
      created_at: loaded.state.created_at,
      updated_at: loaded.state.updated_at,
      tail_seq: loaded.meta.last_applied_seq,
    },
    tasks,
    evidence,
    open_findings: openFindings,
    pending,
    proof: {
      tasks_total: tasks.length,
      tasks_done: tasks.filter((task) => task.status === "done").length,
      evidence_total: evidence.length,
      passing_evidence: evidence.filter((entry) => isPassingEvidence(entry.result)).length,
      open_findings: openFindings.length,
      pending: pending.length,
    },
  };
}

function summarizeSessions(
  sessions: readonly BoardSessionSummary[],
  warnings: number,
): BoardSnapshot["totals"] {
  return {
    sessions: sessions.length,
    active: sessions.filter((row) => row.status_bucket !== "done").length,
    blocked: sessions.filter((row) => row.status_bucket === "blocked").length,
    running: sessions.filter((row) => row.status_bucket === "running").length,
    done: sessions.filter((row) => row.status_bucket === "done").length,
    warnings,
  };
}

function shapeTaskLine(task: NonNullable<BoardDetailProjectionLoad["tasks"]>["tasks"][number]): BoardTaskLine {
  const steps = Object.values(task.execution);
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    title: optionalStringField(task, "title"),
    drives: task.drives ?? [],
    depends_on: task.depends_on ?? [],
    labels: task.labels ?? [],
    steps: {
      total: steps.length,
      done: steps.filter((step) => step.status === "passed" || step.status === "waived").length,
      running: steps.filter((step) => step.status === "running").length,
      failed: steps.filter((step) => step.status === "failed").length,
    },
  };
}

function optionalStringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function summaryText(
  summary: BoardDetailProjectionLoad["evidence"]["evidence"][number]["summary"],
): string {
  if (typeof summary === "string") return summary;
  if (summary.mode === "inline") return summary.text;
  return summary.ref.path;
}

function isPassingEvidence(result: string): boolean {
  return result === "passed" || result === "approved" || result === "waived";
}

function detailFix(detail: Record<string, unknown>): string | null {
  return typeof detail["fix"] === "string" ? detail["fix"] : null;
}

async function canonicalCwd(cwd: string): Promise<string> {
  try {
    return await fs.realpath(cwd);
  } catch {
    return cwd;
  }
}
