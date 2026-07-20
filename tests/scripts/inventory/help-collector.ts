import { Command, Option } from "commander";

import { main } from "../../../src/cli.js";

export type InventoryArgument = {
  name: string;
  required: boolean;
  variadic: boolean;
};

export type InventoryFlag = {
  /** Long form, e.g. "--format" */
  name: string;
  /** Short form, e.g. "-V"; null if none */
  short: string | null;
  /** True when the option accepts an argument. */
  hasArg: boolean;
  /** Whether the option value itself is absent, required (<value>), or optional ([value]). */
  argMode: "none" | "required" | "optional";
  /** True for Commander requiredOption(), independent of its value argument. */
  required: boolean;
  /** Description registered with Commander. */
  description: string;
};

export type InventoryCommand = {
  /** Space-delimited path, e.g. "tasks step start". */
  path: string;
  /** Alternate command names registered with Commander. */
  aliases: string[];
  /** True if this is a namespace group (has subcommands), not a leaf. */
  isGroup: boolean;
  /** True when the command itself has an action, even if it also has children. */
  isExecutable: boolean;
  /** Positional arguments registered on this command. */
  arguments: InventoryArgument[];
  /** Options local to this command (automatic --help excluded). */
  flags: InventoryFlag[];
  description: string;
};

export type Inventory = {
  /** Top-level global flags, including Commander's help and version flags. */
  globalFlags: InventoryFlag[];
  /** All commands, flat list — includes both groups and leaves. */
  commands: InventoryCommand[];
};

/**
 * Capture the live Commander tree without running an action. main() owns the
 * production registration path, so temporarily replacing parseAsync after all
 * registration has completed gives the gate Commander's real Argument/Option
 * objects (including mandatory options and aliases) without a second static
 * command manifest or a subprocess/help-format parser.
 */
export async function collectInventory(): Promise<Inventory> {
  let program: Command | undefined;
  const originalParseAsync = Command.prototype.parseAsync;
  Command.prototype.parseAsync = async function capture(this: Command): Promise<Command> {
    program = this;
    return this;
  };

  try {
    await main(["bun", "loaf"], {
      monotonicNow: () => 0,
      isStdinTty: () => false,
      isStdoutTty: () => false,
    });
  } finally {
    Command.prototype.parseAsync = originalParseAsync;
  }

  if (program === undefined) {
    throw new Error("failed to capture the live Commander program");
  }

  const root = program as Command;
  const globalOptions = [...root.options];
  // Commander keeps the automatic help option outside command.options.
  // Use the public Option shape with Commander's default flags/description;
  // command-local signature comparisons intentionally exclude it below.
  const helpOption = new Option("-h, --help", "display help for command");
  if (!globalOptions.some((option) => option.long === helpOption.long)) {
    globalOptions.push(helpOption);
  }

  const commands: InventoryCommand[] = [];
  collectCommands(root, [], commands);
  return {
    globalFlags: globalOptions.map(toInventoryFlag),
    commands,
  };
}

function collectCommands(parent: Command, parentPath: string[], output: InventoryCommand[]): void {
  for (const command of parent.commands) {
    if (command.name() === "help") continue;
    const commandPath = [...parentPath, command.name()];
    output.push({
      path: commandPath.join(" "),
      aliases: command.aliases(),
      isGroup: command.commands.length > 0,
      isExecutable:
        typeof (command as Command & { _actionHandler?: unknown })._actionHandler === "function",
      arguments: command.registeredArguments.map((argument) => ({
        name: argument.name(),
        required: argument.required,
        variadic: argument.variadic,
      })),
      flags: command.options.map(toInventoryFlag),
      description: command.description(),
    });
    collectCommands(command, commandPath, output);
  }
}

function toInventoryFlag(option: Option): InventoryFlag {
  return {
    name: option.long ?? option.short ?? option.flags,
    short: option.short ?? null,
    hasArg: option.required || option.optional,
    argMode: option.required ? "required" : option.optional ? "optional" : "none",
    required: option.mandatory,
    description: option.description,
  };
}
