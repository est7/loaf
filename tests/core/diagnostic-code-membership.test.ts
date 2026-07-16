// One-directional emission-authority gate.
//
// Failure-code unions remain declared at the surfaces that can emit them.
// This test asks the TypeScript checker for each resolved union (including
// imported aliases and indexed-access types), then only requires that every
// emitted code is registered in the catalog-derived DiagnosticCode enum.

import { fileURLToPath } from "node:url";

import * as ts from "typescript";
import { describe, expect, test } from "vitest";

import { DiagnosticCode } from "../../src/core/error-catalog.js";

const TYPE_SURFACES = {
  PreflightFailureCode: fileURLToPath(
    new URL("../../src/core/reducer/preflight.ts", import.meta.url),
  ),
  MutateFailureCode: fileURLToPath(new URL("../../src/core/journal-mutate.ts", import.meta.url)),
  TaskGraphFailureCode: fileURLToPath(new URL("../../src/core/task-graph.ts", import.meta.url)),
} as const;

const program = ts.createProgram({
  rootNames: Object.values(TYPE_SURFACES),
  options: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
  },
});
const checker = program.getTypeChecker();

function stringMembers(typeName: keyof typeof TYPE_SURFACES): string[] {
  const source = program.getSourceFile(TYPE_SURFACES[typeName]);
  if (source === undefined) throw new Error(`TypeScript did not load ${TYPE_SURFACES[typeName]}`);
  const declaration = source.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName,
  );
  if (declaration === undefined) throw new Error(`missing type alias ${typeName}`);

  const resolved = checker.getTypeAtLocation(declaration);
  const members = resolved.isUnion() ? resolved.types : [resolved];
  return members.map((member) => {
    if (!member.isStringLiteral()) {
      throw new Error(`${typeName} contains non-literal member ${checker.typeToString(member)}`);
    }
    return member.value;
  });
}

describe("emitted failure codes are registered diagnostics", () => {
  for (const typeName of Object.keys(TYPE_SURFACES) as Array<keyof typeof TYPE_SURFACES>) {
    test(`${typeName} is a subset of DiagnosticCode`, () => {
      const registered = new Set<string>(DiagnosticCode.options);
      const missing = stringMembers(typeName).filter((code) => !registered.has(code)).sort();
      expect(missing).toEqual([]);
    });
  }
});
