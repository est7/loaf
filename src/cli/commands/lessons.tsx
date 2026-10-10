import { declareCommandPolicy } from "../command-policy.js";
import { diagnosticVariant } from "../../core/error-catalog.js";
import type { Command } from "commander";
import type { CommandContext } from "../command-context.js";
import type { CommandMutator } from "../command-mutator.js";
import { SUCCESS_KEYS } from "../runtime-i18n-keys.js";
import { loadSession } from "../../core/cli-runtime.js";
import { allocateNextLessonId } from "../lesson-id-allocator.js";
import { buildLessonRecordedPayload } from "../lessons-add.js";
import { promises as fsPromises } from "node:fs";
import { buildNextAdvisoryFromSnapshot, selectorForCommandContext } from "../next-advisory.js";

export function registerLessons(
  program: Command,
  ctx: CommandContext,
  mutator: CommandMutator,
  _actor: string,
): void {
  // ── loaf lessons add ────────────────────────────────────────────────
  // Records an independent `lesson:recorded` entry. Human authority lives
  // on the envelope; the payload carries the LSN id and lesson content.
  // Every mutate rebuilds `.loaf/<feature>/lessons.md` exclusively from
  // lesson:recorded entries through the dedicated lesson selector.
  // LongTextField sidecar promotion fires when lesson body bytes >
  // SIDECAR_THRESHOLD_BYTES (Pass 2 sidecar promote); the lessons.md
  // writer resolves those sidecars back inline.
  const lessonsCmd = program.command("lessons").description("Lessons-learned journal commands");

  declareCommandPolicy(
    lessonsCmd
      .command("add")
      .description("Record a lesson entry (--text inline OR --file <path>)")
      .option("--text <inline>", "Lesson body text (inline). Mutex with --file.")
      .option("--file <path>", "Read lesson body from file. Mutex with --text.")
      .requiredOption(
        "--reason <text>",
        "Why this lesson matters (≥10 chars; mandatory per evidence schema refine)",
      )
      .option("--feature <name>", "Feature whose ledger to append to")
      .option("--feature-dir <path>", "Override default .loaf/<feature> directory"),
    { selectors: "selected", dryRun: "mutating" },
  ).action(
    async (opts: {
      text?: string;
      file?: string;
      reason: string;
      feature: string;
      featureDir?: string;
    }) => {
      // (1) --text / --file mutex (codex r322 P1 lock)
      const hasText = opts.text !== undefined;
      const hasFile = opts.file !== undefined;
      if (hasText === hasFile) {
        ctx.failure(
          diagnosticVariant("failure.lessons.text_file_mutex", {
            ...{ provided_state: hasText ? "both provided" : "neither provided" },
            ...{ text_provided: hasText, file_provided: hasFile },
          }),
        );
        return;
      }
      // (2) Read lesson body
      let lessonText: string;
      if (hasText) lessonText = opts.text!;
      else {
        try {
          lessonText = await fsPromises.readFile(opts.file!, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            ctx.failure(
              diagnosticVariant("failure.lessons.file_missing", {
                ...{ path: opts.file! },
                ...{ path: opts.file! },
              }),
            );
            return;
          }
          throw err;
        }
      }
      if (lessonText.length < 3) {
        ctx.failure(
          diagnosticVariant("failure.lessons.text_too_short", {
            ...{ min_length: 3, lesson_text_length: lessonText.length },
            ...{ min_length: 3, lesson_text_length: lessonText.length },
          }),
        );
        return;
      }
      if (opts.reason.length < 10) {
        ctx.failure(
          diagnosticVariant("failure.lessons.reason_too_short", {
            ...{ min_length: 10, reason_length: opts.reason.length },
            ...{ min_length: 10, reason_length: opts.reason.length },
          }),
        );
        return;
      }
      // (3) resolve human actor (lesson:recorded is HUMAN_ONLY)
      const actor = ctx.resolveHumanActorOrFail();
      if (actor === null) return;
      const featureDir = await ctx.dispatchOrFail(opts);
      if (featureDir === null) return;
      const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
      if (!session.snapshot.state) {
        ctx.failure(
          diagnosticVariant("failure.no_session.generic", { ...{}, feature: opts.feature }),
        );
        return;
      }
      // (5) allocate LSN-id from canonical entries + build payload
      const lessonId = allocateNextLessonId(session.entries);
      const payload = buildLessonRecordedPayload({
        lessonId,
        lessonText,
        reason: opts.reason,
        iteration: session.snapshot.state.iteration,
      });
      const result = await mutator.run(featureDir, session, {
        kind: "lesson:recorded",
        payload,
        actor,
      });
      if (!result) return;
      const selector = await selectorForCommandContext(ctx);
      // v0.1.1 (F-024): the lessons.md projection writer landed — every
      // mutate rebuilds `.loaf/<feature>/lessons.md` from the lesson
      // entries (writeProjections), so the advisory now states it was
      // updated. (Was: "projection writer deferred" through v0.1.0.)
      ctx.success(
        {
          ok: true,
          feature: opts.feature,
          id: lessonId,
          kind: "lesson:recorded" as const,
        },
        () => `${lessonId}\n`,
        (i18n) => {
          const next = buildNextAdvisoryFromSnapshot(i18n, result.snapshot, featureDir, selector);
          return {
            stateChange: i18n.t(SUCCESS_KEYS.lessonsAddStateChange, { lesson_id: lessonId }),
            ...(next === undefined ? {} : { next }),
          };
        },
      );
    },
  );
}
