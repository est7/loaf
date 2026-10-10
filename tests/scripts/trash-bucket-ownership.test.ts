import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const owner = "src/core/trash-bucket.ts";
const names = new Set([
  "TrashSession",
  "RestoreTrashOptions",
  "RestoreTrashResult",
  "BucketManifest",
  "BucketManifestSchema",
  "trashDirectory",
  "trashTimestampPath",
  "trashBucketPath",
  "trashSession",
  "restoreTrashBucket",
  "readBucketManifest",
  "bucketsFor",
  "moveDir",
  "moveFile",
  "toTrashTs",
  "fromTrashTs",
  "CopyMoveError",
]);

function violations(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const result: string[] = [];
  const pruneConsumer = file.startsWith("src/cli/prune/") || file === "src/cli/commands/prune.tsx";
  const add = (rule: string, node: ts.Node) =>
    result.push(
      `${rule}:${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`,
    );
  function visit(node: ts.Node) {
    if (
      file !== owner &&
      (ts.isFunctionDeclaration(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isClassDeclaration(node))
    ) {
      const name = node.name?.getText(tree);
      if (name && names.has(name)) add("duplicate-bucket-owner", node);
    }
    if (pruneConsumer && ts.isCallExpression(node)) {
      const text = node.getText(tree);
      if (
        /\b(?:join|resolve)\(/.test(text) &&
        node.arguments.some(
          (arg) =>
            ts.isStringLiteral(arg) &&
            ["trash", "manifest.json", "registry.json"].includes(arg.text),
        )
      )
        add("bucket-layout-outside-owner", node);
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(tree) === "JSON" &&
        node.expression.name.text === "parse" &&
        /manifest/i.test(text)
      )
        add("manifest-parse-outside-owner", node);
    }
    if (
      pruneConsumer &&
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "feature_trashed"
    )
      add("manifest-transfer-policy-outside-owner", node);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      if (
        /(?:^|\/)(?:restore|trash-ts|fs-move)\.js$/.test(module) &&
        /prune|trash/.test(file + module)
      )
        add("retired-bucket-owner-import", node);
      if (file === owner && /(?:^|\/)cli\//.test(module))
        add("bucket-cli-reverse-dependency", node);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return result;
}

const sources = readdirSync(path.join(root, "src"), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
  .map((entry) => {
    const full = path.join(entry.parentPath, entry.name);
    return [path.relative(root, full), readFileSync(full, "utf8")] as const;
  });

test("persistent trash bucket knowledge has one neutral owner", () => {
  expect(sources.flatMap(([file, source]) => violations(file, source))).toEqual([]);
});

test.each([
  [
    "duplicate-bucket-owner",
    "src/cli/prune/execute.ts",
    "function moveDir(src: string, dst: string) { return fs.rename(src, dst); }",
  ],
  [
    "duplicate-bucket-owner",
    "src/cli/prune/trash-gc.ts",
    "function fromTrashTs(value: string) { return new Date(value); }",
  ],
  [
    "duplicate-bucket-owner",
    "src/cli/prune/execute.ts",
    "const BucketManifestSchema = z.object({});",
  ],
  [
    "bucket-layout-outside-owner",
    "src/cli/prune/execute.ts",
    "const bucket = path.join(trashDir, stamp, id, 'manifest.json');",
  ],
  [
    "bucket-layout-outside-owner",
    "src/cli/commands/prune.tsx",
    "const trash = path.join(path.dirname(registry), 'trash');",
  ],
  [
    "manifest-parse-outside-owner",
    "src/cli/prune/execute.ts",
    "const local = JSON.parse(manifestRaw);",
  ],
  [
    "manifest-transfer-policy-outside-owner",
    "src/cli/prune/execute.ts",
    "if (manifest.feature_trashed) await moveFeature();",
  ],
  [
    "retired-bucket-owner-import",
    "src/cli/prune/execute.ts",
    "import { moveDir as transfer } from './fs-move.js';",
  ],
  [
    "bucket-cli-reverse-dependency",
    owner,
    "import type { PruneTarget } from '../cli/prune/resolve.js';",
  ],
])("negative witness: %s (%s)", (rule, file, injection) => {
  const source = sources.find(([name]) => name === file)?.[1];
  expect(source).toBeDefined();
  expect(
    violations(file, `${source}\n${injection}`).some((error) => error.startsWith(rule + ":")),
  ).toBe(true);
});

test("purge, audit, retention and unrelated registry layout remain independent", () => {
  expect(
    violations("src/cli/prune/execute.ts", "await fs.rm(t.feature_dir, { recursive: true });"),
  ).toEqual([]);
  expect(
    violations("src/cli/prune/audit.ts", "JSON.parse(line); path.join(base, 'prune-log.jsonl');"),
  ).toEqual([]);
  expect(violations("src/core/registry-read.ts", "path.join(registry, id + '.json');")).toEqual([]);
  expect(
    violations("src/cli/prune/trash-gc.ts", "const cutoff = now.getTime() - age * DAY_MS;"),
  ).toEqual([]);
  expect(
    violations("src/cli/prune/execute.ts", "// manifest.feature_trashed; moveDir();\n"),
  ).toEqual([]);
});
