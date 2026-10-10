import { scanArgv } from "../core/argv-scanner.js";

/** Preserve the bootstrap's positional view, including its legacy treatment
 * of `--` and unconditional consumption of a value-taking flag's next token.
 */
export function bootstrapCommandTokens(
  argv: readonly string[],
  max: number,
  valueFlags: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  let consumedThrough = 1;
  for (const token of scanArgv(argv, valueFlags)) {
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
