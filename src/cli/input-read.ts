// Phase 16 SC-3 — `--input` IO + JSON parse + error mapping.
//
// Companion to parseInputSource. Reads from disk/stdin, parses JSON, maps
// failures to catalog DiagnosticCode + detail shape so the caller routes
// through ctx.failure without bespoke error logic.
//
// DI'd for tests: `readStdin` (so tests don't actually read process.stdin)
// + `readFile` default points at node:fs/promises (so production wires
// without ceremony).

import { promises as fs } from "node:fs";

import type { InputSource } from "./input-source.js";

export type ReadJsonInputDeps = {
  readStdin: () => Promise<string>;
  readFile?: (path: string) => Promise<string>;
};

export type ReadJsonInputResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      // Phase 16 SC-4b (codex r224 PATCH 4): MISSING_INPUT extended to
      // cover stdin read failure ("required input source missing or
      // unreadable: --input not provided OR stdin could not be read").
      // Kept distinct from INPUT_FILE_NOT_FOUND (no file) and
      // SCHEMA_VALIDATION_FAILED (no JSON parse attempted on stdin
      // failure).
      code: "INPUT_FILE_NOT_FOUND" | "SCHEMA_VALIDATION_FAILED" | "MISSING_INPUT";
      message: string;
      detail?: Record<string, unknown>;
    };

const DEFAULT_READ_FILE = (p: string): Promise<string> => fs.readFile(p, "utf8");

export async function readJsonInput(
  source: InputSource,
  deps: ReadJsonInputDeps,
): Promise<ReadJsonInputResult> {
  const readFile = deps.readFile ?? DEFAULT_READ_FILE;

  let raw: string;
  switch (source.kind) {
    case "inline":
      raw = source.value;
      break;
    case "stdin": {
      try {
        raw = await deps.readStdin();
      } catch (err) {
        const e = err as Error;
        return {
          ok: false,
          code: "MISSING_INPUT",
          message: `cannot read stdin: ${e.message}`,
          detail: { cause: e.message },
        };
      }
      break;
    }
    case "file": {
      try {
        raw = await readFile(source.path);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
          return {
            ok: false,
            code: "INPUT_FILE_NOT_FOUND",
            message: `input file does not exist: ${source.path}`,
            detail: { path: source.path },
          };
        }
        return {
          ok: false,
          code: "INPUT_FILE_NOT_FOUND",
          message: `input file unreadable: ${source.path} — ${e.message}`,
          detail: { path: source.path, cause: e.message },
        };
      }
      break;
    }
  }

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      code: "SCHEMA_VALIDATION_FAILED",
      message: `invalid JSON: ${(err as Error).message}`,
      detail: { cause: (err as Error).message },
    };
  }
}
