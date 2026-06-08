// Phase 16 SC-15b — pure composition for the `loaf hook` read-side handlers
// (session-start + closure-check).
//
// These functions are deliberately PURE (no IO): the cli.tsx handlers do
// the dispatch + loadProjections IO, then hand the loaded projections here.
// That keeps composition logic exhaustively unit-testable without on-disk
// fixtures, and keeps the handlers thin (resolve → load → compose → format).

import type {
  EvidenceJson,
  FindingsJson,
  PendingQueueEntry,
  StateProjection,
  TasksJson,
} from "./projection-schema.js";
import { promptInjectFor } from "./sub-state-contracts.js";

// ── session-start ──────────────────────────────────────────────────────

export interface SessionStartContextInput {
  sub_state: string;
  iteration: number;
  /** Open findings only (caller filters status==="open"). */
  open_findings: FindingsJson["findings"];
  /** Live pending queue (unresolved); head = [0]. May be empty. */
  pending: readonly PendingQueueEntry[];
}

/**
 * Compose the `additionalContext` string injected into a Claude Code
 * SessionStart hook. Always returns a non-empty banner line; the
 * prompt_inject / findings / pending sections append only when present.
 *
 * Terminal DONE.* sub_states have an empty prompt_inject by design — the
 * banner still renders so the agent knows the session is terminal.
 */
export function composeSessionStartContext(input: SessionStartContextInput): string {
  const lines: string[] = [];
  lines.push(`loaf session — ${input.sub_state} (iteration ${input.iteration})`);

  const inject = promptInjectFor(input.sub_state);
  if (inject !== undefined && inject.length > 0) {
    lines.push(`Next action: ${inject}`);
  }

  if (input.open_findings.length > 0) {
    const rendered = input.open_findings
      .map((f) => {
        const label = `${f.id} [${f.category}/${f.action}]`;
        return f.summary ? `${label} ${f.summary}` : label;
      })
      .join("; ");
    lines.push(`Open findings (${input.open_findings.length}): ${rendered}`);
  }

  const head = input.pending[0];
  if (head !== undefined) {
    lines.push(`Pending: ${head.pending_id} [${head.kind}] ${head.question}`);
  }

  return lines.join("\n");
}

/** Exact Claude Code SessionStart hook stdout envelope (codex GO Q-A lock). */
export interface SessionStartHookOutput {
  hookSpecificOutput: {
    hookEventName: "SessionStart";
    additionalContext: string;
  };
}

export function sessionStartHookOutput(additionalContext: string): SessionStartHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
}

// ── closure-check ──────────────────────────────────────────────────────

export interface ClosureWarningsInput {
  state: StateProjection;
  /** tasks.json projection; null when no plan exists (writer skip). */
  tasks: TasksJson | null;
  evidence: EvidenceJson;
  findings: FindingsJson;
}

/**
 * Read-only closure consistency warnings (codex GO Q-B lock, MVP set).
 * NEVER throws; the caller always exits 0 (warnings must not block the
 * Claude Code Stop event).
 *
 * MVP checks:
 *   1. orphan evidence — `covers[]` task-id (T-NNN) targets absent from
 *      tasks.json (cheap, read-only). REQ/SCEN/VIS-target orphans are
 *      DEFERRED — they require the spec.md projection, which is not in the
 *      loadProjections kind set.
 *   2. open findings summary — count + ids (the narrow "findings reasonable"
 *      signal).
 *
 * Projection freshness/schema consistency (Q-B check 1) is enforced upstream
 * by the loadProjections fast-check path in the caller (SnapshotStaleError),
 * not duplicated here.
 */
export function runClosureWarnings(input: ClosureWarningsInput): string[] {
  const warnings: string[] = [];

  // ── 1. orphan evidence (task-id covers only) ──
  const knownTaskIds = new Set((input.tasks?.tasks ?? []).map((t) => t.id));
  const orphanPairs: string[] = [];
  for (const ev of input.evidence.evidence) {
    for (const ref of ev.covers) {
      // covers[] is a union of REQ/SCEN/VIS/T ids; only T-NNN is checkable
      // against the loaded tasks projection in the SC-15b MVP.
      if (ref.startsWith("T-") && !knownTaskIds.has(ref)) {
        orphanPairs.push(`${ev.id}→${ref}`);
      }
    }
  }
  if (orphanPairs.length > 0) {
    warnings.push(
      `orphan evidence: ${orphanPairs.length} covers[] task target(s) absent from tasks.json: ${orphanPairs.join(", ")}`,
    );
  }

  // ── 2. open findings summary ──
  const open = input.findings.findings.filter((f) => f.status === "open");
  if (open.length > 0) {
    warnings.push(`open findings (${open.length}): ${open.map((f) => f.id).join(", ")}`);
  }

  return warnings;
}
