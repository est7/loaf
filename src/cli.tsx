#!/usr/bin/env node

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

import { Command, CommanderError } from "commander";
import os from "node:os";
import packageJson from "../package.json" with { type: "json" };

import { UNEXPECTED_ERROR, writeCrashLog } from "./core/crash-log.js";
import {
  createCommandContext,
  parsePresentation,
  FORMAT_MODES,
  FORMAT_MODES_HUMAN,
  type I18nVars,
} from "./cli/command-context.js";
import { buildTraceEntry, defaultAppendTraceLine, type TraceEntry } from "./cli/trace-writer.js";
import { defaultRenderTui, type RenderTui } from "./cli/tui/render.js";
import { HOOK_EVENTS, HOOK_EVENT_TO_CLAUDE_CODE } from "./core/hook-events.js";
import { readUserConfig, } from "./core/user-config.js";
import { BUILTIN_BUNDLES, createI18n, resolveLocale, } from "./cli/i18n.js";
import {
  diagnosticKey,
  FAILURE_SITE_KEYS,
  type FailureSiteDiagnosticCode,
  type FailureSiteKey,
  type MigratedDiagnosticCode,
} from "./cli/runtime-i18n-keys.js";
import { runEditor as defaultRunEditor, type RunEditor } from "./cli/run-editor.js";
import { buildReportUrl } from "./cli/url-prefill.js";
import { defaultReadStdin, defaultIsStdinTty } from "./cli/stdin.js";

import {
  LOAF_DOCS_URL,
  LOAF_ISSUE_URL,
  helpFooter,
  loadSession,
} from "./core/cli-runtime.js";
import { type MutateContext } from "./core/journal-mutate.js";
import {
  createCommandMutator,
} from "./cli/command-mutator.js";
import {
  loadProjections,
} from "./core/projection-loader.js";

import { registerLifecycle } from "./cli/commands/lifecycle.js";
import { registerGate } from "./cli/commands/gate.js";
import { registerTerminalExecute } from "./cli/commands/terminal-execute.js";
import { registerProfileConfig } from "./cli/commands/profile-config.js";
import { registerTasks } from "./cli/commands/tasks.js";
import { registerTerminalSettle } from "./cli/commands/terminal-settle.js";
import { registerPending } from "./cli/commands/pending.js";
import { registerEvidence } from "./cli/commands/evidence.js";
import { registerJournal } from "./cli/commands/journal.js";
import { registerLessons } from "./cli/commands/lessons.js";
import { registerIntegrations } from "./cli/commands/integrations.js";
import { registerFinding } from "./cli/commands/finding.js";
import { registerSpec } from "./cli/commands/spec.js";
import { registerState } from "./cli/commands/state.js";
import { registerBoard } from "./cli/commands/board.js";
import { registerPrune } from "./cli/commands/prune.js";
import { defaultRegistryDir } from "./core/registry-writer.js";
import { defaultRuntimeDir } from "./core/session-runtime.js";
import { collectPresentSelectors } from "./cli/selectors.js";
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

function writePreContextKeyedFailure(input: {
  code: MigratedDiagnosticCode;
  vars: I18nVars;
  detail?: Record<string, unknown>;
  renderAsJson: boolean;
}): void {
  const keyPath = diagnosticKey(input.code);
  const message = input.renderAsJson
    ? createI18n("en", BUILTIN_BUNDLES).t(keyPath, input.vars)
    : preparseI18nFromEnv(process.env).t(keyPath, input.vars);
  if (input.renderAsJson) {
    const out: Record<string, unknown> = { ok: false, code: input.code, message };
    if (input.detail !== undefined) out["detail"] = input.detail;
    process.stderr.write(JSON.stringify(out) + "\n");
  } else {
    process.stderr.write(`error: ${input.code} — ${message}\n`);
  }
}

function writePreContextSiteFailure(input: {
  code: FailureSiteDiagnosticCode;
  keyPath: FailureSiteKey;
  vars: I18nVars;
  detail?: Record<string, unknown>;
  renderAsJson: boolean;
}): void {
  const message = input.renderAsJson
    ? createI18n("en", BUILTIN_BUNDLES).t(input.keyPath, input.vars)
    : preparseI18nFromEnv(process.env).t(input.keyPath, input.vars);
  if (input.renderAsJson) {
    const out: Record<string, unknown> = { ok: false, code: input.code, message };
    if (input.detail !== undefined) out["detail"] = input.detail;
    process.stderr.write(JSON.stringify(out) + "\n");
  } else {
    process.stderr.write(`error: ${input.code} — ${message}\n`);
  }
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
        writePreContextKeyedFailure({
          code: "INVALID_FORMAT",
          vars: {
            value: presentation.rawValue,
            allowed_values_human: FORMAT_MODES_HUMAN,
          },
          detail: {
            value: presentation.rawValue,
            allowed_values: FORMAT_MODES,
          },
          renderAsJson: false,
        });
      } else {
        // MUTUALLY_EXCLUSIVE_FLAGS. renderAsJson honors protocol §10.7
        // scripting promise: any --format=json present → JSON body.
        const { conflicting, renderAsJson } = presentation;
        writePreContextKeyedFailure({
          code: "MUTUALLY_EXCLUSIVE_FLAGS",
          vars: { flags: conflicting.join(", ") },
          detail: { conflicting },
          renderAsJson,
        });
      }
      return 2;
    }
  }

  // Phase 16 SC-9b — `sessions list` selector misuse pre-parse.
  //
  // Runs BEFORE the SC-8 dispatch USAGE block so `sessions list --feature-dir`
  // gets the right diagnostic ("sessions list does not accept selectors")
  // instead of SC-8's generic "requires --feature" message (codex r292
  // ordering fix).
  //
  // `sessions list` walks the whole registry — passing dispatch selectors
  // is contract misuse. Detect any of:
  //   --session / --feature / --feature-dir (any argv position)
  //   $LOAF_SESSION / $LOAF_FEATURE (env)
  // and emit typed USAGE with `detail.conflicting` listing ONLY the
  // actually-present selectors (codex r290 nit).
  if (!wantsHelpOrVersion) {
    const SUBCOMMAND_VALUE_FLAGS = new Set([
      "--format",
      "--session",
      "--feature",
      "--feature-dir",
      "--ceremony",
      "--label",
      "--workspace",
    ]);
    const collectNonFlagTokens = (startIdx: number, max: number): string[] => {
      const out: string[] = [];
      for (let i = startIdx; i < argv.length; i++) {
        const a = argv[i]!;
        if (a.startsWith("--")) {
          const flagName = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
          if (SUBCOMMAND_VALUE_FLAGS.has(flagName) && !a.includes("=")) i++;
          continue;
        }
        if (a.startsWith("-") && a.length > 1) continue;
        out.push(a);
        if (out.length >= max) break;
      }
      return out;
    };
    const cmdTokens = collectNonFlagTokens(2, 2);
    const isSessionsList = cmdTokens[0] === "sessions" && cmdTokens[1] === "list";
    if (isSessionsList) {
      const presentSelectors = collectPresentSelectors(argv, process.env);
      if (presentSelectors.length > 0) {
        const renderAsJson = detectRenderAsJson(argv);
        writePreContextSiteFailure({
          code: "USAGE",
          keyPath: FAILURE_SITE_KEYS.sessionsListSelectorConflict,
          vars: { conflicting: presentSelectors.join(" / ") },
          detail: { conflicting: presentSelectors },
          renderAsJson,
        });
        return 2;
      }
    }

    // Phase 16 SC-14 — `tui` selector + --format misuse pre-parse.
    //
    // `loaf tui` walks the registry like `sessions list`. Selectors are
    // contract misuse; --format is meaningless for an interactive UI
    // (use `sessions list --format json` for scriptable output). Mirrors
    // SC-9b ordering — fires BEFORE SC-8 dispatch guard.
    const isTui = cmdTokens[0] === "tui";
    if (isTui) {
      const presentSelectors = collectPresentSelectors(argv, process.env);
      const hasFormat = argv.some((a) => a === "--format" || a.startsWith("--format="));
      const renderAsJson = detectRenderAsJson(argv);
      if (presentSelectors.length > 0) {
        writePreContextSiteFailure({
          code: "USAGE",
          keyPath: FAILURE_SITE_KEYS.tuiSelectorConflict,
          vars: { conflicting: presentSelectors.join(" / ") },
          detail: { conflicting: presentSelectors },
          renderAsJson,
        });
        return 2;
      }
      if (hasFormat) {
        writePreContextSiteFailure({
          code: "USAGE",
          keyPath: FAILURE_SITE_KEYS.tuiInteractiveOnly,
          vars: {},
          detail: { reason: "tui-interactive-only" },
          renderAsJson,
        });
        return 2;
      }
    }

    // Phase 16 SC-15a — `loaf hook <event>` pre-parse (codex r363 P1 / r364 P1):
    //   1. `--list-events` FIRST (cmdTokens[1] would be undefined when
    //      only --list-events is given; ordering matters)
    //   2. Bare `loaf hook` (no event) → USAGE listing enum
    //   3. Unknown event → USAGE + did-you-mean
    //   Known event passes through to Commander; SC-15a action returns
    //   HOOK_EVENT_NOT_IMPLEMENTED for all 4. SC-15b/c wire real handlers.
    if (cmdTokens[0] === "hook") {
      const renderAsJson = detectRenderAsJson(argv);
      // (1) --list-events takes precedence
      if (argv.includes("--list-events")) {
        if (renderAsJson) {
          process.stdout.write(
            JSON.stringify({
              ok: true,
              count: HOOK_EVENTS.length,
              events: HOOK_EVENTS.map((e) => ({
                event: e,
                claude_code: HOOK_EVENT_TO_CLAUDE_CODE[e],
              })),
            }) + "\n",
          );
        } else {
          for (const e of HOOK_EVENTS) {
            process.stdout.write(`${e}\t${HOOK_EVENT_TO_CLAUDE_CODE[e]}\n`);
          }
        }
        return 0;
      }
      // (2) Bare `loaf hook` → USAGE listing enum
      if (cmdTokens[1] === undefined) {
        writePreContextSiteFailure({
          code: "USAGE",
          keyPath: FAILURE_SITE_KEYS.hookMissingEvent,
          vars: { events: HOOK_EVENTS.join(", ") },
          detail: { events: HOOK_EVENTS },
          renderAsJson,
        });
        return 2;
      }
      // (3) Unknown event → USAGE + did-you-mean
      if (!(HOOK_EVENTS as readonly string[]).includes(cmdTokens[1]!)) {
        const got = cmdTokens[1]!;
        const suggestion = HOOK_EVENTS.find((e) => e.startsWith(got.slice(0, 4))) ?? HOOK_EVENTS[0];
        writePreContextSiteFailure({
          code: "USAGE",
          keyPath: FAILURE_SITE_KEYS.hookUnknownEvent,
          vars: { event: got, allowed: HOOK_EVENTS.join(", "), suggestion },
          detail: { event: got, allowed: HOOK_EVENTS, suggestion },
          renderAsJson,
        });
        return 2;
      }
    }

    // Phase 16 SC-9c — `check <path>` selector misuse pre-parse.
    //
    // `loaf check <path>` is feature-agnostic schema validation (CI tool).
    // Passing dispatch selectors is contract misuse — emit typed USAGE
    // BEFORE SC-8's "requires --feature" / "--feature-dir requires --feature"
    // generic messages would fire. Mirrors SC-9b sessions-list ordering.
    const isCheck = cmdTokens[0] === "check";
    if (isCheck) {
      const presentSelectors = collectPresentSelectors(argv, process.env);
      if (presentSelectors.length > 0) {
        const renderAsJson = detectRenderAsJson(argv);
        writePreContextSiteFailure({
          code: "USAGE",
          keyPath: FAILURE_SITE_KEYS.checkSelectorConflict,
          vars: { conflicting: presentSelectors.join(" / ") },
          detail: { conflicting: presentSelectors },
          renderAsJson,
        });
        return 2;
      }
    }

    // Phase 16 SC-10 — `--schema` modifier + `<kind> schema` subs both
    // reject feature/session dispatch selectors pre-parse. Two patterns:
    //
    //   Pattern 1 (mutator --schema): cmd is one of 5 batch-capable
    //     mutators AND argv includes `--schema`.
    //   Pattern 2 (artifact schema sub): cmd is `<kind> schema` where
    //     kind ∈ {spec, tasks, evidence, finding, state}.
    //
    // Both reject the same 5 selectors as SC-9b/SC-9c (--session /
    // --feature / --feature-dir / $LOAF_SESSION / $LOAF_FEATURE).
    const MUTATOR_SCHEMA_LABELS = new Map<string, string>([
      ["spec/add-req", "spec add-req --schema"],
      ["spec/add-scenario", "spec add-scenario --schema"],
      ["spec/add-visual", "spec add-visual --schema"],
      ["tasks/add", "tasks add --schema"],
      ["evidence/add", "evidence add --schema"],
    ]);
    const ARTIFACT_KINDS = new Set(["spec", "tasks", "evidence", "finding", "state"]);
    const isArtifactSchema =
      cmdTokens[1] === "schema" && cmdTokens[0] !== undefined && ARTIFACT_KINDS.has(cmdTokens[0]);
    const mutatorSchemaLabel =
      cmdTokens[0] !== undefined && cmdTokens[1] !== undefined && argv.includes("--schema")
        ? MUTATOR_SCHEMA_LABELS.get(`${cmdTokens[0]}/${cmdTokens[1]}`)
        : undefined;
    if (isArtifactSchema || mutatorSchemaLabel !== undefined) {
      const presentSelectors = collectPresentSelectors(argv, process.env);
      if (presentSelectors.length > 0) {
        const subj = mutatorSchemaLabel ?? `${cmdTokens[0]} schema`;
        const renderAsJson = detectRenderAsJson(argv);
        writePreContextSiteFailure({
          code: "USAGE",
          keyPath: FAILURE_SITE_KEYS.schemaSelectorConflict,
          vars: { subject: subj, conflicting: presentSelectors.join(" / ") },
          detail: { conflicting: presentSelectors },
          renderAsJson,
        });
        return 2;
      }
    }
  }

  // Phase 16 SC-8 — dispatch USAGE pre-parse.
  //
  // Two cases caught BEFORE Commander parses argv:
  //   (a) `--session + --feature-dir` (and env variants) — mutex
  //       (session identity comes from registry; manual featureDir
  //       is contradictory).
  //   (b) Bare global `--feature-dir` with no feature source. If
  //       passed at the per-command position Commander accepts it
  //       and ctx.resolveDispatch catches the conflict at action time;
  //       at the global position Commander rejects with its own
  //       "unknown option" error first, so we need the pre-parse
  //       to catch it with the typed SC-8 USAGE diagnostic instead.
  //
  // `loaf start <feature> --feature-dir <path>` is exempt because
  // start's positional `<feature>` IS the feature source. We detect
  // this by checking whether argv[2] === "start" (subcommand position).
  //
  // Render shape mirrors the presentation guard: JSON envelope when
  // any `--format json` / `--format=json` appears, else text-mode
  // `error: USAGE — <message>` (codex r287 P1).
  if (!wantsHelpOrVersion) {
    const hasSession = argv.includes("--session") || argv.some((a) => a.startsWith("--session="));
    const hasFeatureDir =
      argv.includes("--feature-dir") || argv.some((a) => a.startsWith("--feature-dir="));
    const hasFeature = argv.includes("--feature") || argv.some((a) => a.startsWith("--feature="));
    const hasLoafSession =
      process.env["LOAF_SESSION"] !== undefined && process.env["LOAF_SESSION"].length > 0;
    const hasLoafFeature =
      process.env["LOAF_FEATURE"] !== undefined && process.env["LOAF_FEATURE"].length > 0;
    // Detect the subcommand: walk argv[2:] and pick the first non-flag
    // (and non-flag-value) token. Global flags like `--dry-run`,
    // `--debug`, `--no-input`, `--quiet` can appear BEFORE the
    // subcommand (`loaf --dry-run start auth-refresh`), so we can't
    // simply use argv[2]. Track flags that take values so we skip
    // their value too.
    const FLAGS_WITH_VALUES = new Set([
      "--format",
      "--session",
      "--feature",
      "--feature-dir",
      "--ceremony",
      "--label",
      "--workspace",
    ]);
    let subcommand: string | undefined;
    for (let i = 2; i < argv.length; i++) {
      const a = argv[i]!;
      if (a.startsWith("--")) {
        const flagName = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
        // Skip the value of value-taking flags (when not using = form)
        if (FLAGS_WITH_VALUES.has(flagName) && !a.includes("=")) i++;
        continue;
      }
      if (a.startsWith("-") && a.length > 1) continue; // short flags like -v / -n
      subcommand = a;
      break;
    }
    const isStartCommand = subcommand === "start";

    if (hasFeatureDir && !isStartCommand) {
      const sessionConflict: string[] = [];
      if (hasSession) sessionConflict.push("--session");
      if (hasLoafSession) sessionConflict.push("$LOAF_SESSION");

      let conflictingList: readonly string[] = [];
      let usageKey: FailureSiteKey | null = null;
      let usageVars: I18nVars = {};

      if (sessionConflict.length > 0) {
        usageKey = FAILURE_SITE_KEYS.dispatchSessionFeatureDirConflict;
        usageVars = { conflicting: sessionConflict.join(" + ") };
        conflictingList = [...sessionConflict, "--feature-dir"];
      } else if (!hasFeature && !hasLoafFeature) {
        usageKey = FAILURE_SITE_KEYS.dispatchFeatureDirRequiresFeature;
        usageVars = {};
        conflictingList = ["--feature-dir"];
      }

      if (usageKey !== null) {
        // Render shape per protocol §10.2: text vs JSON based on
        // --format. Reuse the parsePresentation result that already
        // resolved the output mode (safe because the presentation
        // guard above bailed for INVALID_FORMAT etc.).
        const renderAsJson = detectRenderAsJson(argv);
        writePreContextSiteFailure({
          code: "USAGE",
          keyPath: usageKey,
          vars: usageVars,
          detail: { conflicting: conflictingList },
          renderAsJson,
        });
        return 2;
      }
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
    if (renderAsJson) {
      process.stderr.write(
        JSON.stringify({
          ok: false,
          code: localeResolution.code,
          message: localeResolution.message,
          detail: localeResolution.detail,
        }) + "\n",
      );
    } else {
      process.stderr.write(`error: ${localeResolution.code} — ${localeResolution.message}\n`);
    }
    return 2;
  }
  const i18n = createI18n(localeResolution.locale, BUILTIN_BUNDLES);

  const readStdin = deps.readStdin ?? defaultReadStdin;
  const isStdinTty = deps.isStdinTty ?? defaultIsStdinTty;
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
  const program = new Command();

  program
    .name("loaf")
    .description("Spec-driven development protocol CLI")
    .version(packageJson.version)
    .option("--format <fmt>", `Output format: ${FORMAT_MODES_HUMAN} (default: text)`)
    // SC-5b2 presentation flags. Registered globally so they parse on
    // any subcommand; advisory routing per protocol §10.12.
    .option("--plain", "Alias for --format text (clig.dev convention)")
    .option("--no-color", "Disable color (NO_COLOR/LOAF_NO_COLOR/TERM=dumb equivalents)")
    .option("-q, --quiet", "Suppress advisory stderr (state-change + next hint; errors still emit)")
    .option(
      "-v, --verbose",
      "Increase advisory detail; counter — repeat for more (-v, -vv)",
      (_v: string, prior: number | undefined): number => (prior ?? 0) + 1,
      0,
    )
    // SC-6a — non-interactive mode declaration. Required for skill / hook /
    // CI runners on a TTY: forces actor resolver to refuse the git-config
    // fallback (`isInteractiveHuman` AND-folded with !ctx.noInput). Future
    // prompt entry points must short-circuit to exit 2 when set.
    .option(
      "--no-input",
      "Non-interactive mode: refuse git-config actor fallback; forward-compat with future prompts (skill / hook / CI)",
    )
    // SC-6b — debug observability. Writes one `kind:"cli"` row to
    // `.loaf/<feature>/trace.jsonl` at invocation end. Orthogonal to
    // `-v/--verbose` (which owns stderr advisory density). Env equivalents
    // `LOAF_DEBUG` / `DEBUG` (any non-empty value); flag wins.
    .option("--debug", "Write per-invocation trace.jsonl (LOAF_DEBUG=1 / DEBUG=1 equivalents)")
    // SC-6c — dry-run. Mutating commands validate (preflight + reducer +
    // gate + integrity) without writing journal / sidecars / projections;
    // read-only commands reject with DRY_RUN_NOT_APPLICABLE. Orthogonal
    // to all other flags. Per §10.7 invariant: dry-run persists NO state.
    .option(
      "-n, --dry-run",
      "Validate without writing (mutating commands only); read-only commands exit 2",
    )
    // SC-8 — session dispatch. Resolves a registry-tracked session by
    // UUID or ≥8-char prefix. Per protocol §10.3, precedence is
    // --session > --feature > $LOAF_SESSION > $LOAF_FEATURE > auto-pick.
    // Combined with --feature-dir → USAGE (enforced pre-parse — see
    // `enforceDispatchUsagePreParse` below). --feature / --feature-dir
    // stay per-command registrations because making them global
    // conflicts with the per-command opts during Commander parse.
    .option(
      "--session <uuid-or-prefix>",
      "Resolve session by UUID or ≥8-char prefix (registry lookup; see §10.3)",
    )
    .addHelpText("after", helpFooter())
    .showHelpAfterError()
    .exitOverride();

  // SC-5a: actor init now lives BELOW the pre-parse guard (r243 P2) —
  // an invalid `--format` must reject before any env reads.
  const actor = `cli:loaf@${process.env["USER"] ?? "unknown"}`;

  // Phase 16 SC-3 — CommandContext is the presentation-layer plumbing
  // that owns output channel + lazy session/projection cache + failure
  // routing + crash-log context snapshot. Phase W8 0a folds the former
  // main() helper cluster (fail / emitFailure / emitNoSessionFailure /
  // resolveHumanActorOrFail / dispatchOrFail / dispatchForHookOptional /
  // resolveHookPath / resolveDispatchForWriteGuard / rejectIfDryRun /
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
    ...(deps.isInteractiveHuman !== undefined && { isInteractiveHuman: deps.isInteractiveHuman }),
    ...(deps.readGitConfig !== undefined && { readGitConfig: deps.readGitConfig }),
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
          ...(deps.registryDir !== undefined && { registryDir: deps.registryDir }),
          ...(deps.registryNow !== undefined && { now: deps.registryNow }),
          ...(deps.registryCwd !== undefined && { cwd: deps.registryCwd }),
        }
      : undefined;

  // Phase W8 0b — CommandMutator owns mutation orchestration: runMutator /
  // mctxFor / finishMutate / routeMutateFailure / emitMutatorSchemaAndExit.
  const mutator = createCommandMutator(ctx, { registryWriter: registryWriterDeps });

  // ── Phase W8 P1 — per-family command registrations ──────────────────
  // Verbatim block move: inline registrations extracted to per-family
  // files under src/cli/commands/. Registration order preserved exactly
  // (Commander shows commands in registration order in --help; any
  // reorder is a behavioral regression caught by the golden gate).

  registerLifecycle(
    program,
    ctx,
    mutator,
    actor,
    deps.runtimeDir ?? defaultRuntimeDir(os.homedir()),
    deps.now ?? (() => new Date()),
    deps.executeClosureHooks,
  );
  registerGate(program, ctx, mutator, actor);
  registerTerminalExecute(program, ctx, mutator, actor);
  registerProfileConfig(program, ctx, mutator, actor, deps.userConfigHomeDir);

  const { tasksCmd } = registerTasks(program, ctx, mutator, actor, isStdinTty, readStdin);
  registerTerminalSettle(program, ctx, mutator, actor);
  registerPending(program, ctx, mutator, actor);
  const { evidenceCmd } = registerEvidence(program, ctx, mutator, actor, isStdinTty, readStdin);
  registerJournal(program, ctx);
  registerLessons(program, ctx, mutator, actor);

  const renderTuiImpl: RenderTui = deps.renderTui ?? defaultRenderTui;
  const isStdoutTty = deps.isStdoutTty ?? (() => process.stdout.isTTY === true);
  registerIntegrations(
    program,
    ctx,
    mutator,
    actor,
    i18n,
    isStdinTty,
    renderTuiImpl,
    isStdoutTty,
    deps.registryDir,
    deps.now,
    deps.runtimeDir ?? defaultRuntimeDir(os.homedir()),
    deps.now ?? (() => new Date()),
  );
  registerBoard(program, ctx, {
    i18n,
    now,
    ...(deps.registryDir !== undefined && { registryDir: deps.registryDir }),
    ...(deps.openUrl !== undefined && { openUrl: deps.openUrl }),
    ...(deps.boardKeepAlive !== undefined && { boardKeepAlive: deps.boardKeepAlive }),
  });
  registerPrune(program, ctx, {
    registryDir: deps.registryDir ?? defaultRegistryDir(),
    now,
    actor,
  });

  const { findingCmd } = registerFinding(program, ctx, mutator, actor);

  const runEditorImpl: RunEditor = deps.runEditor ?? defaultRunEditor;
  const { specCmd } = registerSpec(
    program,
    ctx,
    mutator,
    actor,
    isStdinTty,
    isStdoutTty,
    readStdin,
    runEditorImpl,
  );

  registerState(program, ctx, specCmd, tasksCmd, evidenceCmd, findingCmd);

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
      if (err instanceof CommanderError) {
        if (err.exitCode === 0) {
          resolvedExit = 0;
          return 0;
        }
        process.stderr.write(`error: ${err.code ?? "USAGE"} — ${err.message}\n`);
        resolvedExit = err.exitCode === 1 ? 2 : err.exitCode;
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
        context: { phase: crashContext.phase, sub_state: crashContext.sub_state },
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
  for (const t of argv.slice(2)) {
    if (t.startsWith("--")) break;
    chain.push(t);
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
