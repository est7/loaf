import { scanArgv, optionArgv } from "../core/argv-scanner.js";

/** Pure argv/environment presentation parsing.
 *
 * This module is the functional core for CLI presentation decisions. Every
 * environment-dependent parser requires its environment explicitly; process
 * state is owned and injected by command-context.ts.
 */

const FORMAT_VALUE_FLAGS = new Set(["--format"]);

export type OutputMode = "json" | "text";

/** Closed value set for `--format`. Single source of truth for both the
 * argv parser and the human-readable error template. */
export const FORMAT_MODES: readonly OutputMode[] = ["text", "json"] as const;

/** Pipe-joined human form for INVALID_FORMAT i18n templates. */
export const FORMAT_MODES_HUMAN: string = FORMAT_MODES.join("|");

export type FormatParseResult = { ok: true; format: OutputMode } | { ok: false; rawValue: string };

export type PresentationEnv = {
  NO_COLOR?: string | undefined;
  LOAF_NO_COLOR?: string | undefined;
  TERM?: string | undefined;
  LOAF_DEBUG?: string | undefined;
  DEBUG?: string | undefined;
};

/** Parse `--format <v>` or `--format=<v>` from argv. Returns OK 'text'
 * on absent. Bare `--format` intentionally defers to Commander. */
export function parseFormatFromArgv(argv: readonly string[]): FormatParseResult {
  const token = scanArgv(optionArgv(argv), FORMAT_VALUE_FLAGS).find(
    (token) => token.kind === "option" && token.flag === "--format",
  );
  if (token?.kind === "option") {
    const value = token.value;
    if (!token.raw.includes("=") && (value === undefined || value.startsWith("--")))
      return { ok: true, format: "text" };
    if (value !== undefined && (FORMAT_MODES as readonly string[]).includes(value))
      return { ok: true, format: value as OutputMode };
    return { ok: false, rawValue: value! };
  }
  return { ok: true, format: "text" };
}

/** Scan EVERY `--format` / `--format=` occurrence — not just the first — so a
 * later invalid value is not masked by an earlier valid one (codex r258 F1).
 * This exhaustiveness is what gives INVALID_FORMAT its position-independent
 * precedence over the mutex check. */
export function findFirstInvalidFormat(argv: readonly string[]): { rawValue: string } | null {
  for (const token of scanArgv(optionArgv(argv), FORMAT_VALUE_FLAGS)) {
    if (token.kind !== "option" || token.flag !== "--format") continue;
    const value = token.value;
    if (!token.raw.includes("=") && (value === undefined || value.startsWith("--"))) continue;
    if (value !== undefined && !(FORMAT_MODES as readonly string[]).includes(value))
      return { rawValue: value };
  }
  return null;
}

export function parsePlainFromArgv(argv: readonly string[]): boolean {
  return scanArgv(optionArgv(argv)).some((token) => token.raw === "--plain");
}

export function parseQuietFromArgv(argv: readonly string[]): boolean {
  return (
    scanArgv(optionArgv(argv)).some((token) => token.raw === "--quiet") ||
    scanArgv(optionArgv(argv)).some((token) => token.raw === "-q")
  );
}

export function parseNoInputFromArgv(argv: readonly string[]): boolean {
  return scanArgv(optionArgv(argv)).some((token) => token.raw === "--no-input");
}

export function parseDebugFromArgv(argv: readonly string[], env: PresentationEnv): boolean {
  if (scanArgv(optionArgv(argv)).some((token) => token.raw === "--debug")) return true;
  if (env.LOAF_DEBUG && env.LOAF_DEBUG.length > 0) return true;
  if (env.DEBUG && env.DEBUG.length > 0) return true;
  return false;
}

export function parseDryRunFromArgv(argv: readonly string[]): boolean {
  return (
    scanArgv(optionArgv(argv)).some((token) => token.raw === "--dry-run") ||
    scanArgv(optionArgv(argv)).some((token) => token.raw === "-n")
  );
}

export function parseVerboseFromArgv(argv: readonly string[]): number {
  let count = 0;
  for (const { raw: arg } of scanArgv(optionArgv(argv))) {
    if (arg === "--verbose") {
      count += 1;
      continue;
    }
    if (/^-v+$/.test(arg)) {
      count += arg.length - 1;
    }
  }
  return count;
}

/** Color suppression per protocol §10.2: `--no-color`, non-empty `NO_COLOR` or
 * `LOAF_NO_COLOR`, or `TERM=dumb`. */
export function parseNoColorFromArgv(argv: readonly string[], env: PresentationEnv): boolean {
  if (scanArgv(optionArgv(argv)).some((token) => token.raw === "--no-color")) return true;
  if (env.NO_COLOR && env.NO_COLOR.length > 0) return true;
  if (env.LOAF_NO_COLOR && env.LOAF_NO_COLOR.length > 0) return true;
  if (env.TERM === "dumb") return true;
  return false;
}

export type PresentationOk = {
  ok: true;
  format: OutputMode;
  plain: boolean;
  quiet: boolean;
  verbose: number;
  noColor: boolean;
  noInput: boolean;
  debug: boolean;
  dryRun: boolean;
};

export type PresentationFail =
  | { ok: false; kind: "INVALID_FORMAT"; rawValue: string }
  | { ok: false; kind: "MUTUALLY_EXCLUSIVE_FLAGS"; conflicting: string[]; renderAsJson: boolean };

export type PresentationResult = PresentationOk | PresentationFail;

function collectOutputFormatEntries(
  argv: readonly string[],
): Array<{ entry: string; canonical: OutputMode }> {
  const out: Array<{ entry: string; canonical: OutputMode }> = [];
  for (const token of scanArgv(optionArgv(argv), FORMAT_VALUE_FLAGS)) {
    if (token.raw === "--plain") {
      out.push({ entry: "--plain", canonical: "text" });
      continue;
    }
    if (token.kind !== "option" || token.flag !== "--format") continue;
    const value = token.value;
    if (value !== undefined && (FORMAT_MODES as readonly string[]).includes(value)) {
      out.push({
        entry: token.raw.includes("=") ? token.raw : `--format ${value}`,
        canonical: value as OutputMode,
      });
    }
  }
  return out;
}

/** Parse presentation flags with INVALID_FORMAT taking precedence over
 * MUTUALLY_EXCLUSIVE_FLAGS. The caller must inject the environment. */
export function parsePresentation(
  argv: readonly string[],
  env: PresentationEnv,
): PresentationResult {
  const invalid = findFirstInvalidFormat(argv);
  if (invalid) {
    return { ok: false, kind: "INVALID_FORMAT", rawValue: invalid.rawValue };
  }

  const entries = collectOutputFormatEntries(argv);
  const canonicals = new Set(entries.map((entry) => entry.canonical));
  if (canonicals.size > 1) {
    // Render the mutex diagnostic as JSON whenever ANY `--format json` spelling
    // appears in argv — the caller asked for machine output even though the
    // request is malformed. Spellings are deduped so error scripting is stable.
    const renderAsJson = entries.some((entry) => entry.canonical === "json");
    const conflicting = Array.from(new Set(entries.map((entry) => entry.entry)));
    return { ok: false, kind: "MUTUALLY_EXCLUSIVE_FLAGS", conflicting, renderAsJson };
  }

  const format: OutputMode = entries.length > 0 ? entries[0]!.canonical : "text";
  return {
    ok: true,
    format,
    plain: parsePlainFromArgv(argv),
    quiet: parseQuietFromArgv(argv),
    verbose: parseVerboseFromArgv(argv),
    noColor: parseNoColorFromArgv(argv, env),
    noInput: parseNoInputFromArgv(argv),
    debug: parseDebugFromArgv(argv, env),
    dryRun: parseDryRunFromArgv(argv),
  };
}
