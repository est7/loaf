// Vitest environment isolation.
//
// CLI tests exercise production defaults, so they must not read the
// maintainer's `~/.loaf/config.json` or write `~/.loaf/registry/`. Each test
// file gets an isolated temporary home; child CLI processes inherit it.
//
// Tests that inject `userConfigHomeDir` or `registryDir` still override these
// defaults. Production does not load this setup file.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterAll } from "vitest";

const originalHome = process.env["HOME"];
const originalUserProfile = process.env["USERPROFILE"];
const originalRegistryDir = process.env["LOAF_REGISTRY_DIR"];
const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-vitest-home-"));
const testRegistry = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-vitest-reg-"));

process.env["HOME"] = testHome;
process.env["USERPROFILE"] = testHome;
process.env["LOAF_REGISTRY_DIR"] = testRegistry;

afterAll(async () => {
  restoreEnv("HOME", originalHome);
  restoreEnv("USERPROFILE", originalUserProfile);
  restoreEnv("LOAF_REGISTRY_DIR", originalRegistryDir);
  await Promise.all([
    fs.rm(testHome, { recursive: true, force: true }),
    fs.rm(testRegistry, { recursive: true, force: true }),
  ]);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
