import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const owner = "src/core/intervention-policy.ts";
const transition = "src/core/reducer/transition.ts";
const policyNames = new Set([
  "FINDING_ACTION_GRID",
  "FINDING_ACTION_TARGET_MODE",
  "FINDING_UNUSUAL_REASON_MIN_LENGTH",
  "FIX_ACTION_STEP",
  "FINDING_DEFERRAL_ACTIONS",
  "cellRisk",
  "isFindingDeferralAction",
  "findingActionEffect",
  "pendingHead",
  "pendingHeadIndex",
  "livePending",
  "checkPendingAdvance",
  "planGatePending",
  "checkPendingEscalation",
  "resolvePending",
  "pendingResolutionOwner",
  "openFinding",
  "requireFindingSponsor",
  "findingForClosure",
  "checkFindingRaise",
  "checkFindingReset",
]);
const transitionNames = new Set(["BACK_EDGE_FROM", "backEdgeSourceStates", "backEdgeTarget"]);
function violations(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) {
      const name = node.name?.getText(tree);
      if (
        name &&
        ((policyNames.has(name) &&
          file !== owner &&
          (ts.isFunctionDeclaration(node) ||
            /^[A-Z_]+$/.test(name) ||
            (ts.isVariableDeclaration(node) &&
              node.initializer !== undefined &&
              (ts.isArrowFunction(node.initializer) ||
                ts.isFunctionExpression(node.initializer))))) ||
          (transitionNames.has(name) && file !== transition) ||
          ["FIX_RESET_STEP", "BACK_EDGE_TARGET"].includes(name))
      )
        found.push(`duplicate policy declaration: ${name}`);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const target = node.expression.expression.getText(tree);
      const callback = node.arguments[0]?.getText(tree) ?? "";
      if (
        file !== owner &&
        ["find", "findIndex", "filter"].includes(method) &&
        /\.resolved\b/.test(callback)
      )
        found.push("unresolved pending query outside owner");
      if (
        file !== owner &&
        ["find", "findIndex"].includes(method) &&
        /(?:^|\.)findings$/.test(target)
      )
        found.push("finding identity lookup outside owner");
    }
    if (ts.isBinaryExpression(node) && file !== owner) {
      const text = node.getText(tree);
      if (
        /(?:\b(?:finding|sponsor|f)\.action\s*[!=]={1,2}|\.action\s*[!=]={1,2}\s*["'](?:amend-spec|amend-tasks|fix-impl|fix-test|defer|backlog)["'])/.test(
          text,
        ) ||
        /\.kind\s*[!=]={1,2}\s*["'](?:gate_decision|profile_escalation)["']/.test(text)
      )
        found.push("intervention eligibility branch outside owner");
      if (/\.status\s*={2,3}\s*["']closed["']/.test(text))
        found.push("closed-finding eligibility outside owner");
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause?.isTypeOnly ||
        (clause?.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          !clause.name &&
          clause.namedBindings.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) {
        const target = node.moduleSpecifier.text;
        if (file === owner && /(?:cli\/|preflight|reducer\.js)/.test(target))
          found.push("policy runtime dependency crosses into orchestration/presentation");
        if (file.endsWith("-schema.ts") && target.includes("intervention-policy"))
          found.push("schema runtime dependency on policy owner");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory()
          ? files(path.join(dir, e.name))
          : /\.tsx?$/.test(e.name)
            ? [path.join(dir, e.name)]
            : [],
      ),
    )
  ).flat();
}
describe("intervention policy ownership", () => {
  test("all production source keeps policy declarations and historical queries with their owners", async () => {
    for (const file of await files("src"))
      expect(violations(file, await readFile(file, "utf8")), file).toEqual([]);
  });
  test("gate detects copied maps, renamed queue/sponsor queries and reverse dependencies", () => {
    expect(
      violations(
        "src/cli/probe.ts",
        `if (finding.action !== expected) reject(); if (head.kind === "profile_escalation") block();`,
      ),
    ).toHaveLength(2);
    expect(
      violations(
        "src/cli/probe.ts",
        `const BACK_EDGE_TARGET = {}; function pendingHead() {} rows.findIndex(p => p.resolved === false); snapshot.findings.find(f => f.id === id); if (finding.status === "closed") reject();`,
      ),
    ).toHaveLength(5);
    expect(
      violations(
        owner,
        `const BACK_EDGE_FROM = {}; import { preflight } from "./reducer/preflight.js";`,
      ),
    ).toHaveLength(2);
    expect(
      violations(
        "src/core/finding-schema.ts",
        `import { findingActionEffect } from "./intervention-policy.js";`,
      ),
    ).toHaveLength(1);
  });
  test("gate preserves typed schema imports, transition-owned rules and live queue/presentation adaptation", () => {
    expect(violations("src/cli/probe.ts", `if (opts.action === "delete") remove();`)).toEqual([]);
    expect(
      violations(
        owner,
        `import type { Snapshot } from "./projection-types.js"; import { backEdgeTarget } from "./reducer/transition.js"; function pendingHead() {} rows.findIndex(p => !p.resolved);`,
      ),
    ).toEqual([]);
    expect(
      violations(transition, `const BACK_EDGE_FROM = {}; function backEdgeTarget() {}`),
    ).toEqual([]);
    expect(
      violations(
        "src/cli/tui/detail-model.ts",
        `const pending = livePending(loaded.pending.pending).map(row => ({label: translate(row.kind)})); const open = loaded.findings.findings.filter(f => f.status === "open");`,
      ),
    ).toEqual([]);
  });
});
