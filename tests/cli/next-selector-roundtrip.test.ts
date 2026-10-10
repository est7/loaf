import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

const cli = path.resolve("src/cli.tsx");

test.each([
  "feature-dir",
  "feature-env-dir",
  "feature",
  "session",
  "auto-pick",
])("returned next command executes without selector environment: %s", async (mode) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "loaf-next-selector-"));
  const feature = "owner's feature";
  const dir = path.join(root, "custom feature's directory");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    LOAF_REGISTRY_DIR: path.join(root, "registry"),
    LOAF_LANG: "en",
  };
  delete env.LOAF_FEATURE;
  delete env.LOAF_SESSION;
  const run = (args: string[], extraEnv = {}) =>
    spawnSync("bun", [cli, ...args, "--format=json", "--quiet"], {
      cwd: root,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
    });
  try {
    const custom = mode.endsWith("dir");
    const start = run([
      "start",
      feature,
      "--ceremony",
      "standard",
      ...(custom ? ["--feature-dir", dir] : []),
    ]);
    expect(start.status, start.stderr).toBe(0);
    const sessionId = JSON.parse(start.stdout).session_id;
    const selector =
      mode === "feature-dir"
        ? ["--feature", feature, "--feature-dir", dir]
        : mode === "feature-env-dir"
          ? ["--feature-dir", dir]
          : mode === "feature"
            ? ["--feature", feature]
            : mode === "session"
              ? ["--session", sessionId]
              : [];
    const next = run(
      ["next", ...selector],
      mode === "feature-env-dir" ? { LOAF_FEATURE: feature } : {},
    );
    expect(next.status, next.stderr).toBe(0);
    const output = JSON.parse(next.stdout);
    expect(output.next_action.target).toBe("TRIAGE.confirm");
    // Execute the returned shell command verbatim; only bind the executable
    // to the source CLI under test. No selector is supplied by the harness.
    const routed = spawnSync(
      "/bin/sh",
      [
        "-c",
        `loaf() { bun "$LOAF_TEST_CLI" "$@" --format=json --quiet; }; ${output.next_action.command}`,
      ],
      {
        cwd: root,
        env: { ...env, LOAF_TEST_CLI: cli },
        encoding: "utf8",
      },
    );
    expect(routed.status, routed.stderr).toBe(0);
    expect(JSON.parse(routed.stdout)).toMatchObject({ ok: true, sub_state: "TRIAGE.confirm" });
    const status = run(
      ["status", ...selector],
      mode === "feature-env-dir" ? { LOAF_FEATURE: feature } : {},
    );
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).state).toMatchObject({ feature, sub_state: "TRIAGE.confirm" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
