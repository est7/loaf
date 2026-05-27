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

export type CommandContext = {
  readonly argv: readonly string[];
  readonly output: OutputMode;
  exitCode: number;
  resolveSession: (featureDir: string) => Promise<SessionLoad>;
  resolveProjections: <K extends ProjectionKind>(
    featureDir: string,
    kinds: readonly K[],
  ) => Promise<LoadResult<K>>;
  /** `textRenderer` is **required** when the command emits text — it's
   *  optional only because JSON mode lazily skips it. In text mode an
   *  omitted renderer throws (codex r208 PATCH 1: no silent JSON
   *  fallback for migrated commands). */
  success: (payload: object, textRenderer?: () => string) => void;
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
  // SC-5a: format derivation goes through the shared `parseFormatFromArgv`
  // helper so the pre-parse guard in cli.tsx main() and CommandContext
  // never disagree on output mode. On parse failure here we fall back to
  // "text" silently; main()'s pre-parse guard is the canonical rejector
  // and is responsible for emitting INVALID_FORMAT + short-circuiting
  // before this code path runs.
  const parsed = parseFormatFromArgv(argv);
  const output: OutputMode = parsed.ok ? parsed.format : "text";
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

    success(payload, textRenderer) {
      if (output === "json") {
        deps.writeStdout(JSON.stringify(payload) + "\n");
        return;
      }
      if (!textRenderer) {
        // Codex r208 PATCH 1: no silent JSON fallback in text mode. A
        // future migration that omits the renderer would silently change
        // the line-oriented text contract. Fail fast so the bug surfaces
        // in tests instead of in production.
        throw new Error(
          "ctx.success: text renderer required in text mode (a migrated command must always pass a text renderer; JSON mode skips it lazily)",
        );
      }
      deps.writeStdout(textRenderer());
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
