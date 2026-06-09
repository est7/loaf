// Phase W8 0b — CommandMutator: mutation orchestration surface.
//
// Moved verbatim from src/cli.tsx main() — runMutator (overloaded) /
// mctxFor / finishMutate / routeMutateFailure / emitMutatorSchemaAndExit.
//
// HARD BOUNDARY: this module imports mutate/mutateBatch (stable core).
// command-context.ts MUST NOT import them.
//
// Depends on ctx for dryRun / success / fail / emitFailure, and on
// registryWriter (from deps) for mctxFor.

import { mutate, mutateBatch, type MutateContext } from "../core/journal-mutate.js";
import { emitInputSchema, formatSchema } from "./schema-emit.js";
import type { MutatorCommand } from "../../docs/schemas.js";
import type { MutatorEntry } from "./mutator-entry.js";
import type { SessionLoad } from "../core/cli-runtime.js";
import type { CommandContext } from "./command-context.js";

type RunPartial = Parameters<typeof mutate>[0];
export type FailureRoute = "emit-failure" | "legacy-fail" | "raw-ctx-failure";
export type MutateOkSingle = Extract<Awaited<ReturnType<typeof mutate>>, { ok: true }>;
export type MutateOkBatch = Extract<Awaited<ReturnType<typeof mutateBatch>>, { ok: true }>;

export type CommandMutatorDeps = {
  registryWriter: MutateContext["registryWriter"] | undefined;
};

export type CommandMutator = {
  /** Build a MutateContext from a resolved session. Exposed so the 3
   *  bypass sites in cli.tsx that build their own batches can reuse it. */
  mctxFor: (featureDir: string, session: SessionLoad) => MutateContext;
  /** Shared result tail: route failure, swallow dry-run success, or hand
   *  back the ok result. Used by run() and by the bypass sites. */
  finishMutate: <Ok extends MutateOkSingle | MutateOkBatch>(
    result: Ok | { ok: false; code: string; message: string; detail?: Record<string, unknown> },
    route: FailureRoute,
  ) => Ok | null;
  /** Single-entry or batch mutate + dry-run + failure routing.
   *  Returns null when already emitted (failure or dry-run success). */
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
  /** Emit the input schema for a mutator command and call ctx.success. */
  emitSchemaAndExit: (commandKey: MutatorCommand) => void;
};

export function createCommandMutator(
  ctx: CommandContext,
  deps: CommandMutatorDeps,
): CommandMutator {
  const registryWriterDeps = deps.registryWriter;

  const mctxFor = (featureDir: string, session: SessionLoad): MutateContext => ({
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

  function finishMutate<Ok extends MutateOkSingle | MutateOkBatch>(
    result: Ok | { ok: false; code: string; message: string; detail?: Record<string, unknown> },
    route: FailureRoute,
  ): Ok | null {
    if (!result.ok) {
      routeMutateFailure(route, result);
      return null;
    }
    if (ctx.dryRun) {
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
    const mctx = mctxFor(featureDir, session);
    const result = Array.isArray(input)
      ? await mutateBatch(input.map(stamp), mctx)
      : await mutate(stamp(input as MutatorEntry), mctx);
    return finishMutate(result, route);
  }

  const emitSchemaAndExit = (commandKey: MutatorCommand): void => {
    const schema = emitInputSchema(commandKey) as Record<string, unknown>;
    ctx.success(schema, () => formatSchema(schema));
  };

  return {
    mctxFor,
    finishMutate,
    run: runImpl as CommandMutator["run"],
    emitSchemaAndExit,
  };
}
