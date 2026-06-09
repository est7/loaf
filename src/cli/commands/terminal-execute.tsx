import type { Command } from "commander";
import type { CommandContext } from "../command-context.js";
import type { CommandMutator } from "../command-mutator.js";
import { FAILURE_SITE_KEYS, SUCCESS_KEYS } from "../runtime-i18n-keys.js";
import { loadSession } from "../../core/cli-runtime.js";

export function registerTerminalExecute(
  program: Command,
  ctx: CommandContext,
  mutator: CommandMutator,
  actor: string,
): void {
  // ── loaf deliver ────────────────────────────────────────────────────
  // Slice 1.D sub-cycle 2. Emits a single `session:delivered` entry
  // (human-only actor); the reducer flips the cursor directly to
  // DONE.delivered (no companion `event:phase_advanced` — that edge was
  // removed in sub-cycle 1). Three legal source sub_states per
  // PER_KIND_SUB_STATE: EXECUTE.done, VERIFY.accept, SETTLE.lessons.
  // Preflight step 5c enforces the ceremony / verify_accepted / spike-
  // tasks preconditions per protocol §5.2 / §10.8 / §1824:
  //   * EXECUTE.done    → v0.1.1 verify-min (quick/light): per-task evidence
  //                       gate; missing → DELIVER_VERIFY_MIN_INCOMPLETE,
  //                       standard/deep here → DELIVER_NOT_ACCEPTED.
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
      const humanActor = ctx.resolveHumanActorOrFail();
      if (humanActor === null) return;

      // (2) Load session via ctx (caches per featureDir; ctx also captures
      //     the resolved sub_state for snapshotCrashContext enrichment).
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await ctx.resolveSession(featureDir);
      const from = session.snapshot.state?.sub_state;
      if (!from) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
        return;
      }

      // (3) Build payload (reason is optional per SessionReasonPayload).
      const payload: Record<string, unknown> = {};
      if (opts.reason !== undefined) payload["reason"] = opts.reason;

      // (4) Mutate. preflight step 5c enforces all delivery preconditions;
      //     reducer flips cursor to DONE.delivered.
      const result = await mutator.run(
        featureDir,
        session,
        { kind: "session:delivered", payload, actor: humanActor },
        "raw-ctx-failure",
      );
      if (!result) return;

      // (5) Success output via ctx.success — stateChange + next routed to
      //     stderr per protocol §10.12 (SC-5b2). The advisory string
      //     remains in the JSON payload for back-compat.
      const advisory = [`session complete — \`loaf start <feature>\` to begin another`];
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
        (i18n) => ({
          stateChange: i18n.t(SUCCESS_KEYS.deliverStateChange, {
            feature: opts.feature,
            from,
            actor: humanActor,
          }),
          next: i18n.t(SUCCESS_KEYS.deliverNext),
        }),
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
    .description(
      "Close the feature session without delivering (emits session:archived → DONE.archived)",
    )
    .option("--feature <name>", "Feature whose session to archive")
    .requiredOption("--reason <text>", "Rationale recorded on the session:archived entry")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; reason: string; featureDir?: string }) => {
      // (1) Human-only actor — `session:archived` is HUMAN_ONLY per PER_KIND_ACTOR.
      const humanActor = ctx.resolveHumanActorOrFail();
      if (humanActor === null) return;

      // (2) Load session.
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      const from = session.snapshot.state?.sub_state;
      if (!from) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
        return;
      }

      // (3) Mutate. preflight step 5c.2 enforces reason-required; reducer
      //     flips cursor to DONE.archived.
      const result = await mutator.run(featureDir, session, {
        kind: "session:archived",
        payload: { reason: opts.reason },
        actor: humanActor,
      });
      if (!result) return;

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
        (i18n) => ({
          stateChange: i18n.t(SUCCESS_KEYS.archiveStateChange, {
            feature: opts.feature,
            from,
            actor: humanActor,
          }),
        }),
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
      const humanActor = ctx.resolveHumanActorOrFail();
      if (humanActor === null) return;

      // (2) Load session.
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      const from = session.snapshot.state?.sub_state;
      if (!from) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
        return;
      }

      // (3) Mutate. preflight step 5c.2 enforces reason-required; reducer
      //     flips cursor to DONE.abandoned.
      const result = await mutator.run(featureDir, session, {
        kind: "session:abandoned",
        payload: { reason: opts.reason },
        actor: humanActor,
      });
      if (!result) return;

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
        (i18n) => ({
          stateChange: i18n.t(SUCCESS_KEYS.abandonStateChange, {
            feature: opts.feature,
            from,
            actor: humanActor,
            reason: opts.reason,
          }),
        }),
      );
    });
}
