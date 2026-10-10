import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ERROR_CATALOG } from "../../src/core/error-catalog.js";
import {
  auditDiagnosticSource,
  auditDiagnosticProducers,
} from "../helpers/diagnostic-producer-audit.js";

describe("diagnostic producer audit", () => {
  test("literal outlet codes are registered; dynamic codes and opaque details remain visible", async () => {
    const records = await auditDiagnosticProducers(
      fileURLToPath(new URL("../..", import.meta.url)),
    );
    const outlets = records.filter((row) => row.boundary === "outlet");
    expect(
      outlets.some(
        (row) => row.code === "SCHEMA_VALIDATION_FAILED" && row.file.includes("integrations"),
      ),
    ).toBe(true);
    expect(outlets.some((row) => row.code === null)).toBe(true);
    expect(outlets.some((row) => row.detailKeys === null)).toBe(true);
    for (const row of outlets) {
      if (row.code !== null)
        expect(Object.hasOwn(ERROR_CATALOG, row.code), `${row.file}:${row.line} ${row.code}`).toBe(
          true,
        );
    }
    for (const row of records) {
      if (row.code !== null && Object.hasOwn(ERROR_CATALOG, row.code)) {
        expect(
          ERROR_CATALOG[row.code as keyof typeof ERROR_CATALOG].detail_keys,
          `${row.file}:${row.line}`,
        ).toBeDefined();
      }
    }
  });

  test("spreads, dynamic codes and existing site adapters cannot silently disappear from the inventory", () => {
    const rows = auditDiagnosticSource(
      "probe.ts",
      `
      ctx.emitFailure("USAGE", "literal", { value: 1 });
      ctx.failure(result.code, result.message, result.detail);
      const failure = { ok: false, code: "TRANSITION_ILLEGAL", detail: { ...current } };
      diagnostic("ALREADY_STARTED", {kind});
      ctx.emitNoSessionFailure(site, feature, detail);
    `,
    );
    expect(rows.map((row) => [row.boundary, row.code, row.detailKeys])).toEqual([
      ["outlet", "USAGE", ["value"]],
      ["outlet", null, null],
      ["result", "TRANSITION_ILLEGAL", null],
      ["constructor", "ALREADY_STARTED", ["kind"]],
      ["outlet", "NO_SESSION", null],
    ]);
  });
});
