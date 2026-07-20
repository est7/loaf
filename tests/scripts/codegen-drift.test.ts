import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, test, vi } from "vitest";

import { writeOrCheckGeneratedFile } from "../../scripts/generated-file.js";
import { ERROR_CATALOG } from "../../src/core/error-catalog.js";
import { generateFsmMermaid, generateFsmProtocol } from "../../scripts/gen-fsm-artifacts.js";
import { generateI18nDiagnostics } from "../../scripts/gen-i18n-diagnostics.js";
import {
  generateErrorCatalogProtocol,
  markdownCodeCell,
  renderErrorCatalogTable,
} from "../../scripts/gen-error-catalog.js";
import { replaceGeneratedBlock } from "../../scripts/generated-markdown.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepo(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("generated artifact drift", () => {
  test("FSM Mermaid and protocol projections match committed bytes", () => {
    expect(readRepo("docs/fsm.mmd")).toBe(generateFsmMermaid());
    const protocol = readRepo("docs/protocol.md");
    expect(generateFsmProtocol(protocol)).toBe(protocol);
  });

  test("error-catalog protocol projection is complete and matches committed bytes", () => {
    const table = renderErrorCatalogTable();
    for (const code of Object.keys(ERROR_CATALOG)) {
      expect(table, code).toContain(`<code>${code}</code>`);
    }

    const protocol = readRepo("docs/protocol.md");
    expect(generateErrorCatalogProtocol(protocol)).toBe(protocol);
  });

  test("generated i18n diagnostic objects match committed bytes", () => {
    for (const locale of ["en", "zh"] as const) {
      const bundle = readRepo(`i18n/${locale}.json`);
      expect(generateI18nDiagnostics(bundle, locale)).toBe(bundle);
    }
  });

  test("check mode reports drift without writing; write mode converges", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "loaf-codegen-drift-"));
    const outputPath = path.join(directory, "generated.txt");
    const outputUrl = pathToFileURL(outputPath);
    writeFileSync(outputPath, "stale\n");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(await writeOrCheckGeneratedFile(outputUrl, () => "fresh\n", true)).toBe(true);
      expect(readFileSync(outputPath, "utf8")).toBe("stale\n");
      expect(await writeOrCheckGeneratedFile(outputUrl, () => "fresh\n", false)).toBe(true);
      expect(readFileSync(outputPath, "utf8")).toBe("fresh\n");
      expect(await writeOrCheckGeneratedFile(outputUrl, () => "fresh\n", true)).toBe(false);
    } finally {
      error.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("generated Markdown boundaries", () => {
  test("replacement changes only bytes inside one exact marker pair", () => {
    const source = [
      "handwritten before",
      "<!-- generated:sample BEGIN -->",
      "stale",
      "<!-- generated:sample END -->",
      "handwritten after",
      "",
    ].join("\n");

    expect(replaceGeneratedBlock(source, "sample", "fresh\n")).toBe(
      [
        "handwritten before",
        "<!-- generated:sample BEGIN -->",
        "fresh",
        "<!-- generated:sample END -->",
        "handwritten after",
        "",
      ].join("\n"),
    );
  });

  test("missing, duplicated, or reversed markers fail closed", () => {
    expect(() => replaceGeneratedBlock("no markers\n", "sample", "fresh\n")).toThrow(
      /missing BEGIN marker/,
    );
    expect(() =>
      replaceGeneratedBlock(
        "<!-- generated:sample BEGIN -->\n<!-- generated:sample BEGIN -->\n<!-- generated:sample END -->\n",
        "sample",
        "fresh\n",
      ),
    ).toThrow(/multiple BEGIN markers/);
    expect(() =>
      replaceGeneratedBlock(
        "<!-- generated:sample END -->\n<!-- generated:sample BEGIN -->\n",
        "sample",
        "fresh\n",
      ),
    ).toThrow(/END marker precedes BEGIN marker/);
  });

  test("catalog cells preserve rendered pipes, braces, backticks, and HTML metacharacters", () => {
    expect(markdownCodeCell("a|{value}`<&>")).toBe(
      "<code>a&#124;&#123;value&#125;`&lt;&amp;&gt;</code>",
    );
  });
});
