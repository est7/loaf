import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  type GeneratedDiagnosticLocale,
  generateI18nDiagnostics,
} from "../../scripts/gen-i18n-diagnostics.js";
import { ERROR_CATALOG } from "../../src/core/error-catalog.js";

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
    if (typeof zhTemplate !== "string") continue;
    expected[code] = locale === "en" ? entry.message_template : zhTemplate;
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
      expect(Object.keys(JSON.parse(generated).diagnostic)).toHaveLength(75);
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
});
