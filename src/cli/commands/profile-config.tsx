import type { Command } from "commander";
import type { CommandContext } from "../command-context.js";
import type { CommandMutator } from "../command-mutator.js";
import { FAILURE_SITE_KEYS, SUCCESS_KEYS } from "../runtime-i18n-keys.js";
import { defaultFeatureDir, loadSession } from "../../core/cli-runtime.js";
import {
  defaultLoafConfig,
  LoafConfig,
  loafConfigPath,
  writeConfigExclusive,
} from "../../core/loaf-config.js";
import { UserConfig, userConfigPath } from "../../core/user-config.js";
import { replayJournal } from "../../core/journal-bootstrap.js";
import { writeProjections } from "../../core/projection-writer.js";
import {
  acquireFeatureWriteLease,
  FeatureWriteLeaseError,
  type FeatureWriteLease,
} from "../../core/feature-write-lease.js";
import { promises as fsP } from "node:fs";
import path from "node:path";
import os from "node:os";

// ── loaf config init — scaffold project/user config (no journal entry) ──
const CONFIG_INIT_COMMENT =
  "Scaffolded by `loaf config init`. Machine contract: src/core/loaf-config.ts LoafConfig. " +
  "This _comment key is an output affordance only; loaf-cli parses the semantic config without it.";

function serializeStableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

export function registerProfileConfig(
  program: Command,
  ctx: CommandContext,
  mutator: CommandMutator,
  actor: string,
  userConfigHomeDir: string | undefined,
): void {
  // ── loaf spike <subcommand> ─────────────────────────────────────────
  // Phase 12 — spike-task exit `convert` (protocol §8.3). Record-only:
  // emits a 2-entry batch [spike:converted, session:archived]. The
  // spike:converted entry records {to_feature, reason}; the sponsored
  // session:archived owns the terminal cursor flip to DONE.archived. The
  // target feature F-N is opened later by a separate `loaf start` — this
  // command does NOT scaffold it. Precondition (preflight 5c.3):
  // SPIKE_CONVERT_NO_SPIKE_TASK if the session holds no non-abandoned
  // kind=spike task.
  const spikeCmd = program.command("spike").description("Spike-task exits (protocol §8.3)");

  spikeCmd
    .command("convert")
    .description("Convert a spike session — emits spike:converted then archives to DONE.archived")
    .option("--feature <name>", "Feature whose spike session to convert")
    .requiredOption("--to-feature <id>", "Target feature id (F-NNN) the spike learnings carry into")
    .requiredOption("--reason <text>", "Rationale recorded on the spike:converted entry")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
      async (opts: { feature: string; toFeature: string; reason: string; featureDir?: string }) => {
        // (1) Human-only actor — `spike:converted` is HUMAN_ONLY per PER_KIND_ACTOR.
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

        // (3) Mutate — 2-entry batch. spike:converted (record-only) MUST
        //     precede session:archived: it carries ANY_NON_DONE authority and
        //     would be rejected against the post-archive DONE snapshot. The
        //     sponsored session:archived performs the terminal cursor flip.
        const result = await mutator.run(featureDir, session, [
          {
            kind: "spike:converted",
            payload: { to_feature: opts.toFeature, reason: opts.reason },
            actor: humanActor,
          },
          {
            kind: "session:archived",
            payload: { reason: opts.reason },
            actor: humanActor,
          },
        ]);
        if (!result) return;

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
        ctx.success(
          out,
          () => "",
          (i18n) => ({
            stateChange: i18n.t(SUCCESS_KEYS.spikeConvertStateChange, {
              feature: opts.feature,
              to_feature: opts.toFeature,
              from,
              actor: humanActor,
            }),
          }),
        );
      },
    );

  // ── loaf profile <subcommand> ───────────────────────────────────────
  // Phase 13 — `profile escalate` applies a ceremony escalation (protocol
  // §10.8 / §1918). Escalation POLICY (which preset to escalate to) is a
  // skill concern (src/core/escalation-schema.ts): the skill computes the new 6-flag
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
    .option("--feature <name>", "Feature whose session to escalate")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
      async (opts: { confirm: boolean; input: string; feature: string; featureDir?: string }) => {
        // SC-6b — record trace target at action entry so input-read /
        // schema-parse failures still trace. SC-8: dispatchOrFail
        // resolves §10.3 precedence + mutates opts.feature/featureDir
        // + records traceTarget (replaces the SC-6b raw recordTraceTarget).
        const earlyFeatureDir = await ctx.dispatchOrFail(opts);
        if (earlyFeatureDir === null) return;
        // (1) Human-only acceptance — escalation is a human decision.
        const humanActor = ctx.resolveHumanActorOrFail();
        if (humanActor === null) return;

        // (2) Read + parse the escalated Ceremony. Schema validation is the
        //     mutateBatch preflight's job (PER_KIND_PAYLOAD = CeremonyPayload).
        let content: string;
        try {
          content = await fsP.readFile(opts.input, "utf8");
        } catch (err) {
          if ((err as { code?: string }).code === "ENOENT") {
            ctx.failureKeyed(
              "INPUT_FILE_NOT_FOUND",
              FAILURE_SITE_KEYS.profileInputFileMissing,
              { path: opts.input },
              { path: opts.input },
            );
          } else {
            ctx.failureKeyed(
              "INPUT_FILE_NOT_FOUND",
              FAILURE_SITE_KEYS.profileInputFileUnreadable,
              { path: opts.input, error: String(err) },
              { path: opts.input },
            );
          }
          return;
        }
        let ceremony: unknown;
        try {
          ceremony = JSON.parse(content);
        } catch (err) {
          ctx.emitFailure(
            "SCHEMA_VALIDATION_FAILED",
            `input is not valid JSON: ${(err as Error).message}`,
          );
          return;
        }

        // (3) Load session.
        const featureDir = await ctx.dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
        const from = session.snapshot.state?.sub_state;
        if (!from) {
          ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
          return;
        }

        // (4) The pending:resolved entry needs the head id. Preflight 5c.4
        //     owns the authority check (head must be profile_escalation);
        //     this only handles the structural "no head at all" case, where
        //     no PEND-id exists to build the pending:resolved entry.
        const head = session.snapshot.pending.find((p) => !p.resolved);
        if (!head) {
          ctx.emitFailure(
            "ESCALATION_NOT_PENDING",
            "`loaf profile escalate --confirm --input <ceremony.json>` requires pending head kind=profile_escalation; current head: (none)",
            { actual_head: "(none)" },
          );
          return;
        }

        // (5) Mutate — 2-entry batch. event:ceremony_set MUST precede
        //     pending:resolved so preflight 5c.4 sees the unresolved head.
        const result = await mutator.run(featureDir, session, [
          {
            kind: "event:ceremony_set",
            payload: ceremony as Record<string, unknown>,
            actor: humanActor,
          },
          {
            kind: "pending:resolved",
            payload: { id: head.id },
            actor: humanActor,
          },
        ]);
        if (!result) return;

        // (6) Success output. The batch moves no cursor — sub_state unchanged.
        const out = {
          ok: true,
          feature: opts.feature,
          resolved_pending: head.id,
          sub_state: result.snapshot.state?.sub_state,
          actor: humanActor,
        };
        ctx.success(
          out,
          () => "",
          (i18n) => ({
            stateChange: i18n.t(SUCCESS_KEYS.profileEscalateStateChange, { pending_id: head.id }),
          }),
        );
      },
    );

  // ── loaf config init — scaffold project/user config (no journal entry) ──
  const refuseConfigExists = (configPath: string): void =>
    ctx.emitFailure(
      "CONFIG_ALREADY_INITIALIZED",
      `loaf config already exists at ${configPath}; refusing to overwrite`,
      { config_path: configPath },
    );

  // Pre-check before any scaffold I/O (mkdir / compose). The exclusive `wx`
  // write in writeConfigExclusive still backstops the check→write race.
  async function ensureConfigTargetAbsent(configPath: string): Promise<boolean> {
    try {
      await fsP.access(configPath);
      refuseConfigExists(configPath);
      return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw err;
    }
  }

  const configCmd = program.command("config").description("Project and user config commands");

  configCmd
    .command("init")
    .description("Write .loaf/.config/loaf.config.json; --global writes ~/.loaf/config.json")
    .option("--global", "Write user config at ~/.loaf/config.json instead of project config")
    .action(async (opts: { global?: boolean }) => {
      // no-feature: config init writes project/user config, not a feature session target.
      if (ctx.rejectIfDryRun("config init", "scaffold-writer")) return;

      const configPath = opts.global
        ? userConfigPath(userConfigHomeDir ?? os.homedir())
        : loafConfigPath(process.cwd());
      if (!(await ensureConfigTargetAbsent(configPath))) return;

      const content = opts.global
        ? serializeStableJson(
            UserConfig.parse({
              schema_version: 1,
              locale: { default_lang: "en" },
            }),
          )
        : serializeStableJson({
            _comment: CONFIG_INIT_COMMENT,
            ...LoafConfig.parse(defaultLoafConfig()),
          });

      if ((await writeConfigExclusive(configPath, content)) === "exists") {
        refuseConfigExists(configPath);
        return;
      }
      ctx.success({ ok: true, config_path: configPath }, () => `${configPath}\n`);
    });

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
  //       (src/core/error-catalog.ts lists DOCTOR_REBUILD_FAILED /
  //       DOCTOR_REBUILD_MIGRATED_UNSUPPORTED with exit_code: 2).
  //   Exit 1 is reserved for unhandled throws caught by the top-level
  //   boundary at the end of main(), which also writes ~/.loaf/crashes/.
  // The replay and all projection writes run under the feature write lease,
  // so doctor cannot publish an older replay over a concurrent mutation.
  program
    .command("doctor")
    .description("Repository self-check. This release implements --rebuild only")
    .option("--rebuild", "Full journal replay → rebuild snapshots/*.json + _meta.json")
    .option("--feature <name>", "Feature whose snapshots to rebuild (required with --rebuild)")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { rebuild?: boolean; feature?: string; featureDir?: string }) => {
      // SC-6c: doctor is read-only at this slice (--rebuild writes
      // projections directly, NOT via mutate(); a dry-run rebuild would
      // need a real in-memory replay precheck — out-of-scope per
      // codex r275 P2). Both bare doctor and --rebuild reject under
      // --dry-run with the same code.
      if (ctx.rejectIfDryRun(opts.rebuild ? "doctor --rebuild" : "doctor")) return;

      if (!opts.rebuild) {
        ctx.emitFailure(
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
        ctx.emitFailure("DOCTOR_FEATURE_REQUIRED", "doctor --rebuild requires --feature <name>");
        return;
      }

      // SC-8: doctor --rebuild bypasses ctx.resolveDispatch because the
      // whole point of `doctor --rebuild` is to recover from corrupt
      // state projections. Going through dispatch would prematurely
      // surface NoSession/SnapshotStale before the rebuild logic gets
      // a chance to read the raw journal and re-derive projections.
      // Compute featureDir directly + record trace target manually.
      // no-dispatch (sc8-dispatch-gate exception marker)
      const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
      ctx.recordTraceTarget(opts.feature, featureDir);
      let lease: FeatureWriteLease;
      try {
        lease = await acquireFeatureWriteLease(featureDir, "doctor:rebuild");
      } catch (error) {
        if (error instanceof FeatureWriteLeaseError) {
          ctx.emitFailure("LOCK_TIMEOUT", error.message);
          return;
        }
        throw error;
      }
      try {
        const journalPath = path.join(featureDir, "journal.jsonl");
        const replay = await replayJournal(journalPath, {
          collect_entries: true,
          feature_dir: featureDir,
        });
        if (!replay.ok) {
          ctx.emitFailure(
            replay.code,
            `journal at ${journalPath} cannot be replayed — ${replay.message}`,
          );
          return;
        }
        const entries = replay.entries;
        if (entries === undefined) {
          ctx.emitFailure(
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
          ctx.emitFailure(
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
          ctx.emitFailure(
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
        ctx.success(
          out,
          (i18n) =>
            i18n.t(
              rebuilt.length === 1
                ? SUCCESS_KEYS.doctorRebuildTextOne
                : SUCCESS_KEYS.doctorRebuildTextMany,
              { count: rebuilt.length, feature: opts.feature },
            ) +
            "\n" +
            rebuilt.map((f) => `  snapshots/${f}\n`).join("") +
            i18n.t(SUCCESS_KEYS.snapshotAsOfSeq, { seq: replay.meta.last_applied_seq }) +
            "\n",
          (i18n) => ({
            stateChange: i18n.t(
              rebuilt.length === 1
                ? SUCCESS_KEYS.doctorRebuildStateChangeOne
                : SUCCESS_KEYS.doctorRebuildStateChangeMany,
              { count: rebuilt.length, feature: opts.feature },
            ),
          }),
        );
      } finally {
        await lease.release();
      }
    });
}
