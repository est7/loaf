import type { Command } from "commander";
import type { CommandContext } from "../command-context.js";
import type { CommandMutator } from "../command-mutator.js";
import { FAILURE_SITE_KEYS, SUCCESS_KEYS } from "../runtime-i18n-keys.js";
import { buildSpecStatusEnvelope, renderSpecStatusText } from "../spec-status.js";
import { loadSession } from "../../core/cli-runtime.js";
import { evaluateSpecLockFromSnapshot } from "../../core/gates/spec-lock-eval.js";
import { buildSpecSubmitBatch } from "../spec-submit-batch.js";
import type { MutatorEntry } from "../mutator-entry.js";
import type { MutatorCommand } from "../input-schemas.js";
import { parseInputSource } from "../input-source.js";
import { readJsonInput } from "../input-read.js";
import { mapZodIssues } from "../check-file.js";
import { runEditor as defaultRunEditor, type RunEditor } from "../run-editor.js";
import { FRONTMATTER_RE, splitFrontmatter } from "../../core/spec-frontmatter.js";
import { parse as parseYaml } from "yaml";
import {
  SpecAddReqInput,
  SpecAddScenarioInput,
  SpecAddVisualInput,
  SpecEditInput,
  SpecFrontmatter,
  SpecSubmitInput,
  nextSerialInNamespace,
} from "../../core/spec-schema.js";
import { promises as fsP } from "node:fs";
import path from "node:path";

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

function specAddTextKey(name: SpecAddKindConfig["name"], count: number): string {
  if (name === "req") {
    return count === 1 ? SUCCESS_KEYS.specAddReqTextOne : SUCCESS_KEYS.specAddReqTextMany;
  }
  if (name === "scenario") {
    return count === 1 ? SUCCESS_KEYS.specAddScenarioTextOne : SUCCESS_KEYS.specAddScenarioTextMany;
  }
  return count === 1 ? SUCCESS_KEYS.specAddVisualTextOne : SUCCESS_KEYS.specAddVisualTextMany;
}

function specAddStateChangeKey(name: SpecAddKindConfig["name"], count: number): string {
  if (name === "req") {
    return count === 1
      ? SUCCESS_KEYS.specAddReqStateChangeOne
      : SUCCESS_KEYS.specAddReqStateChangeMany;
  }
  if (name === "scenario") {
    return count === 1
      ? SUCCESS_KEYS.specAddScenarioStateChangeOne
      : SUCCESS_KEYS.specAddScenarioStateChangeMany;
  }
  return count === 1
    ? SUCCESS_KEYS.specAddVisualStateChangeOne
    : SUCCESS_KEYS.specAddVisualStateChangeMany;
}

export function registerSpec(
  program: Command,
  ctx: CommandContext,
  mutator: CommandMutator,
  actor: string,
  isStdinTty: () => boolean,
  isStdoutTty: () => boolean,
  readStdin: () => Promise<string>,
  runEditorImpl: RunEditor | undefined,
): { specCmd: Command } {
  const resolvedRunEditor: RunEditor = runEditorImpl ?? defaultRunEditor;

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
    .description(
      "SPEC content and diagnostic commands (status / submit / add-req / add-scenario / add-visual; init in SC4)",
    );

  specCmd
    .command("status")
    .description("Show failing and suppressed spec-lock checks from replayed state (read-only)")
    .option("--feature <name>", "Feature whose spec-lock status to show")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { feature: string; featureDir?: string }) => {
      if (ctx.rejectIfDryRun("spec status")) return;
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: false });
      if (session.snapshot.state === null) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
        return;
      }
      const result = evaluateSpecLockFromSnapshot(session.snapshot);
      const envelope = buildSpecStatusEnvelope(result);
      ctx.success(envelope, (i18n) => renderSpecStatusText(envelope, i18n));
    });

  specCmd
    .command("submit")
    .description("Whole-replacement spec submit from JSON --input (CLI fills spec_version)")
    .requiredOption(
      "--input <src>",
      "JSON source: `-` (stdin), inline JSON literal, or file path (protocol §10.7)",
    )
    .option("--feature <name>", "Feature whose spec to submit")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { input: string; feature: string; featureDir?: string }) => {
      // SC-6b — record trace target at action entry so long input-validation
      // failures still trace. SC-8: dispatchOrFail handles §10.3 precedence
      // + traceTarget in one call.
      const earlyFeatureDir = await ctx.dispatchOrFail(opts);
      if (earlyFeatureDir === null) return;
      // Phase 16 SC-4a — unified --input modality (protocol §10.7 +
      // ADR-0004 A11): parseInputSource discriminates stdin / inline /
      // file; readJsonInput handles IO + JSON parse + error mapping;
      // ctx.failure routes through the shared CommandContext.
      const source = parseInputSource(opts.input);
      // TTY no-hang guard per codex r212 PATCH 2 (protocol §10.1:1505).
      if (source.kind === "stdin" && isStdinTty()) {
        ctx.failure(
          "USAGE",
          "stdin is TTY — `loaf spec submit --input -` expects piped input. " +
            "Pipe JSON via `... | loaf spec submit --input -`, OR pass inline " +
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
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        ctx.failure("USAGE", "spec submit --input expects a JSON object (SpecFrontmatter shape)");
        return;
      }
      // CLI boundary: typed runtime schema enforcement (codex r75 BLOCK
      // fix). A malformed `spec_version: "2"` or `requirements: "oops"`
      // would otherwise silently degrade (drop to current+1 / coerce to
      // []) and bump spec_version with empty projection — worse than a
      // hard failure. SpecSubmitInput rejects wrong types before mutate.
      const inputParse = SpecSubmitInput.safeParse(parsed);
      if (!inputParse.success) {
        ctx.failure(
          "SCHEMA_VALIDATION_FAILED",
          `spec submit input failed SpecSubmitInput schema validation`,
          { issues: inputParse.error.issues },
        );
        return;
      }
      const input = inputParse.data;
      // Load session via ctx (caches; captures sub_state for crash context).
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await ctx.resolveSession(featureDir);
      if (!session.snapshot.state) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
        return;
      }
      // (4-6) Build the spec-submit batch via shared SC-12a-1 helper.
      // CLI owns spec_version stamping; reducer enforces monotonic at
      // append. See `src/cli/spec-submit-batch.ts` for the canonical
      // shape (1 head + N req + M scen + K vis entries sharing at /
      // actor / spec_version).
      const now = new Date().toISOString();
      const entries = buildSpecSubmitBatch({
        input,
        snapshot: session.snapshot,
        actor,
        now,
      });
      // (7) Mutate.
      const result = await mutator.runPreparedBatch(
        featureDir,
        session,
        entries,
        "raw-ctx-failure",
      );
      if (!result) return;
      // Output. Echo collected ids for shell scripting.
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
      ctx.success(
        out,
        (i18n) =>
          i18n.t(SUCCESS_KEYS.specSubmitText, {
            spec_version: out.spec_version,
            req_count: reqIds.length,
            scen_count: scenIds.length,
            vis_count: visIds.length,
          }) + "\n",
        (i18n) => ({
          stateChange: i18n.t(SUCCESS_KEYS.specSubmitStateChange, {
            spec_version: out.spec_version,
          }),
          next: i18n.t(SUCCESS_KEYS.specSubmitNext),
        }),
      );
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
    .option("--feature <name>", "Feature whose spec.md to scaffold")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .option("--feature-id <id>", "Override feature.id in scaffold (default: F-XXX placeholder)")
    .option("--feature-name <text>", "Override feature.name in scaffold (default: --feature value)")
    .option(
      "--intent <text>",
      "Override intent line in scaffold (default: TODO placeholder ≥20 chars)",
    )
    .action(
      async (opts: {
        feature: string;
        featureDir?: string;
        featureId?: string;
        featureName?: string;
        intent?: string;
      }) => {
        const featureDir = await ctx.dispatchOrFail(opts);
        if (featureDir === null) return;
        const specMdPath = path.join(featureDir, "spec.md");
        // SPEC_ALREADY_INITIALIZED guard: refuse to overwrite. Check
        // before any I/O so the error surface is the file's existence,
        // not a partial write.
        try {
          await fsP.access(specMdPath);
          // File exists — refuse.
          ctx.emitFailure(
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
          opts.featureName ?? (opts.feature.length >= 3 ? opts.feature : "TODO Feature Name");
        const intent =
          opts.intent ?? "TODO: describe the feature intent in at least twenty characters";
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
          ctx.emitFailure(
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
          `\n## Why\n\nTODO: describe motivation and scope. Edit this section, then run \`loaf spec edit --input <json>\` to record the canonical spec.\n`;
        await fsP.writeFile(specMdPath, md);
        ctx.success(
          { ok: true, feature: opts.feature, spec_md_path: specMdPath },
          () => `${specMdPath}\n`,
          (i18n) => ({
            stateChange: i18n.t(SUCCESS_KEYS.specInitStateChange, { path: specMdPath }),
            next: i18n.t(SUCCESS_KEYS.specInitNext),
          }),
        );
      },
    );

  // ── loaf spec edit — Phase 16 SC-12a-2 ─────────────────────────────
  // Dual-lane mutator: deterministic --input replaces only the Markdown
  // body; otherwise spawn $EDITOR on <feature-dir>/spec.md. Both validate
  // frontmatter and emit the same `event:spec_submitted` batch via the
  // SC-12a-1 builder. No-op detection skips journal append.
  //
  // Codex r331 / r333 / r335 / r336 GO. See:
  //   - r336 P1: spawn error handler (runEditor.ts owns this)
  //   - r336 P2: tokenizer quote contract (runEditor.ts owns this)
  //   - r336 P3: SCHEMA_VALIDATION_FAILED + subcode parity with SC-9c
  //   - r336 P4: SC-6c scanner regex update (tests/scripts/sc6c-...)
  //   - r333 P3: signal !== null → exit 130, code !== 0 → exit 2 USAGE
  specCmd
    .command("edit")
    .description(
      "Replace the spec.md body from --input or launch $EDITOR, validate, then emit event:spec_submitted",
    )
    .option(
      "--input <src>",
      'JSON {"body":"<Markdown>"} source: `-` (stdin), inline JSON, or file path; preserves current frontmatter',
    )
    .option("--feature <name>", "Feature whose spec.md to edit")
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(async (opts: { input?: string; feature: string; featureDir?: string }) => {
      const hasInput = opts.input !== undefined;
      // The editor lane remains a wrapping command. The deterministic
      // --input lane is a normal mutator and therefore participates in the
      // shared dry-run transaction path.
      if (!hasInput && ctx.rejectIfDryRun("spec edit", "wrapping")) return;
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const explicitEditor = (process.env["EDITOR"] ?? "").trim();
      // Match the §10.1 TTY no-hang rule used by `--input -`: whether an
      // interactive program is safe is determined by its streams, never by
      // the presence of $EDITOR. Both streams must be terminals because an
      // editor reads controls from stdin and renders its UI to stdout.
      if (!hasInput && (!isStdinTty() || !isStdoutTty())) {
        ctx.emitFailure(
          "SPEC_EDIT_INPUT_REQUIRED",
          "non-interactive `loaf spec edit` requires --input <src>; the editor lane requires TTY stdin and stdout",
        );
        return;
      }
      // (1) actor — `event:spec_submitted` is human:* per PER_KIND_AUTHORITY
      const actor = ctx.resolveHumanActorOrFail();
      if (actor === null) return;
      const session = await loadSession(featureDir, { ensureDir: false });
      if (!session.snapshot.state) {
        ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
        return;
      }
      // (1.5) pre-editor lock gate (codex r339 P2): post-lock direct
      // spec edits must go through `loaf finding raise --action
      // amend-spec` so the spec_lock invariant + iteration counter
      // stay coherent. Reject BEFORE spawning $EDITOR so the user is
      // not deceived by an open editor whose contents will be discarded.
      if (session.snapshot.state.spec_locked === true) {
        ctx.emitFailure(
          "SPEC_LOCKED_NO_DIRECT_EDIT",
          `spec is locked; direct edits via \`loaf spec edit\` are rejected post-lock — use \`loaf finding raise --category spec-gap --action amend-spec --summary "..."\` to roll back to SPEC.spec and amend through the finding flow`,
          { kind: "event:spec_submitted" },
        );
        return;
      }
      const specMdPath = path.join(featureDir, "spec.md");
      // (2) capture before-content for no-op detection (codex r332 P6)
      let beforeContent: string;
      try {
        beforeContent = await fsP.readFile(specMdPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          ctx.emitFailure(
            "SCHEMA_VALIDATION_FAILED",
            `spec.md not found at ${specMdPath}; run \`loaf spec init\` to scaffold one first`,
            { subcode: "spec-not-found", path: specMdPath },
          );
          return;
        }
        throw err;
      }
      let afterContent: string;
      if (hasInput) {
        const source = parseInputSource(opts.input!);
        if (source.kind === "stdin" && isStdinTty()) {
          ctx.failure(
            "USAGE",
            "stdin is TTY — `loaf spec edit --input -` expects piped JSON. " +
              'Pipe {"body":"<Markdown>"} via stdin, or pass inline JSON / a file path.',
          );
          return;
        }
        const read = await readJsonInput(source, { readStdin });
        if (!read.ok) {
          ctx.failure(read.code, read.message, read.detail);
          return;
        }
        const inputParse = SpecEditInput.safeParse(read.value);
        if (!inputParse.success) {
          ctx.emitFailure(
            "SCHEMA_VALIDATION_FAILED",
            'spec edit --input expects a strict JSON object {"body":"<Markdown>"}',
            { issues: inputParse.error.issues },
          );
          return;
        }
        const frontmatterMatch = FRONTMATTER_RE.exec(beforeContent);
        if (frontmatterMatch === null) {
          ctx.emitFailure(
            "SCHEMA_VALIDATION_FAILED",
            `spec.md is missing a YAML frontmatter block fenced by \`---\` on the first line; --input replaces only the body and cannot repair frontmatter at ${specMdPath}`,
            { subcode: "missing-frontmatter", path: specMdPath },
          );
          return;
        }
        // Preserve the current frontmatter bytes exactly. Projection refresh
        // after the journal commit reuses this body from the CLI-owned work
        // copy. A dry-run validates the batch without touching that copy.
        afterContent = beforeContent.slice(0, frontmatterMatch[0].length) + inputParse.data.body;
      } else {
        // (3) spawn editor
        const editor = explicitEditor || "vi";
        const result = await resolvedRunEditor({
          filePath: specMdPath,
          editor,
          cwd: process.cwd(),
          env: process.env,
        });
        // (4a) spawn error → USAGE (codex r335 P1)
        if (result.error !== undefined) {
          ctx.emitFailure("USAGE", `editor '${editor}' could not be launched (${result.error})`, {
            editor,
            spawn_error: result.error,
          });
          return;
        }
        // (4b) signal abort → exit 130, no journal write (codex r333 P3)
        if (result.signal !== null) {
          ctx.exitCode = 130;
          return;
        }
        // (4c) non-zero exit → USAGE (user aborted via :q! or similar)
        if (result.code !== 0) {
          ctx.emitFailure("USAGE", `editor exited with code=${result.code}`, {
            editor,
            editor_exit: result.code,
          });
          return;
        }
        // (5) re-read post-edit content; no-op skip (codex r332 P6)
        try {
          afterContent = await fsP.readFile(specMdPath, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            ctx.emitFailure(
              "SCHEMA_VALIDATION_FAILED",
              `spec.md was deleted during edit at ${specMdPath}`,
              { subcode: "spec-not-found", path: specMdPath },
            );
            return;
          }
          throw err;
        }
      }
      if (beforeContent === afterContent) {
        ctx.success(
          { ok: true, feature: opts.feature, no_op: true, spec_md_path: specMdPath },
          () => "spec.md unchanged (no-op)\n",
        );
        return;
      }
      // (6) frontmatter validation — direct splitFrontmatter +
      //     parseYaml + SpecFrontmatter.safeParse mirrors SC-9c check
      //     subcode taxonomy (codex r336 P3)
      const { frontmatter } = splitFrontmatter(afterContent);
      if (frontmatter === null) {
        ctx.emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `spec.md is missing a YAML frontmatter block fenced by \`---\` on the first line; work copy preserved at ${specMdPath} for you to fix and re-run \`loaf spec edit\``,
          { subcode: "missing-frontmatter", path: specMdPath },
        );
        return;
      }
      let parsedYaml: unknown;
      try {
        parsedYaml = parseYaml(frontmatter);
      } catch (err) {
        ctx.emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `spec.md frontmatter YAML failed to parse: ${(err as Error).message}; work copy preserved at ${specMdPath} for you to fix and re-run \`loaf spec edit\``,
          { subcode: "invalid-yaml", path: specMdPath },
        );
        return;
      }
      const zodResult = SpecFrontmatter.safeParse(parsedYaml);
      if (!zodResult.success) {
        const issues = mapZodIssues(zodResult.error);
        ctx.emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `spec.md frontmatter failed schema validation (${issues.error_count} errors); work copy preserved at ${specMdPath} for you to fix and re-run \`loaf spec edit\``,
          {
            subcode: "zod",
            path: specMdPath,
            errors: issues.errors,
            truncated: issues.truncated,
            error_count: issues.error_count,
          },
        );
        return;
      }
      // (7) Build SpecSubmitInput (CLI stamps spec_version = current+1
      //     even if user edited the frontmatter value; codex r331 P1)
      const fm = zodResult.data;
      const submitParse = SpecSubmitInput.safeParse({
        spec_version: undefined, // builder defaults to snapshot+1
        feature: fm.feature,
        intent: fm.intent,
        adr_refs: fm.adr_refs,
        requirements: fm.requirements,
        scenarios: fm.scenarios,
        visual_contracts: fm.visual_contracts ?? [],
        needs_clarification: fm.needs_clarification,
      });
      if (!submitParse.success) {
        ctx.emitFailure(
          "SCHEMA_VALIDATION_FAILED",
          `spec.md frontmatter passed SpecFrontmatter but failed SpecSubmitInput shape (unusual cross-schema drift); work copy preserved at ${specMdPath}`,
          { subcode: "zod", path: specMdPath, issues: submitParse.error.issues },
        );
        return;
      }
      // (8) Build batch via shared SC-12a-1 helper + mutate
      const now = new Date().toISOString();
      const entries = buildSpecSubmitBatch({
        input: submitParse.data,
        snapshot: session.snapshot,
        actor,
        now,
      });
      // Match the editor lane's work-copy semantics: a real mutation leaves
      // the supplied body on disk even if downstream admission fails, while a
      // dry-run has no filesystem side effects. Validation above completes
      // before this write, so malformed input never damages the work copy.
      if (hasInput && !ctx.dryRun) {
        await fsP.writeFile(specMdPath, afterContent, "utf8");
      }
      const mutateResult = await mutator.runPreparedBatch(
        featureDir,
        session,
        entries,
        "emit-failure",
      );
      if (!mutateResult) return;
      const newSpecVersion = (entries[0]!.payload as { spec_version: number }).spec_version;
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          spec_version: newSpecVersion,
          sub_state: mutateResult.snapshot.state?.sub_state,
        },
        (i18n) => i18n.t(SUCCESS_KEYS.specEditText, { spec_version: newSpecVersion }) + "\n",
        (i18n) => ({
          stateChange: i18n.t(
            hasInput ? SUCCESS_KEYS.specEditInputStateChange : SUCCESS_KEYS.specEditStateChange,
            { spec_version: newSpecVersion },
          ),
        }),
      );
    });

  for (const cfg of REGISTER_SPEC_ADD) {
    const mutatorKey: MutatorCommand =
      cfg.name === "req"
        ? "spec:add-req"
        : cfg.name === "scenario"
          ? "spec:add-scenario"
          : "spec:add-visual";
    specCmd
      .command(`add-${cfg.name}`)
      .description(
        `Add ${cfg.name} entries via id_namespace stamping (CLI allocates ${cfg.name.toUpperCase()} ids)`,
      )
      .option(
        "--input <src>",
        `JSON source for SpecAdd${cfg.name[0]!.toUpperCase()}${cfg.name.slice(1)}Input (item or array): \`-\` (stdin), inline JSON, or file path (protocol §10.7)`,
      )
      .option("--schema", "Dump the input JSON Schema instead of mutating (Phase 16 SC-10)")
      .option("--feature <name>", `Feature whose spec to extend`)
      .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
      .action(
        async (rawOpts: {
          input?: string;
          schema?: boolean;
          feature: string;
          featureDir?: string;
        }) => {
          // Phase 16 SC-10 — --schema bypass MUST be first (no input read,
          // no session resolve). Pre-parse guard already rejected selectors
          // when --schema is present. Literal labels per cfg.name so the
          // SC-6c static guard can scan ctx.rejectIfDryRun("<label>") strings.
          if (rawOpts.schema === true) {
            let rejected = false;
            if (cfg.name === "req") rejected = ctx.rejectIfDryRun("spec add-req --schema");
            else if (cfg.name === "scenario")
              rejected = ctx.rejectIfDryRun("spec add-scenario --schema");
            else rejected = ctx.rejectIfDryRun("spec add-visual --schema");
            if (rejected) return;
            mutator.emitSchemaAndExit(mutatorKey);
            return;
          }
          if (rawOpts.input === undefined) {
            ctx.emitFailure(
              "MISSING_INPUT",
              `loaf spec add-${cfg.name} requires --input <src> (or pass --schema to dump the input JSON Schema)`,
            );
            return;
          }
          const opts = rawOpts as { input: string; feature: string; featureDir?: string };
          // Phase 16 SC-4a — unified --input modality. TTY no-hang guard
          // per codex r212 PATCH 2 (protocol §10.1:1505) covers the stdin
          // case before any read.
          const source = parseInputSource(opts.input);
          if (source.kind === "stdin" && isStdinTty()) {
            ctx.failure(
              "USAGE",
              `stdin is TTY — \`loaf spec add-${cfg.name} --input -\` expects piped input. ` +
                `Pipe JSON via \`... | loaf spec add-${cfg.name} --input -\`, OR pass ` +
                `inline JSON / file path. Run --help for examples.`,
            );
            return;
          }
          const read = await readJsonInput(source, { readStdin });
          if (!read.ok) {
            ctx.failure(read.code, read.message, read.detail);
            return;
          }
          const parsed = read.value;
          const inputParse = cfg.inputSchema.safeParse(parsed);
          if (!inputParse.success) {
            ctx.failure(
              "SCHEMA_VALIDATION_FAILED",
              `spec add-${cfg.name} input failed schema validation`,
              { issues: inputParse.error.issues },
            );
            return;
          }
          const items: ReadonlyArray<{ id_namespace: string; [k: string]: unknown }> =
            Array.isArray(inputParse.data) ? inputParse.data : [inputParse.data];
          // Load session via ctx (caches; captures sub_state for crash context).
          const featureDir = await ctx.dispatchOrFail(opts);
          if (featureDir === null) return;
          const session = await ctx.resolveSession(featureDir);
          if (!session.snapshot.state) {
            ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
            return;
          }
          // (4) Per-namespace allocator. Track counter across the batch so
          // multiple items in the same invocation share a coherent
          // monotonic sequence per namespace.
          const projection = session.snapshot[cfg.snapshotKey] as ReadonlyArray<{ id: string }>;
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
          const entries: MutatorEntry[] = transformedItems.map(({ id, rest }) => ({
            kind: cfg.entryKind,
            payload: {
              spec_version: targetVersion,
              [cfg.payloadField]: { id, ...rest },
            },
            actor,
          }));
          const result = await mutator.run(featureDir, session, entries, "raw-ctx-failure");
          if (!result) return;
          const specVersion = result.snapshot.state?.spec_version;
          ctx.success(
            {
              ok: true,
              feature: opts.feature,
              spec_version: specVersion,
              ids: allocatedIds,
              sub_state: result.snapshot.state?.sub_state,
            },
            (i18n) =>
              i18n.t(specAddTextKey(cfg.name, allocatedIds.length), {
                spec_version: specVersion,
                ids: allocatedIds.join(", "),
              }) + "\n",
            (i18n) => ({
              stateChange: i18n.t(specAddStateChangeKey(cfg.name, allocatedIds.length), {
                count: allocatedIds.length,
                spec_version: specVersion,
                ids: allocatedIds.join(","),
              }),
            }),
          );
        },
      );
  }

  return { specCmd };
}
