import { expect, test } from "vitest";
import { Command } from "commander";
import { createPolicyCommandProgram } from "../../src/cli/command-program.js";
import {
  assertLeafCommandPolicies,
  bootstrapValueFlags,
  commandPolicy,
  commandPolicyInventory,
  declareCommandPolicy,
  evaluateCommandPreparse,
} from "../../src/cli/command-policy.js";

const argv = (...args: string[]) => ["node", "loaf", ...args];

test("actual command inventory declares every leaf and binds aliases to the same policy", () => {
  const tree = createPolicyCommandProgram();
  const rows = commandPolicyInventory(tree);
  expect(rows.filter(({ command }) => command.commands.length === 0).length).toBeGreaterThan(40);
  expect(
    rows
      .filter(({ command, policy }) => command.commands.length === 0 && policy === undefined)
      .map(({ path }) => path),
  ).toEqual([]);
  const journal = tree.commands.find((command) => command.name() === "journal")!;
  expect(journal.aliases()).toContain("log");
  const list = journal.commands.find((command) => command.name() === "list")!;
  expect(commandPolicy(list)).toEqual({ selectors: "selected", dryRun: "read-only" });
  expect([...bootstrapValueFlags(tree)].sort()).toEqual([
    "--ceremony",
    "--feature",
    "--feature-dir",
    "--format",
    "--label",
    "--session",
    "--workspace",
  ]);
});

test("schema declarations identify the six input emitters and five artifact emitters", () => {
  const rows = commandPolicyInventory(createPolicyCommandProgram());
  expect(
    rows
      .flatMap(({ policy }) => (policy?.schema?.kind === "input" ? [policy.schema.key] : []))
      .sort(),
  ).toEqual([
    "evidence:add",
    "spec:add-req",
    "spec:add-scenario",
    "spec:add-visual",
    "tasks:add",
    "tasks:submit",
  ]);
  expect(
    rows
      .flatMap(({ policy }) => (policy?.schema?.kind === "artifact" ? [policy.schema.key] : []))
      .sort(),
  ).toEqual(["evidence", "finding", "spec", "state", "tasks"]);
});

test.each([
  [["sessions", "list", "--feature-dir=/tmp/x"], "failure.sessions_list.selector_conflict"],
  [["tui", "--feature-dir=/tmp/x", "--format=json"], "failure.tui.selector_conflict"],
  [["tui", "--format=json"], "failure.tui.interactive_only"],
  [["check", "missing", "--feature-dir=/tmp/x"], "failure.check.selector_conflict"],
  [["spec", "schema", "--feature-dir=/tmp/x"], "failure.schema.selector_conflict"],
  [["tasks", "submit", "--schema", "--feature-dir=/tmp/x"], "failure.schema.selector_conflict"],
  [["board", "--once", "--feature-dir=/tmp/x"], "failure.dispatch.feature_dir_requires_feature"],
  [
    ["status", "--session=abcdefgh", "--feature-dir=/tmp/x"],
    "failure.dispatch.session_feature_dir_conflict",
  ],
])("registered pre-parse policies preserve diagnostic priority: %j", (args, context) => {
  const result = evaluateCommandPreparse(createPolicyCommandProgram(), argv(...args), {});
  expect(result).toMatchObject({
    kind: "failure",
    diagnostic: { code: "USAGE", detail: { context } },
  });
});

test("hook routes retain list-before-event and start remains positional", () => {
  const tree = createPolicyCommandProgram();
  expect(
    evaluateCommandPreparse(
      tree,
      argv("hook", "unknown", "--list-events", "--feature-dir=/tmp/x"),
      {},
    ),
  ).toEqual({ kind: "hook-events" });
  expect(evaluateCommandPreparse(tree, argv("hook"), {})).toMatchObject({
    kind: "failure",
    diagnostic: { detail: { context: "failure.hook.missing_event" } },
  });
  expect(evaluateCommandPreparse(tree, argv("start", "probe", "--feature-dir=/tmp/x"), {})).toEqual(
    { kind: "continue" },
  );
});

test("policy attachment retains the actual Commander object and rejects duplicate declarations", () => {
  const command = new Command("probe");
  const policy = { selectors: "selected", dryRun: "mutating" } as const;
  expect(declareCommandPolicy(command, policy)).toBe(command);
  expect(commandPolicy(command)).toBe(policy);
  expect(() => declareCommandPolicy(command, policy)).toThrow("command policy declared twice");
});

test("missing leaf policy is rejected rather than inheriting a permissive default", () => {
  const tree = createPolicyCommandProgram();
  tree.command("undeclared").action(() => {});
  expect(() => assertLeafCommandPolicies(tree)).toThrow("missing command policy: undeclared");
});
