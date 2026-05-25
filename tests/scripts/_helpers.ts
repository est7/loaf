import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, "..", "..");

export type ScriptResult = {
  exit: number;
  stdout: string;
  stderr: string;
};

export function runShellScript(
  scriptName: string,
  args: string[] = [],
  options: { env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {},
): ScriptResult {
  const scriptPath = path.join(REPO_ROOT, "scripts", scriptName);
  const result: SpawnSyncReturns<string> = spawnSync("bash", [scriptPath, ...args], {
    env: { ...process.env, ...(options.env ?? {}) },
    cwd: options.cwd ?? REPO_ROOT,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60_000,
  });
  return {
    exit: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function mktempd(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function safeRm(p: string): void {
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
  }
}

function runGit(cwd: string, args: string[]): SpawnSyncReturns<string> {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ga-test",
      GIT_AUTHOR_EMAIL: "ga-test@example.com",
      GIT_COMMITTER_NAME: "ga-test",
      GIT_COMMITTER_EMAIL: "ga-test@example.com",
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: exit=${result.status} stderr=${result.stderr}`,
    );
  }
  return result;
}

export type ConsistencyFixtureOptions = {
  version: string;
  changelog?: {
    hasEntry?: boolean;
    hasLink?: boolean;
    linkTag?: string;
  };
  dirty?: boolean;
  origin?: {
    setUp: boolean;
    branch?: string;
    matchesHead?: boolean;
  };
};

export type ConsistencyFixture = {
  repo: string;
  cleanup: () => void;
};

/**
 * Build a temp git repo for ga-consistency-check.sh tests.
 *
 * - Initializes git, commits package.json + CHANGELOG.md.
 * - Optionally leaves the worktree dirty.
 * - Optionally creates a sibling bare repo as origin; can be set to
 *   either match HEAD (so HEAD == origin/main) or diverge by adding
 *   an unpushed commit after the origin sync.
 */
export function makeConsistencyFixture(opts: ConsistencyFixtureOptions): ConsistencyFixture {
  const root = mktempd("ga-consistency-");
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });

  const pkgJson = {
    name: "loaf-cli-fixture",
    version: opts.version,
    description: "fixture",
  };
  writeFileSync(path.join(repo, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");

  const cl = opts.changelog ?? { hasEntry: true, hasLink: true };
  const linkTag = cl.linkTag ?? `v${opts.version}`;
  const changelogLines: string[] = ["# Changelog", ""];
  if (cl.hasEntry !== false) {
    changelogLines.push(`## [${opts.version}] — 2026-05-25`, "- something", "");
  }
  if (cl.hasLink !== false) {
    changelogLines.push(`[${opts.version}]: https://example.invalid/tag/${linkTag}`);
  }
  writeFileSync(path.join(repo, "CHANGELOG.md"), changelogLines.join("\n") + "\n");

  runGit(repo, ["init", "--initial-branch=main", "--quiet"]);
  runGit(repo, ["add", "package.json", "CHANGELOG.md"]);
  runGit(repo, ["commit", "-m", "initial", "--quiet"]);

  if (opts.origin?.setUp) {
    const originPath = path.join(root, "origin.git");
    runGit(repo, ["clone", "--bare", "--quiet", repo, originPath]);
    runGit(repo, ["remote", "add", "origin", originPath]);
    runGit(repo, ["fetch", "origin", "--quiet"]);
    runGit(repo, ["branch", "--set-upstream-to=origin/main", "main"]);

    if (opts.origin.matchesHead === false) {
      writeFileSync(path.join(repo, "drift.txt"), "drift\n");
      runGit(repo, ["add", "drift.txt"]);
      runGit(repo, ["commit", "-m", "diverge from origin", "--quiet"]);
    }
  }

  if (opts.dirty) {
    writeFileSync(path.join(repo, "dirty.txt"), "dirty\n");
  }

  return {
    repo,
    cleanup: () => safeRm(root),
  };
}

export type PackageSmokeFixtureOptions = {
  withDist?: boolean;
  /** Override package.json.version. Defaults to "0.0.0-fixture". */
  pkgVersion?: string;
  /**
   * If set, dist/cli.mjs becomes a real Node script that prints this on
   * `--version` and exits 1 on anything else. Used to test
   * VERSION_MISMATCH where the binary reports a different string than
   * package.json.version. Implies withDist=true.
   */
  binaryVersionOutput?: string;
};

export type PackageSmokeFixture = {
  packageRoot: string;
  tmpHome: string;
  cleanup: () => void;
};

/**
 * Build a temp package-root for ga-package-smoke.sh DIST_MISSING tests.
 *
 * The fixture has a minimal package.json but optionally no dist/cli.mjs,
 * letting the script fail fast on the DIST_MISSING preflight without
 * needing to run the full pack lifecycle.
 *
 * Also returns tmpHome (TMPDIR) so callers can verify trap cleanup left
 * nothing behind.
 */
export function makePackageSmokeFixture(opts: PackageSmokeFixtureOptions = {}): PackageSmokeFixture {
  const version = opts.pkgVersion ?? "0.0.0-fixture";
  const root = mktempd("ga-package-smoke-");
  const packageRoot = path.join(root, "pkg");
  mkdirSync(packageRoot, { recursive: true });
  const tmpHome = path.join(root, "tmp");
  mkdirSync(tmpHome, { recursive: true });

  const pkgJson = {
    name: "loaf-cli-fixture",
    version,
    type: "module",
    bin: { loaf: "./dist/cli.mjs" },
    files: ["dist"],
  };
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");

  const needsDist = opts.withDist === true || opts.binaryVersionOutput !== undefined;
  if (needsDist) {
    const distDir = path.join(packageRoot, "dist");
    mkdirSync(distDir, { recursive: true });
    let binBody: string;
    if (opts.binaryVersionOutput !== undefined) {
      const escaped = JSON.stringify(opts.binaryVersionOutput);
      binBody = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log(${escaped});
  process.exit(0);
}
console.error("stub fixture: only --version is implemented");
process.exit(1);
`;
    } else {
      binBody = "#!/usr/bin/env node\nconsole.log('fixture');\n";
    }
    writeFileSync(path.join(distDir, "cli.mjs"), binBody);
    chmodSync(path.join(distDir, "cli.mjs"), 0o755);
  }

  return {
    packageRoot,
    tmpHome,
    cleanup: () => safeRm(root),
  };
}

export function listLeftovers(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

/**
 * Filter directory entries to only those matching ga-package-smoke's
 * own mktemp prefixes (ga-pack-* / ga-install-*). Used to verify the
 * script's trap cleanup ran without flagging unrelated TMPDIR entries
 * that bun pack/add may create as part of their internal staging
 * (e.g. `.<hash>-NNNNNNNN.` lock/install artifacts) — those are NOT
 * the script's responsibility per codex r184 ("should not leave a
 * tarball or temp install dir in the repo").
 */
export function ownedLeftovers(dir: string): string[] {
  return listLeftovers(dir).filter((name) => /^ga-(pack|install)-/.test(name));
}

/**
 * List repo-root entries the script may have leaked: stray .tgz
 * tarballs (codex r184 "tarball MUST NOT land in repo root") or
 * uncleaned `ga-pack-` / `ga-install-` prefixed dirs.
 */
export function repoRootLeftovers(repoRoot: string): string[] {
  return readdirSync(repoRoot).filter(
    (name) => name.endsWith(".tgz") || /^ga-(pack|install)-/.test(name),
  );
}

export function readFileText(p: string): string {
  return readFileSync(p, "utf8");
}

export function writeFileText(p: string, content: string): void {
  writeFileSync(p, content);
}
