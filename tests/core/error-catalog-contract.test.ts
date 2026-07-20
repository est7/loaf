// ERROR_CATALOG detail-contract gate.
//
// Coverage is intentionally pragmatic and non-circular:
// - template satisfaction is derived from literal templates with the runtime
//   substituter's identifier grammar, then checked against detail_keys and the
//   catalog adapter (not against a second handwritten placeholder list);
// - emitter coverage parses direct diagnostic("CODE", { ... }) calls in the
//   three first-adopter core files. Dynamic code values, non-literal detail
//   objects, spreads, legacy emitters, and CLI-only transformation semantics
//   are outside this static gate and remain covered by typecheck/runtime tests.

import { readFile } from "node:fs/promises";

import * as ts from "typescript";
import { describe, expect, test } from "vitest";

import {
  ERROR_CATALOG,
  type UncoveredTemplatePlaceholders,
  diagnostic,
} from "../../src/core/error-catalog.js";

type AssertNever<T extends never> = T;

type CoveredFixture = AssertNever<
  UncoveredTemplatePlaceholders<{
    message_template: "value={value}";
    zh_message_template: "值={value}";
    fix_template: "set {allowed_value}";
    template_keys: readonly ["allowed_value", "value"];
  }>
>;

type RejectedFixture = AssertNever<
  // @ts-expect-error missing_key is absent from template_keys.
  UncoveredTemplatePlaceholders<{
    message_template: "value={missing_key}";
    template_keys: readonly ["value"];
  }>
>;

// Keep the compile-time fixtures live under noUnusedLocals-independent configs.
type _CompileTimeFixtures = CoveredFixture | RejectedFixture;

if (false) {
  diagnostic("ALREADY_STARTED", { kind: "session:started" });
  diagnostic("FEATURE_NOT_FOUND", {});
  // @ts-expect-error ALREADY_STARTED requires detail.kind.
  diagnostic("ALREADY_STARTED", {});
  // @ts-expect-error literal detail objects cannot invent non-contract keys.
  diagnostic("PENDING_NOT_FOUND", { reason: "missing", id: "PEND-404" });
  // @ts-expect-error an empty detail contract rejects invented keys too.
  diagnostic("FEATURE_NOT_FOUND", { cwd: "/tmp" });
}

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

function placeholders(entry: (typeof ERROR_CATALOG)[keyof typeof ERROR_CATALOG]): Set<string> {
  const values = [
    entry.message_template,
    "zh_message_template" in entry ? entry.zh_message_template : undefined,
    "fix_template" in entry ? entry.fix_template : undefined,
    "zh_fix_template" in entry ? entry.zh_fix_template : undefined,
  ];
  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const match of value.matchAll(PLACEHOLDER)) result.add(match[1]!);
  }
  return result;
}

type StaticDiagnosticCall = {
  code: string;
  detailKeys: Set<string>;
  file: string;
  line: number;
};

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
    return null;
  }
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

async function staticDiagnosticCalls(relativePath: string): Promise<StaticDiagnosticCall[]> {
  const source = await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
  const calls: StaticDiagnosticCall[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "diagnostic" &&
      node.arguments.length === 2 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      ts.isObjectLiteralExpression(node.arguments[1]!)
    ) {
      const detailKeys = new Set<string>();
      for (const property of node.arguments[1]!.properties) {
        const name = propertyName(property);
        if (name !== null) detailKeys.add(name);
      }
      calls.push({
        code: node.arguments[0]!.text,
        detailKeys,
        file: relativePath,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return calls;
}

describe("ERROR_CATALOG template/detail contracts", () => {
  test("the diagnosticVarsFor registry records required emitter keys and deliberate renames", () => {
    expect(ERROR_CATALOG.INVALID_FORMAT).toMatchObject({
      detail_keys: ["allowed_values", "value"],
      adapter: { allowed_values_human: "allowed_values" },
    });
    expect(ERROR_CATALOG.MUTUALLY_EXCLUSIVE_FLAGS).toMatchObject({
      detail_keys: ["conflicting"],
      adapter: { flags: "conflicting" },
    });
    expect(ERROR_CATALOG.DRY_RUN_NOT_APPLICABLE.detail_keys).toEqual(["command", "command_type"]);
    expect(ERROR_CATALOG.CONFIG_ALREADY_INITIALIZED.detail_keys).toEqual(["config_path"]);
    expect(ERROR_CATALOG.FEATURE_NOT_FOUND.detail_keys).toEqual([]);
    expect(ERROR_CATALOG.FEATURE_AMBIGUOUS.detail_keys).toEqual(["count", "feature_list"]);
    expect(ERROR_CATALOG.SESSION_CWD_MISMATCH.detail_keys).toEqual([
      "current_cwd",
      "registered_cwd",
      "uuid",
    ]);
    expect(ERROR_CATALOG.SESSION_SHORT_AMBIGUOUS.detail_keys).toEqual([
      "candidate_list",
      "match_count",
      "prefix",
    ]);
    expect(ERROR_CATALOG.SESSION_NOT_FOUND.detail_keys).toEqual(["uuid_or_prefix"]);
  });

  test("the five fixed codes expose the detail contract their emitters construct", () => {
    expect(ERROR_CATALOG.GATE_NOT_PENDING).toMatchObject({
      template_keys: ["gate_kind", "head_kind"],
      detail_keys: ["gate_kind", "head_id", "head_kind"],
    });
    expect(ERROR_CATALOG.FINDING_ACTION_UNUSUAL_REASON_REQUIRED).toMatchObject({
      template_keys: ["action", "category", "min_reason_length"],
      detail_keys: ["action", "category", "current_reason_length", "min_reason_length"],
    });
    expect(ERROR_CATALOG.SPEC_HAS_UNCLARIFIED.detail_keys).toEqual(["count", "ids"]);
    expect(ERROR_CATALOG.ALREADY_STARTED.detail_keys).toEqual(["kind"]);
    expect(ERROR_CATALOG.PENDING_NOT_FOUND.detail_keys).toEqual(["reason"]);
  });

  test("every template placeholder is satisfiable by identity or adapter", () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      if (!("detail_keys" in entry)) continue;
      const detailKeys = new Set<string>(entry.detail_keys);
      const adapter = ("adapter" in entry ? entry.adapter : undefined) as
        | Readonly<Record<string, string>>
        | undefined;
      if (adapter !== undefined) {
        expect(
          Object.keys(adapter).every((key) => placeholders(entry).has(key)),
          `${code}: adapter keys must name template placeholders`,
        ).toBe(true);
        expect(
          Object.values(adapter).every((key) => detailKeys.has(key)),
          `${code}: adapter values must name required detail keys`,
        ).toBe(true);
      }
      for (const templateKey of placeholders(entry)) {
        const detailKey = adapter?.[templateKey] ?? templateKey;
        expect(
          detailKeys.has(detailKey),
          `${code}: template key ${templateKey} needs detail key ${detailKey}`,
        ).toBe(true);
      }
    }
  });

  test("direct first-adopter emitters construct every required detail key", async () => {
    const files = [
      "src/core/reducer/preflight.ts",
      "src/core/reducer/preflight/checks-workflow.ts",
      "src/core/gates/spec-lock-check.ts",
      "src/core/reducer.ts",
    ];
    const calls = (await Promise.all(files.map(staticDiagnosticCalls))).flat();
    const expectedCodes = new Set([
      "GATE_NOT_PENDING",
      "FINDING_ACTION_UNUSUAL_REASON_REQUIRED",
      "SPEC_HAS_UNCLARIFIED",
      "ALREADY_STARTED",
      "PENDING_NOT_FOUND",
    ]);

    const actualCodes = new Set(calls.map((call) => call.code));
    for (const code of expectedCodes)
      expect(actualCodes.has(code), `missing ${code} adopter`).toBe(true);
    for (const call of calls) {
      const entry = ERROR_CATALOG[call.code as keyof typeof ERROR_CATALOG];
      expect(entry, `${call.file}:${call.line}: unknown diagnostic ${call.code}`).toBeDefined();
      if (!("detail_keys" in entry)) continue;
      for (const detailKey of entry.detail_keys) {
        expect(
          call.detailKeys.has(detailKey),
          `${call.file}:${call.line}: ${call.code} misses detail.${detailKey}`,
        ).toBe(true);
      }
    }
  });
});
