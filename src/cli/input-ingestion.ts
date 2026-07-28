// Canonical CLI JSON input boundary.
//
// This module owns source classification, TTY/no-input policy, stdin/file
// reads, JSON parsing, and presentation routing. Command families retain
// ownership of their domain schemas and shape-specific validation.

import { promises as fs } from "node:fs";
import { z } from "zod";

import type { CommandContext } from "./command-context.js";

export const InputSourceResolver = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stdin") }),
  z.object({ kind: z.literal("inline"), value: z.string() }),
  z.object({ kind: z.literal("file"), path: z.string() }),
]);
export type InputSource = z.infer<typeof InputSourceResolver>;

export type InputFailureRoute = "failure" | "emit-failure";

export type JsonInputDeclaration = Readonly<{
  /** Command label without the `--input -` suffix, for diagnostics. */
  command: string;
  /** Help prefix before the canonical source list. */
  helpPrefix: string;
  /** Wording for the inline lane, usually `inline JSON` or `inline JSON literal`. */
  inlineLabel: string;
  /** Optional text appended after `file path`. */
  helpSuffix?: string;
  /** Compatibility escape hatch for a legacy help sentence. */
  helpText?: string;
  /** Existing command-specific wording: `piped input` or `piped JSON`. */
  stdinExpectation: "piped input" | "piped JSON";
  /** Optional exact compatibility text for commands with a specialized pipe example. */
  ttyMessage?: string;
  /** Required only when the command makes `--input` optional for `--schema` or another lane. */
  missing?: Readonly<{
    message: string;
    route: InputFailureRoute;
  }>;
}>;

export type JsonInputResult = { ok: true; value: unknown } | { ok: false };

export type JsonInputIngestor = {
  requireArg: (
    ctx: CommandContext,
    arg: string | undefined,
    declaration: JsonInputDeclaration,
  ) => arg is string;
  readJson: (
    ctx: CommandContext,
    arg: string | undefined,
    declaration: JsonInputDeclaration,
  ) => Promise<JsonInputResult>;
};

export type JsonInputIngestorDeps = {
  readStdin: () => Promise<string>;
  isStdinTty: () => boolean;
  readFile?: (path: string) => Promise<string>;
};

const INLINE_RE = /^[{[]/;

export function parseInputSource(arg: string): InputSource {
  if (arg === "-") return { kind: "stdin" };
  if (INLINE_RE.test(arg)) return { kind: "inline", value: arg };
  return { kind: "file", path: arg };
}

export function jsonInputHelp(declaration: JsonInputDeclaration): string {
  if (declaration.helpText !== undefined) return declaration.helpText;
  return `${declaration.helpPrefix}: \`-\` (stdin), ${declaration.inlineLabel}, or file path${declaration.helpSuffix ?? ""}`;
}

function emitFailure(
  ctx: CommandContext,
  route: InputFailureRoute,
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): void {
  if (route === "emit-failure") ctx.emitFailure(code, message, detail);
  else ctx.failure(code, message, detail);
}

export function createJsonInputIngestor(deps: JsonInputIngestorDeps): JsonInputIngestor {
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFile(filePath, "utf8"));
  const requireArg = (
    ctx: CommandContext,
    arg: string | undefined,
    declaration: JsonInputDeclaration,
  ): arg is string => {
    if (arg !== undefined) return true;
    const missing = declaration.missing ?? {
      message: `${declaration.command} requires --input <src>`,
      route: "failure" as const,
    };
    emitFailure(ctx, missing.route, "MISSING_INPUT", missing.message);
    return false;
  };

  return {
    requireArg,
    async readJson(ctx, arg, declaration): Promise<JsonInputResult> {
      if (!requireArg(ctx, arg, declaration)) return { ok: false };

      const source = parseInputSource(arg);
      if (source.kind === "stdin" && deps.isStdinTty()) {
        ctx.failure(
          "USAGE",
          declaration.ttyMessage ??
            `stdin is TTY — \`${declaration.command} --input -\` expects ${declaration.stdinExpectation}. ` +
              `Pipe JSON via \`... | ${declaration.command} --input -\`, OR pass inline ` +
              "JSON / file path. Run --help for examples.",
        );
        return { ok: false };
      }

      let raw: string;
      if (source.kind === "inline") {
        raw = source.value;
      } else if (source.kind === "stdin") {
        try {
          raw = await deps.readStdin();
        } catch (error) {
          const message = (error as Error).message;
          ctx.failure("MISSING_INPUT", `cannot read stdin: ${message}`, { cause: message });
          return { ok: false };
        }
      } else {
        try {
          raw = await readFile(source.path);
        } catch (error) {
          const cause = error as NodeJS.ErrnoException;
          if (cause.code === "ENOENT") {
            ctx.failure("INPUT_FILE_NOT_FOUND", `input file does not exist: ${source.path}`, {
              path: source.path,
            });
          } else {
            ctx.failure(
              "INPUT_FILE_NOT_FOUND",
              `input file unreadable: ${source.path} — ${cause.message}`,
              { path: source.path, cause: cause.message },
            );
          }
          return { ok: false };
        }
      }

      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch (error) {
        const cause = (error as Error).message;
        ctx.failure("SCHEMA_VALIDATION_FAILED", `invalid JSON: ${cause}`, { cause });
        return { ok: false };
      }
    },
  };
}
