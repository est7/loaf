import type { Command } from "commander";

import type { CommandContext } from "../command-context.js";
import type { I18n } from "../i18n.js";
import { CHROME_KEYS, FAILURE_SITE_KEYS } from "../runtime-i18n-keys.js";
import { loadSession } from "../../core/cli-runtime.js";
import type { JournalEntry } from "../../core/journal-entry.js";
import { KIND_REGISTRY } from "../../core/kind-registry.js";

type JournalListOptions = {
  afterSeq?: string;
  limit?: string;
  kind?: string;
  actor?: string;
  feature: string;
  featureDir?: string;
};

type JournalListRow = Pick<JournalEntry, "seq" | "entry_id" | "at" | "actor" | "kind"> &
  Partial<Pick<JournalEntry, "batch_id" | "batch_index" | "batch_count">>;

const JOURNAL_KINDS = Object.keys(KIND_REGISTRY);

export function registerJournal(program: Command, ctx: CommandContext): void {
  // `list` is the default subcommand so Commander's top-level `journal`
  // alias can provide the explicit `loaf log` compatibility spelling while
  // both surfaces still execute this single action handler.
  const journalCmd = program
    .command("journal")
    .alias("log")
    .description("Journal inspection commands (list; `loaf log` alias)");

  journalCmd
    .command("list", { isDefault: true })
    .description("List journal entry envelopes without interpreting payloads (read-only)")
    .option("--after-seq <n>", "Only include entries whose seq is greater than n")
    .option("--limit <n>", "Return at most n entries in journal order")
    .option("--kind <kind>", "Filter by the closed journal kind registry")
    .option("--actor <prefix-or-full>", "Filter by actor prefix or full actor string")
    .option("--feature <name>", "Feature whose journal to list")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: JournalListOptions) => {
      if (ctx.rejectIfDryRun("journal list")) return;

      const afterSeq = parseIntegerFilter(ctx, "--after-seq", opts.afterSeq, 0);
      if (afterSeq === null) return;
      const limit = parseIntegerFilter(ctx, "--limit", opts.limit, 1);
      if (limit === null) return;
      if (opts.kind !== undefined && !Object.hasOwn(KIND_REGISTRY, opts.kind)) {
        ctx.failureKeyed(
          "USAGE",
          FAILURE_SITE_KEYS.journalKindInvalid,
          { value: opts.kind },
          { value: opts.kind, allowed: JOURNAL_KINDS },
        );
        return;
      }
      if (opts.actor !== undefined && opts.actor.length === 0) {
        ctx.failureKeyed("USAGE", FAILURE_SITE_KEYS.journalActorInvalid, {});
        return;
      }

      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: false });
      if (session.snapshot.state === null) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
        return;
      }

      let entries = session.entries.filter(
        (entry) =>
          (afterSeq === undefined || entry.seq > afterSeq) &&
          (opts.kind === undefined || entry.kind === opts.kind) &&
          (opts.actor === undefined || entry.actor.startsWith(opts.actor)),
      );
      if (limit !== undefined) entries = entries.slice(0, limit);
      const rows = entries.map(toJournalListRow);

      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          count: rows.length,
          entries: rows,
        },
        (i18n) => renderJournalRows(i18n, rows),
      );
    });
}

function parseIntegerFilter(
  ctx: CommandContext,
  flag: "--after-seq" | "--limit",
  value: string | undefined,
  minimum: number,
): number | undefined | null {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    ctx.failureKeyed(
      "USAGE",
      FAILURE_SITE_KEYS.journalIntegerInvalid,
      { flag, value, minimum },
      { flag, value, minimum },
    );
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    ctx.failureKeyed(
      "USAGE",
      FAILURE_SITE_KEYS.journalIntegerInvalid,
      { flag, value, minimum },
      { flag, value, minimum },
    );
    return null;
  }
  return parsed;
}

function toJournalListRow(entry: JournalEntry): JournalListRow {
  const row: JournalListRow = {
    seq: entry.seq,
    entry_id: entry.entry_id,
    at: entry.at,
    actor: entry.actor,
    kind: entry.kind,
  };
  if (
    entry.batch_id !== undefined &&
    entry.batch_index !== undefined &&
    entry.batch_count !== undefined
  ) {
    row.batch_id = entry.batch_id;
    row.batch_index = entry.batch_index;
    row.batch_count = entry.batch_count;
  }
  return row;
}

function renderJournalRows(i18n: I18n, rows: readonly JournalListRow[]): string {
  if (rows.length === 0) return i18n.t(CHROME_KEYS.journalListEmpty) + "\n";
  return rows
    .map(
      (row) =>
        i18n.t(
          row.batch_id === undefined
            ? CHROME_KEYS.journalListRow
            : CHROME_KEYS.journalListRowBatch,
          {
            seq: row.seq,
            entry_id: row.entry_id,
            at: row.at,
            actor: row.actor,
            kind: row.kind,
            batch_id: row.batch_id,
            batch_index: row.batch_index,
            batch_count: row.batch_count,
          },
        ) + "\n",
    )
    .join("");
}
