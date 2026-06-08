// ADR-0006 P0 — user-level loaf config.
//
// This module is intentionally pure IO/schema. Locale policy and bundle
// lookup live in src/cli/i18n.ts so stable core never depends on
// presentation language.

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const UserConfig = z
  .object({
    schema_version: z.literal(1),
    locale: z
      .object({
        default_lang: z.enum(["en", "zh"]),
      })
      .strict(),
  })
  .strict();
export type UserConfig = z.infer<typeof UserConfig>;

export type UserConfigLoad =
  | { status: "ok"; config: UserConfig }
  | { status: "absent" }
  | { status: "invalid"; path: string; reason: string };

/** Canonical user-level config path under an injected home directory. */
export function userConfigPath(homeDir: string): string {
  return path.join(homeDir, ".loaf", "config.json");
}

/**
 * Read + strictly validate ~/.loaf/config.json.
 *
 * - file absent (ENOENT)         -> { status: "absent" }
 * - unreadable / malformed / bad -> { status: "invalid" }
 * - valid                        -> { status: "ok", config }
 */
export async function readUserConfig(homeDir: string): Promise<UserConfigLoad> {
  const configPath = userConfigPath(homeDir);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    return {
      status: "invalid",
      path: configPath,
      reason: `cannot read ${configPath}: ${(err as Error).message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      status: "invalid",
      path: configPath,
      reason: `malformed JSON in ${configPath}`,
    };
  }

  const result = UserConfig.safeParse(parsed);
  if (!result.success) {
    return {
      status: "invalid",
      path: configPath,
      reason: `schema validation failed for ${configPath}`,
    };
  }
  return { status: "ok", config: result.data };
}
