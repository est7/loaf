import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CLI_ENTRY = path.join(REPO_ROOT, "src", "cli.tsx");

export type InventoryFlag = {
  /** Long form, e.g. "--json" */
  name: string;
  /** Short form, e.g. "-V"; null if none */
  short: string | null;
  /** True when the option accepts an argument (e.g. `--feature <name>`) */
  hasArg: boolean;
  /** Description as printed by Commander */
  description: string;
};

export type InventoryCommand = {
  /** Dotted-ish path, e.g. "start", "spec add-req", "tasks step start" */
  path: string;
  /** True if this is a namespace group (has subcommands), not a leaf */
  isGroup: boolean;
  /** Flags local to this command */
  flags: InventoryFlag[];
  /** Description as printed by Commander */
  description: string;
};

export type Inventory = {
  /** Top-level global flags (those parsed at root command level) */
  globalFlags: InventoryFlag[];
  /** All commands, flat list — includes both groups and leaves */
  commands: InventoryCommand[];
};

/**
 * Build the runtime inventory by invoking the CLI's --help surface as a
 * subprocess. Codex r190 BLOCK 1: do NOT extract createProgram() from
 * src/cli.tsx in SC-0; subprocess parsing keeps SC-0 scope-limited to the
 * inventory harness without touching runtime construction.
 *
 * Performance note: this spawns N subprocesses for N commands. On the current
 * surface (~16 top-level commands + ~25 subcommands), each `bun run src/cli.tsx
 * <args> --help` takes ~0.5-1.5s, so total wall time is ~20-40s. Acceptable
 * for a CI-only gate; tests should `beforeAll` cache.
 */
export function collectInventory(): Inventory {
  const topHelp = runHelp([]);
  const { flags: globalFlags, commandHeaders } = parseTopLevelHelp(topHelp);

  const commands: InventoryCommand[] = [];
  for (const header of commandHeaders) {
    const help = runHelp(header.argv);
    const parsed = parseCommandHelp(help, header.argv);
    commands.push({
      path: header.path,
      isGroup: parsed.subcommandHeaders.length > 0,
      flags: parsed.flags,
      description: header.description,
    });

    for (const sub of parsed.subcommandHeaders) {
      const subPath = `${header.path} ${sub.name}`;
      const subArgv = [...header.argv, sub.name];
      const subHelp = runHelp(subArgv);
      const subParsed = parseCommandHelp(subHelp, subArgv);
      commands.push({
        path: subPath,
        isGroup: subParsed.subcommandHeaders.length > 0,
        flags: subParsed.flags,
        description: sub.description,
      });

      // One more level of recursion (tasks step start / done; could be deeper if needed)
      for (const subsub of subParsed.subcommandHeaders) {
        const subsubPath = `${subPath} ${subsub.name}`;
        const subsubArgv = [...subArgv, subsub.name];
        const subsubHelp = runHelp(subsubArgv);
        const subsubParsed = parseCommandHelp(subsubHelp, subsubArgv);
        commands.push({
          path: subsubPath,
          isGroup: subsubParsed.subcommandHeaders.length > 0,
          flags: subsubParsed.flags,
          description: subsub.description,
        });
      }
    }
  }

  return { globalFlags, commands };
}

function runHelp(args: string[]): string {
  const result: SpawnSyncReturns<string> = spawnSync(
    "bun",
    ["run", CLI_ENTRY, ...args, "--help"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  // Commander prints help to stdout. Older help impls go to stderr; concat for safety.
  // Exit code is typically 0 for --help.
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

type CommandHeader = {
  /** Name as appears in the parent `Commands:` block, e.g. "start", "spec", "tasks step" */
  name: string;
  description: string;
  argv: string[];
  path: string;
};

function parseTopLevelHelp(text: string): {
  flags: InventoryFlag[];
  commandHeaders: CommandHeader[];
} {
  const sections = splitHelpSections(text);
  const flags = parseOptionsBlock(sections.options ?? "");
  const subs = parseCommandsBlock(sections.commands ?? "");
  const commandHeaders: CommandHeader[] = subs.map((s) => ({
    name: s.name,
    description: s.description,
    argv: [s.name],
    path: s.name,
  }));
  return { flags, commandHeaders };
}

type SubcommandHeader = { name: string; description: string };

function parseCommandHelp(text: string, _argv: string[]): {
  flags: InventoryFlag[];
  subcommandHeaders: SubcommandHeader[];
} {
  const sections = splitHelpSections(text);
  return {
    flags: parseOptionsBlock(sections.options ?? ""),
    subcommandHeaders: parseCommandsBlock(sections.commands ?? ""),
  };
}

function splitHelpSections(text: string): { options: string; commands: string } {
  // Commander emits "Options:" and "Commands:" headers. Sections end at the
  // next blank-line boundary followed by a non-indented line or EOF.
  const lines = text.split(/\r?\n/);
  let optionsStart = -1;
  let commandsStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^Options:\s*$/.test(line)) optionsStart = i + 1;
    if (/^Commands:\s*$/.test(line)) commandsStart = i + 1;
  }

  const optionsText = optionsStart >= 0 ? extractIndentedBlock(lines, optionsStart) : "";
  const commandsText = commandsStart >= 0 ? extractIndentedBlock(lines, commandsStart) : "";
  return { options: optionsText, commands: commandsText };
}

function extractIndentedBlock(lines: string[], startIdx: number): string {
  const out: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "") {
      // Allow a single blank line inside the block; stop on second blank or any header-ish line.
      const next = lines[i + 1] ?? "";
      if (next === "" || /^[A-Z][^:]*:\s*$/.test(next) || /^(docs|report bug):/i.test(next)) {
        break;
      }
      out.push(line);
      continue;
    }
    // Stop at unindented section header
    if (/^\S/.test(line) && /:\s*$/.test(line)) break;
    if (/^(docs|report bug):/i.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

function parseOptionsBlock(block: string): InventoryFlag[] {
  if (!block.trim()) return [];
  const flags: InventoryFlag[] = [];
  // Group continuation lines (those that don't start with whitespace+option name)
  // with their parent line.
  const lines = block.split(/\r?\n/);
  let current: string[] = [];
  const groups: string[][] = [];
  for (const line of lines) {
    if (/^\s{2,}-[-a-zA-Z]/.test(line) || /^\s{2,}--[a-zA-Z]/.test(line)) {
      if (current.length > 0) groups.push(current);
      current = [line];
    } else if (current.length > 0 && /^\s{4,}\S/.test(line)) {
      current.push(line);
    }
  }
  if (current.length > 0) groups.push(current);

  for (const group of groups) {
    const joined = group.join(" ").replace(/\s+/g, " ").trim();
    // Commander format examples:
    //   -V, --version              output the version number
    //   --json                     Emit JSON output on stdout
    //   --ceremony <preset>        Preset label: quick / light / standard / deep
    //   --feature-dir <path>       Override default .loaf/<feature> directory
    const m = joined.match(/^(?:(-[a-zA-Z]),\s+)?(--[a-zA-Z][-a-zA-Z0-9]*)(\s+[<\[][^>\]]+[>\]])?\s+(.*)$/);
    if (!m) continue;
    flags.push({
      name: m[2] ?? "",
      short: (m[1] ?? null) as string | null,
      hasArg: Boolean(m[3]),
      description: (m[4] ?? "").trim(),
    });
  }
  return flags;
}

function parseCommandsBlock(block: string): SubcommandHeader[] {
  if (!block.trim()) return [];
  const out: SubcommandHeader[] = [];
  const lines = block.split(/\r?\n/);
  let current: string[] = [];
  const groups: string[][] = [];
  for (const line of lines) {
    if (/^\s{2}\S/.test(line)) {
      if (current.length > 0) groups.push(current);
      current = [line];
    } else if (current.length > 0 && /^\s{4,}\S/.test(line)) {
      current.push(line);
    }
  }
  if (current.length > 0) groups.push(current);

  for (const group of groups) {
    const joined = group.join(" ").replace(/\s+/g, " ").trim();
    // Format:
    //   start [options] <feature>  Start a new feature session ...
    //   spec                       SPEC content commands ...
    //   help [command]             display help for command
    const m = joined.match(/^([a-z][a-z0-9-]*)(?:\s+[\[<].*?[\]>])*\s+(.*)$/i);
    if (!m) continue;
    const name = m[1] ?? "";
    if (name === "help") continue; // ignore the synthetic Commander `help` command
    out.push({
      name,
      description: (m[2] ?? "").trim(),
    });
  }
  return out;
}
