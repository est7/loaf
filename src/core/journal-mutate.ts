// journal-mutate — the single transactional mutator API.
//
// `mutateBatch(partials[], ctx)` is the protocol-level multi-entry mutator
// (§11.2 step 2-7 collapsed). `mutate(partial, ctx)` is the single-entry
// shorthand for `mutateBatch([partial], ctx)`.
//
// Step mapping inside one batch:
//   step 1 (lock acquire)     — IMPLEMENTED (W3): O_EXCL `.lock` in feature_dir,
//                               acquired after the dry-run early-return and
//                               before the first disk write (Pass 2);
//                               throw-only (WRITE_CONTENTION on EEXIST, no wait)
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
//   step 7 (post-apply)       — reducer.applyValidated already ran during dry-run on
//                               the cloned snapshot accumulator; that IS the
//                               new state (apply mutates in place)
//   step 8 (snapshot rebuild) — IMPLEMENTED (Phase 15 SC2): after the append,
//                               re-serialize all five snapshots/*.json
//                               projection files + _meta.json via the shared
//                               `writeProjections`. The prefix is the
//                               authoritative entry stream — ctx.entries (the
//                               journal as of tail_seq) concatenated with the
//                               just-appended promoted batch — so no journal
//                               re-read is needed. appendMany returns the
//                               post-append SnapshotMeta which _meta.json
//                               records. Every mutation refreshes all five
//                               projections (no affected-file filter).
//   step 9 (registry refresh) — IMPLEMENTED (Phase 16 SC-7): after step 8,
//                               build + write `~/.loaf/registry/<id>.json`
//                               per protocol §4.12. Best-effort IO write
//                               (silenced on failure — registry is a
//                               TUI projection, not gate authority);
//                               schema-derivation failure surfaces as a
//                               mutate failure (NOT silent ok, NOT CLI
//                               crash — codex r280 P4 split).
//   step 10 (lock release)    — IMPLEMENTED (W3): finally-released on every
//                               exit path (success / mid-span error / throw);
//                               best-effort unlink, stale lock cleared by doctor
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
import { promises as fsp } from "node:fs";
import { O_CREAT, O_EXCL, O_WRONLY } from "node:constants";
import { isDeepStrictEqual } from "node:util";

import { AppendError, appendMany } from "./journal-append.js";
import { evaluateSpecLock } from "./gates/spec-lock-eval.js";
import { evaluateVerifyAccept } from "./gates/verify-accept-eval.js";
import { type JournalEntry } from "./journal-entry.js";
import { REDUCER_IMPLEMENTED_KINDS, SPEC_EMITTING_KINDS } from "./kind-registry.js";
import { writeProjections } from "./projection-writer.js";
import { applyValidated, type Snapshot } from "./reducer.js";
import { preflight, type PreflightFailureCode } from "./reducer/preflight.js";
import { promoteSidecars } from "./sidecar.js";
import { isEmptyMeta, type SnapshotMeta } from "./snapshot.js";
import { buildRegistryFile, writeRegistryFile } from "./registry-writer.js";
import type { RegistryFile } from "./projection-schema.js";
import { writeDerivedSpecMd } from "./spec-projection.js";
import {
  checkTaskGraph,
  type TaskGraphFailureCode,
} from "./task-graph.js";

export interface MutateContext {
  /** Feature directory; journal.jsonl + attachments/ + snapshots/ live here */
  feature_dir: string;
  /** Current snapshot — pre-mutation projection */
  snapshot: Snapshot;
  /** Tail seq from journal — -1 if journal is empty / absent */
  tail_seq: number;
  /** The parsed entries of the journal as of `tail_seq`, in order — what
   *  `loadSession` returns. `mutateBatch` step 8 concatenates this with the
   *  just-appended batch to form the authoritative prefix for
   *  `writeProjections` (no journal re-read). Its last entry's `seq` MUST
   *  equal `tail_seq`; a mismatch fails fast before the append. Empty for a
   *  fresh feature (`tail_seq` = -1). */
  entries: JournalEntry[];
  /** The `SnapshotMeta` as of `tail_seq` — what `loadSession` returns.
   *  Handed to `appendMany` as the authoritative prior meta; `appendMany`
   *  validates it against the journal tail and returns the post-append meta.
   *  Its `last_applied_seq` MUST equal `tail_seq`; a mismatch fails fast
   *  before the append. `emptyMeta()` for a fresh feature. */
  meta: SnapshotMeta;
  /** Disable fsync for tests */
  fsync?: boolean;
  /** Phase 16 SC-6c — when true, run preflight (Pass 0/1/1.5) + the
   *  MutateContext integrity check (Pass A), then SHORT-CIRCUIT before
   *  Pass 2 (sidecar promote), Pass 3 (final reducer + drift), Pass 4
   *  (`appendMany`), Pass 5 (spec.md projection), and step 8 (snapshots).
   *  No disk write — so dryRun runs BEFORE the W3 write lock is acquired and
   *  is never blocked by it (a held `.lock` does not fence a read-only
   *  preview). Returns the same ok-shape with the would-be snapshot +
   *  stamped (but unpromoted) candidates + unchanged ctx.meta. Future
   *  versions may also stage sidecars to `.tmp-*` per protocol §10.7. */
  dryRun?: boolean;
  /** Phase 16 SC-7 — registry-writer DI seam. Production omits; defaults
   *  to `defaultRegistryDir()` (~/.loaf/registry/) + `new Date()` +
   *  `process.cwd()`. Tests inject a tmp dir + canned now/cwd so they
   *  never touch the real user registry. `| undefined` is explicit so
   *  CLI sites can spread a precomputed `undefined` from MainDeps under
   *  `exactOptionalPropertyTypes`. */
  registryWriter?:
    | {
        registryDir?: string;
        now?: () => Date;
        cwd?: () => string;
      }
    | undefined;
}

export type MutateFailureCode =
  | PreflightFailureCode
  | TaskGraphFailureCode
  | "APPEND_ERROR"
  | "SIDECAR_ERROR"
  | "REDUCER_ERROR"
  | "INVALID_BATCH"
  | "GATE_PRECONDITION_VIOLATION"
  | "MULTIPLE_GATE_DECISIONS"
  | "PROJECTION_WRITE_FAILED"
  | "WRITE_CONTENTION";

export type MutateResult =
  | { ok: true; snapshot: Snapshot; entry: JournalEntry; meta: SnapshotMeta }
  | {
      ok: false;
      code: MutateFailureCode;
      message: string;
      detail?: Record<string, unknown>;
    };

export type MutateBatchResult =
  | { ok: true; snapshot: Snapshot; entries: JournalEntry[]; meta: SnapshotMeta }
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

function isBootstrapEntry(entry: JournalEntry): boolean {
  return entry.kind === "session:started" || entry.kind === "migration:snapshot_imported";
}

function noSessionResult(entry: JournalEntry, failedIndex: number): MutateBatchResult {
  return {
    ok: false,
    code: "REDUCER_ERROR",
    message: `kind=${entry.kind} requires a started session`,
    failed_index: failedIndex,
    detail: { code: "NO_SESSION" },
  };
}

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

    if (!isBootstrapEntry(candidate) && snapshotAcc.state === null) {
      return noSessionResult(candidate, i);
    }

    const dryRun = applyValidated(snapshotAcc, candidate);
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
  // residue. Task-graph admission validates snapshotAcc (the batch-final
  // projection) once so intra-batch references are order-independent.
  // Gate approvals below deliberately use ctx.snapshot (pre-batch) — a
  // batch must not satisfy its own gate preconditions with earlier entries.
  //
  // Detection rule: count ALL `gate:decided` entries whose decision is
  // "approved" across the batch (any gate_kind). Protocol §10.8 makes
  // each gate decision a single atomic operation, so a batch carrying
  // ≥2 gate approvals — even with different gate_kinds — is invalid.
  // Rejected gate decisions pass through (rejection requires no gate
  // satisfaction; preflight + reducer dry-run still validates them).
  const taskGraphChanged = candidates.some(
    (candidate) =>
      candidate.kind === "event:tasks_planned" || candidate.kind === "event:tasks_amended",
  );
  if (taskGraphChanged) {
    const graphFailure = checkTaskGraph(snapshotAcc.tasks);
    if (graphFailure !== null) {
      return {
        ok: false,
        code: graphFailure.code,
        message: graphFailure.message,
        detail: graphFailure.detail,
      };
    }
  }

  const gateApprovals = candidates.filter(
    (c) =>
      c.kind === "gate:decided" && (c.payload as { decision?: string }).decision === "approved",
  );
  if (gateApprovals.length > 1) {
    return {
      ok: false,
      code: "MULTIPLE_GATE_DECISIONS",
      message: `batch contains ${gateApprovals.length} approved gate:decided entries; protocol §10.8 requires one gate decision per atomic operation`,
      detail: {
        count: gateApprovals.length,
        gate_kinds: gateApprovals.map((c) => (c.payload as { gate_kind?: string }).gate_kind),
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

  // Pass A: fail-fast context-integrity invariant (Phase 15 SC2; moved
  // here from after Pass 3 in SC-6c per codex r275 P3 + r276 P7). step 8
  // writes `_meta.json` from the post-append meta, which is only
  // authoritative if `ctx.entries` / `ctx.meta` describe the SAME journal
  // prefix as `ctx.tail_seq`. A stale or hand-built context (entries
  // tail seq or meta.last_applied_seq drifted from tail_seq) must be
  // rejected BEFORE the append makes the projection writes authoritative
  // for the wrong prefix. An empty prefix (tail_seq -1) additionally
  // requires the empty-sentinel meta — seq -1 alone does not rule out
  // a corrupt rolling_checksum that `appendMany` would fold into the
  // post-append meta (codex r171 BLOCK 2).
  //
  // Placement: AFTER Pass 1.5 (gate eval) so preflight + gate errors keep
  // their existing priority; IMMEDIATELY BEFORE the dry-run early-return
  // so both dry-run and real-append paths share the same guard (codex
  // r276 priority constraint).
  const ctxEntriesTailSeq = ctx.entries[ctx.entries.length - 1]?.seq ?? -1;
  const emptyPrefixMetaBad = ctx.tail_seq === -1 && !isEmptyMeta(ctx.meta);
  if (
    ctxEntriesTailSeq !== ctx.tail_seq ||
    ctx.meta.last_applied_seq !== ctx.tail_seq ||
    emptyPrefixMetaBad
  ) {
    return {
      ok: false,
      code: "INVALID_BATCH",
      message:
        `MutateContext is internally inconsistent: tail_seq=${ctx.tail_seq} but ` +
        `entries tail seq=${ctxEntriesTailSeq}, meta.last_applied_seq=${ctx.meta.last_applied_seq}` +
        (emptyPrefixMetaBad ? ", and meta is not the empty sentinel for an empty prefix" : "") +
        `; entries + meta must describe the same journal prefix as tail_seq`,
      detail: {
        tail_seq: ctx.tail_seq,
        entries_tail_seq: ctxEntriesTailSeq,
        meta_last_applied_seq: ctx.meta.last_applied_seq,
        empty_prefix_meta_bad: emptyPrefixMetaBad,
      },
    };
  }

  // SC-6c dry-run early-return: skip remaining disk-touching passes
  // (sidecar promote, final reducer + drift, journal append, spec.md +
  // snapshots projection). Returns the would-be snapshot from Pass 1's
  // accumulator + the stamped (but unpromoted) candidates + unchanged
  // ctx.meta. The caller knows from `ctx.dryRun` whether to format
  // success as a "would do" summary.
  if (ctx.dryRun) {
    return {
      ok: true,
      snapshot: snapshotAcc,
      entries: candidates,
      meta: ctx.meta,
    };
  }

  // W3 — per-feature write-contention fence (§11.2 step 1/10, throw-only).
  // Everything past this point touches disk (sidecar promote → append →
  // projections → registry). The MVP single-writer assumption was previously
  // unenforced: two concurrent CLI invocations could both pass the prior-meta
  // check, build entries at the same seq, and O_APPEND-interleave. Acquire an
  // O_EXCL lock file BEFORE the first write; on contention throw-fail fast
  // (no wait loop, no PID-stealing, no timeout machinery, no lock manager —
  // the caller retries). Released in the finally below on EVERY exit path.
  // Placed AFTER the dry-run early-return: a dry run writes nothing, so it
  // must neither acquire nor be blocked by the lock.
  const lockPath = path.join(ctx.feature_dir, ".lock");
  let lockFh: fsp.FileHandle;
  try {
    lockFh = await fsp.open(lockPath, O_CREAT | O_EXCL | O_WRONLY, 0o644);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return {
        ok: false,
        code: "WRITE_CONTENTION",
        message: `another writer holds the per-feature lock at ${lockPath}; retry after it releases (if no writer is active, a prior run crashed mid-write — remove the lock and run 'loaf doctor')`,
        detail: { lock_path: lockPath },
      };
    }
    throw err;
  }

  try {
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
      const entry = promoted[i]!;
      const isBootstrap = isBootstrapEntry(entry);
      if (!isBootstrap) {
        const pre = preflight(entry, {
          snapshot: finalSnapshot,
          tail_seq: ctx.tail_seq + i,
        });
        if (!pre.ok) {
          return {
            ok: false,
            code: "REDUCER_ERROR",
            message: `final dry-run on promoted entries failed at index ${i}: ${pre.message}`,
            failed_index: i,
            detail: { code: pre.code, phase: "post-sidecar", ...(pre.detail ?? {}) },
          };
        }
        if (finalSnapshot.state === null) {
          return noSessionResult(entry, i);
        }
      }
      const dryRun = applyValidated(finalSnapshot, entry);
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
    if (!isDeepStrictEqual(finalSnapshot, snapshotAcc)) {
      return {
        ok: false,
        code: "REDUCER_ERROR",
        message:
          "snapshot drift between unpromoted and promoted dry-runs — a reducer is reading LongTextField content; the batch is unsafe to append",
        detail: { phase: "drift-check" },
      };
    }

    // Single fsync'd batch append (appendMany handles envelope + per-kind
    // payload + per-entry + batch-total byte caps internally). `appendMany`
    // also validates `ctx.meta` against the on-disk journal tail and returns
    // the post-append `SnapshotMeta` step 8 writes to `_meta.json`.
    const journalPath = path.join(ctx.feature_dir, "journal.jsonl");
    let appendMeta: SnapshotMeta;
    try {
      appendMeta = await appendMany(journalPath, promoted, ctx.meta, {
        fsync: ctx.fsync ?? true,
      });
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

    // Pass 5 — post-appendMany spec.md projection sync (Slice A SC-A2).
    // Journal is authoritative (Pass 4 already succeeded). spec.md is a
    // derived projection; sync it from finalSnapshot. On failure surface
    // PROJECTION_WRITE_FAILED — `loaf doctor --rebuild` (Slice 5 D) is
    // the recovery path; retrying the same payload would hit
    // DUPLICATE_*_ID against the already-appended journal entry.
    //
    // W3: Pass 5 now runs INSIDE the per-feature lock window (acquired before
    // Pass 2, released in the finally), so concurrent CLI invocations cannot
    // race spec.md between append and projection sync.
    if (promoted.some((entry) => SPEC_EMITTING_KINDS.has(entry.kind))) {
      try {
        await writeDerivedSpecMd(finalSnapshot, ctx.feature_dir);
      } catch (err) {
        const lastSeq = promoted[promoted.length - 1]!.seq;
        const failSpecVer = finalSnapshot.state?.spec_version ?? "unknown";
        return {
          ok: false,
          code: "PROJECTION_WRITE_FAILED",
          message: `spec.md projection write failed after journal append at last_seq=${lastSeq} (spec_version=${failSpecVer}); journal is authoritative — run 'loaf doctor --rebuild' to resync. Cause: ${(err as Error).message}`,
          detail: {
            projection: "spec.md",
            path: path.join(ctx.feature_dir, "spec.md"),
            journal_appended: true,
            last_seq: lastSeq,
            spec_version: finalSnapshot.state?.spec_version ?? null,
            error: (err as Error).message,
          },
        };
      }
    }

    // Step 8 — post-appendMany snapshot projection sync (Phase 15 SC2).
    // Re-serialize all five `snapshots/*.json` projection files + `_meta.json`
    // via the shared `writeProjections` — the same serializer `loaf doctor
    // --rebuild` drives. Runs unconditionally: every mutation refreshes all
    // five projections (no affected-file filter — Q3), so snapshots stay fresh
    // on every write, not just on `doctor --rebuild`.
    //
    // The entry prefix is authoritative — `ctx.entries` (the journal as of
    // tail_seq, validated above) concatenated with the just-appended
    // `promoted` batch. `appendMeta` is the post-append meta `appendMany`
    // returned; `writeProjections` records it verbatim in `_meta.json`,
    // metadata strictly after data.
    //
    // On failure surface PROJECTION_WRITE_FAILED — mirrors the spec.md Pass-5
    // failure shape: the journal is authoritative (the append already
    // succeeded), `loaf doctor --rebuild` is the recovery path; retrying the
    // same payload would hit a duplicate-id rejection against the
    // already-appended journal entry.
    //
    // W3: step 8, like Pass 5, now runs inside the per-feature lock window, so
    // concurrent CLI invocations cannot race the projection files.
    try {
      await writeProjections(ctx.feature_dir, {
        snapshot: finalSnapshot,
        entries: ctx.entries.concat(promoted),
        meta: appendMeta,
        fsync: ctx.fsync ?? true,
      });
    } catch (err) {
      const lastSeq = promoted[promoted.length - 1]!.seq;
      return {
        ok: false,
        code: "PROJECTION_WRITE_FAILED",
        message:
          `snapshot projection write failed after journal append at last_seq=${lastSeq}; ` +
          `journal is authoritative — run 'loaf doctor --rebuild' to resync. ` +
          `Cause: ${(err as Error).message}`,
        detail: {
          projection: "snapshots",
          path: path.join(ctx.feature_dir, "snapshots"),
          journal_appended: true,
          last_seq: lastSeq,
          error: (err as Error).message,
        },
      };
    }

    // Step 9 — Phase 16 SC-7 registry refresh (~/.loaf/registry/<id>.json).
    //
    // Two-layer guard per codex r280 P4:
    //   - buildRegistryFile() can throw on schema-derivation failure
    //     (corrupt session:started payload, etc.). NOT silenced — surfaces
    //     as a mutate failure result so the bug is visible (not laundered
    //     as "registry stale").
    //   - writeRegistryFile() IO failure is best-effort per §4.12 —
    //     swallowed silently; `loaf doctor --rebuild-registry` (future SC)
    //     recovers from canonical artifacts.
    //
    // Skipped when snapshot.state.session_id is null (pre-session:started
    // edge case — shouldn't happen post-MVP but defensive).
    if (finalSnapshot.state?.session_id) {
      let registryFile: RegistryFile | null;
      try {
        registryFile = buildRegistryFile({
          snapshot: finalSnapshot,
          entries: ctx.entries.concat(promoted),
          now: ctx.registryWriter?.now?.() ?? new Date(),
          cwd: ctx.registryWriter?.cwd?.() ?? process.cwd(),
        });
      } catch (err) {
        // Pure derivation failure — code defect, NOT silent. Surfaces as
        // a mutate failure with the parse cause (codex r280 P4).
        return {
          ok: false,
          code: "PROJECTION_WRITE_FAILED",
          message:
            `registry derivation failed after journal append; ` +
            `journal is authoritative — run 'loaf doctor --rebuild-registry' (future). ` +
            `Cause: ${(err as Error).message}`,
          detail: {
            projection: "registry",
            phase: "derivation",
            journal_appended: true,
            error: (err as Error).message,
          },
        };
      }

      if (registryFile) {
        try {
          await writeRegistryFile(registryFile.session_id, registryFile, {
            ...(ctx.registryWriter?.registryDir !== undefined && {
              registryDir: ctx.registryWriter.registryDir,
            }),
          });
        } catch {
          // Silent — §4.12 best-effort IO. Registry is a TUI projection,
          // not gate authority; readers tolerate stale; doctor --rebuild-
          // registry recovers from canonical artifacts.
        }
      }
    }

    return { ok: true, snapshot: finalSnapshot, entries: promoted, meta: appendMeta };
  } finally {
    // Release the write lock on EVERY exit path — the success return above, any
    // mid-span error return (SIDECAR_ERROR / REDUCER_ERROR drift / APPEND_ERROR
    // / PROJECTION_WRITE_FAILED), or an unexpected throw. Both close and unlink
    // are independently best-effort: a failing close() must NOT skip the unlink
    // (codex W3 nit), and a crash anywhere here leaves a stale `.lock` that the
    // next writer hits as WRITE_CONTENTION — the user removes it manually
    // (doctor does not yet auto-clear stale locks); the honest single-writer-MVP
    // recovery story.
    await lockFh.close().catch(() => {});
    await fsp.unlink(lockPath).catch(() => {});
  }
}

/**
 * Single-entry shorthand for `mutateBatch([partial], ctx)`. Returns the
 * single produced entry under the `entry` key for API compatibility with
 * callers that always emit one entry.
 */
export async function mutate(partial: PartialEntry, ctx: MutateContext): Promise<MutateResult> {
  const batch = await mutateBatch([partial], ctx);
  if (!batch.ok) {
    return batch.detail !== undefined
      ? { ok: false, code: batch.code, message: batch.message, detail: batch.detail }
      : { ok: false, code: batch.code, message: batch.message };
  }
  return { ok: true, snapshot: batch.snapshot, entry: batch.entries[0]!, meta: batch.meta };
}
