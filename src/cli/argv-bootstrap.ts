import { scanArgv } from "../core/argv-scanner.js";

/** Bootstrap positional view: tokens after `--` are literal operands.
 * Retain pre-boundary consumption of a value-taking flag's next token.
 */
export function bootstrapCommandTokens(
  argv: readonly string[],
  max: number,
  valueFlags: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  let consumedThrough = 1;
  let positionalOnly = false;
  for (const token of scanArgv(argv, valueFlags)) {
    if (!positionalOnly && token.kind === "terminator") {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly) {
      out.push(token.raw);
      if (out.length >= max) break;
      continue;
    }
    if (token.index <= consumedThrough) continue;
    if (token.kind === "option") {
      if (token.raw.startsWith("--") && token.arity === 1 && !token.raw.includes("="))
        consumedThrough = token.index + 1;
      continue;
    }
    out.push(token.raw);
    if (out.length >= max) break;
  }
  return out;
}
