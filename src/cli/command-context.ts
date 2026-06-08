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
import { DEFAULT_I18N, type I18n } from "./i18n.js";
import {
  resolveDispatch as realResolveDispatch,
  type DispatchResult,
} from "../core/session-dispatch.js";

export type OutputMode = "json" | "text";
export type I18nVars = Record<string, string | number | boolean | null | undefined>;

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

export type FormatParseResult = { ok: true; format: OutputMode } | { ok: false; rawValue: string };

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

/** Scan EVERY `--format <v>` and `--format=<v>` occurrence and return
 *  the first one with a value outside FORMAT_MODES. Returns null when
 *  all occurrences are valid (or absent). Used by parsePresentation
 *  to honor INVALID_FORMAT precedence over mutex regardless of
 *  position (codex r258 F1: an invalid value AFTER a valid one must
 *  still raise INVALID_FORMAT). */
export function findFirstInvalidFormat(argv: readonly string[]): { rawValue: string } | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--format") {
      const v = argv[i + 1];
      // Bare or trailing flag-like value: SC-5a defers to Commander's
      // mandatory-arg USAGE path. Don't treat it as INVALID_FORMAT.
      if (v === undefined || v.startsWith("--")) continue;
      if (!(FORMAT_MODES as readonly string[]).includes(v)) {
        return { rawValue: v };
      }
      // Valid: skip both arg and the consumed value.
      i++;
      continue;
    }
    if (arg.startsWith("--format=")) {
      const v = arg.slice("--format=".length);
      if (!(FORMAT_MODES as readonly string[]).includes(v)) {
        return { rawValue: v };
      }
    }
  }
  return null;
}

/** Returns true if `--plain` flag appears in argv. */
export function parsePlainFromArgv(argv: readonly string[]): boolean {
  return argv.includes("--plain");
}

/** Returns true if `--quiet` OR `-q` flag appears in argv. */
export function parseQuietFromArgv(argv: readonly string[]): boolean {
  return argv.includes("--quiet") || argv.includes("-q");
}

/** Phase 16 SC-6a — returns true if `--no-input` appears in argv.
 *  Orthogonal to output_format / quiet / verbose / color (no mutex).
 *  Declares non-interactive context — actor resolver refuses git-config
 *  fallback; any future prompt entry must exit 2. Explicit actor input
 *  via `$LOAF_USER` is NOT disabled by this flag. */
export function parseNoInputFromArgv(argv: readonly string[]): boolean {
  return argv.includes("--no-input");
}

/** Phase 16 SC-6b — returns true if `--debug` flag OR a non-empty
 *  `LOAF_DEBUG` / `DEBUG` env var triggers debug mode. Precedence:
 *  `--debug` flag > `LOAF_DEBUG` > `DEBUG` (any non-empty value
 *  is truthy per protocol §1547; no `0`/`false` magic). Orthogonal
 *  to all other presentation flags. */
export function parseDebugFromArgv(
  argv: readonly string[],
  env: { LOAF_DEBUG?: string | undefined; DEBUG?: string | undefined } = process.env as never,
): boolean {
  if (argv.includes("--debug")) return true;
  if (env.LOAF_DEBUG && env.LOAF_DEBUG.length > 0) return true;
  if (env.DEBUG && env.DEBUG.length > 0) return true;
  return false;
}

/** Phase 16 SC-6c — returns true if `--dry-run` or `-n` appears in argv.
 *  Orthogonal to all other presentation flags (no mutex). When true,
 *  mutating commands short-circuit before journal append + projection
 *  refresh; read-only commands reject with DRY_RUN_NOT_APPLICABLE. */
export function parseDryRunFromArgv(argv: readonly string[]): boolean {
  return argv.includes("--dry-run") || argv.includes("-n");
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
  env: {
    NO_COLOR?: string | undefined;
    LOAF_NO_COLOR?: string | undefined;
    TERM?: string | undefined;
  } = process.env as never,
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
  /** Phase 16 SC-6a — non-interactive mode declaration. Orthogonal to
   *  output_format normalization; does not participate in the
   *  MUTUALLY_EXCLUSIVE_FLAGS check. See `parseNoInputFromArgv`. */
  noInput: boolean;
  /** Phase 16 SC-6b — debug observability. Orthogonal to all other
   *  flags; does not participate in MUTUALLY_EXCLUSIVE_FLAGS. See
   *  `parseDebugFromArgv` (env-aware). */
  debug: boolean;
  /** Phase 16 SC-6c — dry-run mode. Orthogonal to all other flags.
   *  When true: mutating commands short-circuit before disk writes;
   *  read-only commands reject. See `parseDryRunFromArgv`. */
  dryRun: boolean;
};
export type PresentationFail =
  | { ok: false; kind: "INVALID_FORMAT"; rawValue: string }
  | { ok: false; kind: "MUTUALLY_EXCLUSIVE_FLAGS"; conflicting: string[]; renderAsJson: boolean };
export type PresentationResult = PresentationOk | PresentationFail;

/** Internal: collect every (entry, canonicalValue) pair from argv
 *  using the FLAG_EXCLUSIONS.output_format normalization. Used to
 *  detect non-equivalent multi-flag conflicts. */
function collectOutputFormatEntries(
  argv: readonly string[],
): Array<{ entry: string; canonical: OutputMode }> {
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
  env: {
    NO_COLOR?: string | undefined;
    LOAF_NO_COLOR?: string | undefined;
    TERM?: string | undefined;
    LOAF_DEBUG?: string | undefined;
    DEBUG?: string | undefined;
  } = process.env as never,
): PresentationResult {
  // Pass 1: INVALID_FORMAT precedence — scan EVERY `--format` /
  // `--format=` occurrence (not just the first) so a later invalid
  // value isn't masked by an earlier valid one (codex r258 F1 fix).
  const invalid = findFirstInvalidFormat(argv);
  if (invalid) {
    return { ok: false, kind: "INVALID_FORMAT", rawValue: invalid.rawValue };
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

export type CrashContext = {
  phase: string | null;
  sub_state: string | null;
  feature: string | null;
  /** Phase 16 SC-6b — `session_id` is also captured by resolveSession
   *  and exposed here so the trace.jsonl finalize step has a single
   *  read site for derived state. Null if no session was resolved. */
  session_id: string | null;
  last_command: string;
};

export type LoadProjectionsFn = <K extends ProjectionKind>(opts: {
  feature_dir: string;
  kinds: readonly K[];
}) => Promise<LoadResult<K>>;

export type CommandContextDeps = {
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
  /** Phase 16 SC-6c: `loadSession` accepts an `ensureDir` option.
   *  Production wires `cli-runtime.ts` `loadSession` (which honors
   *  the option); tests inject synthetic loaders. */
  loadSession?: (featureDir: string, opts?: { ensureDir?: boolean }) => Promise<SessionLoad>;
  loadProjections?: LoadProjectionsFn;
  /** Phase 16 SC-8: per-call registry dir override. Production omits
   *  (registry-writer's defaultRegistryDir() honors LOAF_REGISTRY_DIR
   *  env). Tests inject a tmp dir for isolation. */
  registryDir?: string;
  /** ADR-0006 P0 — selected presentation locale. Production wires the
   *  resolved CLI i18n; tests may inject a tiny fake. */
  i18n?: I18n;
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

export type LazySuccessAdvisories = SuccessAdvisories | ((i18n: I18n) => SuccessAdvisories);

export type CommandContext = {
  readonly argv: readonly string[];
  readonly output: OutputMode;
  /** Phase 16 SC-5b1 — derived from `parsePresentation`. */
  readonly plain: boolean;
  readonly quiet: boolean;
  readonly verbose: number;
  readonly noColor: boolean;
  /** Phase 16 SC-6a — non-interactive mode. When true, `main()`'s
   *  `isInteractiveHumanForActor` helper downgrades the TTY-derived
   *  signal to false, forcing `resolveHumanActor` to refuse the
   *  git-config fallback (CI / skill / hook safety). Explicit
   *  `$LOAF_USER` is NOT affected. */
  readonly noInput: boolean;
  /** Phase 16 SC-6b — debug-trace mode. When true, `main()`'s finally
   *  block writes one `kind:"cli"` row to
   *  `<feature-dir>/trace.jsonl` IFF `traceTarget` was recorded by
   *  the action handler. See `recordTraceTarget`. Suppressed when
   *  `dryRun` is true (codex r275 P1). */
  readonly debug: boolean;
  /** Phase 16 SC-6c — dry-run mode. When true:
   *  - mutating commands pass `dryRun: true` into `MutateContext`,
   *    short-circuiting before sidecar promote + journal append +
   *    projection refresh.
   *  - read-only commands reject with DRY_RUN_NOT_APPLICABLE.
   *  - trace.jsonl write is suppressed (P1).
   *  - `ctx.resolveSession` passes `ensureDir: false` to skip the
   *    feature-dir mkdir side-effect (P6).
   */
  readonly dryRun: boolean;
  /** Phase 16 SC-6b — trace target set by action handlers via
   *  `recordTraceTarget`. `null` when no feature-addressed action
   *  fired (e.g. `loaf --version`, `loaf --help`, bare `loaf doctor`)
   *  or before the action body's top line ran. */
  readonly traceTarget: { feature: string; featureDir: string } | null;
  /** Phase 16 SC-8 — cached dispatch resolution. Called by feature-
   *  addressed action handlers at body top. Per-invocation cache;
   *  resolves the 5-level §10.3 precedence once + reuses on
   *  subsequent calls. */
  resolveDispatch: () => Promise<DispatchResult>;
  /** Phase 16 SC-8 — auto-pick advisory line writer (e.g.
   *  "auto-picked 'auth-refresh'"). Suppressed by `quiet`. Single
   *  source of truth for stderr advisory routing per codex r285
   *  P-impl-1. */
  advisory: (line: string) => void;
  /** Phase 16 SC-6b — called as the first line of each feature-
   *  addressed action body, BEFORE any action-internal validation.
   *  Idempotent; last call wins. Commander-level USAGE failures
   *  never reach the action callback and therefore never set this
   *  (no trace row written) — see docs/protocol.md §4.10. */
  recordTraceTarget: (feature: string, featureDir: string) => void;
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
    textRenderer?: (i18n: I18n) => string,
    advisories?: LazySuccessAdvisories,
  ) => void;
  failure: (code: string, message: string, detail?: Record<string, unknown>) => void;
  failureKeyed: (
    code: string,
    keyPath: string,
    vars: I18nVars,
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
  const i18n = deps.i18n ?? DEFAULT_I18N;
  const plain: boolean = presentation.ok ? presentation.plain : false;
  const quiet: boolean = presentation.ok ? presentation.quiet : false;
  const verbose: number = presentation.ok ? presentation.verbose : 0;
  const noColor: boolean = presentation.ok ? presentation.noColor : false;
  const noInput: boolean = presentation.ok ? presentation.noInput : false;
  const debug: boolean = presentation.ok ? presentation.debug : false;
  const dryRun: boolean = presentation.ok ? presentation.dryRun : false;
  let exitCode = 0;
  let traceTarget: { feature: string; featureDir: string } | null = null;

  // Caches: separate per resolution method per codex r206 PATCH D. Same
  // featureDir hitting both resolveSession and resolveProjections runs
  // both loaders once.
  const sessionCache = new Map<string, Promise<SessionLoad>>();
  const projectionCache = new Map<string, Promise<unknown>>();

  // Cached session for snapshotCrashContext — last resolved session
  // becomes the source for phase/sub_state in the crash log envelope.
  // SC-6b: also captures `session_id` for the trace.jsonl row.
  let lastResolvedSubState: string | null = null;
  let lastResolvedSessionId: string | null = null;
  // SC-8: per-invocation dispatch cache. Resolved once on first call;
  // reused on subsequent ctx.resolveDispatch() calls.
  let cachedDispatch: Promise<DispatchResult> | null = null;

  const ctx: CommandContext = {
    argv,
    output,
    plain,
    quiet,
    verbose,
    noColor,
    noInput,
    debug,
    dryRun,
    get traceTarget() {
      return traceTarget;
    },
    recordTraceTarget(feature: string, featureDir: string): void {
      traceTarget = { feature, featureDir };
    },
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
        throw new Error("CommandContext: loadSession dep not provided; cannot resolveSession");
      }
      // SC-6c: dry-run suppresses the mkdir side-effect by passing
      // `ensureDir: false` so a `loaf --dry-run start new-feature` does
      // not leave behind a `.loaf/new-feature/` directory (codex r275 P6
      // + r276 constraint 2 — ensureDir is derived from ctx.dryRun, not
      // a per-call option, so the cache key stays `featureDir`).
      const p = deps.loadSession(featureDir, { ensureDir: !dryRun }).then((sess) => {
        const sub = sess.snapshot.state?.sub_state ?? null;
        if (sub) lastResolvedSubState = sub;
        const sid = sess.snapshot.state?.session_id ?? null;
        if (sid) lastResolvedSessionId = sid;
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
        deps.writeStdout(textRenderer(i18n));
      }
      // Advisory stderr (channels B + C): mode-independent. Both text
      // and JSON modes emit advisories to stderr — pipe-safe per
      // protocol §10.2. Suppressed by --quiet per protocol §10.12.
      // SC-5b1 only `loaf start` passes advisories; SC-5b2 migrates
      // the remaining 40 sites.
      if (!quiet && advisories) {
        const renderedAdvisories = typeof advisories === "function" ? advisories(i18n) : advisories;
        if (renderedAdvisories.stateChange) {
          deps.writeStderr(renderedAdvisories.stateChange + "\n");
        }
        if (renderedAdvisories.next !== undefined) {
          const lines = Array.isArray(renderedAdvisories.next)
            ? renderedAdvisories.next
            : [renderedAdvisories.next];
          for (const line of lines) {
            deps.writeStderr(`next: ${line}\n`);
          }
        }
      }
    },

    failure(code, message, detail) {
      writeFailure(code, message, detail);
    },

    failureKeyed(code, keyPath, vars, detail) {
      const message = output === "json" ? DEFAULT_I18N.t(keyPath, vars) : i18n.t(keyPath, vars);
      writeFailure(code, message, detail);
    },

    snapshotCrashContext(): CrashContext {
      return {
        phase: phaseOf(lastResolvedSubState),
        sub_state: lastResolvedSubState,
        feature: extractFeature(argv),
        session_id: lastResolvedSessionId,
        last_command: [...argv].join(" "),
      };
    },

    async resolveDispatch() {
      if (cachedDispatch) return cachedDispatch;
      cachedDispatch = realResolveDispatch({
        argv,
        env: process.env,
        cwd: process.cwd(),
        ...(deps.registryDir !== undefined && { registryDir: deps.registryDir }),
      });
      return cachedDispatch;
    },

    advisory(line: string): void {
      if (quiet) return;
      deps.writeStderr(`loaf: ${line}\n`);
    },
  };

  function writeFailure(code: string, message: string, detail?: Record<string, unknown>): void {
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
      // Phase 16 SC-9c — schema validation issue list (codex r309 B1).
      // Renderer is generic but narrow to `{path?, code?, message?}` elements
      // emitted by `mapZodIssues` (src/cli/check-file.ts). JSON mode is
      // untouched — payload still rides one shared envelope line.
      const errors = detail?.["errors"];
      if (Array.isArray(errors)) {
        for (const e of errors as Array<{
          path?: string;
          code?: string;
          message?: string;
        }>) {
          deps.writeStderr(`  [${e.path ?? "?"}] ${e.code ?? "UNKNOWN"}: ${e.message ?? ""}\n`);
        }
        if (detail?.["truncated"] === true) {
          const total = detail?.["error_count"];
          deps.writeStderr(
            `  ... (${typeof total === "number" ? total : "?"} errors total; first ${errors.length} shown)\n`,
          );
        }
      }
    }
    exitCode = 2;
  }

  return ctx;
}
