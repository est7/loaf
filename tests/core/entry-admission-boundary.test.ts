import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory()
        ? sourceFiles(file)
        : Promise.resolve(/\.tsx?$/.test(file) ? [file] : []);
    }),
  );
  return groups.flat();
}

describe("entry admission ownership", () => {
  test("applyValidated has exactly one production consumer and no re-export", async () => {
    const root = path.resolve("src");
    const consumers: string[] = [];
    for (const file of await sourceFiles(root)) {
      const source = ts.createSourceFile(
        file,
        await fs.readFile(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      function visit(node: ts.Node) {
        // Named imports (including aliases), namespace property access and
        // re-exports all expose the reducer seam outside its owner.
        if (
          ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) &&
            (node.propertyName ?? node.name).text === "applyValidated") ||
          (ts.isPropertyAccessExpression(node) && node.name.text === "applyValidated") ||
          (ts.isElementAccessExpression(node) &&
            ts.isStringLiteral(node.argumentExpression) &&
            node.argumentExpression.text === "applyValidated")
        ) {
          consumers.push(path.relative(root, file));
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(consumers).toEqual(["core/entry-admission.ts"]);
  });
});
