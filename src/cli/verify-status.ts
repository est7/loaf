// Phase 16 SC-9a-1 — `loaf verify status` read-side surface.
//
// Renders the verify-accept gate's diagnostic view as a 5-row PerCheckResult
// summary without short-circuiting on first failure. Reuses
// evaluateVerifyAcceptDiagnostic (verify-accept-eval.ts) so the IO boundary
// (spec.md frontmatter read) maps to a structured exit-2 diagnostic; pure
// per-check evaluation rides evaluateAllChecks.
//
// Public envelope (codex r304 lock):
//   { ok: true, all_pass: boolean,
//     checks: [{ check, status, failures: FailedCheck[] }, … 5 rows] }
//
// Status per row:
//   pass — applicable + walker returned no failures
//   fail — applicable + walker returned ≥1 failure
//   na   — not applicable per deriveCheckApplicability
//
// Frontmatter unreadable → caller (cli.tsx action) emits exit-2 envelope
// `{ ok:false, code:"SPEC_FRONTMATTER_INVALID", message, detail }`.

import type {
  FailedCheck,
  PerCheckResult,
  VerifyCheckId,
} from "../core/gates/verify-accept-check.js";
import { DEFAULT_I18N, type I18n } from "./i18n.js";
import { CHROME_KEYS } from "./runtime-i18n-keys.js";

export interface VerifyStatusEnvelope {
  ok: true;
  all_pass: boolean;
  checks: PerCheckResult[];
}

/** Build the JSON envelope from evaluateAllChecks output. */
export function buildEnvelope(checks: PerCheckResult[]): VerifyStatusEnvelope {
  const allPass = checks.every((r) => r.status !== "fail");
  return { ok: true, all_pass: allPass, checks };
}

/** Presentation — fixed column widths per the §7.4 example shape. */
const CHECK_LABEL_KEYS = {
  lane_status: CHROME_KEYS.verifyStatusCheckLaneStatus,
  open_findings: CHROME_KEYS.verifyStatusCheckOpenFindings,
  coverage: CHROME_KEYS.verifyStatusCheckCoverage,
  task_evidence: CHROME_KEYS.verifyStatusCheckTaskEvidence,
  spec_review: CHROME_KEYS.verifyStatusCheckSpecReview,
};

function checkLabel(check: VerifyCheckId, i18n: I18n): string {
  return i18n.t(CHECK_LABEL_KEYS[check]);
}

function statusGlyph(status: PerCheckResult["status"], i18n: I18n): string {
  if (status === "pass") return i18n.t(CHROME_KEYS.verifyStatusPass);
  if (status === "fail") return i18n.t(CHROME_KEYS.verifyStatusFail);
  return i18n.t(CHROME_KEYS.verifyStatusNa);
}

function failureSummary(failures: FailedCheck[], i18n: I18n): string {
  if (failures.length === 0) return "";
  if (failures.length === 1) {
    const f = failures[0];
    return f ? i18n.t(CHROME_KEYS.verifyStatusFailureSummaryOne, { code: f.code }) : "";
  }
  // Multi-fail row: render count + first code for the table line; full
  // failures rendered as nested lines (see renderText).
  const head = failures[0];
  return i18n.t(CHROME_KEYS.verifyStatusFailureSummaryMany, {
    count: failures.length,
    code: head?.code ?? "?",
  });
}

export function renderText(env: VerifyStatusEnvelope, i18n: I18n = DEFAULT_I18N): string {
  const labels = Object.fromEntries(
    env.checks.map((row) => [row.check, checkLabel(row.check, i18n)]),
  ) as Record<VerifyCheckId, string>;
  const labelWidth = Math.max(...Object.values(labels).map((l) => l.length));
  const lines: string[] = [];
  for (const row of env.checks) {
    const label = labels[row.check].padEnd(labelWidth);
    const status = statusGlyph(row.status, i18n).padEnd(4);
    lines.push(`${label}  ${status}${failureSummary(row.failures, i18n)}`);
    // Show nested failure detail under fail rows for multi-fail visibility.
    if (row.status === "fail" && row.failures.length > 1) {
      for (const f of row.failures) {
        lines.push(`    - ${f.code}: ${f.message}`);
      }
    }
  }
  lines.push(env.all_pass ? "" : i18n.t(CHROME_KEYS.verifyStatusDiagnosticOnly));
  return lines.join("\n") + "\n";
}
