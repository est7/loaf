import type { SessionLoad } from "./cli-runtime.js";
import { loadSession } from "./cli-runtime.js";
import type { JournalEntry } from "./journal-entry.js";
import type { MutateBatchResult, MutateContext } from "./journal-mutate.js";
import { mutateBatch } from "./journal-mutate.js";
import type { SessionRuntimeFile } from "./projection-schema.js";
import { resolveScopePaths } from "./scope-projection.js";
import {
  readSessionRuntimeFile,
  withRuntimeLock,
  type RuntimeIdentity,
  type RuntimeStoreOptions,
} from "./session-runtime.js";

type MutateOkBatch = Extract<MutateBatchResult, { ok: true }>;
type MutateFailure = Extract<MutateBatchResult, { ok: false }>;

class ClosureNotCommitted extends Error {}

export interface ExecuteClosureHooks {
  /** Operational/fault-injection boundary immediately before mutateBatch. */
  beforeAppend?: () => void | Promise<void>;
  /** Operational/fault-injection boundary after commit proof and before runtime clear. */
  afterCommitBeforeClear?: () => void | Promise<void>;
  /** Deterministic seam for proving reload count across commit outcomes. */
  reloadSession?: (featureDir: string) => Promise<SessionLoad>;
}

export type ExecuteClosureResult =
  | { kind: "committed"; result: MutateOkBatch; from: "EXECUTE.work" }
  | { kind: "recovered"; session: SessionLoad; from: "EXECUTE.work" }
  | { kind: "failure"; failure: MutateFailure }
  | { kind: "not-committed" };

export class ExecuteClosureError extends Error {
  readonly code:
    | "EXECUTE_CLOSURE_RELOAD_FAILED"
    | "EXECUTE_CLOSURE_STATE_CHANGED"
    | "EXECUTE_CLOSURE_COMMIT_AMBIGUOUS";
  readonly detail?: Record<string, unknown>;

  constructor(
    code: ExecuteClosureError["code"],
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ExecuteClosureError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
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

function committedScopeEntry(
  entries: readonly JournalEntry[],
  iteration: number,
): JournalEntry | null {
  for (let index = 0; index + 1 < entries.length; index += 1) {
    const scope = entries[index]!;
    const closure = entries[index + 1]!;
    if (scope.kind !== "scope:recorded") continue;
    const payload = scope.payload as { iteration?: unknown };
    if (payload.iteration !== iteration || !isExecuteClosure(closure)) continue;
    if (
      scope.batch_id !== undefined &&
      scope.batch_id === closure.batch_id &&
      scope.batch_index === 0 &&
      closure.batch_index === 1 &&
      scope.batch_count === 2 &&
      closure.batch_count === 2
    ) {
      return scope;
    }
  }
  return null;
}

async function pendingIsCovered(
  pending: NonNullable<SessionRuntimeFile["pending_scope"]>,
  entries: readonly JournalEntry[],
  featureDir: string,
): Promise<boolean> {
  const scope = committedScopeEntry(entries, pending.iteration);
  if (scope === null) return false;
  const recorded = new Set(await resolveScopePaths(scope, featureDir));
  return pending.paths.every((scopePath) => recorded.has(scopePath));
}

function baseRuntime(
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

function stampedClosureBatch(
  actor: string,
  iteration: number,
  paths: readonly string[],
  at: string,
): Parameters<typeof mutateBatch>[0] {
  return [
    {
      at,
      actor,
      entry_schema_version: 1,
      kind: "scope:recorded",
      payload: { iteration, paths: [...paths] },
    },
    {
      at,
      actor,
      entry_schema_version: 1,
      kind: "event:phase_advanced",
      payload: { from: "EXECUTE.work", to: "EXECUTE.done" },
    },
  ];
}

async function reloadForCommitProof(
  featureDir: string,
  loader: (featureDir: string) => Promise<SessionLoad> = (target) =>
    loadSession(target, { ensureDir: false }),
): Promise<SessionLoad> {
  try {
    return await loader(featureDir);
  } catch (error) {
    throw new ExecuteClosureError(
      "EXECUTE_CLOSURE_RELOAD_FAILED",
      `cannot reload journal to prove EXECUTE closure commit: ${(error as Error).message}`,
    );
  }
}

async function pathsForCurrentIteration(
  runtime: SessionRuntimeFile,
  session: SessionLoad,
  featureDir: string,
): Promise<string[]> {
  const iteration = session.snapshot.state!.iteration;
  const pending = runtime.pending_scope;
  if (pending === null) return [];
  if (pending.iteration === iteration) return [...pending.paths];
  if (pending.iteration > iteration) {
    throw new ExecuteClosureError(
      "EXECUTE_CLOSURE_STATE_CHANGED",
      `runtime pending scope is from future iteration ${pending.iteration}, ahead of journal iteration ${iteration}`,
      { pending_iteration: pending.iteration, current_iteration: iteration },
    );
  }

  const committed = committedScopeEntry(session.entries, pending.iteration);
  if (committed === null) return [...pending.paths];
  const recorded = new Set(await resolveScopePaths(committed, featureDir));
  return pending.paths.filter((scopePath) => !recorded.has(scopePath));
}

async function canClearPending(
  runtime: SessionRuntimeFile,
  entries: readonly JournalEntry[],
  featureDir: string,
): Promise<boolean> {
  return (
    runtime.pending_scope === null ||
    (await pendingIsCovered(runtime.pending_scope, entries, featureDir))
  );
}

export interface ExecuteClosureOptions {
  featureDir: string;
  session: SessionLoad;
  actor: string;
  identity: RuntimeIdentity;
  runtime: RuntimeStoreOptions;
  debug: boolean;
  hooks?: ExecuteClosureHooks;
  mutateContext: (session: SessionLoad) => MutateContext;
}

/**
 * Close one EXECUTE iteration while holding runtime state over the journal
 * commit. Lock order is runtime first, feature second (inside mutateBatch).
 * Ordinary journal mutators never acquire the runtime lock, so no reverse
 * edge exists and the two-lock dependency graph stays acyclic.
 */
export async function executeClosureTransaction(
  options: ExecuteClosureOptions,
): Promise<ExecuteClosureResult> {
  const initialState = options.session.snapshot.state;
  if (initialState == null) return { kind: "not-committed" };

  // Dry-run remains canonical-write free. It takes the feature lease only
  // after this branch's lock-free runtime read, so it never introduces a
  // feature-then-runtime edge.
  if (options.mutateContext(options.session).dryRun) {
    if (initialState.sub_state !== "EXECUTE.work") return { kind: "not-committed" };
    const heartbeatAt = options.runtime.now().toISOString();
    const current = baseRuntime(
      await readSessionRuntimeFile(options.identity, options.runtime),
      options.identity,
      options.debug,
      heartbeatAt,
    );
    const paths = await pathsForCurrentIteration(current, options.session, options.featureDir);
    const result = await mutateBatch(
      stampedClosureBatch(options.actor, initialState.iteration, paths, heartbeatAt),
      options.mutateContext(options.session),
    );
    return result.ok
      ? { kind: "committed", result, from: "EXECUTE.work" }
      : { kind: "failure", failure: result };
  }

  let outcome: ExecuteClosureResult | null = null;
  const heartbeatAt = options.runtime.now().toISOString();
  try {
    await withRuntimeLock(
      options.identity,
      "execute-closure",
      async (current) => {
        const runtime = baseRuntime(current, options.identity, options.debug, heartbeatAt);
        const session = await reloadForCommitProof(
          options.featureDir,
          options.hooks?.reloadSession,
        );
        const state = session.snapshot.state;
        if (state == null) {
          throw new ClosureNotCommitted();
        }
        const committed = committedScopeEntry(session.entries, state.iteration);

        if (state.sub_state === "EXECUTE.done" && committed !== null) {
          if (runtime.pending_scope !== null && runtime.pending_scope.iteration > state.iteration) {
            throw new ExecuteClosureError(
              "EXECUTE_CLOSURE_STATE_CHANGED",
              "runtime pending scope is ahead of the committed journal iteration; refusing to rewrite causal order",
              { pending_iteration: runtime.pending_scope?.iteration, iteration: state.iteration },
            );
          }
          outcome = { kind: "recovered", session, from: "EXECUTE.work" };
          if (await canClearPending(runtime, session.entries, options.featureDir)) {
            return { ...runtime, heartbeat_at: heartbeatAt, pending_scope: null };
          }
          // A scope-track that read EXECUTE.work before waiting on this lock
          // may publish after the closure commits. Preserve that late set for
          // monotone carry-forward into the next EXECUTE iteration.
          return { ...runtime, heartbeat_at: heartbeatAt };
        }
        if (state.sub_state === "EXECUTE.done") {
          throw new ClosureNotCommitted();
        }
        if (state.sub_state !== "EXECUTE.work") {
          throw new ExecuteClosureError(
            "EXECUTE_CLOSURE_STATE_CHANGED",
            `session moved to ${state.sub_state} while preparing EXECUTE closure`,
            { expected: "EXECUTE.work", actual: state.sub_state },
          );
        }

        const paths = await pathsForCurrentIteration(runtime, session, options.featureDir);
        await options.hooks?.beforeAppend?.();
        const result = await mutateBatch(
          stampedClosureBatch(options.actor, state.iteration, paths, heartbeatAt),
          options.mutateContext(session),
        );
        if (result.ok) {
          outcome = { kind: "committed", result, from: "EXECUTE.work" };
          await options.hooks?.afterCommitBeforeClear?.();
          return { ...runtime, heartbeat_at: heartbeatAt, pending_scope: null };
        }

        if (result.commit_state === "committed") {
          const committedEntries = session.entries.concat(result.entries);
          const proof = committedScopeEntry(committedEntries, state.iteration);
          if (proof !== null) {
            if (!(await canClearPending(runtime, committedEntries, options.featureDir))) {
              throw new ExecuteClosureError(
                "EXECUTE_CLOSURE_COMMIT_AMBIGUOUS",
                "post-append journal proof does not cover all pending scope paths; refusing to clear",
                { iteration: state.iteration },
              );
            }
            outcome = { kind: "failure", failure: result };
            await options.hooks?.afterCommitBeforeClear?.();
            return { ...runtime, heartbeat_at: heartbeatAt, pending_scope: null };
          }
        }

        outcome = { kind: "failure", failure: result };
        return runtime;
      },
      options.runtime,
    );
  } catch (error) {
    if (error instanceof ClosureNotCommitted) return { kind: "not-committed" };
    throw error;
  }

  if (outcome === null) {
    throw new Error("internal invariant: EXECUTE closure transaction produced no outcome");
  }
  return outcome;
}
