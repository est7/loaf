import type { Command } from "commander";
import type { CommandContext } from "../command-context.js";
import type { CommandMutator } from "../command-mutator.js";
import { FAILURE_SITE_KEYS, SUCCESS_KEYS } from "../runtime-i18n-keys.js";
import { loadSession } from "../../core/cli-runtime.js";
import { buildGateApprovalBatch } from "../batch-builders.js";
import {
  buildNextAdvisoryFromSnapshot,
  selectorForCommandContext,
} from "../next-advisory.js";

export function registerGate(
  program: Command,
  ctx: CommandContext,
  mutator: CommandMutator,
  actor: string,
): void {
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
    .description("Decide a gate (emits gate:decided; spec-lock approve also advances cursor)")
    .option("--approve", "Approve the gate")
    .option("--reject", "Reject the gate")
    .requiredOption("--reason <text>", "Decision rationale (passed through to GateDecidedPayload)")
    .option("--feature <name>", "Feature whose session to gate")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
      async (
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
          ctx.emitFailure("USAGE", "exactly one of --approve | --reject is required");
          return;
        }
        // (2) gate name validation — must be in GateName enum
        if (gateName !== "spec-lock" && gateName !== "verify-accept") {
          ctx.emitFailure(
            "GATE_NOT_IMPLEMENTED",
            `gate=${gateName} is not recognized; protocol GateName enum is closed at {spec-lock, verify-accept}`,
            { gate: gateName },
          );
          return;
        }
        // (3) resolve human actor (gate is human-only per per-kind actor policy)
        const humanActor = ctx.resolveHumanActorOrFail();
        if (humanActor === null) return;
        // (4) load session
        const featureDir = await ctx.dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
        const from = session.snapshot.state?.sub_state;
        if (!from) {
          ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
          return;
        }
        // (5) build entries + execute per-gate
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
            const result = await mutator.run(
              featureDir,
              session,
              buildGateApprovalBatch({
                gate: "spec-lock",
                reason: opts.reason,
                humanActor,
                cliActor: actor,
                from,
                ...(coEmitPendingResolved && pendingHead ? { pendingHeadId: pendingHead.id } : {}),
              }),
            );
            if (!result) return;
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
            const selector = await selectorForCommandContext(ctx);
            ctx.success(
              out,
              () => "",
              (i18n) => {
                const next = buildNextAdvisoryFromSnapshot(
                  i18n,
                  result.snapshot,
                  featureDir,
                  selector,
                );
                return {
                  stateChange: i18n.t(SUCCESS_KEYS.gateSpecLockApprovedStateChange, {
                    actor: humanActor,
                  }),
                  ...(next === undefined ? {} : { next }),
                };
              },
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
          const result = await mutator.run(
            featureDir,
            session,
            buildGateApprovalBatch({
              gate: "verify-accept",
              reason: opts.reason,
              humanActor,
              cliActor: actor,
              ...(coEmitPendingResolved && pendingHead ? { pendingHeadId: pendingHead.id } : {}),
            }),
          );
          if (!result) return;
          const out = {
            ok: true,
            gate: "verify-accept",
            decision: "approved" as const,
            from,
            actor: humanActor,
            sub_state: result.snapshot.state?.sub_state,
            verify_accepted: result.snapshot.state?.verify_accepted,
          };
          const selector = await selectorForCommandContext(ctx);
          ctx.success(
            out,
            () => "",
            (i18n) => {
              const next = buildNextAdvisoryFromSnapshot(
                i18n,
                result.snapshot,
                featureDir,
                selector,
              );
              return {
                stateChange: i18n.t(SUCCESS_KEYS.gateVerifyAcceptApprovedStateChange, {
                  actor: humanActor,
                }),
                ...(next === undefined ? {} : { next }),
              };
            },
          );
          return;
        }
        // reject: single entry, no cursor side-effect, no Pass 1.5 eval.
        // Shared between spec-lock and verify-accept.
        const result = await mutator.run(featureDir, session, {
          kind: "gate:decided",
          payload: { gate_kind: gateName, decision: "rejected", reason: opts.reason },
          actor: humanActor,
        });
        if (!result) return;
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
          (i18n) => ({
            stateChange: i18n.t(SUCCESS_KEYS.gateRejectedStateChange, {
              gate: gateName,
              actor: humanActor,
            }),
          }),
        );
      },
    );
}
