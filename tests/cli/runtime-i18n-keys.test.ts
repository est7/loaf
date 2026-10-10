import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

import { BUILTIN_BUNDLES, LOCALES, type LocaleBundle } from "../../src/cli/i18n.js";
import {
  evidenceKindKey,
  applicabilityKey,
  findingActionKey,
  findingCategoryKey,
  pendingKindKey,
  phaseKey,
  RUNTIME_I18N_KEYS,
  CHROME_KEYS,
  findingStatusKey,
  SUCCESS_KEYS,
  statusIndicatorKey,
  subStateKey,
  taskKindKey,
  taskStatusKey,
  verifyCheckKindKey,
  TASK_KIND_VALUES,
  TASK_STATUS_VALUES,
  FINDING_STATUS_VALUES,
} from "../../src/cli/runtime-i18n-keys.js";
import { EvidenceKind, VerifyCheckKind } from "../../src/core/evidence-schema.js";
import {
  ERROR_CATALOG,
  DIAGNOSTIC_VARIANTS,
  DiagnosticCode,
} from "../../src/core/error-catalog.js";
import { FindingAction, FindingCategory } from "../../src/core/finding-schema.js";
import { PendingPromptKind, SubState } from "../../src/core/journal-entry.js";

const PHASE_VALUES = ["TRIAGE", "SPEC", "EXECUTE", "VERIFY", "SETTLE", "DONE"] as const;
const STATUS_BUCKETS = ["done", "blocked", "running", "idle"] as const;
const APPLICABILITY_VALUES = ["must", "optional", "na"] as const;
const STALE_DIAGNOSTIC_KEYS = [
  "TASK_KIND_SCHEMA_INVALID",
  "E2E_ACCEPTANCE_UNRESOLVED",
  "VISUAL_CONTRACT_UNRESOLVED",
  "NO_OPEN_CLARIFICATIONS",
  "TASKS_VERSION_MISMATCH",
] as const;

function lookup(bundle: LocaleBundle, keyPath: string): unknown {
  let cur: unknown = bundle;
  for (const part of keyPath.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

describe("runtime i18n key gate", () => {
  test("every runtime presentation key exists in en + zh bundles", () => {
    expect(new Set(RUNTIME_I18N_KEYS).size).toBe(RUNTIME_I18N_KEYS.length);
    for (const locale of LOCALES) {
      const missing = RUNTIME_I18N_KEYS.filter(
        (key) =>
          lookup(BUILTIN_BUNDLES[locale], key) === undefined &&
          lookup(BUILTIN_BUNDLES.en, key) === undefined,
      );
      expect(missing, `${locale} missing runtime i18n keys`).toEqual([]);
    }
  });

  test("typed enum helpers cover every runtime enum value", () => {
    const helperKeys = [
      ...STATUS_BUCKETS.map(statusIndicatorKey),
      ...TASK_KIND_VALUES.map(taskKindKey),
      ...TASK_STATUS_VALUES.map(taskStatusKey),
      ...EvidenceKind.options.map(evidenceKindKey),
      ...VerifyCheckKind.options.map(verifyCheckKindKey),
      ...APPLICABILITY_VALUES.map(applicabilityKey),
      ...FindingCategory.options.map(findingCategoryKey),
      ...FindingAction.options.map(findingActionKey),
      ...FINDING_STATUS_VALUES.map(findingStatusKey),
      ...PendingPromptKind.options.map(pendingKindKey),
      ...PHASE_VALUES.map(phaseKey),
      ...SubState.options.map(subStateKey),
      ...Object.keys(ERROR_CATALOG).flatMap((code) => [
        `diagnostic.${code}`,
        `diagnostic_fix.${code}`,
      ]),
      ...Object.keys(DIAGNOSTIC_VARIANTS).flatMap((context) => [
        `diagnostic_variant.${context}`,
        `diagnostic_variant_fix.${context}`,
      ]),
      ...Object.values(SUCCESS_KEYS),
      ...Object.values(CHROME_KEYS),
    ];

    expect(new Set(RUNTIME_I18N_KEYS)).toEqual(new Set(helperKeys));
  });

  test("all catalog diagnostic placeholders match generated messages and available translations", () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      const key = `diagnostic.${code}`;
      const en = lookup(BUILTIN_BUNDLES.en, key);
      const zh = lookup(BUILTIN_BUNDLES.zh, key);
      expect(en).toBe(entry.message_template);
      if (zh !== undefined) expect(placeholders(String(zh))).toEqual(placeholders(String(en)));
    }
  });

  test("stale renamed diagnostic keys are absent from bundled catalogs", () => {
    const stalePresent: string[] = [];
    for (const locale of LOCALES) {
      for (const code of STALE_DIAGNOSTIC_KEYS) {
        if (lookup(BUILTIN_BUNDLES[locale], `diagnostic.${code}`) !== undefined) {
          stalePresent.push(`${locale}:diagnostic.${code}`);
        }
      }
    }

    expect(stalePresent).toEqual([]);
  });

  // W5a — structural gate: every bundled `diagnostic.*` key MUST be a valid
  // DiagnosticCode. The STALE_DIAGNOSTIC_KEYS denylist above is a hardcoded
  // backstop; this gate is exhaustive and catches the NEXT stale rename or
  // phantom key automatically (the 10 phantoms removed in this change would
  // have been caught here).
  test("every bundled diagnostic.* key is a valid DiagnosticCode", () => {
    const validCodes = new Set<string>(DiagnosticCode.options);
    const orphans: string[] = [];
    for (const locale of LOCALES) {
      const section = (BUILTIN_BUNDLES[locale] as { diagnostic?: Record<string, string> })
        .diagnostic;
      if (!section) continue;
      for (const code of Object.keys(section)) {
        if (!validCodes.has(code)) orphans.push(`${locale}:diagnostic.${code}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  test("variants derive from catalog and unused legacy failure roots are absent", () => {
    for (const [context, variant] of Object.entries(DIAGNOSTIC_VARIANTS)) {
      expect(lookup(BUILTIN_BUNDLES.en, `diagnostic_variant.${context}`)).toBe(
        variant.template.message_template,
      );
      expect(ERROR_CATALOG[variant.code]).toBeDefined();
      const zh = lookup(BUILTIN_BUNDLES.zh, `diagnostic_variant.${context}`);
      if (zh !== undefined)
        expect(placeholders(String(zh))).toEqual(placeholders(variant.template.message_template));
    }
    for (const locale of LOCALES)
      expect(lookup(BUILTIN_BUNDLES[locale], "failure")).toBeUndefined();
  });

  test("success keys are explicit, localized, and placeholder-symmetric", () => {
    for (const key of Object.values(SUCCESS_KEYS)) {
      const en = lookup(BUILTIN_BUNDLES.en, key);
      const zh = lookup(BUILTIN_BUNDLES.zh, key);
      expect(en, `${key} en`).toBeTypeOf("string");
      expect(zh, `${key} zh`).toBeTypeOf("string");
      expect(placeholders(String(en)), `${key} zh placeholders`).toEqual(placeholders(String(zh)));
    }
  });

  test("chrome keys are explicit, localized, and placeholder-symmetric", () => {
    for (const key of Object.values(CHROME_KEYS)) {
      const en = lookup(BUILTIN_BUNDLES.en, key);
      const zh = lookup(BUILTIN_BUNDLES.zh, key);
      expect(en, `${key} en`).toBeTypeOf("string");
      expect(zh, `${key} zh`).toBeTypeOf("string");
      expect(placeholders(String(en)), `${key} zh placeholders`).toEqual(placeholders(String(zh)));
    }
  });

  test("runtime i18n call sites do not build dynamic keys", async () => {
    const sources = await collectSources(path.join(process.cwd(), "src", "cli"));
    const offenders: string[] = [];
    const dynamicTemplate = /\b(?:[A-Za-z_$][\w$]*\.)?t\s*\(\s*`/;
    const dynamicConcat = /\b(?:[A-Za-z_$][\w$]*\.)?t\s*\(\s*(?:"[^"]*"|'[^']*')\s*\+/;

    for (const filePath of sources) {
      const text = await fs.readFile(filePath, "utf8");
      if (dynamicTemplate.test(text) || dynamicConcat.test(text)) {
        offenders.push(path.relative(process.cwd(), filePath));
      }
    }

    expect(offenders).toEqual([]);
  });
});

async function collectSources(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectSources(entryPath)));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(entryPath);
    }
  }
  return out;
}

function placeholders(template: string): string[] {
  return Array.from(template.matchAll(/\{([A-Za-z0-9_]+)\}/g), (match) => match[1]!).sort();
}
