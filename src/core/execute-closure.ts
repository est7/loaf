import type { SessionLoad } from "./cli-runtime.js";
import { loadSession } from "./cli-runtime.js";
import type { MutateBatchResult, MutateContext } from "./journal-mutate.js";
import { mutateBatch } from "./journal-mutate.js";
import { buildScopeClosureEntries, findScopeClosureFact } from "./scope-closure-policy.js";
import {
  preparePendingScopeClosure,
  settlePendingScope,
  type PendingScopeClosureContext,
} from "./pending-scope.js";
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
    const prepared = await preparePendingScopeClosure(
      await readSessionRuntimeFile(options.identity, options.runtime),
      {
        identity: options.identity,
        debug: options.debug,
        heartbeatAt,
        iteration: initialState.iteration,
        entries: options.session.entries,
        featureDir: options.featureDir,
      },
    );
    if (!prepared.ok) {
      const { code, message, detail } = prepared.failure;
      throw new ExecuteClosureError(code, message, detail);
    }
    const result = await mutateBatch(
      buildScopeClosureEntries(options.actor, initialState.iteration, prepared.paths, heartbeatAt),
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
        const session = await reloadForCommitProof(
          options.featureDir,
          options.hooks?.reloadSession,
        );
        const state = session.snapshot.state;
        if (state == null) {
          throw new ClosureNotCommitted();
        }
        const context: PendingScopeClosureContext = {
          identity: options.identity,
          debug: options.debug,
          heartbeatAt,
          iteration: state.iteration,
          entries: session.entries,
          featureDir: options.featureDir,
        };
        const committed = findScopeClosureFact(session.entries, state.iteration);

        if (state.sub_state === "EXECUTE.done" && committed !== null) {
          const settled = await settlePendingScope(current, context, "recovered");
          if (!settled.ok) {
            const { code, message, detail } = settled.failure;
            throw new ExecuteClosureError(code, message, detail);
          }
          outcome = { kind: "recovered", session, from: "EXECUTE.work" };
          return settled.runtime;
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

        const prepared = await preparePendingScopeClosure(current, context);
        if (!prepared.ok) {
          const { code, message, detail } = prepared.failure;
          throw new ExecuteClosureError(code, message, detail);
        }
        await options.hooks?.beforeAppend?.();
        const result = await mutateBatch(
          buildScopeClosureEntries(options.actor, state.iteration, prepared.paths, heartbeatAt),
          options.mutateContext(session),
        );
        if (result.ok) {
          outcome = { kind: "committed", result, from: "EXECUTE.work" };
          await options.hooks?.afterCommitBeforeClear?.();
          const settled = await settlePendingScope(prepared.runtime, context, "committed");
          return settled.runtime;
        }

        if (result.commit_state === "committed") {
          const committedEntries = session.entries.concat(result.entries);
          const proof = findScopeClosureFact(committedEntries, state.iteration);
          if (proof !== null) {
            const settled = await settlePendingScope(
              prepared.runtime,
              { ...context, entries: committedEntries },
              "committed-failure",
            );
            if (!settled.ok) {
              const { code, message, detail } = settled.failure;
              throw new ExecuteClosureError(code, message, detail);
            }
            outcome = { kind: "failure", failure: result };
            await options.hooks?.afterCommitBeforeClear?.();
            return settled.runtime;
          }
        }

        outcome = { kind: "failure", failure: result };
        return prepared.runtime;
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
