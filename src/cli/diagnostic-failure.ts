// Phase W8 — diagnostic-failure: single-source for the diagnosticVarsFor
// helper that maps structured failure codes to i18n variable bags.
//
// Moved verbatim from src/cli.tsx main() so both command-context.ts
// (emitFailure's try-keyed-then-plain logic) and cli.tsx can import it
// without either owning the catalog knowledge (codex tension 3 resolution).
//
// NOTE: intentionally does NOT import from command-context.ts to avoid a
// circular dependency (command-context imports this module). FORMAT_MODES_HUMAN
// is inlined; I18nVars is defined locally as an equivalent alias.

import { MIGRATED_DIAGNOSTIC_CODES, type MigratedDiagnosticCode } from "./runtime-i18n-keys.js";
import {
  ERROR_CATALOG,
  DIAGNOSTIC_VARIANTS,
  type CatalogDiagnostic,
  type DiagnosticContext,
  type DiagnosticTemplate,
} from "../core/error-catalog.js";
import { DEFAULT_I18N, type I18n } from "./i18n.js";

/** Local equivalent of CommandContext's I18nVars — avoids a circular import. */
export type I18nVars = Record<string, string | number | boolean | null | undefined>;

/** "text|json" — mirrors FORMAT_MODES_HUMAN in command-context.ts without importing it. */
const FORMAT_MODES_HUMAN = "text|json";

function varsIfDefined(vars: Record<string, string | number | null>): I18nVars | null {
  for (const value of Object.values(vars)) {
    if (value === null) return null;
  }
  return vars as I18nVars;
}

function stringVar(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function numberVar(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function listVar(value: unknown): string | null {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  return stringVar(value);
}

function migratedDiagnosticVarsFor(
  code: MigratedDiagnosticCode,
  detail: Record<string, unknown> | undefined,
): I18nVars | null {
  switch (code) {
    case "INVALID_FORMAT":
      return varsIfDefined({
        value: stringVar(detail?.["value"]),
        allowed_values_human: stringVar(detail?.["allowed_values_human"]) ?? FORMAT_MODES_HUMAN,
      });
    case "MUTUALLY_EXCLUSIVE_FLAGS":
      return varsIfDefined({ flags: listVar(detail?.["conflicting"]) });
    case "DRY_RUN_NOT_APPLICABLE":
      return varsIfDefined({
        command_type: stringVar(detail?.["command_type"]),
        command: stringVar(detail?.["command"]),
      });
    case "SPEC_EDIT_INPUT_REQUIRED":
      return {};
    case "CONFIG_ALREADY_INITIALIZED":
      return varsIfDefined({ config_path: stringVar(detail?.["config_path"]) });
    case "FEATURE_NOT_FOUND":
      return {};
    case "FEATURE_AMBIGUOUS":
      return varsIfDefined({
        count: numberVar(detail?.["count"]),
        feature_list: listVar(detail?.["feature_list"]),
      });
    case "SESSION_CWD_MISMATCH":
      return varsIfDefined({
        uuid: stringVar(detail?.["uuid"]),
        registered_cwd: stringVar(detail?.["registered_cwd"]),
        current_cwd: stringVar(detail?.["current_cwd"]),
      });
    case "SESSION_SHORT_AMBIGUOUS":
      return varsIfDefined({
        prefix: stringVar(detail?.["prefix"]),
        match_count: numberVar(detail?.["match_count"]),
        candidate_list: listVar(detail?.["candidate_list"]),
      });
    case "SESSION_NOT_FOUND":
      return varsIfDefined({ uuid_or_prefix: stringVar(detail?.["uuid_or_prefix"]) });
  }

  const exhaustive: never = code;
  return exhaustive;
}

const MIGRATED_DIAGNOSTIC_CODE_SET = new Set<string>(MIGRATED_DIAGNOSTIC_CODES);

export function diagnosticVarsFor(
  code: string,
  detail: Record<string, unknown> | undefined,
): I18nVars | null {
  if (!MIGRATED_DIAGNOSTIC_CODE_SET.has(code)) return null;
  return migratedDiagnosticVarsFor(code as MigratedDiagnosticCode, detail);
}

export interface DiagnosticPresentation {
  format: "text" | "json";
  i18n: I18n;
  writeStderr: (value: string) => void;
}

function catalogVars(template: DiagnosticTemplate, detail: Record<string, unknown>): I18nVars {
  const vars: I18nVars = {};
  for (const key of template.template_keys) {
    const field = template.adapter?.[key] ?? key;
    const value = detail[field];
    if (value === undefined) throw new Error(`diagnostic contract missing detail.${field}`);
    vars[key] = Array.isArray(value)
      ? value.map((item) => String(item)).join(template.list_separator?.[key] ?? ", ")
      : typeof value === "object" && value !== null
        ? JSON.stringify(value)
        : String(value);
  }
  return vars;
}

function diagnosticContextRows(detail: Record<string, unknown>): string {
  const lines: string[] = [];
  const checks = detail["checks"];
  if (Array.isArray(checks)) {
    for (const c of checks as Array<{ check?: number; code?: string; message?: string }>) {
      lines.push(`  [check ${c.check ?? "?"}] ${c.code ?? "UNKNOWN"}: ${c.message ?? ""}\n`);
    }
  }
  const errors = detail["errors"];
  if (Array.isArray(errors)) {
    for (const e of errors as Array<{ path?: string; code?: string; message?: string }>) {
      lines.push(`  [${e.path ?? "?"}] ${e.code ?? "UNKNOWN"}: ${e.message ?? ""}\n`);
    }
    if (detail["truncated"] === true) {
      const count = detail["error_count"];
      lines.push(
        `  ... (${typeof count === "number" ? count : "?"} errors total; first ${errors.length} shown)\n`,
      );
    }
  }
  return lines.join("");
}

/** Recoverable exit-2 outlet. Existing command callers migrate in later
 * slices; this renderer has no CLI/context dependency or error fallback. */
export function writeDiagnosticFailure(
  diagnostic: CatalogDiagnostic,
  presentation: DiagnosticPresentation,
): 2 {
  const parent = ERROR_CATALOG[diagnostic.code];
  const context = diagnostic.detail["context"] as DiagnosticContext | undefined;
  const variant = context === undefined ? undefined : DIAGNOSTIC_VARIANTS[context];
  if (context !== undefined && (variant === undefined || variant.code !== diagnostic.code)) {
    throw new Error(`diagnostic context ${context} does not belong to ${diagnostic.code}`);
  }
  const template: DiagnosticTemplate = variant?.template ?? parent;
  const vars = catalogVars(template, diagnostic.detail);
  const key =
    context === undefined ? `diagnostic.${diagnostic.code}` : `diagnostic_variant.${context}`;
  const i18n = presentation.format === "json" ? DEFAULT_I18N : presentation.i18n;
  const message = i18n.t(key, vars);
  if (presentation.format === "json") {
    presentation.writeStderr(
      JSON.stringify({ ok: false, code: diagnostic.code, message, detail: diagnostic.detail }) +
        "\n",
    );
  } else {
    let output =
      `error: ${diagnostic.code} — ${message}\n` + diagnosticContextRows(diagnostic.detail);
    if (template.fix_template !== undefined) {
      const fixKey =
        context === undefined
          ? `diagnostic_fix.${diagnostic.code}`
          : `diagnostic_variant_fix.${context}`;
      output += `  fix: ${i18n.t(fixKey, vars)}\n`;
    }
    if (template.doc_anchor !== undefined) output += `  see: ${template.doc_anchor}\n`;
    presentation.writeStderr(output);
  }
  return parent.exit_code;
}
