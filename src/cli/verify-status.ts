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
const CHECK_LABEL: Record<VerifyCheckId, string> = {
  lane_status: "lane_status",
  open_findings: "open_findings",
  coverage: "coverage",
  task_evidence: "task_evidence",
  spec_review: "spec_review",
};

function statusGlyph(status: PerCheckResult["status"]): string {
  return status; // already short — "pass" / "fail" / "na"
}

function failureSummary(failures: FailedCheck[]): string {
  if (failures.length === 0) return "";
  if (failures.length === 1) {
    const f = failures[0];
    return f ? ` ${f.code}` : "";
  }
  // Multi-fail row: render count + first code for the table line; full
  // failures rendered as nested lines (see renderText).
  const head = failures[0];
  return ` ${failures.length} failures (${head?.code ?? "?"}, …)`;
}

export function renderText(env: VerifyStatusEnvelope): string {
  const labelWidth = Math.max(
    ...Object.values(CHECK_LABEL).map((l) => l.length),
  );
  const lines: string[] = [];
  for (const row of env.checks) {
    const label = CHECK_LABEL[row.check].padEnd(labelWidth);
    const status = statusGlyph(row.status).padEnd(4);
    lines.push(`${label}  ${status}${failureSummary(row.failures)}`);
    // Show nested failure detail under fail rows for multi-fail visibility.
    if (row.status === "fail" && row.failures.length > 1) {
      for (const f of row.failures) {
        lines.push(`    - ${f.code}: ${f.message}`);
      }
    }
  }
  lines.push(env.all_pass ? "" : "(diagnostic only — gate verdict not implied)");
  return lines.join("\n") + "\n";
}
