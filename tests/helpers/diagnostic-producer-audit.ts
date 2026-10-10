import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export type DiagnosticProducer = {
  file: string;
  line: number;
  boundary: "outlet" | "constructor" | "result";
  code: string | null;
  codeExpression: string;
  detailKeys: string[] | null;
};

function objectKeys(node: ts.Expression | undefined): string[] | null {
  if (node === undefined) return [];
  if (!ts.isObjectLiteralExpression(node)) return null;
  const keys: string[] = [];
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) return null;
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      keys.push(
        ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
          ? prop.name.text
          : prop.name.getText(),
      );
    }
  }
  return keys.sort();
}

export function auditDiagnosticSource(fileName: string, text: string): DiagnosticProducer[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const records: DiagnosticProducer[] = [];
  function add(
    node: ts.Node,
    boundary: DiagnosticProducer["boundary"],
    code: ts.Expression,
    detail: ts.Expression | undefined,
  ) {
    records.push({
      file: fileName,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      boundary,
      code: ts.isStringLiteral(code) ? code.text : null,
      codeExpression: code.getText(source),
      detailKeys: objectKeys(detail),
    });
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(source) === "ctx" &&
        ["failure", "failureKeyed", "fail", "emitFailure", "emitNoSessionFailure"].includes(
          node.expression.name.text,
        )
      ) {
        const method = node.expression.name.text;
        const code =
          method === "emitNoSessionFailure"
            ? ts.factory.createStringLiteral("NO_SESSION")
            : node.arguments[0];
        if (code !== undefined) {
          const detail =
            node.arguments[
              method === "failureKeyed" ? 3 : method === "emitNoSessionFailure" ? 2 : 2
            ];
          if (method === "emitNoSessionFailure") {
            records.push({
              file: fileName,
              line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              boundary: "outlet",
              code: "NO_SESSION",
              codeExpression: '"NO_SESSION"',
              detailKeys: objectKeys(detail),
            });
          } else add(node, "outlet", code, detail);
        }
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "diagnostic" &&
        node.arguments[0] !== undefined
      ) {
        add(node, "constructor", node.arguments[0], node.arguments[1]);
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const fields = new Map(
        node.properties
          .filter(ts.isPropertyAssignment)
          .map((p) => [p.name.getText(source), p.initializer]),
      );
      const code = fields.get("code");
      if (
        code !== undefined &&
        (fields.has("detail") ||
          fields.has("message") ||
          fields.get("ok")?.kind === ts.SyntaxKind.FalseKeyword)
      ) {
        add(node, "result", code, fields.get("detail"));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return records;
}

export async function auditDiagnosticProducers(root: string): Promise<DiagnosticProducer[]> {
  async function sources(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const groups = await Promise.all(
      entries.map(async (e) => {
        const file = path.join(dir, e.name);
        return e.isDirectory() ? await sources(file) : /\.tsx?$/.test(file) ? [file] : [];
      }),
    );
    return groups.flat();
  }
  const files = await sources(path.join(root, "src"));
  return (
    await Promise.all(
      files.map(async (file) =>
        auditDiagnosticSource(path.relative(root, file), await readFile(file, "utf8")),
      ),
    )
  ).flat();
}
