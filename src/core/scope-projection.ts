// Pure-replay actual-scope projection from `scope:recorded` journal entries.
// Payload sidecars are resolved and integrity-checked here because the
// synchronous reducer deliberately treats this audit-only kind as a no-op.

import { readAttachment } from "./attachment-authority.js";
import {
  CanonicalScopePaths,
  ScopeRecordedPayload,
  compareScopePathBytes,
  type JournalEntry,
} from "./journal-entry.js";
import { parseScopeClosureFacts } from "./scope-closure-policy.js";

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

  const buf = await readAttachment(featureDir, entry, "paths", payload.paths.ref);
  return parseCanonicalPathsText(buf.toString("utf8"));
}

/** Set-union all recorded closures and return canonical UTF-8 byte order. */
export async function deriveActualScope(
  entries: readonly JournalEntry[],
  featureDir: string,
): Promise<string[]> {
  const closureHistory = parseScopeClosureFacts(entries);
  const incompleteTransitionSeqs = closureHistory.incompleteTransitionSeqs;
  if (incompleteTransitionSeqs.length > 0) {
    throw new ActualScopeHistoryIncompleteError(incompleteTransitionSeqs);
  }

  const union = new Set<string>();
  for (const fact of closureHistory.facts) {
    for (const scopePath of await resolveScopePaths(fact.scope, featureDir)) {
      union.add(scopePath);
    }
  }
  return [...union].sort(compareScopePathBytes);
}
