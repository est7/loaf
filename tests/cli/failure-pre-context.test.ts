import { describe, expect, test } from "vitest";
import { main } from "../../src/cli.js";

async function run(args: string[]) {
  const stderr: string[] = [],
    stdout: string[] = [];
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
    return { exit: await main(["node", "loaf", ...args]), stderr, stdout };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

describe("pre-context catalog outlet", () => {
  test("invalid format stays text-only and includes catalog recovery guidance", async () => {
    const result = await run(["status", "--format", "yaml", "--format=json"]);
    expect(result).toMatchObject({ exit: 2, stdout: [] });
    expect(result.stderr).toHaveLength(1);
    expect(result.stderr[0]).toContain("INVALID_FORMAT");
    expect(result.stderr[0]).toContain("yaml");
    expect(result.stderr[0]).toContain("\n  fix: ");
    expect(result.stderr[0]).toContain("\n  see: ");
    expect(result.stderr[0]).not.toMatch(/^\{/);
  });
  test("mutex failure respects any-valid-json and retains original flag array", async () => {
    const result = await run(["status", "--plain", "--format=json"]);
    expect(result).toMatchObject({ exit: 2, stdout: [] });
    expect(result.stderr).toHaveLength(1);
    expect(JSON.parse(result.stderr[0]!)).toEqual({
      ok: false,
      code: "MUTUALLY_EXCLUSIVE_FLAGS",
      message: "mutually exclusive flags in the same invocation: --plain, --format=json",
      detail: { conflicting: ["--plain", "--format=json"] },
    });
  });
});
