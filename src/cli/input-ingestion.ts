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

export function createJsonInputIngestor(deps: JsonInputIngestorDeps): JsonInputIngestor {
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFile(filePath, "utf8"));
  const requireArg = (
    ctx: CommandContext,
    arg: string | undefined,
    declaration: JsonInputDeclaration,
  ): arg is string => {
    if (arg !== undefined) return true;
    ctx.diagnosticFailure({ code: "MISSING_INPUT", detail: { command: declaration.command } });
    return false;
  };

  return {
    requireArg,
    async readJson(ctx, arg, declaration): Promise<JsonInputResult> {
      if (!requireArg(ctx, arg, declaration)) return { ok: false };

      const source = parseInputSource(arg);
      if (source.kind === "stdin" && deps.isStdinTty()) {
        ctx.diagnosticFailure({
          code: "USAGE",
          detail: { command: declaration.command, source: "stdin", reason: "stdin_is_tty" },
        });
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
          ctx.diagnosticFailure({
            code: "MISSING_INPUT",
            detail: { command: declaration.command, source: "stdin", cause: message },
          });
          return { ok: false };
        }
      } else {
        try {
          raw = await readFile(source.path);
        } catch (error) {
          const cause = error as NodeJS.ErrnoException;
          ctx.diagnosticFailure({
            code: "INPUT_FILE_NOT_FOUND",
            detail: {
              path: source.path,
              ...(cause.code === "ENOENT" ? {} : { cause: cause.message }),
            },
          });
          return { ok: false };
        }
      }

      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch (error) {
        const cause = (error as Error).message;
        ctx.diagnosticFailure({
          code: "SCHEMA_VALIDATION_FAILED",
          detail: { reason: cause, command: declaration.command, cause },
        });
        return { ok: false };
      }
    },
  };
}
