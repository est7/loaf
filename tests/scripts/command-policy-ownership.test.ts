import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, test } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const owners = new Map([
  ["scanArgv", "src/core/argv-scanner.ts"],
  ["bootstrapCommandTokens", "src/cli/argv-bootstrap.ts"],
  ["collectPresentSelectors", "src/cli/selectors.ts"],
  ["declareCommandPolicy", "src/cli/command-policy.ts"],
  ["commandPolicyInventory", "src/cli/command-policy.ts"],
  ["assertLeafCommandPolicies", "src/cli/command-policy.ts"],
  ["bootstrapValueFlags", "src/cli/command-policy.ts"],
  ["evaluateCommandPreparse", "src/cli/command-policy.ts"],
  ["evaluateCommandAction", "src/cli/command-action-policy.ts"],
  ["installCommandActionPolicy", "src/cli/command-action-policy.ts"],
  ["emitInputSchema", "src/cli/schema-emit.ts"],
  ["emitArtifactSchema", "src/cli/schema-emit.ts"],
]);
const selectorConsumers = new Set([
  "src/cli/selectors.ts",
  "src/cli/command-policy.ts",
  "src/cli/command-action-policy.ts",
]);
const lexicalConsumers = new Set([
  "src/cli/argv-bootstrap.ts",
  "src/cli/argv-presentation.ts",
  "src/cli/selectors.ts",
  "src/core/session-dispatch.ts",
  "src/cli/next-advisory.ts",
]);
const retired = new Set(["rejectIfDryRun", "emitSchemaAndExit"]);

function violations(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const failures: string[] = [];
  const importedNames = new Map<string, string>();
  const family = file.startsWith("src/cli/commands/");
  function report(rule: string, node: ts.Node) {
    const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    failures.push(`${rule}:${file}:${line}`);
  }
  for (const statement of tree.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    )
      for (const item of statement.importClause.namedBindings.elements)
        importedNames.set(item.name.text, item.propertyName?.text ?? item.name.text);
  }
  function visit(node: ts.Node) {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertySignature(node)
    ) {
      const name = node.name?.getText(tree);
      if (name && retired.has(name)) report("retired-policy-helper", node);
      if (
        name &&
        owners.has(name) &&
        owners.get(name) !== file &&
        (ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          (ts.isVariableDeclaration(node) &&
            node.initializer &&
            (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))))
      )
        report("duplicate-policy-owner", node);
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const localName = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : undefined;
      const name = localName && (importedNames.get(localName) ?? localName);
      if (name && retired.has(name)) report("retired-policy-call", node);
      if (name === "collectPresentSelectors" && !selectorConsumers.has(file))
        report("local-selector-policy", node);
      if (
        name &&
        ["emitInputSchema", "emitArtifactSchema"].includes(name) &&
        file !== "src/cli/command-action-policy.ts"
      )
        report("local-schema-output", node);
      if (
        lexicalConsumers.has(file) &&
        ts.isPropertyAccessExpression(expression) &&
        ["includes", "some", "map", "find", "findIndex", "indexOf", "filter"].includes(
          expression.name.text,
        ) &&
        /^(?:\w+\.)?argv$/.test(expression.expression.getText(tree))
      )
        report("raw-argv-scan-outside-lexer", node);
      if (
        file === "src/cli.tsx" &&
        /\bargv\b/.test(expression.getText(tree)) &&
        /["']--(?:feature|feature-dir|session|schema|list-events|dry-run)["']/.test(
          node.getText(tree),
        )
      )
        report("main-local-policy-scan", node);
      if (
        family &&
        ts.isPropertyAccessExpression(expression) &&
        ["includes", "some", "find", "findIndex", "indexOf", "filter"].includes(
          expression.name.text,
        ) &&
        /\bargv\b/.test(expression.expression.getText(tree))
      )
        report("local-argv-scan", node);
    }
    if (
      lexicalConsumers.has(file) &&
      (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      (ts.isForStatement(node)
        ? /\bargv\b/.test(node.condition?.getText(tree) ?? "")
        : /^(?:\w+\.)?argv$/.test(node.expression.getText(tree)))
    )
      report("raw-argv-scan-outside-lexer", node);
    if (
      family &&
      (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      /\bargv\b/.test(
        ts.isForStatement(node)
          ? (node.condition?.getText(tree) ?? "")
          : node.expression.getText(tree),
      )
    )
      report("local-argv-scan", node);
    if (
      family &&
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "schema" &&
      (ts.isBinaryExpression(node.parent) ||
        ts.isIfStatement(node.parent) ||
        ts.isConditionalExpression(node.parent) ||
        ts.isPrefixUnaryExpression(node.parent))
    )
      report("local-schema-branch", node);
    if (
      ts.isStringLiteral(node) &&
      node.text === "DRY_RUN_NOT_APPLICABLE" &&
      file.startsWith("src/cli/") &&
      file !== "src/cli/command-action-policy.ts"
    )
      report("local-dry-run-policy", node);
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      file.startsWith("src/core/") &&
      /(?:^|\/)cli\/(?:command-(?:action-policy|policy|program)|argv-bootstrap|selectors)\.js$/.test(
        node.moduleSpecifier.text,
      )
    )
      report("core-policy-reverse-dependency", node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return failures;
}

const sources = readdirSync(path.join(repo, "src"), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
  .map((entry) => {
    const absolute = path.join(entry.parentPath, entry.name);
    return [path.relative(repo, absolute), readFileSync(absolute, "utf8")] as const;
  });

test("argv scanner and command-policy owners remain exclusive in live source", () => {
  expect(sources.flatMap(([file, source]) => violations(file, source))).toEqual([]);
});

test.each([
  [
    "raw-argv-scan-outside-lexer",
    "src/cli/argv-bootstrap.ts",
    "for (const raw of argv) { consume(raw); }",
  ],
  [
    "raw-argv-scan-outside-lexer",
    "src/core/session-dispatch.ts",
    "const selected = argv.find(token => token.startsWith('--session='));",
  ],
  ["main-local-policy-scan", "src/cli.tsx", "if (argv.includes('--schema')) return;"],
  [
    "duplicate-policy-owner",
    "src/cli/commands/lifecycle.tsx",
    "function scanArgv(argv: string[]) { return argv.map(raw => ({raw})); }",
  ],
  [
    "duplicate-policy-owner",
    "src/cli/commands/lifecycle.tsx",
    "const evaluateCommandAction = () => true;",
  ],
  [
    "local-argv-scan",
    "src/cli/commands/lifecycle.tsx",
    "for (const token of ctx.argv) { if (token === '--schema') break; }",
  ],
  [
    "local-argv-scan",
    "src/cli/commands/board.tsx",
    "const local = ctx.argv.some(token => token === '--feature');",
  ],
  ["retired-policy-call", "src/cli/commands/lifecycle.tsx", "ctx.rejectIfDryRun('status');"],
  [
    "retired-policy-helper",
    "src/cli/command-context.ts",
    "function rejectIfDryRun() { return false; }",
  ],
  [
    "local-dry-run-policy",
    "src/cli/commands/lifecycle.tsx",
    "ctx.failure(diagnostic('DRY_RUN_NOT_APPLICABLE', {}));",
  ],
  [
    "local-selector-policy",
    "src/cli/commands/board.tsx",
    "import { collectPresentSelectors as local } from '../selectors.js'; local(ctx.argv, process.env);",
  ],
  [
    "local-schema-output",
    "src/cli/commands/state.tsx",
    "import { emitArtifactSchema as emit } from '../schema-emit.js'; emit('state');",
  ],
  ["local-schema-branch", "src/cli/commands/spec.tsx", "if (opts.schema === true) return;"],
  [
    "retired-policy-call",
    "src/cli/commands/spec.tsx",
    "mutator.emitSchemaAndExit('spec:add-req');",
  ],
  [
    "core-policy-reverse-dependency",
    "src/core/argv-scanner.ts",
    "import type { CommandPolicy } from '../cli/command-policy.js';",
  ],
])("ownership negative witness: %s (%s)", (rule, file, injection) => {
  const original = sources.find(([name]) => name === file)?.[1];
  expect(original, `missing live injection target ${file}`).toBeDefined();
  expect(
    violations(file, `${original}\n${injection}`).some((failure) => failure.startsWith(`${rule}:`)),
  ).toBe(true);
});

test("comments and independent redaction/editor grammars are outside policy ownership", () => {
  expect(violations("src/cli/commands/probe.ts", "const dataSchema = payload.schema;")).toEqual([]);
  expect(
    violations(
      "src/cli/commands/probe.ts",
      "// ctx.rejectIfDryRun('status');\n// opts.schema === true\n",
    ),
  ).toEqual([]);
  expect(
    violations(
      "src/cli/trace-writer.ts",
      "for (let i = 0; i < argv.length; i++) { redact(argv[i]); }",
    ),
  ).toEqual([]);
  expect(
    violations(
      "src/cli/run-editor.ts",
      "function tokenizeEditor(value: string) { return value.split(' '); }",
    ),
  ).toEqual([]);
});
