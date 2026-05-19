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
import type { Ceremony } from "./core/journal-entry.js";
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
  let exitCode = 0;
  const fail = (code: string, message: string) => {
    process.stderr.write(`error: ${code} — ${message}\n`);
    exitCode = 2;
  };

  // emitFailure — richer error path used by `gate decide` (Slice 1.B
  // sub-cycle 4). Protocol §10.0 keeps stdout for primary output only,
  // so structured JSON failures go to stderr too. detail.checks (when
  // present, e.g. GATE_PRECONDITION_VIOLATION) is one-line-per-check in
  // text mode for readability.
  const emitFailure = (
    code: string,
    message: string,
    detail?: Record<string, unknown>,
  ) => {
    if (useJson) {
      const out: Record<string, unknown> = { ok: false, code, message };
      if (detail) out.detail = detail;
      process.stderr.write(JSON.stringify(out) + "\n");
    } else {
      process.stderr.write(`error: ${code} — ${message}\n`);
      const checks = detail?.["checks"];
      if (Array.isArray(checks)) {
        for (const c of checks as Array<{ check?: number; code?: string; message?: string }>) {
          process.stderr.write(
            `  [check ${c.check ?? "?"}] ${c.code ?? "UNKNOWN"}: ${c.message ?? ""}\n`,
          );
        }
      }
    }
    exitCode = 2;
  };

  // ── loaf start <feature> ────────────────────────────────────────────
  program
    .command("start <feature>")
    .description("Start a new feature session (emits session:started)")
    .option("--ceremony <preset>", "Preset label: quick / light / standard / deep", "standard")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (feature: string, opts: { ceremony: string; featureDir?: string }) => {
      const ceremony = PRESETS[opts.ceremony];
      if (!ceremony) {
        fail("INVALID_PRESET",
          `unknown ceremony preset "${opts.ceremony}" — known: ${Object.keys(PRESETS).join(", ")}`);
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
          payload: { session_id: sessionId, feature, ceremony },
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq },
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq },
      );
      if (!result.ok) {
        fail(result.code, result.message);
        return;
      }
      const out = { ok: true, from, to, sub_state: result.snapshot.state?.sub_state };
      process.stdout.write(useJson ? JSON.stringify(out) + "\n" : `advanced ${from} → ${to}\n`);
    });

  // ── loaf status ─────────────────────────────────────────────────────
  program
    .command("status")
    .description("Show the current session snapshot (read-only)")
    .requiredOption("--feature <name>", "Feature whose status to show")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      const session = await loadSession(featureDir);
      const out = {
        ok: true,
        feature: opts.feature,
        feature_dir: featureDir,
        tail_seq: session.tail_seq,
        state: session.snapshot.state,
        tasks_count: session.snapshot.tasks.length,
        evidence_count: session.snapshot.evidence.length,
        findings_count: session.snapshot.findings.length,
        pending_count: session.snapshot.pending.length,
      };
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        const state = session.snapshot.state;
        if (!state) {
          process.stdout.write(`no session at ${featureDir} (tail_seq=${session.tail_seq})\n`);
        } else {
          process.stdout.write(
            `feature: ${opts.feature}\n` +
            `phase:   ${state.phase}.${state.sub_state.split(".")[1]}\n` +
            `cursor:  ${state.sub_state}\n` +
            `tail:    seq=${session.tail_seq}\n` +
            `tasks=${out.tasks_count} evidence=${out.evidence_count} findings=${out.findings_count} pending=${out.pending_count}\n` +
            `# snapshot as-of seq=${session.tail_seq}\n`,
          );
        }
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
      // (1) Human-only actor — `session:delivered` is HUMAN_ONLY per PER_KIND_ACTOR.
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }

      // (5) Success output. Single advisory hint per protocol §10.12 +
      //     §1824 ("advisory only, 不碰 git/gh"). Callers can grep `next:`
      //     to chain commands in scripts.
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
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        process.stdout.write(
          `delivered ${opts.feature} (advisory only) — ${from} → DONE.delivered by ${humanActor}\n` +
          `next: ${advisory[0]}\n`,
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq },
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq },
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
      const session = await loadSession(featureDir);
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const tasks = session.snapshot.tasks;
      const tasksById = new Map(tasks.map((t) => [t.id, t]));
      const withDerived = tasks.map((t) => {
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq },
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq },
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq },
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
      const session = await loadSession(featureDir);
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const headIdx = session.snapshot.pending.findIndex((p) => !p.resolved);
      const rows = session.snapshot.pending.map((p, i) => ({
        ...p,
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq },
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq },
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
  // Deferred to SC4: back-edge batch path on raise (amend-spec →
  // event:phase_advanced SPEC.spec; amend-tasks → event:tasks_amended +
  // EXECUTE.work; fix-impl/fix-test → tasks.<T>.execution.<step>.status
  // = "running" mutation co-emitted in same mutateBatch).
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
      const result = await mutate(
        {
          at: new Date().toISOString(),
          actor,
          entry_schema_version: 1,
          kind: "finding:raised",
          payload,
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq },
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
      const session = await loadSession(featureDir);
      if (!session.snapshot.state) {
        emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
        return;
      }
      const rows = opts.status
        ? session.snapshot.findings.filter((f) => f.status === opts.status)
        : session.snapshot.findings;
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
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq },
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
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.exitCode === 0) return 0;
      process.stderr.write(`error: ${err.code ?? "USAGE"} — ${err.message}\n`);
      return err.exitCode === 1 ? 2 : err.exitCode;
    }
    process.stderr.write(`error: ${String(err)}\n`);
    return 2;
  }
}

// Stamping marker — never read in production but visible to CI grep so
// release pipelines can verify URL stamping happened (any literal `*.invalid`
// reaching production fails the release).
export const __URL_STAMP_PROBE__ = `${LOAF_DOCS_URL} ${LOAF_ISSUE_URL}`;

if (import.meta.main) {
  const exitCode = await main(process.argv);
  process.exit(exitCode);
}
