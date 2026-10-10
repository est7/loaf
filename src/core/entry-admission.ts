import type { JournalEntry } from "./journal-entry.js";
import { applyValidated, type ApplyFailureCode, type Snapshot } from "./reducer.js";
import { preflight, type PreflightFailureCode } from "./reducer/preflight.js";

export type AdmissionMode = { kind: "mutation"; tail_seq: number } | { kind: "replay" };

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
 * Mutation validates every kind against the journal tail. Replay preserves
 * historical bootstrap tolerance;
 * envelope validation and sequence continuity remain owned by replayJournal.
 */
export function admitEntry(
  prev: Snapshot,
  entry: JournalEntry,
  mode: AdmissionMode,
): AdmissionResult {
  const bootstrap =
    entry.kind === "session:started" || entry.kind === "migration:snapshot_imported";
  if (!bootstrap && prev.state === null) {
    return {
      ok: false,
      stage: "admission",
      code: "NO_SESSION",
      message: `kind=${entry.kind} requires a started session`,
      detail: {},
    };
  }

  if (mode.kind === "mutation" || !bootstrap) {
    const result = preflight(entry, {
      snapshot: prev,
      ...(mode.kind === "mutation" ? { tail_seq: mode.tail_seq } : {}),
    });
    if (!result.ok) {
      return { ...result, stage: "admission", detail: result.detail ?? {} };
    }
  }

  const result = applyValidated(prev, entry);
  if (!result.ok) {
    return { ...result, stage: "reducer", detail: result.detail ?? {} };
  }
  return result;
}
