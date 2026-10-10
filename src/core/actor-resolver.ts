import type { Diagnostic } from "./error-catalog.js";
// actor-resolver — pure policy module for human:* actor resolution.
//
// Resolution order: $LOAF_USER → git config user.email (when interactive) → fail.
// Strict input: explicit LOAF_USER="" is INVALID; unset falls through to git.
// CI safety: refuse to auto-derive from git in non-interactive contexts.
// Format validation reuses ActorString (no duplicated regex). Reserved namespace
// prefixes (human/skill/ci/cli/migration) are rejected as input to prevent
// double-prefix actors.

import { ActorString } from "./journal-entry.js";

export interface ResolverDeps {
  /** Process env. Tests pass synthetic envs; runtime passes process.env. */
  env: Record<string, string | undefined>;
  /** Returns git config user.email (or null when unavailable). May throw — caller treats throw as null. */
  readGitConfig: () => string | null;
  /**
   * True when a human is interactively driving this process. Gates the git
   * fallback path; stdout-only TTY checks would false-positive on stdout
   * pipelines (`loaf status | head`) where the user is still present. Runtime
   * should source this from `process.stdin.isTTY` or a controlling-terminal
   * check, NOT `process.stdout.isTTY`.
   */
  isInteractiveHuman: boolean;
}

export type ResolverFailureCode = "NO_HUMAN_ACTOR" | "INVALID_ACTOR_FORMAT";

export type ResolverResult =
  | { ok: true; actor: string }
  | ({ ok: false } & Diagnostic<ResolverFailureCode>);

const NAMESPACE_PREFIXES = ["human:", "skill:", "ci:", "cli:", "migration:"];

function buildHumanActor(rawValue: string): ResolverResult {
  if (rawValue.length === 0) {
    return {
      ok: false,
      code: "INVALID_ACTOR_FORMAT",
      detail: { reason: "empty", value: rawValue },
    };
  }
  if (rawValue.trim().length === 0) {
    return {
      ok: false,
      code: "INVALID_ACTOR_FORMAT",
      detail: { reason: "all_whitespace", value: rawValue },
    };
  }
  if (rawValue !== rawValue.trim()) {
    return {
      ok: false,
      code: "INVALID_ACTOR_FORMAT",
      detail: { reason: "leading_or_trailing_whitespace", value: rawValue },
    };
  }
  if (NAMESPACE_PREFIXES.some((p) => rawValue.startsWith(p))) {
    return {
      ok: false,
      code: "INVALID_ACTOR_FORMAT",
      detail: { reason: "reserved_namespace", value: rawValue },
    };
  }
  const candidate = `human:${rawValue}`;
  if (!ActorString.safeParse(candidate).success) {
    return {
      ok: false,
      code: "INVALID_ACTOR_FORMAT",
      detail: { reason: "actor_schema_invalid", value: rawValue },
    };
  }
  return { ok: true, actor: candidate };
}

export function resolveHumanActor(deps: ResolverDeps): ResolverResult {
  const envValue = deps.env.LOAF_USER;
  if (envValue !== undefined) {
    return buildHumanActor(envValue);
  }
  if (!deps.isInteractiveHuman) {
    return {
      ok: false,
      code: "NO_HUMAN_ACTOR",
      detail: { reason: "non_interactive" },
    };
  }
  let gitEmail: string | null = null;
  try {
    gitEmail = deps.readGitConfig();
  } catch {
    gitEmail = null;
  }
  if (gitEmail === null || gitEmail.length === 0) {
    return {
      ok: false,
      code: "NO_HUMAN_ACTOR",
      detail: { reason: "git_identity_unavailable" },
    };
  }
  return buildHumanActor(gitEmail);
}
