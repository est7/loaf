import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

function alternateOutlets(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const target = node.expression.getText(tree);
      const argument = node.arguments[0]?.getText(tree) ?? "";
      if (
        /\.(?:fail|emitFailure|failureKeyed|emitNoSessionFailure|diagnosticFailure)$/.test(target)
      )
        violations.push(target);
      if (/^(?:writeFailure|writePreContextKeyedFailure|writePreContextSiteFailure)$/.test(target))
        violations.push(target);
      const direct =
        target === "process.stderr.write" ||
        target === "deps.writeStderr" ||
        target === "console.error";
      if (direct && /error:|JSON\.stringify/.test(argument)) {
        // Unexpected/crash remains the separate exit-1 failure domain.
        const permittedMain =
          file === "src/cli.tsx" &&
          (argument.includes("UNEXPECTED_ERROR") || argument === 'JSON.stringify(payload) + "\\n"');
        if (!permittedMain && file !== "src/cli/diagnostic-failure.ts")
          violations.push(`${target}(${argument})`);
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const fields = new Map(
        node.properties
          .filter(ts.isPropertyAssignment)
          .map((prop) => [prop.name.getText(tree), prop.initializer]),
      );
      if (
        fields.get("ok")?.kind === ts.SyntaxKind.FalseKeyword &&
        fields.has("message") &&
        fields.has("code")
      ) {
        // Only main's explicit unexpected/crash JSON envelope is outside exit-2 diagnostics.
        // The board endpoint's explicit view response preserves its independent public payload.
        const boardView =
          (file === "src/cli/board/model.ts" &&
            fields.get("code")?.getText(tree) === '"SESSION_NOT_FOUND"') ||
          (file === "src/cli/board/server.ts" &&
            fields.get("code")?.getText(tree) ===
              'status === 400 ? "BAD_REQUEST" : "BOARD_SERVER_ERROR"');
        if (
          !boardView &&
          !(file === "src/cli.tsx" && fields.get("code")?.getText(tree) === "UNEXPECTED_ERROR")
        )
          violations.push("producer-owned failure message");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return violations;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? sourceFiles(path.join(dir, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [path.join(dir, entry.name)]
          : [],
    ),
  );
  return nested.flat();
}

describe("single recoverable failure outlet source gate", () => {
  test("direct CLI/context/pre-context failures cannot restore alternate APIs or raw writers", async () => {
    const files = ["src/cli.tsx", ...(await sourceFiles("src/cli"))];
    for (const file of files)
      expect(alternateOutlets(file, await readFile(file, "utf8")), file).toEqual([]);
    const context = await readFile("src/cli/command-context.ts", "utf8");
    expect(
      /\b(?:failureKeyed|emitFailure|emitNoSessionFailure|diagnosticFailure|diagnosticVarsFor)\b/.test(
        context,
      ),
    ).toBe(false);
    const keys = await readFile("src/cli/runtime-i18n-keys.ts", "utf8");
    expect(
      /\b(?:MIGRATED_DIAGNOSTIC_CODES|FAILURE_SITE_KEYS|FAILURE_SITE_TEMPLATES)\b/.test(keys),
    ).toBe(false);
  });

  test("gate is sensitive to alternate output, legacy API, and producer prose", () => {
    expect(
      alternateOutlets(
        "src/cli/probe.ts",
        `
      ctx.emitFailure("USAGE", "old prose");
      process.stderr.write(JSON.stringify({ok:false,code:"USAGE"}));
      const failure = {ok:false,code:"USAGE",message:"old prose",detail:{}};
    `,
      ),
    ).toHaveLength(3);
    expect(
      alternateOutlets(
        "src/cli/probe.ts",
        'ctx.failure(diagnostic("USAGE", {reason:"invalid_input"}));',
      ),
    ).toEqual([]);
  });
});
