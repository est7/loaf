import type { Command } from "commander";
import { diagnosticVariant, type CatalogDiagnostic } from "../core/error-catalog.js";
import { HOOK_EVENTS, HOOK_EVENT_TO_CLAUDE_CODE } from "../core/hook-events.js";
import { bootstrapCommandTokens } from "./argv-bootstrap.js";
import { collectPresentSelectors } from "./selectors.js";
import type { MutatorCommand } from "./input-schemas.js";
import type { ArtifactSchemaKind } from "./schema-emit.js";

export type CommandPolicy = {
  selectors:
    | "selected"
    | "start"
    | "forbidden"
    | "optional-hook"
    | "recovery"
    | "registry"
    | "unscoped";
  dryRun:
    | "mutating"
    | "read-only"
    | "wrapping"
    | "projection-writer"
    | "scaffold-writer"
    | "spec-edit"
    | "hook"
    | "prune"
    | "legacy-scaffold";
  selectorStage?: "action";
  selectorFailure?:
    | "failure.sessions_list.selector_conflict"
    | "failure.tui.selector_conflict"
    | "failure.check.selector_conflict";
  interactiveFormat?: boolean;
  schema?: { kind: "input"; key: MutatorCommand } | { kind: "artifact"; key: ArtifactSchemaKind };
};

const policies = new WeakMap<Command, CommandPolicy>();

/** Attach policy to the actual registered command; aliases share its identity. */
export function declareCommandPolicy(command: Command, policy: CommandPolicy): Command {
  if (policies.has(command)) throw new Error(`command policy declared twice: ${command.name()}`);
  policies.set(command, policy);
  return command;
}

export function commandPolicy(command: Command): CommandPolicy | undefined {
  return policies.get(command);
}

export function commandPolicyInventory(
  program: Command,
): Array<{ command: Command; path: string; policy: CommandPolicy | undefined }> {
  const rows: Array<{ command: Command; path: string; policy: CommandPolicy | undefined }> = [];
  function visit(parent: Command, prefix: string): void {
    for (const command of parent.commands) {
      const path = `${prefix}${command.name()}`;
      rows.push({ command, path, policy: commandPolicy(command) });
      visit(command, `${path} `);
    }
  }
  visit(program, "");
  return rows;
}

export function assertLeafCommandPolicies(program: Command): void {
  const missing = commandPolicyInventory(program).filter(
    ({ command, policy }) => command.commands.length === 0 && policy === undefined,
  );
  if (missing.length > 0)
    throw new Error(`missing command policy: ${missing.map(({ path }) => path).join(", ")}`);
}

/** Preserve the existing bootstrap view's arities, derived from registrations.
 * Other command-local options do not become global bootstrap options.
 */
export function bootstrapValueFlags(program: Command): ReadonlySet<string> {
  const flags = new Set<string>();
  for (const command of [
    program,
    ...program.commands.filter((command) => commandPolicy(command)?.selectors === "start"),
  ]) {
    for (const option of command.options)
      if (option.required && option.long) flags.add(option.long);
  }
  for (const { command, policy } of commandPolicyInventory(program)) {
    if (policy?.selectors !== "selected") continue;
    for (const option of command.options) {
      if (option.required && (option.long === "--feature" || option.long === "--feature-dir"))
        flags.add(option.long);
    }
  }
  return flags;
}

export type PreparsePolicyResult =
  | { kind: "continue" }
  | { kind: "failure"; diagnostic: CatalogDiagnostic }
  | { kind: "hook-events" };

/** Command-specific pre-parse checks, ordered ahead of generic dispatch misuse. */
export function evaluateCommandPreparse(
  program: Command,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): PreparsePolicyResult {
  const tokens = bootstrapCommandTokens(argv, 2, bootstrapValueFlags(program));
  const root = program.commands.find(
    (command) => command.name() === tokens[0] || command.aliases().includes(tokens[0] ?? ""),
  );
  const selected =
    root?.commands.find(
      (command) => command.name() === tokens[1] || command.aliases().includes(tokens[1] ?? ""),
    ) ?? root;
  const policy = selected === undefined ? undefined : commandPolicy(selected);
  const selectors = collectPresentSelectors(argv, env);
  const fail = (diagnostic: CatalogDiagnostic): PreparsePolicyResult => ({
    kind: "failure",
    diagnostic,
  });
  if (policy?.selectorFailure && selectors.length > 0)
    return fail(diagnosticVariant(policy.selectorFailure, { conflicting: selectors }));
  if (
    policy?.interactiveFormat &&
    argv.some((arg) => arg === "--format" || arg.startsWith("--format="))
  )
    return fail(
      diagnosticVariant("failure.tui.interactive_only", { reason: "tui-interactive-only" }),
    );
  if (policy?.selectors === "optional-hook") {
    if (argv.includes("--list-events")) return { kind: "hook-events" };
    const event = tokens[1];
    if (event === undefined)
      return fail(diagnosticVariant("failure.hook.missing_event", { events: HOOK_EVENTS }));
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      const suggestion =
        HOOK_EVENTS.find((known) => known.startsWith(event.slice(0, 4))) ?? HOOK_EVENTS[0];
      return fail(
        diagnosticVariant("failure.hook.unknown_event", {
          event,
          allowed: HOOK_EVENTS,
          suggestion,
        }),
      );
    }
  }
  const schemaMode =
    policy?.schema?.kind === "artifact" ||
    (policy?.schema?.kind === "input" && argv.includes("--schema"));
  if (schemaMode && selectors.length > 0)
    return fail(
      diagnosticVariant("failure.schema.selector_conflict", {
        subject: `${tokens.join(" ")}${policy?.schema?.kind === "input" ? " --schema" : ""}`,
        conflicting: selectors,
      }),
    );
  if (selectors.includes("--feature-dir") && policy?.selectors !== "start") {
    const conflicting = selectors.filter(
      (selector) => selector === "--session" || selector === "$LOAF_SESSION",
    );
    if (conflicting.length > 0)
      return fail(
        diagnosticVariant("failure.dispatch.session_feature_dir_conflict", {
          conflicting: [...conflicting, "--feature-dir"],
        }),
      );
    if (!selectors.includes("--feature") && !selectors.includes("$LOAF_FEATURE"))
      return fail(
        diagnosticVariant("failure.dispatch.feature_dir_requires_feature", {
          conflicting: ["--feature-dir"],
        }),
      );
  }
  return { kind: "continue" };
}

export function renderHookEvents(json: boolean): string {
  return json
    ? `${JSON.stringify({ ok: true, count: HOOK_EVENTS.length, events: HOOK_EVENTS.map((event) => ({ event, claude_code: HOOK_EVENT_TO_CLAUDE_CODE[event] })) })}\n`
    : HOOK_EVENTS.map((event) => `${event}\t${HOOK_EVENT_TO_CLAUDE_CODE[event]}\n`).join("");
}
