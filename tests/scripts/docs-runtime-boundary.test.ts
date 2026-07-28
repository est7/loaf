import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

// tests/scripts/<file> → repo root is two levels up. A third `..` overshoots
// into the parent directory, whose incidental `docs/` masked the bug locally
// while CI's checkout layout surfaced it as ENOENT.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS_ROOT = path.join(REPO_ROOT, "docs");
const FRESHNESS_LEDGER_PATH = path.join(
  DOCS_ROOT,
  "references",
  "architecture-freshness-ledger.md",
);

function runtimeTypeScriptFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...runtimeTypeScriptFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(path.relative(REPO_ROOT, absolute));
    }
  }
  return found.sort();
}

describe("docs/runtime boundary", () => {
  test("docs contains no runtime TypeScript files", () => {
    expect(runtimeTypeScriptFiles(DOCS_ROOT)).toEqual([]);
  });

  test("the legacy docs/schemas facade is absent", () => {
    expect(existsSync(path.join(DOCS_ROOT, "schemas.ts"))).toBe(false);
  });

  test("the retired context-pack contract has no live owner or command promise", () => {
    expect(existsSync(path.join(REPO_ROOT, "src", "cli", "context-pack-schema.ts"))).toBe(false);
    const liveDocs = [
      "docs/machine-contract.md",
      "docs/protocol.md",
      "docs/references/incremental-construction.md",
    ].map((relative) => readFileSync(path.join(REPO_ROOT, relative), "utf8"));
    for (const doc of liveDocs) {
      expect(doc).not.toMatch(/`loaf context pack(?:\s|\[)/);
      expect(doc).not.toContain("src/cli/context-pack-schema.ts");
    }
  });

  test("the tracked freshness ledger closes dated debt without local-file authority", () => {
    const ledger = readFileSync(FRESHNESS_LEDGER_PATH, "utf8");
    expect(ledger).toContain("This is the former W8 command-surface work, not W9.");
    expect(ledger).toContain("Replay sequence monotonicity");
    expect(ledger).toContain("Spec-lock transition enforcement");
    expect(ledger).toContain("Generic context pack");
    expect(ledger).toContain("TUI F-026");
    expect(ledger).toContain("at least two independently changing consumers");
    expect(ledger).toContain("are not repository truth");
  });

  test("current contributor and E2E guidance do not require ignored root ledgers", () => {
    const claude = readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");
    const e2e = readFileSync(path.join(DOCS_ROOT, "e2e-scenarios.md"), "utf8");
    expect(claude).not.toMatch(/read (?:it|`backlog\.md`) before any non-trivial work/i);
    expect(e2e).not.toContain("Closes `task_plan.md`");
    expect(e2e).not.toContain("close `task_plan.md`");
  });

  test("freshness claims remain bound to live source and executable evidence", () => {
    const cli = readFileSync(path.join(REPO_ROOT, "src", "cli.tsx"), "utf8");
    const replay = readFileSync(path.join(REPO_ROOT, "tests", "core", "replay.test.ts"), "utf8");
    const transition = readFileSync(
      path.join(REPO_ROOT, "tests", "core", "transition.test.ts"),
      "utf8",
    );
    const tuiStatus = readFileSync(
      path.join(REPO_ROOT, "src", "cli", "tui", "list-model.ts"),
      "utf8",
    );
    const boardStatus = readFileSync(
      path.join(REPO_ROOT, "src", "cli", "board", "model.ts"),
      "utf8",
    );

    expect(cli).toContain('from "./cli/commands/lifecycle.js"');
    expect(cli).toContain("registerLifecycle(");
    expect(replay).toContain("duplicate seq");
    expect(transition).toContain("SPEC.design → EXECUTE.plan rejected when spec_locked=false");
    expect(tuiStatus).toContain("classifySessionStatus");
    expect(boardStatus).toContain("classifySessionStatus");
  });
});
