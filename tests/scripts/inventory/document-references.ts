import { existsSync } from "node:fs";
import path from "node:path";

import { collectInventory, type Inventory, type InventoryCommand } from "./help-collector.js";

export function collectRepositoryPaths(text: string): Set<string> {
  const references = new Set<string>();
  const pattern =
    /(?<![A-Za-z0-9_.-])((?:src|tests|docs|scripts|skills|i18n|dist)\/[A-Za-z0-9_./{}*,<>-]*|(?:package\.json|tsconfig\.json|bun\.lock|\.gitignore|CHANGELOG\.md|README\.md|loaf\.config\.example\.json|backlog\.md))(?=$|[\s`'"\])};:,])/g;
  for (const match of text.matchAll(pattern)) {
    const reference = match[1]?.replace(/[,;:]+$/, "");
    if (reference !== undefined) references.add(reference);
  }
  return references;
}

export function collectCommandReferences(text: string): Set<string> {
  const references = new Set<string>();
  const pattern = /\bloaf\s+(?:--[A-Za-z][A-Za-z0-9-]*|[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)*)/g;
  for (const match of text.matchAll(pattern)) {
    references.add(match[0].replace(/\s+/g, " ").trim());
  }
  return references;
}

/** Commands intentionally quoted as Markdown inline code in agent-facing docs. */
export function collectQuotedCommandReferences(text: string): Set<string> {
  const references = new Set<string>();
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    for (const reference of collectCommandReferences(match[1] ?? "")) {
      references.add(reference);
    }
  }
  return references;
}

export async function findInvalidCommandReferences(
  references: Iterable<string>,
  inventory?: Inventory,
): Promise<string[]> {
  const liveInventory = inventory ?? (await collectInventory());
  const commandSurfaces = liveInventory.commands.flatMap((command) =>
    commandPathVariants(command, liveInventory.commands).map((commandPath) => ({
      path: commandPath,
      acceptsTrailingWords: command.isExecutable && command.arguments.length > 0,
    })),
  );
  const commandPaths = new Set(commandSurfaces.map((command) => command.path));
  const globalFlags = new Set(
    liveInventory.globalFlags.flatMap((flag) => [flag.name, flag.short].filter(isString)),
  );
  const failures: string[] = [];

  for (const reference of references) {
    const words = reference.split(/\s+/).slice(1);
    const first = words[0];
    if (first?.startsWith("-")) {
      if (!globalFlags.has(first)) failures.push(reference);
      continue;
    }
    const command = words.join(" ");
    if (commandPaths.has(command)) continue;

    const prefix = commandSurfaces
      .filter((surface) => command.startsWith(`${surface.path} `))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (prefix === undefined || !prefix.acceptsTrailingWords) failures.push(reference);
  }

  return failures.sort();
}

export function findInvalidRepositoryPaths(text: string, repoRoot: string): string[] {
  return [...collectRepositoryPaths(text)]
    .filter(
      (reference) =>
        /[{}*<>]|\.\./.test(reference) || !existsSync(path.join(repoRoot, reference)),
    )
    .sort();
}

function commandPathVariants(
  command: InventoryCommand,
  commands: readonly InventoryCommand[],
): string[] {
  const byPath = new Map(commands.map((candidate) => [candidate.path, candidate]));
  const words = command.path.split(" ");
  let variants: string[][] = [[]];

  for (let index = 0; index < words.length; index += 1) {
    const canonicalPrefix = words.slice(0, index + 1).join(" ");
    const owner = byPath.get(canonicalPrefix);
    const choices = [words[index]!, ...(owner?.aliases ?? [])];
    variants = variants.flatMap((prefix) => choices.map((choice) => [...prefix, choice]));
  }

  return variants.map((variant) => variant.join(" "));
}

function isString(value: string | null): value is string {
  return value !== null;
}
