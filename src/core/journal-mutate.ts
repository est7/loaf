// journal-mutate — the single transactional mutator API.
//
// `mutateBatch(partials[], ctx)` is the protocol-level multi-entry mutator
// (§11.2 step 2-7 collapsed). `mutate(partial, ctx)` is the single-entry
// shorthand for `mutateBatch([partial], ctx)`.
//
// Step mapping inside one batch:
//   step 1 (lock acquire)     — deferred (single-writer scope)
//   step 2 (read tail/_meta)  — caller supplies ctx.tail_seq + ctx.snapshot
//   step 3 (preflight)        — per-entry; runs against the snapshot
//                               INCREMENTALLY mutated by prior entries in
//                               the batch (so chained kinds see each other)
//   step 3a (reducer-impl gate)— per-entry; rejects payload-valid but
//                               reducer-unknown kinds before any write
//   step 4 (sidecar finalize) — per-entry
//   step 5 (final validate)   — inside appendMany (envelope + per-kind payload
//                               + per-entry byte cap + batch-total byte cap)
//   step 6 (journal append)   — appendMany single fsync'd write for whole batch
//   step 7 (post-apply)       — reducer.apply already ran during dry-run on
//                               the cloned snapshot accumulator; that IS the
//                               new state (apply mutates in place)
//   step 8 (snapshot rebuild) — deferred (returns in-memory snapshot;
//                               persistence lands in later stage)
//   step 9 (registry refresh) — deferred
//   step 10 (lock release)    — deferred with step 1
//
// Atomicity (preserves audit r1-r5 invariants):
//   - r1 strict per-kind payload (preflight + appendMany final validate)
//   - r2 atomic on prevalidation fail (structuredClone snapshot accumulator;
//                                       journal untouched if any step fails)
//   - r2 REDUCER_IMPLEMENTED_KINDS gate before append
//   - r3 reducer dry-run before append (each entry's apply runs on the
//                                        clone; failure aborts before write)
//   - r4 migration preflight-validate before append (in PER_KIND_PAYLOAD)
//   - r5 wider rollback envelope (sidecar orphans handled by doctor)
//
// Direct `appendEntry` / `appendMany` calls are still possible primitives
// but skip preflight, payload narrowing, REDUCER_IMPLEMENTED gate, sidecar
// promotion, and reducer dry-run. Use `mutate()` / `mutateBatch()` for the
// audit-sanctioned end-to-end path.

import path from "node:path";

import { AppendError, appendMany } from "./journal-append.js";
import { evaluateSpecLock } from "./gates/spec-lock-eval.js";
import { evaluateVerifyAccept } from "./gates/verify-accept-eval.js";
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
  | "REDUCER_ERROR"
  | "INVALID_BATCH"
  | "GATE_PRECONDITION_VIOLATION"
  | "MULTIPLE_GATE_DECISIONS";

export type MutateResult =
  | { ok: true; snapshot: Snapshot; entry: JournalEntry }
  | {
      ok: false;
      code: MutateFailureCode;
      message: string;
      detail?: Record<string, unknown>;
    };

export type MutateBatchResult =
  | { ok: true; snapshot: Snapshot; entries: JournalEntry[] }
  | {
      ok: false;
      code: MutateFailureCode;
      message: string;
      /** 0-based index of the entry that failed, when applicable */
      failed_index?: number;
      detail?: Record<string, unknown>;
    };

/**
 * Caller-supplied entry shape. `seq`, `entry_id`, and the batch envelope
 * triple (`batch_id` / `batch_index` / `batch_count`) are owned by
 * `mutateBatch` — callers must not pre-fill them. Stricter than the previous
 * shape (which allowed seq/entry_id overrides) per codex r12 finding: a
 * mutator API that mixes external IDs and internal allocation creates
 * inconsistent journals.
 */
type PartialEntry = Omit<
  JournalEntry,
  "seq" | "entry_id" | "batch_id" | "batch_index" | "batch_count"
>;

// Slice 1.D: DEFAULT_BOOTSTRAP_CEREMONY moved into preflight() — single-source
// derivation now lives alongside its consumer instead of being injected by
// every caller. The snapshot accumulator carries state.ceremony directly when
// state is initialized.

export async function mutateBatch(
  partials: PartialEntry[],
  ctx: MutateContext,
): Promise<MutateBatchResult> {
  if (partials.length === 0) {
    return {
      ok: false,
      code: "INVALID_BATCH",
      message: "mutateBatch called with empty partials array; pass at least one entry",
      detail: { partials_length: 0 },
    };
  }

  // Per protocol §11.2 + codex r12/r13: validate the ENTIRE batch first
  // (no disk I/O), promote sidecars, then re-validate the promoted form
  // before appending. Three passes:
  //   Pass 1 — preflight + REDUCER_IMPLEMENTED gate + reducer dry-run on
  //            UNPROMOTED candidates (snapshot accumulator threads through
  //            so chained kinds see each other's projection).
  //   Pass 2 — sidecar promotion (only reached if Pass 1 succeeded).
  //   Pass 3 — replay promoted[] on a FRESH clone of ctx.snapshot and assert
  //            the reducer-visible result matches Pass 1. Today's reducers
  //            do not read LongTextField bodies so Pass 3 is a no-op
  //            success; the gate exists as a forward-compatibility guard
  //            (a future reducer that DOES read sidecar refs must not be
  //            able to silently drift the in-memory snapshot away from the
  //            replayed-from-journal snapshot).

  // Runtime reject forbidden caller-supplied fields. The PartialEntry type
  // omits these, but TS can be bypassed via `as any` / external JSON, and
  // mutateBatch must own seq/entry_id/batch envelope unconditionally.
  const FORBIDDEN = ["seq", "entry_id", "batch_id", "batch_index", "batch_count"] as const;
  for (let i = 0; i < partials.length; i++) {
    const partial = partials[i] as Record<string, unknown>;
    for (const f of FORBIDDEN) {
      if (f in partial) {
        return {
          ok: false,
          code: "INVALID_BATCH",
          message: `partial at index ${i} contains forbidden field '${f}'; mutateBatch owns seq/entry_id/batch envelope`,
          failed_index: i,
          detail: { forbidden_field: f, index: i },
        };
      }
    }
  }

  const isBatch = partials.length >= 2;
  const batchId = isBatch ? crypto.randomUUID() : undefined;

  // Pass 1: pure validation, no I/O. Build candidate entries with seq + id +
  // batch envelope; accumulate snapshot.
  let snapshotAcc: Snapshot = structuredClone(ctx.snapshot);
  const candidates: JournalEntry[] = [];

  for (let i = 0; i < partials.length; i++) {
    const partial = partials[i]!;
    const seq = ctx.tail_seq + 1 + i;
    const entry_id = `JE-${String(seq + 1).padStart(6, "0")}`;
    const candidate: JournalEntry = isBatch
      ? ({
          ...partial,
          seq,
          entry_id,
          batch_id: batchId!,
          batch_index: i,
          batch_count: partials.length,
        } as JournalEntry)
      : ({ ...partial, seq, entry_id } as JournalEntry);

    // Slice 1.D — PreflightContext refactor: single-source snapshot accumulator.
    // sub_state / ceremony / verify_accepted / tasks all derive inside preflight()
    // from snapshotAcc.state with TRIAGE.score / standard ceremony defaults.
    const pre = preflight(candidate, {
      snapshot: snapshotAcc,
      tail_seq: ctx.tail_seq + i,
    });
    if (!pre.ok) {
      return {
        ok: false,
        code: pre.code,
        message: pre.message,
        failed_index: i,
        detail: pre.detail ?? {},
      };
    }

    if (!REDUCER_IMPLEMENTED_KINDS.has(candidate.kind)) {
      return {
        ok: false,
        code: "REDUCER_ERROR",
        message: `reducer has no handler for kind=${candidate.kind}; refusing to append (would orphan a journal entry)`,
        failed_index: i,
        detail: { kind: candidate.kind },
      };
    }

    const dryRun = apply(snapshotAcc, candidate);
    if (!dryRun.ok) {
      return {
        ok: false,
        code: "REDUCER_ERROR",
        message: dryRun.message,
        failed_index: i,
        detail: { code: dryRun.code, ...(dryRun.detail ?? {}) },
      };
    }
    snapshotAcc = dryRun.snapshot;
    candidates.push(candidate);
  }

  // Pass 1.5 (Slice 1.B sub-cycle 3c, codex r28 GO v2): gate precondition
  // checks. Runs AFTER Pass 1 preflight + reducer dry-run so stable-core
  // error priority (invalid payload / sub_state / actor) is preserved, and
  // BEFORE Pass 2 sidecar promotion so a failing gate leaves no on-disk
  // residue. Uses ctx.snapshot (pre-batch), not snapshotAcc — a batch must
  // not satisfy its own gate preconditions with earlier entries.
  //
  // Detection rule: count ALL `gate:decided` entries whose decision is
  // "approved" across the batch (any gate_kind). Protocol §10.8 makes
  // each gate decision a single atomic operation, so a batch carrying
  // ≥2 gate approvals — even with different gate_kinds — is invalid.
  // Rejected gate decisions pass through (rejection requires no gate
  // satisfaction; preflight + reducer dry-run still validates them).
  const gateApprovals = candidates.filter(
    (c) =>
      c.kind === "gate:decided" &&
      (c.payload as { decision?: string }).decision === "approved",
  );
  if (gateApprovals.length > 1) {
    return {
      ok: false,
      code: "MULTIPLE_GATE_DECISIONS",
      message: `batch contains ${gateApprovals.length} approved gate:decided entries; protocol §10.8 requires one gate decision per atomic operation`,
      detail: {
        count: gateApprovals.length,
        gate_kinds: gateApprovals.map(
          (c) => (c.payload as { gate_kind?: string }).gate_kind,
        ),
      },
    };
  }
  if (gateApprovals.length === 1) {
    const approval = gateApprovals[0]!;
    const gateKind = (approval.payload as { gate_kind?: string }).gate_kind;
    if (gateKind === "spec-lock") {
      const gateResult = await evaluateSpecLock(ctx.snapshot, ctx.feature_dir);
      if (!gateResult.ok) {
        return {
          ok: false,
          code: "GATE_PRECONDITION_VIOLATION",
          message: `gate:decided spec-lock approval failed ${gateResult.checks.length} spec-lock check(s); see detail.checks`,
          detail: {
            gate: "spec-lock",
            failure_count: gateResult.checks.length,
            checks: gateResult.checks,
          },
        };
      }
    } else if (gateKind === "verify-accept") {
      // Slice 1.C sub-cycle 5: mirror of spec-lock wire above. Pass ceremony
      // is already on ctx.snapshot.state.ceremony — verifyAcceptCheck reads
      // strict_spec_review there for check 5 gating. Same
      // GATE_PRECONDITION_VIOLATION shape; detail.gate disambiguates from
      // spec-lock for downstream renderers / ERROR_CATALOG (codex r42
      // non-blocking note: catalog wording must not describe
      // SPEC_FRONTMATTER_INVALID only as spec-lock check 1).
      const gateResult = await evaluateVerifyAccept(ctx.snapshot, ctx.feature_dir);
      if (!gateResult.ok) {
        return {
          ok: false,
          code: "GATE_PRECONDITION_VIOLATION",
          message: `gate:decided verify-accept approval failed ${gateResult.checks.length} verify-accept check(s); see detail.checks`,
          detail: {
            gate: "verify-accept",
            failure_count: gateResult.checks.length,
            checks: gateResult.checks,
          },
        };
      }
    }
  }

  // Pass 2: sidecar promotion. All entries validated; from here we accept
  // that any failure may leave on-disk residue (sidecar attachments) that
  // `loaf doctor --orphan-attachment` will GC. Planned validation failures
  // (the kind users hit constantly while iterating) DO NOT reach this pass.
  const promoted: JournalEntry[] = [];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const p = await promoteSidecars(candidates[i]!, ctx.feature_dir, {
        fsync: ctx.fsync ?? true,
      });
      promoted.push(p);
    } catch (err) {
      return {
        ok: false,
        code: "SIDECAR_ERROR",
        message: `sidecar finalize failed: ${String(err)}`,
        failed_index: i,
        detail: { err: String(err) },
      };
    }
  }

  // Pass 3 (protocol §11.2 step 5c, codex r13): final reducer dry-run on
  // PROMOTED entries against a fresh clone of ctx.snapshot. Asserts that
  // the promoted form produces the same projection as Pass 1's accumulator.
  // Today's reducers do not read LongTextField bodies, so this is a no-op
  // success; but the gate is a forward-compatibility guard against a
  // future reducer that DOES dereference sidecar refs (which would silently
  // drift in-memory snapshot from replay-from-journal snapshot).
  let finalSnapshot: Snapshot = structuredClone(ctx.snapshot);
  for (let i = 0; i < promoted.length; i++) {
    const dryRun = apply(finalSnapshot, promoted[i]!);
    if (!dryRun.ok) {
      return {
        ok: false,
        code: "REDUCER_ERROR",
        message: `final dry-run on promoted entries failed at index ${i}: ${dryRun.message}`,
        failed_index: i,
        detail: { code: dryRun.code, phase: "post-sidecar", ...(dryRun.detail ?? {}) },
      };
    }
    finalSnapshot = dryRun.snapshot;
  }
  if (JSON.stringify(finalSnapshot) !== JSON.stringify(snapshotAcc)) {
    return {
      ok: false,
      code: "REDUCER_ERROR",
      message:
        "snapshot drift between unpromoted and promoted dry-runs — a reducer is reading LongTextField content; the batch is unsafe to append",
      detail: { phase: "drift-check" },
    };
  }

  // Single fsync'd batch append (appendMany handles envelope + per-kind
  // payload + per-entry + batch-total byte caps internally).
  const journalPath = path.join(ctx.feature_dir, "journal.jsonl");
  try {
    await appendMany(journalPath, promoted, { fsync: ctx.fsync ?? true });
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

  return { ok: true, snapshot: finalSnapshot, entries: promoted };
}

/**
 * Single-entry shorthand for `mutateBatch([partial], ctx)`. Returns the
 * single produced entry under the `entry` key for API compatibility with
 * callers that always emit one entry.
 */
export async function mutate(
  partial: PartialEntry,
  ctx: MutateContext,
): Promise<MutateResult> {
  const batch = await mutateBatch([partial], ctx);
  if (!batch.ok) {
    return batch.detail !== undefined
      ? { ok: false, code: batch.code, message: batch.message, detail: batch.detail }
      : { ok: false, code: batch.code, message: batch.message };
  }
  return { ok: true, snapshot: batch.snapshot, entry: batch.entries[0]! };
}
