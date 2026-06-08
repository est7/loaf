// Phase 16 SC-12a-2 — production `runEditor` wrapper for `loaf spec edit`.
//
// Spawns the user's $EDITOR on a filepath, waits for exit, returns a
// deterministic RunEditorResult to the CLI for downstream
// validation/mutate.
//
// Design (codex r332 P3 → r336 P1):
//   - $EDITOR tokenized via local shell-style tokenizer that handles
//     single/double quotes, whitespace splits, AND surfaces unmatched
//     quotes as a typed error (no silent fallback)
//   - First token is the executable; remaining tokens are args; filepath
//     is appended as the LAST positional arg
//   - No shell exec — direct child_process.spawn(bin, [...args, filepath])
//     means filepath is safe regardless of whitespace/quotes
//   - Listens for both `error` and `close` events; resolves exactly once
//     via a settled flag (codex r335 P1)
//   - Returns { code, signal, error? } — caller (cli.tsx) maps error to
//     USAGE, signal to exit 130 propagation, code !== 0 to USAGE

import { spawn } from "node:child_process";

export interface RunEditorArgs {
  filePath: string;
  /** Editor command from $EDITOR or fallback "vi". May contain args. */
  editor: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface RunEditorResult {
  /** Editor process exit code. 0 on success; 127 on spawn failure. */
  code: number;
  /** Terminating signal name if process was killed (SIGINT etc.); null on
   *  normal exit or spawn error. */
  signal: string | null;
  /** When spawn() emits `error` (ENOENT / EACCES etc.), carries the
   *  errno code or err.message. CLI maps to USAGE; codex r335 P1. */
  error?: string;
}

export class EditorTokenizeError extends Error {
  readonly code = "EDITOR_TOKENIZE_ERROR" as const;
  constructor(
    message: string,
    readonly editor: string,
  ) {
    super(message);
    this.name = "EditorTokenizeError";
  }
}

/** Shell-style word split with single + double quote grouping. NOT a
 *  full shell parser — does NOT expand $VARS, ~, globs, or backticks.
 *  Filepath is appended by the caller (NOT injected via shell). Codex
 *  r336 P2 lock. */
export function tokenizeEditor(editor: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoteChar: '"' | "'" | null = null;
  let inToken = false;

  for (let i = 0; i < editor.length; i++) {
    const ch = editor[i]!;
    if (quoteChar !== null) {
      if (ch === quoteChar) {
        quoteChar = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch;
      inToken = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quoteChar !== null) {
    throw new EditorTokenizeError(
      `EDITOR has unmatched ${quoteChar === '"' ? "double" : "single"} quote: ${editor}`,
      editor,
    );
  }
  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

/** Production runEditor — spawn the user's editor and resolve with the
 *  outcome. Always resolves; never throws — tokenize errors become
 *  `error: "EDITOR_TOKENIZE_ERROR"` (codex r339 P1), spawn errors
 *  become typed error strings (ENOENT etc.). */
export async function runEditor(args: RunEditorArgs): Promise<RunEditorResult> {
  let tokens: string[];
  try {
    tokens = tokenizeEditor(args.editor);
  } catch (err) {
    // Unmatched quote / tokenizer reject path — surface as a spawn-style
    // failure so the CLI maps it to a single USAGE diagnostic family
    // (matches the spawn `error` event handling below).
    if (err instanceof EditorTokenizeError) {
      return { code: 127, signal: null, error: "EDITOR_TOKENIZE_ERROR" };
    }
    throw err;
  }
  if (tokens.length === 0) {
    // Empty $EDITOR after trim is treated as the spawn-error path so the
    // CLI can surface a USAGE failure. Caller (cli.tsx) already does the
    // `$EDITOR || vi` fallback before invoking; an empty string reaching
    // here means the fallback was explicitly bypassed.
    return { code: 127, signal: null, error: "EDITOR_EMPTY" };
  }
  const [bin, ...rest] = tokens as [string, ...string[]];
  return new Promise<RunEditorResult>((resolve) => {
    let settled = false;
    const finish = (result: RunEditorResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(bin, [...rest, args.filePath], {
      stdio: "inherit",
      cwd: args.cwd,
      env: args.env,
    });
    child.once("error", (err) => {
      finish({
        code: 127,
        signal: null,
        error: (err as NodeJS.ErrnoException).code ?? err.message,
      });
    });
    child.once("close", (code, signal) => {
      finish({ code: code ?? 0, signal: signal ?? null });
    });
  });
}

export type RunEditor = (args: RunEditorArgs) => Promise<RunEditorResult>;
