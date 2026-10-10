// Machine-local pending-scope lifecycle policy. session-runtime owns storage
// validation, identity fencing, atomic publication and the runtime lock.
import type { SessionRuntimeFile, StateProjection } from "./projection-schema.js";
import { loadSession } from "./cli-runtime.js";
import { compareScopePathBytes, type JournalEntry } from "./journal-entry.js";
import { findScopeClosureFact } from "./scope-closure-policy.js";
import { resolveScopePaths } from "./scope-projection.js";
import { normalizeScopePath, type NormalizedScopePath } from "./scope-track.js";
import {
  withRuntimeLock,
  type RuntimeIdentity,
  type RuntimeStoreOptions,
} from "./session-runtime.js";

function runtimeOrInitial(
  current: SessionRuntimeFile | null,
  identity: RuntimeIdentity,
  debug: boolean,
  heartbeatAt: string,
): SessionRuntimeFile {
  return (
    current ?? {
      schema_version: 2,
      session_id: identity.session_id,
      cwd: identity.cwd,
      debug,
      heartbeat_at: heartbeatAt,
      pending_scope: null,
    }
  );
}

export interface TrackPendingScopeOptions {
  targetPath: string;
  featureDir: string;
  identity: RuntimeIdentity;
  debug: boolean;
  /** Cursor captured by the trusted session read before waiting on the lock. */
  cursor: Pick<StateProjection, "sub_state" | "iteration">;
  runtime: RuntimeStoreOptions;
}

/** Normalize and accumulate a PostToolUse path, publishing heartbeat even on
 * path rejection. Storage failures propagate before the caller renders that
 * rejection; the lock still owns the complete read-modify-write operation. */
export async function trackPendingScope(
  options: TrackPendingScopeOptions,
): Promise<NormalizedScopePath> {
  let normalized: NormalizedScopePath;
  try {
    normalized = await normalizeScopePath(options.targetPath, options.identity.cwd);
  } catch {
    normalized = { ok: false, reason: "invalid_scope_path", path: options.targetPath };
  }
  const heartbeatAt = options.runtime.now().toISOString();
  await withRuntimeLock(
    options.identity,
    "scope-track",
    async (current) => {
      const base = runtimeOrInitial(current, options.identity, options.debug, heartbeatAt);
      if (
        !normalized.ok ||
        normalized.kind === "internal" ||
        options.cursor.sub_state !== "EXECUTE.work"
      ) {
        return { ...base, heartbeat_at: heartbeatAt };
      }
      const pending = base.pending_scope;
      let carriedPaths: string[] = [];
      if (pending !== null && pending.iteration === options.cursor.iteration) {
        carriedPaths = pending.paths;
      } else if (pending !== null && pending.iteration < options.cursor.iteration) {
        // Read canonical history under the runtime lock. The captured cursor
        // remains authoritative for this hook, including hooks waiting on a
        // closure; replay is read-only and never acquires a feature lock.
        const history = await loadSession(options.featureDir, { ensureDir: false });
        if (history.snapshot.state?.session_id !== options.identity.session_id) {
          throw new Error("scope-track history does not match the selected session identity");
        }
        carriedPaths = await uncoveredPendingPaths(pending, {
          entries: history.entries,
          featureDir: options.featureDir,
        });
      }
      const paths = new Set(carriedPaths);
      paths.add(normalized.path);
      return {
        ...base,
        heartbeat_at: heartbeatAt,
        pending_scope: {
          iteration: options.cursor.iteration,
          paths: [...paths].sort(compareScopePathBytes),
        },
      };
    },
    options.runtime,
  );
  return normalized;
}

export interface PendingScopeClosureContext {
  identity: RuntimeIdentity;
  debug: boolean;
  heartbeatAt: string;
  iteration: number;
  entries: readonly JournalEntry[];
  featureDir: string;
}

export type PendingScopeClosureFailure = {
  code: "EXECUTE_CLOSURE_STATE_CHANGED" | "EXECUTE_CLOSURE_COMMIT_AMBIGUOUS";
  message: string;
  detail: Record<string, unknown>;
};

type PendingScopeFailureResult = { ok: false; failure: PendingScopeClosureFailure };
export type PendingScopePreparationResult =
  | { ok: true; runtime: SessionRuntimeFile; paths: string[] }
  | PendingScopeFailureResult;
export type PendingScopeSettlementResult =
  | { ok: true; runtime: SessionRuntimeFile }
  | PendingScopeFailureResult;
export type PendingScopeSettlementPhase = "committed" | "recovered" | "committed-failure";

async function uncoveredPendingPaths(
  pending: NonNullable<SessionRuntimeFile["pending_scope"]>,
  context: Pick<PendingScopeClosureContext, "entries" | "featureDir">,
): Promise<string[]> {
  const scope = findScopeClosureFact(context.entries, pending.iteration)?.scope;
  if (scope === undefined) return [...pending.paths];
  const recorded = new Set(await resolveScopePaths(scope, context.featureDir));
  return pending.paths.filter((scopePath) => !recorded.has(scopePath));
}

async function pendingIsCovered(
  pending: NonNullable<SessionRuntimeFile["pending_scope"]>,
  context: PendingScopeClosureContext,
): Promise<boolean> {
  const scope = findScopeClosureFact(context.entries, pending.iteration)?.scope;
  // Even an empty pending set requires a canonical origin-iteration fact.
  if (scope === undefined) return false;
  const recorded = new Set(await resolveScopePaths(scope, context.featureDir));
  return pending.paths.every((scopePath) => recorded.has(scopePath));
}

/** Select closure paths without writing runtime or acquiring a lock. Older
 * pending scope carries only paths absent from its own iteration's closure. */
export async function preparePendingScopeClosure(
  current: SessionRuntimeFile | null,
  context: PendingScopeClosureContext,
): Promise<PendingScopePreparationResult> {
  const runtime = runtimeOrInitial(current, context.identity, context.debug, context.heartbeatAt);
  const pending = runtime.pending_scope;
  if (pending === null) return { ok: true, runtime, paths: [] };
  if (pending.iteration === context.iteration) {
    return { ok: true, runtime, paths: [...pending.paths] };
  }
  if (pending.iteration > context.iteration) {
    return {
      ok: false,
      failure: {
        code: "EXECUTE_CLOSURE_STATE_CHANGED",
        message: `runtime pending scope is from future iteration ${pending.iteration}, ahead of journal iteration ${context.iteration}`,
        detail: { pending_iteration: pending.iteration, current_iteration: context.iteration },
      },
    };
  }
  return { ok: true, runtime, paths: await uncoveredPendingPaths(pending, context) };
}

/** Compute a replacement after the coordinator proves a commit or recovery.
 * Normal success clears directly; recovery and committed failures require
 * coverage of the pending set in its origin iteration, not the current one. */
export async function settlePendingScope(
  current: SessionRuntimeFile | null,
  context: PendingScopeClosureContext,
  phase: "committed",
): Promise<Extract<PendingScopeSettlementResult, { ok: true }>>;
export async function settlePendingScope(
  current: SessionRuntimeFile | null,
  context: PendingScopeClosureContext,
  phase: PendingScopeSettlementPhase,
): Promise<PendingScopeSettlementResult>;
export async function settlePendingScope(
  current: SessionRuntimeFile | null,
  context: PendingScopeClosureContext,
  phase: PendingScopeSettlementPhase,
): Promise<PendingScopeSettlementResult> {
  const runtime = runtimeOrInitial(current, context.identity, context.debug, context.heartbeatAt);
  const pending = runtime.pending_scope;
  if (phase === "recovered" && pending !== null && pending.iteration > context.iteration) {
    return {
      ok: false,
      failure: {
        code: "EXECUTE_CLOSURE_STATE_CHANGED",
        message:
          "runtime pending scope is ahead of the committed journal iteration; refusing to rewrite causal order",
        detail: { pending_iteration: pending.iteration, iteration: context.iteration },
      },
    };
  }
  if (phase === "committed" || pending === null || (await pendingIsCovered(pending, context))) {
    return {
      ok: true,
      runtime: { ...runtime, heartbeat_at: context.heartbeatAt, pending_scope: null },
    };
  }
  if (phase === "committed-failure") {
    return {
      ok: false,
      failure: {
        code: "EXECUTE_CLOSURE_COMMIT_AMBIGUOUS",
        message:
          "post-append journal proof does not cover all pending scope paths; refusing to clear",
        detail: { iteration: context.iteration },
      },
    };
  }
  // A hook that captured EXECUTE.work before waiting on the closure lock may
  // publish afterward. Recovery preserves that late set for carry-forward.
  return { ok: true, runtime: { ...runtime, heartbeat_at: context.heartbeatAt } };
}
