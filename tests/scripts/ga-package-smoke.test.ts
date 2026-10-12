import { describe, expect, test, afterEach, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  makePackageSmokeFixture,
  runShellScript,
  REPO_ROOT,
  ownedLeftovers,
  repoRootLeftovers,
  type PackageSmokeFixture,
} from "./_helpers.js";

const fixtures: PackageSmokeFixture[] = [];
function track(f: PackageSmokeFixture): PackageSmokeFixture {
  fixtures.push(f);
  return f;
}

afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

// Ensure dist/cli.mjs exists before running real-package smoke tests.
// `bun run check` runs tests BEFORE build, so dist may be stale or
// missing. This rebuild is local to this test file.
beforeAll(() => {
  const distPath = path.join(REPO_ROOT, "dist", "cli.mjs");
  if (!existsSync(distPath)) {
    const result = spawnSync("bun", ["run", "build"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.status !== 0) {
      throw new Error(`bun run build failed: status=${result.status} stderr=${result.stderr}`);
    }
  }
}, 90_000);

describe("ga-package-smoke.sh", () => {
  test("HOME isolation without XDG_CACHE_HOME keeps the install-time cache", () => {
    const { tmpHome } = track(makePackageSmokeFixture({ withDist: false }));
    expect(process.env["BUN_INSTALL_CACHE_DIR"]).toBeTruthy();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      TMPDIR: tmpHome,
    };
    delete env["XDG_CACHE_HOME"];
    const result = spawnSync(
      "bash",
      [path.join(REPO_ROOT, "scripts", "ga-package-smoke.sh"), "--package-root", REPO_ROOT],
      { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 90_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(ownedLeftovers(tmpHome)).toEqual([]);
  }, 100_000);

  test("real tarball install works from cache with registry unavailable", () => {
    const { tmpHome } = track(makePackageSmokeFixture({ withDist: false }));
    const result = runShellScript("ga-package-smoke.sh", ["--package-root", REPO_ROOT], {
      env: { TMPDIR: tmpHome, BUN_CONFIG_DEFAULT_REGISTRY: "http://127.0.0.1:1" },
      timeoutMs: 90_000,
    });
    expect(result.exit, result.stderr).toBe(0);
    expect(ownedLeftovers(tmpHome)).toEqual([]);
  }, 100_000);

  test("missing local cache fails at INSTALL_FAILED without registry retries", () => {
    const { tmpHome } = track(makePackageSmokeFixture({ withDist: false }));
    const cache = path.join(tmpHome, "empty-cache");
    mkdirSync(cache);
    const result = runShellScript("ga-package-smoke.sh", ["--package-root", REPO_ROOT], {
      env: { TMPDIR: tmpHome, BUN_INSTALL_CACHE_DIR: cache },
      timeoutMs: 90_000,
    });
    expect(result.exit).not.toBe(0);
    expect(result.stderr).toContain("INSTALL_FAILED");
    expect(result.stderr).toContain("local package cache required");
    expect(ownedLeftovers(tmpHome)).toEqual([]);
  }, 100_000);

  test("DIST_MISSING: --package-root has no dist/cli.mjs → fails fast with DIST_MISSING", () => {
    const { packageRoot, tmpHome } = track(makePackageSmokeFixture({ withDist: false }));

    const result = runShellScript("ga-package-smoke.sh", ["--package-root", packageRoot], {
      env: { TMPDIR: tmpHome },
    });

    expect(result.exit).not.toBe(0);
    expect(result.stderr).toMatch(/DIST_MISSING/);
    expect(ownedLeftovers(tmpHome)).toEqual([]);
    expect(repoRootLeftovers(REPO_ROOT)).toEqual([]);
  });

  test("happy: real repo pack → install → lifecycle smoke → exit 0; TMPDIR cleaned", () => {
    const { tmpHome } = track(makePackageSmokeFixture({ withDist: false }));

    const result = runShellScript("ga-package-smoke.sh", ["--package-root", REPO_ROOT], {
      env: { TMPDIR: tmpHome },
      timeoutMs: 120_000,
    });

    expect(result.exit, `stderr=${result.stderr}`).toBe(0);
    expect(ownedLeftovers(tmpHome)).toEqual([]);
    expect(repoRootLeftovers(REPO_ROOT)).toEqual([]);
  }, 180_000);

  test("VERSION_MISMATCH: stub binary prints version != package.json.version → VERSION_MISMATCH", () => {
    const { packageRoot, tmpHome } = track(
      makePackageSmokeFixture({
        pkgVersion: "1.0.0",
        binaryVersionOutput: "9.9.9",
      }),
    );

    const result = runShellScript("ga-package-smoke.sh", ["--package-root", packageRoot], {
      env: { TMPDIR: tmpHome },
      timeoutMs: 60_000,
    });

    expect(result.exit).not.toBe(0);
    expect(result.stderr).toMatch(/VERSION_MISMATCH/);
    expect(ownedLeftovers(tmpHome)).toEqual([]);
    expect(repoRootLeftovers(REPO_ROOT)).toEqual([]);
  }, 90_000);

  test("VERSION_MISMATCH regression (codex r185): pkg 1.2.3 + binary 1.2.30 must fail (no substring pass)", () => {
    const { packageRoot, tmpHome } = track(
      makePackageSmokeFixture({
        pkgVersion: "1.2.3",
        binaryVersionOutput: "1.2.30",
      }),
    );

    const result = runShellScript(
      "ga-package-smoke.sh",
      ["--package-root", packageRoot, "--expected-pin", "^1.2.3"],
      { env: { TMPDIR: tmpHome }, timeoutMs: 60_000 },
    );

    expect(result.exit).not.toBe(0);
    expect(result.stderr).toMatch(/VERSION_MISMATCH/);
  }, 90_000);

  test("PIN_MISMATCH: real pack but --expected-pin wrong → PIN_MISMATCH; TMPDIR cleaned", () => {
    const { tmpHome } = track(makePackageSmokeFixture({ withDist: false }));

    const result = runShellScript(
      "ga-package-smoke.sh",
      ["--package-root", REPO_ROOT, "--expected-pin", "^0.0.0-bogus-not-real"],
      { env: { TMPDIR: tmpHome }, timeoutMs: 120_000 },
    );

    expect(result.exit).not.toBe(0);
    expect(result.stderr).toMatch(/PIN_MISMATCH/);
    expect(ownedLeftovers(tmpHome)).toEqual([]);
    expect(repoRootLeftovers(REPO_ROOT)).toEqual([]);
  }, 180_000);
});
