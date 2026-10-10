import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { main, type MainDeps } from "../../src/cli.js";
import packageJson from "../../package.json";

async function run(args: string[], deps: MainDeps = {}) {
  const stdout: string[] = [],
    stderr: string[] = [];
  const out = process.stdout.write,
    err = process.stderr.write;
  process.stdout.write = ((value: string | Uint8Array) => {
    stdout.push(String(value));
    return true;
  }) as typeof out;
  process.stderr.write = ((value: string | Uint8Array) => {
    stderr.push(String(value));
    return true;
  }) as typeof err;
  try {
    return {
      exit: await main(["node", "loaf", ...args], deps),
      stdout: stdout.join(""),
      stderr: stderr.join(""),
    };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}
afterEach(() => vi.unstubAllEnvs());

const cases = [
  {
    args: ["status", "--unknown-flag"],
    parser_code: "commander.unknownOption",
    reason: "error: unknown option '--unknown-flag'",
  },
  {
    args: ["advance"],
    parser_code: "commander.missingArgument",
    reason: "error: missing required argument 'to'",
  },
  {
    args: ["status", "--feature"],
    parser_code: "commander.optionMissingArgument",
    reason: "error: option '--feature <name>' argument missing",
  },
  {
    args: ["not-a-command"],
    parser_code: "commander.unknownCommand",
    reason: "error: unknown command 'not-a-command'",
  },
  { args: [], parser_code: "commander.help", reason: "(outputHelp)" },
];

describe("Commander catalog boundary", () => {
  for (const locale of ["en", "zh"]) {
    for (const entry of cases) {
      test(`${locale}: ${entry.parser_code} emits one canonical JSON envelope`, async () => {
        vi.stubEnv("LOAF_LANG", locale);
        const result = await run([...entry.args, "--format=json", "--quiet"]);
        expect(result.exit).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr.split("\n")).toHaveLength(2);
        expect(JSON.parse(result.stderr)).toEqual({
          ok: false,
          code: "USAGE",
          message: "invalid CLI usage",
          detail: { parser_code: entry.parser_code, reason: entry.reason },
        });
      });
    }
    test(`${locale}: text includes catalog message, parser context, fix and see once`, async () => {
      vi.stubEnv("LOAF_LANG", locale);
      const result = await run(["status", "--unknown-flag", "--plain", "--quiet"]);
      expect(result.exit).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        locale === "zh" ? "error: USAGE — CLI 用法不合法\n" : "error: USAGE — invalid CLI usage\n",
      );
      expect(result.stderr).toContain("commander.unknownOption");
      expect(result.stderr).toContain("unknown option '--unknown-flag'");
      expect(result.stderr.match(/^error:/gm)).toHaveLength(1);
      expect(result.stderr).toContain("\n  fix: Run the command with --help");
      expect(result.stderr).toContain("\n  see: protocol.md#§10.5\n");
      expect(result.stderr).not.toContain("Usage:");
    });
  }
  for (const args of [["--help"], ["status", "--help"], ["help", "status"], ["--version"]]) {
    test(`${args.join(" ")} retains explicit stdout and exit zero`, async () => {
      const result = await run(args);
      expect(result.exit).toBe(0);
      expect(result.stderr).toBe("");
      if (args.includes("--version")) expect(result.stdout).toBe(`${packageJson.version}\n`);
      else expect(result.stdout).toContain("Usage: loaf");
    });
  }
  test("unknown action exception remains a crash with its original cause", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "loaf-commander-crash-"));
    vi.stubEnv("HOME", home);
    try {
      const result = await run(["tui"], {
        isStdinTty: () => true,
        isStdoutTty: () => true,
        registryDir: path.join(home, "registry"),
        renderTui: async () => {
          throw new Error("commander-boundary-crash-witness");
        },
      });
      expect(result.exit).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("error: UNEXPECTED_ERROR — commander-boundary-crash-witness");
      expect(result.stderr).not.toContain("error: USAGE");
      const dir = path.join(home, ".loaf", "crashes");
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      expect(await readFile(path.join(dir, files[0]!), "utf8")).toContain(
        "commander-boundary-crash-witness",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
