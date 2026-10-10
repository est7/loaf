import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../../src/cli.js";
import { resolveDispatch } from "../../src/core/session-dispatch.js";
import { Command } from "commander";
import { expect, test, vi } from "vitest";
import { bootstrapCommandTokens } from "../../src/cli/argv-bootstrap.js";
import { parsePresentation } from "../../src/cli/argv-presentation.js";
import { collectPresentSelectors } from "../../src/cli/selectors.js";
import { createPolicyCommandProgram } from "../../src/cli/command-program.js";
import { bootstrapValueFlags, evaluateCommandPreparse } from "../../src/cli/command-policy.js";

const argv = (...args: string[]) => ["node", "loaf", ...args];

test("bootstrap follows Commander's positional treatment of every post-terminator token", async () => {
  const args = argv("check", "--", "--feature=literal", "--", "--format=yaml");
  const program = new Command().exitOverride();
  let operands: string[] = [];
  program.command("check <path> [rest...]").action((file: string, rest: string[]) => {
    operands = [file, ...rest];
  });
  await program.parseAsync(args);
  expect(operands).toEqual(["--feature=literal", "--", "--format=yaml"]);
  expect(
    bootstrapCommandTokens(args, 5, bootstrapValueFlags(createPolicyCommandProgram())),
  ).toEqual(["check", ...operands]);
});

test("post-terminator presentation flags are data and retain environment defaults", () => {
  expect(
    parsePresentation(
      argv(
        "status",
        "--",
        "--format=yaml",
        "--plain",
        "--quiet",
        "-vv",
        "--no-color",
        "--no-input",
        "--debug",
        "--dry-run",
      ),
      {},
    ),
  ).toEqual({
    ok: true,
    format: "text",
    plain: false,
    quiet: false,
    verbose: 0,
    noColor: false,
    noInput: false,
    debug: false,
    dryRun: false,
  });
  expect(
    parsePresentation(argv("status", "--format=json", "--", "--format=yaml", "--plain"), {
      NO_COLOR: "1",
      LOAF_DEBUG: "1",
    }),
  ).toMatchObject({ ok: true, format: "json", plain: false, noColor: true, debug: true });
  expect(parsePresentation(argv("status", "--format=yaml", "--", "--format=json"), {})).toEqual({
    ok: false,
    kind: "INVALID_FORMAT",
    rawValue: "yaml",
  });
});

test("post-terminator selectors disappear while pre-terminator and environment selectors retain precedence", () => {
  expect(
    collectPresentSelectors(
      argv("status", "--feature=before", "--", "--session=after", "--feature-dir=/after"),
      { LOAF_SESSION: "env-session", LOAF_FEATURE: "env-feature" },
    ),
  ).toEqual(["--feature", "$LOAF_SESSION", "$LOAF_FEATURE"]);
});

test.each([
  [["sessions", "list", "--", "--feature=literal"], "continue"],
  [["tasks", "submit", "--", "--schema", "--feature=literal"], "continue"],
  [["spec", "schema", "--", "--feature-dir=/literal"], "continue"],
  [["hook", "unknown", "--", "--list-events"], "failure.hook.unknown_event"],
  [
    ["status", "--feature-dir=/before", "--", "--feature=literal"],
    "failure.dispatch.feature_dir_requires_feature",
  ],
])("preparse respects the boundary: %j", (args, expected) => {
  const result = evaluateCommandPreparse(createPolicyCommandProgram(), argv(...args), {});
  if (expected === "continue") expect(result).toEqual({ kind: "continue" });
  else
    expect(result).toMatchObject({
      kind: "failure",
      diagnostic: { detail: { context: expected } },
    });
});

test.each([
  [["status", "--", "--format=yaml"], "USAGE", "parser_code", "commander.excessArguments"],
  [["status", "--", "--help"], "USAGE", "parser_code", "commander.excessArguments"],
  [["status", "--", "--version"], "USAGE", "parser_code", "commander.excessArguments"],
  [
    ["sessions", "list", "--", "--feature=literal"],
    "USAGE",
    "parser_code",
    "commander.excessArguments",
  ],
  [
    ["spec", "schema", "--", "--feature=literal"],
    "USAGE",
    "parser_code",
    "commander.excessArguments",
  ],
  [["hook", "unknown", "--", "--list-events"], "USAGE", "context", "failure.hook.unknown_event"],
  [["check", "--", "--feature=literal"], "INPUT_FILE_NOT_FOUND", undefined, undefined],
])("real CLI keeps positional data out of policy/diagnostic rendering: %j", async (args, code, key, value) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-terminator-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    const exit = await main(argv("--format=json", ...args), {
      userConfigHomeDir: root,
      registryDir: path.join(root, "registry"),
    });
    expect(exit).toBe(2);
    expect(stdout).toEqual([]);
    const diagnostic = JSON.parse(stderr.join(""));
    expect(diagnostic.code).toBe(code);
    if (key) expect(diagnostic.detail[key]).toBe(value);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
});

test("literal post-terminator help cannot bypass an invalid pre-terminator format", async () => {
  const stderr: string[] = [];
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    expect(await main(argv("status", "--format=yaml", "--", "--help"))).toBe(2);
    expect(stderr.join("")).toContain("INVALID_FORMAT");
  } finally {
    err.mockRestore();
  }
});

test("dispatch ignores all three post-boundary flags and uses the environment feature", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-terminator-dispatch-"));
  const result = await resolveDispatch({
    argv: argv("status", "--", "--session=invalid", "--feature=other", "--feature-dir=/other"),
    env: { LOAF_FEATURE: "probe" },
    cwd: root,
    registryDir: path.join(root, "registry"),
  });
  expect(result).toMatchObject({
    ok: false,
    code: "FEATURE_NOT_FOUND",
    detail: { feature: "probe" },
  });
});
