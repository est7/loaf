// ADR-0006 P0 — user-level loaf config.
//
// User config is pure IO/schema. Locale resolution policy lives in
// src/cli/i18n.ts, not here.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { readUserConfig, userConfigPath, UserConfig } from "../../src/core/user-config.js";

async function tmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-user-config-"));
}

async function writeUserConfig(homeDir: string, body: unknown): Promise<void> {
  const p = userConfigPath(homeDir);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

describe("ADR-0006 P0 — readUserConfig", () => {
  test("path is ~/.loaf/config.json under injected home", async () => {
    const homeDir = await tmpHome();
    expect(userConfigPath(homeDir)).toBe(path.join(homeDir, ".loaf", "config.json"));
  });

  test("absent config → status:absent", async () => {
    const homeDir = await tmpHome();
    expect(await readUserConfig(homeDir)).toEqual({ status: "absent" });
  });

  test("valid config → status:ok with locale.default_lang", async () => {
    const homeDir = await tmpHome();
    await writeUserConfig(homeDir, {
      schema_version: 1,
      locale: { default_lang: "zh" },
    });

    expect(await readUserConfig(homeDir)).toEqual({
      status: "ok",
      config: {
        schema_version: 1,
        locale: { default_lang: "zh" },
      },
    });
  });

  test("schema is strict and does not allow global config expansion in P0", async () => {
    const result = UserConfig.safeParse({
      schema_version: 1,
      locale: { default_lang: "en" },
      commands: { run: ["bun test"] },
    });

    expect(result.success).toBe(false);
  });

  test("invalid locale value → status:invalid", async () => {
    const homeDir = await tmpHome();
    await writeUserConfig(homeDir, {
      schema_version: 1,
      locale: { default_lang: "fr" },
    });

    const result = await readUserConfig(homeDir);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toContain("schema validation failed");
      expect(result.path).toBe(userConfigPath(homeDir));
    }
  });

  test("malformed JSON → status:invalid", async () => {
    const homeDir = await tmpHome();
    await writeUserConfig(homeDir, "{not json");

    const result = await readUserConfig(homeDir);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toContain("malformed JSON");
    }
  });
});
