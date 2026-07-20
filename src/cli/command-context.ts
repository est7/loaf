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
import { SnapshotStaleError, NoSessionError } from "../core/projection-loader.js";
import type { SessionLoad } from "../core/cli-runtime.js";
import { getGitEmail } from "../core/cli-runtime.js";
import { DEFAULT_I18N, type I18n } from "./i18n.js";
import {
  resolveDispatch as realResolveDispatch,
  type DispatchResult,
} from "../core/session-dispatch.js";
import { resolveHumanActor } from "../core/actor-resolver.js";
import { parseHookStdinPath } from "../core/write-guard.js";
import {
  diagnosticKey,
  FAILURE_SITE_KEYS,
  type MigratedDiagnosticCode,
  type FailureSiteKey,
} from "./runtime-i18n-keys.js";
import { diagnosticVarsFor } from "./diagnostic-failure.js";
import {
  FORMAT_MODES as ARGV_FORMAT_MODES,
  FORMAT_MODES_HUMAN as ARGV_FORMAT_MODES_HUMAN,
  findFirstInvalidFormat as parseFindFirstInvalidFormat,
  parseDebugFromArgv as parseArgvDebug,
  parseDryRunFromArgv as parseArgvDryRun,
  parseFormatFromArgv as parseArgvFormat,
  parseNoColorFromArgv as parseArgvNoColor,
  parseNoInputFromArgv as parseArgvNoInput,
  parsePlainFromArgv as parseArgvPlain,
  parsePresentation as parseArgvPresentation,
  parseQuietFromArgv as parseArgvQuiet,
  parseVerboseFromArgv as parseArgvVerbose,
  type FormatParseResult as ArgvFormatParseResult,
  type OutputMode as ArgvOutputMode,
  type PresentationEnv,
  type PresentationFail as ArgvPresentationFail,
  type PresentationOk as ArgvPresentationOk,
  type PresentationResult as ArgvPresentationResult,
} from "./argv-presentation.js";
// Note: diagnostic-failure.ts intentionally does NOT import from command-context.ts
// to avoid a circular dependency. Its local I18nVars is structurally identical.

export type OutputMode = ArgvOutputMode;
export type I18nVars = Record<string, string | number | boolean | null | undefined>;

export const FORMAT_MODES: readonly OutputMode[] = ARGV_FORMAT_MODES;
export const FORMAT_MODES_HUMAN: string = ARGV_FORMAT_MODES_HUMAN;

export type FormatParseResult = ArgvFormatParseResult;
export type PresentationOk = ArgvPresentationOk;
export type PresentationFail = ArgvPresentationFail;
export type PresentationResult = ArgvPresentationResult;

/** Compatibility facade for existing command-context import sites. */
export function parseFormatFromArgv(argv: readonly string[]): FormatParseResult {
  return parseArgvFormat(argv);
}

export function findFirstInvalidFormat(argv: readonly string[]): { rawValue: string } | null {
  return parseFindFirstInvalidFormat(argv);
}

export function parsePlainFromArgv(argv: readonly string[]): boolean {
  return parseArgvPlain(argv);
}

export function parseQuietFromArgv(argv: readonly string[]): boolean {
  return parseArgvQuiet(argv);
}

export function parseNoInputFromArgv(argv: readonly string[]): boolean {
  return parseArgvNoInput(argv);
}

export function parseDebugFromArgv(
  argv: readonly string[],
  env: Pick<PresentationEnv, "LOAF_DEBUG" | "DEBUG"> = process.env,
): boolean {
  return parseArgvDebug(argv, env);
}

export function parseDryRunFromArgv(argv: readonly string[]): boolean {
  return parseArgvDryRun(argv);
}

export function parseVerboseFromArgv(argv: readonly string[]): number {
  return parseArgvVerbose(argv);
}

export function parseNoColorFromArgv(
  argv: readonly string[],
  env: Pick<PresentationEnv, "NO_COLOR" | "LOAF_NO_COLOR" | "TERM"> = process.env,
): boolean {
  return parseArgvNoColor(argv, env);
}

export function parsePresentation(
  argv: readonly string[],
  env: PresentationEnv = process.env,
): PresentationResult {
  return parseArgvPresentation(argv, env);
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
  /** Phase W8 0a — injectable git-config reader for resolveHumanActorOrFail.
   *  Production omits (defaults to getGitEmail); tests inject canned values. */
  readGitConfig?: () => string | null;
  /** Phase W8 0a — injectable TTY check for resolveHumanActorOrFail.
   *  Production omits (defaults to process.stdin.isTTY === true). */
  isInteractiveHuman?: () => boolean;
  /** Phase W8 0a — injectable stdin reader for resolveHookPath.
   *  Production omits (defaults to reading process.stdin). */
  readStdin?: () => Promise<string>;
  /** Phase W8 0a — injectable stdin TTY check for resolveHookPath.
   *  Production omits (defaults to process.stdin.isTTY === true). */
  isStdinTty?: () => boolean;
  /** Phase W8 0a — injectable projection loader for loadProjectionsOrFail.
   *  When absent, ctx.loadProjectionsOrFail throws. Tests may inject a
   *  loader that doesn't require real FS. */
  loadProjectionsDirect?: <K extends ProjectionKind>(opts: {
    feature_dir: string;
    kinds: readonly K[];
  }) => Promise<LoadResult<K>>;
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
  /** Phase W8 0a — try keyed-failure first, fall back to plain failure.
   *  Returns the resolved actor string on success; null on failure (already
   *  emitted). */
  fail: (code: string, message: string) => void;
  /** Phase W8 0a — try keyed-failure first, fall back to plain failure.
   *  Mirrors the old bare `emitFailure` closure in main(). */
  emitFailure: (code: string, message: string, detail?: Record<string, unknown>) => void;
  /** Phase W8 0a — emit a NO_SESSION failure keyed to a site-specific key. */
  emitNoSessionFailure: (
    keyPath: FailureSiteKey,
    feature: string,
    detail?: Record<string, unknown>,
  ) => void;
  /** Phase W8 0a — resolve the human actor or emit failure + return null. */
  resolveHumanActorOrFail: () => string | null;
  /** Phase W8 0a — resolve dispatch or emit failure + return null. */
  dispatchOrFail: (opts: { feature?: string; featureDir?: string }) => Promise<string | null>;
  /** Phase W8 0a — hook-optional dispatch (absence = silent skip). */
  dispatchForHookOptional: (opts: {
    feature?: string;
    featureDir?: string;
  }) => Promise<
    { featureDir: string } | { skip: true; stale?: { code: string; message: string } }
  >;
  /** Phase W8 0a — resolve the path for a write-side hook or return null. */
  resolveHookPath: (opts: { path?: string }) => Promise<string | null>;
  /** Phase W8 0a — fail-closed dispatch for write-guard. */
  resolveDispatchForWriteGuard: (opts: {
    feature?: string;
    featureDir?: string;
  }) => Promise<
    | { featureDir: string }
    | { allow: true }
    | { failClosed: true; code: string; message: string }
  >;
  /** Phase W8 0a — reject if dry-run (read-only / wrapping / etc.). */
  rejectIfDryRun: (
    command: string,
    commandType?: "read-only" | "wrapping" | "projection-writer" | "scaffold-writer",
  ) => boolean;
  /** Phase W8 0a — load projections or emit failure + return null. */
  loadProjectionsOrFail: <K extends ProjectionKind>(
    featureDir: string,
    kinds: readonly K[],
    feature: string,
    noSessionKey: FailureSiteKey,
  ) => Promise<LoadResult<K> | null>;
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
  const presentation = parsePresentation(argv, process.env);
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

    fail(code: string, message: string): void {
      if (!emitKeyedFailure(code, undefined)) {
        writeFailure(code, message);
      }
    },

    emitFailure(code: string, message: string, detail?: Record<string, unknown>): void {
      if (!emitKeyedFailure(code, detail)) {
        writeFailure(code, message, detail);
      }
    },

    emitNoSessionFailure(
      keyPath: FailureSiteKey,
      feature: string,
      detail?: Record<string, unknown>,
    ): void {
      ctx.failureKeyed("NO_SESSION", keyPath, { feature }, detail);
    },

    resolveHumanActorOrFail(): string | null {
      const isInteractive =
        (deps.isInteractiveHuman?.() ?? process.stdin.isTTY === true) && !noInput;
      const readGitConfig = deps.readGitConfig ?? getGitEmail;
      const r = resolveHumanActor({
        env: process.env,
        readGitConfig,
        isInteractiveHuman: isInteractive,
      });
      if (!r.ok) {
        ctx.emitFailure(r.code, r.message);
        return null;
      }
      return r.actor;
    },

    async dispatchOrFail(opts: { feature?: string; featureDir?: string }): Promise<string | null> {
      const dispatch = await ctx.resolveDispatch();
      if (!dispatch.ok) {
        ctx.emitFailure(dispatch.code, dispatch.message, dispatch.detail);
        return null;
      }
      if (dispatch.autoPickAdvisory) ctx.advisory(dispatch.autoPickAdvisory);
      opts.feature = dispatch.feature;
      opts.featureDir = dispatch.featureDir;
      ctx.recordTraceTarget(dispatch.feature, dispatch.featureDir);
      return dispatch.featureDir;
    },

    async dispatchForHookOptional(opts: {
      feature?: string;
      featureDir?: string;
    }): Promise<
      { featureDir: string } | { skip: true; stale?: { code: string; message: string } }
    > {
      let dispatch: Awaited<ReturnType<typeof ctx.resolveDispatch>>;
      try {
        dispatch = await ctx.resolveDispatch();
      } catch {
        return { skip: true };
      }
      if (dispatch.ok) {
        opts.feature = dispatch.feature;
        opts.featureDir = dispatch.featureDir;
        ctx.recordTraceTarget(dispatch.feature, dispatch.featureDir);
        return { featureDir: dispatch.featureDir };
      }
      if (dispatch.code === "SNAPSHOT_STALE_REBUILD_REQUIRED") {
        return { skip: true, stale: { code: dispatch.code, message: dispatch.message } };
      }
      return { skip: true };
    },

    async resolveHookPath(opts: { path?: string }): Promise<string | null> {
      if (opts.path !== undefined && opts.path.length > 0) return opts.path;
      const isStdinTty = deps.isStdinTty ?? ((): boolean => process.stdin.isTTY === true);
      if (!isStdinTty()) {
        const readStdin = deps.readStdin;
        if (!readStdin) {
          throw new Error(
            "CommandContext: readStdin dep not provided; cannot resolveHookPath from stdin",
          );
        }
        const raw = await readStdin();
        const parsed = parseHookStdinPath(raw);
        if (!parsed.ok) {
          ctx.failureKeyed(
            "SCHEMA_VALIDATION_FAILED",
            FAILURE_SITE_KEYS.hookStdinParseFailed,
            { reason: parsed.reason },
            { source: "hook-stdin" },
          );
          return null;
        }
        return parsed.path;
      }
      ctx.failureKeyed("USAGE", FAILURE_SITE_KEYS.hookWritePathMissing, {}, {});
      return null;
    },

    async resolveDispatchForWriteGuard(opts: {
      feature?: string;
      featureDir?: string;
    }): Promise<
      | { featureDir: string }
      | { allow: true }
      | { failClosed: true; code: string; message: string }
    > {
      let dispatch: Awaited<ReturnType<typeof ctx.resolveDispatch>>;
      try {
        dispatch = await ctx.resolveDispatch();
      } catch (err) {
        return {
          failClosed: true,
          code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
          message: `write-guard cannot resolve the session: ${(err as Error).message}`,
        };
      }
      if (dispatch.ok) {
        opts.feature = dispatch.feature;
        opts.featureDir = dispatch.featureDir;
        ctx.recordTraceTarget(dispatch.feature, dispatch.featureDir);
        return { featureDir: dispatch.featureDir };
      }
      if (dispatch.code === "FEATURE_NOT_FOUND") return { allow: true };
      return { failClosed: true, code: dispatch.code, message: dispatch.message };
    },

    rejectIfDryRun(
      command: string,
      commandType: "read-only" | "wrapping" | "projection-writer" | "scaffold-writer" = "read-only",
    ): boolean {
      if (dryRun) {
        ctx.emitFailure(
          "DRY_RUN_NOT_APPLICABLE",
          `--dry-run not applicable to ${commandType} command \`${command}\``,
          { command, command_type: commandType },
        );
        return true;
      }
      return false;
    },

    async loadProjectionsOrFail<K extends ProjectionKind>(
      featureDir: string,
      kinds: readonly K[],
      feature: string,
      noSessionKey: FailureSiteKey,
    ): Promise<LoadResult<K> | null> {
      const loader = deps.loadProjectionsDirect ?? deps.loadProjections;
      if (!loader) {
        throw new Error(
          "CommandContext: loadProjections dep not provided; cannot loadProjectionsOrFail",
        );
      }
      try {
        return await loader({ feature_dir: featureDir, kinds });
      } catch (err) {
        if (err instanceof NoSessionError) {
          ctx.emitNoSessionFailure(noSessionKey, feature, err.detail);
          return null;
        }
        if (err instanceof SnapshotStaleError) {
          ctx.emitFailure(
            err.code,
            `snapshot stale (reason=${err.reason}) — run \`loaf doctor --rebuild --feature ${feature}\` to re-serialize from journal truth`,
            err.detail,
          );
          return null;
        }
        throw err;
      }
    },
  };

  // Private helper: attempt keyed failure (try to map code → i18n vars).
  // Returns true if keyed failure was emitted, false if caller must fall back.
  function emitKeyedFailure(code: string, detail: Record<string, unknown> | undefined): boolean {
    const vars = diagnosticVarsFor(code, detail);
    if (vars === null) return false;
    ctx.failureKeyed(code, diagnosticKey(code as MigratedDiagnosticCode), vars, detail);
    return true;
  }

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
