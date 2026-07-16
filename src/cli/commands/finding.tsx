import type { Command } from "commander";
import type { CommandContext } from "../command-context.js";
import type { CommandMutator } from "../command-mutator.js";
import {
  FAILURE_SITE_KEYS,
  SUCCESS_KEYS,
  CHROME_KEYS,
  findingActionKey,
  findingCategoryKey,
  findingStatusKey,
  type FindingStatus,
} from "../runtime-i18n-keys.js";
import { loadSession } from "../../core/cli-runtime.js";
import { buildFindingRaiseBatch } from "../batch-builders.js";
import { FindingAction, FindingCategory, FindingId } from "../../core/finding-schema.js";
import type { I18n } from "../i18n.js";

function formatFindingCategory(i18n: I18n, category: string): string {
  if (i18n.locale === "en") return category;
  const parsed = FindingCategory.safeParse(category);
  return parsed.success ? i18n.t(findingCategoryKey(parsed.data)) : category;
}

function formatFindingAction(i18n: I18n, action: string): string {
  if (i18n.locale === "en") return action;
  const parsed = FindingAction.safeParse(action);
  return parsed.success ? i18n.t(findingActionKey(parsed.data)) : action;
}

function formatFindingStatus(i18n: I18n, status: FindingStatus): string {
  return i18n.t(findingStatusKey(status));
}

export function registerFinding(
  program: Command,
  ctx: CommandContext,
  mutator: CommandMutator,
  actor: string,
): { findingCmd: Command } {
  // ── loaf finding raise / list / close ────────────────────────────────
  // Slice 3 SC3 — finding ledger CLI + FINDING_ACTION_GRID + target_payload
  // preflight (protocol §4.5 + §10.8 / src/core/finding-schema.ts).
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
    .action(
      async (opts: {
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
          ctx.emitFailure(
            "USAGE",
            "--target-task and --target-step must be specified together (or both omitted)",
          );
          return;
        }
        const featureDir = await ctx.dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
        if (!session.snapshot.state) {
          ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionFinding, opts.feature);
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

        // L9: finding-raise co-emission shape lives in buildFindingRaiseBatch
        // (fix-* reset batch / amend-* back-edge / lone). The builder owns the
        // action→batch mapping, ordering, and per-entry actor split; fix-* without
        // a target returns "none" so the lone path runs and preflight's
        // FINDING_TARGET_REQUIRED stays the authoritative target gate.
        const currentSubState = session.snapshot.state.sub_state;
        const findingBatch = buildFindingRaiseBatch({
          action: opts.action,
          findingPayload: payload,
          findingId: id,
          currentSubState,
          findingActor: actor,
          ...(hasTask && hasStep ? { target: { taskId: opts.targetTask! } } : {}),
        });
        if (findingBatch.kind === "none") {
          const result = await mutator.run(featureDir, session, {
            kind: "finding:raised",
            payload,
            actor,
          });
          if (!result) return;
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
              stateChange: `finding raise: ${id} (category=${opts.category}, action=${opts.action})`,
            },
          );
          return;
        }
        const batchResult = await mutator.run(featureDir, session, findingBatch.entries);
        if (!batchResult) return;
        ctx.success(
          {
            ok: true,
            feature: opts.feature,
            id,
            category: opts.category,
            action: opts.action,
            back_edge: { from: currentSubState, to: findingBatch.backEdgeTo },
          },
          // codex r98 §1: keep text-mode stdout bare (matches every other
          // `loaf finding raise` action). Callers script
          // `FND=$(loaf finding raise ...)` and feed the id straight into
          // `loaf finding close`; a decorated string would break that pipeline
          // contract. The back_edge sponsorship is observable from the journal
          // tail + JSON mode.
          () => id + "\n",
          {
            stateChange: `finding raise: ${id} (category=${opts.category}, action=${opts.action}) — back-edge to ${findingBatch.backEdgeTo}`,
          },
        );
      },
    );

  findingCmd
    .command("list")
    .description("List findings (read-only; --status filters open|closed)")
    .option("--feature <name>", "Feature whose findings to list")
    .option("--status <s>", "Filter by status (open | closed)")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; status?: string; featureDir?: string }) => {
      if (ctx.rejectIfDryRun("finding list")) return;
      if (opts.status !== undefined && opts.status !== "open" && opts.status !== "closed") {
        ctx.failureKeyed(
          "USAGE",
          FAILURE_SITE_KEYS.findingStatusInvalid,
          { allowed_statuses_human: "open | closed", value: opts.status },
          { allowed: ["open", "closed"], value: opts.status },
        );
        return;
      }
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      // Phase 15 SC3 — projection-loader. findings.json's FindingStateShape
      // is already byte-equal to the reducer's FindingState slim shape (id,
      // category, action, status, summary?, reason?, target?) — no adapter
      // beyond the array unwrap.
      const loaded = await ctx.loadProjectionsOrFail(
        featureDir,
        ["findings"] as const,
        opts.feature,
        FAILURE_SITE_KEYS.noSessionFinding,
      );
      if (loaded === null) return;
      const all = loaded.findings.findings;
      const rows = opts.status ? all.filter((f) => f.status === opts.status) : all;
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          count: rows.length,
          findings: rows,
        },
        (i18n) =>
          rows
            .map(
              (r) =>
                i18n.t(CHROME_KEYS.findingListRow, {
                  finding_id: r.id,
                  category: formatFindingCategory(i18n, r.category),
                  action: formatFindingAction(i18n, r.action),
                  status: formatFindingStatus(i18n, r.status),
                }) + "\n",
            )
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
        ctx.emitFailure(
          "INVALID_PAYLOAD",
          `finding close id must match FindingId regex /^FND-\\d{3,}$/ (got ${fndId})`,
          { id: fndId, issues: idParse.error.issues },
        );
        return;
      }
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionFinding, opts.feature);
        return;
      }
      // CLI-side pre-check surfaces FINDING_NOT_FOUND directly (instead of
      // letting mutate() wrap the reducer error as REDUCER_ERROR). Reducer
      // keeps the same checks as defense-in-depth for raw mutate paths.
      // Detail.reason distinguishes unknown vs already_closed for callers
      // that want to react programmatically (codex r68 #4).
      const existing = session.snapshot.findings.find((f) => f.id === fndId);
      if (!existing) {
        ctx.emitFailure("FINDING_NOT_FOUND", `finding:closed references unknown finding id=${fndId}`, {
          id: fndId,
          reason: "unknown",
        });
        return;
      }
      if (existing.status === "closed") {
        ctx.emitFailure(
          "FINDING_NOT_FOUND",
          `finding:closed references finding id=${fndId} that is already closed`,
          { id: fndId, reason: "already_closed" },
        );
        return;
      }
      const result = await mutator.run(featureDir, session, {
        kind: "finding:closed",
        payload: { id: fndId },
        actor,
      });
      if (!result) return;
      ctx.success(
        { ok: true, feature: opts.feature, id: fndId, status: "closed" },
        (i18n) => i18n.t(SUCCESS_KEYS.findingCloseText, { finding_id: fndId }) + "\n",
        (i18n) => ({
          stateChange: i18n.t(SUCCESS_KEYS.findingCloseStateChange, { finding_id: fndId }),
        }),
      );
    });

  return { findingCmd };
}
