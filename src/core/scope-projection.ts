// Pure-replay actual-scope projection from `scope:recorded` journal entries.
// Payload sidecars are resolved and integrity-checked here because the
// synchronous reducer deliberately treats this audit-only kind as a no-op.

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  CanonicalScopePaths,
  ScopeRecordedPayload,
  compareScopePathBytes,
  type JournalEntry,
} from "./journal-entry.js";

export class ActualScopeHistoryIncompleteError extends Error {
  readonly code = "ACTUAL_SCOPE_HISTORY_INCOMPLETE" as const;
  readonly detail: { transition_seqs: number[] };

  constructor(transitionSeqs: number[]) {
    super(
      `actual scope history incomplete: EXECUTE closure transition(s) at seq ${transitionSeqs.join(", ")} have no same-batch scope:recorded marker`,
    );
    this.name = "ActualScopeHistoryIncompleteError";
    this.detail = { transition_seqs: transitionSeqs };
  }
}

function isExecuteClosure(entry: JournalEntry): boolean {
  const payload = entry.payload as { from?: unknown; to?: unknown };
  return (
    entry.kind === "event:phase_advanced" &&
    payload.from === "EXECUTE.work" &&
    payload.to === "EXECUTE.done"
  );
}

function hasSameBatchScopeMarker(
  closure: JournalEntry,
  entries: readonly JournalEntry[],
): boolean {
  return (
    closure.batch_id !== undefined &&
    entries.some(
      (entry) => entry.kind === "scope:recorded" && entry.batch_id === closure.batch_id,
    )
  );
}

function parseCanonicalPathsText(text: string): string[] {
  const decoded: unknown = JSON.parse(text);
  const paths = CanonicalScopePaths.parse(decoded);
  if (text !== JSON.stringify(paths)) {
    throw new Error("scope paths sidecar is not canonical JSON");
  }
  return paths;
}

export async function resolveScopePaths(
  entry: JournalEntry,
  featureDir: string,
): Promise<string[]> {
  const payload = ScopeRecordedPayload.parse(entry.payload);
  if (Array.isArray(payload.paths)) return payload.paths;
  if (payload.paths.mode === "inline") return parseCanonicalPathsText(payload.paths.text);

  const ref = payload.paths.ref;
  const buf = await fsp.readFile(path.join(featureDir, ref.path));
  const sha256 = createHash("sha256").update(buf).digest("hex");
  if (sha256 !== ref.sha256 || buf.byteLength !== ref.size) {
    throw new Error(
      `scope sidecar ${ref.path} integrity mismatch ` +
        `(sha256 ${sha256 === ref.sha256 ? "ok" : "MISMATCH"}, ` +
        `size ${buf.byteLength}≟${ref.size})`,
    );
  }
  return parseCanonicalPathsText(buf.toString("utf8"));
}

/** Set-union all recorded closures and return canonical UTF-8 byte order. */
export async function deriveActualScope(
  entries: readonly JournalEntry[],
  featureDir: string,
): Promise<string[]> {
  const incompleteTransitionSeqs = entries
    .filter(isExecuteClosure)
    .filter((closure) => !hasSameBatchScopeMarker(closure, entries))
    .map((closure) => closure.seq);
  if (incompleteTransitionSeqs.length > 0) {
    throw new ActualScopeHistoryIncompleteError(incompleteTransitionSeqs);
  }

  const union = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "scope:recorded") continue;
    for (const scopePath of await resolveScopePaths(entry, featureDir)) union.add(scopePath);
  }
  return [...union].sort(compareScopePathBytes);
}
