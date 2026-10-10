import { readFile } from "node:fs/promises";
import ts from "typescript";
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
        (row) => row.code === "SCHEMA_VALIDATION_FAILED" && row.file.includes("input-ingestion"),
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

  test("migrated core producers have catalog detail minimums and no prose fields", async () => {
    const files = [
      "entry-admission.ts",
      "reducer.ts",
      "task-graph.ts",
      "reducer/preflight.ts",
      "reducer/transition.ts",
      "journal-mutate.ts",
      "scope-closure-policy.ts",
      "pending-scope.ts",
      "actor-resolver.ts",
      "session-dispatch.ts",
      "gates/spec-lock-check.ts",
      "gates/verify-accept-check.ts",
      "spec-snapshot.ts",
      "gates/verify-accept-eval.ts",
      ...["common", "spec", "task", "workflow"].map(
        (name) => `reducer/preflight/checks-${name}.ts`,
      ),
    ];
    for (const file of files) {
      const source = await readFile(new URL(`../../src/core/${file}`, import.meta.url), "utf8");
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const prose: string[] = [];
      function visit(node: ts.Node) {
        if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "message")
          prose.push(node.getText(tree));
        ts.forEachChild(node, visit);
      }
      visit(tree);
      expect(prose, file).toEqual([]);
      const records = auditDiagnosticSource(file, source);
      for (const record of records) {
        if (record.code === null || record.detailKeys === null) continue;
        const entry = ERROR_CATALOG[record.code as keyof typeof ERROR_CATALOG];
        if (entry === undefined && file === "pending-scope.ts") {
          expect(["EXECUTE_CLOSURE_STATE_CHANGED", "EXECUTE_CLOSURE_COMMIT_AMBIGUOUS"]).toContain(
            record.code,
          );
          continue;
        }
        expect(entry, `${file}:${record.line}`).toBeDefined();
        expect(
          entry.detail_keys.filter((key) => !record.detailKeys!.includes(key)),
          `${file}:${record.line}`,
        ).toEqual([]);
      }
      if (file === "task-graph.ts")
        expect(records.map((record) => record.code)).toEqual([
          "TASK_DEP_NOT_FOUND",
          "TASK_DEP_SELF",
          "TASK_DEP_DUPLICATE",
          "TASK_DEP_CYCLE",
          "TASK_DEP_ABANDONED",
        ]);
    }
  });

  test("mutation failures cannot select a legacy outlet or failure route", async () => {
    const source = await readFile(
      new URL("../../src/cli/command-mutator.ts", import.meta.url),
      "utf8",
    );
    expect(
      /\bFailureRoute\b|routeMutateFailure|ctx\.(?:fail|emitFailure)\(/.test(source),
    ).toBe(false);
  });

  test("structured outlet records and opaque record propagation stay visible", () => {
    const rows = auditDiagnosticSource(
      "probe.ts",
      `
      ctx.failure({code: "TASK_DEP_SELF", detail: {task_id: "T-001"}});
      ctx.failure(result);
    `,
    );
    expect(
      rows.filter((row) => row.boundary === "outlet").map((row) => [row.code, row.detailKeys]),
    ).toEqual([
      ["TASK_DEP_SELF", ["task_id"]],
      [null, null],
    ]);
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
