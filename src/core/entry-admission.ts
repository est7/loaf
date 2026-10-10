import type { JournalEntry } from "./journal-entry.js";
import { applyValidated, type ApplyFailureCode, type Snapshot } from "./reducer.js";
import { preflight, type PreflightFailureCode } from "./reducer/preflight.js";

export type AdmissionResult =
  | { ok: true; snapshot: Snapshot }
  | ({
      ok: false;
      message: string;
      detail: Record<string, unknown>;
    } & (
      | { stage: "admission"; code: PreflightFailureCode | "NO_SESSION" }
      | { stage: "reducer"; code: ApplyFailureCode }
    ));

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
      message: `kind=${entry.kind} requires a started session`,
      detail: {},
    };
  }

  const checked = preflight(entry, { snapshot: prev, ...options });
  if (!checked.ok) {
    return { ...checked, stage: "admission", detail: checked.detail ?? {} };
  }

  const result = applyValidated(prev, entry);
  if (!result.ok) {
    return { ...result, stage: "reducer", detail: result.detail ?? {} };
  }
  return result;
}
