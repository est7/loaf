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
  // Slice 1.B sub-cycle 4: spec-lock direct gate MVP. Emits
  //   approve: [gate:decided, event:phase_advanced SPEC.design → EXECUTE.plan]
  //   reject:  [gate:decided]
  // Pending-head enforcement and `pending:resolved` co-emission are
  // intentionally deferred — full protocol §10.7/§10.8 lands with the
  // pending CLI surface in a later slice.
  program
    .command("gate")
    .description("Gate decision commands (spec-lock; verify-accept is deferred)")
    .command("decide <gate-name>")
    .description("Decide a gate (emits gate:decided + event:phase_advanced on approve)")
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
      // (2) unsupported gate names
      if (gateName !== "spec-lock") {
        emitFailure(
          "GATE_NOT_IMPLEMENTED",
          `gate=${gateName} is not yet wired in this release; only spec-lock is supported`,
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
      // (5) build entries + execute
      const ctx = {
        feature_dir: featureDir,
        snapshot: session.snapshot,
        tail_seq: session.tail_seq,
      };
      const now = new Date().toISOString();
      if (approve) {
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
      // reject: single entry, no phase advance
      const result = await mutate(
        {
          at: now,
          actor: humanActor,
          entry_schema_version: 1,
          kind: "gate:decided",
          payload: { gate_kind: "spec-lock", decision: "rejected", reason: opts.reason },
        },
        ctx,
      );
      if (!result.ok) {
        emitFailure(result.code, result.message, result.detail);
        return;
      }
      const out = {
        ok: true,
        gate: "spec-lock",
        decision: "rejected" as const,
        from,
        actor: humanActor,
        sub_state: result.snapshot.state?.sub_state,
        spec_locked: result.snapshot.state?.spec_locked,
      };
      process.stdout.write(
        useJson
          ? JSON.stringify(out) + "\n"
          : `gate spec-lock rejected by ${humanActor} — cursor stays at ${from}\n`,
      );
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
