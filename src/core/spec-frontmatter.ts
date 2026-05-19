// spec.md frontmatter reader — disk I/O boundary for the spec-lock gate.
//
// Reads `<featureDir>/spec.md`, extracts the YAML frontmatter block between
// `---` fences, parses with the `yaml` package (cross-runtime: works under
// both Bun production and vitest/Node test runner; Bun.YAML alone would
// crash inside vitest where Bun globals are not defined), validates
// against the SpecFrontmatter zod (uses the structural RequirementEarsShape;
// missing verifiability is NOT a parse error here — it's reachable as
// spec-lock check 5 / MISSING_VERIFIABILITY).
//
// Three failure subcodes are preserved on ReadSpecResult so the eventual
// gate-result mapping (sub-cycle 3 mutateBatch wire) can carry the precise
// reason in `detail.subcode`:
//   - SPEC_NOT_FOUND        — spec.md missing
//   - SPEC_YAML_INVALID     — frontmatter block missing/malformed or YAML syntax error
//   - SPEC_FRONTMATTER_INVALID — frontmatter parsed but fails SpecFrontmatter zod
//
// codex r20 GO v2: ReadSpecResult preserves its own code; caller maps to
// gate-result check 1 with detail.subcode if/when sub-cycle 3 needs that.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { SpecFrontmatter } from "./spec-schema.js";
import type { SpecFrontmatter as SpecFrontmatterType } from "./spec-schema.js";

export type ReadSpecFailureCode =
  | "SPEC_NOT_FOUND"
  | "SPEC_YAML_INVALID"
  | "SPEC_FRONTMATTER_INVALID";

export type ReadSpecResult =
  | { ok: true; frontmatter: SpecFrontmatterType }
  | {
      ok: false;
      code: ReadSpecFailureCode;
      message: string;
      detail?: Record<string, unknown>;
    };

// Frontmatter block must be the first non-empty content. Opening `---`
// on its own line (with optional trailing whitespace), then any number of
// lines until a closing `---` on its own line. Tolerates LF or CRLF.
//
// Shared with the SC-A2 projection writer (composeSpecMdFrontmatter /
// writeDerivedSpecMd) via splitFrontmatter() — reader and writer MUST
// agree on the fence grammar (codex r90).
export const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

/**
 * Splits a spec.md raw string into (frontmatter_yaml, body) using the
 * shared FRONTMATTER_RE grammar. `body` is everything AFTER the closing
 * `---\n` (preserves trailing content verbatim). If no frontmatter block
 * is present, frontmatter is null and body is the whole input.
 *
 * Symmetric companion to readSpecFrontmatter() that returns ONLY the
 * structural split — caller validates YAML / SpecFrontmatter separately.
 */
export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { frontmatter: null, body: raw };
  // match[0] is the entire matched fence block; everything AFTER is body.
  const body = raw.slice(match[0].length);
  return { frontmatter: match[1]!, body };
}

export async function readSpecFrontmatter(featureDir: string): Promise<ReadSpecResult> {
  const specPath = path.join(featureDir, "spec.md");

  let raw: string;
  try {
    raw = await fs.readFile(specPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: false,
        code: "SPEC_NOT_FOUND",
        message: `spec.md not found at ${specPath}`,
        detail: { path: specPath },
      };
    }
    throw err;
  }

  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return {
      ok: false,
      code: "SPEC_YAML_INVALID",
      message: "spec.md is missing a YAML frontmatter block fenced by `---` on the first line",
      detail: { path: specPath },
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]!);
  } catch (err) {
    return {
      ok: false,
      code: "SPEC_YAML_INVALID",
      message: `spec.md frontmatter YAML failed to parse: ${(err as Error).message}`,
      detail: { path: specPath, error: (err as Error).message },
    };
  }

  const validated = SpecFrontmatter.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      code: "SPEC_FRONTMATTER_INVALID",
      message: "spec.md frontmatter failed SpecFrontmatter schema validation",
      detail: { path: specPath, issues: validated.error.issues },
    };
  }

  return { ok: true, frontmatter: validated.data };
}
