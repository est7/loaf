// Catalog-owned diagnostic presentation and the single recoverable failure outlet.

import {
  ERROR_CATALOG,
  DIAGNOSTIC_VARIANTS,
  type CatalogDiagnostic,
  type DiagnosticContext,
  type DiagnosticTemplate,
} from "../core/error-catalog.js";
import { DEFAULT_I18N, type I18n } from "./i18n.js";

type I18nVars = Record<string, string | number | boolean | null | undefined>;

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

/** Project nested domain check records only at the presentation boundary. */
function presentedDetail(detail: Record<string, unknown>, i18n: I18n): Record<string, unknown> {
  if (!Array.isArray(detail["checks"])) return detail;
  const checks = detail["checks"] as Array<CatalogDiagnostic & { check: number }>;
  return {
    ...detail,
    checks: checks.map((check) => ({ ...check, message: diagnosticMessage(check, i18n) })),
  };
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

/** Canonical message for nested replay diagnostics at existing presentation boundaries. */
export function diagnosticMessage(
  diagnostic: CatalogDiagnostic,
  i18n: I18n = DEFAULT_I18N,
): string {
  return renderDiagnostic(diagnostic, i18n).message;
}

function renderDiagnostic(diagnostic: CatalogDiagnostic, i18n: I18n) {
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
  const message = i18n.t(key, vars);
  return { parent, context, template, vars, message };
}

/** Recoverable exit-2 outlet. Existing command callers migrate in later
 * slices; this renderer has no CLI/context dependency or error fallback. */
export function writeDiagnosticFailure(
  diagnostic: CatalogDiagnostic,
  presentation: DiagnosticPresentation,
): 2 {
  const i18n = presentation.format === "json" ? DEFAULT_I18N : presentation.i18n;
  const { parent, context, template, vars, message } = renderDiagnostic(diagnostic, i18n);
  const detail = presentedDetail(diagnostic.detail, i18n);
  if (presentation.format === "json") {
    presentation.writeStderr(
      JSON.stringify({ ok: false, code: diagnostic.code, message, detail }) + "\n",
    );
  } else {
    let output = `error: ${diagnostic.code} — ${message}\n` + diagnosticContextRows(detail);
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
