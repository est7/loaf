import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { admitEntry } from "../../src/core/entry-admission.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";

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

  test("migration bootstrap preflights in mutation but remains tolerant in replay", () => {
    const entry: JournalEntry = {
      seq: 0,
      entry_id: "JE-000001",
      at: "2026-05-15T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "migration:snapshot_imported",
      payload: {},
    };
    expect(admitEntry(initialSnapshot(), entry, { kind: "mutation", tail_seq: -1 })).toMatchObject({
      ok: false,
      stage: "admission",
      code: "ACTOR_AUTHORITY_VIOLATION",
    });
    expect(admitEntry(initialSnapshot(), entry, { kind: "replay" })).toMatchObject({
      ok: true,
      snapshot: { state: { feature: "migrated" } },
    });
  });
});
