// Phase 16 SC-15c — loaf.config.json loader tests.
//
// Fail-closed contract: absent = no overlay; present-but-invalid = strict
// failure (write-guard refuses to authorize under an untrusted config).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  defaultLoafConfig,
  LoafConfig,
  readLoafConfig,
  loafConfigPath,
  WriteGuardConfig,
  writeConfigExclusive,
} from "../../src/core/loaf-config.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function tmpRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-cli-config-"));
}

async function writeConfig(repoRoot: string, content: string): Promise<void> {
  const p = loafConfigPath(repoRoot);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

describe("readLoafConfig", () => {
  test("absent config → status:absent (no overlay)", async () => {
    const repo = await tmpRepo();
    expect(await readLoafConfig(repo)).toEqual({ status: "absent" });
  });

  test("valid config → status:ok with parsed paths + protected_files", async () => {
    const repo = await tmpRepo();
    await writeConfig(
      repo,
      JSON.stringify({
        schema_version: 2,
        protected_files: ["src/secrets.ts"],
        paths: { source: ["app/**"] },
      }),
    );
    const r = await readLoafConfig(repo);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.config.protected_files).toEqual(["src/secrets.ts"]);
      expect(r.config.paths.source).toEqual(["app/**"]);
      // omitted categories fall back to docs defaults
      expect(r.config.paths.tests).toEqual(["**/test/**", "tests/**"]);
    }
  });

  test("config carrying loaf-skill sections (commands/constitution) still parses", async () => {
    const repo = await tmpRepo();
    await writeConfig(
      repo,
      JSON.stringify({
        schema_version: 2,
        protected_files: [],
        paths: {},
        commands: { run: ["bun test"] },
        constitution: { tdd_strictness: "strict" },
        locale: { default_lang: "en" },
      }),
    );
    expect((await readLoafConfig(repo)).status).toBe("ok");
  });

  test("malformed JSON → status:invalid (fail closed)", async () => {
    const repo = await tmpRepo();
    await writeConfig(repo, "{ not valid json");
    expect((await readLoafConfig(repo)).status).toBe("invalid");
  });

  test("wrong-typed write-guard field → status:invalid (fail closed)", async () => {
    const repo = await tmpRepo();
    await writeConfig(repo, JSON.stringify({ schema_version: 2, protected_files: "nope" }));
    expect((await readLoafConfig(repo)).status).toBe("invalid");
  });

  test("shipped loaf.config.example.json parses through WriteGuardConfig (drift guard)", async () => {
    // codex SC-15c PATCH: the canonical example is copied verbatim into
    // .loaf/.config/loaf.config.json by users. If it does not parse, every
    // write-guard call fails closed (SCHEMA_VALIDATION_FAILED). Lock it.
    const raw = await fs.readFile(path.join(REPO_ROOT, "loaf.config.example.json"), "utf8");
    const result = WriteGuardConfig.safeParse(JSON.parse(raw));
    expect(result.success, result.success ? "" : JSON.stringify(result.error.issues)).toBe(true);
  });

  test("example config copied to canonical path loads via readLoafConfig (status:ok)", async () => {
    const repo = await tmpRepo();
    const raw = await fs.readFile(path.join(REPO_ROOT, "loaf.config.example.json"), "utf8");
    await writeConfig(repo, raw);
    expect((await readLoafConfig(repo)).status).toBe("ok");
  });

  test("WriteGuardConfig.paths exposes every canonical path category", async () => {
    const parsed = WriteGuardConfig.parse({ schema_version: 2 });
    expect(Object.keys(parsed.paths).sort()).toEqual([
      "docs",
      "public_api",
      "schema",
      "security",
      "source",
      "tests",
      "ui",
    ]);
  });
});

describe("LoafConfig full runtime schema", () => {
  test("defaultLoafConfig serializes every explicit §21 section and key", () => {
    const config = defaultLoafConfig();
    expect(LoafConfig.parse(config)).toEqual(config);
    expect(config).toEqual({
      schema_version: 2,
      protected_files: [],
      stable_core: [],
      paths: {
        source: ["src/**"],
        tests: ["**/test/**", "tests/**"],
        docs: ["docs/**", "**/*.md"],
        ui: [],
        public_api: [],
        schema: [],
        security: [],
      },
      commands: {
        run: [],
        lint: [],
        typecheck: [],
        visual: [],
        acceptance: [],
        build: [],
      },
      constitution: {
        tdd_strictness: "preferred",
        default_ceremony_label: "standard",
        require_red_for_behavioral: true,
        allow_manual_for_requirement: true,
        require_attachment_for_visual: true,
      },
      locale: {
        default_lang: "en",
      },
    });
  });

  test("malformed skill-only section fails full config but not write-guard slice", () => {
    const raw = {
      ...defaultLoafConfig(),
      commands: { run: "bun test" },
    };
    expect(LoafConfig.safeParse(raw).success).toBe(false);
    expect(WriteGuardConfig.safeParse(raw).success).toBe(true);
  });
});

describe("writeConfigExclusive", () => {
  test("writes content and creates the parent dir when target absent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-cfg-write-"));
    const target = path.join(dir, ".loaf", ".config", "loaf.config.json");

    const result = await writeConfigExclusive(target, "scaffolded\n");

    expect(result).toBe("written");
    expect(await fs.readFile(target, "utf8")).toBe("scaffolded\n");
  });

  test("returns 'exists' without clobbering when target is present (wx race path)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-cfg-write-"));
    const target = path.join(dir, "loaf.config.json");
    await fs.writeFile(target, "original");

    const result = await writeConfigExclusive(target, "REPLACEMENT");

    expect(result).toBe("exists");
    expect(await fs.readFile(target, "utf8")).toBe("original");
  });

  test("propagates non-EEXIST errors (parent path is a file, not a dir)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-cfg-write-"));
    const fileAsParent = path.join(dir, "not-a-dir");
    await fs.writeFile(fileAsParent, "x");
    const target = path.join(fileAsParent, "loaf.config.json");

    await expect(writeConfigExclusive(target, "data")).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTDIR|EEXIST)$/),
    });
  });
});
