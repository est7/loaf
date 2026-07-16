// Phase 16 SC-8 — static guards + i18n / protocol invariants.
//
// Per codex r285 plan + r286 GO:
//   1. protocol §10.3 row no longer has inventory:future
//   2. all 5 dispatch DiagnosticCodes present in en.json + zh.json
//      (FEATURE_NOT_FOUND, FEATURE_AMBIGUOUS, SESSION_CWD_MISMATCH,
//       SESSION_SHORT_AMBIGUOUS, SESSION_NOT_FOUND — the last is
//       the new SC-8 code)
//   3. SESSION_NOT_FOUND present in ERROR_CATALOG and its derived DiagnosticCode

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DiagnosticCode, ERROR_CATALOG } from "../../src/core/error-catalog.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function readRepo(rel: string): Promise<string> {
  return await fs.readFile(path.join(REPO_ROOT, rel), "utf8");
}

describe("SC-8 — protocol + schema invariants", () => {
  test("protocol §10.7: --session row no longer carries inventory:future", async () => {
    const md = await readRepo("docs/protocol.md");
    const row = md.match(/^\| `--session <UUID>`[^\n]*$/m);
    expect(row).not.toBeNull();
    expect(row![0]).not.toContain("inventory:future");
  });

  test("schemas: SESSION_NOT_FOUND in ERROR_CATALOG + derived DiagnosticCode", () => {
    expect(ERROR_CATALOG).toHaveProperty("SESSION_NOT_FOUND");
    expect(DiagnosticCode.options).toContain("SESSION_NOT_FOUND");
  });

  test("i18n: all 5 SC-8 codes flat-string in en + zh diagnostic namespace", async () => {
    const en = JSON.parse(await readRepo("i18n/en.json")) as { diagnostic: Record<string, string> };
    const zh = JSON.parse(await readRepo("i18n/zh.json")) as { diagnostic: Record<string, string> };
    const codes = [
      "FEATURE_NOT_FOUND",
      "FEATURE_AMBIGUOUS",
      "SESSION_CWD_MISMATCH",
      "SESSION_SHORT_AMBIGUOUS",
      "SESSION_NOT_FOUND",
    ];
    for (const code of codes) {
      expect(en.diagnostic[code]).toBeTypeOf("string");
      expect(zh.diagnostic[code]).toBeTypeOf("string");
    }
  });
});

describe("SC-8 — feature-addressed actions go through dispatchOrFail", () => {
  test("static: every .action( block referencing opts.feature now calls dispatchOrFail", async () => {
    // Phase W8 P1: command registrations moved to per-family files. Scan all of them.
    const familyDir = path.join(REPO_ROOT, "src", "cli", "commands");
    const familyFiles = (await fs.readdir(familyDir)).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
    const familySources = await Promise.all(familyFiles.map((f) => fs.readFile(path.join(familyDir, f), "utf8")));
    const source = familySources.join("\n");
    const lines = source.split("\n");
    const actionStarts = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*\.action\(/.test(line));

    expect(actionStarts.length).toBeGreaterThanOrEqual(33);

    const misses: string[] = [];
    for (const block of actionStarts) {
      const slice = lines.slice(block.index, block.index + 60).join("\n");
      // Actions that reference opts.feature must call dispatchOrFail
      // (which mutates opts and records traceTarget). Actions that don't
      // reference opts.feature (e.g. `loaf start` positional) are exempt.
      // Match `opts.feature` (the feature-name field) but NOT
      // `opts.featureDir` / `opts.featureName` / `opts.feature-X`.
      // Negative lookahead excludes the common collisions.
      const referencesOptsFeature = /opts\.feature(?!Dir|Name|[A-Za-z-])/.test(slice);
      const callsDispatchOrFail = /dispatchOrFail\(/.test(slice);
      const isNoFeatureMarker = /\/\/\s*no-feature/.test(slice);
      // `// no-dispatch` marks intentional bypass (e.g. doctor --rebuild,
      // which is for recovering corrupt projections — going through
      // dispatch would prematurely surface SnapshotStale).
      const isNoDispatchMarker = /\/\/\s*no-dispatch/.test(slice);
      if (
        referencesOptsFeature &&
        !callsDispatchOrFail &&
        !isNoFeatureMarker &&
        !isNoDispatchMarker
      ) {
        misses.push(
          `line ${block.index + 1}: action references opts.feature but doesn't call dispatchOrFail`,
        );
      }
    }
    expect(misses).toEqual([]);
  });
});
