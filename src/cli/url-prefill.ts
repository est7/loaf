// Phase 16 SC-3 — bug-report URL prefill (sanitization + query assembly).
//
// Protocol §10.5 documents that the unexpected-error stderr line points
// at `$LOAF_ISSUE_URL?<prefilled-context>`. SC-3 implements the prefill
// per codex r206 PATCH H: conservative allowlist.
//
// Discipline:
//   - command + subcommand pass through (CLI surface is public)
//   - flag NAMES pass through (also public surface)
//   - flag VALUES default-redact except for a tight allowlist of public
//     enum-like flags (--ceremony / --format / --feature). Any value that
//     looks like inline JSON ({...}/[...]) OR contains a path separator
//     OR is for a known-sensitive flag (--reason / --answer / --summary /
//     --input / --label) is redacted to "<redacted>".
//   - The crash log file ON DISK keeps full argv (envelope.argv). Only
//     the URL query is sanitized — that's the user-pasteable surface.
//
// Test surface: tests/cli/url-prefill.test.ts.

// Codex r208 PATCH 2: positional allowlist. Unknown positionals (feature
// slugs / task ids / customer codenames) default-redact. Only command
// words + protocol-defined public enums (sub_state targets, gate names)
// pass through.
const COMMAND_WORDS = new Set<string>([
  "loaf",
  // Top-level commands
  "start", "advance", "status", "spec", "tasks", "pending", "evidence",
  "finding", "gate", "deliver", "settle", "doctor", "archive", "abandon",
  "spike", "profile",
  // Subcommands (per cli.tsx)
  "submit", "init", "add-req", "add-scenario", "add-visual",
  "claim", "list", "next", "step", "amend", "complete",
  "done", "raise", "resolve", "add", "close", "decide",
  "convert", "escalate",
]);

// Public enum positionals per protocol §1 SubState + §10.8 gate names
const SUB_STATE_RE = /^(TRIAGE|SPEC|EXECUTE|VERIFY|SETTLE|DONE)(\.[a-z_]+)?$/;
const GATE_NAME_RE = /^(spec-lock|verify-accept)$/;

function isSafePositional(token: string): boolean {
  if (COMMAND_WORDS.has(token)) return true;
  if (SUB_STATE_RE.test(token)) return true;
  if (GATE_NAME_RE.test(token)) return true;
  return false;
}

const ALLOWLIST_VALUE_FLAGS = new Set<string>([
  "--ceremony",
  "--format",
  "--feature",
]);

const ALWAYS_REDACT_FLAGS = new Set<string>([
  "--input",
  "--reason",
  "--answer",
  "--summary",
  "--label",
]);

const REDACTED = "<redacted>";

function looksLikeInlineJson(s: string): boolean {
  return /^[{[]/.test(s);
}

function looksLikePath(s: string): boolean {
  return s.includes("/") || s.includes("\\");
}

/**
 * Sanitize an argv array into a single-space-joined string safe for URL
 * query inclusion. The first non-flag positional after a flag NAME is
 * considered its value; if the flag is in ALWAYS_REDACT_FLAGS or the
 * value matches a sensitivity heuristic (inline JSON / path), redact.
 * Otherwise, if the flag is in ALLOWLIST_VALUE_FLAGS, pass the value
 * through; else redact.
 */
export function sanitizeArgvForUrl(argv: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      // Codex r208 PATCH 2: positional default-redact. Only command
      // words + public enum positionals (sub_states, gate names) pass
      // through — everything else (feature slugs, task ids, customer
      // codenames) is potentially sensitive and goes to <redacted>.
      out.push(isSafePositional(token) ? token : REDACTED);
      continue;
    }
    // Flag — push the name verbatim
    out.push(token);
    // Look at the next token: if it's another flag or end-of-args, the
    // current flag is boolean (no value). Otherwise it's the value.
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) continue;
    // Value belongs to the previous flag.
    i++;
    const flag = token;
    if (ALWAYS_REDACT_FLAGS.has(flag)) {
      out.push(REDACTED);
    } else if (looksLikeInlineJson(next) || looksLikePath(next)) {
      out.push(REDACTED);
    } else if (ALLOWLIST_VALUE_FLAGS.has(flag)) {
      out.push(next);
    } else {
      out.push(REDACTED);
    }
  }
  return out.join(" ");
}

export type BuildReportUrlInput = {
  base: string;
  loaf_version: string;
  schema_version: string;
  phase: string | null;
  sub_state: string | null;
  argv: readonly string[];
  crash_log_path: string | null;
};

/**
 * Build the prefilled report URL. Query params: loaf_version /
 * schema_version / phase? / sub_state? / last_command (sanitized) /
 * crash_log_path?. Per codex r206 PATCH H: nulls are omitted, not
 * stringified.
 */
export function buildReportUrl(input: BuildReportUrlInput): string {
  const u = new URL(input.base);
  u.searchParams.set("loaf_version", input.loaf_version);
  u.searchParams.set("schema_version", input.schema_version);
  if (input.phase !== null) u.searchParams.set("phase", input.phase);
  if (input.sub_state !== null) u.searchParams.set("sub_state", input.sub_state);
  u.searchParams.set("last_command", sanitizeArgvForUrl(input.argv));
  if (input.crash_log_path !== null) {
    u.searchParams.set("crash_log_path", input.crash_log_path);
  }
  return u.toString();
}
