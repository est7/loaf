// Phase 16 SC-7 — mutator-ctx audit: every `await mutate(Batch)?` site
// in cli.tsx carries `registryWriter: registryWriterDeps`, either inline
// in the ctx object literal OR via a known-good named ctx (`mctx`).
//
// This mirrors the SC-6c P12 audit shape (codex r277 lesson — multi-line
// ctx variants were missed by naive `replace_all`). Catches the same bug
// class for the SC-7 `registryWriter` field.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..",
);

async function readRepo(rel: string): Promise<string> {
  return await fs.readFile(path.join(REPO_ROOT, rel), "utf8");
}

describe("SC-7 — every mutator call carries registryWriter in MutateContext", () => {
  test("static: each await mutate(Batch) site's ctx contains registryWriter: registryWriterDeps", async () => {
    const source = await readRepo("src/cli.tsx");

    // The single wired-ctx factory: every mutator ctx now flows through
    // `mctxFor(...)`. Verify the factory wires the field once, then accept any
    // site whose ctx arg is mctxFor(...) or a var assigned from it.
    expect(
      /const\s+mctxFor\s*=[\s\S]{0,400}?registryWriter\s*:\s*registryWriterDeps/.test(source),
      "mctxFor factory must wire `registryWriter: registryWriterDeps`",
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
    for (const m of source.matchAll(/const\s+(\w+)\s*=\s*mctxFor\(/g)) {
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

      // Direct factory call as the ctx arg: `mutateBatch(batch, mctxFor(...))`
      if (/\bmctxFor\(/.test(slice)) continue;

      // Named-ctx check
      const tailMatch = /(\w+)\s*,?\s*\)\s*$/.exec(slice.trim());
      if (tailMatch && KNOWN_GOOD_CTX_NAMES.has(tailMatch[1]!)) continue;

      misses.push(
        `line ${i + 1}: await ${callMatch[1]}(...) — missing registryWriter wiring`,
      );
    }

    expect(misses).toEqual([]);
    // Sanity: the mutator pipeline is centralized behind `runMutator`, which
    // builds the wired `mctx` once. The remaining textual `await mutate(Batch)`
    // sites are the helper internals, the two pre-stamped buildSpecSubmitBatch
    // sites, and the sponsored tasks-add exclusion (per-entry `at`) — all
    // covered by the `misses` check above.
    // Guard that a representative number of call sites route through the
    // centralized helper (was: ≥30 inline ctx literals pre-L1 migration).
    const runMutatorCalls = source.match(/await\s+runMutator\s*\(/g)?.length ?? 0;
    expect(runMutatorCalls).toBeGreaterThanOrEqual(25);
  });
});
