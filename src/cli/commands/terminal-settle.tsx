import type { Command } from "commander";
import type { CommandContext } from "../command-context.js";
import type { CommandMutator } from "../command-mutator.js";
import { FAILURE_SITE_KEYS, SUCCESS_KEYS } from "../runtime-i18n-keys.js";
import { loadSession } from "../../core/cli-runtime.js";
import { buildResumePack } from "../build-resume-pack.js";
import { ResumePack as RuntimeResumePack } from "../../core/resume-pack-schema.js";
import { promises as fsP } from "node:fs";
import path from "node:path";

export function registerTerminalSettle(
  program: Command,
  ctx: CommandContext,
  mutator: CommandMutator,
  actor: string,
): void {
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
    .option("--feature <name>", "Feature whose session to settle")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      const from = session.snapshot.state?.sub_state;
      if (!from) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
        return;
      }

      // mutate. preflight + transition validator enforce all preconditions
      // (settle_phase / verify_accepted / cursor edge legality).
      const result = await mutator.run(
        featureDir,
        session,
        // module-level cli:loaf actor — settle is machine-driven
        { kind: "event:phase_advanced", payload: { from, to: "SETTLE.reconcile" }, actor },
      );
      if (!result) return;

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
      ctx.success(
        out,
        (i18n) => i18n.t(SUCCESS_KEYS.settleText),
        (i18n) => ({
          stateChange: i18n.t(SUCCESS_KEYS.settleStateChange, { from }),
          next: i18n.t(SUCCESS_KEYS.nextSettleLessons),
        }),
      );
    });

  // ── loaf resume — Phase 16 SC-13b ────────────────────────────────────
  // Mutator: reads `<feature-dir>/snapshots/resume-pack.json`, validates
  // via runtime ResumePack, emits a typed `session:resumed` journal
  // entry. Cursor / projection state UNCHANGED — the entry is a
  // transparent marker (codex r343 P3). Default cli actor
  // (`cli:loaf@<USER>`) is allowed per PER_KIND_ACTOR; no human gate.
  // `--dry-run` honored through standard mutate dry-run path.
  program
    .command("resume")
    .description(
      "Resume session from snapshots/resume-pack.json (emits session:resumed journal entry)",
    )
    .option("--feature <name>", "Feature whose resume pack to consume")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: false });
      if (!session.snapshot.state) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
        return;
      }
      const packPath = path.join(featureDir, "snapshots", "resume-pack.json");
      let raw: string;
      try {
        raw = await fsP.readFile(packPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          ctx.emitFailure(
            "INPUT_FILE_NOT_FOUND",
            `resume pack not found at ${packPath}; run \`loaf handoff --reason "..."\` first to create one`,
            { path: packPath },
          );
          return;
        }
        throw err;
      }
      let parsedPack: unknown;
      try {
        parsedPack = JSON.parse(raw);
      } catch (err) {
        ctx.emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `resume pack at ${packPath} is not valid JSON: ${(err as Error).message}`,
          { subcode: "invalid-json", path: packPath },
        );
        return;
      }
      const packParse = RuntimeResumePack.safeParse(parsedPack);
      if (!packParse.success) {
        ctx.emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `resume pack at ${packPath} failed ResumePack schema validation`,
          { subcode: "zod", path: packPath, issues: packParse.error.issues },
        );
        return;
      }
      const pack = packParse.data;
      // Default cli actor — PER_KIND_ACTOR allows human|skill|ci|cli.
      const resumeActor = `cli:loaf@${process.env["USER"] ?? "unknown"}`;
      const result = await mutator.run(featureDir, session, {
        kind: "session:resumed",
        payload: {
          resumed_from_pack: {
            at: pack.at,
            reason: pack.reason,
            session_id: pack.session_id,
          },
        },
        actor: resumeActor,
      });
      if (!result) return;
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          session_id: pack.session_id,
          sub_state: result.snapshot.state?.sub_state,
        },
        () => `${pack.session_id}\n`,
        (i18n) => ({
          stateChange: i18n.t(SUCCESS_KEYS.resumeStateChange, {
            session_id: pack.session_id,
            sub_state: result.snapshot.state?.sub_state,
          }),
        }),
      );
    });

  // ── loaf handoff — Phase 16 SC-13a ───────────────────────────────────
  // Read-side projection writer. Composes a `ResumePack` from current
  // snapshot + journal tail IDs, writes atomically to
  // `<feature-dir>/snapshots/resume-pack.json`. Does NOT emit a journal
  // entry. Reject `--dry-run` with new `command_type: "projection-writer"`
  // category (writes a file but no journal mutation — neither read-only
  // nor wrapping).
  program
    .command("handoff")
    .description(
      "Compose and persist snapshots/resume-pack.json (read-side projection writer; no journal entry)",
    )
    .requiredOption(
      "--reason <text>",
      "Why this handoff is being taken (≥5 chars; mandatory per ResumePack.reason)",
    )
    .option("--notes <text>", "Optional free-form notes attached to the pack")
    .option("--feature <name>", "Feature whose handoff to take")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
      async (opts: { reason: string; notes?: string; feature: string; featureDir?: string }) => {
        if (ctx.rejectIfDryRun("handoff", "projection-writer")) return;
        if (opts.reason.length < 5) {
          ctx.failureKeyed(
            "USAGE",
            FAILURE_SITE_KEYS.handoffReasonTooShort,
            { min_length: 5, reason_length: opts.reason.length },
            { min_length: 5, reason_length: opts.reason.length },
          );
          return;
        }
        // Handoff is a deliberate human decision (codex r345 P4 — actor is
        // a gate not persisted in the pack, per ResumePack having no actor
        // field; documented residual).
        const humanActor = ctx.resolveHumanActorOrFail();
        if (humanActor === null) return;
        const featureDir = await ctx.dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await loadSession(featureDir, { ensureDir: false });
        if (!session.snapshot.state) {
          ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
          return;
        }
        const pack = buildResumePack({
          snapshot: session.snapshot,
          entries: session.entries,
          at: new Date().toISOString(),
          reason: opts.reason,
          ...(opts.notes !== undefined && { notes: opts.notes }),
        });
        // Defense-in-depth: validate against runtime schema before write.
        const parse = RuntimeResumePack.safeParse(pack);
        if (!parse.success) {
          ctx.failureKeyed(
            "SCHEMA_VALIDATION_FAILED",
            FAILURE_SITE_KEYS.handoffPackValidationFailed,
            {},
            { subcode: "zod", issues: parse.error.issues },
          );
          return;
        }
        // Atomic write to <feature-dir>/snapshots/resume-pack.json
        const snapshotsDir = path.join(featureDir, "snapshots");
        await fsP.mkdir(snapshotsDir, { recursive: true });
        const packPath = path.join(snapshotsDir, "resume-pack.json");
        const tmpPath = packPath + ".tmp";
        await fsP.writeFile(tmpPath, JSON.stringify(pack, null, 2) + "\n");
        await fsP.rename(tmpPath, packPath);
        ctx.success(
          { ok: true, feature: opts.feature, pack_path: packPath, session_id: pack.session_id },
          () => `${packPath}\n`,
          (i18n) => ({
            stateChange: i18n.t(SUCCESS_KEYS.handoffStateChange, { actor: humanActor }),
          }),
        );
      },
    );
}
