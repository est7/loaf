import type { Command } from "commander";
import type { CommandContext } from "../command-context.js";
import type { CommandMutator } from "../command-mutator.js";
import { FAILURE_SITE_KEYS, CHROME_KEYS } from "../runtime-i18n-keys.js";
import { listSessions, formatAtRelative, type SessionRow } from "../sessions-list.js";
import {
  CHECK_KINDS,
  checkFile,
  renderSuccessText as renderCheckSuccess,
  type CheckKind,
} from "../check-file.js";
import {
  buildEnvelope as buildVerifyStatusEnvelope,
  renderText as renderVerifyStatusText,
} from "../verify-status.js";
import { evaluateVerifyAcceptDiagnostic } from "../../core/gates/verify-accept-eval.js";
import { loadSession } from "../../core/cli-runtime.js";
import {
  loadProjections,
  SnapshotStaleError,
  NoSessionError,
  type LoadResult,
} from "../../core/projection-loader.js";
import { readLoafConfig } from "../../core/loaf-config.js";
import {
  stepWritePaths,
  stepWriteCategories,
  VERIFY_CHECK_WRITE_PATHS,
  VERIFY_CHECK_WRITE_CATEGORIES,
  type WriteCategory,
  type VerifyCheckKind,
} from "../../core/step-write-paths.js";
import { SUB_STATE_CONTRACT_BY_STATE } from "../../core/sub-state-contracts.js";
import { evaluateWritePath } from "../../core/write-guard.js";
import { normalizeScopePath } from "../../core/scope-track.js";
import { compareScopePathBytes } from "../../core/journal-entry.js";
import { RuntimeStoreError, withRuntimeLock } from "../../core/session-runtime.js";
import {
  composeSessionStartContext,
  runClosureWarnings,
  sessionStartHookOutput,
} from "../../core/hook-read.js";
import { App as TuiApp } from "../tui/app.js";
import { classifyDetailOutcome, DETAIL_PROJECTION_KINDS } from "../tui/detail-model.js";
import { formatPhaseSub } from "../tui/format-row.js";
import { defaultRenderTui, type RenderTui } from "../tui/render.js";
import { createElement } from "react";
import type { I18n } from "../i18n.js";
import path from "node:path";
import { promises as fsPromises } from "node:fs";

export function registerIntegrations(
  program: Command,
  ctx: CommandContext,
  _mutator: CommandMutator,
  _actor: string,
  i18n: I18n,
  isStdinTty: () => boolean,
  renderTuiImpl: RenderTui | undefined,
  isStdoutTtyForTui: () => boolean,
  registryDir: string | undefined,
  now: (() => Date) | undefined,
  runtimeDir: string,
  runtimeNow: () => Date,
): void {
  // ── loaf hook <event> — Phase 16 SC-15a (framework only) ────────────
  program
    .command("hook <event>")
    .description(
      "Claude Code hook entry point (session-start + closure-check read-side; write-guard + scope-track land SC-15c)",
    )
    .option("--list-events", "Dump the canonical 4-event enum (handled by pre-parse guard)")
    .option("--feature <name>", "Feature whose session to read (read-side events)")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .option("--session <uuid>", "Resolve session by registry UUID (read-side events)")
    .option("--path <text>", "Tool target path (for write-guard / scope-track; SC-15c)")
    .action(
      async (event: string, opts: { feature?: string; featureDir?: string; path?: string }) => {
        // The pre-parse guard already validated `event ∈ HOOK_EVENTS`.

        // ── session-start (SC-15b) — inject sub_state context into the
        //    Claude Code SessionStart hook. No active session (non-loaf
        //    project / empty .loaf / stale) → silent exit 0, empty output. ──
        if (event === "session-start") {
          const d = await ctx.dispatchForHookOptional(opts);
          if ("skip" in d) return; // absence OR stale → silent (avoid misleading context)
          let loaded: LoadResult<"state" | "findings" | "pending">;
          try {
            loaded = await loadProjections({
              feature_dir: d.featureDir,
              kinds: ["state", "findings", "pending"] as const,
            });
          } catch {
            // NoSession race / stale / corrupt → stay silent for SessionStart.
            return;
          }
          const additionalContext = composeSessionStartContext({
            sub_state: loaded.state.sub_state,
            iteration: loaded.state.iteration,
            open_findings: loaded.findings.findings.filter((f) => f.status === "open"),
            pending: loaded.state.pending,
          });
          // Claude Code SessionStart hook wire shape — NOT the loaf {ok}
          // envelope (codex GO Q-A lock).
          process.stdout.write(JSON.stringify(sessionStartHookOutput(additionalContext)) + "\n");
          return;
        }

        // ── closure-check (SC-15b) — read-only consistency warnings on the
        //    Claude Code Stop event. ALWAYS exit 0 (warnings to stderr);
        //    blocking Stop is a regression. ──
        if (event === "closure-check") {
          const d = await ctx.dispatchForHookOptional(opts);
          if ("skip" in d) {
            if (d.stale) {
              process.stderr.write(`warning: closure-check skipped — ${d.stale.message}\n`);
            }
            return;
          }
          let loaded: LoadResult<"state" | "tasks" | "evidence" | "findings">;
          try {
            loaded = await loadProjections({
              feature_dir: d.featureDir,
              kinds: ["state", "tasks", "evidence", "findings"] as const,
            });
          } catch (err) {
            if (err instanceof SnapshotStaleError) {
              // Q-B check 1: projection freshness — warn, never block.
              process.stderr.write(`warning: closure-check skipped — ${err.message}\n`);
              return;
            }
            if (err instanceof NoSessionError) return; // absence → silent
            // Contract: closure-check must NEVER block the Claude Code Stop
            // event. Any other failure (EACCES / read error outside the stale
            // taxonomy) degrades to a stderr warning + exit 0 — it must not
            // escape to the UNEXPECTED_ERROR boundary (exit 1) (codex SC-15b
            // PATCH: blocking Stop is a regression).
            process.stderr.write(`warning: closure-check skipped — ${(err as Error).message}\n`);
            return;
          }
          const warnings = runClosureWarnings({
            state: loaded.state,
            tasks: loaded.tasks,
            evidence: loaded.evidence,
            findings: loaded.findings,
          });
          for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
          return;
        }

        // ── scope-track (ticket #11 SC3) — PostToolUse accumulator ──
        if (event === "scope-track") {
          const target = await ctx.resolveHookPath(opts);
          if (target === null) return; // USAGE / SCHEMA_VALIDATION_FAILED exit 2

          let dispatch: Awaited<ReturnType<typeof ctx.resolveDispatch>>;
          try {
            dispatch = await ctx.resolveDispatch();
          } catch (error) {
            ctx.emitFailure(
              "SNAPSHOT_STALE_REBUILD_REQUIRED",
              `scope-track cannot select a trustworthy session: ${(error as Error).message}`,
              { reason: (error as Error).message },
            );
            return;
          }
          if (!dispatch.ok) {
            if (dispatch.code === "FEATURE_NOT_FOUND") return; // non-loaf project → silent
            ctx.emitFailure(dispatch.code, `scope-track cannot select a session: ${dispatch.message}`, dispatch.detail);
            return;
          }
          opts.feature = dispatch.feature;
          opts.featureDir = dispatch.featureDir;
          ctx.recordTraceTarget(dispatch.feature, dispatch.featureDir);
          const sessionId = dispatch.sessionId;
          if (sessionId === null) {
            ctx.emitFailure(
              "SCHEMA_VALIDATION_FAILED",
              "scope-track selected a session without a canonical session_id",
              { source: "scope-track", reason: "selected_session_id_missing" },
            );
            return;
          }

          const repoRoot = path.dirname(path.dirname(dispatch.featureDir));
          let state: LoadResult<"state">["state"];
          try {
            state = (
              await loadProjections({
                feature_dir: dispatch.featureDir,
                kinds: ["state"] as const,
              })
            ).state;
          } catch (error) {
            const code =
              error instanceof SnapshotStaleError
                ? error.code
                : "SNAPSHOT_STALE_REBUILD_REQUIRED";
            ctx.emitFailure(code, `scope-track cannot load selected state: ${(error as Error).message}`, {
              reason: (error as Error).message,
            });
            return;
          }

          let normalized: Awaited<ReturnType<typeof normalizeScopePath>>;
          try {
            normalized = await normalizeScopePath(target, repoRoot);
          } catch {
            normalized = {
              ok: false,
              reason: "invalid_scope_path",
              path: target,
            };
          }
          const heartbeatAt = runtimeNow().toISOString();
          try {
            await withRuntimeLock(
              { session_id: sessionId, cwd: repoRoot },
              "scope-track",
              (current) => {
                const base =
                  current ??
                  ({
                    schema_version: 2,
                    session_id: sessionId,
                    cwd: repoRoot,
                    debug: ctx.debug,
                    heartbeat_at: heartbeatAt,
                    pending_scope: null,
                  } as const);
                if (
                  !normalized.ok ||
                  normalized.kind === "internal" ||
                  state.sub_state !== "EXECUTE.work"
                ) {
                  return { ...base, heartbeat_at: heartbeatAt };
                }
                const paths = new Set(
                  base.pending_scope?.iteration === state.iteration
                    ? base.pending_scope.paths
                    : [],
                );
                paths.add(normalized.path);
                return {
                  ...base,
                  heartbeat_at: heartbeatAt,
                  pending_scope: {
                    iteration: state.iteration,
                    paths: [...paths].sort(compareScopePathBytes),
                  },
                };
              },
              { runtimeDir, now: runtimeNow },
            );
          } catch (error) {
            const code =
              error instanceof RuntimeStoreError && error.code.startsWith("RUNTIME_LOCK_")
                ? "LOCK_TIMEOUT"
                : "SCHEMA_VALIDATION_FAILED";
            ctx.emitFailure(code, `scope-track runtime update failed: ${(error as Error).message}`, {
              source: "session-runtime",
              reason: (error as Error).message,
            });
            return;
          }

          if (!normalized.ok) {
            ctx.emitFailure(
              "SCHEMA_VALIDATION_FAILED",
              `scope-track rejected path: ${normalized.reason}`,
              { source: "scope-track", path: target, reason: normalized.reason },
            );
          }
          return;
        }

        // ── write-guard (SC-15c) — PreToolUse(Write,Edit) ──
        const target = await ctx.resolveHookPath(opts);
        if (target === null) return; // USAGE / SCHEMA exit 2 (already emitted)

        const wd = await ctx.resolveDispatchForWriteGuard(opts);
        if ("allow" in wd) return; // no loaf session here → allow, exit 0
        if ("failClosed" in wd) {
          ctx.emitFailure(wd.code, `write-guard blocked: ${wd.message}`, { reason: wd.message });
          return;
        }

        const repoRoot = path.dirname(path.dirname(wd.featureDir)); // <repoRoot>/.loaf/<feature>
        const feature = opts.feature!;

        // Config overlay — fail closed on an invalid (untrusted) config.
        const cfg = await readLoafConfig(repoRoot);
        if (cfg.status === "invalid") {
          ctx.failureKeyed(
            "SCHEMA_VALIDATION_FAILED",
            FAILURE_SITE_KEYS.writeGuardConfigInvalid,
            { reason: cfg.reason },
            {
              source: "loaf.config.json",
              reason: cfg.reason,
            },
          );
          return;
        }
        const config = cfg.status === "ok" ? cfg.config : null;

        // Projections — fail closed (stale/corrupt selected session must not
        // relax the write boundary; codex Q5 reversed polarity vs read-side).
        let loaded: LoadResult<"state" | "tasks">;
        try {
          loaded = await loadProjections({
            feature_dir: wd.featureDir,
            kinds: ["state", "tasks"] as const,
          });
        } catch (err) {
          const code =
            err instanceof SnapshotStaleError ? err.code : "SNAPSHOT_STALE_REBUILD_REQUIRED";
          ctx.emitFailure(code, `write-guard blocked: ${(err as Error).message}`, {
            reason: (err as Error).message,
          });
          return;
        }
        const { state, tasks } = loaded;

        // Assemble built-in globs (sub_state ∪ active task/step ∪ verify check)
        // + the config-widenable semantic categories for the active steps.
        const builtinGlobs: string[] = [
          ...(SUB_STATE_CONTRACT_BY_STATE[state.sub_state]?.write_paths ?? []),
        ];
        const activeCategories = new Set<WriteCategory>();
        for (const task of tasks?.tasks ?? []) {
          if (task.status !== "in_progress") continue;
          const execution =
            (task as { execution?: Record<string, { status?: string }> }).execution ?? {};
          for (const [step, st] of Object.entries(execution)) {
            if (st?.status === "running") {
              for (const g of stepWritePaths(task.kind, step)) builtinGlobs.push(g);
              for (const c of stepWriteCategories(task.kind, step)) activeCategories.add(c);
            }
          }
        }
        const [phase, sub] = state.sub_state.split(".");
        const VERIFY_CHECKS: readonly VerifyCheckKind[] = ["run", "review", "acceptance", "visual"];
        if (phase === "VERIFY" && VERIFY_CHECKS.includes(sub as VerifyCheckKind)) {
          const check = sub as VerifyCheckKind;
          for (const g of VERIFY_CHECK_WRITE_PATHS[check]) builtinGlobs.push(g);
          for (const c of VERIFY_CHECK_WRITE_CATEGORIES[check]) activeCategories.add(c);
        }

        const decision = evaluateWritePath({
          targetPath: target,
          repoRoot,
          feature,
          subState: state.sub_state,
          builtinGlobs,
          activeCategories: [...activeCategories],
          config,
        });

        if (decision.allowed) return; // exit 0 — write permitted
        if (decision.code === "PROTECTED_FILE_WRITE") {
          ctx.emitFailure(
            "PROTECTED_FILE_WRITE",
            `write blocked: \`${decision.normalizedPath}\` matches protected_files entry \`${decision.matchedDeny}\` — protected files are never writable`,
            {
              path: target,
              normalized_path: decision.normalizedPath,
              matched_deny: decision.matchedDeny,
            },
          );
          return;
        }
        // WRITE_PATH_VIOLATION — bound the allow_set for the detail envelope.
        ctx.emitFailure(
          "WRITE_PATH_VIOLATION",
          `write blocked: \`${decision.normalizedPath}\` is outside the allowed write paths for sub_state \`${state.sub_state}\``,
          {
            path: target,
            normalized_path: decision.normalizedPath,
            sub_state: state.sub_state,
            allow_set: decision.allowSet.slice(0, 30),
            ...(decision.reason ? { reason: decision.reason } : {}),
          },
        );
      },
    );

  // ── loaf tui — Phase 16 SC-14 ────────────────────────────────────────
  const resolvedRenderTui: RenderTui = renderTuiImpl ?? defaultRenderTui;
  program
    .command("tui")
    .description("Interactive session manager TUI (Ink; read-only, MVP)")
    .action(async () => {
      // no-feature — tui walks across all sessions
      if (ctx.rejectIfDryRun("tui")) return;
      // TTY guard — BOTH stdin and stdout must be TTY (codex r355 P4).
      const stdinTty = isStdinTty();
      const stdoutTty = isStdoutTtyForTui();
      if (!stdinTty || !stdoutTty) {
        ctx.emitFailure("USAGE", "TUI requires an interactive terminal (stdin/stdout TTY)", {
          stdin_tty: stdinTty,
          stdout_tty: stdoutTty,
        });
        return;
      }
      // loadRows closure: preserves deps.registryDir / LOAF_REGISTRY_DIR
      // behavior across initial load AND [r] refresh (codex r357
      // guardrail 2). Does NOT silently fall back to real user registry.
      const loadRows = async () => {
        const result = await listSessions(
          registryDir !== undefined ? { registryDir } : {},
        );
        return result.rows;
      };
      const loadDetail = async (row: SessionRow) => {
        const featureDir = path.join(row.cwd, ".loaf", row.feature);
        try {
          const loadedDetail = await loadProjections({
            feature_dir: featureDir,
            kinds: DETAIL_PROJECTION_KINDS,
          });
          return classifyDetailOutcome(row, { ok: true, loaded: loadedDetail }, new Date(), i18n);
        } catch (error) {
          return classifyDetailOutcome(row, { ok: false, error }, new Date(), i18n);
        }
      };
      const initialRows = await loadRows();
      const app = createElement(TuiApp, { initialRows, loadRows, loadDetail, i18n });
      await resolvedRenderTui(app);
    });

  const sessionsCmd = program.command("sessions").description("Session registry commands (list)");

  sessionsCmd
    .command("list")
    .description("List session registry entries (read-only; --in-cwd filters by current cwd)")
    .option("--in-cwd", "Only list sessions whose registered cwd matches the current cwd")
    .action(async (opts: { inCwd?: boolean }) => {
      // no-feature — sessions list walks across all features
      if (ctx.rejectIfDryRun("sessions list")) return;

      const filterCwd = opts.inCwd
        ? await fsPromises.realpath(process.cwd()).catch(() => process.cwd())
        : undefined;

      const result = await listSessions({
        ...(registryDir !== undefined && { registryDir }),
        ...(filterCwd !== undefined && { filterCwd }),
      });

      // Warnings → stderr via ctx.advisory (respects --quiet).
      for (const w of result.warnings) {
        const actionKey =
          w.reason === "orphan-cwd"
            ? opts.inCwd
              ? CHROME_KEYS.sessionsActionFilteredOut
              : CHROME_KEYS.sessionsActionOrphanCwd
            : CHROME_KEYS.sessionsActionSkipped;
        ctx.advisory(
          i18n.t(CHROME_KEYS.sessionsWarning, {
            file: w.file,
            action: i18n.t(actionKey),
            reason: w.reason,
            detail_suffix: w.detail ? `: ${w.detail}` : "",
          }),
        );
      }

      const nowDate = now?.() ?? new Date();

      ctx.success(
        {
          ok: true,
          count: result.rows.length,
          sessions: result.rows,
          warnings: result.warnings,
        },
        (textI18n) => {
          if (result.rows.length === 0) return textI18n.t(CHROME_KEYS.sessionsListEmpty) + "\n";
          // 4-column aligned: <short8> <feature> <phase.sub_state> <at>
          const lines: string[] = [];
          // Column widths
          const featureWidth = Math.max(...result.rows.map((r) => r.feature.length), 7);
          const stateWidth = Math.max(
            ...result.rows.map((r) => formatPhaseSub(r, textI18n).length),
            12,
          );
          for (const row of result.rows) {
            const at = formatAtRelative(row.at, nowDate, textI18n);
            const state = formatPhaseSub(row, textI18n);
            lines.push(
              `${row.session_id_short}  ${row.feature.padEnd(featureWidth)}  ${state.padEnd(stateWidth)}  ${at}\n`,
            );
          }
          return lines.join("");
        },
      );
    });

  // ── loaf check <path> ────────────────────────────────────────────────
  program
    .command("check <path>")
    .description("Validate an artifact file against its schema (read-only; CI-friendly)")
    .option(
      "--kind <kind>",
      `Artifact kind (one of ${CHECK_KINDS.join("|")}); auto-detected from basename when omitted`,
    )
    .action(async (filePath: string, opts: { kind?: string }) => {
      // no-feature — check is feature-agnostic per protocol §1891
      if (ctx.rejectIfDryRun("check")) return;

      // --kind validation
      let kind: CheckKind | undefined;
      if (opts.kind !== undefined) {
        if (!(CHECK_KINDS as readonly string[]).includes(opts.kind)) {
          ctx.failureKeyed(
            "USAGE",
            FAILURE_SITE_KEYS.checkKindInvalid,
            { value: opts.kind, allowed_kinds_human: CHECK_KINDS.join("|") },
            { provided: opts.kind, value: opts.kind, allowed: CHECK_KINDS },
          );
          return;
        }
        kind = opts.kind as CheckKind;
      }

      const result = await checkFile(
        kind === undefined ? { path: filePath } : { path: filePath, kind },
      );
      if (result.ok) {
        ctx.success(result, (checkI18n) => renderCheckSuccess(result, checkI18n));
        return;
      }
      if (result.code === "USAGE" && result.detail["suggestion"] !== undefined) {
        ctx.failureKeyed(
          "USAGE",
          FAILURE_SITE_KEYS.checkKindRequired,
          {
            subject: String(result.detail["argument"] ?? filePath),
            kind: "tasks",
            suggestion: String(result.detail["suggestion"]),
          },
          result.detail,
        );
        return;
      }
      if (result.code === "INPUT_FILE_NOT_FOUND") {
        ctx.failureKeyed(
          "INPUT_FILE_NOT_FOUND",
          FAILURE_SITE_KEYS.checkPathMissing,
          { path: String(result.detail["path"] ?? filePath) },
          result.detail,
        );
        return;
      }
      if (
        result.code === "SCHEMA_VALIDATION_FAILED" &&
        result.detail["kind"] !== undefined &&
        result.detail["path"] !== undefined &&
        result.detail["error_count"] !== undefined
      ) {
        ctx.failureKeyed(
          "SCHEMA_VALIDATION_FAILED",
          FAILURE_SITE_KEYS.schemaValidation,
          {
            kind: String(result.detail["kind"]),
            path: String(result.detail["path"]),
            error_count: String(result.detail["error_count"]),
            error_word: Number(result.detail["error_count"]) === 1 ? "error" : "errors",
          },
          result.detail,
        );
        return;
      }
      ctx.emitFailure(result.code, result.message, result.detail);
    });

  // ── loaf verify status ───────────────────────────────────────────────
  const verifyCmd = program
    .command("verify")
    .description("Verify-accept gate read commands (status)");

  verifyCmd
    .command("status")
    .description("Show per-check verify-accept diagnostic (read-only)")
    .option("--feature <name>", "Feature whose verify status to show")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature?: string; featureDir?: string }) => {
      if (ctx.rejectIfDryRun("verify status")) return;
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      const diag = await evaluateVerifyAcceptDiagnostic(session.snapshot, featureDir);
      if (!diag.ok) {
        // IO-boundary divergence: frontmatter unreadable → exit 2,
        // structured envelope on stderr. Does NOT synthesize a check-1
        // row (codex r302 lock).
        ctx.emitFailure(diag.code, diag.message, diag.detail);
        return;
      }
      const env = buildVerifyStatusEnvelope(diag.checks);
      ctx.success(env, (verI18n) => renderVerifyStatusText(env, verI18n));
    });
}
