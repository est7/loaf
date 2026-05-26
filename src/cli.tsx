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
import { promises as fsP, readFileSync } from "node:fs";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };

import { UNEXPECTED_ERROR, writeCrashLog } from "./core/crash-log.js";
import { createCommandContext } from "./cli/command-context.js";
import { buildReportUrl } from "./cli/url-prefill.js";

import { resolveHumanActor } from "./core/actor-resolver.js";
import {
  LOAF_DOCS_URL,
  LOAF_ISSUE_URL,
  defaultFeatureDir,
  getGitEmail,
  helpFooter,
  loadSession,
} from "./core/cli-runtime.js";
import { mutate, mutateBatch } from "./core/journal-mutate.js";
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
import {
  SpecAddReqInput,
  SpecAddScenarioInput,
  SpecAddVisualInput,
  SpecFrontmatter,
  SpecSubmitInput,
  nextSerialInNamespace,
} from "./core/spec-schema.js";

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

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = new Command();

  program
    .name("loaf")
    .description("Spec-driven development protocol CLI")
    .version(packageJson.version)
    .option("--json", "Emit JSON output on stdout")
    .addHelpText("after", helpFooter())
    .showHelpAfterError()
    .exitOverride();

  const useJson = argv.includes("--json");
  const actor = `cli:loaf@${process.env["USER"] ?? "unknown"}`;

  // Phase 16 SC-3 — CommandContext is the presentation-layer plumbing
  // that owns output channel + lazy session/projection cache + failure
  // routing + crash-log context snapshot. fail()/emitFailure() become
  // thin shims so all 28 unmigrated commands transparently route through
  // ctx without per-call-site changes (codex r206 axis G: 1 representative
  // command migrated; rest follow in SC-4..SC-15 as each is touched).
  const ctx = createCommandContext(argv, {
    writeStdout: (s) => process.stdout.write(s),
    writeStderr: (s) => process.stderr.write(s),
    loadSession,
    loadProjections,
  });
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
      const session = await loadSession(featureDir);
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        fail(result.code, result.message);
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
      process.stdout.write(useJson ? JSON.stringify(out) + "\n" : `started ${feature} (${opts.ceremony}) — session ${sessionId}\n`);
    });

  // ── loaf advance <to> ───────────────────────────────────────────────
  program
    .command("advance <to>")
    .description("Advance the session cursor (emits event:phase_advanced)")
    .requiredOption("--feature <name>", "Feature whose session to advance")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (to: string, opts: { feature: string; featureDir?: string }) => {
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        fail(result.code, result.message);
        return;
      }
      const out = { ok: true, from, to, sub_state: result.snapshot.state?.sub_state };
      process.stdout.write(useJson ? JSON.stringify(out) + "\n" : `advanced ${from} → ${to}\n`);
    });

  // ── loaf status ─────────────────────────────────────────────────────
  // Phase 15 SC3: switched from loadSession (full replay) to
  // loadProjections (snapshot + fast-check). Pre-`loaf start` dir now
  // exits 2 NO_SESSION (was exit 0 + state:null) — codex r175a confirmed
  // (A): uniform with the other 3 SC3-wired read commands.
  program
    .command("status")
    .description("Show the current session snapshot (read-only)")
    .requiredOption("--feature <name>", "Feature whose status to show")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
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
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        process.stdout.write(
          `feature: ${opts.feature}\n` +
          `phase:   ${state.phase}.${state.sub_state.split(".")[1]}\n` +
          `cursor:  ${state.sub_state}\n` +
          `tail:    seq=${out.tail_seq}\n` +
          `tasks=${out.tasks_count} evidence=${out.evidence_count} findings=${out.findings_count} pending=${out.pending_count}\n` +
          `# snapshot as-of seq=${out.tail_seq} (projection-loader, Phase 15 SC3)\n`,
        );
      }
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
    .requiredOption("--feature <name>", "Feature whose session to gate")
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
        readGitConfig: getGitEmail,
        isInteractiveHuman: process.stdin.isTTY === true,
      });
      if (!resolution.ok) {
        emitFailure(resolution.code, resolution.message);
        return;
      }
      const humanActor = resolution.actor;
      // (4) load session
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
      const from = session.snapshot.state?.sub_state;
      if (!from) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      // (5) build entries + execute per-gate
      const ctx = {
        feature_dir: featureDir,
        snapshot: session.snapshot,
        tail_seq: session.tail_seq,
        entries: session.entries,
        meta: session.meta,
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
          const result = await mutateBatch(entries, ctx);
          if (!result.ok) {
            emitFailure(result.code, result.message, result.detail);
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
          process.stdout.write(
            useJson
              ? JSON.stringify(out) + "\n"
              : `gate spec-lock approved by ${humanActor} — ${from} → EXECUTE.plan\n`,
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
            ctx,
          )
          : await mutate(
            {
              at: now,
              actor: humanActor,
              entry_schema_version: 1,
              kind: "gate:decided",
              payload: { gate_kind: "verify-accept", decision: "approved", reason: opts.reason },
            },
            ctx,
          );
        if (!result.ok) {
          emitFailure(result.code, result.message, result.detail);
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
        process.stdout.write(
          useJson
            ? JSON.stringify(out) + "\n"
            : `gate verify-accept approved by ${humanActor} — verify_accepted=true, cursor stays at ${from} (advance via \`loaf deliver\` / \`loaf settle\`)\n`,
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
        ctx,
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
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
      process.stdout.write(
        useJson
          ? JSON.stringify(out) + "\n"
          : `gate ${gateName} rejected by ${humanActor} — cursor stays at ${from}\n`,
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
    .requiredOption("--feature <name>", "Feature whose session to deliver")
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
        readGitConfig: getGitEmail,
        isInteractiveHuman: process.stdin.isTTY === true,
      });
      if (!resolution.ok) {
        ctx.failure(resolution.code, resolution.message);
        return;
      }
      const humanActor = resolution.actor;

      // (2) Load session via ctx (caches per featureDir; ctx also captures
      //     the resolved sub_state for snapshotCrashContext enrichment).
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        ctx.failure(result.code, result.message, result.detail);
        return;
      }

      // (5) Success output via ctx.success — single payload, lazy text
      //     renderer (only invoked in text mode). Output bytes identical
      //     to pre-SC-3 (asserted in tests).
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
        () =>
          `delivered ${opts.feature} (advisory only) — ${from} → DONE.delivered by ${humanActor}\n` +
          `next: ${advisory[0]}\n`,
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
    .requiredOption("--feature <name>", "Feature whose session to archive")
    .requiredOption("--reason <text>", "Rationale recorded on the session:archived entry")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; reason: string; featureDir?: string }) => {
      // (1) Human-only actor — `session:archived` is HUMAN_ONLY per PER_KIND_ACTOR.
      const resolution = resolveHumanActor({
        env: process.env,
        readGitConfig: getGitEmail,
        isInteractiveHuman: process.stdin.isTTY === true,
      });
      if (!resolution.ok) {
        emitFailure(resolution.code, resolution.message);
        return;
      }
      const humanActor = resolution.actor;

      // (2) Load session.
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
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
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        process.stdout.write(
          `archived ${opts.feature} — ${from} → DONE.archived by ${humanActor}\n`,
        );
      }
    });

  program
    .command("abandon")
    .description("Abandon the feature session (emits session:abandoned → DONE.abandoned)")
    .requiredOption("--feature <name>", "Feature whose session to abandon")
    .requiredOption("--reason <text>", "Rationale recorded on the session:abandoned entry")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; reason: string; featureDir?: string }) => {
      // (1) Human-only actor — `session:abandoned` is HUMAN_ONLY per PER_KIND_ACTOR.
      const resolution = resolveHumanActor({
        env: process.env,
        readGitConfig: getGitEmail,
        isInteractiveHuman: process.stdin.isTTY === true,
      });
      if (!resolution.ok) {
        emitFailure(resolution.code, resolution.message);
        return;
      }
      const humanActor = resolution.actor;

      // (2) Load session.
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
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
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        process.stdout.write(
          `abandoned ${opts.feature} — ${from} → DONE.abandoned by ${humanActor}\n`,
        );
      }
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
    .requiredOption("--feature <name>", "Feature whose spike session to convert")
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
          readGitConfig: getGitEmail,
          isInteractiveHuman: process.stdin.isTTY === true,
        });
        if (!resolution.ok) {
          emitFailure(resolution.code, resolution.message);
          return;
        }
        const humanActor = resolution.actor;

        // (2) Load session.
        const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
        const session = await loadSession(featureDir);
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
          { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
        );
        if (!result.ok) {
          emitFailure(result.code, result.message, result.detail);
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
        if (useJson) {
          process.stdout.write(JSON.stringify(out) + "\n");
        } else {
          process.stdout.write(
            `converted ${opts.feature} → ${opts.toFeature} — ${from} → DONE.archived by ${humanActor}\n`,
          );
        }
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
    .requiredOption("--feature <name>", "Feature whose session to escalate")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
      async (opts: {
        confirm: boolean;
        input: string;
        feature: string;
        featureDir?: string;
      }) => {
        // (1) Human-only acceptance — escalation is a human decision.
        const resolution = resolveHumanActor({
          env: process.env,
          readGitConfig: getGitEmail,
          isInteractiveHuman: process.stdin.isTTY === true,
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
        const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
        const session = await loadSession(featureDir);
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
          { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
        );
        if (!result.ok) {
          emitFailure(result.code, result.message, result.detail);
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
        if (useJson) {
          process.stdout.write(JSON.stringify(out) + "\n");
        } else {
          process.stdout.write(
            `escalated ${opts.feature} — ceremony updated, pending ${head.id} resolved (cursor ${out.sub_state})\n`,
          );
        }
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

      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
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
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        process.stdout.write(
          `rebuilt ${rebuilt.length} projection file(s) for ${opts.feature}:\n` +
          rebuilt.map((f) => `  snapshots/${f}\n`).join("") +
          `# snapshot as-of seq=${replay.meta.last_applied_seq}\n`,
        );
      }
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

  // ── loaf tasks submit <file> ────────────────────────────────────────
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
    .command("submit <file>")
    .description("Submit a complete task graph from JSON file (or '-' for stdin)")
    .requiredOption("--feature <name>", "Feature whose task graph to submit")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (file: string, opts: { feature: string; featureDir?: string }) => {
      // (1) Read content from file or stdin.
      let content: string;
      if (file === "-") {
        // readFileSync(0) reads from stdin (fd 0). Cross-runtime (node + bun).
        try {
          content = readFileSync(0, "utf8");
        } catch (err) {
          emitFailure("MISSING_INPUT", `cannot read stdin: ${String(err)}`);
          return;
        }
      } else {
        try {
          content = await fsP.readFile(file, "utf8");
        } catch (err) {
          if ((err as { code?: string }).code === "ENOENT") {
            emitFailure("INPUT_FILE_NOT_FOUND", `input file does not exist: ${file}`, { path: file });
          } else {
            emitFailure("INPUT_FILE_NOT_FOUND", `cannot read input file ${file}: ${String(err)}`, { path: file });
          }
          return;
        }
      }

      // (2) Parse JSON.
      let payload: unknown;
      try {
        payload = JSON.parse(content);
      } catch (err) {
        emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `input is not valid JSON: ${(err as Error).message}`,
        );
        return;
      }

      // (3) Load session.
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }

      // (4) Mutate. Preflight validates TasksPlannedPayload + sub_state +
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }

      // (5) Success output. Echo task ids for the planner / shell scripts.
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
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        process.stdout.write(
          `submitted ${tasks.length} task${tasks.length === 1 ? "" : "s"}: ${taskIds.join(", ")}\n`,
        );
      }
    });

  // ── loaf tasks add <file> [--finding <FND-N>] ───────────────────────
  // Slice C SC-C3 + Phase 11 Item 3 SC1b. Two surfaces, gated by --finding:
  //
  // (a) UNSPONSORED — `tasks add <file>` at SPEC.design (no --finding).
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
  // (b) SPONSORED — `tasks add <file> --finding <FND-N>` at EXECUTE.work.
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
    .command("add <file>")
    .description("Append id-less task(s) to the graph (SPEC.design whole-graph, or EXECUTE.work sponsored via --finding)")
    .requiredOption("--feature <name>", "Feature whose task graph to extend")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .option("--finding <FND-N>", "Sponsoring amend-tasks finding (sponsored add at EXECUTE.work)")
    .action(async (file: string, opts: { feature: string; featureDir?: string; finding?: string }) => {
      // (1) Read input from file or stdin.
      let content: string;
      if (file === "-") {
        try {
          content = readFileSync(0, "utf8");
        } catch (err) {
          emitFailure("MISSING_INPUT", `cannot read stdin: ${String(err)}`);
          return;
        }
      } else {
        try {
          content = await fsP.readFile(file, "utf8");
        } catch (err) {
          if ((err as { code?: string }).code === "ENOENT") {
            emitFailure("INPUT_FILE_NOT_FOUND", `input file does not exist: ${file}`, { path: file });
          } else {
            emitFailure("INPUT_FILE_NOT_FOUND", `cannot read input file ${file}: ${String(err)}`, { path: file });
          }
          return;
        }
      }

      // (2) Parse JSON; normalize to an array; validate each against the
      // strict TaskInput schema. TaskInput omits id / status / execution
      // (CLI-owned); `.strict()` rejects a caller that supplies any of
      // them — the shape-enforcement point of ADR-0004 (codex r113).
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        emitFailure("SCHEMA_VALIDATION_FAILED", `input is not valid JSON: ${(err as Error).message}`);
        return;
      }
      const rawTasks: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      if (rawTasks.length === 0) {
        emitFailure("SCHEMA_VALIDATION_FAILED", "tasks add input is an empty array");
        return;
      }
      const validatedInputs: TaskInput[] = [];
      for (const raw of rawTasks) {
        const p = TaskInput.safeParse(raw);
        if (!p.success) {
          emitFailure(
            "SCHEMA_VALIDATION_FAILED",
            `tasks add input is not a valid id-less task (omit id / status / execution): ${p.error.issues.map((i) => i.message).join("; ")}`,
            { issues: p.error.issues },
          );
          return;
        }
        validatedInputs.push(p.data);
      }

      // (3) Load session; resolve the surface (unsponsored vs sponsored).
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const subState = session.snapshot.state.sub_state;
      const sponsored = opts.finding !== undefined;
      // --finding is the EXECUTE.work sponsored path; SPEC.design is the
      // unsponsored whole-graph path. Reject the cross-product explicitly
      // rather than silently ignoring the flag (codex r136 Q6).
      if (sponsored && subState === "SPEC.design") {
        emitFailure(
          "USAGE",
          "--finding is for the sponsored EXECUTE.work add; at SPEC.design `tasks add` is the unsponsored whole-graph path — drop --finding",
        );
        return;
      }
      if (!sponsored && subState !== "SPEC.design") {
        emitFailure(
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
          emitFailure(
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
        });
        if (!result.ok) {
          emitFailure(result.code, result.message, result.detail);
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
        if (useJson) {
          process.stdout.write(JSON.stringify(out) + "\n");
        } else {
          process.stdout.write(
            `added ${newIds.length} task${newIds.length === 1 ? "" : "s"} (sponsored by ${opts.finding}): ${newIds.join(", ")}\n`,
          );
        }
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
          emitFailure(
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
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
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        process.stdout.write(
          `added ${newIds.length} task${newIds.length === 1 ? "" : "s"}: ${newIds.join(", ")}\n`,
        );
      }
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
    .requiredOption("--feature <name>", "Feature whose task to claim")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (taskId: string, opts: { feature: string; featureDir?: string }) => {
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
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
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        process.stdout.write(`claimed ${taskId} (status=${status})\n`);
      }
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
    .requiredOption("--feature <name>", "Feature whose task to abandon")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
      async (
        taskId: string,
        opts: { reason: string; feature: string; featureDir?: string },
      ) => {
        const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
        const session = await loadSession(featureDir);
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
          { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
        );
        if (!result.ok) {
          emitFailure(result.code, result.message, result.detail);
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
        if (useJson) {
          process.stdout.write(JSON.stringify(out) + "\n");
        } else {
          process.stdout.write(`abandoned ${taskId} (status=${status})\n`);
        }
      },
    );

  // ── loaf tasks list [--status <s>] [--json] ─────────────────────────
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
    .requiredOption("--feature <name>", "Feature whose tasks to list")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .option(
      "--status <s>",
      "Filter by task status (pending|ready|in_progress|done|abandoned)",
    )
    .action(async (opts: { feature: string; featureDir?: string; status?: string }) => {
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
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

      if (useJson) {
        process.stdout.write(
          JSON.stringify({
            ok: true,
            feature: opts.feature,
            count: filtered.length,
            tasks: filtered,
          }) + "\n",
        );
      } else {
        if (filtered.length === 0) {
          process.stdout.write(
            opts.status
              ? `no tasks match --status=${opts.status}\n`
              : `no tasks in projection (run \`loaf tasks submit\` first)\n`,
          );
        } else {
          for (const t of filtered) {
            const ready = t.ready ? " [ready]" : "";
            process.stdout.write(`${t.id} ${t.kind} ${t.status}${ready}\n`);
          }
        }
      }
    });

  // ── loaf tasks next ─────────────────────────────────────────────────
  // Slice 2 SC4. Computes the next ready task (status=pending +
  // depends_on all done). Returns first match in journal order. No
  // journal entry emitted. Exits 0 with empty stdout when no ready
  // task exists (caller scripts can use this as a sentinel).
  tasksCmd
    .command("next")
    .description("Print the next ready task id (or empty if none); read-only")
    .requiredOption("--feature <name>", "Feature whose ready task to compute")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
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
      if (useJson) {
        process.stdout.write(
          JSON.stringify({
            ok: true,
            feature: opts.feature,
            task_id: ready?.id ?? null,
            kind: ready?.kind ?? null,
          }) + "\n",
        );
      } else {
        process.stdout.write(ready ? `${ready.id}\n` : "");
      }
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
    .requiredOption("--feature <name>", "Feature whose task to confirm")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (taskId: string, opts: { feature: string; featureDir?: string }) => {
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
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
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        process.stdout.write(`${taskId} complete (status=done)\n`);
      }
    });

  // ── loaf tasks amend <task-id> (--policy ... | --input <file> --finding) ──
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
    .requiredOption("--feature <name>", "Feature whose task to amend")
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
            "tasks amend needs either --policy <step>=<applicability> or --input <file> --finding <FND-N>",
          );
          return;
        }

        // ── (b) SPONSORED --input path ──────────────────────────────────
        if (hasInput) {
          const inputPath = opts.input!;
          const findingId = opts.finding!;
          // (b1) Read the new id-less task definition.
          let inContent: string;
          if (inputPath === "-") {
            try {
              inContent = readFileSync(0, "utf8");
            } catch (err) {
              emitFailure("MISSING_INPUT", `cannot read stdin: ${String(err)}`);
              return;
            }
          } else {
            try {
              inContent = await fsP.readFile(inputPath, "utf8");
            } catch (err) {
              if ((err as { code?: string }).code === "ENOENT") {
                emitFailure("INPUT_FILE_NOT_FOUND", `input file does not exist: ${inputPath}`, { path: inputPath });
              } else {
                emitFailure("INPUT_FILE_NOT_FOUND", `cannot read input file ${inputPath}: ${String(err)}`, { path: inputPath });
              }
              return;
            }
          }
          // (b2) Parse + validate the id-less TaskInput. Strict: id /
          // status / execution are CLI-owned and must not be supplied.
          let inParsed: unknown;
          try {
            inParsed = JSON.parse(inContent);
          } catch (err) {
            emitFailure("SCHEMA_VALIDATION_FAILED", `input is not valid JSON: ${(err as Error).message}`);
            return;
          }
          const inTask = TaskInput.safeParse(inParsed);
          if (!inTask.success) {
            emitFailure(
              "SCHEMA_VALIDATION_FAILED",
              `tasks amend --input is not a valid id-less task (omit id / status / execution): ${inTask.error.issues.map((i) => i.message).join("; ")}`,
              { issues: inTask.error.issues },
            );
            return;
          }
          // (b3) Load session; the task being replaced must exist.
          const sFeatureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
          const sSession = await loadSession(sFeatureDir);
          if (!sSession.snapshot.state) {
            emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
            return;
          }
          const sCurrent = sSession.snapshot.tasks.find((t) => t.id === taskId);
          if (!sCurrent) {
            emitFailure(
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
              emitFailure(
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
            { feature_dir: sFeatureDir, snapshot: sSession.snapshot, tail_seq: sSession.tail_seq, entries: sSession.entries, meta: sSession.meta },
          );
          if (!sResult.ok) {
            emitFailure(sResult.code, sResult.message, sResult.detail);
            return;
          }
          const sOut = {
            ok: true,
            feature: opts.feature,
            task_id: taskId,
            sponsored_by_finding_id: findingId,
            sub_state: sResult.snapshot.state?.sub_state,
          };
          if (useJson) {
            process.stdout.write(JSON.stringify(sOut) + "\n");
          } else {
            process.stdout.write(`amended ${taskId} (sponsored by ${findingId})\n`);
          }
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
        const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
        const session = await loadSession(featureDir);
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
          { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
        );
        if (!result.ok) {
          emitFailure(result.code, result.message, result.detail);
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
        if (useJson) {
          process.stdout.write(JSON.stringify(out) + "\n");
        } else {
          process.stdout.write(`amended ${taskId} (${applied})\n`);
        }
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
    .requiredOption("--feature <name>", "Feature whose task to register")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (taskId: string, opts: { feature: string; featureDir?: string }) => {
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      const out = {
        ok: true,
        feature: opts.feature,
        task_id: taskId,
        red_test_registered: true,
        sub_state: result.snapshot.state?.sub_state,
      };
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        process.stdout.write(`registered RED for ${taskId}\n`);
      }
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
    .requiredOption("--feature <name>", "Feature whose task lifecycle to advance")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { task: string; step: string; feature: string; featureDir?: string }) => {
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
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
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        process.stdout.write(`started ${opts.task} step=${opts.step} (status=running)\n`);
      }
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
    .requiredOption("--feature <name>", "Feature whose task lifecycle to advance")
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
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
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
      const ctx = {
        feature_dir: featureDir,
        snapshot: session.snapshot,
        tail_seq: session.tail_seq,
        entries: session.entries,
        meta: session.meta,
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
          ctx,
        );
      } else {
        result = await mutate(stepDoneEntry, ctx);
      }
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
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
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        const promote = updated.status === "done" ? " (task auto-promoted to done)" : "";
        const evidenceSuffix = evidenceId !== undefined ? ` evidence=${evidenceId}` : "";
        process.stdout.write(
          `done ${opts.task} step=${opts.step} result=${opts.result}${evidenceSuffix}${promote}\n`,
        );
      }
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
    .requiredOption("--feature <name>", "Feature whose session to settle")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
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
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        process.stdout.write(
          `settled ${opts.feature} — ${from} → SETTLE.reconcile\n` +
          `next: ${advisory[0]}\n`,
        );
      }
    });

  // ── loaf pending raise / list / status / resolve ─────────────────────
  // Slice 3 SC1 — minimum FIFO surface over the pending queue.
  //   raise   --kind <K> --question <Q> [--options <csv>] [--task-id <tid>]
  //              CLI allocates PEND-N (max-serial+1); emits pending:added.
  //              stdout in text mode = bare PEND-id (scriptable; codex r62).
  //   list    [--json]
  //              snapshot.pending projection + derived `head: boolean`
  //              flag = first unresolved entry. Text mode = 4 fixed
  //              columns `<PEND-id> <kind> <open|resolved> <head|->`.
  //   status  [--id <id>] [--json]
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
    .requiredOption("--feature <name>", "Feature whose session to raise pending against")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: {
      kind: string;
      question: string;
      options?: string;
      taskId?: string;
      feature: string;
      featureDir?: string;
    }) => {
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (useJson) {
        process.stdout.write(
          JSON.stringify({ ok: true, feature: opts.feature, id, kind: opts.kind }) + "\n",
        );
      } else {
        process.stdout.write(id + "\n");
      }
    });

  pendingCmd
    .command("list")
    .description("List pending entries (FIFO; first unresolved is head)")
    .requiredOption("--feature <name>", "Feature whose pending to list")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
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
      if (useJson) {
        process.stdout.write(
          JSON.stringify({
            ok: true,
            feature: opts.feature,
            count: rows.length,
            pending: rows,
          }) + "\n",
        );
      } else {
        for (const r of rows) {
          process.stdout.write(
            `${r.id} ${r.kind} ${r.resolved ? "resolved" : "open"} ${r.head ? "head" : "-"}\n`,
          );
        }
      }
    });

  pendingCmd
    .command("status")
    .description("Status of head pending entry (default) or specific entry by --id")
    .requiredOption("--feature <name>", "Feature whose pending to inspect")
    .option("--id <id>", "Lookup a specific PEND-id (default: head)")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; id?: string; featureDir?: string }) => {
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
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
      if (useJson) {
        process.stdout.write(
          JSON.stringify({
            ok: true,
            feature: opts.feature,
            pending: target,
          }) + "\n",
        );
      } else {
        if (target === null) {
          process.stdout.write("no open pending\n");
        } else {
          process.stdout.write(
            `${target.id} ${target.kind} ${target.resolved ? "resolved" : "open"} ${target.head ? "head" : "-"}\n`,
          );
        }
      }
    });

  pendingCmd
    .command("resolve")
    .description("Resolve the head pending entry (strict FIFO; no --id flag)")
    .requiredOption("--answer <text>", "Resolution answer (passthrough into pending:resolved payload)")
    .requiredOption("--feature <name>", "Feature whose pending to resolve")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { answer: string; feature: string; featureDir?: string }) => {
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (useJson) {
        process.stdout.write(
          JSON.stringify({
            ok: true,
            feature: opts.feature,
            resolved_id: head.id,
            kind: head.kind,
          }) + "\n",
        );
      } else {
        process.stdout.write(`resolved ${head.id} (kind=${head.kind})\n`);
      }
    });

  // ── loaf evidence add --input <file> ──────────────────────────────────
  // Slice 3 SC2 — minimal single-entry evidence add over the existing
  // EvidenceFullPayload schema (src/core/evidence-schema.ts).
  //
  // Scope per codex r62 → r66 sign-off:
  //   - Single-entry --input only; array → USAGE deterministic reject
  //     (no silent first-element processing).
  //   - Caller-supplied `id` → USAGE exit 2 BEFORE mutate/append; CLI is
  //     the single-source EV-id allocator (max-serial+1, zero-padded to
  //     ≥6 digits per docs/schemas.ts EvidenceIdPayload regex).
  //   - Attachments are PRE-HASHED PASSTHROUGH ONLY: input.attachments
  //     must match runtime AttachmentPayload {path, sha256(64 lowercase
  //     hex), mime, bytes?}. CLI does NOT stat / hash / copy / verify
  //     files — the rev 4.3 / ADR-0004 A6 auto-hash transaction lands
  //     in SC2b.
  //   - No `--external-ref` CLI flag; `external_ref` is allowed only
  //     as an --input field (passthrough via EvidenceFullPayload).
  //   - EvidenceFullPayload refines already enforce: manual/waiver actor
  //     must start with `human:` and reason ≥10; visual-review requires
  //     ≥1 attachment. CLI does not duplicate these checks.
  const evidenceCmd = program
    .command("evidence")
    .description("Evidence ledger commands (Slice 3 SC2 MVP: add)");

  evidenceCmd
    .command("add")
    .description("Append an evidence entry from --input JSON (CLI allocates EV-id)")
    .requiredOption("--input <file>", "Path to JSON file holding the EvidenceFullPayload minus id")
    .requiredOption("--feature <name>", "Feature whose ledger to append to")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { input: string; feature: string; featureDir?: string }) => {
      // (1) Read --input file.
      let content: string;
      try {
        content = await fsP.readFile(opts.input, "utf8");
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          emitFailure(
            "INPUT_FILE_NOT_FOUND",
            `input file does not exist: ${opts.input}`,
            { path: opts.input },
          );
        } else {
          emitFailure(
            "INPUT_FILE_NOT_FOUND",
            `cannot read input file ${opts.input}: ${String(err)}`,
            { path: opts.input },
          );
        }
        return;
      }

      // (2) Parse JSON.
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `input is not valid JSON: ${(err as Error).message}`,
        );
        return;
      }

      // (3) Boundary guards (codex r66 Q2 + Q4): single-entry shape;
      // caller MUST NOT supply id (CLI is single-source allocator).
      if (Array.isArray(parsed)) {
        emitFailure(
          "USAGE",
          "evidence add --input expects a single object; arrays are not supported in this slice",
        );
        return;
      }
      if (parsed === null || typeof parsed !== "object") {
        emitFailure(
          "USAGE",
          `evidence add --input must be a JSON object, got ${parsed === null ? "null" : typeof parsed}`,
        );
        return;
      }
      const inputObj = parsed as Record<string, unknown>;
      if ("id" in inputObj) {
        emitFailure(
          "USAGE",
          "do not include `id` in --input — CLI is the single-source EV-id allocator",
        );
        return;
      }

      // (4) Load session.
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }

      // (5) Allocate EV-NNNNNN: scan numeric EV ids (`EV-\d+`) in
      // projection, take max numeric part, +1, zero-pad to ≥6 digits per
      // EvidenceIdPayload. Non-numeric / non-EV ids (legacy / drift) are
      // skipped — by construction only CLI-allocated ids enter, and the
      // next allocation always emits canonical 6-digit padded form.
      const maxSerial = session.snapshot.evidence.reduce((max, e) => {
        const m = /^EV-(\d+)$/.exec(e.id);
        if (!m) return max;
        return Math.max(max, Number.parseInt(m[1]!, 10));
      }, 0);
      const id = `EV-${String(maxSerial + 1).padStart(6, "0")}`;

      // (6) Merge id into payload, hand to mutate(). Preflight will run
      // EvidenceFullPayload strict + refines (manual/waiver actor +
      // reason, visual-review attachments) at PER_KIND_PAYLOAD; sub_state
      // authority gate is also preflight's job. CLI does not duplicate.
      const fullPayload = { ...inputObj, id };
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor,
          entry_schema_version: 1,
          kind: "evidence:added",
          payload: fullPayload,
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }

      // (7) Output. Bare EV-id in text mode (scriptable); {ok, feature,
      // id, kind} in JSON mode — same shape rhythm as pending raise.
      if (useJson) {
        process.stdout.write(
          JSON.stringify({
            ok: true,
            feature: opts.feature,
            id,
            kind: inputObj["kind"],
          }) + "\n",
        );
      } else {
        process.stdout.write(id + "\n");
      }
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
    .requiredOption("--feature <name>", "Feature whose ledger to append to")
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
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
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
          { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
        );
        if (!batchResult.ok) {
          emitFailure(batchResult.code, batchResult.message, batchResult.detail);
          return;
        }
        if (useJson) {
          process.stdout.write(
            JSON.stringify({
              ok: true,
              feature: opts.feature,
              id,
              category: opts.category,
              action: opts.action,
              back_edge: { from: currentSubState, to: "EXECUTE.work" },
            }) + "\n",
          );
        } else {
          process.stdout.write(id + "\n");
        }
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
          { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
        );
        if (!batchResult.ok) {
          emitFailure(batchResult.code, batchResult.message, batchResult.detail);
          return;
        }
        if (useJson) {
          process.stdout.write(
            JSON.stringify({
              ok: true,
              feature: opts.feature,
              id,
              category: opts.category,
              action: opts.action,
              back_edge: { from: currentSubState, to: backEdgeTarget },
            }) + "\n",
          );
        } else {
          // codex r98 §1: keep text-mode stdout bare (matches every
          // other `loaf finding raise` action). Callers script
          // `FND=$(loaf finding raise ...)` and feed the id straight
          // into `loaf finding close`; a decorated string would
          // break that pipeline contract. The back_edge sponsorship
          // is observable from the journal tail + JSON mode.
          process.stdout.write(id + "\n");
        }
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (useJson) {
        process.stdout.write(
          JSON.stringify({
            ok: true,
            feature: opts.feature,
            id,
            category: opts.category,
            action: opts.action,
          }) + "\n",
        );
      } else {
        process.stdout.write(id + "\n");
      }
    });

  findingCmd
    .command("list")
    .description("List findings (read-only; --status filters open|closed)")
    .requiredOption("--feature <name>", "Feature whose findings to list")
    .option("--status <s>", "Filter by status (open | closed)")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; status?: string; featureDir?: string }) => {
      if (opts.status !== undefined && opts.status !== "open" && opts.status !== "closed") {
        emitFailure("USAGE", `--status must be one of: open | closed (got ${opts.status})`);
        return;
      }
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
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
      if (useJson) {
        process.stdout.write(
          JSON.stringify({
            ok: true,
            feature: opts.feature,
            count: rows.length,
            findings: rows,
          }) + "\n",
        );
      } else {
        for (const r of rows) {
          process.stdout.write(`${r.id} ${r.category} ${r.action} ${r.status}\n`);
        }
      }
    });

  findingCmd
    .command("close <fnd-id>")
    .description("Close a finding (emits finding:closed)")
    .requiredOption("--feature <name>", "Feature whose ledger to close against")
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
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq, entries: session.entries, meta: session.meta },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      if (useJson) {
        process.stdout.write(
          JSON.stringify({ ok: true, feature: opts.feature, id: fndId, status: "closed" }) + "\n",
        );
      } else {
        process.stdout.write(`closed ${fndId}\n`);
      }
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
    .requiredOption("--input <file>", "JSON file with SpecFrontmatter-shaped content")
    .requiredOption("--feature <name>", "Feature whose spec to submit")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { input: string; feature: string; featureDir?: string }) => {
      // (1) Read --input.
      let content: string;
      try {
        content = await fsP.readFile(opts.input, "utf8");
      } catch (err) {
        const code = (err as { code?: string }).code;
        emitFailure(
          "INPUT_FILE_NOT_FOUND",
          code === "ENOENT"
            ? `input file does not exist: ${opts.input}`
            : `cannot read input file ${opts.input}: ${String(err)}`,
          { path: opts.input },
        );
        return;
      }
      // (2) Parse JSON.
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `input is not valid JSON: ${(err as Error).message}`,
        );
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        emitFailure(
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
        emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `spec submit input failed SpecSubmitInput schema validation`,
          { issues: inputParse.error.issues },
        );
        return;
      }
      const input = inputParse.data;
      // (3) Load session.
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const currentVersion = session.snapshot.state.spec_version;
      // (4) spec_version handling: CLI fills with current+1 when absent;
      // when caller supplies, defer to reducer's monotonic check (codex
      // r74 — both paths must reach the same SPEC_VERSION_NOT_MONOTONIC
      // surface when mismatch, so we let preflight/reducer enforce
      // instead of duplicating the check here).
      const specVersion = input.spec_version ?? currentVersion + 1;
      // (5) Extract companion arrays (already defaulted to [] by schema).
      const reqs = input.requirements;
      const scens = input.scenarios;
      const viss = input.visual_contracts;
      // (6) Build batch entries.
      const headPayload: Record<string, unknown> = {
        spec_version: specVersion,
        feature: input.feature,
        intent: input.intent,
        adr_refs: input.adr_refs,
        needs_clarification: input.needs_clarification,
      };
      const now = new Date().toISOString();
      const entries: Parameters<typeof mutateBatch>[0] = [
        {
          at: now,
          actor,
          entry_schema_version: 1,
          kind: "event:spec_submitted",
          payload: headPayload,
        },
      ];
      for (const req of reqs) {
        entries.push({
          at: now,
          actor,
          entry_schema_version: 1,
          kind: "event:spec_req_added",
          payload: { spec_version: specVersion, req },
        });
      }
      for (const scen of scens) {
        entries.push({
          at: now,
          actor,
          entry_schema_version: 1,
          kind: "event:spec_scenario_added",
          payload: { spec_version: specVersion, scenario: scen },
        });
      }
      for (const vis of viss) {
        entries.push({
          at: now,
          actor,
          entry_schema_version: 1,
          kind: "event:spec_visual_added",
          payload: { spec_version: specVersion, visual: vis },
        });
      }
      // (7) Mutate.
      const result = await mutateBatch(entries, {
        feature_dir: featureDir,
        snapshot: session.snapshot,
        tail_seq: session.tail_seq,
        entries: session.entries,
        meta: session.meta,
      });
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      // (8) Output. Echo collected ids for shell scripting.
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
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        process.stdout.write(
          `spec submitted v${out.spec_version}: ${reqIds.length} req / ${scenIds.length} scen / ${visIds.length} vis\n`,
        );
      }
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
    .requiredOption("--feature <name>", "Feature whose spec.md to scaffold")
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
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
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
      if (useJson) {
        process.stdout.write(
          JSON.stringify({ ok: true, feature: opts.feature, spec_md_path: specMdPath }) + "\n",
        );
      } else {
        process.stdout.write(
          `spec init: wrote scaffold to ${specMdPath}\nnext: edit, then \`loaf spec submit --input <json> --feature ${opts.feature}\`\n`,
        );
      }
    });

  for (const cfg of REGISTER_SPEC_ADD) {
    specCmd
      .command(`add-${cfg.name}`)
      .description(`Add ${cfg.name} entries via id_namespace stamping (CLI allocates ${cfg.name.toUpperCase()} ids)`)
      .requiredOption("--input <file>", `JSON file with SpecAdd${cfg.name[0]!.toUpperCase()}${cfg.name.slice(1)}Input shape (item or array)`)
      .requiredOption("--feature <name>", `Feature whose spec to extend`)
      .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
      .action(async (opts: { input: string; feature: string; featureDir?: string }) => {
        // (1) Read --input.
        let content: string;
        try {
          content = await fsP.readFile(opts.input, "utf8");
        } catch (err) {
          const code = (err as { code?: string }).code;
          emitFailure(
            "INPUT_FILE_NOT_FOUND",
            code === "ENOENT"
              ? `input file does not exist: ${opts.input}`
              : `cannot read input file ${opts.input}: ${String(err)}`,
            { path: opts.input },
          );
          return;
        }
        // (2) Parse JSON + CLI boundary schema validation.
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch (err) {
          emitFailure(
            "SCHEMA_VALIDATION_FAILED",
            `input is not valid JSON: ${(err as Error).message}`,
          );
          return;
        }
        const inputParse = cfg.inputSchema.safeParse(parsed);
        if (!inputParse.success) {
          emitFailure(
            "SCHEMA_VALIDATION_FAILED",
            `spec add-${cfg.name} input failed schema validation`,
            { issues: inputParse.error.issues },
          );
          return;
        }
        const items: ReadonlyArray<{ id_namespace: string; [k: string]: unknown }> =
          Array.isArray(inputParse.data) ? inputParse.data : [inputParse.data];
        // (3) Load session.
        const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
        const session = await loadSession(featureDir);
        if (!session.snapshot.state) {
          emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
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
        });
        if (!result.ok) {
          emitFailure(result.code, result.message, result.detail);
          return;
        }
        if (useJson) {
          process.stdout.write(
            JSON.stringify({
              ok: true,
              feature: opts.feature,
              spec_version: result.snapshot.state?.spec_version,
              ids: allocatedIds,
              sub_state: result.snapshot.state?.sub_state,
            }) + "\n",
          );
        } else {
          process.stdout.write(
            `spec add-${cfg.name} v${result.snapshot.state?.spec_version}: ${allocatedIds.join(", ")}\n`,
          );
        }
      });
  }

  try {
    await program.parseAsync(argv);
    return ctx.exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.exitCode === 0) return 0;
      process.stderr.write(`error: ${err.code ?? "USAGE"} — ${err.message}\n`);
      return err.exitCode === 1 ? 2 : err.exitCode;
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
    if (useJson) {
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
    return 1;
  }
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
