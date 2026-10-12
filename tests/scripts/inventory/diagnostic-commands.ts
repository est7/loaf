import ts from "typescript";
import type { Inventory, InventoryCommand } from "./help-collector.js";

/** CLI examples are partial invocations: validate command/option existence, not required values. */
export function diagnosticCommandFailures(text: string, inventory: Inventory): string[] {
  const failures: string[] = [];
  for (const match of text.matchAll(/\bloaf\s+([^`\n;]+)(?:`|$)?/g)) {
    const example = match[1]!.trim();
    const before = text.slice(0, match.index);
    const first = example.split(/\s/)[0]!;
    const knownRoot = inventory.commands.some((command) => command.path.split(" ")[0] === first);
    if (
      !/`$|(?:run|use|rerun|invoke|call|运行|执行)\s*$/i.test(before) &&
      !(knownRoot && /--[a-z]/.test(example))
    )
      continue;
    const tokens = example.match(/<[^>]+>|\{[^}]+\}|--?[\w-]+(?:=[^\s,;)]+)?|[\w-]+/g) ?? [];
    const paths: string[] = [];
    for (const token of tokens) {
      if (token.startsWith("-") || token === "requires" || token === "with") break;
      if (/^[<{]/.test(token)) {
        if (paths.length > 0) break; // A positional argument, except generic root command slots.
        paths.push("*");
        continue;
      }
      const candidate = [...paths, token].join(" ");
      const matching = inventory.commands.filter((command) => pathMatches(candidate, command));
      if (matching.length === 0) {
        if (paths.length === 0 || !hasExecutable(paths.join(" "), inventory)) {
          failures.push(`unknown command: loaf ${candidate}`);
        }
        break; // Free text/argument after a valid executable command.
      }
      paths.push(token);
    }
    const prefix = paths.join(" ");
    let commands = inventory.commands.filter((command) => pathMatches(prefix, command));
    for (const token of tokens.filter((value) => /^--?[A-Za-z]/.test(value))) {
      const flag = token.split("=")[0]!;
      if (inventory.globalFlags.some((option) => option.name === flag || option.short === flag))
        continue;
      commands = commands.filter((command) =>
        command.flags.some((option) => option.name === flag || option.short === flag),
      );
      if (commands.length === 0) failures.push(`unknown option: loaf ${prefix} ${flag}`);
    }
  }
  return failures;
}

function pathMatches(prefix: string, command: InventoryCommand): boolean {
  const parts = prefix.split(" ");
  const actual = command.path.split(" ");
  return (
    parts.length <= actual.length &&
    parts.every(
      (part, index) =>
        part === "*" ||
        part === actual[index] ||
        (index === actual.length - 1 && command.aliases.includes(part)),
    )
  );
}

function hasExecutable(prefix: string, inventory: Inventory): boolean {
  return inventory.commands.some(
    (command) =>
      command.isExecutable &&
      command.path.split(" ").length === prefix.split(" ").length &&
      pathMatches(prefix, command),
  );
}

/** Runtime error constructors and returned message fields; comments/docs are deliberately excluded. */
export function runtimeErrorStrings(source: string, file: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const result: string[] = [];
  function visit(node: ts.Node): void {
    const isMessage =
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === "message";
    const isError =
      (ts.isNewExpression(node) && /Error$/.test(node.expression.getText(ast))) ||
      (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.SuperKeyword ||
          /Error$/.test(node.expression.getText(ast))));
    if (isMessage || isError) {
      const target = isMessage && ts.isPropertyAssignment(node) ? node.initializer : node;
      function collect(value: ts.Node): void {
        if (ts.isTemplateExpression(value)) {
          const text =
            value.head.text +
            value.templateSpans.map((span) => `<value>${span.literal.text}`).join("");
          if (text.includes("loaf ")) result.push(text);
        } else if (ts.isStringLiteralLike(value)) {
          if (value.text.includes("loaf ")) result.push(value.text);
        } else ts.forEachChild(value, collect);
      }
      collect(target);
    } else ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}
