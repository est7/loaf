// Phase 16 SC-5a — cross-file gates for `--format text|json` migration.
//
// Per r249 GO trace:
//   - RED #8  : INVALID_FORMAT is registered in DiagnosticCode + ERROR_CATALOG
//               + both i18n bundles; diagnostic-baseline.json unchanged.
//   - RED #12 : placeholder symmetry — INVALID_FORMAT template placeholder
//               set is identical across docs/schemas.ts, i18n/en.json,
//               i18n/zh.json. Generalized to any single DiagnosticCode.
//   - RED #18 : FLAG_EXCLUSIONS (JSON-stringified) contains no "--json"
//               substring after the A1-honestly sweep.
//   - RED #19 : Surface-wide grep gate. No bare "--json" in current-contract
//               docs + production code. Allowlist limited to the exact
//               historical line 94 fragment in docs/protocol.md.
//
// These gates exist because:
//   - r245 P3 surfaced placeholder-drift class of bugs (codex r80 pattern).
//   - r246 P5 cleaned FLAG_EXCLUSIONS of removed flags and needed a
//     machine-checkable invariant.
//   - r247/r248/r249 P6/P7/P8 iterated on docs surface coverage — the
//     gate is the static enforcement so future PRs cannot regress.

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DiagnosticCode, ERROR_CATALOG, FLAG_EXCLUSIONS } from "../../docs/schemas.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRepo(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function extractPlaceholders(template: string): Set<string> {
  // Mustache-style {var} placeholders. Match [a-z_][a-z0-9_]* inside braces.
  const out = new Set<string>();
  const re = /\{([a-z_][a-z0-9_]*)\}/g;
  for (const m of template.matchAll(re)) out.add(m[1]!);
  return out;
}

describe("Phase 16 SC-5a — RED #8: INVALID_FORMAT catalog + i18n registration", () => {
  test("DiagnosticCode enum contains INVALID_FORMAT", () => {
    expect(DiagnosticCode.options).toContain("INVALID_FORMAT");
  });

  test("ERROR_CATALOG has INVALID_FORMAT entry with exit_code=2", () => {
    const entry = ERROR_CATALOG.INVALID_FORMAT;
    expect(entry).toBeDefined();
    expect(entry.exit_code).toBe(2);
    expect(typeof entry.message_template).toBe("string");
    expect(entry.message_template.length).toBeGreaterThan(0);
  });

  test("i18n/en.json + i18n/zh.json both define INVALID_FORMAT under diagnostic", () => {
    const en = JSON.parse(readRepo("i18n/en.json")) as { diagnostic: Record<string, string> };
    const zh = JSON.parse(readRepo("i18n/zh.json")) as { diagnostic: Record<string, string> };
    expect(typeof en.diagnostic["INVALID_FORMAT"]).toBe("string");
    expect(typeof zh.diagnostic["INVALID_FORMAT"]).toBe("string");
  });

  test("diagnostic-baseline.json remains empty (SC-1 lock holds; INVALID_FORMAT is registered, not baselined)", () => {
    const baselinePath = path.join(REPO_ROOT, "tests/scripts/inventory/diagnostic-baseline.json");
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { entries: unknown[] };
    expect(baseline.entries).toEqual([]);
  });
});

describe("Phase 16 SC-5a — RED #12: placeholder symmetry across catalog ↔ i18n", () => {
  test("INVALID_FORMAT placeholders match across docs/schemas.ts + i18n/en + i18n/zh", () => {
    const catalogTemplate = ERROR_CATALOG.INVALID_FORMAT.message_template;
    const en = JSON.parse(readRepo("i18n/en.json")) as { diagnostic: Record<string, string> };
    const zh = JSON.parse(readRepo("i18n/zh.json")) as { diagnostic: Record<string, string> };
    const enTemplate = en.diagnostic["INVALID_FORMAT"]!;
    const zhTemplate = zh.diagnostic["INVALID_FORMAT"]!;

    const catalogPlaceholders = extractPlaceholders(catalogTemplate);
    const enPlaceholders = extractPlaceholders(enTemplate);
    const zhPlaceholders = extractPlaceholders(zhTemplate);

    // All three must agree on the placeholder set; runtime emit site must
    // pass exactly these template vars. Drift fails the test (r80 pattern).
    expect(enPlaceholders).toEqual(catalogPlaceholders);
    expect(zhPlaceholders).toEqual(catalogPlaceholders);
  });

  test("INVALID_FORMAT canonical placeholders are {value} and {allowed_values_human}", () => {
    const catalogTemplate = ERROR_CATALOG.INVALID_FORMAT.message_template;
    const placeholders = extractPlaceholders(catalogTemplate);
    expect(placeholders).toEqual(new Set(["value", "allowed_values_human"]));
  });
});

describe("Phase 16 SC-5a — RED #18: FLAG_EXCLUSIONS contains no '--json' after A1", () => {
  test("FLAG_EXCLUSIONS JSON-stringified does not contain '--json'", () => {
    const serialized = JSON.stringify(FLAG_EXCLUSIONS);
    expect(serialized).not.toContain("--json");
  });

  test("FLAG_EXCLUSIONS.sets[output_format] normalization keys all start with '--format' (or set is reserved-empty)", () => {
    const outputFormat = FLAG_EXCLUSIONS.sets.find((s) => s.name === "output_format");
    expect(outputFormat).toBeDefined();
    const keys = Object.keys(outputFormat!.normalization);
    for (const k of keys) {
      expect(k.startsWith("--format")).toBe(true);
    }
  });
});

describe("Phase 16 SC-5a — RED #19: surface-wide '--json' grep gate", () => {
  // Files where bare `--json` MUST NOT appear after A1-honestly sweep.
  // Allowlist: an in-gate file may contain `--json` only if every hit
  // matches one of the entries in `allowedHistoryLineFragments`.
  const inGateFiles: string[] = [
    "docs/protocol.md",
    "docs/schemas.ts",
    "docs/e2e-scenarios.md",
    "docs/index.html",
    "docs/references/incremental-construction.md",
    "scripts/ga-package-smoke.sh",
    "src/cli.tsx",
    "src/cli/command-context.ts",
    "src/core/reducer.ts",
    "src/core/crash-log.ts",
  ];

  // Exact-content allowlist. A `--json` hit is allowed only if its line
  // contains one of these fragments verbatim. Per r248 P7: must be
  // exact historical/changelog prose, not broad substrings like "JSON
  // Schema" or "JSON 示例".
  const allowedHistoryLineFragments: string[] = [
    // docs/protocol.md line 94 — rev 3.2 cleanup changelog bullet
    // listing planned aliases (historical record per CLAUDE.md
    // "no fabricated history").
    "global flags 补齐(`--no-input` / `-v/--verbose` / `--quiet` / `--plain` alias / `--json` alias)",
  ];

  for (const rel of inGateFiles) {
    test(`${rel} contains no bare '--json' outside the historical allowlist`, () => {
      const text = readRepo(rel);
      const lines = text.split("\n");
      const offenders: Array<{ line: number; content: string }> = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.includes("--json")) continue;
        const allowed = allowedHistoryLineFragments.some((frag) => line.includes(frag));
        if (allowed) continue;
        offenders.push({ line: i + 1, content: line });
      }
      if (offenders.length > 0) {
        const detail = offenders.map((o) => `  ${rel}:${o.line}  ${o.content}`).join("\n");
        throw new Error(
          `RED #19 surface gate: ${offenders.length} unauthorized '--json' hit(s) in ${rel}:\n${detail}\n\n` +
            `Either rewrite to '--format json' / '--format=json', or extend allowedHistoryLineFragments in tests/scripts/sc5a-surface-gate.test.ts with the exact fragment (only for explicit historical/changelog prose).`,
        );
      }
    });
  }
});
