import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const COMMANDS_DIR = fileURLToPath(new URL("../../src/cli/commands", import.meta.url));

async function commandSources(dir = COMMANDS_DIR): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const sources = await Promise.all(
    entries.map(async (entry): Promise<string> => {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) return commandSources(target);
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) return "";
      return fs.readFile(target, "utf8");
    }),
  );
  return sources.join("\n");
}

describe("CLI input-ingestion boundary", () => {
  test("command handlers do not compose classification, reads, or TTY rejection", async () => {
    const source = await commandSources();

    expect(source).not.toMatch(/from\s+["'][^"']*\/input-(?:source|read)\.js["']/);
    expect(source).not.toMatch(/\bparseInputSource\s*\(/);
    expect(source).not.toMatch(/\breadJsonInput\s*\(/);
    expect(source).not.toMatch(/source\.kind\s*===\s*["']stdin["']/);
  });
});
