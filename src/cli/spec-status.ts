import type { SpecLockResult } from "../core/gates/spec-lock-check.js";
import type { I18n } from "./i18n.js";
import { CHROME_KEYS } from "./runtime-i18n-keys.js";

export type SpecStatusFailureRow = {
  check: number;
  code: string;
  message: string;
  detail: Record<string, unknown> | null;
};

export type SpecStatusSuppressedRow = {
  check: 4 | 6 | 7;
  blocked_by: 3;
};

export interface SpecStatusEnvelope {
  ok: true;
  all_pass: boolean;
  failures: SpecStatusFailureRow[];
  suppressed_checks: SpecStatusSuppressedRow[];
}

const CHECK_3_SUPPRESSION: readonly SpecStatusSuppressedRow[] = [
  { check: 4, blocked_by: 3 },
  { check: 6, blocked_by: 3 },
  { check: 7, blocked_by: 3 },
];

/** Map internal check objects to the explicit public JSON contract. */
export function buildSpecStatusEnvelope(result: SpecLockResult): SpecStatusEnvelope {
  const checks = result.ok ? [] : result.checks;
  const failures = checks.map((failure) => ({
    check: failure.check,
    code: failure.code,
    message: failure.message,
    detail: failure.detail ?? null,
  }));
  const suppressedChecks = checks.some((failure) => failure.check === 3)
    ? CHECK_3_SUPPRESSION.map((row) => ({ ...row }))
    : [];
  return {
    ok: true,
    all_pass: failures.length === 0,
    failures,
    suppressed_checks: suppressedChecks,
  };
}

export function renderSpecStatusText(env: SpecStatusEnvelope, i18n: I18n): string {
  if (env.all_pass) return i18n.t(CHROME_KEYS.specStatusPass) + "\n";
  const failureLines = env.failures.map(
    (failure) =>
      i18n.t(CHROME_KEYS.specStatusFailureRow, {
        check: failure.check,
        code: failure.code,
        message: failure.message,
      }) + "\n",
  );
  const suppressedLines = env.suppressed_checks.map(
    (row) =>
      i18n.t(CHROME_KEYS.specStatusSuppressedRow, {
        check: row.check,
        blocked_by: row.blocked_by,
      }) + "\n",
  );
  return [...failureLines, ...suppressedLines].join("");
}
