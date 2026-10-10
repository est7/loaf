import { scanArgv, optionArgv } from "../core/argv-scanner.js";
// Shared argv/env selector detection (presentation layer).
//
// Extracted from cli.tsx so command-family files (e.g. board) can reuse it
// without importing back from cli.tsx — that would form a cycle, since cli.tsx
// imports the family `registerX` functions. Pure: (argv, env) → present
// selector tokens. Used by the pre-parse "X does not accept selectors" guards
// (sessions list / tui / board) which walk the whole registry.

export function collectPresentSelectors(argv: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const selectors: string[] = [];
  const tokens = scanArgv(optionArgv(argv));
  if (tokens.some((token) => token.kind === "option" && token.flag === "--session")) {
    selectors.push("--session");
  }
  if (tokens.some((token) => token.kind === "option" && token.flag === "--feature")) {
    selectors.push("--feature");
  }
  if (tokens.some((token) => token.kind === "option" && token.flag === "--feature-dir")) {
    selectors.push("--feature-dir");
  }
  if (env["LOAF_SESSION"] !== undefined && env["LOAF_SESSION"].length > 0) {
    selectors.push("$LOAF_SESSION");
  }
  if (env["LOAF_FEATURE"] !== undefined && env["LOAF_FEATURE"].length > 0) {
    selectors.push("$LOAF_FEATURE");
  }
  return selectors;
}
