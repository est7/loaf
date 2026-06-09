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
  test("static: each await mutate(Batch) site's ctx contains registryWriter: registryWriterDeps", async () => {
    const source = await readRepo("src/cli.tsx");

    // Phase W8: mctxFor factory now lives in src/cli/command-mutator.ts.
    // Verify the factory wires the field there.
    const mutatorSource = await readRepo("src/cli/command-mutator.ts");
    expect(
      /const\s+mctxFor\s*=[\s\S]{0,400}?registryWriter\s*:\s*registryWriterDeps/.test(
        mutatorSource,
      ),
      "mctxFor factory must wire `registryWriter: registryWriterDeps` in command-mutator.ts",
    ).toBe(true);

    // Collect names of locally-defined ctx variables that carry
    // `registryWriter: registryWriterDeps` — either as an inline object literal
    // OR assigned from the `mctxFor` factory.
    const KNOWN_GOOD_CTX_NAMES = new Set<string>();
    const ctxDefRe =
      /const\s+(\w+)\s*(?::\s*\w+\s*)?=\s*\{[^}]*?registryWriter\s*:\s*registryWriterDeps[^}]*?\};/gs;
    for (const m of source.matchAll(ctxDefRe)) {
      KNOWN_GOOD_CTX_NAMES.add(m[1]!);
    }
    // Phase W8: bypass sites use mutator.mctxFor(...)
    for (const m of source.matchAll(/const\s+(\w+)\s*=\s*(?:mutator\.)?mctxFor\(/g)) {
      KNOWN_GOOD_CTX_NAMES.add(m[1]!);
    }

    const lines = source.split("\n");
    const misses: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const callMatch = /await\s+(mutate(?:Batch)?)\s*\(/.exec(line);
      if (!callMatch) continue;

      // Walk forward, accumulating until we close the outermost paren.
      let depth = 0;
      let slice = "";
      const startCol = callMatch.index + callMatch[0].length - 1;
      let scan = true;
      for (let j = i; j < lines.length && scan; j++) {
        const text = j === i ? lines[j]!.slice(startCol) : lines[j]!;
        for (let k = 0; k < text.length; k++) {
          const ch = text[k];
          slice += ch;
          if (ch === "(") depth++;
          else if (ch === ")") {
            depth--;
            if (depth === 0) {
              scan = false;
              break;
            }
          }
        }
        slice += "\n";
      }

      // Inline literal check
      if (/registryWriter\s*:\s*registryWriterDeps/.test(slice)) continue;

      // Direct factory call as the ctx arg: `mutateBatch(batch, mctxFor(...))` or
      // `mutateBatch(batch, mutator.mctxFor(...))` (Phase W8 bypass sites)
      if (/(?:mutator\.)?mctxFor\(/.test(slice)) continue;

      // Named-ctx check
      const tailMatch = /(\w+)\s*,?\s*\)\s*$/.exec(slice.trim());
      if (tailMatch && KNOWN_GOOD_CTX_NAMES.has(tailMatch[1]!)) continue;

      misses.push(`line ${i + 1}: await ${callMatch[1]}(...) — missing registryWriter wiring`);
    }

    expect(misses).toEqual([]);
    // Sanity: the mutator pipeline is centralized behind `mutator.run` (was:
    // `runMutator` pre-W8). The remaining textual `await mutate(Batch)` sites
    // are the helper internals and the sponsored tasks-add bypass sites.
    // Guard that a representative number of call sites route through the
    // centralized helper.
    const mutatorRunCalls = source.match(/await\s+mutator\.run\s*\(/g)?.length ?? 0;
    expect(mutatorRunCalls).toBeGreaterThanOrEqual(25);
  });
});
