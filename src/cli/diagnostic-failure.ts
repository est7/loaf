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

import {
  MIGRATED_DIAGNOSTIC_CODES,
  type MigratedDiagnosticCode,
} from "./runtime-i18n-keys.js";

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
