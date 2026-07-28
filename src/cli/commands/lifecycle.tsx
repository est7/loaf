import type { Command } from "commander";
import type { CommandContext } from "../command-context.js";
import type { CommandMutator } from "../command-mutator.js";
import { FAILURE_SITE_KEYS, SUCCESS_KEYS, subStateKey, CHROME_KEYS } from "../runtime-i18n-keys.js";
import { defaultFeatureDir, loadSession } from "../../core/cli-runtime.js";
import packageJson from "../../../package.json" with { type: "json" };
import { deriveVerifyApplicability } from "../../core/gates/verify-accept-check.js";
import { buildNextOutput } from "../../core/next-action.js";
import { appendSelector, buildNextAdvisory, pendingKindsForNext } from "../next-advisory.js";
import { readSpecFrontmatter } from "../../core/spec-frontmatter.js";
import { extractTaskSlim } from "../../core/task-schema.js";
import type { TaskState } from "../../core/reducer.js";
import path from "node:path";
import { ExecuteClosureError, type ExecuteClosureHooks } from "../../core/execute-closure.js";
import { RuntimeStoreError } from "../../core/session-runtime.js";

const PRESETS: Record<string, import("../../core/journal-entry.js").Ceremony> = {
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

export function registerLifecycle(
  program: Command,
  ctx: CommandContext,
  mutator: CommandMutator,
  actor: string,
  runtimeDir: string,
  runtimeNow: () => Date,
  executeClosureHooks?: ExecuteClosureHooks,
): void {
  // ── loaf start <feature> ────────────────────────────────────────────────
  program
    .command("start <feature>")
    .description("Start a new feature session (emits session:started)")
    .option("--ceremony <preset>", "Preset label: quick / light / standard / deep", "standard")
    .option("--label <text>", "Human-readable session label (≥3 chars)")
    .option("--workspace <name>", "Workspace name (multi-worktree display)", "default")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
      async (
        feature: string,
        opts: { ceremony: string; label?: string; workspace: string; featureDir?: string },
      ) => {
        const ceremony = PRESETS[opts.ceremony];
        if (!ceremony) {
          ctx.fail(
            "INVALID_PRESET",
            `unknown ceremony preset "${opts.ceremony}" — known: ${Object.keys(PRESETS).join(", ")}`,
          );
          return;
        }
        // Phase 15 SC1 (F-019): --label is optional, but when given it must
        // satisfy the session:started payload contract (≥3 chars). Reject
        // client-side with a usage error rather than a deep INVALID_PAYLOAD.
        if (opts.label !== undefined && opts.label.length < 3) {
          ctx.failureKeyed(
            "USAGE",
            FAILURE_SITE_KEYS.startLabelTooShort,
            { min_length: 3 },
            { min_length: 3, actual_length: opts.label.length },
          );
          return;
        }
        if (opts.workspace.length < 1) {
          ctx.failureKeyed("USAGE", FAILURE_SITE_KEYS.startWorkspaceEmpty, {}, {});
          return;
        }
        const featureDir = opts.featureDir ?? defaultFeatureDir(feature);
        ctx.recordTraceTarget(feature, featureDir);
        const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
        const sessionId = crypto.randomUUID();
        const result = await mutator.run(
          featureDir,
          session,
          {
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
            actor,
          },
          "legacy-fail",
        );
        if (!result) return;
        const state = result.snapshot.state;
        if (state === null) {
          ctx.emitFailure(
            "REDUCER_ERROR",
            "internal: state missing from snapshot after successful session:started apply",
          );
          return;
        }
        const out = {
          ok: true,
          feature,
          session_id: sessionId,
          ceremony_label: opts.ceremony,
          workspace: opts.workspace,
          feature_dir: featureDir,
          sub_state: state.sub_state,
        };
        // Phase 16 SC-5b1 pilot — `loaf start` is the first command
        // migrated to ctx.success(payload, textRenderer, advisories).
        // Text mode stdout = bare session_id (UUID) for pipeable use;
        // stderr stateChange + next advisory per protocol §10.12
        // (`docs/protocol.md:2014` — aligned to runtime data, no F-NNN).
        ctx.success(
          out,
          () => `${sessionId}\n`,
          (i18n) => {
            const next = buildNextAdvisory(
              i18n,
              {
                feature: state.feature,
                feature_dir: featureDir,
                phase: state.phase,
                sub_state: state.sub_state,
                ceremony: state.ceremony,
                spec_locked: state.spec_locked,
                verify_accepted: state.verify_accepted,
                pending: pendingKindsForNext(result.snapshot.pending),
              },
              opts.featureDir !== undefined
                ? { kind: "feature-dir", value: featureDir }
                : { kind: "feature", value: state.feature },
            );
            return {
              stateChange: i18n.t(SUCCESS_KEYS.startStateChange, { feature }),
              ...(next === undefined ? {} : { next }),
            };
          },
        );
      },
    );

  // ── loaf advance <to> ───────────────────────────────────────────────
  program
    .command("advance <to>")
    .description("Advance the session cursor (emits event:phase_advanced)")
    .option("--feature <name>", "Feature whose session to advance")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (to: string, opts: { feature: string; featureDir?: string }) => {
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      const from = session.snapshot.state?.sub_state;
      if (!from) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionAdvance, opts.feature);
        return;
      }
      if (to === "EXECUTE.done" && (from === "EXECUTE.work" || from === "EXECUTE.done")) {
        const state = session.snapshot.state!;
        const repoRoot = path.dirname(path.dirname(featureDir));
        try {
          const closure = await mutator.runExecuteClosure(
            {
              featureDir,
              session,
              actor,
              identity: { session_id: state.session_id, cwd: repoRoot },
              runtime: { runtimeDir, now: runtimeNow },
              debug: ctx.debug,
              ...(executeClosureHooks !== undefined && { hooks: executeClosureHooks }),
            },
            "legacy-fail",
          );
          if (closure === null) return;
          if (closure.kind !== "not-committed") {
            const snapshot =
              closure.kind === "committed" ? closure.result.snapshot : closure.session.snapshot;
            const out = {
              ok: true,
              from: closure.from,
              to,
              sub_state: snapshot.state?.sub_state,
            };
            ctx.success(
              out,
              () => "",
              (i18n) => ({
                stateChange: i18n.t(SUCCESS_KEYS.advanceStateChange, {
                  from: closure.from,
                  to,
                }),
              }),
            );
            return;
          }
        } catch (error) {
          const isRuntimeLockFailure =
            error instanceof RuntimeStoreError && error.code.startsWith("RUNTIME_LOCK_");
          if (!isRuntimeLockFailure && !(error instanceof ExecuteClosureError)) throw error;
          const code = isRuntimeLockFailure ? "LOCK_TIMEOUT" : "SCHEMA_VALIDATION_FAILED";
          ctx.failure(code, `EXECUTE closure failed: ${(error as Error).message}`, {
            source: "execute-closure",
            ...(error instanceof ExecuteClosureError && error.detail !== undefined
              ? error.detail
              : {}),
          });
          return;
        }
      }
      const result = await mutator.run(
        featureDir,
        session,
        { kind: "event:phase_advanced", payload: { from, to }, actor },
        "legacy-fail",
      );
      if (!result) return;
      const out = { ok: true, from, to, sub_state: result.snapshot.state?.sub_state };
      ctx.success(
        out,
        () => "",
        (i18n) => ({
          stateChange: i18n.t(SUCCESS_KEYS.advanceStateChange, { from, to }),
        }),
      );
    });

  // ── loaf status ─────────────────────────────────────────────────────
  // Phase 15 SC3: switched from loadSession (full replay) to
  // loadProjections (snapshot + fast-check). Pre-`loaf start` dir now
  // exits 2 NO_SESSION (was exit 0 + state:null) — codex r175a confirmed
  // (A): uniform with the other 3 SC3-wired read commands.
  program
    .command("status")
    .description("Show the current session snapshot (read-only)")
    .option("--feature <name>", "Feature whose status to show")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      if (ctx.rejectIfDryRun("status")) return;
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const loaded = await ctx.loadProjectionsOrFail(
        featureDir,
        ["state", "tasks", "evidence", "findings", "pending"] as const,
        opts.feature,
        FAILURE_SITE_KEYS.noSessionStatus,
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
      ctx.success(
        out,
        (i18n) =>
          i18n.t(CHROME_KEYS.statusFeature, { feature: opts.feature }) +
          "\n" +
          i18n.t(CHROME_KEYS.statusPhase, { phase: i18n.t(subStateKey(state.sub_state)) }) +
          "\n" +
          i18n.t(CHROME_KEYS.statusCursor, { cursor: state.sub_state }) +
          "\n" +
          i18n.t(CHROME_KEYS.statusTail, { seq: out.tail_seq }) +
          "\n" +
          i18n.t(CHROME_KEYS.statusCounts, {
            tasks_count: out.tasks_count,
            evidence_count: out.evidence_count,
            findings_count: out.findings_count,
            pending_count: out.pending_count,
          }) +
          "\n" +
          i18n.t(CHROME_KEYS.statusSnapshotAsOfProjectionLoader, { seq: out.tail_seq }) +
          "\n",
      );
    });

  // ── loaf next ───────────────────────────────────────────────────────
  // Read-side phase-routing computation. It does not mutate the session;
  // it formats the next owner command from the current cursor, unresolved
  // pending head, ceremony forks, and VERIFY lane applicability.
  program
    .command("next")
    .description("Compute the next owner command for the current session (read-only)")
    .option("--feature <name>", "Feature whose next action to compute")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature?: string; featureDir?: string }) => {
      if (ctx.rejectIfDryRun("next")) return;
      const requestedFeatureDir = opts.featureDir !== undefined;
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const loaded = await ctx.loadProjectionsOrFail(
        featureDir,
        ["state", "tasks", "pending"] as const,
        opts.feature!,
        FAILURE_SITE_KEYS.noSessionStatus,
      );
      if (loaded === null) return;

      let verifyApplicableLanes: ReturnType<typeof deriveVerifyApplicability> | undefined;
      if (loaded.state.sub_state.startsWith("VERIFY.")) {
        const read = await readSpecFrontmatter(featureDir);
        if (!read.ok) {
          ctx.emitFailure("SPEC_FRONTMATTER_INVALID", read.message, {
            subcode: read.code,
            ...(read.detail ?? {}),
          });
          return;
        }
        const tasks: TaskState[] = loaded.tasks
          ? loaded.tasks.tasks.map((t) => extractTaskSlim(t))
          : [];
        // deriveVerifyApplicability reads frontmatter plus snapshot.tasks;
        // the remaining Snapshot fields are intentionally not loaded here.
        verifyApplicableLanes = deriveVerifyApplicability(
          {
            state: null,
            tasks,
            evidence: [],
            findings: [],
            pending: [],
            spec_header: null,
            requirements: [],
            scenarios: [],
            visual_contracts: [],
            tasks_based_on: null,
          },
          read.frontmatter,
        );
      }

      const rawOut = buildNextOutput({
        feature: opts.feature!,
        feature_dir: featureDir,
        phase: loaded.state.phase,
        sub_state: loaded.state.sub_state,
        ceremony: loaded.state.ceremony,
        spec_locked: loaded.state.spec_locked,
        verify_accepted: loaded.state.verify_accepted,
        pending: loaded.state.pending,
        verify_applicable_lanes: verifyApplicableLanes,
      });
      const selector = requestedFeatureDir
        ? ({ kind: "feature-dir", value: featureDir } as const)
        : ({ kind: "feature", value: opts.feature! } as const);
      const out =
        rawOut.next_action === undefined
          ? rawOut
          : {
              ...rawOut,
              next_action: {
                ...rawOut.next_action,
                command: appendSelector(rawOut.next_action.command, selector),
              },
            };

      ctx.success(out, () => (out.next_action === undefined ? "" : `${out.next_action.command}\n`));
    });
}
