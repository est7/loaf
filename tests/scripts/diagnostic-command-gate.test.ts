import { promises as fs } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { ERROR_CATALOG } from "../../src/core/error-catalog.js";
import { collectInventory, type Inventory } from "./inventory/help-collector.js";
import { diagnosticCommandFailures, runtimeErrorStrings } from "./inventory/diagnostic-commands.js";

let inventory: Inventory;
beforeAll(async () => {
  inventory = await collectInventory();
});

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const file = path.join(dir, entry.name);
        return entry.isDirectory()
          ? sourceFiles(file)
          : Promise.resolve(/\.tsx?$/.test(file) ? [file] : []);
      }),
    )
  ).flat();
}

function catalogTemplates(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    /^(?:zh_)?(?:message|fix)_template$/.test(key) && typeof item === "string"
      ? [item]
      : catalogTemplates(item),
  );
}

describe("diagnostic recommendations reference the live Commander tree", () => {
  test("catalog and runtime error strings contain no nonexistent commands/options", async () => {
    const findings = catalogTemplates(ERROR_CATALOG).flatMap((text) =>
      diagnosticCommandFailures(text, inventory),
    );
    for (const file of await sourceFiles("src")) {
      const source = await fs.readFile(file, "utf8");
      for (const text of runtimeErrorStrings(source, file)) {
        findings.push(
          ...diagnosticCommandFailures(text, inventory).map((finding) => `${file}: ${finding}`),
        );
      }
    }
    expect(findings).toEqual([]);
  });

  test("negative controls catch a nonexistent leaf and a nonexistent flag", () => {
    expect(
      diagnosticCommandFailures("run `loaf tasks phantom --feature <name>`", inventory),
    ).toContain("unknown command: loaf tasks phantom");
    expect(diagnosticCommandFailures("run `loaf doctor --phantom`", inventory)).toContain(
      "unknown option: loaf doctor --phantom",
    );
    expect(diagnosticCommandFailures("run `loaf phantom`", inventory)).toContain(
      "unknown command: loaf phantom",
    );
    expect(
      diagnosticCommandFailures("run `loaf <cmd> --schema --list-events`", inventory),
    ).toContain("unknown option: loaf * --list-events");
  });

  test("templates, subclass messages and quoted message fields keep command flags visible", () => {
    const source = [
      "throw new Error(`run loaf doctor --feature ${feature} --phantom`);",
      'class Failure extends Error { constructor() { super("run `loaf doctor --phantom`"); } }',
      'const failure = { "message": "run `loaf tasks phantom`" };',
    ].join("\n");
    const strings = runtimeErrorStrings(source, "fixture.ts");
    expect(strings).toHaveLength(3);
    expect(strings.flatMap((text) => diagnosticCommandFailures(text, inventory))).toEqual([
      "unknown option: loaf doctor --phantom",
      "unknown option: loaf doctor --phantom",
      "unknown command: loaf tasks phantom",
    ]);
  });

  test("partial examples and generic capability examples resolve without executing actions", () => {
    expect(
      diagnosticCommandFailures(
        "run `loaf tasks add --input <file>` or `loaf <cmd> --schema --format=json`",
        inventory,
      ),
    ).toEqual([]);
    expect(diagnosticCommandFailures("see `loaf <cmd> --help`", inventory)).toEqual([]);
    expect(
      runtimeErrorStrings(
        '// new Error("loaf phantom")\nthrow new Error("run `loaf doctor --phantom`");',
        "fixture.ts",
      ),
    ).toEqual(["run `loaf doctor --phantom`"]);
  });
});
