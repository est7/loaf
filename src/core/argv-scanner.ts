/** Lexical argv records. Consumers own value consumption and terminator semantics. */
export type ArgvToken =
  | { kind: "positional" | "terminator"; index: number; raw: string }
  | {
      kind: "option";
      index: number;
      raw: string;
      flag: string;
      arity: 0 | 1;
      value: string | undefined;
      valueIndex: number | undefined;
    };

/** Keep every raw token, including option-looking values and duplicates.
 * No command recognition, validation, alias expansion or shell parsing occurs.
 */
export function scanArgv(
  argv: readonly string[],
  valueFlags: ReadonlySet<string> = new Set(),
): ArgvToken[] {
  return argv.map((raw, index) => {
    if (raw === "--") return { kind: "terminator", index, raw };
    if (!raw.startsWith("-") || raw === "-") return { kind: "positional", index, raw };
    const equals = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    const arity = equals !== -1 || valueFlags.has(flag) ? 1 : 0;
    return {
      kind: "option",
      index,
      raw,
      flag,
      arity,
      value: equals !== -1 ? raw.slice(equals + 1) : arity === 1 ? argv[index + 1] : undefined,
      valueIndex:
        equals !== -1 ? index : arity === 1 && index + 1 < argv.length ? index + 1 : undefined,
    };
  });
}
