import { scanArgv } from "../core/argv-scanner.js";

// Existing bootstrap arities; registration metadata replaces this in slice 2.
const BOOTSTRAP_VALUE_FLAGS = new Set([
  "--format",
  "--session",
  "--feature",
  "--feature-dir",
  "--ceremony",
  "--label",
  "--workspace",
]);

/** Preserve the bootstrap's positional view, including its legacy treatment
 * of `--` and unconditional consumption of a value-taking flag's next token.
 */
export function bootstrapCommandTokens(argv: readonly string[], max: number): string[] {
  const out: string[] = [];
  let consumedThrough = 1;
  for (const token of scanArgv(argv, BOOTSTRAP_VALUE_FLAGS)) {
    if (token.index <= consumedThrough) continue;
    if (token.kind === "option") {
      if (token.raw.startsWith("--") && token.arity === 1 && !token.raw.includes("="))
        consumedThrough = token.index + 1;
      continue;
    }
    if (token.kind === "terminator") continue;
    out.push(token.raw);
    if (out.length >= max) break;
  }
  return out;
}
