// Phase 16 SC-15c — loaf.config.json loader for the write-guard hook.
//
// Canonical config path is `<repoRoot>/.loaf/.config/loaf.config.json`
// (project-level, NOT per-feature; codex Q2 lock). loaf.config carries more
// than write-guard needs (commands / constitution / locale) — those are
// loaf-skill's concern. This module mirrors and STRICTLY validates only the
// write-guard-relevant slice (protected_files + stable_core + paths); Zod's
// default object behavior ignores the other top-level sections.
//
// Fail-closed contract (codex Q2 lock): absent config = no overlay; a
// present-but-invalid config (malformed JSON / wrong-typed write-guard
// fields / unreadable) is a STRICT failure — write-guard must refuse to
// authorize under an untrusted config, never silently allow.

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

// Mirror of docs/schemas.ts:LoafConfig.paths (§21). Defaults match the
// canonical schema so an omitted key behaves identically to docs semantics
// (and the defaults overlap the built-in step globs, so they widen nothing
// new). public_api / schema / security default empty — dormant in v0.1.0.
export const WriteGuardConfigPaths = z.object({
  source: z.array(z.string()).default(["src/**"]),
  tests: z.array(z.string()).default(["**/test/**", "tests/**"]),
  docs: z.array(z.string()).default(["docs/**", "**/*.md"]),
  ui: z.array(z.string()).default([]),
  public_api: z.array(z.string()).default([]),
  schema: z.array(z.string()).default([]),
  security: z.array(z.string()).default([]),
});
export type WriteGuardConfigPaths = z.infer<typeof WriteGuardConfigPaths>;

// Write-guard-relevant slice. NOT .strict() at the top level — the real
// config file also carries commands / constitution / locale, which Zod's
// default object parse silently strips (they are not write-guard's concern).
export const WriteGuardConfig = z.object({
  schema_version: z.literal(2),
  protected_files: z.array(z.string()).default([]),
  stable_core: z.array(z.string()).default([]),
  paths: WriteGuardConfigPaths.prefault({}),
});
export type WriteGuardConfig = z.infer<typeof WriteGuardConfig>;

export type LoafConfigLoad =
  | { status: "ok"; config: WriteGuardConfig }
  | { status: "absent" }
  | { status: "invalid"; reason: string };

/** Canonical project-level config path under a repo root. */
export function loafConfigPath(repoRoot: string): string {
  return path.join(repoRoot, ".loaf", ".config", "loaf.config.json");
}

/**
 * Read + validate the write-guard slice of loaf.config.json.
 *
 * - file absent (ENOENT)           → { status: "absent" }   (no overlay)
 * - unreadable / malformed / bad   → { status: "invalid" }  (fail closed)
 * - valid                          → { status: "ok", config }
 *
 * The caller (write-guard) treats "invalid" as a hard exit-2: an untrusted
 * config must never silently relax the write boundary.
 */
export async function readLoafConfig(repoRoot: string): Promise<LoafConfigLoad> {
  const configPath = loafConfigPath(repoRoot);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    return { status: "invalid", reason: `cannot read ${configPath}: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "invalid", reason: `malformed JSON in ${configPath}` };
  }
  const result = WriteGuardConfig.safeParse(parsed);
  if (!result.success) {
    return { status: "invalid", reason: `schema validation failed for ${configPath}` };
  }
  return { status: "ok", config: result.data };
}
