import { expect, test } from "vitest";
import { scanArgv } from "../../src/core/argv-scanner.js";
import { bootstrapCommandTokens } from "../../src/cli/argv-bootstrap.js";

test("scanner retains ordered raw provenance, arity and adjacent values without consuming them", () => {
  expect(
    scanArgv(
      [
        "node",
        "loaf",
        "--feature",
        "--session=x",
        "--feature=",
        "-n",
        "--",
        "status",
        "-",
        "--format",
      ],
      new Set(["--feature", "--format"]),
    ),
  ).toEqual([
    { kind: "positional", index: 0, raw: "node" },
    { kind: "positional", index: 1, raw: "loaf" },
    {
      kind: "option",
      index: 2,
      raw: "--feature",
      flag: "--feature",
      arity: 1,
      value: "--session=x",
      valueIndex: 3,
    },
    {
      kind: "option",
      index: 3,
      raw: "--session=x",
      flag: "--session",
      arity: 1,
      value: "x",
      valueIndex: 3,
    },
    {
      kind: "option",
      index: 4,
      raw: "--feature=",
      flag: "--feature",
      arity: 1,
      value: "",
      valueIndex: 4,
    },
    {
      kind: "option",
      index: 5,
      raw: "-n",
      flag: "-n",
      arity: 0,
      value: undefined,
      valueIndex: undefined,
    },
    { kind: "terminator", index: 6, raw: "--" },
    { kind: "positional", index: 7, raw: "status" },
    { kind: "positional", index: 8, raw: "-" },
    {
      kind: "option",
      index: 9,
      raw: "--format",
      flag: "--format",
      arity: 1,
      value: undefined,
      valueIndex: undefined,
    },
  ]);
});

test.each([
  [
    ["--format=json", "--dry-run", "start", "probe"],
    ["start", "probe"],
  ],
  [["--label", "sessions", "list"], ["list"]],
  [
    ["--feature", "--format=json", "sessions", "list"],
    ["sessions", "list"],
  ],
  [
    ["--", "sessions", "list"],
    ["sessions", "list"],
  ],
  [
    ["-n", "start", "-"],
    ["start", "-"],
  ],
])("bootstrap positional view preserves characterized token consumption: %j", (args, expected) => {
  expect(bootstrapCommandTokens(["node", "loaf", ...args], 2)).toEqual(expected);
});

test("lexical records preserve duplicates and option-looking values across the terminator", () => {
  const tokens = scanArgv(
    ["--format", "json", "--", "--format=text", "--format", "yaml"],
    new Set(["--format"]),
  );
  expect(tokens.filter((token) => token.kind === "option")).toEqual([
    {
      kind: "option",
      index: 0,
      raw: "--format",
      flag: "--format",
      arity: 1,
      value: "json",
      valueIndex: 1,
    },
    {
      kind: "option",
      index: 3,
      raw: "--format=text",
      flag: "--format",
      arity: 1,
      value: "text",
      valueIndex: 3,
    },
    {
      kind: "option",
      index: 4,
      raw: "--format",
      flag: "--format",
      arity: 1,
      value: "yaml",
      valueIndex: 5,
    },
  ]);
});
