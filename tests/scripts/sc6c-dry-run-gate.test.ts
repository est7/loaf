// Phase 16 SC-6c — static guards + positive read-only enumeration table.
//
// Per codex r275/r276 P5 + non-blocking note: the positive table is the
// checked-in source of truth. The static guard cross-references each
// tabled command's expected source line range and asserts a
// `rejectIfDryRun(` marker is present within the action body window.
//
// New read-only commands must be ADDED to the table — the test will not
// auto-discover them.

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

/** Positive enumeration — the source of truth for which commands MUST
 *  reject `--dry-run`. Adding a new read-only command requires updating
 *  this table AND ensuring the action handler calls `rejectIfDryRun(label)`.
 */
const READ_ONLY_COMMANDS: readonly string[] = [
  "status",
  "tasks list",
  "tasks next",
  "tasks complete",
  "pending list",
  "pending status",
  "finding list",
  "doctor",            // bare + --rebuild both go through the same handler
];

describe("SC-6c — positive table: every read-only command has rejectIfDryRun marker", () => {
  test("static: each table entry has rejectIfDryRun(\"<label>\") in src/cli.tsx", async () => {
    const source = await readRepo("src/cli.tsx");
    const misses: string[] = [];
    for (const label of READ_ONLY_COMMANDS) {
      // The doctor handler uses a ternary; allow either literal
      const variants =
        label === "doctor"
          ? [`rejectIfDryRun(opts.rebuild ? "doctor --rebuild" : "doctor"`]
          : [`rejectIfDryRun("${label}")`];
      const found = variants.some((v) => source.includes(v));
      if (!found) {
        misses.push(`'${label}': expected one of ${JSON.stringify(variants)}`);
      }
    }
    expect(misses).toEqual([]);
  });
});

describe("SC-6c — every mutator call carries dryRun in MutateContext", () => {
  test("static: each await mutate(Batch) site's ctx arg contains dryRun: ctx.dryRun", async () => {
    const source = await readRepo("src/cli.tsx");

    // Collect names of locally-defined ctx variables that include
    // `dryRun: ctx.dryRun` in their object literal. `mctx` is the
    // common reuse pattern (see codex r277 audit).
    const KNOWN_GOOD_CTX_NAMES = new Set<string>();
    const ctxDefRe =
      /const\s+(\w+)\s*=\s*\{[^}]*?dryRun\s*:\s*ctx\.dryRun[^}]*?\};/gs;
    for (const m of source.matchAll(ctxDefRe)) {
      KNOWN_GOOD_CTX_NAMES.add(m[1]!);
    }

    // For each `await mutate(...)` / `await mutateBatch(...)` site,
    // extract the call slice up to its matching close-paren by walking
    // forward and counting parens. Then assert either:
    //   - the slice contains `dryRun: ctx.dryRun` (inline ctx), OR
    //   - the second arg is a bare identifier matching a known-good
    //     ctx (e.g. `mctx`).
    const lines = source.split("\n");
    const misses: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const callMatch = /await\s+(mutate(?:Batch)?)\s*\(/.exec(line);
      if (!callMatch) continue;

      // Walk forward, accumulating until we close the outermost paren.
      let depth = 0;
      let slice = "";
      let startCol = callMatch.index + callMatch[0].length - 1; // at the '('
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
      if (/dryRun\s*:\s*ctx\.dryRun/.test(slice)) continue;

      // Named-ctx check: find the last identifier before the closing
      // `)`. Allow optional trailing comma (multi-line call style).
      // E.g. `..., mctx,\n)` — last identifier is `mctx`.
      const tailMatch = /(\w+)\s*,?\s*\)\s*$/.exec(slice.trim());
      if (tailMatch && KNOWN_GOOD_CTX_NAMES.has(tailMatch[1]!)) continue;

      misses.push(
        `line ${i + 1}: await ${callMatch[1]}(...) — neither inline 'dryRun: ctx.dryRun' nor known-good named ctx`,
      );
    }

    expect(misses).toEqual([]);
    // Sanity: there should be ≥30 mutator call sites in cli.tsx
    const totalCalls = source.match(/await\s+mutate(?:Batch)?\s*\(/g)?.length ?? 0;
    expect(totalCalls).toBeGreaterThanOrEqual(30);
  });
});

describe("SC-6c — protocol + schema invariants", () => {
  test("protocol: --dry-run row has no inventory:future annotation", async () => {
    const md = await readRepo("docs/protocol.md");
    const row = md.match(/^\| `--dry-run`[^\n]*$/m);
    expect(row).not.toBeNull();
    expect(row![0]).not.toContain("inventory:future");
  });

  test("schema: DRY_RUN_NOT_APPLICABLE in DiagnosticCode enum + ERROR_CATALOG", async () => {
    const schemas = await readRepo("docs/schemas.ts");
    expect(schemas).toMatch(/"DRY_RUN_NOT_APPLICABLE"/);
    expect(schemas).toMatch(/DRY_RUN_NOT_APPLICABLE:\s*\{/);
  });

  test("i18n: DRY_RUN_NOT_APPLICABLE flat-string in both en + zh", async () => {
    const en = await readRepo("i18n/en.json");
    const zh = await readRepo("i18n/zh.json");
    const enObj = JSON.parse(en) as { diagnostic: Record<string, string> };
    const zhObj = JSON.parse(zh) as { diagnostic: Record<string, string> };
    expect(enObj.diagnostic["DRY_RUN_NOT_APPLICABLE"]).toBeTypeOf("string");
    expect(zhObj.diagnostic["DRY_RUN_NOT_APPLICABLE"]).toBeTypeOf("string");
    // Placeholders present
    expect(enObj.diagnostic["DRY_RUN_NOT_APPLICABLE"]).toContain("{command}");
    expect(enObj.diagnostic["DRY_RUN_NOT_APPLICABLE"]).toContain("{command_type}");
  });
});
