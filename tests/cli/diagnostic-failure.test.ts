import { describe, expect, test } from "vitest";
import fixtures from "../fixtures/diagnostic-rendering.json";
import { writeDiagnosticFailure } from "../../src/cli/diagnostic-failure.js";
import { createI18n, BUILTIN_BUNDLES } from "../../src/cli/i18n.js";
import {
  diagnostic,
  diagnosticVariant,
  type CatalogDiagnostic,
} from "../../src/core/error-catalog.js";

describe("catalog diagnostic outlet", () => {
  test.each(fixtures)("$code / $context has canonical English JSON and exact en/zh text", (row) => {
    // Frozen fixtures were captured from the catalog and existing site
    // templates before the renderer existed; expected strings are not
    // computed from the renderer or the mutable catalog under test.
    const input = { code: row.code, detail: row.detail } as CatalogDiagnostic;
    const before = JSON.stringify(input);
    for (const locale of ["en", "zh"] as const) {
      const lines: string[] = [];
      const writeStderr = (value: string) => {
        lines.push(value);
      };
      const i18n = createI18n(locale, BUILTIN_BUNDLES);
      expect(writeDiagnosticFailure(input, { format: "json", i18n, writeStderr })).toBe(2);
      expect(lines).toEqual([
        JSON.stringify({ ok: false, code: row.code, message: row.en_message, detail: row.detail }) +
          "\n",
      ]);
      lines.length = 0;
      expect(writeDiagnosticFailure(input, { format: "text", i18n, writeStderr })).toBe(2);
      expect(lines.join("")).toBe(locale === "en" ? row.en_text : row.zh_text);
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  test("catalog joins preserve the original machine arrays and additional fields", () => {
    const detail = { value: "yaml", allowed_values: ["text", "json"], extra: { accepted: true } };
    const input = diagnostic("INVALID_FORMAT", detail);
    const lines: string[] = [];
    writeDiagnosticFailure(input, {
      format: "text",
      i18n: createI18n("en", BUILTIN_BUNDLES),
      writeStderr: (s) => {
        lines.push(s);
      },
    });
    expect(lines.join("")).toContain("allowed: text|json");
    expect(input.detail).toBe(detail);
    lines.length = 0;
    writeDiagnosticFailure(input, {
      format: "json",
      i18n: createI18n("zh", BUILTIN_BUNDLES),
      writeStderr: (s) => {
        lines.push(s);
      },
    });
    expect(JSON.parse(lines.join("")).detail).toEqual(detail);
  });

  test("variant construction preserves zod subcode and chooses the existing context", () => {
    const input = diagnosticVariant("failure.handoff.pack_validation_failed", {
      subcode: "zod",
      issues: [{ message: "invalid" }],
    });
    expect(input).toEqual({
      code: "SCHEMA_VALIDATION_FAILED",
      detail: {
        subcode: "zod",
        issues: [{ message: "invalid" }],
        context: "failure.handoff.pack_validation_failed",
      },
    });
    const lines: string[] = [];
    writeDiagnosticFailure(input, {
      format: "json",
      i18n: createI18n("zh", BUILTIN_BUNDLES),
      writeStderr: (s) => {
        lines.push(s);
      },
    });
    expect(JSON.parse(lines.join("")).message).toBe(
      "ResumePack failed runtime validation (builder bug or schema drift)",
    );
  });

  test("task dependency fields retain their exact JSON value and shape", () => {
    const detail = { task_id: "T-A", field: "depends_on[0]", ref: "T-B" };
    const lines: string[] = [];
    writeDiagnosticFailure(diagnostic("TASK_DEP_NOT_FOUND", detail), {
      format: "json",
      i18n: createI18n("zh", BUILTIN_BUNDLES),
      writeStderr: (s) => {
        lines.push(s);
      },
    });
    expect(JSON.parse(lines.join("")).detail).toEqual(detail);
    expect(Object.keys(JSON.parse(lines.join("")).detail).sort()).toEqual([
      "field",
      "ref",
      "task_id",
    ]);
  });

  test("check and schema issue context rows remain distinct from message/fix rendering", () => {
    const input = diagnosticVariant("failure.schema.validation", {
      kind: "tasks",
      path: "/tmp/tasks.json",
      error_count: 50,
      error_word: "errors",
      subcode: "zod",
      truncated: true,
      errors: [{ path: "version", code: "invalid_type", message: "expected number" }],
      checks: [{ check: 2, code: "TASKS_NOT_PLANNED", message: "tasks absent" }],
    });
    const lines: string[] = [];
    writeDiagnosticFailure(input, {
      format: "text",
      i18n: createI18n("en", BUILTIN_BUNDLES),
      writeStderr: (s) => {
        lines.push(s);
      },
    });
    expect(lines.join("")).toContain(
      "  [check 2] TASKS_NOT_PLANNED: tasks absent\n  [version] invalid_type: expected number\n  ... (50 errors total; first 1 shown)\n  fix:",
    );
  });
});
