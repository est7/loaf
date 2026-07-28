// Phase 16 SC-10 — regression gate: ERROR_CATALOG fix_templates must not
// recommend `--schema` on commands that do not support it.
//
// Schema emission is limited to the explicitly registered mutators
// mutators (spec add-req / spec add-scenario / spec add-visual / tasks
// add / evidence add / tasks submit). Other input-consuming commands
// (spec submit / tasks amend / etc.) do NOT accept `--schema`. Stale fix templates
// that suggest `loaf spec submit --schema` or `loaf <cmd> --schema`
// without qualification would mislead users and break shell scripts.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ERROR_CATALOG_PATH = path.join(REPO_ROOT, "src/core/error-catalog.ts");

const COMMANDS_WITHOUT_SCHEMA: ReadonlyArray<string> = [
  // input-consuming commands without a registered authoring schema
  "spec submit",
  "tasks amend",
  "profile escalate",
];

describe("SC-10 — error-catalog.ts fix_template hygiene", () => {
  test("no fix_template recommends `<cmd> --schema` for a command that doesn't support it", async () => {
    const source = await fs.readFile(ERROR_CATALOG_PATH, "utf8");
    const offenders: string[] = [];
    for (const cmd of COMMANDS_WITHOUT_SCHEMA) {
      const literal = `${cmd} --schema`;
      if (source.includes(literal)) {
        offenders.push(
          `stale fix_template recommends \`loaf ${literal}\` but ${cmd} does not accept --schema`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  test("MISSING_INPUT and SCHEMA_VALIDATION_FAILED fix_templates qualify `--schema` scope", async () => {
    const source = await fs.readFile(ERROR_CATALOG_PATH, "utf8");
    // Find the two catalog entries and check their wording acknowledges
    // the schema-emitter scope: either names the capability /
    // "Phase 16 SC-10" / "when supported by the command", OR enumerates
    // the supported mutators explicitly.
    const missingInputBlock = extractCatalogBlock(source, "MISSING_INPUT");
    const schemaFailedBlock = extractCatalogBlock(source, "SCHEMA_VALIDATION_FAILED");
    expect(missingInputBlock).not.toBe("");
    expect(schemaFailedBlock).not.toBe("");
    for (const [name, block] of [
      ["MISSING_INPUT", missingInputBlock],
      ["SCHEMA_VALIDATION_FAILED", schemaFailedBlock],
    ] as const) {
      const qualified =
        block.includes("batch-capable") ||
        block.includes("schema-capable") ||
        block.includes("SC-10") ||
        block.includes("when supported by the command");
      if (!qualified) {
        throw new Error(
          `${name} fix_template mentions \`--schema\` but does not qualify the SC-10 scope ` +
            `(expected one of: "batch-capable" / "SC-10" / "when supported by the command")`,
        );
      }
    }
  });
});

/** Extract the multi-line catalog entry block for a given code name. */
function extractCatalogBlock(source: string, codeName: string): string {
  const startIdx = source.indexOf(`  ${codeName}: {`);
  if (startIdx === -1) return "";
  // Find the closing `  },` for this entry.
  const endIdx = source.indexOf("\n  },\n", startIdx);
  if (endIdx === -1) return source.slice(startIdx);
  return source.slice(startIdx, endIdx);
}
