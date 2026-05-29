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
import { promises as fsP } from "node:fs";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };

import { UNEXPECTED_ERROR, writeCrashLog } from "./core/crash-log.js";
import {
  createCommandContext,
  parsePresentation,
  FORMAT_MODES_HUMAN,
} from "./cli/command-context.js";
import {
  buildTraceEntry,
  defaultAppendTraceLine,
  type TraceEntry,
} from "./cli/trace-writer.js";
import { listSessions, formatAtRelative } from "./cli/sessions-list.js";
import { buildEnvelope as buildVerifyStatusEnvelope, renderText as renderVerifyStatusText } from "./cli/verify-status.js";
import { evaluateVerifyAcceptDiagnostic } from "./core/gates/verify-accept-eval.js";
import { CHECK_KINDS, checkFile, renderSuccessText as renderCheckSuccess, type CheckKind } from "./cli/check-file.js";
import {
  ARTIFACT_SCHEMA_KINDS,
  emitArtifactSchema,
  emitInputSchema,
  formatSchema,
  type ArtifactSchemaKind,
} from "./cli/schema-emit.js";
import type { MutatorCommand } from "../docs/schemas.js";
import {
  allocateNextEvidenceId,
  allocateNextEvidenceIds,
} from "./cli/evidence-id-allocator.js";
import { buildWaiveEvidencePayload } from "./cli/waive.js";
import { buildLessonsEvidencePayload } from "./cli/lessons-add.js";
import { buildSpecSubmitBatch } from "./cli/spec-submit-batch.js";
import { buildResumePack } from "./cli/build-resume-pack.js";
import { ResumePack as RuntimeResumePack } from "./core/resume-pack-schema.js";
import { App as TuiApp } from "./cli/tui/app.js";
import { defaultRenderTui, type RenderTui } from "./cli/tui/render.js";
import { createElement } from "react";
import { runEditor as defaultRunEditor, type RunEditor } from "./cli/run-editor.js";
import { splitFrontmatter } from "./core/spec-frontmatter.js";
import { parse as parseYaml } from "yaml";
import { mapZodIssues } from "./cli/check-file.js";
import { CoversRefPayload } from "./core/evidence-schema.js";
import { promises as fsPromises } from "node:fs";
import { buildReportUrl } from "./cli/url-prefill.js";
import { parseInputSource } from "./cli/input-source.js";
import { readJsonInput } from "./cli/input-read.js";
import { defaultReadStdin, defaultIsStdinTty } from "./cli/stdin.js";

import { resolveHumanActor } from "./core/actor-resolver.js";
import {
  LOAF_DOCS_URL,
  LOAF_ISSUE_URL,
  defaultFeatureDir,
  getGitEmail,
  helpFooter,
  loadSession,
} from "./core/cli-runtime.js";
import { mutate, mutateBatch, type MutateContext } from "./core/journal-mutate.js";
import { replayJournal } from "./core/journal-bootstrap.js";
import { writeProjections } from "./core/projection-writer.js";
import {
  loadProjections,
  SnapshotStaleError,
  NoSessionError,
  type LoadResult,
  type ProjectionKind,
} from "./core/projection-loader.js";
import type { Ceremony, SubState } from "./core/journal-entry.js";
import {
  carryForwardStepProgress,
  latestCanonicalTaskBody,
  materializeTaskForAmend,
} from "./core/task-history.js";
import {
  TaskInput,
  extractTaskSlim,
  materializeTaskInput,
  type TaskFullPayload,
  type TaskFullProjection,
} from "./core/task-schema.js";
import { FindingId } from "./core/finding-schema.js";
import { EvidenceAddInput } from "./core/evidence-schema.js";
import {
  SpecAddReqInput,
  SpecAddScenarioInput,
  SpecAddVisualInput,
  SpecFrontmatter,
  SpecSubmitInput,
  nextSerialInNamespace,
} from "./core/spec-schema.js";

// Phase 16 SC-5b2 — evidence add stateChange helper per protocol §10.12.
// Set-semantics covers: sort + dedupe before compare AND render
// (codex r262 OQ7). Heterogeneous batches drop kind/covers (codex
// r261 P26 + r262 nit absorption).

function normalizedCovers(covers: readonly string[] | undefined): string {
  if (!covers || covers.length === 0) return "";
  return [...new Set(covers)].sort().join(",");
}

function formatCovers(covers: readonly string[] | undefined): string {
  if (!covers || covers.length === 0) return "<none>";
  return [...new Set(covers)].sort().join(",");
}

function evidenceAddStateChange(
  items: Array<{ id: string; kind: string; covers?: readonly string[] | undefined }>,
): string {
  if (items.length === 1) {
    const it = items[0]!;
    return `evidence add: ${it.id} kind=${it.kind}, covers=${formatCovers(it.covers)}`;
  }
  const kinds = new Set(items.map((it) => it.kind));
  const coversNorm = new Set(items.map((it) => normalizedCovers(it.covers)));
  const idsList = items.map((it) => it.id).join(",");
  if (kinds.size === 1 && coversNorm.size === 1) {
    const kind = [...kinds][0]!;
    const coversForRender = formatCovers(items[0]!.covers);
    return `evidence add: +${items.length} evidence (${idsList}; kind=${kind}, covers=${coversForRender})`;
  }
  return `evidence add: +${items.length} evidence (${idsList})`;
}

const PRESETS: Record<string, Ceremony> = {
  quick: {
    spec_phase: false,
    verify_phase: false,
    settle_phase: false,
    strict_spec_review: false,
    lessons_required: "skip",
    strict_drift_check: false,
  },
  light: {
    spec_phase: true,
    verify_phase: false,
    settle_phase: false,
    strict_spec_review: false,
    lessons_required: "skip",
    strict_drift_check: false,
  },
  standard: {
    spec_phase: true,
    verify_phase: true,
    settle_phase: false,
    strict_spec_review: false,
    lessons_required: "skip",
    strict_drift_check: false,
  },
  deep: {
    spec_phase: true,
    verify_phase: true,
    settle_phase: true,
    strict_spec_review: true,
    lessons_required: "must",
    strict_drift_check: true,
  },
};

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
  // Phase 16 SC-12a-2 — test-injectable editor runner for `loaf spec
  // edit`. Production omits (defaults to runEditor from
  // ./cli/run-editor.js which spawns $EDITOR or vi). Tests inject
  // deterministic stubs to assert the work-copy / no-op / signal split
  // semantics without spawning a real editor (codex r331 P3).
  runEditor?: RunEditor;
  // Phase 16 SC-14 — test-injectable TTY suitability check for
  // `loaf tui`. Defaults to `() => process.stdout.isTTY === true`.
  // Kept separate from isInteractiveHuman (which is actor / no-input
  // semantics per SC-6a) per codex r355 ack 1.
  isStdoutTty?: () => boolean;
  // Phase 16 SC-14 — test-injectable Ink render hook. Defaults to a
  // dynamic-import wrapper around Ink's render() + waitUntilExit().
  // Tests inject a stub that asserts the App was constructed with the
  // right rows then resolves immediately (codex r355 Q3 / r356 ack 2).
  renderTui?: RenderTui;
};

export async function main(
  argv: string[] = process.argv,
  deps: MainDeps = {},
): Promise<number> {
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
        process.stderr.write(
          `error: INVALID_FORMAT — invalid --format value '${presentation.rawValue}'; ` +
            `allowed: ${FORMAT_MODES_HUMAN}\n`,
        );
      } else {
        // MUTUALLY_EXCLUSIVE_FLAGS. renderAsJson honors protocol §10.7
        // scripting promise: any --format=json present → JSON body.
        const { conflicting, renderAsJson } = presentation;
        const message = `mutually exclusive flags in the same invocation: ${conflicting.join(", ")}`;
        if (renderAsJson) {
          process.stderr.write(
            JSON.stringify({
              ok: false,
              code: "MUTUALLY_EXCLUSIVE_FLAGS",
              message,
              detail: { conflicting },
            }) + "\n",
          );
        } else {
          process.stderr.write(`error: MUTUALLY_EXCLUSIVE_FLAGS — ${message}\n`);
        }
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
      "--format", "--session", "--feature", "--feature-dir",
      "--ceremony", "--label", "--workspace",
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
      const presentSelectors: string[] = [];
      if (argv.includes("--session") || argv.some((a) => a.startsWith("--session="))) {
        presentSelectors.push("--session");
      }
      if (argv.includes("--feature") || argv.some((a) => a.startsWith("--feature="))) {
        presentSelectors.push("--feature");
      }
      if (argv.includes("--feature-dir") || argv.some((a) => a.startsWith("--feature-dir="))) {
        presentSelectors.push("--feature-dir");
      }
      if (process.env["LOAF_SESSION"] !== undefined && process.env["LOAF_SESSION"].length > 0) {
        presentSelectors.push("$LOAF_SESSION");
      }
      if (process.env["LOAF_FEATURE"] !== undefined && process.env["LOAF_FEATURE"].length > 0) {
        presentSelectors.push("$LOAF_FEATURE");
      }
      if (presentSelectors.length > 0) {
        const usageMessage = `sessions list does not accept ${presentSelectors.join(" / ")} — it lists across all sessions; use --in-cwd to filter`;
        const renderAsJson = argv.some(
          (a) => a === "--format=json" || (a === "--format" && argv[argv.indexOf(a) + 1] === "json"),
        );
        if (renderAsJson) {
          process.stderr.write(JSON.stringify({
            ok: false,
            code: "USAGE",
            message: usageMessage,
            detail: { conflicting: presentSelectors },
          }) + "\n");
        } else {
          process.stderr.write(`error: USAGE — ${usageMessage}\n`);
        }
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
      const presentSelectors: string[] = [];
      if (argv.includes("--session") || argv.some((a) => a.startsWith("--session="))) {
        presentSelectors.push("--session");
      }
      if (argv.includes("--feature") || argv.some((a) => a.startsWith("--feature="))) {
        presentSelectors.push("--feature");
      }
      if (argv.includes("--feature-dir") || argv.some((a) => a.startsWith("--feature-dir="))) {
        presentSelectors.push("--feature-dir");
      }
      if (process.env["LOAF_SESSION"] !== undefined && process.env["LOAF_SESSION"].length > 0) {
        presentSelectors.push("$LOAF_SESSION");
      }
      if (process.env["LOAF_FEATURE"] !== undefined && process.env["LOAF_FEATURE"].length > 0) {
        presentSelectors.push("$LOAF_FEATURE");
      }
      const hasFormat = argv.some(
        (a) => a === "--format" || a.startsWith("--format="),
      );
      const renderAsJson = argv.some(
        (a) => a === "--format=json" || (a === "--format" && argv[argv.indexOf(a) + 1] === "json"),
      );
      if (presentSelectors.length > 0) {
        const usageMessage = `tui does not accept ${presentSelectors.join(" / ")} — it lists across all sessions; selectors are nonsensical for an interactive UI`;
        if (renderAsJson) {
          process.stderr.write(JSON.stringify({
            ok: false,
            code: "USAGE",
            message: usageMessage,
            detail: { conflicting: presentSelectors },
          }) + "\n");
        } else {
          process.stderr.write(`error: USAGE — ${usageMessage}\n`);
        }
        return 2;
      }
      if (hasFormat) {
        const usageMessage = `tui is interactive-only; use \`loaf sessions list --format json\` for scriptable session output`;
        if (renderAsJson) {
          process.stderr.write(JSON.stringify({
            ok: false,
            code: "USAGE",
            message: usageMessage,
            detail: { reason: "tui-interactive-only" },
          }) + "\n");
        } else {
          process.stderr.write(`error: USAGE — ${usageMessage}\n`);
        }
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
      const presentSelectors: string[] = [];
      if (argv.includes("--session") || argv.some((a) => a.startsWith("--session="))) {
        presentSelectors.push("--session");
      }
      if (argv.includes("--feature") || argv.some((a) => a.startsWith("--feature="))) {
        presentSelectors.push("--feature");
      }
      if (argv.includes("--feature-dir") || argv.some((a) => a.startsWith("--feature-dir="))) {
        presentSelectors.push("--feature-dir");
      }
      if (process.env["LOAF_SESSION"] !== undefined && process.env["LOAF_SESSION"].length > 0) {
        presentSelectors.push("$LOAF_SESSION");
      }
      if (process.env["LOAF_FEATURE"] !== undefined && process.env["LOAF_FEATURE"].length > 0) {
        presentSelectors.push("$LOAF_FEATURE");
      }
      if (presentSelectors.length > 0) {
        const usageMessage = `check does not accept ${presentSelectors.join(" / ")} — it validates a file by path, independent of any feature session`;
        const renderAsJson = argv.some(
          (a) => a === "--format=json" || (a === "--format" && argv[argv.indexOf(a) + 1] === "json"),
        );
        if (renderAsJson) {
          process.stderr.write(JSON.stringify({
            ok: false,
            code: "USAGE",
            message: usageMessage,
            detail: { conflicting: presentSelectors },
          }) + "\n");
        } else {
          process.stderr.write(`error: USAGE — ${usageMessage}\n`);
        }
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
      ["spec/add-req",      "spec add-req --schema"],
      ["spec/add-scenario", "spec add-scenario --schema"],
      ["spec/add-visual",   "spec add-visual --schema"],
      ["tasks/add",         "tasks add --schema"],
      ["evidence/add",      "evidence add --schema"],
    ]);
    const ARTIFACT_KINDS = new Set(["spec", "tasks", "evidence", "finding", "state"]);
    const isArtifactSchema =
      cmdTokens[1] === "schema" && cmdTokens[0] !== undefined && ARTIFACT_KINDS.has(cmdTokens[0]);
    const mutatorSchemaLabel =
      cmdTokens[0] !== undefined && cmdTokens[1] !== undefined && argv.includes("--schema")
        ? MUTATOR_SCHEMA_LABELS.get(`${cmdTokens[0]}/${cmdTokens[1]}`)
        : undefined;
    if (isArtifactSchema || mutatorSchemaLabel !== undefined) {
      const presentSelectors: string[] = [];
      if (argv.includes("--session") || argv.some((a) => a.startsWith("--session="))) {
        presentSelectors.push("--session");
      }
      if (argv.includes("--feature") || argv.some((a) => a.startsWith("--feature="))) {
        presentSelectors.push("--feature");
      }
      if (argv.includes("--feature-dir") || argv.some((a) => a.startsWith("--feature-dir="))) {
        presentSelectors.push("--feature-dir");
      }
      if (process.env["LOAF_SESSION"] !== undefined && process.env["LOAF_SESSION"].length > 0) {
        presentSelectors.push("$LOAF_SESSION");
      }
      if (process.env["LOAF_FEATURE"] !== undefined && process.env["LOAF_FEATURE"].length > 0) {
        presentSelectors.push("$LOAF_FEATURE");
      }
      if (presentSelectors.length > 0) {
        const subj = mutatorSchemaLabel ?? `${cmdTokens[0]} schema`;
        const usageMessage = `${subj} does not accept ${presentSelectors.join(" / ")} — schema dumps are feature-agnostic`;
        const renderAsJson = argv.some(
          (a) => a === "--format=json" || (a === "--format" && argv[argv.indexOf(a) + 1] === "json"),
        );
        if (renderAsJson) {
          process.stderr.write(JSON.stringify({
            ok: false,
            code: "USAGE",
            message: usageMessage,
            detail: { conflicting: presentSelectors },
          }) + "\n");
        } else {
          process.stderr.write(`error: USAGE — ${usageMessage}\n`);
        }
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
    const hasFeatureDir = argv.includes("--feature-dir") || argv.some((a) => a.startsWith("--feature-dir="));
    const hasFeature = argv.includes("--feature") || argv.some((a) => a.startsWith("--feature="));
    const hasLoafSession = process.env["LOAF_SESSION"] !== undefined && process.env["LOAF_SESSION"].length > 0;
    const hasLoafFeature = process.env["LOAF_FEATURE"] !== undefined && process.env["LOAF_FEATURE"].length > 0;
    // Detect the subcommand: walk argv[2:] and pick the first non-flag
    // (and non-flag-value) token. Global flags like `--dry-run`,
    // `--debug`, `--no-input`, `--quiet` can appear BEFORE the
    // subcommand (`loaf --dry-run start auth-refresh`), so we can't
    // simply use argv[2]. Track flags that take values so we skip
    // their value too.
    const FLAGS_WITH_VALUES = new Set([
      "--format", "--session", "--feature", "--feature-dir",
      "--ceremony", "--label", "--workspace",
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

      let usageMessage: string | null = null;
      let conflictingList: readonly string[] = [];

      if (sessionConflict.length > 0) {
        usageMessage = `${sessionConflict.join(" + ")} cannot be combined with --feature-dir (session identity comes from registry; manual featureDir is contradictory)`;
        conflictingList = [...sessionConflict, "--feature-dir"];
      } else if (!hasFeature && !hasLoafFeature) {
        usageMessage = "--feature-dir requires --feature <name> or $LOAF_FEATURE to name the feature";
        conflictingList = ["--feature-dir"];
      }

      if (usageMessage !== null) {
        // Render shape per protocol §10.2: text vs JSON based on
        // --format. Reuse the parsePresentation result that already
        // resolved the output mode (safe because the presentation
        // guard above bailed for INVALID_FORMAT etc.).
        const renderAsJson = argv.some(
          (a) => a === "--format=json" || (a === "--format" && argv[argv.indexOf(a) + 1] === "json"),
        );
        if (renderAsJson) {
          process.stderr.write(
            JSON.stringify({
              ok: false,
              code: "USAGE",
              message: usageMessage,
              detail: { conflicting: conflictingList },
            }) + "\n",
          );
        } else {
          process.stderr.write(`error: USAGE — ${usageMessage}\n`);
        }
        return 2;
      }
    }
  }

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
    .option(
      "--format <fmt>",
      `Output format: ${FORMAT_MODES_HUMAN} (default: text)`,
    )
    // SC-5b2 presentation flags. Registered globally so they parse on
    // any subcommand; advisory routing per protocol §10.12.
    .option("--plain", "Alias for --format text (clig.dev convention)")
    .option("--no-color", "Disable color (NO_COLOR/LOAF_NO_COLOR/TERM=dumb equivalents)")
    .option("-q, --quiet", "Suppress advisory stderr (state-change + next hint; errors still emit)")
    .option("-v, --verbose", "Increase advisory detail; counter — repeat for more (-v, -vv)", (_v: string, prior: number | undefined): number => (prior ?? 0) + 1, 0)
    // SC-6a — non-interactive mode declaration. Required for skill / hook /
    // CI runners on a TTY: forces actor resolver to refuse the git-config
    // fallback (`isInteractiveHuman` AND-folded with !ctx.noInput). Future
    // prompt entry points must short-circuit to exit 2 when set.
    .option("--no-input", "Non-interactive mode: refuse git-config actor fallback; forward-compat with future prompts (skill / hook / CI)")
    // SC-6b — debug observability. Writes one `kind:"cli"` row to
    // `.loaf/<feature>/trace.jsonl` at invocation end. Orthogonal to
    // `-v/--verbose` (which owns stderr advisory density). Env equivalents
    // `LOAF_DEBUG` / `DEBUG` (any non-empty value); flag wins.
    .option("--debug", "Write per-invocation trace.jsonl (LOAF_DEBUG=1 / DEBUG=1 equivalents)")
    // SC-6c — dry-run. Mutating commands validate (preflight + reducer +
    // gate + integrity) without writing journal / sidecars / projections;
    // read-only commands reject with DRY_RUN_NOT_APPLICABLE. Orthogonal
    // to all other flags. Per §10.7 invariant: dry-run persists NO state.
    .option("-n, --dry-run", "Validate without writing (mutating commands only); read-only commands exit 2")
    // SC-8 — session dispatch. Resolves a registry-tracked session by
    // UUID or ≥8-char prefix. Per protocol §10.3, precedence is
    // --session > --feature > $LOAF_SESSION > $LOAF_FEATURE > auto-pick.
    // Combined with --feature-dir → USAGE (enforced pre-parse — see
    // `enforceDispatchUsagePreParse` below). --feature / --feature-dir
    // stay per-command registrations because making them global
    // conflicts with the per-command opts during Commander parse.
    .option("--session <uuid-or-prefix>", "Resolve session by UUID or ≥8-char prefix (registry lookup; see §10.3)")
    .addHelpText("after", helpFooter())
    .showHelpAfterError()
    .exitOverride();

  // SC-5a: actor init now lives BELOW the pre-parse guard (r243 P2) —
  // an invalid `--format` must reject before any env reads.
  const actor = `cli:loaf@${process.env["USER"] ?? "unknown"}`;

  // Phase 16 SC-3 — CommandContext is the presentation-layer plumbing
  // that owns output channel + lazy session/projection cache + failure
  // routing + crash-log context snapshot. fail()/emitFailure() become
  // thin shims so all 28 unmigrated commands transparently route through
  // ctx without per-call-site changes (codex r206 axis G: 1 representative
  // command migrated; rest follow in SC-4..SC-15 as each is touched).
  const ctx = createCommandContext(argv, {
    writeStdout: writeStdoutCaptured,
    writeStderr: (s) => process.stderr.write(s),
    loadSession,
    loadProjections,
    // Phase 16 SC-8: thread MainDeps.registryDir through to the
    // CommandContext so ctx.resolveDispatch() uses the tmp dir in
    // CLI e2e tests. Production omits → defaultRegistryDir() honors
    // LOAF_REGISTRY_DIR env (set by vitest setup file).
    ...(deps.registryDir !== undefined && { registryDir: deps.registryDir }),
  });
  // SC-5b2 closed the legacy presentation shim — all sites now route
  // through ctx.success / ctx.failure. Single source of truth =
  // ctx.output (parsePresentation via createCommandContext).
  const fail = (code: string, message: string): void => {
    ctx.failure(code, message);
  };
  const emitFailure = (
    code: string,
    message: string,
    detail?: Record<string, unknown>,
  ): void => {
    ctx.failure(code, message, detail);
  };

  // Phase 16 SC-6a — actor-resolution boundary helpers. Both injection
  // points live in MainDeps so tests can drive deterministic TTY-up /
  // git-config values; production omits both and falls back to the
  // pre-SC-6a literals (process.stdin.isTTY === true, getGitEmail).
  // The closure re-evaluates `ctx.noInput` on every invocation so a
  // shared helper works for sub-commands resolved later in main().
  const isInteractiveHumanForActor = (): boolean =>
    (deps.isInteractiveHuman?.() ?? process.stdin.isTTY === true) && !ctx.noInput;
  const readGitConfigForActor: () => string | null = deps.readGitConfig ?? getGitEmail;

  // Phase 16 SC-8 — dispatch resolution wrapper. Each feature-addressed
  // action handler calls this at the top instead of the SC-6b
  // `featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature)` +
  // `ctx.recordTraceTarget(...)` pattern. Resolves protocol §10.3
  // 5-level precedence; on failure emits the dispatch diagnostic and
  // returns null (caller early-returns). On success mutates `opts` so
  // downstream `opts.feature` / `opts.featureDir` references resolve to
  // the dispatched values (existing code path stays valid).
  const dispatchOrFail = async (
    opts: { feature?: string; featureDir?: string },
  ): Promise<string | null> => {
    const dispatch = await ctx.resolveDispatch();
    if (!dispatch.ok) {
      emitFailure(dispatch.code, dispatch.message, dispatch.detail);
      return null;
    }
    if (dispatch.autoPickAdvisory) ctx.advisory(dispatch.autoPickAdvisory);
    opts.feature = dispatch.feature;
    opts.featureDir = dispatch.featureDir;
    ctx.recordTraceTarget(dispatch.feature, dispatch.featureDir);
    return dispatch.featureDir;
  };

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

  // Phase 16 SC-6c — `--dry-run` helpers. `emitDryRunSuccess` formats
  // the "would do" summary after a mutator returns ok:true under
  // `ctx.dryRun`. `rejectIfDryRun` short-circuits read-only / wrapping
  // command handlers with a typed `DRY_RUN_NOT_APPLICABLE` failure.
  // Both presentation-layer closures over `ctx`; stable-core behavior
  // lives in `MutateContext.dryRun` (codex r275 D / r276 acceptance).
  // SC-6c stdout "would do" summary. Reads the kind from the mutator
  // result (entry for single mutate, entries[0] for batch). The
  // discriminator + ok shape matches r271 D5 (next-id enumeration
  // deferred — kind only for v0.1.0).
  const emitDryRunSuccess = (
    result: { entry: { kind: string } } | { entries: readonly { kind: string }[] },
  ): void => {
    const kind =
      "entry" in result ? result.entry.kind : result.entries[0]?.kind ?? "(empty)";
    ctx.success(
      { ok: true, dry_run: true, would: { kind } },
      () => `dry-run: would ${kind}\n`,
    );
  };
  const rejectIfDryRun = (
    command: string,
    commandType: "read-only" | "wrapping" | "projection-writer" = "read-only",
  ): boolean => {
    if (ctx.dryRun) {
      emitFailure(
        "DRY_RUN_NOT_APPLICABLE",
        `--dry-run not applicable to ${commandType} command \`${command}\``,
        { command, command_type: commandType },
      );
      return true;
    }
    return false;
  };

  // Phase 16 SC-10 — `--schema` bypass emitter for the 5 batch-capable
  // mutator commands (codex r316 lock). Caller pre-checks opts.schema
  // and rejectIfDryRun(<literal label>) at the action site so the
  // SC-6c static guard can scan the literal strings; this helper only
  // emits the schema once those gates have passed.
  const emitMutatorSchemaAndExit = (commandKey: MutatorCommand): void => {
    const schema = emitInputSchema(commandKey) as Record<string, unknown>;
    ctx.success(schema, () => formatSchema(schema));
  };

  // loadProjectionsOrFail — projection-loader wrapper for the four
  // SC3-wired read-only commands (status / tasks list / pending list /
  // finding list). On NoSessionError / SnapshotStaleError, routes through
  // emitFailure (exit 2 + structured stderr per Q5 contract) and returns
  // null — caller must early-return without touching stdout. The 9-reason
  // stale taxonomy rides err.detail.reason; CLI does not interpret it,
  // just forwards the loader-built envelope verbatim.
  const loadProjectionsOrFail = async <K extends ProjectionKind>(
    featureDir: string,
    kinds: readonly K[],
    feature: string,
  ): Promise<LoadResult<K> | null> => {
    try {
      return await loadProjections({ feature_dir: featureDir, kinds });
    } catch (err) {
      if (err instanceof NoSessionError) {
        emitFailure(
          "NO_SESSION",
          `run \`loaf start ${feature}\` first`,
          err.detail,
        );
        return null;
      }
      if (err instanceof SnapshotStaleError) {
        emitFailure(
          err.code,
          `snapshot stale (reason=${err.reason}) — run \`loaf doctor --rebuild --feature ${feature}\` to re-serialize from journal truth`,
          err.detail,
        );
        return null;
      }
      throw err;
    }
  };

  // ── loaf start <feature> ────────────────────────────────────────────
  program
    .command("start <feature>")
    .description("Start a new feature session (emits session:started)")
    .option("--ceremony <preset>", "Preset label: quick / light / standard / deep", "standard")
    .option("--label <text>", "Human-readable session label (≥3 chars)")
    .option("--workspace <name>", "Workspace name (multi-worktree display)", "default")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (
      feature: string,
      opts: { ceremony: string; label?: string; workspace: string; featureDir?: string },
    ) => {
      const ceremony = PRESETS[opts.ceremony];
      if (!ceremony) {
        fail("INVALID_PRESET",
          `unknown ceremony preset "${opts.ceremony}" — known: ${Object.keys(PRESETS).join(", ")}`);
        return;
      }
      // Phase 15 SC1 (F-019): --label is optional, but when given it must
      // satisfy the session:started payload contract (≥3 chars). Reject
      // client-side with a usage error rather than a deep INVALID_PAYLOAD.
      if (opts.label !== undefined && opts.label.length < 3) {
        fail("USAGE", "--label must be at least 3 characters");
        return;
      }
      if (opts.workspace.length < 1) {
        fail("USAGE", "--workspace must not be empty");
        return;
      }
      const featureDir = opts.featureDir ?? defaultFeatureDir(feature);
      ctx.recordTraceTarget(feature, featureDir);
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      const sessionId = crypto.randomUUID();
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor,
          entry_schema_version: 1,
          kind: "session:started",
          // Phase 15 SC1 (F-019): bucket-C identity fields ride the
          // session:started payload so state.json is fully journal-derived.
          payload: {
            session_id: sessionId,
            feature,
            ceremony,
            ceremony_label: opts.ceremony,
            workspace: opts.workspace,
            loaf_version_required: `^${packageJson.version}`,
            ...(opts.label !== undefined ? { session_label: opts.label } : {}),
          },
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
      );
      if (!result.ok) {
        fail(result.code, result.message);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }
      const out = {
        ok: true,
        feature,
        session_id: sessionId,
        ceremony_label: opts.ceremony,
        workspace: opts.workspace,
        feature_dir: featureDir,
        sub_state: result.snapshot.state?.sub_state,
      };
      // Phase 16 SC-5b1 pilot — `loaf start` is the first command
      // migrated to ctx.success(payload, textRenderer, advisories).
      // Text mode stdout = bare session_id (UUID) for pipeable use;
      // stderr stateChange + next advisory per protocol §10.12
      // (`docs/protocol.md:2014` — aligned to runtime data, no F-NNN).
      ctx.success(
        out,
        () => `${sessionId}\n`,
        {
          stateChange: `start: '${feature}' created → TRIAGE.score`,
          next: "loaf advance",
        },
      );
    });

  // ── loaf advance <to> ───────────────────────────────────────────────
  program
    .command("advance <to>")
    .description("Advance the session cursor (emits event:phase_advanced)")
    .option("--feature <name>", "Feature whose session to advance")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (to: string, opts: { feature: string; featureDir?: string }) => {
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      const from = session.snapshot.state?.sub_state;
      if (!from) {
        fail("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor,
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from, to },
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
      );
      if (!result.ok) {
        fail(result.code, result.message);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }
      const out = { ok: true, from, to, sub_state: result.snapshot.state?.sub_state };
      ctx.success(out, () => "", { stateChange: `advance: ${from} → ${to}` });
    });

  // ── loaf status ─────────────────────────────────────────────────────
  // Phase 15 SC3: switched from loadSession (full replay) to
  // loadProjections (snapshot + fast-check). Pre-`loaf start` dir now
  // exits 2 NO_SESSION (was exit 0 + state:null) — codex r175a confirmed
  // (A): uniform with the other 3 SC3-wired read commands.
  program
    .command("status")
    .description("Show the current session snapshot (read-only)")
    .option("--feature <name>", "Feature whose status to show")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      if (rejectIfDryRun("status")) return;
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const loaded = await loadProjectionsOrFail(
        featureDir,
        ["state", "tasks", "evidence", "findings", "pending"] as const,
        opts.feature,
      );
      if (loaded === null) return;
      const { state, tasks, evidence, findings, pending, meta } = loaded;
      // Adapter: StateProjection → SessionState-compatible slim shape
      // (codex r176 BLOCK 1 — do not widen `status.state` with SC1 bucket-C
      // fields or drop the historical `feature` field). Re-inject `feature`
      // from --feature flag (StateProjection drops it; the feature dir is
      // the canonical identity). 9-field shape mirrors reducer's SessionState.
      const slimState = {
        session_id: state.session_id,
        feature: opts.feature,
        phase: state.phase,
        sub_state: state.sub_state,
        iteration: state.iteration,
        spec_locked: state.spec_locked,
        verify_accepted: state.verify_accepted,
        spec_version: state.spec_version,
        ceremony: state.ceremony,
      };
      const out = {
        ok: true,
        feature: opts.feature,
        feature_dir: featureDir,
        tail_seq: meta.last_applied_seq,
        state: slimState,
        tasks_count: tasks ? tasks.tasks.length : 0,
        evidence_count: evidence.evidence.length,
        findings_count: findings.findings.length,
        pending_count: pending.pending.length,
      };
      ctx.success(
        out,
        () =>
          `feature: ${opts.feature}\n` +
          `phase:   ${state.phase}.${state.sub_state.split(".")[1]}\n` +
          `cursor:  ${state.sub_state}\n` +
          `tail:    seq=${out.tail_seq}\n` +
          `tasks=${out.tasks_count} evidence=${out.evidence_count} findings=${out.findings_count} pending=${out.pending_count}\n` +
          `# snapshot as-of seq=${out.tail_seq} (projection-loader, Phase 15 SC3)\n`,
      );
    });

  // ── loaf gate decide <gate-name> ────────────────────────────────────
  // Slice 1.B sub-cycle 4 (spec-lock) + Slice 1.C sub-cycle 6 (verify-accept).
  // Approve emissions differ per gate:
  //   spec-lock:     [gate:decided, event:phase_advanced SPEC.design → EXECUTE.plan]
  //                  (dual-entry batch — gate decision + cursor advance)
  //   verify-accept: [gate:decided]
  //                  (single-entry — gate flips verify_accepted flag only;
  //                   cursor stays at VERIFY.accept. `loaf deliver` /
  //                   `loaf settle` later move the cursor per ceremony.settle_phase.)
  //   reject:        [gate:decided] for both gates (no cursor side-effect)
  //
  // Slice 3 SC4: pending:resolved co-emission soft-binding (codex r68
  // → r71 plan). When the snapshot's unresolved pending head exists
  // with kind=gate_decision, the approve batch appends pending:resolved
  // so the head is cleared atomically with the decision. Heads with a
  // non-gate kind are rejected upstream by preflight GATE_NOT_PENDING
  // (resolve the active prompt first). Rejected decisions do not
  // co-emit. Strict gate_decision(<G>) matching is deferred until
  // PendingAddedPayload gains a gate_name discriminator.
  program
    .command("gate")
    .description("Gate decision commands (spec-lock + verify-accept)")
    .command("decide <gate-name>")
    .description(
      "Decide a gate (emits gate:decided; spec-lock approve also advances cursor)",
    )
    .option("--approve", "Approve the gate")
    .option("--reject", "Reject the gate")
    .requiredOption("--reason <text>", "Decision rationale (passed through to GateDecidedPayload)")
    .option("--feature <name>", "Feature whose session to gate")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (
      gateName: string,
      opts: {
        approve?: boolean;
        reject?: boolean;
        reason: string;
        feature: string;
        featureDir?: string;
      },
    ) => {
      // (1) action-level mutex: exactly one of --approve / --reject
      const approve = opts.approve === true;
      const reject = opts.reject === true;
      if (approve === reject) {
        emitFailure(
          "USAGE",
          "exactly one of --approve | --reject is required",
        );
        return;
      }
      // (2) gate name validation — must be in GateName enum
      if (gateName !== "spec-lock" && gateName !== "verify-accept") {
        emitFailure(
          "GATE_NOT_IMPLEMENTED",
          `gate=${gateName} is not recognized; protocol GateName enum is closed at {spec-lock, verify-accept}`,
          { gate: gateName },
        );
        return;
      }
      // (3) resolve human actor (gate is human-only per per-kind actor policy)
      const resolution = resolveHumanActor({
        env: process.env,
        readGitConfig: readGitConfigForActor,
        isInteractiveHuman: isInteractiveHumanForActor(),
      });
      if (!resolution.ok) {
        emitFailure(resolution.code, resolution.message);
        return;
      }
      const humanActor = resolution.actor;
      // (4) load session
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      const from = session.snapshot.state?.sub_state;
      if (!from) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      // (5) build entries + execute per-gate
      const mctx = {
        feature_dir: featureDir,
        snapshot: session.snapshot,
        tail_seq: session.tail_seq,
        entries: session.entries,
        meta: session.meta,
        dryRun: ctx.dryRun,
        registryWriter: registryWriterDeps,
      };
      const now = new Date().toISOString();
      // SC4 soft pending co-emission: if the unresolved head is a
      // gate_decision prompt, the approve batch appends pending:resolved
      // so the head clears atomically. Non-gate heads are rejected by
      // preflight GATE_NOT_PENDING (see reducer/preflight.ts (5a)).
      const pendingHead = session.snapshot.pending.find((p) => !p.resolved);
      const coEmitPendingResolved =
        approve && pendingHead && pendingHead.kind === "gate_decision";
      if (approve) {
        if (gateName === "spec-lock") {
          // dual-entry batch: human gate:decided + machine event:phase_advanced.
          // mutateBatch Pass 1.5 evaluates spec-lock via evaluateSpecLock; any
          // failure surfaces as GATE_PRECONDITION_VIOLATION with checks[] in
          // detail. spec-lock specifically moves SPEC.design → EXECUTE.plan.
          // SC4: when coEmitPendingResolved, insert pending:resolved between
          // the gate decision and the cursor advance — order matters for
          // reducer dry-run (pending head must still be unresolved when
          // pending:resolved applies; phase_advanced runs after).
          const entries: Parameters<typeof mutateBatch>[0] = [
            {
              at: now,
              actor: humanActor,
              entry_schema_version: 1,
              kind: "gate:decided",
              payload: { gate_kind: "spec-lock", decision: "approved", reason: opts.reason },
            },
          ];
          if (coEmitPendingResolved && pendingHead) {
            entries.push({
              at: now,
              actor,
              entry_schema_version: 1,
              kind: "pending:resolved",
              payload: { id: pendingHead.id, answer: "gate-decide:spec-lock:approved" },
            });
          }
          entries.push({
            at: now,
            actor,
            entry_schema_version: 1,
            kind: "event:phase_advanced",
            payload: { from, to: "EXECUTE.plan" },
          });
          const result = await mutateBatch(entries, mctx);
          if (!result.ok) {
            emitFailure(result.code, result.message, result.detail);
            return;
          }
          if (ctx.dryRun) {
            emitDryRunSuccess(result);
            return;
          }
          const out = {
            ok: true,
            gate: "spec-lock",
            decision: "approved" as const,
            from,
            to: "EXECUTE.plan",
            actor: humanActor,
            sub_state: result.snapshot.state?.sub_state,
            spec_locked: result.snapshot.state?.spec_locked,
          };
          ctx.success(
            out,
            () => "",
            { stateChange: `gate decide: spec-lock approved by ${humanActor}` },
          );
          return;
        }
        // verify-accept approve: single-entry [gate:decided] OR 2-entry
        // batch [gate:decided, pending:resolved] when SC4 co-emission fires.
        // mutateBatch Pass 1.5 evaluates verify-accept via evaluateVerifyAccept
        // (5 checks: lane status / open findings / coverage / done-task evidence
        // / deep spec-review). Gate does NOT move cursor — cursor stays at
        // VERIFY.accept; `loaf deliver` / `loaf settle` advance cursor later
        // per ceremony.settle_phase.
        const result = coEmitPendingResolved && pendingHead
          ? await mutateBatch(
            [
              {
                at: now,
                actor: humanActor,
                entry_schema_version: 1,
                kind: "gate:decided",
                payload: { gate_kind: "verify-accept", decision: "approved", reason: opts.reason },
              },
              {
                at: now,
                actor,
                entry_schema_version: 1,
                kind: "pending:resolved",
                payload: { id: pendingHead.id, answer: "gate-decide:verify-accept:approved" },
              },
            ],
            mctx,
          )
          : await mutate(
            {
              at: now,
              actor: humanActor,
              entry_schema_version: 1,
              kind: "gate:decided",
              payload: { gate_kind: "verify-accept", decision: "approved", reason: opts.reason },
            },
            mctx,
          );
        if (!result.ok) {
          emitFailure(result.code, result.message, result.detail);
          return;
        }
        if (ctx.dryRun) {
          emitDryRunSuccess(result);
          return;
        }
        const out = {
          ok: true,
          gate: "verify-accept",
          decision: "approved" as const,
          from,
          actor: humanActor,
          sub_state: result.snapshot.state?.sub_state,
          verify_accepted: result.snapshot.state?.verify_accepted,
        };
        const nextCmd =
          result.snapshot.state?.ceremony?.settle_phase === true
            ? "loaf settle"
            : "loaf deliver";
        ctx.success(
          out,
          () => "",
          {
            stateChange: `gate decide: verify-accept approved by ${humanActor}`,
            next: nextCmd,
          },
        );
        return;
      }
      // reject: single entry, no cursor side-effect, no Pass 1.5 eval.
      // Shared between spec-lock and verify-accept.
      const result = await mutate(
        {
          at: now,
          actor: humanActor,
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: gateName, decision: "rejected", reason: opts.reason },
        },
        mctx,
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }
      const out = {
        ok: true,
        gate: gateName,
        decision: "rejected" as const,
        from,
        actor: humanActor,
        sub_state: result.snapshot.state?.sub_state,
        spec_locked: result.snapshot.state?.spec_locked,
        verify_accepted: result.snapshot.state?.verify_accepted,
      };
      ctx.success(
        out,
        () => "",
        { stateChange: `gate decide: ${gateName} rejected by ${humanActor}` },
      );
    });

  // ── loaf deliver ────────────────────────────────────────────────────
  // Slice 1.D sub-cycle 2. Emits a single `session:delivered` entry
  // (human-only actor); the reducer flips the cursor directly to
  // DONE.delivered (no companion `event:phase_advanced` — that edge was
  // removed in sub-cycle 1). Three legal source sub_states per
  // PER_KIND_SUB_STATE: EXECUTE.done, VERIFY.accept, SETTLE.lessons.
  // Preflight step 5c enforces the ceremony / verify_accepted / spike-
  // tasks preconditions per protocol §5.2 / §10.8 / §1824:
  //   * EXECUTE.done    → DELIVER_VERIFY_MIN_UNAVAILABLE (deferred —
  //                       verify-min check infra not yet wired).
  //   * VERIFY.accept   → ceremony.settle_phase=false + verify_accepted=true
  //                       (DELIVER_SETTLE_PHASE_BYPASS / DELIVER_NOT_ACCEPTED).
  //   * SETTLE.lessons  → verify_accepted=true (defensive; legal
  //                       transitions cannot reach here without approval).
  //   * Any source      → no non-abandoned spike tasks (DELIVER_SPIKE_TASKS).
  // Output is advisory-only per protocol §1824 — the deliver step does
  // not invoke git/gh; it records the cursor flip and renders a "next:"
  // hint that callers can grep for.
  program
    .command("deliver")
    .description("Deliver the feature session (emits session:delivered → DONE.delivered)")
    .option("--feature <name>", "Feature whose session to deliver")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .option("--reason <text>", "Optional rationale to record on the session:delivered entry")
    .action(async (opts: { feature: string; featureDir?: string; reason?: string }) => {
      // Phase 16 SC-3 — representative command migrated to CommandContext.
      // Same external behavior (byte-identical text + JSON output) per
      // codex r206 axis I; proves the API can drive a real mutate command
      // end-to-end. SC-4..SC-15 migrate the remaining 28 handlers as
      // each command group gets touched.

      // (1) Human-only actor — `session:delivered` is HUMAN_ONLY per PER_KIND_ACTOR.
      const resolution = resolveHumanActor({
        env: process.env,
        readGitConfig: readGitConfigForActor,
        isInteractiveHuman: isInteractiveHumanForActor(),
      });
      if (!resolution.ok) {
        ctx.failure(resolution.code, resolution.message);
        return;
      }
      const humanActor = resolution.actor;

      // (2) Load session via ctx (caches per featureDir; ctx also captures
      //     the resolved sub_state for snapshotCrashContext enrichment).
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await ctx.resolveSession(featureDir);
      const from = session.snapshot.state?.sub_state;
      if (!from) {
        ctx.failure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }

      // (3) Build payload (reason is optional per SessionReasonPayload).
      const payload: Record<string, unknown> = {};
      if (opts.reason !== undefined) payload["reason"] = opts.reason;

      // (4) Mutate. preflight step 5c enforces all delivery preconditions;
      //     reducer flips cursor to DONE.delivered.
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor: humanActor,
          entry_schema_version: 1,
          kind: "session:delivered",
          payload,
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
      );
      if (!result.ok) {
        ctx.failure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }

      // (5) Success output via ctx.success — stateChange + next routed to
      //     stderr per protocol §10.12 (SC-5b2). The advisory string
      //     remains in the JSON payload for back-compat.
      const advisory = [
        `session complete — \`loaf start <feature>\` to begin another`,
      ];
      const out = {
        ok: true,
        feature: opts.feature,
        from,
        to: "DONE.delivered" as const,
        actor: humanActor,
        sub_state: result.snapshot.state?.sub_state,
        advisory,
      };
      ctx.success(
        out,
        () => "",
        {
          stateChange: `deliver: ${opts.feature} — ${from} → DONE.delivered by ${humanActor}`,
          next: advisory[0]!,
        },
      );
    });

  // ── loaf archive / loaf abandon ─────────────────────────────────────
  // Item 2 — the two non-delivered session-terminal commands (protocol
  // §8.3 三出口 minus `spike convert`). Both emit a `session:*` entry whose
  // reducer flips the cursor directly to DONE.archived / DONE.abandoned
  // (no `event:phase_advanced`). Modeled on `loaf deliver` above, with two
  // differences: `--reason` is REQUIRED (deliver's is optional), and the
  // preflight refine (step 5c.2) rejects an absent reason as
  // SESSION_REASON_REQUIRED. Both kinds are HUMAN_ONLY per PER_KIND_ACTOR
  // and accept any non-DONE source sub_state per PER_KIND_SUB_STATE.
  // The two blocks are intentionally parallel — kept side-by-side rather
  // than abstracted, consistent with `deliver` not sharing a helper.
  program
    .command("archive")
    .description("Close the feature session without delivering (emits session:archived → DONE.archived)")
    .option("--feature <name>", "Feature whose session to archive")
    .requiredOption("--reason <text>", "Rationale recorded on the session:archived entry")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; reason: string; featureDir?: string }) => {
      // (1) Human-only actor — `session:archived` is HUMAN_ONLY per PER_KIND_ACTOR.
      const resolution = resolveHumanActor({
        env: process.env,
        readGitConfig: readGitConfigForActor,
        isInteractiveHuman: isInteractiveHumanForActor(),
      });
      if (!resolution.ok) {
        emitFailure(resolution.code, resolution.message);
        return;
      }
      const humanActor = resolution.actor;

      // (2) Load session.
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      const from = session.snapshot.state?.sub_state;
      if (!from) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }

      // (3) Mutate. preflight step 5c.2 enforces reason-required; reducer
      //     flips cursor to DONE.archived.
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor: humanActor,
          entry_schema_version: 1,
          kind: "session:archived",
          payload: { reason: opts.reason },
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }

      // (4) Success output.
      const out = {
        ok: true,
        feature: opts.feature,
        from,
        to: "DONE.archived" as const,
        actor: humanActor,
        sub_state: result.snapshot.state?.sub_state,
      };
      ctx.success(
        out,
        () => "",
        {
          stateChange: `archive: ${opts.feature} — ${from} → DONE.archived by ${humanActor}`,
        },
      );
    });

  program
    .command("abandon")
    .description("Abandon the feature session (emits session:abandoned → DONE.abandoned)")
    .option("--feature <name>", "Feature whose session to abandon")
    .requiredOption("--reason <text>", "Rationale recorded on the session:abandoned entry")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; reason: string; featureDir?: string }) => {
      // (1) Human-only actor — `session:abandoned` is HUMAN_ONLY per PER_KIND_ACTOR.
      const resolution = resolveHumanActor({
        env: process.env,
        readGitConfig: readGitConfigForActor,
        isInteractiveHuman: isInteractiveHumanForActor(),
      });
      if (!resolution.ok) {
        emitFailure(resolution.code, resolution.message);
        return;
      }
      const humanActor = resolution.actor;

      // (2) Load session.
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      const from = session.snapshot.state?.sub_state;
      if (!from) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }

      // (3) Mutate. preflight step 5c.2 enforces reason-required; reducer
      //     flips cursor to DONE.abandoned.
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor: humanActor,
          entry_schema_version: 1,
          kind: "session:abandoned",
          payload: { reason: opts.reason },
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }

      // (4) Success output.
      const out = {
        ok: true,
        feature: opts.feature,
        from,
        to: "DONE.abandoned" as const,
        actor: humanActor,
        sub_state: result.snapshot.state?.sub_state,
      };
      ctx.success(
        out,
        () => "",
        {
          stateChange: `abandon: ${opts.feature} — ${from} → DONE.abandoned by ${humanActor} (reason='${opts.reason}')`,
        },
      );
    });

  // ── loaf spike <subcommand> ─────────────────────────────────────────
  // Phase 12 — spike-task exit `convert` (protocol §8.3). Record-only:
  // emits a 2-entry batch [spike:converted, session:archived]. The
  // spike:converted entry records {to_feature, reason}; the sponsored
  // session:archived owns the terminal cursor flip to DONE.archived. The
  // target feature F-N is opened later by a separate `loaf start` — this
  // command does NOT scaffold it. Precondition (preflight 5c.3):
  // SPIKE_CONVERT_NO_SPIKE_TASK if the session holds no non-abandoned
  // kind=spike task.
  const spikeCmd = program
    .command("spike")
    .description("Spike-task exits (protocol §8.3)");

  spikeCmd
    .command("convert")
    .description(
      "Convert a spike session — emits spike:converted then archives to DONE.archived",
    )
    .option("--feature <name>", "Feature whose spike session to convert")
    .requiredOption(
      "--to-feature <id>",
      "Target feature id (F-NNN) the spike learnings carry into",
    )
    .requiredOption("--reason <text>", "Rationale recorded on the spike:converted entry")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
      async (opts: {
        feature: string;
        toFeature: string;
        reason: string;
        featureDir?: string;
      }) => {
        // (1) Human-only actor — `spike:converted` is HUMAN_ONLY per PER_KIND_ACTOR.
        const resolution = resolveHumanActor({
          env: process.env,
          readGitConfig: readGitConfigForActor,
          isInteractiveHuman: isInteractiveHumanForActor(),
        });
        if (!resolution.ok) {
          emitFailure(resolution.code, resolution.message);
          return;
        }
        const humanActor = resolution.actor;

        // (2) Load session.
        const featureDir = await dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
        const from = session.snapshot.state?.sub_state;
        if (!from) {
          emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
          return;
        }

        // (3) Mutate — 2-entry batch. spike:converted (record-only) MUST
        //     precede session:archived: it carries ANY_NON_DONE authority and
        //     would be rejected against the post-archive DONE snapshot. The
        //     sponsored session:archived performs the terminal cursor flip.
        const now = new Date().toISOString();
        const result = await mutateBatch(
          [
            {
              at: now,
              actor: humanActor,
              entry_schema_version: 1,
              kind: "spike:converted",
              payload: { to_feature: opts.toFeature, reason: opts.reason },
            },
            {
              at: now,
              actor: humanActor,
              entry_schema_version: 1,
              kind: "session:archived",
              payload: { reason: opts.reason },
            },
          ],
          { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
        );
        if (!result.ok) {
          emitFailure(result.code, result.message, result.detail);
          return;
        }
        if (ctx.dryRun) {
          emitDryRunSuccess(result);
          return;
        }

        // (4) Success output.
        const out = {
          ok: true,
          feature: opts.feature,
          to_feature: opts.toFeature,
          from,
          to: "DONE.archived" as const,
          actor: humanActor,
          sub_state: result.snapshot.state?.sub_state,
        };
        ctx.success(
          out,
          () => "",
          {
            stateChange: `spike convert: ${opts.feature} → ${opts.toFeature} — ${from} → DONE.archived by ${humanActor}`,
          },
        );
      },
    );

  // ── loaf profile <subcommand> ───────────────────────────────────────
  // Phase 13 — `profile escalate` applies a ceremony escalation (protocol
  // §10.8 / §1918). Escalation POLICY (which preset to escalate to) is a
  // skill concern (schemas.ts §24): the skill computes the new 6-flag
  // Ceremony and passes it via --input. This command does the atomic
  // [event:ceremony_set, pending:resolved] batch + the ESCALATION_NOT_PENDING
  // head guard. event:ceremony_set is ordered FIRST so preflight 5c.4 still
  // sees the unresolved profile_escalation head before pending:resolved
  // pops it.
  const profileCmd = program
    .command("profile")
    .description("Ceremony profile commands (protocol §10.8)");

  profileCmd
    .command("escalate")
    .description(
      "Apply a ceremony escalation — resolve the profile_escalation pending + emit event:ceremony_set",
    )
    .requiredOption("--confirm", "Human acceptance of the escalation (required)")
    .requiredOption("--input <path>", "JSON file with the escalated 6-flag Ceremony object")
    .option("--feature <name>", "Feature whose session to escalate")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
      async (opts: {
        confirm: boolean;
        input: string;
        feature: string;
        featureDir?: string;
      }) => {
        // SC-6b — record trace target at action entry so input-read /
        // schema-parse failures still trace. SC-8: dispatchOrFail
        // resolves §10.3 precedence + mutates opts.feature/featureDir
        // + records traceTarget (replaces the SC-6b raw recordTraceTarget).
        const earlyFeatureDir = await dispatchOrFail(opts);
        if (earlyFeatureDir === null) return;
        // (1) Human-only acceptance — escalation is a human decision.
        const resolution = resolveHumanActor({
          env: process.env,
          readGitConfig: readGitConfigForActor,
          isInteractiveHuman: isInteractiveHumanForActor(),
        });
        if (!resolution.ok) {
          emitFailure(resolution.code, resolution.message);
          return;
        }
        const humanActor = resolution.actor;

        // (2) Read + parse the escalated Ceremony. Schema validation is the
        //     mutateBatch preflight's job (PER_KIND_PAYLOAD = CeremonyPayload).
        let content: string;
        try {
          content = await fsP.readFile(opts.input, "utf8");
        } catch (err) {
          if ((err as { code?: string }).code === "ENOENT") {
            emitFailure("INPUT_FILE_NOT_FOUND", `input file does not exist: ${opts.input}`, {
              path: opts.input,
            });
          } else {
            emitFailure(
              "INPUT_FILE_NOT_FOUND",
              `cannot read input file ${opts.input}: ${String(err)}`,
              { path: opts.input },
            );
          }
          return;
        }
        let ceremony: unknown;
        try {
          ceremony = JSON.parse(content);
        } catch (err) {
          emitFailure(
            "SCHEMA_VALIDATION_FAILED",
            `input is not valid JSON: ${(err as Error).message}`,
          );
          return;
        }

        // (3) Load session.
        const featureDir = await dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
        const from = session.snapshot.state?.sub_state;
        if (!from) {
          emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
          return;
        }

        // (4) The pending:resolved entry needs the head id. Preflight 5c.4
        //     owns the authority check (head must be profile_escalation);
        //     this only handles the structural "no head at all" case, where
        //     no PEND-id exists to build the pending:resolved entry.
        const head = session.snapshot.pending.find((p) => !p.resolved);
        if (!head) {
          emitFailure(
            "ESCALATION_NOT_PENDING",
            "`loaf profile escalate --confirm --input <ceremony.json>` requires pending head kind=profile_escalation; current head: (none)",
            { actual_head: "(none)" },
          );
          return;
        }

        // (5) Mutate — 2-entry batch. event:ceremony_set MUST precede
        //     pending:resolved so preflight 5c.4 sees the unresolved head.
        const now = new Date().toISOString();
        const result = await mutateBatch(
          [
            {
              at: now,
              actor: humanActor,
              entry_schema_version: 1,
              kind: "event:ceremony_set",
              payload: ceremony as Record<string, unknown>,
            },
            {
              at: now,
              actor: humanActor,
              entry_schema_version: 1,
              kind: "pending:resolved",
              payload: { id: head.id },
            },
          ],
          { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
        );
        if (!result.ok) {
          emitFailure(result.code, result.message, result.detail);
          return;
        }
        if (ctx.dryRun) {
          emitDryRunSuccess(result);
          return;
        }

        // (6) Success output. The batch moves no cursor — sub_state unchanged.
        const out = {
          ok: true,
          feature: opts.feature,
          resolved_pending: head.id,
          sub_state: result.snapshot.state?.sub_state,
          actor: humanActor,
        };
        ctx.success(
          out,
          () => "",
          {
            stateChange: `profile escalate: ceremony updated, ${head.id} resolved`,
          },
        );
      },
    );

  // ── loaf doctor --rebuild ───────────────────────────────────────────
  // Phase 14 SC2. The only doctor mode this release: --rebuild does a full
  // journal replay (replayJournal from seq=0) and re-serializes the four
  // journal-derived snapshot projections + _meta.json via writeProjections
  // (Phase 14 SC1). The read-only check suite (bare `loaf doctor`, §10.15)
  // + the other sub-flags (--check-tail / --migrate-v2 / --scope /
  // --verify-checksum) are later slices.
  //
  // Exit codes (Phase 16 SC-2 normalization, was codex r160 pre-normalization):
  //   0 = rebuilt OK
  //   2 = every catalogued failure (unreplayable journal, unsupported
  //       migrated journal, serialization/write failure, missing --feature,
  //       bare `doctor` without an implemented mode). All routed through
  //       emitFailure to keep ERROR_CATALOG ⇔ runtime exit_code in agreement
  //       (docs/schemas.ts:5042-5063 lists DOCTOR_REBUILD_FAILED /
  //       DOCTOR_REBUILD_MIGRATED_UNSUPPORTED with exit_code: 2).
  //   Exit 1 is reserved for unhandled throws caught by the top-level
  //   boundary at the end of main(), which also writes ~/.loaf/crashes/.
  // No per-feature lock — the repo runs under the single-writer assumption
  // (no .lock infra; F-014 r112; protocol.md §11.2 step 1/8/9/10 deferred).
  program
    .command("doctor")
    .description("Repository self-check. This release implements --rebuild only")
    .option("--rebuild", "Full journal replay → rebuild snapshots/*.json + _meta.json")
    .option("--feature <name>", "Feature whose snapshots to rebuild (required with --rebuild)")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { rebuild?: boolean; feature?: string; featureDir?: string }) => {
      // SC-6c: doctor is read-only at this slice (--rebuild writes
      // projections directly, NOT via mutate(); a dry-run rebuild would
      // need a real in-memory replay precheck — out-of-scope per
      // codex r275 P2). Both bare doctor and --rebuild reject under
      // --dry-run with the same code.
      if (rejectIfDryRun(opts.rebuild ? "doctor --rebuild" : "doctor")) return;

      if (!opts.rebuild) {
        emitFailure(
          "DOCTOR_MODE_NOT_IMPLEMENTED",
          "only --rebuild is implemented for loaf doctor in this release",
        );
        return;
      }

      // --feature is validated AFTER mode selection so a literal bare
      // `loaf doctor` surfaces DOCTOR_MODE_NOT_IMPLEMENTED, not a
      // missing-feature error — `--feature` is a Commander `.option`, not
      // `.requiredOption`, precisely so mode is checked first (codex r161).
      if (!opts.feature) {
        emitFailure(
          "DOCTOR_FEATURE_REQUIRED",
          "doctor --rebuild requires --feature <name>",
        );
        return;
      }

      // SC-8: doctor --rebuild bypasses ctx.resolveDispatch because the
      // whole point of `doctor --rebuild` is to recover from corrupt
      // state projections. Going through dispatch would prematurely
      // surface NoSession/SnapshotStale before the rebuild logic gets
      // a chance to read the raw journal and re-derive projections.
      // Compute featureDir directly + record trace target manually.
      // no-dispatch (sc8-dispatch-gate exception marker)
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      ctx.recordTraceTarget(opts.feature, featureDir);
      const journalPath = path.join(featureDir, "journal.jsonl");
      const replay = await replayJournal(journalPath, {
        collect_entries: true,
        feature_dir: featureDir,
      });
      if (!replay.ok) {
        emitFailure(
          replay.code,
          `journal at ${journalPath} cannot be replayed — ${replay.message}`,
        );
        return;
      }
      const entries = replay.entries;
      if (entries === undefined) {
        emitFailure(
          "DOCTOR_REBUILD_FAILED",
          "internal invariant: replay returned ok without collected entries",
        );
        return;
      }

      // A v0.0.x-migrated journal carries its projection state through
      // `migration:snapshot_imported` sidecar rehydration, not the event
      // payloads the SC1 serializer folds — rebuilding one is a follow-up
      // intersecting `doctor --migrate-v2` (F-018). Fail cleanly before
      // writeProjections rather than let composeTasksJson throw.
      if (entries.some((e) => e.kind === "migration:snapshot_imported")) {
        emitFailure(
          "DOCTOR_REBUILD_MIGRATED_UNSUPPORTED",
          "doctor --rebuild does not yet support v0.0.x-migrated journals (intersects doctor --migrate-v2)",
        );
        return;
      }

      let rebuilt: string[];
      try {
        rebuilt = await writeProjections(featureDir, {
          snapshot: replay.snapshot,
          entries,
          meta: replay.meta,
        });
      } catch (err) {
        emitFailure(
          "DOCTOR_REBUILD_FAILED",
          `snapshot rebuild failed — ${(err as Error).message}`,
        );
        return;
      }

      const out = {
        ok: true,
        feature: opts.feature,
        feature_dir: featureDir,
        tail_seq: replay.meta.last_applied_seq,
        rebuilt,
      };
      ctx.success(
        out,
        () =>
          `rebuilt ${rebuilt.length} projection file(s) for ${opts.feature}:\n` +
          rebuilt.map((f) => `  snapshots/${f}\n`).join("") +
          `# snapshot as-of seq=${replay.meta.last_applied_seq}\n`,
        {
          stateChange: `doctor rebuild: rebuilt ${rebuilt.length} projection file(s) for ${opts.feature}`,
        },
      );
    });

  // ── loaf tasks <subcommand> ─────────────────────────────────────────
  // Slice 2 SC2/SC3 task lifecycle CLI surface. The parent `tasks`
  // command is a namespace; sub-commands carry the actual work:
  //   submit <file>          — emit event:tasks_planned (SC2)
  //   claim <task-id>        — emit event:task_claimed (SC3)
  //   step start             — emit event:task_step_started (SC3)
  //   step done              — emit event:task_step_done (SC3)
  // All preconditions enforced by SC1 preflight step 5e (TASK_NOT_FOUND
  // / TASK_NOT_CLAIMABLE / TASK_ALREADY_CLAIMED / TASK_DEPS_NOT_SATISFIED
  // / TASK_NOT_CLAIMED).
  const tasksCmd = program
    .command("tasks")
    .description("Task lifecycle commands (Slice 2 MVP: submit / claim / step)");

  // ── loaf tasks submit --input <src> ─────────────────────────────────
  // Slice 2 SC2. Reads a JSON document `{ based_on, tasks }`, emits
  // event:tasks_planned (whole-replacement at SPEC.design; per protocol
  // §1810). PER_KIND_PAYLOAD strict-validates payload during preflight —
  // CLI passes parsed JSON through directly (single-source via preflight).
  //
  // Input shape (codex r57 acceptance — no bare-array fallback):
  //   { "based_on": { "spec": 1 }, "tasks": [ <TaskFullPayload>, ... ] }
  //
  // Actor: cli:loaf — submit is machine-driven (CLI just routes input to
  // mutate; no human decision encoded in the entry).
  //
  // Failure paths:
  //   - file missing            → INPUT_FILE_NOT_FOUND (CLI-side)
  //   - JSON parse fail         → SCHEMA_VALIDATION_FAILED (CLI-side)
  //   - payload schema violation → INVALID_PAYLOAD (preflight)
  //   - wrong sub_state          → SUB_STATE_AUTHORITY_VIOLATION (preflight)
  //   - no session               → NO_SESSION (CLI-side)
  tasksCmd
    .command("submit")
    .description("Submit a complete task graph from --input <src> (stdin / inline JSON / file path; whole-graph single object)")
    .requiredOption(
      "--input <src>",
      "JSON source: `-` (stdin), inline JSON literal, or file path (protocol §10.7). Whole-graph single object only.",
    )
    .option("--feature <name>", "Feature whose task graph to submit")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { input: string; feature: string; featureDir?: string }) => {
      // Phase 16 SC-4b — unified --input modality (protocol §10.7).
      const source = parseInputSource(opts.input);
      if (source.kind === "stdin" && isStdinTty()) {
        ctx.failure(
          "USAGE",
          "stdin is TTY — `loaf tasks submit --input -` expects piped input. " +
            "Pipe JSON via `... | loaf tasks submit --input -`, OR pass inline " +
            "JSON / file path. Run --help for examples.",
        );
        return;
      }
      const read = await readJsonInput(source, { readStdin });
      if (!read.ok) {
        ctx.failure(read.code, read.message, read.detail);
        return;
      }
      const payload = read.value;

      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await ctx.resolveSession(featureDir);
      if (!session.snapshot.state) {
        ctx.failure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }

      // Mutate. Preflight validates TasksPlannedPayload + sub_state +
      // duplicate task ids + reducer dry-run + final-validate. CLI does
      // not duplicate any of that.
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor,
          entry_schema_version: 1,
          kind: "event:tasks_planned",
          payload: payload as Record<string, unknown>,
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
      );
      if (!result.ok) {
        ctx.failure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }

      // Success output via ctx.success — output bytes identical to
      // pre-SC-4b shape (asserted via existing tasks-submit tests).
      const tasks = result.snapshot.tasks;
      const taskIds = tasks.map((t) => t.id);
      const out = {
        ok: true,
        feature: opts.feature,
        sub_state: result.snapshot.state?.sub_state,
        tasks_count: tasks.length,
        task_ids: taskIds,
        tasks_based_on: result.snapshot.tasks_based_on,
      };
      ctx.success(
        out,
        () =>
          `submitted ${tasks.length} task${tasks.length === 1 ? "" : "s"}: ${taskIds.join(", ")}\n`,
        {
          stateChange: `tasks submit: ${tasks.length} tasks`,
          next: "loaf advance",
        },
      );
    });

  // ── loaf tasks add --input <src> [--finding <FND-N>] ────────────────
  // Slice C SC-C3 + Phase 11 Item 3 SC1b. Two surfaces, gated by --finding:
  //
  // (a) UNSPONSORED — `tasks add --input <src>` at SPEC.design (no --finding).
  //     Appends id-less task(s) to the graph, the append variant of
  //     `tasks submit` (codex r111 Q6). Emits ONE whole-replacement
  //     event:tasks_planned (protocol §1818 / emit table L1886):
  //     payload.tasks is the re-materialized existing graph plus the
  //     newly seeded tasks. The existing graph is reconstructed from the
  //     journal — latestCanonicalTaskBody recovers each task's canonical
  //     body, materializeTaskForAmend overlays live runtime status. A
  //     task with no journal body (migration-imported) is a hard stop —
  //     CANONICAL_TASK_BODY_UNAVAILABLE — never synthesize fields.
  //
  // (b) SPONSORED — `tasks add --input <src> --finding <FND-N>` at EXECUTE.work.
  //     Post-back-edge graph amend: emits one event:tasks_amended
  //     mode="add" + sponsored_by_finding_id PER added task (a mutateBatch
  //     when the input has several). Preflight §8.6 verifies the finding
  //     is open with action=amend-tasks (SC1b sponsored branch).
  //
  // --finding at SPEC.design → USAGE reject (the unsponsored path is
  // whole-graph tasks_planned, not sponsored). No --finding outside
  // SPEC.design → SUB_STATE_AUTHORITY_VIOLATION as before.
  //
  // The CLI allocates each T-id (max-serial+1, zero-pad ≥3) — input must
  // NOT carry `id` (protocol §706). T-id allocation uses the same
  // loadSession→max+1→mutate pattern as the other id allocators; no
  // `.lock` yet (Slice 5), single-writer assumption (codex r112).
  tasksCmd
    .command("add")
    .description("Append id-less task(s) to the graph — --input <src> with single object or array (batch); SPEC.design whole-graph, or EXECUTE.work sponsored via --finding")
    .option(
      "--input <src>",
      "JSON source for TaskInput (single object or array): `-` (stdin), inline JSON, or file path (protocol §10.7)",
    )
    .option("--schema", "Dump the input JSON Schema instead of mutating (Phase 16 SC-10)")
    .option("--feature <name>", "Feature whose task graph to extend")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .option("--finding <FND-N>", "Sponsoring amend-tasks finding (sponsored add at EXECUTE.work)")
    .action(async (rawOpts: { input?: string; schema?: boolean; feature: string; featureDir?: string; finding?: string }) => {
      if (rawOpts.schema === true) {
        if (rejectIfDryRun("tasks add --schema")) return;
        emitMutatorSchemaAndExit("tasks:add");
        return;
      }
      if (rawOpts.input === undefined) {
        emitFailure(
          "MISSING_INPUT",
          "loaf tasks add requires --input <src> (or pass --schema to dump the input JSON Schema)",
        );
        return;
      }
      const opts = rawOpts as { input: string; feature: string; featureDir?: string; finding?: string };
      // Phase 16 SC-4b — unified --input modality (protocol §10.7).
      const source = parseInputSource(opts.input);
      if (source.kind === "stdin" && isStdinTty()) {
        ctx.failure(
          "USAGE",
          "stdin is TTY — `loaf tasks add --input -` expects piped input. " +
            "Pipe JSON via `... | loaf tasks add --input -`, OR pass inline " +
            "JSON / file path. Run --help for examples.",
        );
        return;
      }
      const read = await readJsonInput(source, { readStdin });
      if (!read.ok) {
        ctx.failure(read.code, read.message, read.detail);
        return;
      }
      const parsed = read.value;

      // Normalize to an array; validate each against the strict TaskInput
      // schema. TaskInput omits id / status / execution (CLI-owned);
      // `.strict()` rejects a caller that supplies any of them — the
      // shape-enforcement point of ADR-0004 (codex r113).
      const rawTasks: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      if (rawTasks.length === 0) {
        ctx.failure("SCHEMA_VALIDATION_FAILED", "tasks add input is an empty array");
        return;
      }
      const validatedInputs: TaskInput[] = [];
      for (const raw of rawTasks) {
        const p = TaskInput.safeParse(raw);
        if (!p.success) {
          ctx.failure(
            "SCHEMA_VALIDATION_FAILED",
            `tasks add input is not a valid id-less task (omit id / status / execution): ${p.error.issues.map((i) => i.message).join("; ")}`,
            { issues: p.error.issues },
          );
          return;
        }
        validatedInputs.push(p.data);
      }

      // Load session; resolve the surface (unsponsored vs sponsored).
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await ctx.resolveSession(featureDir);
      if (!session.snapshot.state) {
        ctx.failure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const subState = session.snapshot.state.sub_state;
      const sponsored = opts.finding !== undefined;
      // --finding is the EXECUTE.work sponsored path; SPEC.design is the
      // unsponsored whole-graph path. Reject the cross-product explicitly
      // rather than silently ignoring the flag (codex r136 Q6).
      if (sponsored && subState === "SPEC.design") {
        ctx.failure(
          "USAGE",
          "--finding is for the sponsored EXECUTE.work add; at SPEC.design `tasks add` is the unsponsored whole-graph path — drop --finding",
        );
        return;
      }
      if (!sponsored && subState !== "SPEC.design") {
        ctx.failure(
          "SUB_STATE_AUTHORITY_VIOLATION",
          `loaf tasks add without --finding is only valid at SPEC.design (current sub_state=${subState}); post-lock task additions go through \`loaf finding raise --action amend-tasks\` then \`tasks add --finding\``,
          { sub_state: subState },
        );
        return;
      }

      // (4) Allocate T-ids. Existing ids must all be canonical T-NNN — a
      // non-canonical id cannot participate in collision-safe allocation
      // (codex r112: fail loud, do not skip).
      let maxSerial = 0;
      for (const t of session.snapshot.tasks) {
        const m = /^T-(\d{3,})$/.exec(t.id);
        if (!m) {
          ctx.failure(
            "REDUCER_ERROR",
            `internal: task id ${t.id} in the projection is not canonical T-NNN; cannot allocate the next id`,
            { task_id: t.id },
          );
          return;
        }
        const n = Number.parseInt(m[1]!, 10);
        if (n > maxSerial) maxSerial = n;
      }
      // Materialize each validated input into a full TaskFull — the CLI
      // stamps the allocated id, status="pending", and the per-kind
      // execution map (all steps applicability="must", status="pending").
      const seededNew = validatedInputs.map((input, i) =>
        materializeTaskInput(input, `T-${String(maxSerial + 1 + i).padStart(3, "0")}`),
      );
      const newIds = seededNew.map((t) => t.id);

      if (sponsored) {
        // (5s) SPONSORED — emit one event:tasks_amended mode="add" +
        // sponsored_by_finding_id per added task (a mutateBatch when the
        // input carries several). Preflight §8.6 verifies the finding is
        // open with action=amend-tasks; the reducer dry-run appends each
        // task and rejects a duplicate id.
        const sponsoredBatch: Parameters<typeof mutateBatch>[0] = seededNew.map(
          (task) => ({
            at: new Date().toISOString(),
            actor,
            entry_schema_version: 1,
            kind: "event:tasks_amended",
            payload: {
              mode: "add",
              task,
              sponsored_by_finding_id: opts.finding,
            },
          }),
        );
        const result = await mutateBatch(sponsoredBatch, {
          feature_dir: featureDir,
          snapshot: session.snapshot,
          tail_seq: session.tail_seq,
          entries: session.entries,
          meta: session.meta,
          dryRun: ctx.dryRun,
          registryWriter: registryWriterDeps,
        });
        if (!result.ok) {
          ctx.failure(result.code, result.message, result.detail);
          return;
        }
        if (ctx.dryRun) {
          emitDryRunSuccess(result);
          return;
        }
        const out = {
          ok: true,
          feature: opts.feature,
          task_ids: newIds,
          sponsored_by_finding_id: opts.finding,
          tasks_count: result.snapshot.tasks.length,
          sub_state: result.snapshot.state?.sub_state,
        };
        ctx.success(
          out,
          () =>
            `added ${newIds.length} task${newIds.length === 1 ? "" : "s"} (sponsored by ${opts.finding}): ${newIds.join(", ")}\n`,
          {
            stateChange: `tasks add: +${newIds.length} tasks (allocated ${newIds.join(",")})`,
          },
        );
        return;
      }

      // (5u) UNSPONSORED — re-materialize every existing task to its
      // canonical full body. tasks_planned is whole-replacement, so the
      // re-emit must carry the complete graph; the slim projection alone
      // would erase body fields.
      const existingFull: TaskFullPayload[] = [];
      for (const t of session.snapshot.tasks) {
        const base = latestCanonicalTaskBody(session.entries, t.id);
        if (!base) {
          ctx.failure(
            "CANONICAL_TASK_BODY_UNAVAILABLE",
            `task ${t.id} is in the projection but has no canonical body in the journal (migration-imported); cannot rebuild the graph to append`,
            { task_id: t.id, source: "migration" },
          );
          return;
        }
        existingFull.push(materializeTaskForAmend(base, t));
      }

      // (6) Emit one whole-replacement event:tasks_planned. based_on carries
      // forward the spec version the graph derives from.
      const based_on = session.snapshot.tasks_based_on ?? {
        spec: session.snapshot.state.spec_version,
      };
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor,
          entry_schema_version: 1,
          kind: "event:tasks_planned",
          payload: { based_on, tasks: [...existingFull, ...seededNew] },
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
      );
      if (!result.ok) {
        ctx.failure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }

      // (7) Success output — echo the allocated ids for shell scripting.
      const out = {
        ok: true,
        feature: opts.feature,
        task_ids: newIds,
        tasks_count: result.snapshot.tasks.length,
        sub_state: result.snapshot.state?.sub_state,
      };
      ctx.success(
        out,
        () =>
          `added ${newIds.length} task${newIds.length === 1 ? "" : "s"}: ${newIds.join(", ")}\n`,
        {
          stateChange: `tasks add: +${newIds.length} tasks (allocated ${newIds.join(",")})`,
        },
      );
    });

  // ── loaf tasks claim <task-id> ──────────────────────────────────────
  // Slice 2 SC3. Emits `event:task_claimed` for a pending/ready task at
  // EXECUTE.work. SC1 preflight step 5e enforces existence + claimability
  // + deps_on satisfied (TASK_NOT_FOUND / TASK_NOT_CLAIMABLE /
  // TASK_ALREADY_CLAIMED / TASK_DEPS_NOT_SATISFIED). Reducer flips
  // status to in_progress; subsequent step_started/step_done can proceed.
  // Actor: cli:loaf — claim is machine-driven (worker pulls task).
  tasksCmd
    .command("claim <task-id>")
    .description("Claim a ready task (pending → in_progress) at EXECUTE.work")
    .option("--feature <name>", "Feature whose task to claim")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (taskId: string, opts: { feature: string; featureDir?: string }) => {
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor,
          entry_schema_version: 1,
          kind: "event:task_claimed",
          payload: { task_id: taskId },
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }
      // Read the actual claimed task status from the reducer-applied snapshot
      // (codex r60 P2.1 + r61 BLOCK closure): fail-fast if the post-mutate
      // lookup misses. Preflight + reducer guarantee task exists on success,
      // so a missing lookup is an internal contract violation — match the
      // fail-fast pattern step start / step done use, instead of silently
      // falling back to a hardcoded status.
      const claimed = result.snapshot.tasks.find((t) => t.id === taskId);
      if (!claimed) {
        emitFailure(
          "REDUCER_ERROR",
          `internal: task ${taskId} missing from snapshot after successful task_claimed apply`,
        );
        return;
      }
      const status = claimed.status;
      const out = {
        ok: true,
        feature: opts.feature,
        task_id: taskId,
        status,
        sub_state: result.snapshot.state?.sub_state,
      };
      ctx.success(
        out,
        () => "",
        { stateChange: `tasks claim: ${taskId} (status=${status})` },
      );
    });

  // ── loaf tasks abandon <task-id> --reason "..." ─────────────────────
  // Item 1. Emits `event:task_abandoned` for a non-terminal task at
  // EXECUTE.work. Preflight step 5e.3 enforces existence + abandonability
  // (TASK_NOT_FOUND / TASK_NOT_ABANDONABLE / TASK_ABANDON_BLOCKED_DEPENDENTS).
  // Reducer flips status → abandoned; the journal payload carries the why.
  // Actor: cli:loaf — per-kind authority is ALL_NON_MIGRATION (not
  // human-only), so abandon is machine-driven like claim, no human actor
  // resolution.
  tasksCmd
    .command("abandon <task-id>")
    .description("Abandon a non-terminal task (→ abandoned) at EXECUTE.work")
    .requiredOption("--reason <text>", "Why the task is being abandoned (required)")
    .option("--feature <name>", "Feature whose task to abandon")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
      async (
        taskId: string,
        opts: { reason: string; feature: string; featureDir?: string },
      ) => {
        const featureDir = await dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
        if (!session.snapshot.state) {
          emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
          return;
        }
        const result = await mutate(
          {
            at: new Date().toISOString(),
            actor,
            entry_schema_version: 1,
            kind: "event:task_abandoned",
            payload: { task_id: taskId, reason: opts.reason },
          },
          { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
        );
        if (!result.ok) {
          emitFailure(result.code, result.message, result.detail);
          return;
        }
        if (ctx.dryRun) {
          emitDryRunSuccess(result);
          return;
        }
        // Read the abandoned task status from the reducer-applied snapshot;
        // fail-fast if the post-mutate lookup misses (preflight + reducer
        // guarantee the task exists on success — same pattern as claim).
        const abandoned = result.snapshot.tasks.find((t) => t.id === taskId);
        if (!abandoned) {
          emitFailure(
            "REDUCER_ERROR",
            `internal: task ${taskId} missing from snapshot after successful task_abandoned apply`,
          );
          return;
        }
        const status = abandoned.status;
        const out = {
          ok: true,
          feature: opts.feature,
          task_id: taskId,
          status,
          sub_state: result.snapshot.state?.sub_state,
        };
        ctx.success(
          out,
          () => "",
          { stateChange: `tasks abandon: ${taskId} (status=${status})` },
        );
      },
    );

  // ── loaf tasks list [--status <s>] [--format json] ──────────────────
  // Slice 2 SC4. Read-only snapshot dump of `snapshot.tasks`. Computes
  // the derived `ready: boolean` column per Option C arch (codex r57):
  //   ready = status === "pending" && depends_on.every(dep_done)
  // No journal entry emitted. Optional `--status <s>` filter narrows
  // output to tasks whose status matches the filter (pending / ready /
  // in_progress / done / abandoned). Text mode: one line per task with
  // stable columns `<T-id> <kind> <status> [ready]`. JSON: full slim
  // TaskState array + derived ready boolean per task.
  tasksCmd
    .command("list")
    .description("List tasks (read-only); shows derived `ready` column")
    .option("--feature <name>", "Feature whose tasks to list")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .option(
      "--status <s>",
      "Filter by task status (pending|ready|in_progress|done|abandoned)",
    )
    .action(async (opts: { feature: string; featureDir?: string; status?: string }) => {
      if (rejectIfDryRun("tasks list")) return;
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      // Phase 15 SC3 — projection-loader read-path. Adapter: TasksJson
      // (TaskFullPayload[]) → slim TaskState via the same `extractTaskSlim`
      // the reducer uses, preserving byte-equal output with the prior
      // loadSession-derived shape. tasks: null (writer skips when no plan)
      // surfaces as count=0 + tasks:[] — codex r173 minimum case.
      const loaded = await loadProjectionsOrFail(
        featureDir,
        ["state", "tasks"] as const,
        opts.feature,
      );
      if (loaded === null) return;
      const slimTasks = loaded.tasks
        ? loaded.tasks.tasks.map((t) =>
            extractTaskSlim(t as unknown as TaskFullProjection),
          )
        : [];
      const tasksById = new Map(slimTasks.map((t) => [t.id, t]));
      const withDerived = slimTasks.map((t) => {
        const depsAllDone =
          t.depends_on.length === 0 ||
          t.depends_on.every((d) => tasksById.get(d)?.status === "done");
        return {
          ...t,
          ready: t.status === "pending" && depsAllDone,
        };
      });

      // Apply --status filter (codex r60 P2 wording: validate filter
      // value client-side for actionable USAGE error).
      const validStatuses = ["pending", "ready", "in_progress", "done", "abandoned"] as const;
      if (opts.status !== undefined && !(validStatuses as readonly string[]).includes(opts.status)) {
        emitFailure(
          "USAGE",
          `--status must be one of: ${validStatuses.join(" | ")} (got ${opts.status})`,
        );
        return;
      }
      // "ready" status filter matches derived ready=true (since no task
      // ever persists status="ready" per Option C arch — codex r57).
      const filtered = withDerived.filter((t) => {
        if (!opts.status) return true;
        if (opts.status === "ready") return t.ready;
        return t.status === opts.status;
      });

      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          count: filtered.length,
          tasks: filtered,
        },
        () => {
          if (filtered.length === 0) {
            return opts.status
              ? `no tasks match --status=${opts.status}\n`
              : `no tasks in projection (run \`loaf tasks submit\` first)\n`;
          }
          return filtered
            .map((t) => `${t.id} ${t.kind} ${t.status}${t.ready ? " [ready]" : ""}\n`)
            .join("");
        },
      );
    });

  // ── loaf tasks next ─────────────────────────────────────────────────
  // Slice 2 SC4. Computes the next ready task (status=pending +
  // depends_on all done). Returns first match in journal order. No
  // journal entry emitted. Exits 0 with empty stdout when no ready
  // task exists (caller scripts can use this as a sentinel).
  tasksCmd
    .command("next")
    .description("Print the next ready task id (or empty if none); read-only")
    .option("--feature <name>", "Feature whose ready task to compute")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      if (rejectIfDryRun("tasks next")) return;
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const tasks = session.snapshot.tasks;
      const tasksById = new Map(tasks.map((t) => [t.id, t]));
      const ready = tasks.find((t) => {
        if (t.status !== "pending") return false;
        return (
          t.depends_on.length === 0 ||
          t.depends_on.every((d) => tasksById.get(d)?.status === "done")
        );
      });
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          task_id: ready?.id ?? null,
          kind: ready?.kind ?? null,
        },
        () => (ready ? `${ready.id}\n` : ""),
      );
    });

  // ── loaf tasks complete <task-id> ───────────────────────────────────
  // Slice C SC-C1. NO-OP confirmation command (codex r101 Q2=a): emits NO
  // journal entry. `event:task_step_done` already auto-promotes a task to
  // status=done once every must-applicable step is terminal-positive
  // (passed | waived | na — see shouldPromoteToDone). `tasks complete`
  // therefore only confirms that invariant: exit 0 when task.status=done,
  // else TASK_COMPLETE_PRECONDITION_VIOLATED exit 2 listing the
  // must-applicable steps that are not yet terminal-positive.
  //
  // Read-only — no mutate(), no sub_state gate (it appends nothing). The
  // protocol §1869 emit-table row mapping `tasks complete → task_step_done`
  // is corrected in the same commit (the auto-promote path made an explicit
  // completion entry redundant).
  tasksCmd
    .command("complete <task-id>")
    .description("Confirm a task has reached status=done (read-only; emits nothing)")
    .option("--feature <name>", "Feature whose task to confirm")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (taskId: string, opts: { feature: string; featureDir?: string }) => {
      if (rejectIfDryRun("tasks complete")) return;
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const task = session.snapshot.tasks.find((t) => t.id === taskId);
      if (!task) {
        emitFailure(
          "TASK_NOT_FOUND",
          `task ${taskId} is not in the current tasks projection`,
          { task_id: taskId },
        );
        return;
      }
      if (task.status !== "done") {
        // Enumerate the must-applicable steps that block auto-promote so the
        // caller knows exactly what is still owed (codex r101 Q2 detail).
        const TERMINAL_POSITIVE = ["passed", "waived", "na"];
        const blockingSteps = Object.entries(task.steps)
          .filter(
            ([, s]) => s.applicability === "must" && !TERMINAL_POSITIVE.includes(s.status),
          )
          .map(([name]) => name);
        emitFailure(
          "TASK_COMPLETE_PRECONDITION_VIOLATED",
          `task ${taskId} is not complete (status=${task.status}); must-applicable steps not terminal-positive: ${blockingSteps.join(", ") || "(none — task has no must steps to auto-promote)"}`,
          { task_id: taskId, status: task.status, blocking_steps: blockingSteps },
        );
        return;
      }
      const out = {
        ok: true,
        feature: opts.feature,
        task_id: taskId,
        status: task.status,
      };
      ctx.success(out, () => `${taskId} complete (status=done)\n`);
    });

  // ── loaf tasks amend <task-id> (--policy ... | --input <src> --finding) ──
  // Two surfaces, mutually exclusive:
  //
  // (a) UNSPONSORED `--policy` (Slice C SC-C2c) — narrowly amends a task's
  //     execution[].applicability at EXECUTE.plan (protocol §1822 / §8.6).
  //     `--policy` is repeatable; each value is `<step>=<must|optional|na>`.
  //     The CLI rebuilds the full payload from the journal:
  //       latestCanonicalTaskBody(journal) → materializeTaskForAmend(+ live
  //       runtime status) → apply the --policy applicability deltas.
  //     Emits event:tasks_amended mode="replace" (no sponsorship marker).
  //
  // (b) SPONSORED `--input <file> --finding <FND-N>` (Phase 11 Item 3 SC1b)
  //     — a structured-input graph replacement at EXECUTE.work after an
  //     amend-tasks finding back-edge. The input file is the NEW id-less
  //     task definition; the CLI materializes it under the existing T-id,
  //     overlays current runtime progress via materializeTaskForAmend (so
  //     a retained step keeps its live status — Q4 frozen-field rule), and
  //     emits event:tasks_amended mode="replace" + sponsored_by_finding_id.
  //     Preflight §8.6 verifies the finding is open with action=amend-tasks
  //     and enforces the sponsored frozen-field split.
  //
  // --policy and --input are mutually exclusive (USAGE reject if both).
  //
  // Failure paths:
  //   - no flag at all / both flags          → USAGE (CLI)
  //   - no/ malformed / dup --policy         → SCHEMA_VALIDATION_FAILED (CLI)
  //   - --finding without --input (or vice versa) → USAGE (CLI)
  //   - unknown task                         → TASK_NOT_FOUND (CLI)
  //   - task in projection, no journal body  → CANONICAL_TASK_BODY_UNAVAILABLE
  //     (migration-imported task; codex r107 #3 — --policy path)
  //   - --policy step not in task.execution  → TASK_STEP_NOT_FOUND (CLI)
  //   - unsponsored amend outside EXECUTE.plan → MUTATION_OUT_OF_RIGHTS
  //   - sponsored amend outside EXECUTE.work / bad finding → preflight §8.6
  tasksCmd
    .command("amend <task-id>")
    .description("Amend a task: --policy <step>=<applicability> (EXECUTE.plan) or --input <file> --finding <FND-N> (sponsored, EXECUTE.work)")
    .option("--feature <name>", "Feature whose task to amend")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .option(
      "--policy <step=applicability>",
      "Step applicability override (must|optional|na); repeatable",
      (val: string, acc: string[]) => [...acc, val],
      [] as string[],
    )
    .option("--input <file>", "New id-less task definition for a sponsored graph replacement (JSON file or '-')")
    .option("--finding <FND-N>", "Sponsoring amend-tasks finding (required with --input)")
    .action(
      async (
        taskId: string,
        opts: {
          feature: string;
          featureDir?: string;
          policy: string[];
          input?: string;
          finding?: string;
        },
      ) => {
        // SC-6b — record trace target at action entry so long pre-validation
        // failures (input parse, policy/finding mutex) still trace.
        // SC-8: dispatchOrFail resolves §10.3 + records traceTarget.
        const earlyFeatureDir = await dispatchOrFail(opts);
        if (earlyFeatureDir === null) return;
        // (0) Resolve the surface — --policy and --input are mutually
        // exclusive; --finding pairs with --input.
        const policies = opts.policy ?? [];
        const hasPolicy = policies.length > 0;
        const hasInput = opts.input !== undefined;
        const hasFinding = opts.finding !== undefined;
        if (hasPolicy && hasInput) {
          emitFailure(
            "USAGE",
            "--policy and --input are mutually exclusive: --policy narrows applicability at EXECUTE.plan, --input replaces the task graph (sponsored) at EXECUTE.work",
          );
          return;
        }
        if (hasInput !== hasFinding) {
          emitFailure(
            "USAGE",
            "--input and --finding must be specified together — a sponsored graph replacement needs the sponsoring amend-tasks finding",
          );
          return;
        }
        if (!hasPolicy && !hasInput) {
          emitFailure(
            "USAGE",
            "tasks amend needs either --policy <step>=<applicability> or --input <src> --finding <FND-N>",
          );
          return;
        }

        // ── (b) SPONSORED --input path ──────────────────────────────────
        if (hasInput) {
          const inputPath = opts.input!;
          const findingId = opts.finding!;
          // Phase 16 SC-4b — unified --input modality (protocol §10.7).
          const source = parseInputSource(inputPath);
          if (source.kind === "stdin" && isStdinTty()) {
            ctx.failure(
              "USAGE",
              "stdin is TTY — `loaf tasks amend --input -` expects piped input. " +
                "Pipe JSON via `... | loaf tasks amend --input -`, OR pass inline " +
                "JSON / file path. Run --help for examples.",
            );
            return;
          }
          const read = await readJsonInput(source, { readStdin });
          if (!read.ok) {
            ctx.failure(read.code, read.message, read.detail);
            return;
          }
          const inParsed = read.value;
          const inTask = TaskInput.safeParse(inParsed);
          if (!inTask.success) {
            ctx.failure(
              "SCHEMA_VALIDATION_FAILED",
              `tasks amend --input is not a valid id-less task (omit id / status / execution): ${inTask.error.issues.map((i) => i.message).join("; ")}`,
              { issues: inTask.error.issues },
            );
            return;
          }
          // (b3) Load session via ctx; the task being replaced must exist.
          const sFeatureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
          const sSession = await ctx.resolveSession(sFeatureDir);
          if (!sSession.snapshot.state) {
            ctx.failure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
            return;
          }
          const sCurrent = sSession.snapshot.tasks.find((t) => t.id === taskId);
          if (!sCurrent) {
            ctx.failure(
              "TASK_NOT_FOUND",
              `task ${taskId} is not in the current tasks projection`,
              { task_id: taskId },
            );
            return;
          }
          // (b4) Recover the current canonical body from the journal. A
          // task in the projection but absent from every plan/amend entry
          // is migration-imported — its body lives only in the v0.0.x
          // snapshot, so a whole-task amend cannot preserve its execution
          // progress (codex r107 #3 — distinct from TASK_NOT_FOUND; mirrors
          // the --policy path).
          const sCanonical = latestCanonicalTaskBody(sSession.entries, taskId);
          if (!sCanonical) {
            emitFailure(
              "CANONICAL_TASK_BODY_UNAVAILABLE",
              `task ${taskId} is in the projection but has no canonical body in the journal (migration-imported); cannot amend in place`,
              { task_id: taskId, source: "migration" },
            );
            return;
          }
          // (b5) Materialize the input under the EXISTING task id, carry the
          // body-only execution progress forward from the canonical body for
          // retained steps (codex r136 Q4 — a sponsored graph amend must not
          // erase evidence_refs / started_at / step reason), then overlay
          // live runtime status/applicability via materializeTaskForAmend.
          // carryForwardStepProgress is the CLI-side guard for the body-only
          // fields the slim projection drops; materializeTaskForAmend handles
          // the slim status overlay; preflight §8.6 re-verifies the
          // slim-visible half (status / step set / step status).
          const sNewGraph = materializeTaskInput(inTask.data, taskId);
          // (b5.1) codex r137 BLOCK 2 — reject a sponsored replace that DROPS
          // a canonical step still carrying execution progress. Preflight's
          // slim-projection check (firstSponsoredFrozenViolation) rejects a
          // removed step with non-pending STATUS, but a `pending` step can
          // still hold body-only progress — evidence_refs / started_at /
          // reason — that the slim projection drops. This removed-step
          // body-only check is the canonical-body half of the Q4 locus split
          // (preflight owns the slim-visible half).
          const sNewSteps = new Set(Object.keys(sNewGraph.execution));
          const sPriorExec = sCanonical.execution as Record<
            string,
            { status: string; evidence_refs: string[]; started_at?: string; reason?: string }
          >;
          for (const [stepName, prior] of Object.entries(sPriorExec)) {
            if (sNewSteps.has(stepName)) continue;
            if (
              prior.status !== "pending" ||
              prior.evidence_refs.length > 0 ||
              prior.started_at !== undefined ||
              prior.reason !== undefined
            ) {
              ctx.failure(
                "MUTATION_OUT_OF_RIGHTS",
                `sponsored tasks amend on ${taskId} drops step '${stepName}', which carries ` +
                  `execution progress — a graph amend may not erase execution history (codex r136 Q4)`,
                { task_id: taskId, step: stepName, reason: "sponsored_amend_drops_progress_step" },
              );
              return;
            }
          }
          const sWithProgress = carryForwardStepProgress(sNewGraph, sCanonical);
          const sMaterialized = materializeTaskForAmend(sWithProgress, sCurrent);
          // (b6) Emit event:tasks_amended mode="replace" + sponsorship
          // marker. Preflight §8.6 sponsored branch does the rest.
          const sResult = await mutate(
            {
              at: new Date().toISOString(),
              actor,
              entry_schema_version: 1,
              kind: "event:tasks_amended",
              payload: {
                mode: "replace",
                task: sMaterialized,
                sponsored_by_finding_id: findingId,
              },
            },
            { feature_dir: sFeatureDir, snapshot: sSession.snapshot, tail_seq: sSession.tail_seq, entries: sSession.entries, meta: sSession.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
          );
          if (!sResult.ok) {
            ctx.failure(sResult.code, sResult.message, sResult.detail);
            return;
          }
          if (ctx.dryRun) {
            emitDryRunSuccess(sResult);
            return;
          }
          const sOut = {
            ok: true,
            feature: opts.feature,
            task_id: taskId,
            sponsored_by_finding_id: findingId,
            sub_state: sResult.snapshot.state?.sub_state,
          };
          ctx.success(
            sOut,
            () => `amended ${taskId} (sponsored by ${findingId})\n`,
            { stateChange: `amend: ${taskId}` },
          );
          return;
        }

        // ── (a) UNSPONSORED --policy path ───────────────────────────────
        // (1) Parse + validate --policy flags.
        const APPLICABILITY = ["must", "optional", "na"];
        const policyMap = new Map<string, string>();
        for (const p of policies) {
          const eq = p.indexOf("=");
          if (eq <= 0 || eq === p.length - 1) {
            emitFailure(
              "SCHEMA_VALIDATION_FAILED",
              `malformed --policy '${p}' — expected <step>=<applicability>`,
            );
            return;
          }
          const step = p.slice(0, eq);
          const applicability = p.slice(eq + 1);
          if (!APPLICABILITY.includes(applicability)) {
            emitFailure(
              "SCHEMA_VALIDATION_FAILED",
              `--policy '${p}': applicability must be one of must | optional | na`,
            );
            return;
          }
          if (policyMap.has(step)) {
            emitFailure(
              "SCHEMA_VALIDATION_FAILED",
              `--policy step '${step}' specified more than once`,
            );
            return;
          }
          policyMap.set(step, applicability);
        }

        // (2) Load session.
        const featureDir = await dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
        if (!session.snapshot.state) {
          emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
          return;
        }

        // (3) Current task must be in the projection.
        const current = session.snapshot.tasks.find((t) => t.id === taskId);
        if (!current) {
          emitFailure(
            "TASK_NOT_FOUND",
            `task ${taskId} is not in the current tasks projection`,
            { task_id: taskId },
          );
          return;
        }

        // (4) Recover the canonical full body from the journal. A task
        // present in the projection but absent from every plan/amend entry
        // is migration-imported — its body lives only in the v0.0.x
        // snapshot, so a whole-task amend cannot be reconstructed here
        // (codex r107 #3 — distinct from TASK_NOT_FOUND).
        const base = latestCanonicalTaskBody(session.entries, taskId);
        if (!base) {
          emitFailure(
            "CANONICAL_TASK_BODY_UNAVAILABLE",
            `task ${taskId} is in the projection but has no canonical body in the journal (migration-imported); cannot amend in place`,
            { task_id: taskId, source: "migration" },
          );
          return;
        }

        // (5) Materialize (canonical body + live runtime status) then apply
        // the --policy applicability deltas.
        const materialized = materializeTaskForAmend(base, current);
        const execution = materialized.execution as Record<
          string,
          { applicability: string }
        >;
        for (const [step, applicability] of policyMap) {
          const seeded = execution[step];
          if (!seeded) {
            emitFailure(
              "TASK_STEP_NOT_FOUND",
              `step '${step}' is not in task ${taskId}'s execution set`,
              { task_id: taskId, step },
            );
            return;
          }
          seeded.applicability = applicability;
        }

        // (6) Emit event:tasks_amended (mode=replace). Preflight §8.6
        // validates the change is applicability-only.
        const result = await mutate(
          {
            at: new Date().toISOString(),
            actor,
            entry_schema_version: 1,
            kind: "event:tasks_amended",
            payload: { mode: "replace", task: materialized },
          },
          { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
        );
        if (!result.ok) {
          emitFailure(result.code, result.message, result.detail);
          return;
        }
        if (ctx.dryRun) {
          emitDryRunSuccess(result);
          return;
        }

        // (7) Success output.
        const applied = [...policyMap].map(([s, a]) => `${s}=${a}`).join(", ");
        const out = {
          ok: true,
          feature: opts.feature,
          task_id: taskId,
          policy: Object.fromEntries(policyMap),
          sub_state: result.snapshot.state?.sub_state,
        };
        ctx.success(
          out,
          () => `amended ${taskId} (${applied})\n`,
          { stateChange: `amend: ${taskId}` },
        );
      },
    );

  // ── loaf tasks register-red <task-id> ───────────────────────────────
  // Slice C SC-C4 (R2). Records that the failing RED test for a
  // behavioral bug task is in place. Emits one
  //   event:task_step_done { step:"red", result:"passed", red_test_registered:true }
  // which the reducer promotes to task-level red_test_registered=true.
  // Until then the bug task's `implement` step is gated by preflight's
  // BUG_TASK_REQUIRES_RED. Ordering is claim → register-red → step
  // implement; the failure surface is entirely preflight's:
  //   - unknown task            → TASK_NOT_FOUND
  //   - task not claimed        → TASK_NOT_CLAIMED
  //   - non-bug / non-behavioral → BUG_TASK_FLAG_MISUSE (red flag misuse)
  tasksCmd
    .command("register-red <task-id>")
    .description("Register the RED test for a claimed behavioral bug task (EXECUTE.work)")
    .option("--feature <name>", "Feature whose task to register")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (taskId: string, opts: { feature: string; featureDir?: string }) => {
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor,
          entry_schema_version: 1,
          kind: "event:task_step_done",
          payload: { task_id: taskId, step: "red", result: "passed", red_test_registered: true },
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }
      const out = {
        ok: true,
        feature: opts.feature,
        task_id: taskId,
        red_test_registered: true,
        sub_state: result.snapshot.state?.sub_state,
      };
      ctx.success(
        out,
        () => "",
        { stateChange: `tasks register-red: ${taskId}` },
      );
    });

  // ── loaf tasks step <subcommand> ────────────────────────────────────
  // Slice 2 SC3. Sub-namespace for task step lifecycle. `step start` and
  // `step done` both require task.status=in_progress (SC1 TASK_NOT_CLAIMED).
  const stepCmd = tasksCmd
    .command("step")
    .description("Task step lifecycle (start / done)");

  // ── loaf tasks step start --task T-N --step <s> ─────────────────────
  // Slice 2 SC3. Emits `event:task_step_started`. SC1 preflight gates:
  // task exists + status=in_progress + step seeded (step-seeded check
  // remains reducer-side TASK_STEP_NOT_FOUND).
  //
  // Slice 2 SC4 (codex r60 P2.3 closure) — idempotency contract: running
  // `step start` on a step already at status=running emits a second
  // event:task_step_started entry; reducer rewrites step.status to running
  // (idempotent state). This is accepted audit-trail redundancy — the
  // journal records every claim/start regardless of effect. No
  // TASK_STEP_ALREADY_RUNNING refine; future slice can add one if the
  // redundancy becomes operationally noisy.
  stepCmd
    .command("start")
    .description("Mark a task step as running (task must be claimed)")
    .requiredOption("--task <task-id>", "Task whose step to start")
    .requiredOption("--step <step-name>", "Step name (kind-specific; see spec)")
    .option("--feature <name>", "Feature whose task lifecycle to advance")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { task: string; step: string; feature: string; featureDir?: string }) => {
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor,
          entry_schema_version: 1,
          kind: "event:task_step_started",
          payload: { task_id: opts.task, step: opts.step },
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }
      // Slice 2 SC4 (codex r60 P2.2 closure): preflight + reducer guarantee
      // task + step exist on success; fail-fast if either is missing so
      // output schema never silently drops `step_status` to undefined.
      const updated = result.snapshot.tasks.find((t) => t.id === opts.task);
      if (!updated) {
        emitFailure(
          "REDUCER_ERROR",
          `internal: task ${opts.task} missing from snapshot after successful step_started apply`,
        );
        return;
      }
      const stepInfo = updated.steps[opts.step];
      if (!stepInfo) {
        emitFailure(
          "REDUCER_ERROR",
          `internal: step ${opts.step} missing from task ${opts.task} after successful step_started apply`,
        );
        return;
      }
      const out = {
        ok: true,
        feature: opts.feature,
        task_id: opts.task,
        step: opts.step,
        step_status: stepInfo.status,
        sub_state: result.snapshot.state?.sub_state,
      };
      ctx.success(
        out,
        () => "",
        { stateChange: `step start: ${opts.task} ${opts.step} (running)` },
      );
    });

  // ── loaf tasks step done --task T-N --step <s> [--result <r>] ───────
  // Slice 2 SC3. Emits `event:task_step_done`. SC1 preflight gates same
  // as step start. Reducer auto-promotes task.status=done when all must-
  // applicable steps are terminal-positive (passed | waived | na).
  // --result defaults to "passed" if omitted; valid values per
  // TaskStepDonePayload schema: passed | failed | waived | na.
  //
  // Slice 3 SC4 (codex r62 plan): optional --evidence-* flags trigger a
  // mutateBatch [event:task_step_done, evidence:added] so a single
  // command both closes the step and registers its proof under one
  // batch_id. CLI allocates EV-NNNNNN (max-serial+1, zero-pad ≥6),
  // injects task_id from --task, and forwards remaining fields to the
  // EvidenceFullPayload schema. Without --evidence-* the original
  // single-entry behavior is preserved.
  stepCmd
    .command("done")
    .description("Mark a task step as done (--result passed|failed|waived|na; default passed)")
    .requiredOption("--task <task-id>", "Task whose step to mark done")
    .requiredOption("--step <step-name>", "Step name (kind-specific)")
    .option("--result <r>", "Step result: passed (default) | failed | waived | na", "passed")
    // Slice 3 SC4 --evidence-* batch flags. Any one of these triggers
    // the batch path; --evidence-kind + --evidence-summary are then
    // required together (others optional, mirrors evidence add payload).
    .option("--evidence-kind <kind>", "Evidence kind (closed EvidenceKind enum)")
    .option("--evidence-result <r>", "Evidence result (passed | failed | approved | rejected | waived)")
    .option("--evidence-summary <text>", "Evidence summary (≥3 chars)")
    .option("--evidence-covers <csv>", "Comma-separated REQ/SCEN/VIS/Task ids covered by this evidence")
    .option("--evidence-check <kind>", "Verify-check kind (run | review | acceptance | visual)")
    .option("--evidence-reason <text>", "Evidence reason (manual/waiver require ≥10 chars)")
    .option("--evidence-actor <actor>", "Override evidence actor (default: cli:loaf; required human:* for manual/waiver)")
    .option("--feature <name>", "Feature whose task lifecycle to advance")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: {
      task: string;
      step: string;
      result: string;
      feature: string;
      featureDir?: string;
      evidenceKind?: string;
      evidenceResult?: string;
      evidenceSummary?: string;
      evidenceCovers?: string;
      evidenceCheck?: string;
      evidenceReason?: string;
      evidenceActor?: string;
    }) => {
      // Validate --result client-side (payload schema also enforces).
      const validResults = ["passed", "failed", "waived", "na"] as const;
      if (!(validResults as readonly string[]).includes(opts.result)) {
        emitFailure(
          "USAGE",
          `--result must be one of: passed | failed | waived | na (got ${opts.result})`,
        );
        return;
      }
      // SC4 batch path: any --evidence-* flag triggers; --kind + --summary
      // are mutually required (kind without summary or vice versa → USAGE).
      const evidenceFlagSet =
        opts.evidenceKind !== undefined ||
        opts.evidenceResult !== undefined ||
        opts.evidenceSummary !== undefined ||
        opts.evidenceCovers !== undefined ||
        opts.evidenceCheck !== undefined ||
        opts.evidenceReason !== undefined ||
        opts.evidenceActor !== undefined;
      if (evidenceFlagSet) {
        if (opts.evidenceKind === undefined || opts.evidenceSummary === undefined) {
          emitFailure(
            "USAGE",
            "--evidence-kind and --evidence-summary must be specified together when any --evidence-* flag is present",
          );
          return;
        }
      }
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const now = new Date().toISOString();
      // Build the step_done entry. SC4 batch path adds evidence:added
      // afterward when --evidence-* is set.
      const stepDoneEntry = {
        at: now,
        actor,
        entry_schema_version: 1,
        kind: "event:task_step_done" as const,
        payload: { task_id: opts.task, step: opts.step, result: opts.result },
      };
      const mctx = {
        feature_dir: featureDir,
        snapshot: session.snapshot,
        tail_seq: session.tail_seq,
        entries: session.entries,
        meta: session.meta,
        dryRun: ctx.dryRun,
        registryWriter: registryWriterDeps,
      };
      let result:
        | Awaited<ReturnType<typeof mutate>>
        | Awaited<ReturnType<typeof mutateBatch>>;
      let evidenceId: string | undefined;
      if (evidenceFlagSet) {
        // Allocate EV-NNNNNN — same shape as evidence add CLI.
        const maxSerial = session.snapshot.evidence.reduce((max, e) => {
          const m = /^EV-(\d+)$/.exec(e.id);
          if (!m) return max;
          return Math.max(max, Number.parseInt(m[1]!, 10));
        }, 0);
        evidenceId = `EV-${String(maxSerial + 1).padStart(6, "0")}`;
        const iteration = session.snapshot.state.iteration ?? 1;
        const evidenceActor = opts.evidenceActor ?? actor;
        const evidencePayload: Record<string, unknown> = {
          id: evidenceId,
          kind: opts.evidenceKind,
          iteration,
          actor: evidenceActor,
          // Evidence.result defaults to the step result so passed steps
          // emit passed evidence by default; caller can override via
          // --evidence-result for waiver / approved / rejected cases.
          result: opts.evidenceResult ?? opts.result,
          summary: opts.evidenceSummary,
          task_id: opts.task,
        };
        if (opts.evidenceCovers !== undefined) {
          evidencePayload["covers"] = opts.evidenceCovers
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }
        if (opts.evidenceCheck !== undefined) evidencePayload["check"] = opts.evidenceCheck;
        if (opts.evidenceReason !== undefined) evidencePayload["reason"] = opts.evidenceReason;
        // Journal envelope actor is always the CLI-injected machine actor
        // (codex r72 BLOCK fix): protocol §10.8 keeps `--actor` a permanent
        // non-flag — envelope provenance must stay `cli:loaf@...` so audit
        // trail aligns with the adjacent event:task_step_done entry.
        // Payload.actor inside evidencePayload can still carry `human:*`
        // for manual/waiver evidence (preserved above).
        result = await mutateBatch(
          [
            stepDoneEntry,
            {
              at: now,
              actor,
              entry_schema_version: 1,
              kind: "evidence:added",
              payload: evidencePayload,
            },
          ],
          mctx,
        );
      } else {
        result = await mutate(stepDoneEntry, mctx);
      }
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }
      // Slice 2 SC4 (codex r60 P2.2 closure): same fail-fast assertions
      // as step start — concrete step_status / task_status in output.
      const updated = result.snapshot.tasks.find((t) => t.id === opts.task);
      if (!updated) {
        emitFailure(
          "REDUCER_ERROR",
          `internal: task ${opts.task} missing from snapshot after successful step_done apply`,
        );
        return;
      }
      const stepInfo = updated.steps[opts.step];
      if (!stepInfo) {
        emitFailure(
          "REDUCER_ERROR",
          `internal: step ${opts.step} missing from task ${opts.task} after successful step_done apply`,
        );
        return;
      }
      const out: Record<string, unknown> = {
        ok: true,
        feature: opts.feature,
        task_id: opts.task,
        step: opts.step,
        step_status: stepInfo.status,
        task_status: updated.status, // reflects auto-promote if it fired
        sub_state: result.snapshot.state?.sub_state,
      };
      if (evidenceId !== undefined) out["evidence_id"] = evidenceId;
      ctx.success(
        out,
        () => {
          const promote = updated.status === "done" ? " (task auto-promoted to done)" : "";
          const evidenceSuffix = evidenceId !== undefined ? ` evidence=${evidenceId}` : "";
          return `done ${opts.task} step=${opts.step} result=${opts.result}${evidenceSuffix}${promote}\n`;
        },
        { stateChange: `step done: ${opts.task} ${opts.step} (${opts.result})` },
      );
    });

  // ── loaf settle ─────────────────────────────────────────────────────
  // Slice 1.D sub-cycle 3. Deep-ceremony-only cursor advance:
  // VERIFY.accept → SETTLE.reconcile. Emits a single
  // `event:phase_advanced` with `cli:` actor — settle is a deterministic
  // cursor move (no human decision), so unlike `loaf deliver` it does not
  // resolve a human:* actor. Per protocol §10.6 chaos deviation, the
  // command keeps the single-verb name even though it follows the
  // event:phase_advanced kind contract.
  //
  // All failure paths surface through stable-core validators:
  //   * cursor != VERIFY.accept           → TRANSITION_ILLEGAL (edge legality)
  //   * cursor=VERIFY.accept, settle_phase=false → SETTLE_PHASE_DISABLED
  //   * cursor=VERIFY.accept, verify_accepted=false → SETTLE_NOT_ACCEPTED
  //   * no session                        → NO_SESSION
  //
  // Output (text mode):
  //   `settled <feature> — VERIFY.accept → SETTLE.reconcile`
  //   `next: loaf advance SETTLE.lessons`
  // JSON includes `advisory: string[]` for scripted chaining. The output
  // intentionally does NOT claim `snapshots/reconcile.json rebuilt`
  // (per codex r49 Q4): the derived reconcile snapshot is deferred to a
  // later slice; the CLI here only owns the cursor transition.
  program
    .command("settle")
    .description("Advance VERIFY.accept → SETTLE.reconcile (deep ceremony only)")
    .option("--feature <name>", "Feature whose session to settle")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      const from = session.snapshot.state?.sub_state;
      if (!from) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }

      // mutate. preflight + transition validator enforce all preconditions
      // (settle_phase / verify_accepted / cursor edge legality).
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor, // module-level cli:loaf actor — settle is machine-driven
          entry_schema_version: 1,
          kind: "event:phase_advanced",
          payload: { from, to: "SETTLE.reconcile" },
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }

      const advisory = [
        "complete SETTLE.* phase (loaf advance SETTLE.lessons) then `loaf deliver`",
      ];
      const out = {
        ok: true,
        feature: opts.feature,
        from,
        to: "SETTLE.reconcile" as const,
        sub_state: result.snapshot.state?.sub_state,
        advisory,
      };
      ctx.success(
        out,
        () => "",
        {
          stateChange: `settle: ${from} → SETTLE.reconcile`,
          next: "loaf deliver",
        },
      );
    });

  // ── loaf resume — Phase 16 SC-13b ────────────────────────────────────
  // Mutator: reads `<feature-dir>/snapshots/resume-pack.json`, validates
  // via runtime ResumePack, emits a typed `session:resumed` journal
  // entry. Cursor / projection state UNCHANGED — the entry is a
  // transparent marker (codex r343 P3). Default cli actor
  // (`cli:loaf@<USER>`) is allowed per PER_KIND_ACTOR; no human gate.
  // `--dry-run` honored through standard mutate dry-run path.
  program
    .command("resume")
    .description("Resume session from snapshots/resume-pack.json (emits session:resumed journal entry)")
    .option("--feature <name>", "Feature whose resume pack to consume")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: false });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const packPath = path.join(featureDir, "snapshots", "resume-pack.json");
      let raw: string;
      try {
        raw = await fsP.readFile(packPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          emitFailure(
            "INPUT_FILE_NOT_FOUND",
            `resume pack not found at ${packPath}; run \`loaf handoff --reason "..."\` first to create one`,
            { path: packPath },
          );
          return;
        }
        throw err;
      }
      let parsedPack: unknown;
      try { parsedPack = JSON.parse(raw); }
      catch (err) {
        emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `resume pack at ${packPath} is not valid JSON: ${(err as Error).message}`,
          { subcode: "invalid-json", path: packPath },
        );
        return;
      }
      const packParse = RuntimeResumePack.safeParse(parsedPack);
      if (!packParse.success) {
        emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `resume pack at ${packPath} failed ResumePack schema validation`,
          { subcode: "zod", path: packPath, issues: packParse.error.issues },
        );
        return;
      }
      const pack = packParse.data;
      // Default cli actor — PER_KIND_ACTOR allows human|skill|ci|cli.
      const actor = `cli:loaf@${process.env["USER"] ?? "unknown"}`;
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor,
          entry_schema_version: 1,
          kind: "session:resumed",
          payload: {
            resumed_from_pack: {
              at: pack.at,
              reason: pack.reason,
              session_id: pack.session_id,
            },
          },
        },
        {
          feature_dir: featureDir,
          snapshot: session.snapshot,
          tail_seq: session.tail_seq,
          entries: session.entries,
          meta: session.meta,
          dryRun: ctx.dryRun,
          registryWriter: registryWriterDeps,
        },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          session_id: pack.session_id,
          sub_state: result.snapshot.state?.sub_state,
        },
        () => `${pack.session_id}\n`,
        { stateChange: `resume: session ${pack.session_id} (sub_state=${result.snapshot.state?.sub_state} unchanged)` },
      );
    });

  // ── loaf handoff — Phase 16 SC-13a ───────────────────────────────────
  // Read-side projection writer. Composes a `ResumePack` from current
  // snapshot + journal tail IDs, writes atomically to
  // `<feature-dir>/snapshots/resume-pack.json`. Does NOT emit a journal
  // entry. Reject `--dry-run` with new `command_type: "projection-writer"`
  // category (writes a file but no journal mutation — neither read-only
  // nor wrapping).
  program
    .command("handoff")
    .description("Compose and persist snapshots/resume-pack.json (read-side projection writer; no journal entry)")
    .requiredOption("--reason <text>", "Why this handoff is being taken (≥5 chars; mandatory per ResumePack.reason)")
    .option("--notes <text>", "Optional free-form notes attached to the pack")
    .option("--feature <name>", "Feature whose handoff to take")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { reason: string; notes?: string; feature: string; featureDir?: string }) => {
      if (rejectIfDryRun("handoff", "projection-writer")) return;
      if (opts.reason.length < 5) {
        emitFailure("USAGE", `--reason must be ≥5 chars (got ${opts.reason.length})`, { reason_length: opts.reason.length });
        return;
      }
      // Handoff is a deliberate human decision (codex r345 P4 — actor is
      // a gate not persisted in the pack, per ResumePack having no actor
      // field; documented residual).
      const resolution = resolveHumanActor({
        env: process.env,
        readGitConfig: readGitConfigForActor,
        isInteractiveHuman: isInteractiveHumanForActor(),
      });
      if (!resolution.ok) { emitFailure(resolution.code, resolution.message); return; }
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: false });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const pack = buildResumePack({
        snapshot: session.snapshot,
        entries: session.entries,
        at: new Date().toISOString(),
        reason: opts.reason,
        ...(opts.notes !== undefined && { notes: opts.notes }),
      });
      // Defense-in-depth: validate against runtime schema before write.
      const parse = RuntimeResumePack.safeParse(pack);
      if (!parse.success) {
        emitFailure("SCHEMA_VALIDATION_FAILED",
          `ResumePack failed runtime validation (builder bug or schema drift)`,
          { subcode: "zod", issues: parse.error.issues });
        return;
      }
      // Atomic write to <feature-dir>/snapshots/resume-pack.json
      const snapshotsDir = path.join(featureDir, "snapshots");
      await fsP.mkdir(snapshotsDir, { recursive: true });
      const packPath = path.join(snapshotsDir, "resume-pack.json");
      const tmpPath = packPath + ".tmp";
      await fsP.writeFile(tmpPath, JSON.stringify(pack, null, 2) + "\n");
      await fsP.rename(tmpPath, packPath);
      ctx.success(
        { ok: true, feature: opts.feature, pack_path: packPath, session_id: pack.session_id },
        () => `${packPath}\n`,
        { stateChange: `handoff: resume-pack.json written by ${resolution.actor}` },
      );
    });

  // ── loaf pending raise / list / status / resolve ─────────────────────
  // Slice 3 SC1 — minimum FIFO surface over the pending queue.
  //   raise   --kind <K> --question <Q> [--options <csv>] [--task-id <tid>]
  //              CLI allocates PEND-N (max-serial+1); emits pending:added.
  //              stdout in text mode = bare PEND-id (scriptable; codex r62).
  //   list    [--format json]
  //              snapshot.pending projection + derived `head: boolean`
  //              flag = first unresolved entry. Text mode = 4 fixed
  //              columns `<PEND-id> <kind> <open|resolved> <head|->`.
  //   status  [--id <id>] [--format json]
  //              default = head (or null if queue has no unresolved entry);
  //              --id = specific entry; miss → PENDING_NOT_FOUND.
  //   resolve --answer <ans>
  //              strict FIFO pop — no --id flag (no skip-ahead per
  //              protocol §10.8 + codex r63). Empty queue → PENDING_NOT_FOUND.
  //
  // Question / options / task_id round-trip via journal payload passthrough
  // (.passthrough()). PendingState projection stays {id, kind, resolved} —
  // surfacing the richer fields is a follow-up refine outside SC1.
  //
  // GATE_NOT_PENDING / ESCALATION_NOT_PENDING and the gate-decide
  // pending:resolved co-emission are deferred to SC4.
  const pendingCmd = program
    .command("pending")
    .description("Pending queue commands (raise / list / status / resolve)");

  pendingCmd
    .command("raise")
    .description("Raise a new pending entry (CLI allocates PEND-id)")
    .requiredOption(
      "--kind <kind>",
      "Pending kind (ask_user_question | gate_decision | spec_clarification | finding_decision | profile_escalation)",
    )
    .requiredOption(
      "--question <text>",
      "Question / rationale shown to whoever resolves it (required for ALL kinds)",
    )
    .option("--options <csv>", "Comma-separated answer options (passthrough)")
    .option("--task-id <id>", "Optional task association (passthrough)")
    .option("--feature <name>", "Feature whose session to raise pending against")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: {
      kind: string;
      question: string;
      options?: string;
      taskId?: string;
      feature: string;
      featureDir?: string;
    }) => {
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      // Single-writer PEND-id allocator: max-serial+1, zero-padded to ≥4
      // digits to match `^PEND-\d{4,}$` (docs/schemas.ts §PendingId,
      // protocol §10.7 rev 4.1). Parser is intentionally permissive on
      // older/legacy unpadded ids so a v0.0.x journal can replay; the
      // allocator only emits canonical form (codex r64 BLOCK 2).
      const maxSerial = session.snapshot.pending.reduce((max, p) => {
        const m = /^PEND-(\d+)$/.exec(p.id);
        if (!m) return max;
        return Math.max(max, Number.parseInt(m[1]!, 10));
      }, 0);
      const id = `PEND-${String(maxSerial + 1).padStart(4, "0")}`;
      const payload: Record<string, unknown> = {
        id,
        kind: opts.kind,
        question: opts.question,
      };
      if (opts.options !== undefined) {
        payload["options"] = opts.options
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
      if (opts.taskId !== undefined) payload["task_id"] = opts.taskId;
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor,
          entry_schema_version: 1,
          kind: "pending:added",
          payload,
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }
      ctx.success(
        { ok: true, feature: opts.feature, id, kind: opts.kind },
        () => id + "\n",
        { stateChange: `pending raise: ${id} (kind=${opts.kind})` },
      );
    });

  pendingCmd
    .command("list")
    .description("List pending entries (FIFO; first unresolved is head)")
    .option("--feature <name>", "Feature whose pending to list")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      if (rejectIfDryRun("pending list")) return;
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      // Phase 15 SC3 — projection-loader. Adapter: PendingProjectionEntry
      // (pending.json native — pending_id + rich fields) → slim row
      // {id, kind, resolved, head} matching the prior PendingState shape.
      const loaded = await loadProjectionsOrFail(
        featureDir,
        ["pending"] as const,
        opts.feature,
      );
      if (loaded === null) return;
      const entries = loaded.pending.pending;
      const headIdx = entries.findIndex((p) => !p.resolved);
      const rows = entries.map((p, i) => ({
        id: p.pending_id,
        kind: p.kind,
        resolved: p.resolved,
        head: i === headIdx,
      }));
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          count: rows.length,
          pending: rows,
        },
        () =>
          rows
            .map(
              (r) =>
                `${r.id} ${r.kind} ${r.resolved ? "resolved" : "open"} ${r.head ? "head" : "-"}\n`,
            )
            .join(""),
      );
    });

  pendingCmd
    .command("status")
    .description("Status of head pending entry (default) or specific entry by --id")
    .option("--feature <name>", "Feature whose pending to inspect")
    .option("--id <id>", "Lookup a specific PEND-id (default: head)")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; id?: string; featureDir?: string }) => {
      if (rejectIfDryRun("pending status")) return;
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const headIdx = session.snapshot.pending.findIndex((p) => !p.resolved);
      let target: { id: string; kind: string; resolved: boolean; head: boolean } | null;
      if (opts.id !== undefined) {
        const idx = session.snapshot.pending.findIndex((p) => p.id === opts.id);
        if (idx === -1) {
          emitFailure(
            "PENDING_NOT_FOUND",
            `pending id=${opts.id} not found in queue`,
            { pending_id: opts.id },
          );
          return;
        }
        target = { ...session.snapshot.pending[idx]!, head: idx === headIdx };
      } else {
        // Default = head; empty queue yields null (script-friendly per
        // codex r63 — distinct from --id miss which is PENDING_NOT_FOUND).
        target =
          headIdx === -1
            ? null
            : { ...session.snapshot.pending[headIdx]!, head: true };
      }
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          pending: target,
        },
        () => {
          if (target === null) return "no open pending\n";
          return `${target.id} ${target.kind} ${target.resolved ? "resolved" : "open"} ${target.head ? "head" : "-"}\n`;
        },
      );
    });

  pendingCmd
    .command("resolve")
    .description("Resolve the head pending entry (strict FIFO; no --id flag)")
    .requiredOption("--answer <text>", "Resolution answer (passthrough into pending:resolved payload)")
    .option("--feature <name>", "Feature whose pending to resolve")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { answer: string; feature: string; featureDir?: string }) => {
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const head = session.snapshot.pending.find((p) => !p.resolved);
      if (!head) {
        emitFailure(
          "PENDING_NOT_FOUND",
          "pending:resolved called but the queue has no unresolved head",
        );
        return;
      }
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor,
          entry_schema_version: 1,
          kind: "pending:resolved",
          payload: { id: head.id, answer: opts.answer },
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          resolved_id: head.id,
          kind: head.kind,
        },
        () => `resolved ${head.id} (kind=${head.kind})\n`,
        { stateChange: `pending resolve: ${head.id} cleared` },
      );
    });

  // ── loaf evidence add --input <src> ───────────────────────────────────
  // Phase 16 SC-4c (closes SC-4 series; codex r229 → r236 amend cycles):
  // unified --input source modality + batch (array) input. Slice 3 SC2
  // shipped the single-entry file-only minimum; SC-4c extends to all 6
  // source-resolution consumers' shared contract.
  //
  // Scope per codex r236 GO (after r230 → r234 patches absorbed):
  //   - `--input <src>` source-discriminated: `-` (stdin via deps.readStdin
  //     with TTY no-hang guard) / inline JSON / file path (protocol §10.7).
  //   - Single object OR non-empty array; array enables batch input via
  //     EvidenceAddInputBatched. One mutateBatch atomic per invocation;
  //     EV-ids allocated sequentially max+1..max+N from a single
  //     max-serial scan.
  //   - Caller-supplied `id` / `evidence_id` / `schema_version` / `at` →
  //     SCHEMA_VALIDATION_FAILED (codex r230 PATCH D — input-schema
  //     violations consistently use SCHEMA_VALIDATION_FAILED; USAGE
  //     reserved for CLI shape/TTY/flag misuse). Per-item failures
  //     include detail.index identifying the failing array element.
  //   - EvidenceAddInput (src/core/evidence-schema.ts) = EvidenceFullShape
  //     .omit({id:true}).strict() — caller-owned id rejection at the
  //     schema layer, not silently stripped. EvidenceFullPayload refines
  //     (manual/waiver actor=human:* + reason≥10; visual-review ≥1
  //     attachment) run later in mutateBatch preflight AFTER id injection.
  //   - Attachments still require full AttachmentPayload {path, sha256,
  //     mime, bytes?} in SC-4c. ADR-0004 A6 auto-hash materialization
  //     (path → full Attachment) is DEFERRED to a future SC; runtime +
  //     docs/schemas.ts INPUT_SCHEMAS["evidence:add"] machine schema +
  //     this CLI handler all match on the full-metadata requirement.
  //   - No `--external-ref` CLI flag; `external_ref` is allowed only
  //     as an --input field (passthrough via EvidenceFullPayload).
  const evidenceCmd = program
    .command("evidence")
    .description("Evidence ledger commands (Slice 3 SC2 MVP: add)");

  evidenceCmd
    .command("add")
    .description("Append evidence entry/entries from --input <src> JSON (CLI allocates EV-id; single object or non-empty array for batch)")
    .option(
      "--input <src>",
      "JSON source for EvidenceAddInput (single object OR non-empty array for batch): `-` (stdin), inline JSON, or file path (protocol §10.7)",
    )
    .option("--schema", "Dump the input JSON Schema instead of mutating (Phase 16 SC-10)")
    .option("--feature <name>", "Feature whose ledger to append to")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (rawOpts: { input?: string; schema?: boolean; feature: string; featureDir?: string }) => {
      if (rawOpts.schema === true) {
        if (rejectIfDryRun("evidence add --schema")) return;
        emitMutatorSchemaAndExit("evidence:add");
        return;
      }
      if (rawOpts.input === undefined) {
        emitFailure(
          "MISSING_INPUT",
          "loaf evidence add requires --input <src> (or pass --schema to dump the input JSON Schema)",
        );
        return;
      }
      const opts = rawOpts as { input: string; feature: string; featureDir?: string };
      // SC-6b — record trace target at action entry so long input-validation
      // failures still trace. SC-8: dispatchOrFail handles §10.3 precedence
      // + traceTarget in one call.
      const earlyFeatureDir = await dispatchOrFail(opts);
      if (earlyFeatureDir === null) return;
      // Phase 16 SC-4c — unified --input modality (protocol §10.7) +
      // array (batch) input enabled (was USAGE reject).
      const source = parseInputSource(opts.input);
      if (source.kind === "stdin" && isStdinTty()) {
        ctx.failure(
          "USAGE",
          "stdin is TTY — `loaf evidence add --input -` expects piped input. " +
            "Pipe JSON via `... | loaf evidence add --input -`, OR pass inline " +
            "JSON / file path. Run --help for examples.",
        );
        return;
      }
      const read = await readJsonInput(source, { readStdin });
      if (!read.ok) {
        ctx.failure(read.code, read.message, read.detail);
        return;
      }
      const parsed = read.value;

      // Normalize to array; reject empty (codex r230 Q3 + r236 PATCH E).
      const rawItems: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      if (rawItems.length === 0) {
        ctx.failure(
          "SCHEMA_VALIDATION_FAILED",
          "evidence add input is an empty array (non-empty array required)",
        );
        return;
      }

      // Per-item strict parse — caller-supplied `id` rejected via
      // .strict() in EvidenceAddInput (codex r230 PATCH D:
      // SCHEMA_VALIDATION_FAILED, not USAGE, for input-schema violations
      // — matches tasks add strict rejection pattern). detail.index
      // identifies the failing item in batch input.
      const validatedInputs: EvidenceAddInput[] = [];
      for (let i = 0; i < rawItems.length; i++) {
        const raw = rawItems[i];
        const p = EvidenceAddInput.safeParse(raw);
        if (!p.success) {
          ctx.failure(
            "SCHEMA_VALIDATION_FAILED",
            `evidence add input[${i}] failed schema validation: ${p.error.issues.map((iss: { message: string }) => iss.message).join("; ")}`,
            { index: i, issues: p.error.issues },
          );
          return;
        }
        validatedInputs.push(p.data);
      }

      // Load session via ctx.
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await ctx.resolveSession(featureDir);
      if (!session.snapshot.state) {
        ctx.failure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }

      // Allocate EV-ids sequentially via shared allocator (Phase 16
      // SC-11 lock — single source for `evidence add` / `waive` /
      // `lessons add`). Atomic across batch via mutateBatch sharing
      // batch_id (codex r230 Q1 / r236 GO).
      const evIds: string[] = allocateNextEvidenceIds(session.snapshot, validatedInputs.length);

      // Materialize full payloads (inject CLI-allocated EV-id; refines
      // in EvidenceFullPayload run during mutateBatch preflight).
      const now = new Date().toISOString();
      const entries: Parameters<typeof mutateBatch>[0] = validatedInputs.map(
        (input, i) => ({
          at: now,
          actor,
          entry_schema_version: 1,
          kind: "evidence:added",
          payload: { ...input, id: evIds[i] },
        }),
      );

      const result = await mutateBatch(entries, {
        feature_dir: featureDir,
        snapshot: session.snapshot,
        tail_seq: session.tail_seq,
        entries: session.entries,
        meta: session.meta,
        dryRun: ctx.dryRun,
        registryWriter: registryWriterDeps,
      });
      if (!result.ok) {
        ctx.failure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }

      // Output preserves single-input bare-EV-id text (back-compat per
      // codex r230 Q6 + r236) and adds {ok, feature, ev_ids, count,
      // sub_state} JSON for batch (matches tasks add shape).
      // SC-5b2: stateChange via evidenceAddStateChange helper per
      // protocol §10.12 (set-semantics covers; heterogeneous batches
      // drop kind/covers).
      const isBatch = Array.isArray(parsed);
      const evidenceItems = validatedInputs.map((input, i) => ({
        id: evIds[i]!,
        kind: input.kind,
        covers: input.covers,
      }));
      const stateChange = evidenceAddStateChange(evidenceItems);
      if (isBatch) {
        ctx.success(
          {
            ok: true,
            feature: opts.feature,
            ev_ids: evIds,
            count: evIds.length,
            sub_state: result.snapshot.state?.sub_state,
          },
          () => evIds.join("\n") + "\n",
          { stateChange },
        );
      } else {
        // Single-input back-compat: bare EV-id in text mode; {ok,
        // feature, id, kind} in JSON mode (pre-SC-4c shape preserved).
        ctx.success(
          {
            ok: true,
            feature: opts.feature,
            id: evIds[0],
            kind: validatedInputs[0]!.kind,
          },
          () => `${evIds[0]}\n`,
          { stateChange },
        );
      }
    });

  // ── loaf waive <obligation-id> — Phase 16 SC-11 ──────────────────────
  // Sugar wrapper over `evidence:added` payload.kind=waiver. Records a
  // human:* waiver against a specific obligation id (REQ-/SCEN-/VIS-/T-)
  // with a required ≥10-char reason. Single-shot — emits one
  // evidence:added entry (no batch). Uses the shared SC-11 EV-id
  // allocator so monotonic ordering matches `evidence add` /
  // `lessons add`.
  program
    .command("waive <obligation-id>")
    .description("Record a waiver evidence (kind=waiver) against an obligation id (REQ-/SCEN-/VIS-/T-)")
    .requiredOption("--reason <text>", "Waiver rationale (≥10 chars; mandatory per evidence schema refine)")
    .option("--feature <name>", "Feature whose ledger to append to")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (
      obligationId: string,
      opts: { reason: string; feature: string; featureDir?: string },
    ) => {
      // (1) obligation id validation via shared CoversRefPayload regex
      //     (no parallel local regex; codex r322 P5 lock)
      const idCheck = CoversRefPayload.safeParse(obligationId);
      if (!idCheck.success) {
        emitFailure(
          "USAGE",
          `invalid obligation id '${obligationId}' — expected REQ-NS-NNN / SCEN-NS-NNN / VIS-NS-NNN / T-NNN form`,
          { argument: obligationId },
        );
        return;
      }
      // (2) reason length is enforced by EvidenceFullPayload refine
      //     downstream; surface the friendlier USAGE here too
      if (opts.reason.length < 10) {
        emitFailure(
          "USAGE",
          `--reason must be ≥10 chars (got ${opts.reason.length})`,
          { reason_length: opts.reason.length },
        );
        return;
      }
      // (3) resolve human actor (waiver requires human:* per refine)
      const resolution = resolveHumanActor({
        env: process.env,
        readGitConfig: readGitConfigForActor,
        isInteractiveHuman: isInteractiveHumanForActor(),
      });
      if (!resolution.ok) {
        emitFailure(resolution.code, resolution.message);
        return;
      }
      const actor = resolution.actor;
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      // (4) allocate EV-id + build payload (pure builder, payload only)
      const evidenceId = allocateNextEvidenceId(session.snapshot);
      const payload = buildWaiveEvidencePayload({
        evidenceId,
        obligationId,
        reason: opts.reason,
        actor,
        iteration: session.snapshot.state.iteration,
      });
      // (5) wrap in journal envelope (codex r325 P1 Option A boundary)
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor,
          entry_schema_version: 1,
          kind: "evidence:added",
          payload,
        },
        {
          feature_dir: featureDir,
          snapshot: session.snapshot,
          tail_seq: session.tail_seq,
          entries: session.entries,
          meta: session.meta,
          dryRun: ctx.dryRun,
          registryWriter: registryWriterDeps,
        },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          id: evidenceId,
          kind: "waiver" as const,
          obligation_id: obligationId,
        },
        () => `${evidenceId}\n`,
        { stateChange: `waive: ${evidenceId} obligation=${obligationId}` },
      );
    });

  // ── loaf lessons add — Phase 16 SC-11 ────────────────────────────────
  // Sugar wrapper over `evidence:added` payload.kind=manual. Records a
  // human:* manual evidence entry whose summary holds the lesson body.
  // v0.1.0 scope: evidence ledger only — `lessons.md` projection writer
  // is deferred (F-024; advisory stderr does NOT claim lessons.md
  // updated). LongTextField sidecar promotion fires when lesson body
  // bytes > SIDECAR_THRESHOLD_BYTES (Pass 2 sidecar promote).
  const lessonsCmd = program
    .command("lessons")
    .description("Lessons-learned evidence commands (Phase 16 SC-11: add)");

  lessonsCmd
    .command("add")
    .description("Record a lessons-learned evidence entry (kind=manual; --text inline OR --file <path>)")
    .option("--text <inline>", "Lesson body text (inline). Mutex with --file.")
    .option("--file <path>", "Read lesson body from file. Mutex with --text.")
    .requiredOption("--reason <text>", "Why this lesson matters (≥10 chars; mandatory per evidence schema refine)")
    .option("--feature <name>", "Feature whose ledger to append to")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { text?: string; file?: string; reason: string; feature: string; featureDir?: string }) => {
      // (1) --text / --file mutex (codex r322 P1 lock)
      const hasText = opts.text !== undefined;
      const hasFile = opts.file !== undefined;
      if (hasText === hasFile) {
        emitFailure("USAGE",
          hasText ? "exactly one of --text or --file required (both provided)"
                  : "exactly one of --text or --file required (neither provided)",
          { text_provided: hasText, file_provided: hasFile });
        return;
      }
      // (2) Read lesson body
      let lessonText: string;
      if (hasText) lessonText = opts.text!;
      else {
        try { lessonText = await fsPromises.readFile(opts.file!, "utf8"); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            emitFailure("INPUT_FILE_NOT_FOUND", `lesson file not found: ${opts.file}`, { path: opts.file! });
            return;
          }
          throw err;
        }
      }
      if (lessonText.length < 3) {
        emitFailure("USAGE", `lesson text must be ≥3 chars (got ${lessonText.length})`, { lesson_text_length: lessonText.length });
        return;
      }
      if (opts.reason.length < 10) {
        emitFailure("USAGE", `--reason must be ≥10 chars (got ${opts.reason.length})`, { reason_length: opts.reason.length });
        return;
      }
      // (3) resolve human actor (manual requires human:* per refine)
      const resolution = resolveHumanActor({
        env: process.env,
        readGitConfig: readGitConfigForActor,
        isInteractiveHuman: isInteractiveHumanForActor(),
      });
      if (!resolution.ok) { emitFailure(resolution.code, resolution.message); return; }
      const actor = resolution.actor;
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      // (5) allocate EV-id + build payload
      const evidenceId = allocateNextEvidenceId(session.snapshot);
      const payload = buildLessonsEvidencePayload({
        evidenceId,
        lessonText,
        reason: opts.reason,
        actor,
        iteration: session.snapshot.state.iteration,
      });
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor,
          entry_schema_version: 1,
          kind: "evidence:added",
          payload,
        },
        {
          feature_dir: featureDir,
          snapshot: session.snapshot,
          tail_seq: session.tail_seq,
          entries: session.entries,
          meta: session.meta,
          dryRun: ctx.dryRun,
          registryWriter: registryWriterDeps,
        },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }
      // v0.1.0: stateChange mentions evidence ledger only — lessons.md
      // projection writer is F-024 deferred. Advisory must NOT claim
      // lessons.md was updated (codex r323 P2 contract).
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          id: evidenceId,
          kind: "manual" as const,
        },
        () => `${evidenceId}\n`,
        { stateChange: `lessons add: ${evidenceId} recorded (kind=manual; lessons.md projection writer deferred)` },
      );
    });

  // ── loaf sessions list — Phase 16 SC-9b ──────────────────────────────
  // Read-only: walks ~/.loaf/registry/*.json (via defaultRegistryDir
  // which honors LOAF_REGISTRY_DIR env from SC-7), formats for terminal
  // UUID recovery (§1588). --in-cwd filters by canonical cwd match.
  // Corrupt entries and orphan-cwd registry rows are surfaced via
  // warnings (codex r290 P2 + P3). Dispatch selectors rejected via
  // pre-parse guard in main() (codex r292 P1 v3 ordering).
  // ── loaf tui — Phase 16 SC-14 ────────────────────────────────────────
  // Read-only Ink-based session manager (MVP). Walks the registry
  // (same source as `sessions list`) and renders a 4-column table:
  // LABEL / PHASE.SUB / ITER / STATUS. Hotkeys [q] quit / [r] reload.
  //
  // MVP scope per codex r353-r357 lock:
  //   IN — table render with active_tasks + pending_queue_depth badges,
  //        manual [r] refresh, [q]/Ctrl-C quit, TTY guard
  //   OUT (deferred to F-026) — [Enter] open / [d] details / [p] pending /
  //        [a] archive interactions; ⚠ stale marker (needs heartbeat_at);
  //        auto-refresh polling; ⏸ gate differentiation
  //
  // Pre-parse guard above rejects --session / --feature / --feature-dir /
  // $LOAF_SESSION / $LOAF_FEATURE / --format.
  const renderTuiImpl: RenderTui = deps.renderTui ?? defaultRenderTui;
  const isStdoutTtyForTui = deps.isStdoutTty ?? (() => process.stdout.isTTY === true);
  program
    .command("tui")
    .description("Interactive session manager TUI (Ink; read-only, MVP)")
    .action(async () => {
      // no-feature — tui walks across all sessions
      if (rejectIfDryRun("tui")) return;
      // TTY guard — BOTH stdin and stdout must be TTY (codex r355 P4).
      const stdinTty = isStdinTty();
      const stdoutTty = isStdoutTtyForTui();
      if (!stdinTty || !stdoutTty) {
        emitFailure(
          "USAGE",
          "TUI requires an interactive terminal (stdin/stdout TTY)",
          { stdin_tty: stdinTty, stdout_tty: stdoutTty },
        );
        return;
      }
      // loadRows closure: preserves deps.registryDir / LOAF_REGISTRY_DIR
      // behavior across initial load AND [r] refresh (codex r357
      // guardrail 2). Does NOT silently fall back to real user registry.
      const loadRows = async () => {
        const result = await listSessions(
          deps.registryDir !== undefined ? { registryDir: deps.registryDir } : {},
        );
        return result.rows;
      };
      const initialRows = await loadRows();
      const app = createElement(TuiApp, { initialRows, loadRows });
      await renderTuiImpl(app);
    });

  const sessionsCmd = program
    .command("sessions")
    .description("Session registry commands (list)");

  sessionsCmd
    .command("list")
    .description("List session registry entries (read-only; --in-cwd filters by current cwd)")
    .option("--in-cwd", "Only list sessions whose registered cwd matches the current cwd")
    .action(async (opts: { inCwd?: boolean }) => {
      // no-feature — sessions list walks across all features
      if (rejectIfDryRun("sessions list")) return;

      const filterCwd = opts.inCwd
        ? await fsPromises.realpath(process.cwd()).catch(() => process.cwd())
        : undefined;

      const result = await listSessions({
        ...(deps.registryDir !== undefined && { registryDir: deps.registryDir }),
        ...(filterCwd !== undefined && { filterCwd }),
      });

      // Warnings → stderr via ctx.advisory (respects --quiet).
      // Wording differs by reason because orphan-cwd rows ARE listed
      // (when no --in-cwd filter); saying "skipped" would contradict
      // the visible row (codex r293 finding).
      for (const w of result.warnings) {
        const action =
          w.reason === "orphan-cwd"
            ? (opts.inCwd ? "filtered out" : "has orphan cwd")
            : "skipped";
        ctx.advisory(
          `registry entry ${w.file} ${action} (${w.reason}${w.detail ? `: ${w.detail}` : ""})`,
        );
      }

      const nowDate = deps.now?.() ?? new Date();

      ctx.success(
        {
          ok: true,
          count: result.rows.length,
          sessions: result.rows,
          warnings: result.warnings,
        },
        () => {
          if (result.rows.length === 0) return "(no sessions found)\n";
          // 4-column aligned: <short8> <feature> <phase.sub_state> <at>
          const lines: string[] = [];
          // Column widths
          const featureWidth = Math.max(
            ...result.rows.map((r) => r.feature.length),
            7,
          );
          const stateWidth = Math.max(
            ...result.rows.map((r) => r.sub_state.length),
            12,
          );
          for (const row of result.rows) {
            const at = formatAtRelative(row.at, nowDate);
            lines.push(
              `${row.session_id_short}  ${row.feature.padEnd(featureWidth)}  ${row.sub_state.padEnd(stateWidth)}  ${at}\n`,
            );
          }
          return lines.join("");
        },
      );
    });

  // ── loaf check <path> ────────────────────────────────────────────────
  // Phase 16 SC-9c — pure schema validation entry. Feature-agnostic;
  // no session resolution. Read-only — rejects --dry-run. Pre-parse
  // guard above already rejected --session/--feature/--feature-dir.
  // Delegates to src/cli/check-file.ts which handles per-kind dispatch
  // (KIND_DISPATCH table), did-you-mean for `tasks` (codex r309 N2),
  // Zod issue cap (MAX_CHECK_ERRORS = 20), shared failure envelope
  // (codex r308 B1). 6 artifact kinds for v0.1.0: spec / tasks /
  // evidence / finding / pending / state.
  program
    .command("check <path>")
    .description("Validate an artifact file against its schema (read-only; CI-friendly)")
    .option(
      "--kind <kind>",
      `Artifact kind (one of ${CHECK_KINDS.join("|")}); auto-detected from basename when omitted`,
    )
    .action(async (filePath: string, opts: { kind?: string }) => {
      // no-feature — check is feature-agnostic per protocol §1891
      if (rejectIfDryRun("check")) return;

      // --kind validation
      let kind: CheckKind | undefined;
      if (opts.kind !== undefined) {
        if (!(CHECK_KINDS as readonly string[]).includes(opts.kind)) {
          emitFailure(
            "USAGE",
            `--kind '${opts.kind}' is not recognized; expected one of ${CHECK_KINDS.join("|")}`,
            { provided: opts.kind, allowed: CHECK_KINDS },
          );
          return;
        }
        kind = opts.kind as CheckKind;
      }

      const result = await checkFile(kind === undefined ? { path: filePath } : { path: filePath, kind });
      if (result.ok) {
        ctx.success(result, () => renderCheckSuccess(result));
        return;
      }
      emitFailure(result.code, result.message, result.detail);
    });

  // ── loaf verify status ───────────────────────────────────────────────
  // Phase 16 SC-9a-1 — read-only diagnostic view of the verify-accept gate
  // (codex r304 lock). 5-row PerCheckResult summary per VerifyCheckId,
  // failures: FailedCheck[]. SPEC_FRONTMATTER_INVALID stays at the IO
  // boundary (exit 2 stderr envelope), NOT injected as a synthetic check
  // 1 row — divergence from evaluateVerifyAccept by design (gate decision
  // path is unchanged).
  //
  // Uses loadSession (full replay) because evaluateAllChecks needs the
  // reducer-domain Snapshot (5 fields: state/tasks/evidence/findings/
  // tasks_based_on). loadProjectionsOrFail returns slim projections; the
  // reconstruction-to-Snapshot synthesis is non-trivial. Read-only diag
  // is the right place to pay the full-replay cost for v0.1.0.
  // SnapshotStaleError doesn't apply here (loadSession reads journal
  // directly, not the snapshot file).
  const verifyCmd = program
    .command("verify")
    .description("Verify-accept gate read commands (status)");

  verifyCmd
    .command("status")
    .description("Show per-check verify-accept diagnostic (read-only)")
    .option("--feature <name>", "Feature whose verify status to show")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature?: string; featureDir?: string }) => {
      if (rejectIfDryRun("verify status")) return;
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      const diag = await evaluateVerifyAcceptDiagnostic(session.snapshot, featureDir);
      if (!diag.ok) {
        // IO-boundary divergence: frontmatter unreadable → exit 2,
        // structured envelope on stderr. Does NOT synthesize a check-1
        // row (codex r302 lock).
        emitFailure(diag.code, diag.message, diag.detail);
        return;
      }
      const env = buildVerifyStatusEnvelope(diag.checks);
      ctx.success(env, () => renderVerifyStatusText(env));
    });

  // ── loaf finding raise / list / close ────────────────────────────────
  // Slice 3 SC3 — finding ledger CLI + FINDING_ACTION_GRID + target_payload
  // preflight (protocol §4.5 + §10.8 / docs/schemas.ts §5 / §37).
  //
  // Scope per codex r68 conditional sign-off:
  //   - raise: closed FindingCategory / FindingAction enums via schema;
  //     CLI allocates FND-NNN (max-serial+1, zero-pad ≥3 digits per
  //     FindingId); --summary/--reason/--target-task/--target-step flags
  //     accepted as typed optional payload fields.
  //   - Partial target flags (only one of --target-task / --target-step)
  //     rejected at CLI boundary with USAGE before mutate.
  //   - Grid + target invariants enforced in stable-core preflight
  //     (FINDING_ACTION_INCOHERENT / FINDING_ACTION_UNUSUAL_REASON_REQUIRED
  //     / FINDING_TARGET_REQUIRED with detail.reason).
  //   - list: read-only snapshot.findings; --status filters open/closed;
  //     JSON exposes the slim projection including summary/reason/target.
  //   - close: positional <FND-id>; reducer returns FINDING_NOT_FOUND with
  //     detail.reason ∈ {unknown, already_closed} (codex r68 #4).
  //
  // Back-edge batch paths on raise (Phase 11 Item 3): amend-spec →
  // [finding:raised, event:phase_advanced SPEC.spec]; amend-tasks →
  // [finding:raised, event:phase_advanced EXECUTE.work]; fix-impl →
  // [finding:raised, event:task_step_reset, event:phase_advanced
  // EXECUTE.work] (the reset returns the implement step to "pending").
  // fix-test (SC3) mirrors fix-impl with the "red" step.
  const findingCmd = program
    .command("finding")
    .description("Finding ledger commands (Slice 3 SC3 MVP: raise / list / close)");

  findingCmd
    .command("raise")
    .description("Raise a new finding (CLI allocates FND-id)")
    .requiredOption(
      "--category <category>",
      "Finding category (spec-gap | spec-defect | impl-defect | test-defect | new-scope | risk-escalation)",
    )
    .requiredOption(
      "--action <action>",
      "Finding action (amend-spec | amend-tasks | fix-impl | fix-test | defer | backlog)",
    )
    .option("--summary <text>", "One-line finding summary (passthrough)")
    .option("--reason <text>", "Justification (required ≥20 chars on unusual cells)")
    .option("--target-task <task-id>", "Target task for fix-impl / fix-test / amend-tasks")
    .option("--target-step <step>", "Target step (must equal action's canonical step)")
    .option("--feature <name>", "Feature whose ledger to append to")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: {
      category: string;
      action: string;
      summary?: string;
      reason?: string;
      targetTask?: string;
      targetStep?: string;
      feature: string;
      featureDir?: string;
    }) => {
      // Partial target flags: USAGE before mutate (codex r68 RED #5).
      const hasTask = opts.targetTask !== undefined;
      const hasStep = opts.targetStep !== undefined;
      if (hasTask !== hasStep) {
        emitFailure(
          "USAGE",
          "--target-task and --target-step must be specified together (or both omitted)",
        );
        return;
      }
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      // FND-NNN allocator: scan numeric FND ids in projection, max+1,
      // zero-pad to ≥3 digits per FindingId regex.
      const maxSerial = session.snapshot.findings.reduce((max, f) => {
        const m = /^FND-(\d+)$/.exec(f.id);
        if (!m) return max;
        return Math.max(max, Number.parseInt(m[1]!, 10));
      }, 0);
      const id = `FND-${String(maxSerial + 1).padStart(3, "0")}`;
      const payload: Record<string, unknown> = {
        id,
        category: opts.category,
        action: opts.action,
      };
      if (opts.summary !== undefined) payload["summary"] = opts.summary;
      if (opts.reason !== undefined) payload["reason"] = opts.reason;
      if (hasTask && hasStep) {
        payload["target"] = { task_id: opts.targetTask, step: opts.targetStep };
      }
      // Slice B / Phase 11 Item 3 SC1: back-edge actions emit a 2-entry
      // batch [finding:raised, event:phase_advanced(back_edge)] so the
      // cursor move is journal-derivable + replay-safe. amend-spec →
      // SPEC.spec (lock-bypass); amend-tasks → EXECUTE.work (back-edge-
      // only, no event:tasks_amended — that is SC1b). The target is
      // dictated by `action` and re-derived by validateTransition.
      // Other actions remain single-entry until their slices land.
      const nowIso = new Date().toISOString();

      // Phase 11 Item 3 SC2/SC3 — fix-impl / fix-test emit a 3-entry batch
      // [finding:raised, event:task_step_reset, event:phase_advanced(
      // back_edge → EXECUTE.work)]. The reset entry returns the target
      // repair step to `pending` so the fix loop can re-run it. The step
      // is the action's canonical step (fix-impl → "implement",
      // fix-test → "red"). Both actions share the keyed batch path and the
      // event:task_step_reset kind — the only per-action input is this map.
      const FIX_RESET_STEP: Record<string, string> = {
        "fix-impl": "implement",
        "fix-test": "red",
      };
      const fixResetStep = FIX_RESET_STEP[opts.action];
      // fix-impl is a `task_id_step` target action: the CLI cannot build the
      // event:task_step_reset entry without {task_id, step}. When the target
      // is absent, fall through to the lone-`finding:raised` path below — its
      // FINDING_TARGET_REQUIRED preflight refine is the authoritative,
      // already-tested target gate (the 3-entry batch path only runs when
      // the target is present).
      if (fixResetStep !== undefined && hasTask && hasStep) {
        const currentSubState = session.snapshot.state.sub_state;
        const batchResult = await mutateBatch(
          [
            {
              at: nowIso,
              actor,
              entry_schema_version: 1,
              kind: "finding:raised",
              payload,
            },
            {
              // cli:loaf actor on the mechanical reset entry — human
              // attribution lives on the sibling finding:raised entry.
              at: nowIso,
              actor: "cli:loaf",
              entry_schema_version: 1,
              kind: "event:task_step_reset",
              payload: {
                task_id: opts.targetTask,
                step: fixResetStep,
                finding_id: id,
              },
            },
            {
              at: nowIso,
              actor: "cli:loaf",
              entry_schema_version: 1,
              kind: "event:phase_advanced",
              payload: {
                from: currentSubState,
                to: "EXECUTE.work",
                back_edge: { action: opts.action, finding_id: id },
              },
            },
          ],
          { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
        );
        if (!batchResult.ok) {
          emitFailure(batchResult.code, batchResult.message, batchResult.detail);
          return;
        }
        if (ctx.dryRun) {
          emitDryRunSuccess(batchResult);
          return;
        }
        ctx.success(
          {
            ok: true,
            feature: opts.feature,
            id,
            category: opts.category,
            action: opts.action,
            back_edge: { from: currentSubState, to: "EXECUTE.work" },
          },
          () => id + "\n",
          {
            stateChange:
              `finding raise: ${id} (category=${opts.category}, action=${opts.action}) — back-edge to EXECUTE.work`,
          },
        );
        return;
      }

      const BACK_EDGE_TARGET: Record<string, SubState> = {
        "amend-spec": "SPEC.spec",
        "amend-tasks": "EXECUTE.work",
      };
      const backEdgeTarget = BACK_EDGE_TARGET[opts.action];
      if (backEdgeTarget !== undefined) {
        const currentSubState = session.snapshot.state.sub_state;
        const batchResult = await mutateBatch(
          [
            {
              at: nowIso,
              actor,
              entry_schema_version: 1,
              kind: "finding:raised",
              payload,
            },
            {
              // codex r96 Q6 ack: cli:loaf actor on derived
              // phase_advanced (consistent with gate-decide
              // co-emission). Human attribution lives on the
              // sibling finding:raised entry one journal line away.
              at: nowIso,
              actor: "cli:loaf",
              entry_schema_version: 1,
              kind: "event:phase_advanced",
              payload: {
                from: currentSubState,
                to: backEdgeTarget,
                back_edge: { action: opts.action, finding_id: id },
              },
            },
          ],
          { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
        );
        if (!batchResult.ok) {
          emitFailure(batchResult.code, batchResult.message, batchResult.detail);
          return;
        }
        if (ctx.dryRun) {
          emitDryRunSuccess(batchResult);
          return;
        }
        ctx.success(
          {
            ok: true,
            feature: opts.feature,
            id,
            category: opts.category,
            action: opts.action,
            back_edge: { from: currentSubState, to: backEdgeTarget },
          },
          // codex r98 §1: keep text-mode stdout bare (matches every
          // other `loaf finding raise` action). Callers script
          // `FND=$(loaf finding raise ...)` and feed the id straight
          // into `loaf finding close`; a decorated string would
          // break that pipeline contract. The back_edge sponsorship
          // is observable from the journal tail + JSON mode.
          () => id + "\n",
          {
            stateChange:
              `finding raise: ${id} (category=${opts.category}, action=${opts.action}) — back-edge to ${backEdgeTarget}`,
          },
        );
        return;
      }

      const result = await mutate(
        {
          at: nowIso,
          actor,
          entry_schema_version: 1,
          kind: "finding:raised",
          payload,
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          id,
          category: opts.category,
          action: opts.action,
        },
        () => id + "\n",
        {
          stateChange:
            `finding raise: ${id} (category=${opts.category}, action=${opts.action})`,
        },
      );
    });

  findingCmd
    .command("list")
    .description("List findings (read-only; --status filters open|closed)")
    .option("--feature <name>", "Feature whose findings to list")
    .option("--status <s>", "Filter by status (open | closed)")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; status?: string; featureDir?: string }) => {
      if (rejectIfDryRun("finding list")) return;
      if (opts.status !== undefined && opts.status !== "open" && opts.status !== "closed") {
        emitFailure("USAGE", `--status must be one of: open | closed (got ${opts.status})`);
        return;
      }
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      // Phase 15 SC3 — projection-loader. findings.json's FindingStateShape
      // is already byte-equal to the reducer's FindingState slim shape (id,
      // category, action, status, summary?, reason?, target?) — no adapter
      // beyond the array unwrap.
      const loaded = await loadProjectionsOrFail(
        featureDir,
        ["findings"] as const,
        opts.feature,
      );
      if (loaded === null) return;
      const all = loaded.findings.findings;
      const rows = opts.status
        ? all.filter((f) => f.status === opts.status)
        : all;
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          count: rows.length,
          findings: rows,
        },
        () =>
          rows
            .map((r) => `${r.id} ${r.category} ${r.action} ${r.status}\n`)
            .join(""),
      );
    });

  findingCmd
    .command("close <fnd-id>")
    .description("Close a finding (emits finding:closed)")
    .option("--feature <name>", "Feature whose ledger to close against")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (fndId: string, opts: { feature: string; featureDir?: string }) => {
      // CLI-side id format check fires before projection lookup so a
      // non-canonical id (e.g. legacy `FND-1`) yields INVALID_PAYLOAD
      // rather than "not in projection" — matches the schema-tightening
      // contract at the journal boundary.
      const idParse = FindingId.safeParse(fndId);
      if (!idParse.success) {
        emitFailure(
          "INVALID_PAYLOAD",
          `finding close id must match FindingId regex /^FND-\\d{3,}$/ (got ${fndId})`,
          { id: fndId, issues: idParse.error.issues },
        );
        return;
      }
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      // CLI-side pre-check surfaces FINDING_NOT_FOUND directly (instead of
      // letting mutate() wrap the reducer error as REDUCER_ERROR). Reducer
      // keeps the same checks as defense-in-depth for raw mutate paths.
      // Detail.reason distinguishes unknown vs already_closed for callers
      // that want to react programmatically (codex r68 #4).
      const existing = session.snapshot.findings.find((f) => f.id === fndId);
      if (!existing) {
        emitFailure(
          "FINDING_NOT_FOUND",
          `finding:closed references unknown finding id=${fndId}`,
          { id: fndId, reason: "unknown" },
        );
        return;
      }
      if (existing.status === "closed") {
        emitFailure(
          "FINDING_NOT_FOUND",
          `finding:closed references finding id=${fndId} that is already closed`,
          { id: fndId, reason: "already_closed" },
        );
        return;
      }
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor,
          entry_schema_version: 1,
          kind: "finding:closed",
          payload: { id: fndId },
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta, dryRun: ctx.dryRun, registryWriter: registryWriterDeps },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }
      ctx.success(
        { ok: true, feature: opts.feature, id: fndId, status: "closed" },
        () => `closed ${fndId}\n`,
        { stateChange: `finding close: ${fndId} → closed` },
      );
    });

  // ── loaf spec submit --input <file> ──────────────────────────────────
  // Slice 4 SC1 — whole-replacement spec content entry (protocol §10.8 +
  // rev 4.3 ADR-0004 A4). The reducer for event:spec_submitted resets
  // requirements / scenarios / visual_contracts projections to [] (codex
  // r74 reminder: spec submit is whole-replacement, not incremental).
  //
  // Input shape mirrors SpecFrontmatter (full-id companions; id_namespace
  // is reserved for spec add-* in SC2):
  //   {
  //     spec_version?,                 // CLI fills with current+1 if absent
  //     feature: { id, name },
  //     intent: string ≥20 chars,
  //     adr_refs: string[],
  //     needs_clarification: ...,
  //     requirements?: RequirementEarsVerifiable[],
  //     scenarios?: ScenarioGherkin[],
  //     visual_contracts?: VisualContract[],
  //   }
  //
  // Emits a mutateBatch: [event:spec_submitted at batch_index=0, ...
  // event:spec_req_added at batch_index=1.., ... event:spec_scenario_added,
  // ... event:spec_visual_added]. All entries share a single batch_id +
  // spec_version. Empty companion arrays land a 1-entry batch.
  //
  // DUPLICATE_REQ_ID / DUPLICATE_SCEN_ID / DUPLICATE_VIS_ID fire from
  // preflight (5h) when companion arrays collide within the submit batch.
  // SC2/SC3 deferrals: id_namespace allocator (SC2); SPEC_NOT_INITIALIZED
  // / SPEC_LOCKED_NO_DIRECT_EDIT preflight (SC3 — currently relies on
  // PER_KIND_SUB_STATE ALL_SPEC gate).
  const specCmd = program
    .command("spec")
    .description("SPEC content commands (submit / add-req / add-scenario / add-visual; init in SC4)");

  specCmd
    .command("submit")
    .description("Whole-replacement spec submit from JSON --input (CLI fills spec_version)")
    .requiredOption(
      "--input <src>",
      "JSON source: `-` (stdin), inline JSON literal, or file path (protocol §10.7)",
    )
    .option("--feature <name>", "Feature whose spec to submit")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { input: string; feature: string; featureDir?: string }) => {
      // SC-6b — record trace target at action entry so long input-validation
      // failures still trace. SC-8: dispatchOrFail handles §10.3 precedence
      // + traceTarget in one call.
      const earlyFeatureDir = await dispatchOrFail(opts);
      if (earlyFeatureDir === null) return;
      // Phase 16 SC-4a — unified --input modality (protocol §10.7 +
      // ADR-0004 A11): parseInputSource discriminates stdin / inline /
      // file; readJsonInput handles IO + JSON parse + error mapping;
      // ctx.failure routes through the shared CommandContext.
      const source = parseInputSource(opts.input);
      // TTY no-hang guard per codex r212 PATCH 2 (protocol §10.1:1505).
      if (source.kind === "stdin" && isStdinTty()) {
        ctx.failure(
          "USAGE",
          "stdin is TTY — `loaf spec submit --input -` expects piped input. " +
            "Pipe JSON via `... | loaf spec submit --input -`, OR pass inline " +
            "JSON / file path. Run --help for examples.",
        );
        return;
      }
      const read = await readJsonInput(source, { readStdin });
      if (!read.ok) {
        ctx.failure(read.code, read.message, read.detail);
        return;
      }
      const parsed = read.value;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        ctx.failure(
          "USAGE",
          "spec submit --input expects a JSON object (SpecFrontmatter shape)",
        );
        return;
      }
      // CLI boundary: typed runtime schema enforcement (codex r75 BLOCK
      // fix). A malformed `spec_version: "2"` or `requirements: "oops"`
      // would otherwise silently degrade (drop to current+1 / coerce to
      // []) and bump spec_version with empty projection — worse than a
      // hard failure. SpecSubmitInput rejects wrong types before mutate.
      const inputParse = SpecSubmitInput.safeParse(parsed);
      if (!inputParse.success) {
        ctx.failure(
          "SCHEMA_VALIDATION_FAILED",
          `spec submit input failed SpecSubmitInput schema validation`,
          { issues: inputParse.error.issues },
        );
        return;
      }
      const input = inputParse.data;
      // Load session via ctx (caches; captures sub_state for crash context).
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await ctx.resolveSession(featureDir);
      if (!session.snapshot.state) {
        ctx.failure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      // (4-6) Build the spec-submit batch via shared SC-12a-1 helper.
      // CLI owns spec_version stamping; reducer enforces monotonic at
      // append. See `src/cli/spec-submit-batch.ts` for the canonical
      // shape (1 head + N req + M scen + K vis entries sharing at /
      // actor / spec_version).
      const now = new Date().toISOString();
      const entries: Parameters<typeof mutateBatch>[0] = buildSpecSubmitBatch({
        input,
        snapshot: session.snapshot,
        actor,
        now,
      });
      // (7) Mutate.
      const result = await mutateBatch(entries, {
        feature_dir: featureDir,
        snapshot: session.snapshot,
        tail_seq: session.tail_seq,
        entries: session.entries,
        meta: session.meta,
        dryRun: ctx.dryRun,
        registryWriter: registryWriterDeps,
      });
      if (!result.ok) {
        ctx.failure(result.code, result.message, result.detail);
        return;
      }
      if (ctx.dryRun) {
        emitDryRunSuccess(result);
        return;
      }
      // Output. Echo collected ids for shell scripting.
      const reqIds = result.snapshot.requirements.map((r) => r.id);
      const scenIds = result.snapshot.scenarios.map((s) => s.id);
      const visIds = result.snapshot.visual_contracts.map((v) => v.id);
      const out = {
        ok: true,
        feature: opts.feature,
        spec_version: result.snapshot.state?.spec_version,
        req_ids: reqIds,
        scen_ids: scenIds,
        vis_ids: visIds,
        sub_state: result.snapshot.state?.sub_state,
      };
      ctx.success(
        out,
        () =>
          `spec submitted v${out.spec_version}: ${reqIds.length} req / ${scenIds.length} scen / ${visIds.length} vis\n`,
        {
          stateChange: `spec submit: spec_version=${out.spec_version}, locked=false`,
          next: "loaf gate decide spec-lock",
        },
      );
    });

  // ── loaf spec add-req / add-scenario / add-visual ────────────────────
  // Slice 4 SC2 (codex r74 sign-off, rev 4.3 / ADR-0004 A5). Incremental
  // add path: caller submits a namespace stem; CLI allocates the canonical
  // full id `<namespace>-<NNN>` (zero-pad ≥3, max-serial+1 per namespace);
  // spec_version bumps once per CLI invocation (caller never supplies);
  // single-item or array-of-items both accepted (array → one mutateBatch
  // with N entries sharing one batch_id + spec_version, allocator advances
  // across batch entries).
  //
  // SPEC_NOT_INITIALIZED + SPEC_LOCKED_NO_DIRECT_EDIT phase gating is SC3.
  // Currently relies on PER_KIND_SUB_STATE ALL_SPEC gate + existing
  // SPEC_VERSION_NOT_MONOTONIC reducer check.
  //
  // Each command is structurally identical; the only differences are:
  //   1. Input schema (SpecAddReqInput / SpecAddScenarioInput / SpecAddVisualInput)
  //   2. Snapshot projection scanned (requirements / scenarios / visual_contracts)
  //   3. Output payload field name (req / scenario / visual)
  //   4. Journal entry kind (event:spec_req_added / spec_scenario_added /
  //      spec_visual_added)
  // The shared shape factored into `registerSpecAdd()` to avoid drift across
  // the three commands.

  interface SpecAddKindConfig {
    name: "req" | "scenario" | "visual";
    payloadField: "req" | "scenario" | "visual";
    entryKind: "event:spec_req_added" | "event:spec_scenario_added" | "event:spec_visual_added";
    inputSchema: typeof SpecAddReqInput | typeof SpecAddScenarioInput | typeof SpecAddVisualInput;
    snapshotKey: "requirements" | "scenarios" | "visual_contracts";
  }
  const REGISTER_SPEC_ADD: SpecAddKindConfig[] = [
    {
      name: "req",
      payloadField: "req",
      entryKind: "event:spec_req_added",
      inputSchema: SpecAddReqInput,
      snapshotKey: "requirements",
    },
    {
      name: "scenario",
      payloadField: "scenario",
      entryKind: "event:spec_scenario_added",
      inputSchema: SpecAddScenarioInput,
      snapshotKey: "scenarios",
    },
    {
      name: "visual",
      payloadField: "visual",
      entryKind: "event:spec_visual_added",
      inputSchema: SpecAddVisualInput,
      snapshotKey: "visual_contracts",
    },
  ];

  // ── loaf spec init — scaffold spec.md (no journal entry) ─────────────
  // Slice 4 SC4 (codex r74 sign-off): writes a parser-valid minimal
  // spec.md template under <featureDir>/spec.md. Pure I/O — no journal
  // entry, no state mutation; spec content goes through `loaf spec submit`
  // / `loaf spec add-*` which emit the canonical journal events.
  //
  // Refuses to overwrite an existing spec.md with SPEC_ALREADY_INITIALIZED
  // (codex r74: no --force in Slice 4 — strict-over-Postel). Empty
  // requirements / scenarios / visual_contracts / needs_clarification
  // arrays so the file passes SpecFrontmatter parsing without leaking
  // tutorial-style sample placeholders into real submits.
  specCmd
    .command("init")
    .description("Write a parser-valid minimal spec.md scaffold (no journal entry)")
    .option("--feature <name>", "Feature whose spec.md to scaffold")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .option("--feature-id <id>", "Override feature.id in scaffold (default: F-XXX placeholder)")
    .option("--feature-name <text>", "Override feature.name in scaffold (default: --feature value)")
    .option(
      "--intent <text>",
      "Override intent line in scaffold (default: TODO placeholder ≥20 chars)",
    )
    .action(async (opts: {
      feature: string;
      featureDir?: string;
      featureId?: string;
      featureName?: string;
      intent?: string;
    }) => {
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      const specMdPath = path.join(featureDir, "spec.md");
      // SPEC_ALREADY_INITIALIZED guard: refuse to overwrite. Check
      // before any I/O so the error surface is the file's existence,
      // not a partial write.
      try {
        await fsP.access(specMdPath);
        // File exists — refuse.
        emitFailure(
          "SPEC_ALREADY_INITIALIZED",
          `spec.md already exists at ${specMdPath}; edit it directly or remove before re-init`,
          { spec_md_path: specMdPath },
        );
        return;
      } catch {
        // ENOENT — proceed.
      }
      // Ensure feature dir exists (loaf start would have created it,
      // but spec init might be called before start in a fresh tree).
      await fsP.mkdir(featureDir, { recursive: true });
      // FeatureIdPayload regex is `^F-\d{3,}$`. F-000 is a deliberate
      // placeholder that parses but is obviously a stand-in — caller
      // should override with `--feature-id F-NNN` before running submit.
      // codex r81 BLOCK fix: validate the composed scaffold against
      // SpecFrontmatter BEFORE writing. Otherwise caller overrides like
      // `--feature-id BAD --feature-name x --intent short` would emit a
      // file that immediately fails the production readSpecFrontmatter()
      // parser, giving scripts a false-success result. Validation here
      // catches feature.id regex / feature.name min length / intent
      // min length / etc. upfront with SCHEMA_VALIDATION_FAILED.
      const featureId = opts.featureId ?? "F-000";
      // SpecFrontmatter requires feature.name length ≥3. The --feature
      // flag is a loaf-internal feature key that can be short (e.g.
      // "F1"); when no --feature-name override is supplied and the
      // feature key is too short, fall back to a clearly-marked
      // placeholder so the scaffold parses but does not pretend to be
      // a finished display name.
      const featureName =
        opts.featureName ??
        (opts.feature.length >= 3 ? opts.feature : "TODO Feature Name");
      const intent =
        opts.intent ??
        "TODO: describe the feature intent in at least twenty characters";
      // codex r81 BLOCK fix: validate the composed scaffold against
      // SpecFrontmatter BEFORE any disk write. Caller overrides
      // (--feature-id BAD / --feature-name x / --intent short) would
      // otherwise write a spec.md that immediately fails the production
      // readSpecFrontmatter() parser. Validation here catches feature.id
      // regex / feature.name min length / intent min length upfront with
      // SCHEMA_VALIDATION_FAILED and zero partial-write risk.
      const scaffoldObj = {
        schema_version: 2,
        spec_version: 1,
        feature: { id: featureId, name: featureName },
        intent,
        adr_refs: [],
        requirements: [],
        scenarios: [],
        visual_contracts: [],
        needs_clarification: [],
      };
      const scaffoldParse = SpecFrontmatter.safeParse(scaffoldObj);
      if (!scaffoldParse.success) {
        emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          "spec init scaffold failed SpecFrontmatter validation; check --feature-id (/^F-\\d{3,}$/), --feature-name (≥3 chars), --intent (≥20 chars)",
          { issues: scaffoldParse.error.issues },
        );
        return;
      }
      // codex r80 BLOCK fix: YAML scalars containing colons / leading
      // dashes / hashes (e.g. the default "TODO: describe..." intent)
      // would otherwise be parsed as nested mappings or comments. Quote
      // every interpolated scalar via JSON.stringify — JSON-encoded
      // strings are also valid double-quoted YAML scalars, so the
      // production readSpecFrontmatter() parser accepts them.
      const md =
        `---\n` +
        `schema_version: 2\n` +
        `spec_version: 1\n` +
        `feature:\n` +
        `  id: ${JSON.stringify(featureId)}\n` +
        `  name: ${JSON.stringify(featureName)}\n` +
        `intent: ${JSON.stringify(intent)}\n` +
        `adr_refs: []\n` +
        `requirements: []\n` +
        `scenarios: []\n` +
        `needs_clarification: []\n` +
        `---\n` +
        `\n## Why\n\nTODO: describe motivation and scope. Edit this section, then run \`loaf spec submit --input <json>\` to record the canonical spec.\n`;
      await fsP.writeFile(specMdPath, md);
      ctx.success(
        { ok: true, feature: opts.feature, spec_md_path: specMdPath },
        () => `${specMdPath}\n`,
        {
          stateChange: `spec init: wrote scaffold to ${specMdPath}`,
          next: "edit, then `loaf spec submit`",
        },
      );
    });

  // ── loaf spec edit — Phase 16 SC-12a-2 ─────────────────────────────
  // Wrapping mutator: spawn $EDITOR on <feature-dir>/spec.md, wait for
  // save, validate post-edit frontmatter, emit `event:spec_submitted`
  // batch (re-using SC-12a-1 shared builder). No-op detection skips
  // journal append. Failure paths preserve the edited work copy on
  // disk for the human to fix + re-run.
  //
  // Codex r331 / r333 / r335 / r336 GO. See:
  //   - r336 P1: spawn error handler (runEditor.ts owns this)
  //   - r336 P2: tokenizer quote contract (runEditor.ts owns this)
  //   - r336 P3: SCHEMA_VALIDATION_FAILED + subcode parity with SC-9c
  //   - r336 P4: SC-6c scanner regex update (tests/scripts/sc6c-...)
  //   - r333 P3: signal !== null → exit 130, code !== 0 → exit 2 USAGE
  const runEditorImpl: RunEditor = deps.runEditor ?? defaultRunEditor;
  specCmd
    .command("edit")
    .description("Launch $EDITOR on spec.md, validate, then emit event:spec_submitted (wrapping mutator; --dry-run rejected)")
    .option("--feature <name>", "Feature whose spec.md to edit")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      if (rejectIfDryRun("spec edit", "wrapping")) return;
      const featureDir = await dispatchOrFail(opts);
      if (featureDir === null) return;
      // (1) actor — `event:spec_submitted` is human:* per PER_KIND_AUTHORITY
      const resolution = resolveHumanActor({
        env: process.env,
        readGitConfig: readGitConfigForActor,
        isInteractiveHuman: isInteractiveHumanForActor(),
      });
      if (!resolution.ok) { emitFailure(resolution.code, resolution.message); return; }
      const actor = resolution.actor;
      const session = await loadSession(featureDir, { ensureDir: false });
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      // (1.5) pre-editor lock gate (codex r339 P2): post-lock direct
      // spec edits must go through `loaf finding raise --action
      // amend-spec` so the spec_lock invariant + iteration counter
      // stay coherent. Reject BEFORE spawning $EDITOR so the user is
      // not deceived by an open editor whose contents will be discarded.
      if (session.snapshot.state.spec_locked === true) {
        emitFailure(
          "SPEC_LOCKED_NO_DIRECT_EDIT",
          `spec is locked; direct edits via \`loaf spec edit\` are rejected post-lock — use \`loaf finding raise --category spec-gap --action amend-spec --summary "..."\` to roll back to SPEC.spec and amend through the finding flow`,
          { kind: "event:spec_submitted" },
        );
        return;
      }
      const specMdPath = path.join(featureDir, "spec.md");
      // (2) capture before-content for no-op detection (codex r332 P6)
      let beforeContent: string;
      try {
        beforeContent = await fsP.readFile(specMdPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          emitFailure(
            "SCHEMA_VALIDATION_FAILED",
            `spec.md not found at ${specMdPath}; run \`loaf spec init\` to scaffold one first`,
            { subcode: "spec-not-found", path: specMdPath },
          );
          return;
        }
        throw err;
      }
      // (3) spawn editor
      const editor = (process.env["EDITOR"] ?? "").trim() || "vi";
      const result = await runEditorImpl({
        filePath: specMdPath,
        editor,
        cwd: process.cwd(),
        env: process.env,
      });
      // (4a) spawn error → USAGE (codex r335 P1)
      if (result.error !== undefined) {
        emitFailure(
          "USAGE",
          `editor '${editor}' could not be launched (${result.error})`,
          { editor, spawn_error: result.error },
        );
        return;
      }
      // (4b) signal abort → exit 130, no journal write (codex r333 P3)
      if (result.signal !== null) {
        ctx.exitCode = 130;
        return;
      }
      // (4c) non-zero exit → USAGE (user aborted via :q! or similar)
      if (result.code !== 0) {
        emitFailure(
          "USAGE",
          `editor exited with code=${result.code}`,
          { editor, editor_exit: result.code },
        );
        return;
      }
      // (5) re-read post-edit content; no-op skip (codex r332 P6)
      let afterContent: string;
      try {
        afterContent = await fsP.readFile(specMdPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          emitFailure(
            "SCHEMA_VALIDATION_FAILED",
            `spec.md was deleted during edit at ${specMdPath}`,
            { subcode: "spec-not-found", path: specMdPath },
          );
          return;
        }
        throw err;
      }
      if (beforeContent === afterContent) {
        ctx.success(
          { ok: true, feature: opts.feature, no_op: true, spec_md_path: specMdPath },
          () => "spec.md unchanged (no-op)\n",
        );
        return;
      }
      // (6) frontmatter validation — direct splitFrontmatter +
      //     parseYaml + SpecFrontmatter.safeParse mirrors SC-9c check
      //     subcode taxonomy (codex r336 P3)
      const { frontmatter } = splitFrontmatter(afterContent);
      if (frontmatter === null) {
        emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `spec.md is missing a YAML frontmatter block fenced by \`---\` on the first line; work copy preserved at ${specMdPath} for you to fix and re-run \`loaf spec edit\``,
          { subcode: "missing-frontmatter", path: specMdPath },
        );
        return;
      }
      let parsedYaml: unknown;
      try {
        parsedYaml = parseYaml(frontmatter);
      } catch (err) {
        emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `spec.md frontmatter YAML failed to parse: ${(err as Error).message}; work copy preserved at ${specMdPath} for you to fix and re-run \`loaf spec edit\``,
          { subcode: "invalid-yaml", path: specMdPath },
        );
        return;
      }
      const zodResult = SpecFrontmatter.safeParse(parsedYaml);
      if (!zodResult.success) {
        const issues = mapZodIssues(zodResult.error);
        emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `spec.md frontmatter failed schema validation (${issues.error_count} errors); work copy preserved at ${specMdPath} for you to fix and re-run \`loaf spec edit\``,
          {
            subcode: "zod",
            path: specMdPath,
            errors: issues.errors,
            truncated: issues.truncated,
            error_count: issues.error_count,
          },
        );
        return;
      }
      // (7) Build SpecSubmitInput (CLI stamps spec_version = current+1
      //     even if user edited the frontmatter value; codex r331 P1)
      const fm = zodResult.data;
      const submitParse = SpecSubmitInput.safeParse({
        spec_version: undefined, // builder defaults to snapshot+1
        feature: fm.feature,
        intent: fm.intent,
        adr_refs: fm.adr_refs,
        requirements: fm.requirements,
        scenarios: fm.scenarios,
        visual_contracts: fm.visual_contracts ?? [],
        needs_clarification: fm.needs_clarification,
      });
      if (!submitParse.success) {
        emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `spec.md frontmatter passed SpecFrontmatter but failed SpecSubmitInput shape (unusual cross-schema drift); work copy preserved at ${specMdPath}`,
          { subcode: "zod", path: specMdPath, issues: submitParse.error.issues },
        );
        return;
      }
      // (8) Build batch via shared SC-12a-1 helper + mutate
      const now = new Date().toISOString();
      const entries: Parameters<typeof mutateBatch>[0] = buildSpecSubmitBatch({
        input: submitParse.data,
        snapshot: session.snapshot,
        actor,
        now,
      });
      const mutateResult = await mutateBatch(entries, {
        feature_dir: featureDir,
        snapshot: session.snapshot,
        tail_seq: session.tail_seq,
        entries: session.entries,
        meta: session.meta,
        dryRun: ctx.dryRun,
        registryWriter: registryWriterDeps,
      });
      if (!mutateResult.ok) {
        emitFailure(mutateResult.code, mutateResult.message, mutateResult.detail);
        return;
      }
      const newSpecVersion = (entries[0]!.payload as { spec_version: number }).spec_version;
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          spec_version: newSpecVersion,
          sub_state: mutateResult.snapshot.state?.sub_state,
        },
        () => `spec edit: spec_version=${newSpecVersion}\n`,
        { stateChange: `spec edit: spec_version=${newSpecVersion} via $EDITOR` },
      );
    });

  for (const cfg of REGISTER_SPEC_ADD) {
    const mutatorKey: MutatorCommand =
      cfg.name === "req" ? "spec:add-req"
      : cfg.name === "scenario" ? "spec:add-scenario"
      : "spec:add-visual";
    specCmd
      .command(`add-${cfg.name}`)
      .description(`Add ${cfg.name} entries via id_namespace stamping (CLI allocates ${cfg.name.toUpperCase()} ids)`)
      .option(
        "--input <src>",
        `JSON source for SpecAdd${cfg.name[0]!.toUpperCase()}${cfg.name.slice(1)}Input (item or array): \`-\` (stdin), inline JSON, or file path (protocol §10.7)`,
      )
      .option("--schema", "Dump the input JSON Schema instead of mutating (Phase 16 SC-10)")
      .option("--feature <name>", `Feature whose spec to extend`)
      .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
      .action(async (rawOpts: { input?: string; schema?: boolean; feature: string; featureDir?: string }) => {
        // Phase 16 SC-10 — --schema bypass MUST be first (no input read,
        // no session resolve). Pre-parse guard already rejected selectors
        // when --schema is present. Literal labels per cfg.name so the
        // SC-6c static guard can scan rejectIfDryRun("<label>") strings.
        if (rawOpts.schema === true) {
          let rejected = false;
          if (cfg.name === "req")            rejected = rejectIfDryRun("spec add-req --schema");
          else if (cfg.name === "scenario")  rejected = rejectIfDryRun("spec add-scenario --schema");
          else                                rejected = rejectIfDryRun("spec add-visual --schema");
          if (rejected) return;
          emitMutatorSchemaAndExit(mutatorKey);
          return;
        }
        if (rawOpts.input === undefined) {
          emitFailure(
            "MISSING_INPUT",
            `loaf spec add-${cfg.name} requires --input <src> (or pass --schema to dump the input JSON Schema)`,
          );
          return;
        }
        const opts = rawOpts as { input: string; feature: string; featureDir?: string };
        // Phase 16 SC-4a — unified --input modality. TTY no-hang guard
        // per codex r212 PATCH 2 (protocol §10.1:1505) covers the stdin
        // case before any read.
        const source = parseInputSource(opts.input);
        if (source.kind === "stdin" && isStdinTty()) {
          ctx.failure(
            "USAGE",
            `stdin is TTY — \`loaf spec add-${cfg.name} --input -\` expects piped input. ` +
              `Pipe JSON via \`... | loaf spec add-${cfg.name} --input -\`, OR pass ` +
              `inline JSON / file path. Run --help for examples.`,
          );
          return;
        }
        const read = await readJsonInput(source, { readStdin });
        if (!read.ok) {
          ctx.failure(read.code, read.message, read.detail);
          return;
        }
        const parsed = read.value;
        const inputParse = cfg.inputSchema.safeParse(parsed);
        if (!inputParse.success) {
          ctx.failure(
            "SCHEMA_VALIDATION_FAILED",
            `spec add-${cfg.name} input failed schema validation`,
            { issues: inputParse.error.issues },
          );
          return;
        }
        const items: ReadonlyArray<{ id_namespace: string; [k: string]: unknown }> =
          Array.isArray(inputParse.data) ? inputParse.data : [inputParse.data];
        // Load session via ctx (caches; captures sub_state for crash context).
        const featureDir = await dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await ctx.resolveSession(featureDir);
        if (!session.snapshot.state) {
          ctx.failure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
          return;
        }
        // (4) Per-namespace allocator. Track counter across the batch so
        // multiple items in the same invocation share a coherent
        // monotonic sequence per namespace.
        const projection = (session.snapshot[cfg.snapshotKey] as ReadonlyArray<{ id: string }>);
        const existingIds = projection.map((p) => p.id);
        const counters = new Map<string, number>();
        const allocatedIds: string[] = [];
        const transformedItems: Array<{ id: string; rest: Record<string, unknown> }> = [];
        for (const raw of items) {
          const ns = raw.id_namespace;
          let next = counters.get(ns);
          if (next === undefined) {
            next = nextSerialInNamespace(existingIds, ns);
          }
          const fullId = `${ns}-${String(next).padStart(3, "0")}`;
          counters.set(ns, next + 1);
          allocatedIds.push(fullId);
          // Strip id_namespace; CLI does not pass it through to the
          // journal payload (output regex enforces id only).
          const { id_namespace: _ns, ...rest } = raw;
          transformedItems.push({ id: fullId, rest });
        }
        // (5) Build batch: one event:spec_*_added per item. spec_version
        // = current+1; reducer applies whole-batch monotonic check
        // (batch head bumps; companions share). Per protocol: each CLI
        // invocation = one spec_version bump, irrespective of N items.
        const targetVersion = session.snapshot.state.spec_version + 1;
        const now = new Date().toISOString();
        const entries: Parameters<typeof mutateBatch>[0] = transformedItems.map(
          ({ id, rest }, _idx) => ({
            at: now,
            actor,
            entry_schema_version: 1,
            kind: cfg.entryKind,
            payload: {
              spec_version: targetVersion,
              [cfg.payloadField]: { id, ...rest },
            },
          }),
        );
        const result = await mutateBatch(entries, {
          feature_dir: featureDir,
          snapshot: session.snapshot,
          tail_seq: session.tail_seq,
          entries: session.entries,
          meta: session.meta,
          dryRun: ctx.dryRun,
          registryWriter: registryWriterDeps,
        });
        if (!result.ok) {
          ctx.failure(result.code, result.message, result.detail);
          return;
        }
        if (ctx.dryRun) {
          emitDryRunSuccess(result);
          return;
        }
        const specVersion = result.snapshot.state?.spec_version;
        ctx.success(
          {
            ok: true,
            feature: opts.feature,
            spec_version: specVersion,
            ids: allocatedIds,
            sub_state: result.snapshot.state?.sub_state,
          },
          () =>
            `spec add-${cfg.name} v${specVersion}: ${allocatedIds.join(", ")}\n`,
          {
            stateChange:
              `spec add-${cfg.name}: +${allocatedIds.length} ${cfg.name.toUpperCase()} (spec_version=${specVersion}; allocated ${allocatedIds.join(",")})`,
          },
        );
      });
  }

  // ── Phase 16 SC-10 — `loaf <kind> schema` artifact subs ──────────────
  //
  // 5 closed-enum kinds per protocol §1947 (excludes pending):
  //   spec / tasks / evidence / finding / state
  //
  // 4 attach under existing parents (specCmd / tasksCmd / evidenceCmd /
  // findingCmd); `state` is a NEW top-level parent (no other v0.1.0
  // state subs). Feature-agnostic — pre-parse guard already rejected
  // --feature / --feature-dir / --session / $LOAF_*. Read-only —
  // `--dry-run` rejected via rejectIfDryRun(<label>).
  const stateCmd = program
    .command("state")
    .description("Session state schema dump (SC-10)");

  const ARTIFACT_PARENTS: Record<ArtifactSchemaKind, ReturnType<typeof program.command>> = {
    spec:     specCmd,
    tasks:    tasksCmd,
    evidence: evidenceCmd,
    finding:  findingCmd,
    state:    stateCmd,
  };
  for (const kind of ARTIFACT_SCHEMA_KINDS) {
    ARTIFACT_PARENTS[kind]
      .command("schema")
      .description(`Dump the ${kind} artifact JSON Schema (Phase 16 SC-10; read-only)`)
      .action(async () => {
        // no-feature — schema dump is feature-agnostic. Literal label
        // per kind so the SC-6c static guard finds rejectIfDryRun("<kind> schema").
        let rejected = false;
        if (kind === "spec")          rejected = rejectIfDryRun("spec schema");
        else if (kind === "tasks")    rejected = rejectIfDryRun("tasks schema");
        else if (kind === "evidence") rejected = rejectIfDryRun("evidence schema");
        else if (kind === "finding")  rejected = rejectIfDryRun("finding schema");
        else                          rejected = rejectIfDryRun("state schema");
        if (rejected) return;
        const schema = emitArtifactSchema(kind) as Record<string, unknown>;
        ctx.success(schema, () => formatSchema(schema));
      });
  }

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
