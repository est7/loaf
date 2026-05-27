// Phase 16 SC-3 — CommandContext (presentation-layer plumbing).
//
// Encapsulates the cross-cutting concerns shared by ~29 action handlers
// in src/cli.tsx:
//
//   - Output channel resolution via `--format <text|json>` (SC-5a)
//   - Lazy session/projection load with per-(featureDir, method) cache
//   - Success / failure stderr+stdout routing
//   - Crash context snapshot for the SC-2 boundary enrichment
//
// Per codex r206:
//   - A: fold OutputContext into CommandContext (single inject point)
//   - A3: keep mutable exitCode (NOT throw KnownFailure) — expected
//     failures shouldn't travel through the exceptional boundary
//   - C: src/cli/ flat (presentation, not stable-core)
//   - D: lazy + cache by (featureDir, method) — sessions and projections
//     have different failure modes (loadSession throws on bad journal;
//     loadProjections has typed NoSession / SnapshotStale)
//   - G/I: ctx.failure code is `string` (not typed DiagnosticCode); the
//     SC-1 catalog gate is enforced via tests/scripts/cli-inventory.test.ts
//     which (SC-3 extension per r206 PATCH G/I) now scans src/cli/**/*.ts
//     for ctx.failure(...) emit sites
//
// Test surface: tests/cli/command-context.test.ts.

import type { ProjectionKind, LoadResult } from "../core/projection-loader.js";
import type { SessionLoad } from "../core/cli-runtime.js";

export type OutputMode = "json" | "text";

/** Closed value set for `--format`. Single source of truth for both the
 *  argv parser and the human-readable error template. Order is
 *  intentional: matches the `text|json` rendering in user-facing
 *  diagnostics. */
export const FORMAT_MODES: readonly OutputMode[] = ["text", "json"] as const;

/** Pipe-joined human form for INVALID_FORMAT i18n templates.
 *  Derived explicitly — never `Array.toString()` — to keep the
 *  catalog/i18n/runtime placeholder symmetry deterministic
 *  (per RED #12 in tests/scripts/sc5a-surface-gate.test.ts). */
export const FORMAT_MODES_HUMAN: string = FORMAT_MODES.join("|");

export type FormatParseResult =
  | { ok: true; format: OutputMode }
  | { ok: false; rawValue: string };

/** Parse `--format <v>` or `--format=<v>` from argv. Returns OK 'text'
 *  on absent. Bare `--format` (no value, or followed by another flag)
 *  is intentionally OK-text — Commander's mandatory-arg path catches
 *  the missing value during `program.parseAsync(argv)` and reports a
 *  USAGE error (per RED #13).
 *
 *  Used both by `createCommandContext` (to derive `ctx.output`) and by
 *  `cli.tsx main()`'s pre-parse guard. Both readers MUST share this
 *  function to guarantee a single source of truth (no Commander
 *  default; argv-scan owns the decision). */
export function parseFormatFromArgv(argv: readonly string[]): FormatParseResult {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--format") {
      const v = argv[i + 1];
      // Bare or trailing flag-like value: defer to Commander's
      // missing-argument USAGE path. Return text default so ctx.output
      // is well-defined if main() forgot to bail.
      if (v === undefined || v.startsWith("--")) {
        return { ok: true, format: "text" };
      }
      if ((FORMAT_MODES as readonly string[]).includes(v)) {
        return { ok: true, format: v as OutputMode };
      }
      return { ok: false, rawValue: v };
    }
    if (arg.startsWith("--format=")) {
      const v = arg.slice("--format=".length);
      if ((FORMAT_MODES as readonly string[]).includes(v)) {
        return { ok: true, format: v as OutputMode };
      }
      return { ok: false, rawValue: v };
    }
  }
  return { ok: true, format: "text" };
}

// ─────────────────────────────────────────────────────────────────
// Phase 16 SC-5b1 — presentation flag helpers + parsePresentation
// unified guard. Each helper is raw-argv-only (NOT Commander opts)
// because createCommandContext runs BEFORE program.parseAsync(argv).
// ─────────────────────────────────────────────────────────────────

/** Returns true if `--plain` flag appears in argv. */
export function parsePlainFromArgv(argv: readonly string[]): boolean {
  return argv.includes("--plain");
}

/** Returns true if `--quiet` OR `-q` flag appears in argv. */
export function parseQuietFromArgv(argv: readonly string[]): boolean {
  return argv.includes("--quiet") || argv.includes("-q");
}

/** Returns cumulative verbose count: `-v` = 1, `-vv` = 2,
 *  `--verbose` = 1, and multiple occurrences sum. E.g.
 *  `-v --verbose` = 2, `-vv --verbose` = 3. Per protocol §10.7 +
 *  codex r254 OQ3 verdict. */
export function parseVerboseFromArgv(argv: readonly string[]): number {
  let count = 0;
  for (const arg of argv) {
    if (arg === "--verbose") {
      count += 1;
      continue;
    }
    // `-v`, `-vv`, `-vvv`, ... — N v's = N. Reject mixed
    // short-form (e.g. `-vq`); only pure v-runs count.
    if (/^-v+$/.test(arg)) {
      count += arg.length - 1;
    }
  }
  return count;
}

/** Returns true if any of these is true:
 *  - `--no-color` in argv
 *  - `env.NO_COLOR` non-empty
 *  - `env.LOAF_NO_COLOR` non-empty
 *  - `env.TERM === "dumb"`
 *  Per protocol §10.2 (`docs/protocol.md:1512-1513`). */
export function parseNoColorFromArgv(
  argv: readonly string[],
  env: { NO_COLOR?: string | undefined; LOAF_NO_COLOR?: string | undefined; TERM?: string | undefined } = process.env as never,
): boolean {
  if (argv.includes("--no-color")) return true;
  if (env.NO_COLOR && env.NO_COLOR.length > 0) return true;
  if (env.LOAF_NO_COLOR && env.LOAF_NO_COLOR.length > 0) return true;
  if (env.TERM === "dumb") return true;
  return false;
}

/** parsePresentation — unified pre-parse guard for SC-5a INVALID_FORMAT
 *  + SC-5b1 MUTUALLY_EXCLUSIVE_FLAGS. Runs BEFORE Commander parse.
 *
 *  Precedence:
 *  - INVALID_FORMAT wins over MUTUALLY_EXCLUSIVE_FLAGS (no canonical
 *    value computable from invalid input — per codex r252 Q3 verdict).
 *
 *  Mutex rule (codex r255 P17): a conflict exists if 2+ entries from
 *  the output_format normalization set appear in argv with non-
 *  equivalent canonical values. The error renders as JSON if ANY
 *  `--format json` / `--format=json` appears in argv (renderAsJson),
 *  else text. Order- and spelling-independent.
 */
export type PresentationOk = {
  ok: true;
  format: OutputMode;
  plain: boolean;
  quiet: boolean;
  verbose: number;
  noColor: boolean;
};
export type PresentationFail =
  | { ok: false; kind: "INVALID_FORMAT"; rawValue: string }
  | { ok: false; kind: "MUTUALLY_EXCLUSIVE_FLAGS"; conflicting: string[]; renderAsJson: boolean };
export type PresentationResult = PresentationOk | PresentationFail;

/** Internal: collect every (entry, canonicalValue) pair from argv
 *  using the FLAG_EXCLUSIONS.output_format normalization. Used to
 *  detect non-equivalent multi-flag conflicts. */
function collectOutputFormatEntries(argv: readonly string[]): Array<{ entry: string; canonical: OutputMode }> {
  const out: Array<{ entry: string; canonical: OutputMode }> = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--plain") {
      out.push({ entry: "--plain", canonical: "text" });
      continue;
    }
    if (arg === "--format") {
      const v = argv[i + 1];
      if (v && !v.startsWith("--") && (FORMAT_MODES as readonly string[]).includes(v)) {
        out.push({ entry: `--format ${v}`, canonical: v as OutputMode });
      }
      // bare --format or invalid value: not a normalization entry
      // (Commander or INVALID_FORMAT handles it elsewhere)
      continue;
    }
    if (arg.startsWith("--format=")) {
      const v = arg.slice("--format=".length);
      if ((FORMAT_MODES as readonly string[]).includes(v)) {
        out.push({ entry: arg, canonical: v as OutputMode });
      }
      continue;
    }
  }
  return out;
}

export function parsePresentation(
  argv: readonly string[],
  env: { NO_COLOR?: string | undefined; LOAF_NO_COLOR?: string | undefined; TERM?: string | undefined } = process.env as never,
): PresentationResult {
  // Pass 1: INVALID_FORMAT precedence — scan for `--format` with a
  // value that isn't in FORMAT_MODES. parseFormatFromArgv returns
  // the FIRST INVALID_FORMAT it finds.
  const fmt = parseFormatFromArgv(argv);
  if (!fmt.ok) {
    return { ok: false, kind: "INVALID_FORMAT", rawValue: fmt.rawValue };
  }

  // Pass 2: multi-entry mutex check on output_format normalization.
  // Build the unique canonical-value set; if size > 1, conflict.
  const entries = collectOutputFormatEntries(argv);
  const canonicals = new Set(entries.map((e) => e.canonical));
  if (canonicals.size > 1) {
    // Mutex: render shape per renderAsJson rule (any --format json
    // / --format=json present in argv → JSON shape).
    const renderAsJson = entries.some((e) => e.canonical === "json");
    // Collect the offending entries (those NOT matching the
    // first canonical) for the diagnostic payload. Use stable
    // dedup of spellings to keep error scripting predictable.
    const conflicting = Array.from(new Set(entries.map((e) => e.entry)));
    return { ok: false, kind: "MUTUALLY_EXCLUSIVE_FLAGS", conflicting, renderAsJson };
  }

  // Resolve final format: --plain alias maps to text; explicit
  // --format wins. With no conflict, the single canonical is the
  // result. If no output_format entry at all, default text.
  const format: OutputMode = entries.length > 0 ? entries[0]!.canonical : fmt.format;
  return {
    ok: true,
    format,
    plain: parsePlainFromArgv(argv),
    quiet: parseQuietFromArgv(argv),
    verbose: parseVerboseFromArgv(argv),
    noColor: parseNoColorFromArgv(argv, env),
  };
}

export type CrashContext = {
  phase: string | null;
  sub_state: string | null;
  feature: string | null;
  last_command: string;
};

export type LoadProjectionsFn = <K extends ProjectionKind>(opts: {
  feature_dir: string;
  kinds: readonly K[];
}) => Promise<LoadResult<K>>;

export type CommandContextDeps = {
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
  loadSession?: (featureDir: string) => Promise<SessionLoad>;
  loadProjections?: LoadProjectionsFn;
};

/** Phase 16 SC-5b1 — advisory metadata for state-change + next hint.
 *  Both fields emit to stderr in BOTH text and JSON mode (pipe-safe
 *  separation per protocol §10.2), suppressed only by `ctx.quiet`
 *  (per protocol §10.12). */
export type SuccessAdvisories = {
  /** Single state-change line per protocol §10.12 (`<action>: <changed>`
   *  shape). Newline appended by ctx. */
  stateChange?: string;
  /** Next-step hint(s). Each line prefixed with `next: ` and
   *  newline-terminated. May be a single string or array of strings
   *  for multi-line hints. */
  next?: string | string[];
};

export type CommandContext = {
  readonly argv: readonly string[];
  readonly output: OutputMode;
  /** Phase 16 SC-5b1 — derived from `parsePresentation`. */
  readonly plain: boolean;
  readonly quiet: boolean;
  readonly verbose: number;
  readonly noColor: boolean;
  exitCode: number;
  resolveSession: (featureDir: string) => Promise<SessionLoad>;
  resolveProjections: <K extends ProjectionKind>(
    featureDir: string,
    kinds: readonly K[],
  ) => Promise<LoadResult<K>>;
  /** `textRenderer` is **required** when the command emits text — it's
   *  optional only because JSON mode lazily skips it. In text mode an
   *  omitted renderer throws (codex r208 PATCH 1: no silent JSON
   *  fallback for migrated commands).
   *
   *  Phase 16 SC-5b1: `advisories` are OPTIONAL stateChange + next
   *  emitted to stderr in BOTH modes, suppressed only by `ctx.quiet`. */
  success: (
    payload: object,
    textRenderer?: () => string,
    advisories?: SuccessAdvisories,
  ) => void;
  failure: (
    code: string,
    message: string,
    detail?: Record<string, unknown>,
  ) => void;
  snapshotCrashContext: () => CrashContext;
};

/** Pre-resolve `--feature <NAME>` from argv. Best-effort; null on miss.
 *  Lifted here (was duplicated in src/core/crash-log.ts) so ctx and
 *  crash-log can agree on what "feature" means for a given invocation. */
function extractFeature(argv: readonly string[]): string | null {
  const i = argv.indexOf("--feature");
  if (i < 0 || i + 1 >= argv.length) return null;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

/** Derive `phase` from a `sub_state` like "EXECUTE.work" → "EXECUTE".
 *  Returns null if the sub_state has no dot (no phase prefix). */
function phaseOf(subState: string | null | undefined): string | null {
  if (!subState) return null;
  const i = subState.indexOf(".");
  return i < 0 ? null : subState.slice(0, i);
}

export function createCommandContext(
  argv: readonly string[],
  deps: CommandContextDeps,
): CommandContext {
  // SC-5a/SC-5b1: presentation derivation goes through the shared
  // `parsePresentation` helper so the pre-parse guard in cli.tsx
  // main() and CommandContext never disagree on output mode + flags.
  // On parse failure here we fall back to safe defaults; main()'s
  // pre-parse guard is the canonical rejector and is responsible for
  // emitting INVALID_FORMAT / MUTUALLY_EXCLUSIVE_FLAGS +
  // short-circuiting before this code path runs.
  const presentation = parsePresentation(argv);
  const output: OutputMode = presentation.ok ? presentation.format : "text";
  const plain: boolean = presentation.ok ? presentation.plain : false;
  const quiet: boolean = presentation.ok ? presentation.quiet : false;
  const verbose: number = presentation.ok ? presentation.verbose : 0;
  const noColor: boolean = presentation.ok ? presentation.noColor : false;
  let exitCode = 0;

  // Caches: separate per resolution method per codex r206 PATCH D. Same
  // featureDir hitting both resolveSession and resolveProjections runs
  // both loaders once.
  const sessionCache = new Map<string, Promise<SessionLoad>>();
  const projectionCache = new Map<string, Promise<unknown>>();

  // Cached session for snapshotCrashContext — last resolved session
  // becomes the source for phase/sub_state in the crash log envelope.
  let lastResolvedSubState: string | null = null;

  const ctx: CommandContext = {
    argv,
    output,
    plain,
    quiet,
    verbose,
    noColor,
    get exitCode() {
      return exitCode;
    },
    set exitCode(v: number) {
      exitCode = v;
    },

    async resolveSession(featureDir: string): Promise<SessionLoad> {
      const cached = sessionCache.get(featureDir);
      if (cached) return cached;
      if (!deps.loadSession) {
        throw new Error(
          "CommandContext: loadSession dep not provided; cannot resolveSession",
        );
      }
      const p = deps.loadSession(featureDir).then((sess) => {
        const sub = sess.snapshot.state?.sub_state ?? null;
        if (sub) lastResolvedSubState = sub;
        return sess;
      });
      sessionCache.set(featureDir, p);
      return p;
    },

    async resolveProjections<K extends ProjectionKind>(
      featureDir: string,
      kinds: readonly K[],
    ): Promise<LoadResult<K>> {
      const key = `${featureDir}::${[...kinds].sort().join(",")}`;
      const cached = projectionCache.get(key) as Promise<LoadResult<K>> | undefined;
      if (cached) return cached;
      if (!deps.loadProjections) {
        throw new Error(
          "CommandContext: loadProjections dep not provided; cannot resolveProjections",
        );
      }
      const p = deps.loadProjections({ feature_dir: featureDir, kinds });
      projectionCache.set(key, p);
      return p;
    },

    success(payload, textRenderer, advisories) {
      // Primary stdout (channel A): mode-dependent.
      if (output === "json") {
        deps.writeStdout(JSON.stringify(payload) + "\n");
      } else {
        if (!textRenderer) {
          // Codex r208 PATCH 1: no silent JSON fallback in text mode.
          // A migration that omits the renderer would silently change
          // the line-oriented text contract. Fail fast so the bug
          // surfaces in tests instead of in production.
          throw new Error(
            "ctx.success: text renderer required in text mode (a migrated command must always pass a text renderer; JSON mode skips it lazily)",
          );
        }
        deps.writeStdout(textRenderer());
      }
      // Advisory stderr (channels B + C): mode-independent. Both text
      // and JSON modes emit advisories to stderr — pipe-safe per
      // protocol §10.2. Suppressed by --quiet per protocol §10.12.
      // SC-5b1 only `loaf start` passes advisories; SC-5b2 migrates
      // the remaining 40 sites.
      if (!quiet && advisories) {
        if (advisories.stateChange) {
          deps.writeStderr(advisories.stateChange + "\n");
        }
        if (advisories.next !== undefined) {
          const lines = Array.isArray(advisories.next) ? advisories.next : [advisories.next];
          for (const line of lines) {
            deps.writeStderr(`next: ${line}\n`);
          }
        }
      }
    },

    failure(code, message, detail) {
      if (output === "json") {
        const out: Record<string, unknown> = { ok: false, code, message };
        if (detail !== undefined) out["detail"] = detail;
        deps.writeStderr(JSON.stringify(out) + "\n");
      } else {
        deps.writeStderr(`error: ${code} — ${message}\n`);
        // Inherit the SC-2 emitFailure check-detail rendering for parity.
        const checks = detail?.["checks"];
        if (Array.isArray(checks)) {
          for (const c of checks as Array<{
            check?: number;
            code?: string;
            message?: string;
          }>) {
            deps.writeStderr(
              `  [check ${c.check ?? "?"}] ${c.code ?? "UNKNOWN"}: ${c.message ?? ""}\n`,
            );
          }
        }
      }
      exitCode = 2;
    },

    snapshotCrashContext(): CrashContext {
      return {
        phase: phaseOf(lastResolvedSubState),
        sub_state: lastResolvedSubState,
        feature: extractFeature(argv),
        last_command: [...argv].join(" "),
      };
    },
  };
  return ctx;
}
