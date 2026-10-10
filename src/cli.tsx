#!/usr/bin/env node
import { createCommandProgram, createPolicyCommandProgram } from "./cli/command-program.js";
import { evaluateCommandPreparse, renderHookEvents } from "./cli/command-policy.js";
import { CommandPolicyComplete } from "./cli/command-action-policy.js";
import { scanArgv } from "./core/argv-scanner.js";
import { diagnostic } from "./core/error-catalog.js";
import { writeDiagnosticFailure } from "./cli/diagnostic-failure.js";

// loaf CLI — audit r1 Blocker #7 (MVP).
//
// Currently exposes the three minimum-viable lifecycle commands that
// demonstrate the protocol surface end-to-end:
//
//   loaf start <feature> --ceremony <preset>  → session:started entry
//   loaf advance <to>                         → event:phase_advanced entry
//   loaf status                               → read-only snapshot dump
//
// Full surface (spec / tasks / evidence / gate / settle / deliver / archive /
// abandon / doctor) follows the same pattern: parse args → loadSession →
// build entry payload → mutate → format output. They are scaffolded as
// follow-up work in a companion PR per the audit r1 punch list.

import { CommanderError } from "commander";
import os from "node:os";
import packageJson from "../package.json" with { type: "json" };

import { UNEXPECTED_ERROR, writeCrashLog } from "./core/crash-log.js";
import { createCommandContext, parsePresentation, FORMAT_MODES } from "./cli/command-context.js";
import { buildTraceEntry, defaultAppendTraceLine, type TraceEntry } from "./cli/trace-writer.js";
import { type RenderTui } from "./cli/tui/render.js";
import { readUserConfig } from "./core/user-config.js";
import { BUILTIN_BUNDLES, createI18n, resolveLocale } from "./cli/i18n.js";
import { type RunEditor } from "./cli/run-editor.js";
import { buildReportUrl } from "./cli/url-prefill.js";
import { defaultReadStdin, defaultIsStdinTty } from "./cli/stdin.js";
import { createJsonInputIngestor } from "./cli/input-ingestion.js";

import { LOAF_DOCS_URL, LOAF_ISSUE_URL, loadSession } from "./core/cli-runtime.js";
import { type MutateContext } from "./core/journal-mutate.js";
import { createCommandMutator } from "./cli/command-mutator.js";
import { loadProjections } from "./core/projection-loader.js";

import { releaseFeatureWriteLeasesForSignalSync } from "./core/feature-write-lease.js";
import type { OpenUrl } from "./cli/board/open-url.js";

// Phase 16 SC-2 — SIGINT handler (protocol §10.9 exit 130).
//
// Module-scope `_sigintInstalled` + DI-shaped factory `installSigintHandler`
// per codex r196 PATCH C. Two contracts:
//   - Idempotent install: each `main()` call could re-install otherwise,
//     and vitest invokes `main` many times in a single process. A growing
//     listener list eventually triggers MaxListenersExceededWarning.
//   - Injectable deps: makes the 130-exit + "interrupted (SIGINT)" stderr
//     unit-testable without timing-based child-process plumbing.
// `installSigintHandler` returns the handler closure so callers (chiefly
// the unit test) can invoke it directly without waiting for an actual
// signal.
export type SigintHandlerDeps = {
  writeStderr: (s: string) => void;
  exit: (code: number) => void;
};

let _sigintInstalled = false;

export function installSigintHandler(deps: SigintHandlerDeps): () => void {
  const handler = (): void => {
    releaseFeatureWriteLeasesForSignalSync();
    deps.writeStderr("\nloaf: interrupted (SIGINT)\n");
    deps.exit(130);
  };
  if (_sigintInstalled) return handler;
  _sigintInstalled = true;
  process.on("SIGINT", handler);
  return handler;
}

// Phase 16 SC-4a — main() gains an optional presentation-layer deps bag
// per codex r212 PATCH 1 so tests can inject stdin / TTY semantics
// without monkey-patching process.stdin globally. Production wires real
// implementations; tests pass `{ readStdin: async () => "...", isStdinTty: () => true }`.
export type MainDeps = {
  readStdin?: () => Promise<string>;
  isStdinTty?: () => boolean;
  // Phase 16 SC-6a — test-injectable actor-resolution primitives. Both
  // default to the production sources at the 6 human-actor sites
  // (`process.stdin.isTTY === true` and `getGitEmail`); tests inject
  // synthetic values so the `--no-input` TTY-downgrade contract can be
  // asserted deterministically (Vitest runs with non-interactive stdin,
  // so the inline literal defaults would not differentiate with-vs-
  // without `--no-input`).
  isInteractiveHuman?: () => boolean;
  readGitConfig?: () => string | null;
  // Phase 16 SC-6b — test-injectable trace-writer primitives. Production
  // omits all three; defaults wire `defaultAppendTraceLine`, `new Date()`,
  // and `performance.now()`. Tests inject throwing `appendTraceLine` to
  // assert write-failure does NOT flip exit code (T22), and inject canned
  // `now` / `monotonicNow` to assert deterministic `at` / `wall_ms`.
  appendTraceLine?: (featureDir: string, entry: TraceEntry) => Promise<void>;
  now?: () => Date;
  monotonicNow?: () => number;
  // Phase 16 SC-7 — test-injectable registry-writer primitives. Production
  // omits all three; defaults to `~/.loaf/registry/` + `new Date()` +
  // `process.cwd()`. CLI e2e tests inject a tmp dir to avoid touching the
  // real user registry (codex r280 P5). Threaded through every
  // MutateContext literal in cli.tsx via the `registryWriter` field.
  registryDir?: string;
  registryNow?: () => Date;
  registryCwd?: () => string;
  // Ticket #11 SC3 — explicit machine-local hook runtime root. Production
  // defaults to ~/.loaf/runtime; hook tests inject a temp root.
  runtimeDir?: string;
  /** EXECUTE closure commit-boundary instrumentation/fault injection. */
  executeClosureHooks?: import("./core/execute-closure.js").ExecuteClosureHooks;
  // Phase 16 SC-12a-2 — test-injectable editor runner for `loaf spec
  // edit`. Production omits (defaults to runEditor from
  // ./cli/run-editor.js which spawns $EDITOR or vi). Tests inject
  // deterministic stubs to assert the work-copy / no-op / signal split
  // semantics without spawning a real editor (codex r331 P3).
  runEditor?: RunEditor;
  // Test-injectable stdout TTY suitability check for interactive surfaces
  // (`loaf tui` and the editor lane of `loaf spec edit`). Defaults to
  // `() => process.stdout.isTTY === true`.
  // Kept separate from isInteractiveHuman (which is actor / no-input
  // semantics per SC-6a) per codex r355 ack 1.
  isStdoutTty?: () => boolean;
  // Phase 16 SC-14 — test-injectable Ink render hook. Defaults to a
  // dynamic-import wrapper around Ink's render() + waitUntilExit().
  // Tests inject a stub that asserts the App was constructed with the
  // right rows then resolves immediately (codex r355 Q3 / r356 ack 2).
  renderTui?: RenderTui;
  // ADR-0006 P0 — test-injectable home for ~/.loaf/config.json so
  // locale config tests never touch a real user's home directory.
  userConfigHomeDir?: string;
  // `loaf board` seams. Production opens the browser via platform tools and
  // keeps the server process alive until SIGINT; tests inject no-op functions
  // so the command stays deterministic.
  openUrl?: OpenUrl;
  boardKeepAlive?: (url: string) => Promise<void>;
};

function preparseI18nFromEnv(
  env: Record<string, string | undefined>,
): ReturnType<typeof createI18n> {
  const explicit = env["LOAF_LANG"];
  if (explicit === "zh" || explicit === "en") {
    return createI18n(explicit, BUILTIN_BUNDLES);
  }
  const ambient = env["LC_ALL"] ?? env["LC_MESSAGES"] ?? env["LANG"];
  const normalized = ambient?.toLowerCase();
  if (normalized?.startsWith("zh")) return createI18n("zh", BUILTIN_BUNDLES);
  return createI18n("en", BUILTIN_BUNDLES);
}

function detectRenderAsJson(argv: string[]): boolean {
  // Preserve the pre-existing argv.indexOf(a) first-match behavior; changing duplicate --format handling is behavioral.
  return argv.some(
    (a) => a === "--format=json" || (a === "--format" && argv[argv.indexOf(a) + 1] === "json"),
  );
}

export async function main(argv: string[] = process.argv, deps: MainDeps = {}): Promise<number> {
  // Phase 16 SC-5a/SC-5b1 — pre-parse presentation guard.
  //
  // Runs BEFORE Commander setup, BEFORE actor/env init, BEFORE
  // `program.parseAsync(argv)`. On invalid `--format <value>` or
  // a multi-flag mutex (e.g. `--plain --format=json`), emits a typed
  // diagnostic to stderr and returns exit 2 — no Commander parse,
  // no action, no deps invocation.
  //
  // Precedence: INVALID_FORMAT > MUTUALLY_EXCLUSIVE_FLAGS (no canonical
  // conflict computable from an invalid value).
  //
  // Mutex render shape: JSON body iff any valid `--format json` /
  // `--format=json` appears in argv (renderAsJson). Otherwise text.
  //
  // Bypass on `--help` / `-h` / `--version` / `-V` so e.g.
  // `loaf --help --format yaml` still prints help (Commander owns
  // help/version output).
  //
  // Tests: tests/cli/format-flag.test.ts + tests/cli/presentation-flags.test.ts.
  const wantsHelpOrVersion = argv.some(
    (a) => a === "--help" || a === "-h" || a === "--version" || a === "-V",
  );
  if (!wantsHelpOrVersion) {
    const presentation = parsePresentation(argv);
    if (!presentation.ok) {
      if (presentation.kind === "INVALID_FORMAT") {
        // Text-mode emit only: no output mode established yet.
        writeDiagnosticFailure(
          diagnostic("INVALID_FORMAT", {
            value: presentation.rawValue,
            allowed_values: FORMAT_MODES,
          }),
          {
            format: false ? "json" : "text",
            i18n: preparseI18nFromEnv(process.env),
            writeStderr: (line) => process.stderr.write(line),
          },
        );
      } else {
        // MUTUALLY_EXCLUSIVE_FLAGS. renderAsJson honors protocol §10.7
        // scripting promise: any --format=json present → JSON body.
        const { conflicting, renderAsJson } = presentation;
        writeDiagnosticFailure(diagnostic("MUTUALLY_EXCLUSIVE_FLAGS", { conflicting }), {
          format: renderAsJson ? "json" : "text",
          i18n: preparseI18nFromEnv(process.env),
          writeStderr: (line) => process.stderr.write(line),
        });
      }
      return 2;
    }
  }

  if (!wantsHelpOrVersion) {
    const policy = evaluateCommandPreparse(createPolicyCommandProgram(), argv, process.env);
    if (policy.kind === "failure") {
      writeDiagnosticFailure(policy.diagnostic, {
        format: detectRenderAsJson(argv) ? "json" : "text",
        i18n: preparseI18nFromEnv(process.env),
        writeStderr: (line) => process.stderr.write(line),
      });
      return 2;
    }
    if (policy.kind === "hook-events") {
      process.stdout.write(renderHookEvents(detectRenderAsJson(argv)));
      return 0;
    }
  }

  const userConfigLoad = await readUserConfig(deps.userConfigHomeDir ?? os.homedir());
  const localeResolution = resolveLocale({
    // ADR-0006 defines --lang as the highest-precedence future flag.
    // P0 keeps the live CLI surface unchanged, so runtime wiring does
    // not consume argv --lang yet; pure resolver tests cover the future
    // precedence slot.
    argv: [],
    env: process.env,
    userConfig:
      userConfigLoad.status === "ok"
        ? { status: "ok", locale: userConfigLoad.config.locale.default_lang }
        : userConfigLoad,
    // ADR-0006: project locale fallback is deferred until dispatch/root
    // is known. P0 wires user/env/ambient only; resolver supports
    // projectConfig for the future root-aware call site.
  });
  if (!localeResolution.ok) {
    const presentation = parsePresentation(argv);
    const renderAsJson = presentation.ok && presentation.format === "json";
    writeDiagnosticFailure(localeResolution, {
      format: renderAsJson ? "json" : "text",
      i18n: preparseI18nFromEnv(process.env),
      writeStderr: (line) => process.stderr.write(line),
    });
    return 2;
  }
  const i18n = createI18n(localeResolution.locale, BUILTIN_BUNDLES);

  const readStdin = deps.readStdin ?? defaultReadStdin;
  const isStdinTty = deps.isStdinTty ?? defaultIsStdinTty;
  const input = createJsonInputIngestor({ readStdin, isStdinTty });
  // SC-6b — trace-writer DI seams. Production defaults wire the real
  // append + clocks; tests inject canned values (deterministic `at` /
  // `wall_ms`) or throwing append (assert write-failure does NOT flip
  // exit code).
  const appendTraceLine = deps.appendTraceLine ?? defaultAppendTraceLine;
  const now = deps.now ?? ((): Date => new Date());
  const monotonicNow = deps.monotonicNow ?? ((): number => performance.now());
  // Always-on stdout capture (capped) so the trace.jsonl `stdout_summary`
  // field can be populated lazily in the finally block. Capacity is
  // 16× the 256-char summary slice — JS string length is UTF-16 code
  // units; cap is approximate for non-ASCII (over-cap drops more than
  // 256 chars of summary, fine for debug observability).
  const STDOUT_CAPTURE_CHAR_CAP = 4096;
  const stdoutCapture: string[] = [];
  let stdoutCaptureChars = 0;
  const writeStdoutCaptured = (s: string): void => {
    if (stdoutCaptureChars < STDOUT_CAPTURE_CHAR_CAP) {
      stdoutCapture.push(s.slice(0, STDOUT_CAPTURE_CHAR_CAP - stdoutCaptureChars));
      stdoutCaptureChars += s.length;
    }
    process.stdout.write(s);
  };
  // SC-5a: actor init now lives BELOW the pre-parse guard (r243 P2) —
  // an invalid `--format` must reject before any env reads.
  const actor = `cli:loaf@${process.env["USER"] ?? "unknown"}`;

  // Phase 16 SC-3 — CommandContext is the presentation-layer plumbing
  // that owns output channel + lazy session/projection cache + failure
  // routing + crash-log context snapshot. Phase W8 0a folds the former
  // CommandContext owns the single catalog failure API and success presentation.
  // Former main() helper cluster (
  // resolveHumanActorOrFail / dispatchOrFail / dispatchForHookOptional /
  // resolveHookPath / resolveDispatchForWriteGuard /
  // loadProjectionsOrFail) into ctx methods.
  const ctx = createCommandContext(argv, {
    writeStdout: writeStdoutCaptured,
    writeStderr: (s) => process.stderr.write(s),
    loadSession,
    loadProjections,
    loadProjectionsDirect: loadProjections,
    i18n,
    // Phase W8 0a: actor-resolution injection points (formerly isInteractiveHumanForActor
    // / readGitConfigForActor in main() helper cluster).
    ...(deps.isInteractiveHuman !== undefined && {
      isInteractiveHuman: deps.isInteractiveHuman,
    }),
    ...(deps.readGitConfig !== undefined && {
      readGitConfig: deps.readGitConfig,
    }),
    // Phase W8 0a: hook-path stdin injection points. Pass the RESOLVED locals
    // (deps.* ?? production default, lines 631-632) — NOT the conditional
    // `deps.readStdin` spread. ctx.resolveHookPath has no internal readStdin
    // default and throws when it is absent; the pre-split `resolveHookPath`
    // closed over `deps.readStdin ?? defaultReadStdin`, so production must keep
    // receiving the default reader (codex W8 BLOCK: `loaf hook scope-track`
    // piped-stdin regression).
    readStdin,
    isStdinTty,
    // Phase 16 SC-8: thread MainDeps.registryDir through to the
    // CommandContext so ctx.resolveDispatch() uses the tmp dir in
    // CLI e2e tests. Production omits → defaultRegistryDir() honors
    // LOAF_REGISTRY_DIR env (set by vitest setup file).
    ...(deps.registryDir !== undefined && { registryDir: deps.registryDir }),
  });

  // Phase 16 SC-7 — registry-writer DI bundle for MutateContext literals.
  // Built once at main() entry; threaded into every mutate ctx so the
  // CLI never reaches into ~/.loaf/registry/ when a test injects an
  // override (codex r280 P5). `undefined` when no override given so
  // production stays on the defaults inside the writer module.
  const registryWriterDeps: MutateContext["registryWriter"] | undefined =
    deps.registryDir !== undefined ||
    deps.registryNow !== undefined ||
    deps.registryCwd !== undefined
      ? {
          ...(deps.registryDir !== undefined && {
            registryDir: deps.registryDir,
          }),
          ...(deps.registryNow !== undefined && { now: deps.registryNow }),
          ...(deps.registryCwd !== undefined && { cwd: deps.registryCwd }),
        }
      : undefined;

  // CommandMutator is the CLI's sole journal-mutation adapter.
  const mutator = createCommandMutator(ctx, {
    registryWriter: registryWriterDeps,
  });

  const program = createCommandProgram(ctx, mutator, input, i18n, actor, deps, isStdinTty, now);

  // SC-6b — monotonic clock for `wall_ms`. Captured before parseAsync
  // so a Commander-internal throw + the unhandled-error branch both
  // see the same baseline.
  const t0 = monotonicNow();
  let resolvedExit: number = 0;
  try {
    try {
      await program.parseAsync(argv);
      resolvedExit = ctx.exitCode;
      return ctx.exitCode;
    } catch (err) {
      if (err instanceof CommandPolicyComplete) {
        resolvedExit = ctx.exitCode;
        return resolvedExit;
      }
      if (err instanceof CommanderError) {
        if (err.exitCode === 0) {
          resolvedExit = 0;
          return 0;
        }
        ctx.failure(diagnostic("USAGE", { parser_code: err.code, reason: err.message }));
        resolvedExit = ctx.exitCode;
        return resolvedExit;
      }
      // Phase 16 SC-2/SC-3 — unhandled error boundary (protocol §10.5 / §10.9).
      // Any non-Commander error reaching here is "Error escaped the action
      // handler" (codex r196 PATCH A wording): the discriminator is escape,
      // not whether exitCode was set. Crash log + UNEXPECTED_ERROR sentinel
      // + exit 1. SC-3 enriches the envelope with phase/sub_state from the
      // ctx cache (NO journal load inside catch — codex r196 PATCH B) and
      // includes a prefilled report URL (sanitized last_command per codex
      // r206 PATCH H) on both stderr and the JSON sentinel.
      const error = err instanceof Error ? err : new Error(String(err));
      const crashContext = ctx.snapshotCrashContext();
      const crashLog = await writeCrashLog({
        argv,
        cwd: process.cwd(),
        version: packageJson.version,
        error,
        context: {
          phase: crashContext.phase,
          sub_state: crashContext.sub_state,
        },
      });
      const reportUrl = buildReportUrl({
        base: LOAF_ISSUE_URL,
        loaf_version: packageJson.version,
        schema_version: "2",
        phase: crashContext.phase,
        sub_state: crashContext.sub_state,
        argv,
        crash_log_path: crashLog,
      });
      if (ctx.output === "json") {
        const payload: Record<string, unknown> = {
          ok: false,
          code: UNEXPECTED_ERROR,
          message: "unexpected internal error",
          report_url: reportUrl,
        };
        if (crashLog !== null) payload["crash_log"] = crashLog;
        process.stderr.write(JSON.stringify(payload) + "\n");
      } else {
        process.stderr.write(`error: ${UNEXPECTED_ERROR} — ${error.message}\n`);
        if (crashLog !== null) {
          process.stderr.write(`  crash log: ${crashLog}\n`);
        }
        process.stderr.write(`  report at ${reportUrl}\n`);
      }
      resolvedExit = 1;
      return 1;
    }
  } finally {
    // SC-6b — trace.jsonl write happens here. Best-effort, silent on
    // failure (observability must not poison exit code). Skipped when
    // `ctx.debug` is false OR no action handler recorded a feature
    // target (e.g. Commander USAGE failures, `loaf --help`, bare
    // `loaf doctor`). See docs/protocol.md §4.10.
    //
    // SC-6c — also skipped when `ctx.dryRun` is true. Per §10.7
    // invariant, dry-run persists NO `.loaf/<feature>/*` state, and
    // trace.jsonl lives under that path (codex r275 P1 / r276 P1).
    if (ctx.debug && ctx.traceTarget && !ctx.dryRun) {
      try {
        const wallMs = Math.round(monotonicNow() - t0);
        const crashContext = ctx.snapshotCrashContext();
        const entry = buildTraceEntry({
          now: now(),
          feature: ctx.traceTarget.feature,
          sessionId: crashContext.session_id,
          subState: crashContext.sub_state,
          cmd: deriveCmdFromArgv(argv),
          // Strip launcher tokens (`node` + `loaf`) so the trace entry's
          // argv matches §4.10's documented shape and doesn't duplicate
          // the chain already carried by `cmd`. Codex r272 contract
          // drift fix.
          argv: argv.slice(2),
          exit: resolvedExit,
          wallMs,
          rawStdout: stdoutCapture.join(""),
          outputMode: ctx.output,
        });
        await appendTraceLine(ctx.traceTarget.featureDir, entry);
      } catch {
        // Silent best-effort — Debug-trace is non-authoritative per §13.1.
      }
    }
  }
}

/** Derive `cmd` (subcommand chain) from argv for trace.jsonl. Walks
 *  argv[2:], collects up to 3 leading non-flag tokens, stopping at
 *  the first `--<flag>` token. Catches `loaf advance EXECUTE.done`,
 *  `loaf start auth-refresh`, and 3-level chains like `loaf tasks
 *  step start`. Flag values (e.g. `standard` after `--ceremony`)
 *  are excluded because the walk stops at the first `--<flag>`. */
function deriveCmdFromArgv(argv: readonly string[]): string {
  const chain: string[] = [];
  for (const token of scanArgv(argv).slice(2)) {
    if (token.raw.startsWith("--")) break;
    chain.push(token.raw);
    if (chain.length >= 3) break;
  }
  return ["loaf", ...chain].join(" ");
}

// Stamping marker — never read in production but visible to CI grep so
// release pipelines can verify URL stamping happened (any literal `*.invalid`
// reaching production fails the release).
export const __URL_STAMP_PROBE__ = `${LOAF_DOCS_URL} ${LOAF_ISSUE_URL}`;

if (import.meta.main) {
  // Phase 16 SC-2 — SIGINT handler installs at the binary entry only,
  // never when the module is imported (e.g. vitest). Tests exercise the
  // handler via direct `installSigintHandler({writeStderr, exit})` DI
  // so they don't accidentally tear down the test runner via real exit(130).
  installSigintHandler({
    writeStderr: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
  });
  const exitCode = await main(process.argv);
  process.exit(exitCode);
}
