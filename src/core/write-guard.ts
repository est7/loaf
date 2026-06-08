// Phase 16 SC-15c — pure write-guard decision + hook stdin parse.
//
// PURE (no IO): the cli.tsx handler resolves the session, loads the tasks
// projection + config, assembles the built-in glob set + active categories,
// then calls evaluateWritePath. Keeping the decision pure makes the security
// boundary (incl. the category-isolation negative cases) exhaustively unit-
// testable without on-disk fixtures.

import path from "node:path";
import picomatch from "picomatch";
import { z } from "zod";

import type { WriteGuardConfig } from "./loaf-config.js";
import type { WriteCategory } from "./step-write-paths.js";

// picomatch options: `dot:true` so `.loaf/**` and other dot-prefixed repo
// paths match (default picomatch excludes dotfiles).
const MATCH_OPTS = { dot: true } as const;

function substituteFeature(glob: string, feature: string): string {
  return glob.replace(/<feature>/g, feature);
}

/** Normalize a target path to a repo-root-relative POSIX path. */
export function normalizeToRepoRoot(targetPath: string, repoRoot: string): string {
  const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(repoRoot, targetPath);
  const rel = path.relative(repoRoot, abs);
  return rel.split(path.sep).join("/");
}

function anyMatch(normalized: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return false;
  return picomatch(globs as string[], MATCH_OPTS)(normalized);
}

function firstMatch(normalized: string, globs: readonly string[]): string | null {
  for (const g of globs) {
    if (picomatch(g, MATCH_OPTS)(normalized)) return g;
  }
  return null;
}

export interface WritePathDecisionInput {
  /** Raw path from `--path` or the parsed hook stdin `tool_input.file_path`. */
  targetPath: string;
  repoRoot: string;
  feature: string;
  subState: string;
  /**
   * Built-in write globs = SUB_STATE_CONTRACTS[sub_state].write_paths ∪
   * (per active in_progress task) STEP_WRITE_PATHS_BY_KIND[kind][runningStep]
   * ∪ VERIFY_CHECK_WRITE_PATHS[check]. May contain `<feature>` placeholders.
   */
  builtinGlobs: readonly string[];
  /**
   * Config-widenable semantic categories active for the current step set
   * (union across active tasks/checks). Only `config.paths[cat]` for these
   * categories widens the allow-set — NEVER a global union.
   */
  activeCategories: readonly WriteCategory[];
  config: WriteGuardConfig | null;
}

export type WritePathDecision =
  | { allowed: true; normalizedPath: string }
  | {
      allowed: false;
      code: "PROTECTED_FILE_WRITE";
      normalizedPath: string;
      matchedDeny: string;
    }
  | {
      allowed: false;
      code: "WRITE_PATH_VIOLATION";
      normalizedPath: string;
      allowSet: string[];
    };

/**
 * Decide whether `targetPath` may be written in the current sub_state +
 * active task/step context.
 *
 * Order (codex Q1/Q7 lock):
 *   1. normalize to repo-root-relative POSIX path
 *   2. protected_files HARD-DENY (config) — wins over any allow
 *   3. allow-set = built-in globs (<feature>-substituted) ∪ config.paths[cat]
 *      for cat ∈ activeCategories only (category-aware widening, NOT a flat
 *      union — `paths.tests` cannot authorize a source write in implement)
 *   4. match → allowed; else WRITE_PATH_VIOLATION
 */
export function evaluateWritePath(input: WritePathDecisionInput): WritePathDecision {
  const normalized = normalizeToRepoRoot(input.targetPath, input.repoRoot);

  // 2. protected_files hard-deny (after normalization, before allow).
  if (input.config) {
    const denyGlobs = input.config.protected_files.map((g) => substituteFeature(g, input.feature));
    const matchedDeny = firstMatch(normalized, denyGlobs);
    if (matchedDeny !== null) {
      return {
        allowed: false,
        code: "PROTECTED_FILE_WRITE",
        normalizedPath: normalized,
        matchedDeny,
      };
    }
  }

  // 3. allow-set = built-in ∪ category-widened config paths.
  const allowSet: string[] = input.builtinGlobs.map((g) => substituteFeature(g, input.feature));
  if (input.config) {
    for (const cat of input.activeCategories) {
      for (const g of input.config.paths[cat]) {
        allowSet.push(substituteFeature(g, input.feature));
      }
    }
  }

  // 4. decide.
  if (anyMatch(normalized, allowSet)) {
    return { allowed: true, normalizedPath: normalized };
  }
  return { allowed: false, code: "WRITE_PATH_VIOLATION", normalizedPath: normalized, allowSet };
}

// ── Claude Code hook stdin envelope ──────────────────────────────────────
//
// PreToolUse/PostToolUse hooks receive a JSON payload on stdin with the
// tool call shape; write-guard needs `tool_input.file_path`. Non-strict at
// the top level (CC also passes session_id / tool_name / cwd etc.).
export const HookToolInputEnvelope = z.object({
  tool_input: z.object({
    file_path: z.string().min(1),
  }),
});

export type HookStdinParse = { ok: true; path: string } | { ok: false; reason: string };

/** Parse `tool_input.file_path` from a Claude Code hook stdin JSON payload. */
export function parseHookStdinPath(raw: string): HookStdinParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "hook stdin is not valid JSON" };
  }
  const result = HookToolInputEnvelope.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: "hook stdin JSON missing non-empty tool_input.file_path" };
  }
  return { ok: true, path: result.data.tool_input.file_path };
}
