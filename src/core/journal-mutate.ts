// journal-mutate — the single transactional mutator API (Blocker #3).
//
// `mutate(partial, ctx)` is the only sanctioned entry point for journal
// mutation. It collapses the §11.2 transaction steps into one call:
//
//   step 1 (lock acquire)     — deferred to a follow-up (single-writer scope)
//   step 2 (read tail/_meta)  — caller supplies ctx.tail_seq + ctx.snapshot
//   step 3 (preflight)        — via reducer/preflight
//   step 4 (sidecar finalize) — via sidecar.promoteSidecars
//   step 5 (final validate)   — via appendEntry's inline re-parse (envelope + per-kind payload)
//   step 6 (journal append)   — via appendEntry single-write
//   step 7 (post-apply)       — via reducer.apply
//   step 8 (snapshot rebuild) — deferred (returns the new in-memory snapshot;
//                                caller persists via snapshot writers in later stages)
//   step 9 (registry refresh) — deferred (registry is per-session projection)
//   step 10 (lock release)    — deferred with step 1
//
// Direct calls to `appendEntry` are still possible (it remains the step 6
// primitive) but `mutate` is the audit-approved end-to-end path: bypassing
// it skips preflight, payload narrowing, and reducer apply.
//
// Caller contract:
//   - Supply ctx.snapshot (current projection) + ctx.tail_seq (journal tail)
//   - Supply partial entry (envelope + kind + payload) sans seq / entry_id;
//     mutate fills those from tail_seq + 1
//   - On ok: receive new snapshot + the persisted JournalEntry
//   - On error: typed code + message; journal is unchanged (preflight aborts
//     before any I/O), or sidecar/append errors surface accordingly

import path from "node:path";

import { appendEntry, AppendError } from "./journal-append.js";
import { REDUCER_IMPLEMENTED_KINDS, type JournalEntry } from "./journal-entry.js";
import { apply, type Snapshot } from "./reducer.js";
import { preflight, type PreflightFailureCode } from "./reducer/preflight.js";
import { promoteSidecars } from "./sidecar.js";

export interface MutateContext {
  /** Feature directory; journal.jsonl + attachments/ + snapshots/ live here */
  feature_dir: string;
  /** Current snapshot — pre-mutation projection */
  snapshot: Snapshot;
  /** Tail seq from journal — -1 if journal is empty / absent */
  tail_seq: number;
  /** Disable fsync for tests */
  fsync?: boolean;
}

export type MutateFailureCode =
  | PreflightFailureCode
  | "APPEND_ERROR"
  | "SIDECAR_ERROR"
  | "REDUCER_ERROR";

export type MutateResult =
  | { ok: true; snapshot: Snapshot; entry: JournalEntry }
  | {
      ok: false;
      code: MutateFailureCode;
      message: string;
      detail?: Record<string, unknown>;
    };

const DEFAULT_BOOTSTRAP_CEREMONY = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip" as const,
  strict_drift_check: false,
};

export async function mutate(
  partial: Omit<JournalEntry, "seq" | "entry_id"> & {
    seq?: number;
    entry_id?: string;
  },
  ctx: MutateContext,
): Promise<MutateResult> {
  // (1) Fill seq + entry_id from journal tail. Caller MAY override, but
  // preflight's monotonic seq check will reject mismatches.
  const seq = partial.seq ?? ctx.tail_seq + 1;
  const entry_id = partial.entry_id ?? `JE-${String(seq + 1).padStart(6, "0")}`;
  const candidate: JournalEntry = { ...partial, seq, entry_id } as JournalEntry;

  // (2) Preflight context — sub_state + ceremony from current snapshot.
  // Bootstrap kinds (session:started, migration:snapshot_imported) run with
  // state==null; preflight's PER_KIND_SUB_STATE accepts ANY_SUB_STATE for
  // those kinds, so the default cursor is consistent with the apply contract.
  const subState = ctx.snapshot.state?.sub_state ?? "TRIAGE.score";
  const ceremony = ctx.snapshot.state?.ceremony ?? DEFAULT_BOOTSTRAP_CEREMONY;
  const pre = preflight(candidate, {
    sub_state: subState,
    tail_seq: ctx.tail_seq,
    ceremony,
  });
  if (!pre.ok) {
    return {
      ok: false,
      code: pre.code,
      message: pre.message,
      detail: pre.detail ?? {},
    };
  }

  // (2b) Audit r2 fix — reducer-not-implemented MUST surface before append,
  // not after. Without this gate, mutate() returns REDUCER_ERROR while the
  // journal has already grown by one line (codex r2 caught this: implementing
  // event:spec_req_added would otherwise pollute the journal).
  if (!REDUCER_IMPLEMENTED_KINDS.has(candidate.kind)) {
    return {
      ok: false,
      code: "REDUCER_ERROR",
      message: `reducer has no handler for kind=${candidate.kind}; refusing to append (would orphan a journal entry)`,
      detail: { kind: candidate.kind },
    };
  }

  // (3) Sidecar finalize (step 4). Promotes any LongTextField inline > 8KB
  // into per-entry attachment files; replaces the inline form with a
  // sidecar AttachmentRef. No-op for entries without LongTextField shapes.
  let promoted: JournalEntry;
  try {
    promoted = await promoteSidecars(candidate, ctx.feature_dir, {
      fsync: ctx.fsync ?? true,
    });
  } catch (err) {
    return {
      ok: false,
      code: "SIDECAR_ERROR",
      message: `sidecar finalize failed: ${String(err)}`,
      detail: { err: String(err) },
    };
  }

  // (4) Audit r3 fix — reducer dry-run BEFORE append. `apply()` mutates the
  // snapshot in-place on success (perf optimization for replay), so we
  // structuredClone first. State-invariant errors (PENDING_NOT_FOUND,
  // FINDING_NOT_FOUND, ALREADY_STARTED, INVALID_PAYLOAD reducer-side, etc.)
  // surface here and abort the transaction WITHOUT growing the journal.
  // codex r3 repro: `pending:resolved {id:"PEND-404"}` previously appended
  // before reducer caught the FIFO head mismatch — fixed here.
  const snapshotCopy = structuredClone(ctx.snapshot);
  const dryRun = apply(snapshotCopy, promoted);
  if (!dryRun.ok) {
    return {
      ok: false,
      code: "REDUCER_ERROR",
      message: dryRun.message,
      detail: { code: dryRun.code, ...(dryRun.detail ?? {}) },
    };
  }

  // (5) Step 5+6 — final validate + journal append (single-write).
  const journalPath = path.join(ctx.feature_dir, "journal.jsonl");
  try {
    await appendEntry(journalPath, promoted, { fsync: ctx.fsync ?? true });
  } catch (err) {
    if (err instanceof AppendError) {
      return {
        ok: false,
        code: "APPEND_ERROR",
        message: err.message,
        detail: { code: err.code, ...(err.detail ?? {}) },
      };
    }
    return {
      ok: false,
      code: "APPEND_ERROR",
      message: `append failed: ${String(err)}`,
      detail: { err: String(err) },
    };
  }

  // (6) Steps 8-10 — snapshot rebuild + registry refresh + lock release.
  // The dry-run snapshotCopy IS the new state (apply mutated it in place);
  // we hand it back rather than apply() again on ctx.snapshot, which would
  // double-mutate.
  return { ok: true, snapshot: dryRun.snapshot, entry: promoted };
}
