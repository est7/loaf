// Phase 16 SC-7 — mutator-ctx audit: every `await mutate(Batch)?` site
// in cli.tsx carries `registryWriter: registryWriterDeps`, either inline
// in the ctx object literal OR via a known-good named ctx (`mctx`).
//
// This mirrors the SC-6c P12 audit shape (codex r277 lesson — multi-line
// ctx variants were missed by naive `replace_all`). Catches the same bug
// class for the SC-7 `registryWriter` field.
//
// Phase W8 update: mctxFor factory moved to src/cli/command-mutator.ts;
// runMutator renamed to mutator.run in cli.tsx. Patterns updated accordingly.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function readRepo(rel: string): Promise<string> {
  return await fs.readFile(path.join(REPO_ROOT, rel), "utf8");
}

describe("SC-7 — every mutator call carries registryWriter in MutateContext", () => {
  test("static: command handlers cannot bypass CommandMutator registry wiring", async () => {
    const familyDir = path.join(REPO_ROOT, "src", "cli", "commands");
    const familyFiles = (await fs.readdir(familyDir, { recursive: true })).filter(
      (f) => f.endsWith(".tsx") || f.endsWith(".ts"),
    );
    const familySources = await Promise.all(
      familyFiles.map((f) => fs.readFile(path.join(familyDir, f), "utf8")),
    );
    const source = familySources.join("\n");

    const mutatorSource = await readRepo("src/cli/command-mutator.ts");
    expect(
      /const\s+createMutationContext\s*=[\s\S]{0,400}?registryWriter\s*:\s*registryWriterDeps/.test(
        mutatorSource,
      ),
      "CommandMutator must wire `registryWriter: registryWriterDeps` in its private context factory",
    ).toBe(true);
    expect(source).not.toMatch(/from\s+["'][^"']*journal-mutate\.js["']/);
    expect(source).not.toMatch(/\b(?:mutator\.)?(?:mctxFor|finishMutate)\b/);
    expect(source).not.toMatch(/\bawait\s+mutate(?:Batch)?\s*\(/);
  });
});
