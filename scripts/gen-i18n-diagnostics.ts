import path from "node:path";
import { fileURLToPath } from "node:url";

import { ERROR_CATALOG, DIAGNOSTIC_VARIANTS, type DiagnosticTemplate } from "../src/core/error-catalog.js";
import { parseCheckMode, writeOrCheckGeneratedFile } from "./generated-file.js";

export type GeneratedDiagnosticLocale = "en" | "zh";

type DiagnosticSection = {
  readonly start: number;
  readonly end: number;
};

function findDiagnosticSection(source: string, root = "diagnostic"): DiagnosticSection {
  const propertyNeedle = `\n  ${JSON.stringify(root)}: {`;
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

type TemplateTree = { [key: string]: string | TemplateTree };
const GENERATED_ROOTS = ["diagnostic", "diagnostic_fix", "diagnostic_variant", "diagnostic_variant_fix"] as const;
type GeneratedRoot = (typeof GENERATED_ROOTS)[number];

function generatedTree(locale: GeneratedDiagnosticLocale, root: GeneratedRoot): TemplateTree {
  const tree: TemplateTree = {};
  const fix = root.endsWith("_fix");
  const variants = root.startsWith("diagnostic_variant");
  const entries: Array<[string, DiagnosticTemplate]> = variants
    ? Object.entries(DIAGNOSTIC_VARIANTS).map(([key, variant]) => [key, variant.template])
    : Object.entries(ERROR_CATALOG);
  for (const [key, entry] of entries) {
    const template = locale === "en"
      ? fix ? entry.fix_template : entry.message_template
      : fix ? entry.zh_fix_template : entry.zh_message_template;
    // Missing translations are intentionally absent; createI18n uses en.
    if (template === undefined) continue;
    const parts = variants ? key.split(".") : [key];
    let parent = tree;
    for (const part of parts.slice(0, -1)) {
      const child = parent[part];
      if (typeof child === "string") throw new Error(`diagnostic key collision at ${key}`);
      parent[part] ??= {};
      parent = parent[part] as TemplateTree;
    }
    parent[parts.at(-1)!] = template;
  }
  return tree;
}

function renderSection(locale: GeneratedDiagnosticLocale, root: GeneratedRoot): string {
  const object = JSON.stringify(generatedTree(locale, root), null, 2);
  const lines = object.split("\n");
  return `  ${JSON.stringify(root)}: ${lines[0]}` + lines.slice(1).map((line) => `\n  ${line}`).join("");
}

/** Replace only the four catalog-owned root objects, preserving other bytes. */
export function generateI18nDiagnostics(source: string, locale: GeneratedDiagnosticLocale): string {
  let output = source;
  for (const root of GENERATED_ROOTS) {
    const rendered = renderSection(locale, root);
    if (root === "diagnostic" || output.includes(`\n  ${JSON.stringify(root)}: {`)) {
      const section = findDiagnosticSection(output, root);
      output = `${output.slice(0, section.start)}${rendered}${output.slice(section.end)}`;
    } else {
      const before = output.indexOf('\n  "failure": {');
      if (before === -1) throw new Error("i18n bundle is missing the failure insertion anchor");
      output = `${output.slice(0, before)}\n${rendered},\n${output.slice(before)}`;
    }
  }
  return output;
}

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined && path.resolve(invokedPath) === fileURLToPath(import.meta.url);

if (isMain) {
  const check = parseCheckMode(process.argv.slice(2));
  let drifted = false;
  for (const locale of ["en", "zh"] as const) {
    const outputUrl = new URL(`../i18n/${locale}.json`, import.meta.url);
    drifted =
      (await writeOrCheckGeneratedFile(
        outputUrl,
        (source) => generateI18nDiagnostics(source, locale),
        check,
      )) || drifted;
  }
  if (check && drifted) process.exitCode = 1;
}
