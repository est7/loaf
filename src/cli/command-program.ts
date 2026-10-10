// Shared registration assembly. Constructing the tree never runs an action.
import { Command } from "commander";
import { assertLeafCommandPolicies } from "./command-policy.js";
import os from "node:os";
import packageJson from "../../package.json" with { type: "json" };
import type { MainDeps } from "../cli.js";
import { helpFooter } from "../core/cli-runtime.js";
import { defaultRegistryDir } from "../core/registry-writer.js";
import { defaultRuntimeDir } from "../core/session-runtime.js";
import {
  createCommandContext,
  FORMAT_MODES_HUMAN,
  type CommandContext,
} from "./command-context.js";
import { createCommandMutator, type CommandMutator } from "./command-mutator.js";
import { createJsonInputIngestor, type JsonInputIngestor } from "./input-ingestion.js";
import { createI18n, BUILTIN_BUNDLES, type I18n } from "./i18n.js";
import { defaultRenderTui, type RenderTui } from "./tui/render.js";
import { runEditor as defaultRunEditor, type RunEditor } from "./run-editor.js";
import { registerLifecycle } from "./commands/lifecycle.js";
import { registerGate } from "./commands/gate.js";
import { registerTerminalExecute } from "./commands/terminal-execute.js";
import { registerProfileConfig } from "./commands/profile-config.js";
import { registerTasks } from "./commands/tasks.js";
import { registerTerminalSettle } from "./commands/terminal-settle.js";
import { registerPending } from "./commands/pending.js";
import { registerEvidence } from "./commands/evidence.js";
import { registerJournal } from "./commands/journal.js";
import { registerLessons } from "./commands/lessons.js";
import { registerIntegrations } from "./commands/integrations.js";
import { registerFinding } from "./commands/finding.js";
import { registerSpec } from "./commands/spec.js";
import { registerState } from "./commands/state.js";
import { registerBoard } from "./commands/board.js";
import { registerPrune } from "./commands/prune.js";

export function createCommandProgram(
  ctx: CommandContext,
  mutator: CommandMutator,
  input: JsonInputIngestor,
  i18n: I18n,
  actor: string,
  deps: MainDeps,
  isStdinTty: () => boolean,
  now: () => Date,
): Command {
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
    // Combined with --feature-dir → USAGE (enforced by the registered
    // pre-parse policy). --feature / --feature-dir
    // stay per-command registrations because making them global
    // conflicts with the per-command opts during Commander parse.
    .option(
      "--session <uuid-or-prefix>",
      "Resolve session by UUID or ≥8-char prefix (registry lookup; see §10.3)",
    )
    .addHelpText("after", helpFooter())
    // Commander errors/help-on-error are translated once by the catalog boundary.
    // Explicit --help/help and --version still use Commander stdout.
    .configureOutput({ writeErr: () => {} })
    .exitOverride();

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

  const { tasksCmd } = registerTasks(program, ctx, mutator, actor, input);
  registerTerminalSettle(program, ctx, mutator, actor);
  registerPending(program, ctx, mutator, actor);
  const { evidenceCmd } = registerEvidence(program, ctx, mutator, actor, input);
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
    ...(deps.boardKeepAlive !== undefined && {
      boardKeepAlive: deps.boardKeepAlive,
    }),
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
    input,
    runEditorImpl,
  );

  registerState(program, ctx, specCmd, tasksCmd, evidenceCmd, findingCmd);

  assertLeafCommandPolicies(program);
  return program;
}

/** Same registrations as execution; input/output seams fail if construction
 * accidentally executes an action. No user config, registry or session reads.
 */
export function createPolicyCommandProgram(): Command {
  const unavailable = (): never => {
    throw new Error("command inventory must not execute actions");
  };
  const i18n = createI18n("en", BUILTIN_BUNDLES);
  const ctx = createCommandContext(["node", "loaf"], {
    i18n,
    writeStdout: unavailable,
    writeStderr: unavailable,
  });
  const mutator = createCommandMutator(ctx, { registryWriter: undefined });
  const input = createJsonInputIngestor({
    readStdin: async () => unavailable(),
    isStdinTty: unavailable,
  });
  return createCommandProgram(
    ctx,
    mutator,
    input,
    i18n,
    "cli:inventory",
    {},
    unavailable,
    unavailable,
  );
}
