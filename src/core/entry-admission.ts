import type { Diagnostic } from "./error-catalog.js";
import type { JournalEntry } from "./journal-entry.js";
import { applyValidated, type ApplyFailureCode, type Snapshot } from "./reducer.js";
import { preflight, type PreflightFailureCode } from "./reducer/preflight.js";

export type AdmissionResult =
  | { ok: true; snapshot: Snapshot }
  | ({ ok: false; stage: "admission" } & Diagnostic<PreflightFailureCode | "NO_SESSION">)
  | ({ ok: false; stage: "reducer" } & Diagnostic<ApplyFailureCode>);

/**
 * Admits one entry and consumes `prev`; projection application can mutate its
 * arrays in place. Clone first when the caller needs the prior snapshot.
 * Every kind passes preflight before projection application. Supply tail_seq
 * when the caller owns the journal tail; replayJournal checks envelope and
 * sequence continuity independently and omits it.
 */
export function admitEntry(
  prev: Snapshot,
  entry: JournalEntry,
  options: { tail_seq?: number } = {},
): AdmissionResult {
  const bootstrap = entry.kind === "session:started";
  if (!bootstrap && prev.state === null) {
    return {
      ok: false,
      stage: "admission",
      code: "NO_SESSION",
      detail: { kind: entry.kind },
    };
  }

  const checked = preflight(entry, { snapshot: prev, ...options });
  if (!checked.ok) {
    return { ...checked, stage: "admission" };
  }

  const result = applyValidated(prev, checked.entry);
  if (!result.ok) {
    return { ...result, stage: "reducer" };
  }
  return result;
}
