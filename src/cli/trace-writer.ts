// Phase 16 SC-6b — `--debug` observability: trace.jsonl writer.
//
// Best-effort, non-authoritative Debug-trace per protocol §13.1. One
// `kind:"cli"` row per loaf invocation, written at the end of main()
// when:
//   - `ctx.debug` is true (flag OR `LOAF_DEBUG`/`DEBUG` env), AND
//   - `ctx.traceTarget` resolved (action handler entered + recorded
//     feature + featureDir)
//
// External-command rows (`kind:"external"`) are reserved per
// docs/protocol.md §4.10 + §13.2 future. Not implemented in v0.1.0.
//
// Write failure never flips the command's exit code — observability
// must not poison stable-core correctness. Trace tests use `MainDeps`
// injection (`appendTraceLine`/`now`/`monotonicNow`) — see
// src/cli.tsx MainDeps + tests/cli/debug-end-to-end.test.ts.
//
// Redaction set covers 14 free-text / payload / identity-bearing
// flags per codex r270 + r271. Closed-enum / identifier flags stay
// verbatim. trace.jsonl is local debug data and may include command
// output and user input fragments — `.gitignore` excludes it by
// default (`**/.loaf/*/trace.jsonl`).

import { promises as fs } from "node:fs";
import path from "node:path";

export type TraceEntry = {
  schema_version: 2;
  kind: "cli";
  at: string; // ISO-8601
  feature: string;
  session_id: string | null;
  sub_state: string | null;
  cmd: string;
  argv: readonly string[];
  exit: number;
  wall_ms: number;
  stdout_summary: string;
};

/** Flags whose value carries free-form prose, file paths, payloads,
 *  or identity-bearing data — replaced with a placeholder before
 *  trace.jsonl write. Closed enums / numeric identifiers / boolean
 *  flags stay verbatim. */
const REDACTED_FLAG_VALUES: ReadonlySet<string> = new Set([
  // Path / payload
  "--feature-dir",
  "--input",
  // Free-text prose
  "--reason",
  "--answer",
  "--question",
  "--options",
  "--label",
  "--summary",
  "--evidence-summary",
  "--evidence-reason",
  "--feature-name",
  "--intent",
  "--workspace",
  // Identity-bearing
  "--evidence-actor",
]);

function placeholderFor(flag: string): string {
  // Strip leading `--` and produce `<name>` token (e.g. `--feature-dir`
  // → `<feature-dir>`). Keeps the original flag shape visible in trace
  // for grep ergonomics while scrubbing the value.
  return `<${flag.slice(2)}>`;
}

/** Walks argv once, replacing each REDACTED flag's value. Handles both
 *  forms: `--flag value` (two argv tokens) and `--flag=value` (single
 *  token). Idempotent. */
export function redactArgv(argv: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // Equals form: `--flag=value`
    const eqIdx = arg.indexOf("=");
    if (arg.startsWith("--") && eqIdx > 2) {
      const flag = arg.slice(0, eqIdx);
      if (REDACTED_FLAG_VALUES.has(flag)) {
        out.push(`${flag}=${placeholderFor(flag)}`);
        continue;
      }
      out.push(arg);
      continue;
    }
    // Space form: `--flag value`. Replace next token if the value
    // exists and isn't itself another flag (defensive — flags are
    // never blank values).
    if (REDACTED_FLAG_VALUES.has(arg)) {
      out.push(arg);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.push(placeholderFor(arg));
        i++; // consume the value
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** Captured stdout slice → summary string. JSON mode parses + re-
 *  stringifies (drops formatting whitespace, normalizes shape). Text
 *  mode passes raw + truncates. 256-char cap. */
const STDOUT_SUMMARY_CHAR_CAP = 256;

export function summarizeStdout(
  rawStdout: string,
  outputMode: "json" | "text",
): string {
  if (outputMode === "json") {
    try {
      const parsed = JSON.parse(rawStdout) as unknown;
      const s = JSON.stringify(parsed);
      return s.length <= STDOUT_SUMMARY_CHAR_CAP
        ? s
        : s.slice(0, STDOUT_SUMMARY_CHAR_CAP);
    } catch {
      // Fall through to text truncation if not parseable
    }
  }
  return rawStdout.length <= STDOUT_SUMMARY_CHAR_CAP
    ? rawStdout
    : rawStdout.slice(0, STDOUT_SUMMARY_CHAR_CAP);
}

export type BuildTraceEntryInput = {
  now: Date;
  feature: string;
  sessionId: string | null;
  subState: string | null;
  cmd: string;
  argv: readonly string[];
  exit: number;
  wallMs: number;
  rawStdout: string;
  outputMode: "json" | "text";
};

export function buildTraceEntry(input: BuildTraceEntryInput): TraceEntry {
  return {
    schema_version: 2,
    kind: "cli",
    at: input.now.toISOString(),
    feature: input.feature,
    session_id: input.sessionId,
    sub_state: input.subState,
    cmd: input.cmd,
    argv: redactArgv(input.argv),
    exit: input.exit,
    wall_ms: input.wallMs,
    stdout_summary: summarizeStdout(input.rawStdout, input.outputMode),
  };
}

/** Production trace-line writer. Best-effort `fs.appendFile`; no
 *  fsync (Debug-trace is non-authoritative per §13.1). POSIX
 *  O_APPEND atomic semantics for single-line writes (entries here
 *  cap below 4KB after redaction + summary truncation). */
export async function defaultAppendTraceLine(
  featureDir: string,
  entry: TraceEntry,
): Promise<void> {
  const line = JSON.stringify(entry) + "\n";
  await fs.appendFile(path.join(featureDir, "trace.jsonl"), line, "utf8");
}
