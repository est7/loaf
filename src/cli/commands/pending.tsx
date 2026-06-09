import type { Command } from "commander";
import type { CommandContext } from "../command-context.js";
import type { CommandMutator } from "../command-mutator.js";
import { FAILURE_SITE_KEYS, SUCCESS_KEYS, CHROME_KEYS, pendingKindKey } from "../runtime-i18n-keys.js";
import { loadSession } from "../../core/cli-runtime.js";
import { PendingPromptKind } from "../../core/journal-entry.js";
import type { I18n } from "../i18n.js";

function formatPendingKind(i18n: I18n, kind: string): string {
  if (i18n.locale === "en") return kind;
  const parsed = PendingPromptKind.safeParse(kind);
  return parsed.success ? i18n.t(pendingKindKey(parsed.data)) : kind;
}

export function registerPending(
  program: Command,
  ctx: CommandContext,
  mutator: CommandMutator,
  actor: string,
): void {
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
    .action(
      async (opts: {
        kind: string;
        question: string;
        options?: string;
        taskId?: string;
        feature: string;
        featureDir?: string;
      }) => {
        const featureDir = await ctx.dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
        if (!session.snapshot.state) {
          ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionPending, opts.feature);
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
        const result = await mutator.run(featureDir, session, {
          kind: "pending:added",
          payload,
          actor,
        });
        if (!result) return;
        ctx.success(
          { ok: true, feature: opts.feature, id, kind: opts.kind },
          () => id + "\n",
          (i18n) => ({
            stateChange: i18n.t(SUCCESS_KEYS.pendingRaiseStateChange, {
              pending_id: id,
              kind: opts.kind,
            }),
          }),
        );
      },
    );

  pendingCmd
    .command("list")
    .description("List pending entries (FIFO; first unresolved is head)")
    .option("--feature <name>", "Feature whose pending to list")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      if (ctx.rejectIfDryRun("pending list")) return;
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      // Phase 15 SC3 — projection-loader. Adapter: PendingProjectionEntry
      // (pending.json native — pending_id + rich fields) → slim row
      // {id, kind, resolved, head} matching the prior PendingState shape.
      const loaded = await ctx.loadProjectionsOrFail(
        featureDir,
        ["pending"] as const,
        opts.feature,
        FAILURE_SITE_KEYS.noSessionPending,
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
        (i18n) =>
          rows
            .map(
              (r) =>
                i18n.t(CHROME_KEYS.pendingListRow, {
                  pending_id: r.id,
                  kind: formatPendingKind(i18n, r.kind),
                  status: i18n.t(
                    r.resolved ? CHROME_KEYS.pendingResolved : CHROME_KEYS.pendingOpen,
                  ),
                  head: i18n.t(r.head ? CHROME_KEYS.pendingHead : CHROME_KEYS.pendingNonHead),
                }) + "\n",
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
      if (ctx.rejectIfDryRun("pending status")) return;
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionPending, opts.feature);
        return;
      }
      const headIdx = session.snapshot.pending.findIndex((p) => !p.resolved);
      let target: { id: string; kind: string; resolved: boolean; head: boolean } | null;
      if (opts.id !== undefined) {
        const idx = session.snapshot.pending.findIndex((p) => p.id === opts.id);
        if (idx === -1) {
          ctx.emitFailure("PENDING_NOT_FOUND", `pending id=${opts.id} not found in queue`, {
            pending_id: opts.id,
          });
          return;
        }
        target = { ...session.snapshot.pending[idx]!, head: idx === headIdx };
      } else {
        // Default = head; empty queue yields null (script-friendly per
        // codex r63 — distinct from --id miss which is PENDING_NOT_FOUND).
        target = headIdx === -1 ? null : { ...session.snapshot.pending[headIdx]!, head: true };
      }
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          pending: target,
        },
        (i18n) => {
          if (target === null) return i18n.t(CHROME_KEYS.pendingStatusNoOpen) + "\n";
          return (
            i18n.t(CHROME_KEYS.pendingListRow, {
              pending_id: target.id,
              kind: formatPendingKind(i18n, target.kind),
              status: i18n.t(
                target.resolved ? CHROME_KEYS.pendingResolved : CHROME_KEYS.pendingOpen,
              ),
              head: i18n.t(target.head ? CHROME_KEYS.pendingHead : CHROME_KEYS.pendingNonHead),
            }) + "\n"
          );
        },
      );
    });

  pendingCmd
    .command("resolve")
    .description("Resolve the head pending entry (strict FIFO; no --id flag)")
    .requiredOption(
      "--answer <text>",
      "Resolution answer (passthrough into pending:resolved payload)",
    )
    .option("--feature <name>", "Feature whose pending to resolve")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { answer: string; feature: string; featureDir?: string }) => {
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionPending, opts.feature);
        return;
      }
      const head = session.snapshot.pending.find((p) => !p.resolved);
      if (!head) {
        ctx.emitFailure(
          "PENDING_NOT_FOUND",
          "pending:resolved called but the queue has no unresolved head",
        );
        return;
      }
      const result = await mutator.run(featureDir, session, {
        kind: "pending:resolved",
        payload: { id: head.id, answer: opts.answer },
        actor,
      });
      if (!result) return;
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          resolved_id: head.id,
          kind: head.kind,
        },
        (i18n) =>
          i18n.t(SUCCESS_KEYS.pendingResolveText, {
            pending_id: head.id,
            kind: head.kind,
          }) + "\n",
        (i18n) => ({
          stateChange: i18n.t(SUCCESS_KEYS.pendingResolveStateChange, { pending_id: head.id }),
        }),
      );
    });
}
