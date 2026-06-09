// `loaf prune` — session GC CLI surface.
//
// Main path (6a): resolve → (preview | execute) → audit. Targets ALWAYS come
// from resolvePruneTargets (never hand-built) so the status + lock safety gates
// can't be bypassed. Preview by default (no side effects); --yes executes.
//
// 6b modes/subcommands: `prune --history` (read the audit log), `prune --trash
// --older-than <N>d` (trash retention sweep, preview/--yes), and the `prune
// restore <id>` subcommand (surfaces the 4 PRUNE_RESTORE_* / PRUNE_PATH_OCCUPIED
// codes via ctx.failure).

import { promises as fs } from "node:fs";
import path from "node:path";

import type { Command } from "commander";
import { tryRealpath } from "../../core/registry-read.js";
import type { CommandContext } from "../command-context.js";
import { appendPruneLog, readPruneLog } from "../prune/audit.js";
import { executePrune } from "../prune/execute.js";
import { resolvePruneTargets, type PruneScope } from "../prune/resolve.js";
import { restorePrune } from "../prune/restore.js";
import { gcTrash } from "../prune/trash-gc.js";
import { toTrashTs } from "../prune/trash-ts.js";

export interface PruneDeps {
  /** Resolved registry dir (deps.registryDir ?? defaultRegistryDir()). */
  registryDir: string;
  now: () => Date;
  actor: string;
}

interface PruneOpts {
  session?: string;
  inCwd?: boolean;
  project?: string;
  all?: boolean;
  orphans?: boolean;
  force?: boolean;
  purge?: boolean;
  yes?: boolean;
}

/** Resolve a uuid prefix against the registry (mirrors SESSION_SHORT_AMBIGUOUS). */
async function resolveSessionPrefix(
  registryDir: string,
  prefix: string,
): Promise<
  { kind: "found"; id: string } | { kind: "not-found" } | { kind: "ambiguous"; matches: string[] }
> {
  let files: string[];
  try {
    files = await fs.readdir(registryDir);
  } catch {
    return { kind: "not-found" };
  }
  const matches = files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .filter((id) => id.startsWith(prefix));
  if (matches.length === 0) return { kind: "not-found" };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "found", id: matches[0]! };
}

/** Commander coercion for `--older-than <days>`: positive integer or throws. */
function parseDaysOption(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--older-than must be a non-negative integer number of days (got ${value})`);
  }
  return n;
}

function describeScope(scope: PruneScope): string {
  switch (scope.kind) {
    case "session":
      return `session:${scope.id}`;
    case "cwd":
      return `cwd:${scope.cwd}`;
    case "orphans":
      return scope.cwd === undefined ? "orphans" : `orphans:${scope.cwd}`;
    default:
      return "all";
  }
}

export function registerPrune(program: Command, ctx: CommandContext, deps: PruneDeps): void {
  const pruneCmd = program
    .command("prune")
    .description(
      "Garbage-collect finished sessions (terminal-only; recoverable trash). Scope with the global --session <id> or one of --in-cwd / --project / --all / --orphans.",
    )
    .option("--in-cwd", "Prune sessions registered under the current cwd")
    .option("--project <path>", "Prune sessions registered under <path>")
    .option("--all", "Prune across all sessions (global)")
    .option("--orphans", "Remove only dangling registry entries (feature dir gone)")
    .option("--force", "Include active (non-terminal) sessions — never overrides a held lock")
    .option("--purge", "Hard-delete instead of moving to recoverable trash")
    .option("--yes", "Execute; without it, prune previews and changes nothing")
    .option("--history", "Print the prune audit log (~/.loaf/prune-log.jsonl) and exit")
    .option("--trash", "Trash retention sweep: remove trash buckets older than --older-than")
    .option(
      "--older-than <days>",
      "(with --trash) remove buckets older than N days",
      parseDaysOption,
    )
    .action(async (_localOpts: PruneOpts, command: Command) => {
      // no-feature — prune GCs the session registry across all sessions; it is
      // not feature-addressed and records no trace target.
      // `--session` and `--dry-run` are GLOBAL program options (cli.tsx); a
      // subcommand-local `--session` would collide and never reach this action,
      // so read the merged view. `--dry-run` forces preview (never executes).
      const opts = command.optsWithGlobals() as PruneOpts & {
        session?: string;
        dryRun?: boolean;
        history?: boolean;
        trash?: boolean;
        olderThan?: number;
      };
      const base = path.dirname(deps.registryDir);

      // ── mode: --history (read the audit log) ───────────────────────
      if (opts.history === true) {
        const entries = await readPruneLog(path.join(base, "prune-log.jsonl"));
        ctx.success({ ok: true, count: entries.length, entries }, () => {
          if (entries.length === 0) return "prune history: (empty)\n";
          return `${entries
            .map((e) => `${e.at}  ${e.mode}  ${e.scope}  pruned=${e.pruned.length}`)
            .join("\n")}\n`;
        });
        return;
      }

      // ── mode: --trash --older-than <N> (retention sweep) ───────────
      if (opts.trash === true) {
        if (opts.olderThan === undefined) {
          ctx.emitFailure("USAGE", "loaf prune --trash requires --older-than <days>", {});
          return;
        }
        const previewTrash = opts.yes !== true || opts.dryRun === true;
        const r = await gcTrash({
          trashDir: path.join(base, "trash"),
          olderThanDays: opts.olderThan,
          now: deps.now(),
          dryRun: previewTrash,
        });
        ctx.success(
          { ok: true, dry_run: previewTrash, removed: r.removed, kept: r.kept },
          () =>
            `${previewTrash ? "would remove" : "removed"} ${r.removed.length} trash bucket(s), kept ${r.kept.length}` +
            (previewTrash ? " — re-run with --yes to execute" : "") +
            "\n",
        );
        return;
      }

      // Exactly one scope.
      const scopeCount =
        (opts.session !== undefined ? 1 : 0) +
        (opts.inCwd ? 1 : 0) +
        (opts.project !== undefined ? 1 : 0) +
        (opts.all ? 1 : 0) +
        (opts.orphans ? 1 : 0);
      if (scopeCount !== 1) {
        ctx.emitFailure(
          "USAGE",
          "loaf prune requires exactly one scope: --session <id> | --in-cwd | --project <path> | --all | --orphans",
          { scope_count: scopeCount },
        );
        return;
      }

      let scope: PruneScope;
      if (opts.session !== undefined) {
        const resolved = await resolveSessionPrefix(deps.registryDir, opts.session);
        if (resolved.kind === "not-found") {
          ctx.emitFailure("SESSION_NOT_FOUND", `no session matches '${opts.session}'`, {
            uuid_or_prefix: opts.session,
          });
          return;
        }
        if (resolved.kind === "ambiguous") {
          ctx.emitFailure(
            "SESSION_SHORT_AMBIGUOUS",
            `prefix '${opts.session}' matches ${resolved.matches.length} sessions; use a longer prefix`,
            {
              prefix: opts.session,
              match_count: resolved.matches.length,
              candidate_list: resolved.matches,
            },
          );
          return;
        }
        scope = { kind: "session", id: resolved.id };
      } else if (opts.inCwd) {
        const cwd = (await tryRealpath(process.cwd())) ?? process.cwd();
        scope = { kind: "cwd", cwd };
      } else if (opts.project !== undefined) {
        const cwd = (await tryRealpath(opts.project)) ?? opts.project;
        scope = { kind: "cwd", cwd };
      } else if (opts.all) {
        scope = { kind: "all" };
      } else {
        scope = { kind: "orphans" };
      }

      const { targets, skipped } = await resolvePruneTargets({
        registryDir: deps.registryDir,
        scope,
        includeActive: opts.force === true,
      });

      const mode = opts.purge === true ? "purge" : "trash";

      // Preview by default — no --yes, no side effects. The global --dry-run
      // forces preview even with --yes (belt-and-suspenders, per the plan).
      const previewOnly = opts.yes !== true || opts.dryRun === true;
      if (previewOnly) {
        ctx.success(
          {
            ok: true,
            dry_run: true,
            mode,
            pruned: targets.map((t) => ({
              session_id: t.session_id,
              feature: t.feature,
              cwd: t.cwd,
              sub_state: t.sub_state,
              orphan: t.orphan,
            })),
            skipped,
          },
          () =>
            `would ${mode} ${targets.length} session(s)` +
            (skipped.length > 0 ? `, skip ${skipped.length}` : "") +
            ` — re-run with --yes to execute\n`,
        );
        return;
      }

      const trashDir = path.join(base, "trash");
      const logPath = path.join(base, "prune-log.jsonl");
      const timestamp = toTrashTs(deps.now());

      const result = await executePrune({
        registryDir: deps.registryDir,
        trashDir,
        targets,
        mode,
        timestamp,
      });

      // Audit AFTER execute so the log records the actual outcome (M2). The
      // crash window between the destructive moves and this append is a
      // documented residual; the trash itself is the recovery of record.
      await appendPruneLog(logPath, {
        at: deps.now().toISOString(),
        scope: describeScope(scope),
        mode,
        actor: deps.actor,
        pruned: result.done.map((d) => ({
          session_id: d.session_id,
          feature: d.feature,
          orphan: d.orphan,
        })),
        skipped: skipped.map((s) => ({ session_id: s.session_id, reason: s.reason })),
        // Preserve a partial failure in the durable record (codex 6a BLOCK).
        ...(result.failed.length > 0 && { failed: result.failed }),
      });

      const body = { dry_run: false, mode, pruned: result.done, skipped, failed: result.failed };

      // A partial failure is NOT a successful command outcome — exit non-zero so
      // scripts don't proceed as if prune fully succeeded (codex 6a BLOCK). The
      // structured body still carries pruned/skipped/failed for inspection.
      if (result.failed.length > 0) {
        ctx.emitFailure(
          "PRUNE_PARTIAL_FAILURE",
          `prune partially failed: ${result.failed.length} of ${result.done.length + result.failed.length} session(s) could not be removed`,
          body,
        );
        return;
      }

      ctx.success(
        { ok: true, ...body },
        () =>
          `${mode === "purge" ? "purged" : "pruned"} ${result.done.length} session(s)` +
          (skipped.length > 0 ? `, skipped ${skipped.length}` : "") +
          "\n",
      );
    });

  // ── loaf prune restore <id> [--at <ts>] ──────────────────────────
  // Inverse of trash: surfaces the 4 PRUNE_RESTORE_* / PRUNE_PATH_OCCUPIED
  // codes via ctx.failure. Takes the FULL session uuid (shown by --history /
  // preview); a partial id would not match a trash bucket dir name.
  pruneCmd
    .command("restore <session-id>")
    .description("Restore a trashed session (registry entry + feature dir) from the prune trash")
    .option("--at <ts>", "Disambiguate when the session was trashed more than once")
    .action(async (sessionId: string, localOpts: { at?: string }) => {
      // no-feature — restore addresses a trashed session by uuid, not a feature.
      const trashDir = path.join(path.dirname(deps.registryDir), "trash");
      const result = await restorePrune({
        registryDir: deps.registryDir,
        trashDir,
        sessionId,
        ...(localOpts.at !== undefined && { at: localOpts.at }),
      });
      if (!result.ok) {
        ctx.emitFailure(result.code, result.message, result.detail ?? {});
        return;
      }
      ctx.success(
        {
          ok: true,
          session_id: result.session_id,
          feature: result.feature,
          cwd: result.cwd,
        },
        () => `restored ${result.session_id} (${result.feature})\n`,
      );
    });
}
