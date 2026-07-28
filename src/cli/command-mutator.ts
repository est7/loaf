// CommandMutator is the only CLI adapter allowed to invoke journal mutation.
// Command handlers provide intent-shaped entries; this module owns context
// construction, timestamp policy, dry-run presentation, and failure routing.

import { mutate, mutateBatch, type MutateContext } from "../core/journal-mutate.js";
import {
  executeClosureTransaction,
  type ExecuteClosureOptions,
  type ExecuteClosureResult,
} from "../core/execute-closure.js";
import { emitInputSchema, formatSchema } from "./schema-emit.js";
import type { MutatorCommand } from "./input-schemas.js";
import type { MutatorEntry } from "./mutator-entry.js";
import type { SessionLoad } from "../core/cli-runtime.js";
import type { CommandContext } from "./command-context.js";

type RunPartial = Parameters<typeof mutate>[0];
export type FailureRoute = "emit-failure" | "legacy-fail" | "raw-ctx-failure";
export type TimestampStrategy = "shared" | "per-entry";
export type MutateOkSingle = Extract<Awaited<ReturnType<typeof mutate>>, { ok: true }>;
export type MutateOkBatch = Extract<Awaited<ReturnType<typeof mutateBatch>>, { ok: true }>;
type MutateFailure =
  | Extract<Awaited<ReturnType<typeof mutate>>, { ok: false }>
  | Extract<Awaited<ReturnType<typeof mutateBatch>>, { ok: false }>;
type SuccessfulExecuteClosure = Exclude<ExecuteClosureResult, { kind: "failure" }>;

export type CommandMutatorDeps = {
  registryWriter: MutateContext["registryWriter"] | undefined;
};

export type CommandMutator = {
  /** Single-entry or shared-timestamp batch mutation. */
  run: {
    (
      featureDir: string,
      session: SessionLoad,
      entry: MutatorEntry,
      route?: FailureRoute,
    ): Promise<MutateOkSingle | null>;
    (
      featureDir: string,
      session: SessionLoad,
      entries: readonly MutatorEntry[],
      route?: FailureRoute,
    ): Promise<MutateOkBatch | null>;
  };
  /** Batch mutation with an explicit timestamp policy. */
  runBatch: (
    featureDir: string,
    session: SessionLoad,
    entries: readonly MutatorEntry[],
    options: { timestamps: TimestampStrategy; route?: FailureRoute },
  ) => Promise<MutateOkBatch | null>;
  /** Mutate a batch whose actor, schema version, and timestamp are already fixed. */
  runPreparedBatch: (
    featureDir: string,
    session: SessionLoad,
    entries: readonly RunPartial[],
    route?: FailureRoute,
  ) => Promise<MutateOkBatch | null>;
  /** Adapt the core EXECUTE closure transaction without leaking mutation helpers. */
  runExecuteClosure: (
    options: Omit<ExecuteClosureOptions, "mutateContext">,
    route?: FailureRoute,
  ) => Promise<SuccessfulExecuteClosure | null>;
  /** Emit the input schema for a mutator command and call ctx.success. */
  emitSchemaAndExit: (commandKey: MutatorCommand) => void;
};

export function createCommandMutator(
  ctx: CommandContext,
  deps: CommandMutatorDeps,
): CommandMutator {
  const registryWriterDeps = deps.registryWriter;

  const createMutationContext = (featureDir: string, session: SessionLoad): MutateContext => ({
    feature_dir: featureDir,
    snapshot: session.snapshot,
    tail_seq: session.tail_seq,
    entries: session.entries,
    meta: session.meta,
    dryRun: ctx.dryRun,
    registryWriter: registryWriterDeps,
  });

  const emitDryRunSuccess = (
    result: { entry: { kind: string } } | { entries: readonly { kind: string }[] },
  ): void => {
    const kind = "entry" in result ? result.entry.kind : (result.entries[0]?.kind ?? "(empty)");
    ctx.success({ ok: true, dry_run: true, would: { kind } }, () => `dry-run: would ${kind}\n`);
  };

  const routeMutateFailure = (
    route: FailureRoute,
    r: { code: string; message: string; detail?: Record<string, unknown> },
  ): void => {
    if (route === "legacy-fail") ctx.fail(r.code, r.message);
    else if (route === "raw-ctx-failure") ctx.failure(r.code, r.message, r.detail);
    else ctx.emitFailure(r.code, r.message, r.detail);
  };

  function acceptResult<Ok extends MutateOkSingle | MutateOkBatch>(
    result: Ok | MutateFailure,
    route: FailureRoute,
  ): Ok | null {
    if (!result.ok) {
      routeMutateFailure(route, result);
      return null;
    }
    if (result.commit_state === "not-committed") {
      emitDryRunSuccess(result);
      return null;
    }
    return result;
  }

  async function runImpl(
    featureDir: string,
    session: SessionLoad,
    input: MutatorEntry | readonly MutatorEntry[],
    route: FailureRoute = "emit-failure",
  ): Promise<MutateOkSingle | MutateOkBatch | null> {
    const now = new Date().toISOString();
    const stamp = (e: MutatorEntry): RunPartial => ({
      at: now,
      actor: e.actor,
      entry_schema_version: 1,
      kind: e.kind,
      payload: e.payload,
    });
    const mctx = createMutationContext(featureDir, session);
    const result = Array.isArray(input)
      ? await mutateBatch(input.map(stamp), mctx)
      : await mutate(stamp(input as MutatorEntry), mctx);
    return acceptResult(result, route);
  }

  async function runBatch(
    featureDir: string,
    session: SessionLoad,
    entries: readonly MutatorEntry[],
    options: { timestamps: TimestampStrategy; route?: FailureRoute },
  ): Promise<MutateOkBatch | null> {
    const sharedAt = options.timestamps === "shared" ? new Date().toISOString() : undefined;
    const prepared = entries.map(
      (entry): RunPartial => ({
        at: sharedAt ?? new Date().toISOString(),
        actor: entry.actor,
        entry_schema_version: 1,
        kind: entry.kind,
        payload: entry.payload,
      }),
    );
    return runPreparedBatch(featureDir, session, prepared, options.route ?? "emit-failure");
  }

  async function runPreparedBatch(
    featureDir: string,
    session: SessionLoad,
    entries: readonly RunPartial[],
    route: FailureRoute = "emit-failure",
  ): Promise<MutateOkBatch | null> {
    const result = await mutateBatch([...entries], createMutationContext(featureDir, session));
    return acceptResult(result, route);
  }

  async function runExecuteClosure(
    options: Omit<ExecuteClosureOptions, "mutateContext">,
    route: FailureRoute = "emit-failure",
  ): Promise<SuccessfulExecuteClosure | null> {
    const closure = await executeClosureTransaction({
      ...options,
      mutateContext: (session) => createMutationContext(options.featureDir, session),
    });
    if (closure.kind === "failure") {
      acceptResult(closure.failure, route);
      return null;
    }
    if (closure.kind === "committed" && acceptResult(closure.result, route) === null) {
      return null;
    }
    return closure;
  }

  const emitSchemaAndExit = (commandKey: MutatorCommand): void => {
    const schema = emitInputSchema(commandKey) as Record<string, unknown>;
    ctx.success(schema, () => formatSchema(schema));
  };

  return {
    run: runImpl as CommandMutator["run"],
    runBatch,
    runPreparedBatch,
    runExecuteClosure,
    emitSchemaAndExit,
  };
}
