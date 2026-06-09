// `loaf prune <scope>` — session GC CLI surface (slice 6a).
//
// One-way pipeline: resolve → (preview | execute) → audit. Targets ALWAYS come
// from resolvePruneTargets (never hand-built) so the status + lock safety gates
// can't be bypassed. Preview by default (no side effects); --yes executes.
//
// Deferred to slice 6b (codex prune-core notes): resolve matches a session's
// stored cwd literally, so --in-cwd / --project canonicalize the SCOPE side here
// but full realpath symmetry on the stored side is 6b; --history / restore /
// --trash --older-than subcommands; audit EACCES/corrupt surfacing.

import { promises as fs } from "node:fs";
import path from "node:path";

import type { Command } from "commander";
import { tryRealpath } from "../../core/registry-read.js";
import type { CommandContext } from "../command-context.js";
import { appendPruneLog } from "../prune/audit.js";
import { executePrune } from "../prune/execute.js";
import { resolvePruneTargets, type PruneScope } from "../prune/resolve.js";
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
): Promise<{ kind: "found"; id: string } | { kind: "not-found" } | { kind: "ambiguous"; matches: string[] }> {
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
  program
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
    .action(async (_localOpts: PruneOpts, command: Command) => {
      // no-feature — prune GCs the session registry across all sessions; it is
      // not feature-addressed and records no trace target.
      // `--session` and `--dry-run` are GLOBAL program options (cli.tsx); a
      // subcommand-local `--session` would collide and never reach this action,
      // so read the merged view. `--dry-run` forces preview (never executes).
      const opts = command.optsWithGlobals() as PruneOpts & {
        session?: string;
        dryRun?: boolean;
      };
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

      const base = path.dirname(deps.registryDir);
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
      });

      ctx.success(
        { ok: true, dry_run: false, mode, pruned: result.done, skipped, failed: result.failed },
        () =>
          `${mode === "purge" ? "purged" : "pruned"} ${result.done.length} session(s)` +
          (skipped.length > 0 ? `, skipped ${skipped.length}` : "") +
          (result.failed.length > 0 ? `, ${result.failed.length} FAILED` : "") +
          "\n",
      );
    });
}
