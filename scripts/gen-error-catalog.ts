import path from "node:path";
import { fileURLToPath } from "node:url";

import { ERROR_CATALOG } from "../src/core/error-catalog.js";
import { parseCheckMode, writeOrCheckGeneratedFile } from "./generated-file.js";
import { markdownCodeCell, replaceGeneratedBlock } from "./generated-markdown.js";

export { markdownCodeCell };

export function renderErrorCatalogTable(): string {
  const lines = [
    "| Code | Exit | English message template | Fix template | Doc anchor |",
    "|---|---:|---|---|---|",
  ];

  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    const fixTemplate = "fix_template" in entry ? entry.fix_template : undefined;
    const docAnchor = "doc_anchor" in entry ? entry.doc_anchor : undefined;
    lines.push(
      `| ${markdownCodeCell(code)} | ${entry.exit_code} | ${markdownCodeCell(entry.message_template)} | ${typeof fixTemplate === "string" ? markdownCodeCell(fixTemplate) : "—"} | ${typeof docAnchor === "string" ? markdownCodeCell(docAnchor) : "—"} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

/** Replace only the generated error-catalog block in protocol.md. */
export function generateErrorCatalogProtocol(source: string): string {
  return replaceGeneratedBlock(source, "error-catalog", renderErrorCatalogTable());
}

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined && path.resolve(invokedPath) === fileURLToPath(import.meta.url);

if (isMain) {
  const check = parseCheckMode(process.argv.slice(2));
  const outputUrl = new URL("../docs/protocol.md", import.meta.url);
  const drifted = await writeOrCheckGeneratedFile(outputUrl, generateErrorCatalogProtocol, check);
  if (check && drifted) process.exitCode = 1;
}
