import type { Command } from "commander";
import { diagnostic, type CatalogDiagnostic } from "../core/error-catalog.js";
import type { CommandContext } from "./command-context.js";
import { commandPolicy, type CommandPolicy } from "./command-policy.js";
import { collectPresentSelectors } from "./selectors.js";
import { emitArtifactSchema, emitInputSchema, formatSchema } from "./schema-emit.js";

type SchemaPolicy = NonNullable<CommandPolicy["schema"]>;
export type ActionPolicyDecision =
  | { kind: "continue" }
  | { kind: "failure"; diagnostic: CatalogDiagnostic }
  | { kind: "schema"; schema: SchemaPolicy };

/** An intentional pre-action completion, handled by the CLI parse boundary. */
export class CommandPolicyComplete extends Error {
  constructor() {
    super("command completed by registered action policy");
    this.name = "CommandPolicyComplete";
  }
}

function commandLabel(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent)
    names.unshift(current.name());
  return names.join(" ");
}

/** Preserve action-entry priority: dry-run rejection, Board selectors, schema output. */
export function evaluateCommandAction(
  command: Command,
  input: { dryRun: boolean; argv: readonly string[]; env: NodeJS.ProcessEnv },
): ActionPolicyDecision {
  const policy = commandPolicy(command);
  if (!policy) throw new Error(`missing command policy: ${commandLabel(command)}`);
  const opts = command.opts();
  const schema =
    policy.schema?.kind === "artifact" || (policy.schema?.kind === "input" && opts.schema === true)
      ? policy.schema
      : undefined;
  let commandType: "read-only" | "wrapping" | "projection-writer" | "scaffold-writer" | undefined;
  if (schema) commandType = "read-only";
  else if (policy.dryRun === "spec-edit") {
    if (opts.input === undefined) commandType = "wrapping";
  } else if (
    policy.dryRun === "read-only" ||
    policy.dryRun === "wrapping" ||
    policy.dryRun === "projection-writer" ||
    policy.dryRun === "scaffold-writer"
  )
    commandType = policy.dryRun;
  if (input.dryRun && commandType) {
    let label = commandLabel(command);
    if (policy.selectors === "recovery" && opts.rebuild) label += " --rebuild";
    if (schema?.kind === "input") label += " --schema";
    return {
      kind: "failure",
      diagnostic: diagnostic("DRY_RUN_NOT_APPLICABLE", {
        command: label,
        command_type: commandType,
      }),
    };
  }
  if (policy.selectors === "forbidden" && policy.selectorStage === "action") {
    const selectors = collectPresentSelectors(input.argv, input.env);
    if (selectors.length > 0)
      return {
        kind: "failure",
        diagnostic: diagnostic("USAGE", {
          reason: "board_selector_not_supported",
          conflicting: selectors,
        }),
      };
  }
  return schema ? { kind: "schema", schema } : { kind: "continue" };
}

/** Commander validates syntax before this public hook; completion skips the action. */
export function installCommandActionPolicy(program: Command, ctx: CommandContext): void {
  program.hook("preAction", (_program, command) => {
    const decision = evaluateCommandAction(command, {
      dryRun: ctx.dryRun,
      argv: ctx.argv,
      env: process.env,
    });
    if (decision.kind === "continue") return;
    if (decision.kind === "failure") ctx.failure(decision.diagnostic);
    else {
      const schema = (
        decision.schema.kind === "input"
          ? emitInputSchema(decision.schema.key)
          : emitArtifactSchema(decision.schema.key)
      ) as Record<string, unknown>;
      ctx.success(schema, () => formatSchema(schema));
    }
    throw new CommandPolicyComplete();
  });
}
