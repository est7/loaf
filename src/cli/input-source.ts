// Phase 16 SC-3 — `--input` source classification (pure).
//
// Protocol §10.7 + ADR-0004 A11 specify three lanes:
//   1. value === "-"           → stdin
//   2. value matches /^[\{\[]/ → inline JSON literal
//   3. else                    → file path
//
// This module ONLY classifies. The companion `readJsonInput()` (in
// input-read.ts) handles IO + JSON parsing + error mapping (codex r206
// PATCH F: classification and reading deliberately separated so neither
// becomes a shallow module).

export type InputSource =
  | { kind: "stdin" }
  | { kind: "inline"; value: string }
  | { kind: "file"; path: string };

const INLINE_RE = /^[{[]/;

export function parseInputSource(arg: string): InputSource {
  if (arg === "-") return { kind: "stdin" };
  if (INLINE_RE.test(arg)) return { kind: "inline", value: arg };
  return { kind: "file", path: arg };
}
