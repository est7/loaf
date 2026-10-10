import { Command, CommanderError } from "commander";
import { expect, test } from "vitest";
import { createCommandContext } from "../../src/cli/command-context.js";
import { createPolicyCommandProgram } from "../../src/cli/command-program.js";
import { commandPolicyInventory, declareCommandPolicy } from "../../src/cli/command-policy.js";
import {
  CommandPolicyComplete,
  evaluateCommandAction,
  installCommandActionPolicy,
} from "../../src/cli/command-action-policy.js";

function actualCommand(path: string): Command {
  return commandPolicyInventory(createPolicyCommandProgram()).find((row) => row.path === path)!
    .command;
}

const dryRun = { dryRun: true, argv: [] as string[], env: {} };

test("dynamic command modes preserve exact dry-run labels and classifications", () => {
  const edit = actualCommand("spec edit");
  expect(evaluateCommandAction(edit, dryRun)).toMatchObject({
    kind: "failure",
    diagnostic: {
      code: "DRY_RUN_NOT_APPLICABLE",
      detail: { command: "spec edit", command_type: "wrapping" },
    },
  });
  for (const input of ["/missing", ""]) {
    edit.setOptionValue("input", input);
    expect(evaluateCommandAction(edit, dryRun)).toEqual({ kind: "continue" });
  }
  const doctor = actualCommand("doctor");
  doctor.setOptionValue("rebuild", true);
  expect(evaluateCommandAction(doctor, dryRun)).toMatchObject({
    kind: "failure",
    diagnostic: { detail: { command: "doctor --rebuild", command_type: "read-only" } },
  });
  const add = actualCommand("evidence add");
  expect(evaluateCommandAction(add, dryRun)).toEqual({ kind: "continue" });
  add.setOptionValue("schema", true);
  expect(evaluateCommandAction(add, dryRun)).toMatchObject({
    kind: "failure",
    diagnostic: { detail: { command: "evidence add --schema", command_type: "read-only" } },
  });
});

test("Board action-stage dry-run rejection precedes selector rejection", () => {
  const board = actualCommand("board");
  const input = { ...dryRun, argv: ["node", "loaf", "board", "--feature=probe"] };
  expect(evaluateCommandAction(board, input)).toMatchObject({
    kind: "failure",
    diagnostic: { code: "DRY_RUN_NOT_APPLICABLE" },
  });
  expect(evaluateCommandAction(board, { ...input, dryRun: false })).toMatchObject({
    kind: "failure",
    diagnostic: {
      code: "USAGE",
      detail: { reason: "board_selector_not_supported", conflicting: ["--feature"] },
    },
  });
});

test("schema hook emits the declared input schema and skips business action", async () => {
  const program = new Command("loaf");
  let actionCalls = 0;
  declareCommandPolicy(program.command("submit").option("--schema"), {
    selectors: "selected",
    dryRun: "mutating",
    schema: { kind: "input", key: "tasks:submit" },
  }).action(() => {
    actionCalls++;
    throw new Error("schema must not read input or dispatch");
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createCommandContext(["node", "loaf", "submit", "--schema", "--format=json"], {
    writeStdout: (line) => stdout.push(line),
    writeStderr: (line) => stderr.push(line),
  });
  installCommandActionPolicy(program, ctx);
  await expect(program.parseAsync(["node", "loaf", "submit", "--schema"])).rejects.toBeInstanceOf(
    CommandPolicyComplete,
  );
  expect(actionCalls).toBe(0);
  expect(stderr).toEqual([]);
  expect(ctx.exitCode).toBe(0);
  expect(JSON.parse(stdout.join(""))).toMatchObject({
    type: "object",
    required: ["tasks"],
    properties: { tasks: { type: "array" } },
  });
});

test("dry-run hook rejects with canonical alias label and skips business action", async () => {
  const program = new Command("loaf").option("--dry-run");
  let actionCalls = 0;
  declareCommandPolicy(program.command("journal").alias("log"), {
    selectors: "selected",
    dryRun: "read-only",
  }).action(() => {
    actionCalls++;
  });
  const stderr: string[] = [];
  const ctx = createCommandContext(["node", "loaf", "log", "--dry-run", "--format=json"], {
    writeStdout: () => {
      throw new Error("rejection must not emit stdout");
    },
    writeStderr: (line) => stderr.push(line),
  });
  installCommandActionPolicy(program, ctx);
  await expect(program.parseAsync(["node", "loaf", "log", "--dry-run"])).rejects.toBeInstanceOf(
    CommandPolicyComplete,
  );
  expect(actionCalls).toBe(0);
  expect(ctx.exitCode).toBe(2);
  expect(JSON.parse(stderr.join(""))).toMatchObject({
    code: "DRY_RUN_NOT_APPLICABLE",
    detail: { command: "journal", command_type: "read-only" },
  });
});

test("Commander required-option failure precedes action policy", async () => {
  const program = new Command("loaf")
    .option("--dry-run")
    .exitOverride()
    .configureOutput({ writeErr: () => {} });
  declareCommandPolicy(program.command("probe").requiredOption("--required <value>"), {
    selectors: "selected",
    dryRun: "read-only",
  }).action(() => {
    throw new Error("missing option must not enter action");
  });
  const ctx = createCommandContext(["node", "loaf", "probe", "--dry-run"], {
    writeStdout: () => {
      throw new Error("missing option must not emit stdout");
    },
    writeStderr: () => {
      throw new Error("missing option must not enter action policy");
    },
  });
  installCommandActionPolicy(program, ctx);
  await expect(program.parseAsync(["node", "loaf", "probe", "--dry-run"])).rejects.toMatchObject({
    code: "commander.missingMandatoryOptionValue",
  } satisfies Partial<CommanderError>);
});
