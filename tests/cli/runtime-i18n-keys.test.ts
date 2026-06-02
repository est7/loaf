import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

import { BUILTIN_BUNDLES, LOCALES, type LocaleBundle } from "../../src/cli/i18n.js";
import {
  evidenceKindKey,
  findingActionKey,
  findingCategoryKey,
  pendingKindKey,
  phaseKey,
  RUNTIME_I18N_KEYS,
  diagnosticKey,
  FAILURE_SITE_KEYS,
  FAILURE_SITE_TEMPLATES,
  SUCCESS_KEYS,
  statusIndicatorKey,
  subStateKey,
  taskKindKey,
  TASK_KIND_VALUES,
  MIGRATED_DIAGNOSTIC_CODES,
} from "../../src/cli/runtime-i18n-keys.js";
import { EvidenceKind } from "../../src/core/evidence-schema.js";
import { FindingAction, FindingCategory } from "../../src/core/finding-schema.js";
import { PendingPromptKind, SubState } from "../../src/core/journal-entry.js";
import { ERROR_CATALOG } from "../../docs/schemas.js";

const PHASE_VALUES = ["TRIAGE", "SPEC", "EXECUTE", "VERIFY", "SETTLE", "DONE"] as const;
const STATUS_BUCKETS = ["done", "blocked", "running", "idle"] as const;

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
      const missing = RUNTIME_I18N_KEYS.filter((key) => lookup(BUILTIN_BUNDLES[locale], key) === undefined);
      expect(missing, `${locale} missing runtime i18n keys`).toEqual([]);
    }
  });

  test("typed enum helpers cover every runtime enum value", () => {
    const helperKeys = [
      ...STATUS_BUCKETS.map(statusIndicatorKey),
      ...TASK_KIND_VALUES.map(taskKindKey),
      ...EvidenceKind.options.map(evidenceKindKey),
      ...FindingCategory.options.map(findingCategoryKey),
      ...FindingAction.options.map(findingActionKey),
      ...PendingPromptKind.options.map(pendingKindKey),
      ...PHASE_VALUES.map(phaseKey),
      ...SubState.options.map(subStateKey),
      ...MIGRATED_DIAGNOSTIC_CODES.map(diagnosticKey),
      ...Object.values(FAILURE_SITE_KEYS),
      ...Object.values(SUCCESS_KEYS),
    ];

    expect(new Set(RUNTIME_I18N_KEYS)).toEqual(new Set(helperKeys));
  });

  test("migrated diagnostic placeholders match en, zh, and ERROR_CATALOG", () => {
    for (const code of MIGRATED_DIAGNOSTIC_CODES) {
      const key = diagnosticKey(code);
      const en = lookup(BUILTIN_BUNDLES.en, key);
      const zh = lookup(BUILTIN_BUNDLES.zh, key);
      expect(en, `${key} en`).toBeTypeOf("string");
      expect(zh, `${key} zh`).toBeTypeOf("string");
      expect(placeholders(String(en)), `${key} zh placeholders`).toEqual(placeholders(String(zh)));
      expect(placeholders(String(en)), `${key} ERROR_CATALOG placeholders`).toEqual(
        placeholders(ERROR_CATALOG[code].message_template),
      );
    }
  });

  test("failure site keys are explicit, localized, placeholder-symmetric, and map to catalog codes", () => {
    const templateByKey = new Map(Object.values(FAILURE_SITE_TEMPLATES).map((entry) => [entry.key, entry]));
    expect(templateByKey.size).toBe(Object.keys(FAILURE_SITE_TEMPLATES).length);

    for (const key of Object.values(FAILURE_SITE_KEYS)) {
      const entry = templateByKey.get(key);
      expect(entry, `${key} registry entry`).toBeDefined();
      expect(ERROR_CATALOG[entry!.code], `${key} known DiagnosticCode`).toBeDefined();

      const en = lookup(BUILTIN_BUNDLES.en, key);
      const zh = lookup(BUILTIN_BUNDLES.zh, key);
      expect(en, `${key} en`).toBeTypeOf("string");
      expect(zh, `${key} zh`).toBeTypeOf("string");
      expect(placeholders(String(en)), `${key} zh placeholders`).toEqual(placeholders(String(zh)));
      expect(placeholders(String(en)), `${key} registry placeholders`).toEqual(placeholders(entry!.template));
    }
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
      out.push(...await collectSources(entryPath));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(entryPath);
    }
  }
  return out;
}

function placeholders(template: string): string[] {
  return Array.from(template.matchAll(/\{([A-Za-z0-9_]+)\}/g), (match) => match[1]!).sort();
}
