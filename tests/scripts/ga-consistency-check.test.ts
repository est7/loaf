import { describe, expect, test, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { makeConsistencyFixture, runShellScript, type ConsistencyFixture } from "./_helpers.js";

const fixtures: ConsistencyFixture[] = [];
function track(f: ConsistencyFixture): ConsistencyFixture {
  fixtures.push(f);
  return f;
}

afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

describe("ga-consistency-check.sh", () => {
  test("happy: clean fixture with matching version + CHANGELOG entry + link → exit 0", () => {
    const { repo } = track(
      makeConsistencyFixture({
        version: "0.1.0",
        changelog: { hasEntry: true, hasLink: true },
        origin: { setUp: true, matchesHead: true },
      }),
    );

    const result = runShellScript("ga-consistency-check.sh", ["--repo", repo, "--no-fetch"]);

    expect(result.exit).toBe(0);
  });

  test("dirty worktree → exit !=0, stderr contains WORKTREE_DIRTY", () => {
    const { repo } = track(
      makeConsistencyFixture({
        version: "0.1.0",
        changelog: { hasEntry: true, hasLink: true },
        origin: { setUp: true, matchesHead: true },
        dirty: true,
      }),
    );

    const result = runShellScript("ga-consistency-check.sh", ["--repo", repo, "--no-fetch"]);

    expect(result.exit).not.toBe(0);
    expect(result.stderr).toMatch(/WORKTREE_DIRTY/);
  });

  test("--expected-tag does not match package version → VERSION_TAG_MISMATCH", () => {
    const { repo } = track(
      makeConsistencyFixture({
        version: "0.1.0",
        changelog: { hasEntry: true, hasLink: true },
        origin: { setUp: true, matchesHead: true },
      }),
    );

    const result = runShellScript("ga-consistency-check.sh", [
      "--repo",
      repo,
      "--no-fetch",
      "--expected-tag",
      "v0.2.0",
    ]);

    expect(result.exit).not.toBe(0);
    expect(result.stderr).toMatch(/VERSION_TAG_MISMATCH/);
  });

  test("CHANGELOG missing version entry → CHANGELOG_MISSING", () => {
    const { repo } = track(
      makeConsistencyFixture({
        version: "0.1.0",
        changelog: { hasEntry: false, hasLink: true },
        origin: { setUp: true, matchesHead: true },
      }),
    );

    const result = runShellScript("ga-consistency-check.sh", ["--repo", repo, "--no-fetch"]);

    expect(result.exit).not.toBe(0);
    expect(result.stderr).toMatch(/CHANGELOG_MISSING/);
  });

  test("CHANGELOG entry but no matching tag link → CHANGELOG_MISSING", () => {
    const { repo } = track(
      makeConsistencyFixture({
        version: "0.1.0",
        changelog: { hasEntry: true, hasLink: false },
        origin: { setUp: true, matchesHead: true },
      }),
    );

    const result = runShellScript("ga-consistency-check.sh", ["--repo", repo, "--no-fetch"]);

    expect(result.exit).not.toBe(0);
    expect(result.stderr).toMatch(/CHANGELOG_MISSING/);
  });

  test("HEAD diverged from origin/main + --no-fetch → HEAD_NOT_ORIGIN", () => {
    const { repo } = track(
      makeConsistencyFixture({
        version: "0.1.0",
        changelog: { hasEntry: true, hasLink: true },
        origin: { setUp: true, matchesHead: false },
      }),
    );

    const result = runShellScript("ga-consistency-check.sh", ["--repo", repo, "--no-fetch"]);

    expect(result.exit).not.toBe(0);
    expect(result.stderr).toMatch(/HEAD_NOT_ORIGIN/);
  });

  test("GA_REPO_ROOT env is honored when --repo flag is omitted", () => {
    const { repo } = track(
      makeConsistencyFixture({
        version: "0.1.0",
        changelog: { hasEntry: true, hasLink: true },
        origin: { setUp: true, matchesHead: true },
      }),
    );

    const result = runShellScript("ga-consistency-check.sh", ["--no-fetch"], {
      env: { GA_REPO_ROOT: repo },
    });

    expect(result.exit).toBe(0);
  });

  test("--no-fetch does not attempt network: succeeds even with unreachable origin URL", () => {
    const { repo } = track(
      makeConsistencyFixture({
        version: "0.1.0",
        changelog: { hasEntry: true, hasLink: true },
        origin: { setUp: true, matchesHead: true },
      }),
    );

    // Re-point origin at a black-hole URL. With --no-fetch the script
    // must NOT attempt `git fetch`, so the local origin/main ref stays
    // valid and the check passes. Without --no-fetch this would error.
    spawnSync("git", ["-C", repo, "remote", "set-url", "origin", "https://127.0.0.1:1/nope.git"], {
      encoding: "utf8",
    });

    const result = runShellScript("ga-consistency-check.sh", ["--repo", repo, "--no-fetch"], {
      timeoutMs: 10_000,
    });

    expect(result.exit).toBe(0);
  });
});
