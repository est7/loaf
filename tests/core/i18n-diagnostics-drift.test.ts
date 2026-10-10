import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  type GeneratedDiagnosticLocale,
  generateI18nDiagnostics,
} from "../../scripts/gen-i18n-diagnostics.js";
import { ERROR_CATALOG, DIAGNOSTIC_VARIANTS } from "../../src/core/error-catalog.js";

const DRIFT_MESSAGE =
  "i18n diagnostic drift detected. Run `bun run gen:i18n` and commit i18n/en.json + i18n/zh.json.";

function outsideDiagnostic(source: string): string {
  const start = source.indexOf('\n  "diagnostic": {');
  const end = source.indexOf('\n  "failure": {', start);
  if (start === -1 || end === -1) throw new Error("unexpected i18n bundle layout");
  return `${source.slice(0, start)}\n  "diagnostic": <generated>${source.slice(end)}`;
}

async function readBundle(locale: GeneratedDiagnosticLocale): Promise<string> {
  return await readFile(new URL(`../../i18n/${locale}.json`, import.meta.url), "utf8");
}

function expectedDiagnostic(locale: GeneratedDiagnosticLocale): Record<string, string> {
  const expected: Record<string, string> = {};
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    const zhTemplate = "zh_message_template" in entry ? entry.zh_message_template : undefined;
    if (locale === "zh" && typeof zhTemplate !== "string") continue;
    expected[code] = locale === "en" ? entry.message_template : zhTemplate!;
  }
  return expected;
}

describe("generated i18n diagnostic sections", () => {
  for (const locale of ["en", "zh"] as const) {
    test(`${locale} bundle matches the catalog projection`, async () => {
      const committed = await readBundle(locale);
      const generated = generateI18nDiagnostics(committed, locale);

      expect(committed, DRIFT_MESSAGE).toBe(generated);
      expect(generateI18nDiagnostics(generated, locale)).toBe(generated);
      expect(JSON.parse(generated).diagnostic).toEqual(expectedDiagnostic(locale));
      expect(Object.keys(JSON.parse(generated).diagnostic)).toHaveLength(
        Object.keys(expectedDiagnostic(locale)).length,
      );
    });

    test(`${locale} generation preserves every byte outside diagnostic`, async () => {
      const committed = await readBundle(locale);
      const generated = generateI18nDiagnostics(committed, locale);
      expect(outsideDiagnostic(generated)).toBe(outsideDiagnostic(committed));
    });
  }

  test("repairs diagnostic drift without reserializing the bundle", async () => {
    const committed = await readBundle("en");
    const drifted = committed.replace(
      ERROR_CATALOG.SPEC_LOCKED_NO_DIRECT_EDIT.message_template,
      "intentional diagnostic drift probe",
    );
    expect(drifted).not.toBe(committed);

    const repaired = generateI18nDiagnostics(drifted, "en");
    expect(repaired).toBe(committed);
    expect(outsideDiagnostic(repaired)).toBe(outsideDiagnostic(drifted));
  });

  test("fixes and existing-context variants are catalog projections, without invented zh", async () => {
    const en = JSON.parse(await readBundle("en"));
    const zh = JSON.parse(await readBundle("zh"));
    expect(Object.keys(en.diagnostic_fix)).toHaveLength(129);
    expect(Object.keys(zh.diagnostic_fix)).toHaveLength(2);
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(en.diagnostic_fix[code]).toBe(entry.fix_template);
      expect(zh.diagnostic_fix[code]).toBe(
        "zh_fix_template" in entry ? entry.zh_fix_template : undefined,
      );
    }
    for (const [context, variant] of Object.entries(DIAGNOSTIC_VARIANTS)) {
      const read = (root: Record<string, unknown>) =>
        context
          .split(".")
          .reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], root);
      expect(read(en.diagnostic_variant)).toBe(variant.template.message_template);
      expect(read(en.diagnostic_variant_fix)).toBe(variant.template.fix_template);
      expect(read(zh.diagnostic_variant)).toBe(variant.template.zh_message_template);
      expect(read(zh.diagnostic_variant_fix)).toBeUndefined();
    }
  });
});
