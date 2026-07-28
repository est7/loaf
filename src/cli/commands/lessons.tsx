import type { Command } from "commander";
import type { CommandContext } from "../command-context.js";
import type { CommandMutator } from "../command-mutator.js";
import { FAILURE_SITE_KEYS, SUCCESS_KEYS } from "../runtime-i18n-keys.js";
import { loadSession } from "../../core/cli-runtime.js";
import { allocateNextLessonId } from "../lesson-id-allocator.js";
import { buildLessonRecordedPayload } from "../lessons-add.js";
import { promises as fsPromises } from "node:fs";
import {
  buildNextAdvisoryFromSnapshot,
  selectorForCommandContext,
} from "../next-advisory.js";

export function registerLessons(
  program: Command,
  ctx: CommandContext,
  mutator: CommandMutator,
  _actor: string,
): void {
  // ── loaf lessons add ────────────────────────────────────────────────
  // Records an independent `lesson:recorded` entry. Human authority lives
  // on the envelope; the payload carries the LSN id and lesson content.
  // Every mutate rebuilds `.loaf/<feature>/lessons.md` from new and legacy
  // lesson entries through the single compatibility selector.
  // LongTextField sidecar promotion fires when lesson body bytes >
  // SIDECAR_THRESHOLD_BYTES (Pass 2 sidecar promote); the lessons.md
  // writer resolves those sidecars back inline.
  const lessonsCmd = program
    .command("lessons")
    .description("Lessons-learned journal commands");

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
    .option("--feature-dir <path>", "Override default .loaf/<feature> directory")
    .action(
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
          ctx.failureKeyed(
            "USAGE",
            FAILURE_SITE_KEYS.lessonsTextFileMutex,
            { provided_state: hasText ? "both provided" : "neither provided" },
            { text_provided: hasText, file_provided: hasFile },
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
              ctx.failureKeyed(
                "INPUT_FILE_NOT_FOUND",
                FAILURE_SITE_KEYS.lessonsFileMissing,
                { path: opts.file! },
                { path: opts.file! },
              );
              return;
            }
            throw err;
          }
        }
        if (lessonText.length < 3) {
          ctx.failureKeyed(
            "USAGE",
            FAILURE_SITE_KEYS.lessonsTextTooShort,
            { min_length: 3, lesson_text_length: lessonText.length },
            { min_length: 3, lesson_text_length: lessonText.length },
          );
          return;
        }
        if (opts.reason.length < 10) {
          ctx.failureKeyed(
            "USAGE",
            FAILURE_SITE_KEYS.lessonsReasonTooShort,
            { min_length: 10, reason_length: opts.reason.length },
            { min_length: 10, reason_length: opts.reason.length },
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
          ctx.emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
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
            const next = buildNextAdvisoryFromSnapshot(
              i18n,
              result.snapshot,
              featureDir,
              selector,
            );
            return {
              stateChange: i18n.t(SUCCESS_KEYS.lessonsAddStateChange, { lesson_id: lessonId }),
              ...(next === undefined ? {} : { next }),
            };
          },
        );
      },
    );
}
