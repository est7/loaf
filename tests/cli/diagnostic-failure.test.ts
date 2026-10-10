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
      checks: [{ check: 2, code: "TASKS_NOT_PLANNED", detail: {} }],
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
      "  [check 2] TASKS_NOT_PLANNED: gate task-graph check: tasks have not been planned (snapshot.tasks_based_on is null)\n  [version] invalid_type: expected number\n  ... (50 errors total; first 1 shown)\n  fix:",
    );
  });
  test("nested gate checks serialize canonical English without mutating the domain record", () => {
    const check = {
      check: 4,
      code: "TASKS_BASED_ON_STALE" as const,
      detail: { tasks_based_on_spec: 1, current_spec_version: 2 },
      ref: "spec.md",
    };
    const coverage = {
      check: 3,
      code: "COVERAGE_NOT_SATISFIED" as const,
      detail: { covered_id: "REQ-AUTH-001", covered_kind: "REQ" },
    };
    const input = diagnostic("GATE_PRECONDITION_VIOLATION", {
      gate: "verify-accept",
      failure_count: 2,
      checks: [coverage, check],
    });
    const outputs = ["en", "zh"].map((locale) => {
      const lines: string[] = [];
      writeDiagnosticFailure(input, {
        format: "json",
        i18n: createI18n(locale as "en" | "zh", BUILTIN_BUNDLES),
        writeStderr: (line) => lines.push(line),
      });
      expect(lines).toHaveLength(1);
      return JSON.parse(lines[0]!);
    });
    expect(outputs[0]).toEqual(outputs[1]);
    expect(outputs[0].detail.checks).toEqual([
      {
        ...coverage,
        message:
          "REQ-AUTH-001 has no evidence that satisfies it (canSatisfy failed for all candidates)",
      },
      {
        ...check,
        message:
          "gate task-graph check: tasks_based_on.spec=1 but current spec.spec_version=2 — the task graph was planned against an older spec",
      },
    ]);
    expect(check).not.toHaveProperty("message");
    expect(input.detail.checks).toEqual([coverage, check]);
    const localized: string[] = [];
    writeDiagnosticFailure(input, {
      format: "text",
      i18n: createI18n("zh", BUILTIN_BUNDLES),
      writeStderr: (line) => localized.push(line),
    });
    expect(localized.join("")).toContain(
      "[check 3] COVERAGE_NOT_SATISFIED: REQ-AUTH-001 没有任何证据满足覆盖(canSatisfy 对所有候选 evidence 都失败)",
    );
  });

  test("task obligation reason arrays retain the semicolon presentation join", () => {
    const lines: string[] = [];
    writeDiagnosticFailure(
      diagnostic("TASK_KIND_SCHEMA_VIOLATION", {
        task_id: "T-001",
        kind: "visual-ui",
        reasons: ["first", "second"],
      }),
      {
        format: "text",
        i18n: createI18n("en", BUILTIN_BUNDLES),
        writeStderr: (line) => lines.push(line),
      },
    );
    expect(lines.join("").split("\n")[0]).toBe(
      "error: TASK_KIND_SCHEMA_VIOLATION — spec-lock check 8: task T-001 (kind=visual-ui) violates projected kind-specific obligations: first; second",
    );
  });
});
