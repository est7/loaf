import type { Command } from "commander";
import type { CommandContext } from "../command-context.js";
import type { CommandMutator } from "../command-mutator.js";
import { FAILURE_SITE_KEYS, SUCCESS_KEYS } from "../runtime-i18n-keys.js";
import { loadSession } from "../../core/cli-runtime.js";
import { allocateNextEvidenceId, allocateNextEvidenceIds } from "../evidence-id-allocator.js";
import { buildWaiveEvidencePayload } from "../waive.js";
import { CoversRefPayload, EvidenceAddInput } from "../../core/evidence-schema.js";
import { parseInputSource } from "../input-source.js";
import { readJsonInput } from "../input-read.js";
import type { MutatorEntry } from "../mutator-entry.js";
import type { I18n } from "../i18n.js";

function normalizedCovers(covers: readonly string[] | undefined): string {
  if (!covers || covers.length === 0) return "";
  return [...new Set(covers)].sort().join(",");
}

function formatCovers(i18n: I18n, covers: readonly string[] | undefined): string {
  if (!covers || covers.length === 0) return i18n.t(SUCCESS_KEYS.evidenceCoversNone);
  return [...new Set(covers)].sort().join(",");
}

function evidenceAddStateChange(
  i18n: I18n,
  items: Array<{ id: string; kind: string; covers?: readonly string[] | undefined }>,
): string {
  if (items.length === 1) {
    const it = items[0]!;
    return i18n.t(SUCCESS_KEYS.evidenceAddStateChangeSingle, {
      evidence_id: it.id,
      kind: it.kind,
      covers: formatCovers(i18n, it.covers),
    });
  }
  const kinds = new Set(items.map((it) => it.kind));
  const coversNorm = new Set(items.map((it) => normalizedCovers(it.covers)));
  const idsList = items.map((it) => it.id).join(",");
  if (kinds.size === 1 && coversNorm.size === 1) {
    const kind = [...kinds][0]!;
    const coversForRender = formatCovers(i18n, items[0]!.covers);
    return i18n.t(SUCCESS_KEYS.evidenceAddStateChangeBatchHomogeneous, {
      count: items.length,
      evidence_ids: idsList,
      kind,
      covers: coversForRender,
    });
  }
  return i18n.t(SUCCESS_KEYS.evidenceAddStateChangeBatchMixed, {
    count: items.length,
    evidence_ids: idsList,
  });
}

export function registerEvidence(
  program: Command,
  ctx: CommandContext,
  mutator: CommandMutator,
  actor: string,
  isStdinTty: () => boolean,
  readStdin: () => Promise<string>,
): { evidenceCmd: Command } {
  // ── loaf evidence add --input <src> ───────────────────────────────────
  // Phase 16 SC-4c (closes SC-4 series; codex r229 → r236 amend cycles):
  // unified --input source modality + batch (array) input. Slice 3 SC2
  // shipped the single-entry file-only minimum; SC-4c extends to all 6
  // source-resolution consumers' shared contract.
  //
  // Scope per codex r236 GO (after r230 → r234 patches absorbed):
  //   - `--input <src>` source-discriminated: `-` (stdin via deps.readStdin
  //     with TTY no-hang guard) / inline JSON / file path (protocol §10.7).
  //   - Single object OR non-empty array; array enables batch input via
  //     EvidenceAddInputBatched. One mutateBatch atomic per invocation;
  //     EV-ids allocated sequentially max+1..max+N from a single
  //     max-serial scan.
  //   - Caller-supplied `id` / `evidence_id` / `schema_version` / `at` →
  //     SCHEMA_VALIDATION_FAILED (codex r230 PATCH D — input-schema
  //     violations consistently use SCHEMA_VALIDATION_FAILED; USAGE
  //     reserved for CLI shape/TTY/flag misuse). Per-item failures
  //     include detail.index identifying the failing array element.
  //   - EvidenceAddInput (src/core/evidence-schema.ts) = EvidenceFullShape
  //     .omit({id:true}).strict() — caller-owned id rejection at the
  //     schema layer, not silently stripped. EvidenceFullPayload refines
  //     (manual/waiver actor=human:* + reason≥10; visual-review ≥1
  //     attachment) run later in mutateBatch preflight AFTER id injection.
  //   - Attachments still require full AttachmentPayload {path, sha256,
  //     mime, bytes?} in SC-4c. ADR-0004 A6 auto-hash materialization
  //     (path → full Attachment) is DEFERRED to a future SC; runtime +
  //     docs/schemas.ts INPUT_SCHEMAS["evidence:add"] machine schema +
  //     this CLI handler all match on the full-metadata requirement.
  //   - No `--external-ref` CLI flag; `external_ref` is allowed only
  //     as an --input field (passthrough via EvidenceFullPayload).
  const evidenceCmd = program
    .command("evidence")
    .description("Evidence ledger commands (Slice 3 SC2 MVP: add)");

  evidenceCmd
    .command("add")
    .description(
      "Append evidence entry/entries from --input <src> JSON (CLI allocates EV-id; single object or non-empty array for batch)",
    )
    .option(
      "--input <src>",
      "JSON source for EvidenceAddInput (single object OR non-empty array for batch): `-` (stdin), inline JSON, or file path (protocol §10.7)",
    )
    .option("--schema", "Dump the input JSON Schema instead of mutating (Phase 16 SC-10)")
    .option("--feature <name>", "Feature whose ledger to append to")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
      async (rawOpts: {
        input?: string;
        schema?: boolean;
        feature: string;
        featureDir?: string;
      }) => {
        if (rawOpts.schema === true) {
          if (ctx.rejectIfDryRun("evidence add --schema")) return;
          mutator.emitSchemaAndExit("evidence:add");
          return;
        }
        if (rawOpts.input === undefined) {
          ctx.emitFailure(
            "MISSING_INPUT",
            "loaf evidence add requires --input <src> (or pass --schema to dump the input JSON Schema)",
          );
          return;
        }
        const opts = rawOpts as { input: string; feature: string; featureDir?: string };
        // SC-6b — record trace target at action entry so long input-validation
        // failures still trace. SC-8: dispatchOrFail handles §10.3 precedence
        // + traceTarget in one call.
        const earlyFeatureDir = await ctx.dispatchOrFail(opts);
        if (earlyFeatureDir === null) return;
        // Phase 16 SC-4c — unified --input modality (protocol §10.7) +
        // array (batch) input enabled (was USAGE reject).
        const source = parseInputSource(opts.input);
        if (source.kind === "stdin" && isStdinTty()) {
          ctx.failure(
            "USAGE",
            "stdin is TTY — `loaf evidence add --input -` expects piped input. " +
              "Pipe JSON via `... | loaf evidence add --input -`, OR pass inline " +
              "JSON / file path. Run --help for examples.",
          );
          return;
        }
        const read = await readJsonInput(source, { readStdin });
        if (!read.ok) {
          ctx.failure(read.code, read.message, read.detail);
          return;
        }
        const parsed = read.value;

        // Normalize to array; reject empty (codex r230 Q3 + r236 PATCH E).
        const rawItems: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        if (rawItems.length === 0) {
          ctx.failure(
            "SCHEMA_VALIDATION_FAILED",
            "evidence add input is an empty array (non-empty array required)",
          );
          return;
        }

        // Per-item strict parse — caller-supplied `id` rejected via
        // .strict() in EvidenceAddInput (codex r230 PATCH D:
        // SCHEMA_VALIDATION_FAILED, not USAGE, for input-schema violations
        // — matches tasks add strict rejection pattern). detail.index
        // identifies the failing item in batch input.
        const validatedInputs: EvidenceAddInput[] = [];
        for (let i = 0; i < rawItems.length; i++) {
          const raw = rawItems[i];
          const p = EvidenceAddInput.safeParse(raw);
          if (!p.success) {
            ctx.failure(
              "SCHEMA_VALIDATION_FAILED",
              `evidence add input[${i}] failed schema validation: ${p.error.issues.map((iss: { message: string }) => iss.message).join("; ")}`,
              { index: i, issues: p.error.issues },
            );
            return;
          }
          validatedInputs.push(p.data);
        }

        // Load session via ctx.
        const featureDir = await ctx.dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await ctx.resolveSession(featureDir);
        if (!session.snapshot.state) {
          ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
          return;
        }

        // Allocate EV-ids sequentially via shared allocator (Phase 16
        // SC-11 lock — single source for `evidence add` / `waive` /
        // `lessons add`). Atomic across batch via mutateBatch sharing
        // batch_id (codex r230 Q1 / r236 GO).
        const evIds: string[] = allocateNextEvidenceIds(session.snapshot, validatedInputs.length);

        // Materialize full payloads (inject CLI-allocated EV-id; refines
        // in EvidenceFullPayload run during mutateBatch preflight).
        const entries: MutatorEntry[] = validatedInputs.map((input, i) => ({
          kind: "evidence:added",
          payload: { ...input, id: evIds[i] },
          actor,
        }));

        const result = await mutator.run(featureDir, session, entries, "raw-ctx-failure");
        if (!result) return;

        // Output preserves single-input bare-EV-id text (back-compat per
        // codex r230 Q6 + r236) and adds {ok, feature, ev_ids, count,
        // sub_state} JSON for batch (matches tasks add shape).
        // SC-5b2: stateChange via evidenceAddStateChange helper per
        // protocol §10.12 (set-semantics covers; heterogeneous batches
        // drop kind/covers).
        const isBatch = Array.isArray(parsed);
        const evidenceItems = validatedInputs.map((input, i) => ({
          id: evIds[i]!,
          kind: input.kind,
          covers: input.covers,
        }));
        if (isBatch) {
          ctx.success(
            {
              ok: true,
              feature: opts.feature,
              ev_ids: evIds,
              count: evIds.length,
              sub_state: result.snapshot.state?.sub_state,
            },
            () => evIds.join("\n") + "\n",
            (i18n) => ({ stateChange: evidenceAddStateChange(i18n, evidenceItems) }),
          );
        } else {
          // Single-input back-compat: bare EV-id in text mode; {ok,
          // feature, id, kind} in JSON mode (pre-SC-4c shape preserved).
          ctx.success(
            {
              ok: true,
              feature: opts.feature,
              id: evIds[0],
              kind: validatedInputs[0]!.kind,
            },
            () => `${evIds[0]}\n`,
            (i18n) => ({ stateChange: evidenceAddStateChange(i18n, evidenceItems) }),
          );
        }
      },
    );

  // ── loaf waive <obligation-id> — Phase 16 SC-11 ──────────────────────
  // Sugar wrapper over `evidence:added` payload.kind=waiver. Records a
  // human:* waiver against a specific obligation id (REQ-/SCEN-/VIS-/T-)
  // with a required ≥10-char reason. Single-shot — emits one
  // evidence:added entry (no batch). Uses the shared SC-11 EV-id
  // allocator so monotonic ordering matches `evidence add` /
  // `lessons add`.
  program
    .command("waive <obligation-id>")
    .description(
      "Record a waiver evidence (kind=waiver) against an obligation id (REQ-/SCEN-/VIS-/T-)",
    )
    .requiredOption(
      "--reason <text>",
      "Waiver rationale (≥10 chars; mandatory per evidence schema refine)",
    )
    .option("--feature <name>", "Feature whose ledger to append to")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
      async (
        obligationId: string,
        opts: { reason: string; feature: string; featureDir?: string },
      ) => {
        // (1) obligation id validation via shared CoversRefPayload regex
        //     (no parallel local regex; codex r322 P5 lock)
        const idCheck = CoversRefPayload.safeParse(obligationId);
        if (!idCheck.success) {
          ctx.emitFailure(
            "USAGE",
            `invalid obligation id '${obligationId}' — expected REQ-NS-NNN / SCEN-NS-NNN / VIS-NS-NNN / T-NNN form`,
            { argument: obligationId },
          );
          return;
        }
        // (2) reason length is enforced by EvidenceFullPayload refine
        //     downstream; surface the friendlier USAGE here too
        if (opts.reason.length < 10) {
          ctx.failureKeyed(
            "USAGE",
            FAILURE_SITE_KEYS.lessonsReasonTooShort,
            { min_length: 10, reason_length: opts.reason.length },
            { min_length: 10, reason_length: opts.reason.length },
          );
          return;
        }
        // (3) resolve human actor (waiver requires human:* per refine)
        const waiveActor = ctx.resolveHumanActorOrFail();
        if (waiveActor === null) return;
        const featureDir = await ctx.dispatchOrFail(opts);
        if (featureDir === null) return;
        const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
        if (!session.snapshot.state) {
          ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
          return;
        }
        // (4) allocate EV-id + build payload (pure builder, payload only)
        const evidenceId = allocateNextEvidenceId(session.snapshot);
        const payload = buildWaiveEvidencePayload({
          evidenceId,
          obligationId,
          reason: opts.reason,
          actor: waiveActor,
          iteration: session.snapshot.state.iteration,
        });
        // (5) wrap in journal envelope (codex r325 P1 Option A boundary)
        const result = await mutator.run(featureDir, session, {
          kind: "evidence:added",
          payload,
          actor: waiveActor,
        });
        if (!result) return;
        ctx.success(
          {
            ok: true,
            feature: opts.feature,
            id: evidenceId,
            kind: "waiver" as const,
            obligation_id: obligationId,
          },
          () => `${evidenceId}\n`,
          (i18n) => ({
            stateChange: i18n.t(SUCCESS_KEYS.waiveStateChange, {
              evidence_id: evidenceId,
              obligation_id: obligationId,
            }),
          }),
        );
      },
    );

  return { evidenceCmd };
}
