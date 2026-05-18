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
  // Pending-head enforcement and `pending:resolved` co-emission are
  // intentionally deferred — full protocol §10.7/§10.8 lands with the
  // pending CLI surface in a later slice.
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
      if (approve) {
        if (gateName === "spec-lock") {
          // dual-entry batch: human gate:decided + machine event:phase_advanced.
          // mutateBatch Pass 1.5 evaluates spec-lock via evaluateSpecLock; any
          // failure surfaces as GATE_PRECONDITION_VIOLATION with checks[] in
          // detail. spec-lock specifically moves SPEC.design → EXECUTE.plan.
          const result = await mutateBatch(
            [
              {
                at: now,
                actor: humanActor,
                entry_schema_version: 1,
                kind: "gate:decided",
                payload: { gate_kind: "spec-lock", decision: "approved", reason: opts.reason },
              },
              {
                at: now,
                actor,
                entry_schema_version: 1,
                kind: "event:phase_advanced",
                payload: { from, to: "EXECUTE.plan" },
              },
            ],
            ctx,
          );
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
        // verify-accept approve: single-entry [gate:decided].
        // mutateBatch Pass 1.5 evaluates verify-accept via evaluateVerifyAccept
        // (5 checks: lane status / open findings / coverage / done-task evidence
        // / deep spec-review). Gate does NOT move cursor — cursor stays at
        // VERIFY.accept; `loaf deliver` / `loaf settle` advance cursor later
        // per ceremony.settle_phase.
        const result = await mutate(
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
      // (codex r60 P2: do not hardcode "in_progress" — if the reducer ever
      // changes claim semantics, the CLI output should reflect that without
      // requiring a test to catch the drift).
      const claimed = result.snapshot.tasks.find((t) => t.id === taskId);
      const status = claimed?.status ?? "in_progress";
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
      const updated = result.snapshot.tasks.find((t) => t.id === opts.task);
      const out = {
        ok: true,
        feature: opts.feature,
        task_id: opts.task,
        step: opts.step,
        step_status: updated?.steps[opts.step]?.status,
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
  // SC3 MVP: no --evidence-* flag (deferred to Slice 3 Ledger CLI; the
  // batch evidence emission contract per protocol §1809 lands when
  // evidence add CLI ships).
  stepCmd
    .command("done")
    .description("Mark a task step as done (--result passed|failed|waived|na; default passed)")
    .requiredOption("--task <task-id>", "Task whose step to mark done")
    .requiredOption("--step <step-name>", "Step name (kind-specific)")
    .option("--result <r>", "Step result: passed (default) | failed | waived | na", "passed")
    .requiredOption("--feature <name>", "Feature whose task lifecycle to advance")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { task: string; step: string; result: string; feature: string; featureDir?: string }) => {
      // Validate --result client-side (payload schema also enforces).
      const validResults = ["passed", "failed", "waived", "na"] as const;
      if (!(validResults as readonly string[]).includes(opts.result)) {
        emitFailure(
          "USAGE",
          `--result must be one of: passed | failed | waived | na (got ${opts.result})`,
        );
        return;
      }
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
          payload: { task_id: opts.task, step: opts.step, result: opts.result },
        },
        { feature_dir: featureDir, snapshot: session.snapshot, tail_seq: session.tail_seq },
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      const updated = result.snapshot.tasks.find((t) => t.id === opts.task);
      const out = {
        ok: true,
        feature: opts.feature,
        task_id: opts.task,
        step: opts.step,
        step_status: updated?.steps[opts.step]?.status,
        task_status: updated?.status, // reflects auto-promote if it fired
        sub_state: result.snapshot.state?.sub_state,
      };
      if (useJson) {
        process.stdout.write(JSON.stringify(out) + "\n");
      } else {
        const promote = updated?.status === "done" ? " (task auto-promoted to done)" : "";
        process.stdout.write(
          `done ${opts.task} step=${opts.step} result=${opts.result}${promote}\n`,
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
