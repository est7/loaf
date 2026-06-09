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

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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
  "doctor", // bare + --rebuild both go through the same handler
  "sessions list", // Phase 16 SC-9b
  "verify status", // Phase 16 SC-9a-1
  "check", // Phase 16 SC-9c
  // Phase 16 SC-10 — `--schema` modifier mode on 5 batch-capable mutators
  // + 5 `<kind> schema` artifact subs. All are read-only schema dumps.
  "spec add-req --schema",
  "spec add-scenario --schema",
  "spec add-visual --schema",
  "tasks add --schema",
  "evidence add --schema",
  "spec schema",
  "tasks schema",
  "evidence schema",
  "finding schema",
  "state schema",
  "spec edit", // Phase 16 SC-12a-2 (wrapping mutator)
  "handoff", // Phase 16 SC-13a (projection-writer)
  "tui", // Phase 16 SC-14 (read-only)
  "config init", // rev 5.0 (scaffold-writer) — rejects --dry-run
];

/** Escape regex metacharacters in a literal label. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("SC-6c — positive table: every read-only command has rejectIfDryRun marker", () => {
  test('static: each table entry has rejectIfDryRun("<label>"...) in src/cli.tsx', async () => {
    const source = await readRepo("src/cli.tsx");
    const misses: string[] = [];
    for (const label of READ_ONLY_COMMANDS) {
      // Codex r336 P4: strict regex boundary check. The label must be
      // followed by `)` (1-arg form) OR `,` (2-arg form like wrapping
      // mutator `rejectIfDryRun("spec edit", "wrapping")`). Doctor
      // handler uses a ternary; allow its literal as a special case.
      let found: boolean;
      if (label === "doctor") {
        found = source.includes(`rejectIfDryRun(opts.rebuild ? "doctor --rebuild" : "doctor"`);
      } else {
        const re = new RegExp(`rejectIfDryRun\\("${escapeRegex(label)}"\\s*(?:,|\\))`);
        found = re.test(source);
      }
      if (!found) {
        misses.push(`'${label}': no matching rejectIfDryRun("<label>"...) call in src/cli.tsx`);
      }
    }
    expect(misses).toEqual([]);
  });
});

describe("SC-13b — §10.7 dry-run classification ↔ runtime/SC-6c drift gate (codex r349)", () => {
  test("`resume` is NOT in the §10.7 Read-only list (it's a mutator)", async () => {
    const protocolText = await readRepo("docs/protocol.md");
    // Find the Read-only command list line (single line listing in §10.7)
    const readOnlyLine = protocolText
      .split("\n")
      .find((line) => line.includes("Read-only 命令") && line.includes("status"));
    expect(readOnlyLine, "expected to find §10.7 Read-only commands row").toBeDefined();
    // Match a word-boundary `resume` (not "resumes" / "resumed" / "session:resumed")
    const hasResume = /[\s/(]resume[\s/),]/.test(readOnlyLine!);
    expect(
      hasResume,
      "docs/protocol.md §10.7 Read-only list still mentions `resume` — but resume is a mutator (Phase 16 SC-13b); move it to the Mutating list",
    ).toBe(false);
  });

  test("`resume` IS in the §10.7 Mutating list (Phase 16 SC-13b)", async () => {
    const protocolText = await readRepo("docs/protocol.md");
    const mutatingLine = protocolText
      .split("\n")
      .find((line) => line.includes("Mutating 命令") && line.includes("advance"));
    expect(mutatingLine, "expected to find §10.7 Mutating commands row").toBeDefined();
    const hasResume = /[\s/(`]resume[\s/),`*]/.test(mutatingLine!);
    expect(
      hasResume,
      "docs/protocol.md §10.7 Mutating list must include `resume` (Phase 16 SC-13b mutator)",
    ).toBe(true);
  });

  test("§10.7 has a `Projection-writer` category for `handoff` (Phase 16 SC-13a)", async () => {
    const protocolText = await readRepo("docs/protocol.md");
    expect(
      protocolText.includes("Projection-writer"),
      "docs/protocol.md §10.7 must include a Projection-writer category covering `handoff`",
    ).toBe(true);
  });

  test("§10.7 has a `Scaffold-writer` category for `config init`", async () => {
    const protocolText = await readRepo("docs/protocol.md");
    const scaffoldLine = protocolText
      .split("\n")
      .find(
        (line) =>
          line.startsWith("|") && line.includes("Scaffold-writer") && line.includes("config init"),
      );
    expect(
      scaffoldLine,
      "docs/protocol.md §10.7 must include a Scaffold-writer category covering `config init`",
    ).toBeDefined();
    expect(scaffoldLine).toContain('"scaffold-writer"');
  });

  test("§10.7 Hook category row exists (Phase 16 SC-15a)", async () => {
    const protocolText = await readRepo("docs/protocol.md");
    const hookLine = protocolText
      .split("\n")
      .find((line) => line.startsWith("|") && line.includes("Hook 入口") && line.includes("hook"));
    expect(hookLine, "expected §10.7 Hook 入口 row").toBeDefined();
  });

  test("`hook` is NOT in non-Hook §10.7 rows (Phase 16 SC-15a — codex r364 P2)", async () => {
    const protocolText = await readRepo("docs/protocol.md");
    const lines = protocolText.split("\n");
    const CATEGORIES = [
      "Mutating 命令",
      "Read-only 命令",
      "Wrapping 命令",
      "Projection-writer 命令",
    ] as const;
    for (const category of CATEGORIES) {
      const row = lines.find((l) => {
        if (!l.startsWith("|") || !l.includes(category)) return false;
        if (category === "Mutating 命令") return l.includes("走 §11.2 10-step transaction");
        // Other categories use either `reject` or `**reject**` (markdown bold).
        return /reject\*?\*?\s*`--dry-run`/.test(l);
      });
      expect(row, `expected §10.7 ${category} dry-run row to exist`).toBeDefined();
      const hasHook = /[\s/(`]hook[\s/),`*]/.test(row!);
      expect(
        hasHook,
        `§10.7 ${category} row mentions \`hook\` — but hooks have their own dedicated category; remove from ${category}`,
      ).toBe(false);
    }
  });

  test("`tui` is NOT in the §10.7 dry-run Wrapping row (Phase 16 SC-14 — TUI is read-only for dry-run, not wrapping)", async () => {
    const protocolText = await readRepo("docs/protocol.md");
    // Target the §10.7 dry-run table row specifically — it's a table
    // row (starts with `|`) AND mentions reject `--dry-run`. The
    // signal-handling prose at §10.4 also uses "Wrapping 命令" but for
    // signal handling, not dry-run classification. Filter to table
    // rows only.
    const wrappingDryRunRow = protocolText
      .split("\n")
      .find(
        (line) =>
          line.startsWith("|") &&
          line.includes("Wrapping 命令") &&
          line.includes("reject `--dry-run`"),
      );
    expect(wrappingDryRunRow, "expected to find §10.7 Wrapping dry-run table row").toBeDefined();
    const hasTui = /[\s/(`]tui[\s/),`*]/.test(wrappingDryRunRow!);
    expect(
      hasTui,
      "docs/protocol.md §10.7 Wrapping dry-run row still mentions `tui` — but tui is read-only (Phase 16 SC-14); remove from Wrapping",
    ).toBe(false);
  });
});

describe("SC-6c — every mutator call carries dryRun in MutateContext", () => {
  test("static: each await mutate(Batch) site's ctx arg contains dryRun: ctx.dryRun", async () => {
    const source = await readRepo("src/cli.tsx");

    // Phase W8: mctxFor factory moved to src/cli/command-mutator.ts.
    // Verify the factory wires the field there.
    const mutatorSource = await readRepo("src/cli/command-mutator.ts");
    expect(
      /const\s+mctxFor\s*=[\s\S]{0,400}?dryRun\s*:\s*ctx\.dryRun/.test(mutatorSource),
      "mctxFor factory must wire `dryRun: ctx.dryRun` in command-mutator.ts",
    ).toBe(true);

    // Collect names of locally-defined ctx variables that carry
    // `dryRun: ctx.dryRun` — either as an inline object literal OR assigned
    // from the `mctxFor` factory. `mctx` is the common reuse pattern.
    const KNOWN_GOOD_CTX_NAMES = new Set<string>();
    const ctxDefRe =
      /const\s+(\w+)\s*(?::\s*\w+\s*)?=\s*\{[^}]*?dryRun\s*:\s*ctx\.dryRun[^}]*?\};/gs;
    for (const m of source.matchAll(ctxDefRe)) {
      KNOWN_GOOD_CTX_NAMES.add(m[1]!);
    }
    // Phase W8: bypass sites use mutator.mctxFor(...)
    for (const m of source.matchAll(/const\s+(\w+)\s*=\s*(?:mutator\.)?mctxFor\(/g)) {
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
      const startCol = callMatch.index + callMatch[0].length - 1; // at the '('
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

      // Direct factory call as the ctx arg: `mutateBatch(batch, mctxFor(...))` or
      // `mutateBatch(batch, mutator.mctxFor(...))` (Phase W8 bypass sites)
      if (/(?:mutator\.)?mctxFor\(/.test(slice)) continue;

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
    // Sanity: the mutator pipeline is centralized behind `mutator.run` (Phase
    // W8 rename from `runMutator`). The remaining textual `await mutate(Batch)`
    // sites are the helper internals and the sponsored tasks-add bypass sites.
    // Guard that a representative number of call sites route through the
    // centralized helper.
    const mutatorRunCalls = source.match(/await\s+mutator\.run\s*\(/g)?.length ?? 0;
    expect(mutatorRunCalls).toBeGreaterThanOrEqual(25);
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
