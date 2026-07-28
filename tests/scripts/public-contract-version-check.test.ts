import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { mktempd, REPO_ROOT, runShellScript, safeRm } from "./_helpers.js";

const roots: string[] = [];

function git(repo: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "release-identity-test",
      GIT_AUTHOR_EMAIL: "release-identity@example.invalid",
      GIT_COMMITTER_NAME: "release-identity-test",
      GIT_COMMITTER_EMAIL: "release-identity@example.invalid",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr);
}

function fixture(currentVersion: string, targetVersion: string): string {
  const repo = mktempd("loaf-release-identity-");
  roots.push(repo);
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  writeFileSync(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "0.6.0" }, null, 2)}\n`,
  );
  git(repo, ["init", "--initial-branch=main", "--quiet"]);
  git(repo, ["add", "package.json"]);
  git(repo, ["commit", "-m", "baseline", "--quiet"]);
  git(repo, ["tag", "v0.6.0"]);

  writeFileSync(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: "fixture", version: currentVersion }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(repo, "docs", "release-identity.json"),
    `${JSON.stringify(
      {
        schema: 1,
        baseline_tag: "v0.6.0",
        target_version: targetVersion,
        breaking_changes: [{ task: "A08", contract: "strict task intake" }],
      },
      null,
      2,
    )}\n`,
  );
  git(repo, ["add", "package.json", "docs/release-identity.json"]);
  git(repo, ["commit", "-m", "candidate", "--quiet"]);
  return repo;
}

afterEach(() => {
  for (const root of roots.splice(0)) safeRm(root);
});

describe("public-contract-version-check.sh", () => {
  test("quality CI fetches the baseline tag required by the release identity gate", () => {
    const workflow = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    const qualityJob = workflow.slice(
      workflow.indexOf("  quality:"),
      workflow.indexOf("  release-consistency:"),
    );

    expect(qualityJob).toMatch(
      /- uses: actions\/checkout@v4\s+with:\s+fetch-depth: 0/,
    );
  });

  test("rejects breaking contracts published under the baseline identity", () => {
    const repo = fixture("0.6.0", "0.6.0");
    const result = runShellScript("public-contract-version-check.sh", ["--repo", repo]);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("PUBLIC_CONTRACT_VERSION_UNCHANGED");
  });

  test("accepts a 0.x minor identity boundary for declared breaking changes", () => {
    const repo = fixture("0.7.0", "0.7.0");
    const result = runShellScript("public-contract-version-check.sh", ["--repo", repo]);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("rejects a patch-only identity for 0.x breaking changes", () => {
    const repo = fixture("0.6.1", "0.6.1");
    const result = runShellScript("public-contract-version-check.sh", ["--repo", repo]);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("PUBLIC_CONTRACT_VERSION_NOT_BREAKING");
  });

  test("accepts 1.0.0 as a breaking successor to a 0.x baseline", () => {
    const repo = fixture("1.0.0", "1.0.0");
    const result = runShellScript("public-contract-version-check.sh", ["--repo", repo]);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("the live repository package and manifest remain coupled", () => {
    const result = runShellScript("public-contract-version-check.sh", ["--repo", REPO_ROOT]);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
  });
});
