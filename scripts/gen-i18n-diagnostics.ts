import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ERROR_CATALOG } from "../src/core/error-catalog.js";

export type GeneratedDiagnosticLocale = "en" | "zh";

type DiagnosticSection = {
  readonly start: number;
  readonly end: number;
};

function findDiagnosticSection(source: string): DiagnosticSection {
  const propertyNeedle = '\n  "diagnostic": {';
  const propertyOffset = source.indexOf(propertyNeedle);
  if (propertyOffset === -1) throw new Error("i18n bundle is missing the root diagnostic object");
  if (source.indexOf(propertyNeedle, propertyOffset + propertyNeedle.length) !== -1) {
    throw new Error("i18n bundle has multiple root diagnostic objects");
  }

  const start = propertyOffset + 1;
  const objectStart = source.indexOf("{", start);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: index + 1 };
    }
  }

  throw new Error("i18n bundle has an unterminated diagnostic object");
}

function generatedEntries(locale: GeneratedDiagnosticLocale): readonly (readonly [string, string])[] {
  const entries: Array<readonly [string, string]> = [];
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    const zhTemplate = "zh_message_template" in entry ? entry.zh_message_template : undefined;
    if (typeof zhTemplate !== "string") continue;
    entries.push([code, locale === "en" ? entry.message_template : zhTemplate]);
  }
  return entries;
}

function renderDiagnosticSection(locale: GeneratedDiagnosticLocale): string {
  const entries = generatedEntries(locale);
  const lines = ['  "diagnostic": {'];
  for (const [index, [code, template]] of entries.entries()) {
    const comma = index + 1 === entries.length ? "" : ",";
    lines.push(`    ${JSON.stringify(code)}: ${JSON.stringify(template)}${comma}`);
  }
  lines.push("  }");
  return lines.join("\n");
}

/** Replace only the root `.diagnostic` object; every byte outside it is preserved. */
export function generateI18nDiagnostics(
  source: string,
  locale: GeneratedDiagnosticLocale,
): string {
  const section = findDiagnosticSection(source);
  return `${source.slice(0, section.start)}${renderDiagnosticSection(locale)}${source.slice(section.end)}`;
}

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined && path.resolve(invokedPath) === fileURLToPath(import.meta.url);

if (isMain) {
  for (const locale of ["en", "zh"] as const) {
    const outputUrl = new URL(`../i18n/${locale}.json`, import.meta.url);
    const source = await readFile(outputUrl, "utf8");
    await writeFile(outputUrl, generateI18nDiagnostics(source, locale), "utf8");
  }
}
