import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { ERROR_CATALOG } from "../../src/core/error-catalog.js";
import { KIND_REGISTRY } from "../../src/core/kind-registry.js";
import { collectInventory } from "./inventory/help-collector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PROTOCOL_PATH = path.join(REPO_ROOT, "docs", "protocol.md");

const ENV_RG_PATTERN = String.raw`\benv(?:\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]|\.([A-Z][A-Z0-9_]*))`;

describe("drift gate: protocol §10.3 environment variable tiers", () => {
  test("runtime/public, build-only, and test-only rows equal source reads with no dead rows", () => {
    // Equivalent audit command:
    //   rg -n 'env\["[A-Z][A-Z0-9_]*"\]|env\.[A-Z][A-Z0-9_]*' src tests tsdown.config.ts
    // Keep ENV_RG_PATTERN and this command in lockstep. Any new env read must
    // update both the explicit tier table and this gate's source-derived set.
    const runtime = scanEnvKeys(discoverSourceFiles(path.join(REPO_ROOT, "src")));
    const buildOnly = scanEnvKeys([path.join(REPO_ROOT, "tsdown.config.ts")]);
    const testOnly = difference(
      scanEnvKeys(discoverSourceFiles(path.join(REPO_ROOT, "tests"))),
      runtime,
      buildOnly,
    );
    const documented = parseEnvironmentTable(readFileSync(PROTOCOL_PATH, "utf8"));

    expect([...documented.keys()].sort()).toEqual(["build-only", "runtime/public", "test-only"]);
    expect(sorted(documented.get("runtime/public") ?? new Set())).toEqual(sorted(runtime));
    expect(sorted(documented.get("build-only") ?? new Set())).toEqual(sorted(buildOnly));
    expect(sorted(documented.get("test-only") ?? new Set())).toEqual(sorted(testOnly));
  });
});

describe("drift gate: ERROR_CATALOG doc_anchor validity", () => {
  test("every anchor resolves to a file and protocol §X resolves to an actual heading", () => {
    const failures: string[] = [];
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      const [rawFile, fragment] = entry.doc_anchor.split("#", 2);
      const file = rawFile === "protocol.md" ? PROTOCOL_PATH : path.join(REPO_ROOT, rawFile ?? "");
      if (!existsSync(file)) {
        failures.push(`${code}: missing file ${entry.doc_anchor}`);
        continue;
      }
      if (rawFile !== "protocol.md" || fragment === undefined) continue;
      if (!fragment.startsWith("§")) {
        failures.push(`${code}: protocol fragment must use §X convention: ${entry.doc_anchor}`);
        continue;
      }
      const wanted = fragment.slice(1);
      const headings = protocolSectionHeadings(readFileSync(file, "utf8"));
      if (!headings.has(wanted)) {
        failures.push(`${code}: protocol heading §${wanted} does not exist`);
      }
    }
    expect(failures).toEqual([]);
  });
});

type SourceRegion = { file: string; start: string; end?: string };

// Stable source anchors are semantic Commander registration strings, not line
// numbers. Helper regions are included only where a command delegates entry
// construction; emitted literals are then filtered through KIND_REGISTRY.
const JOURNAL_KIND_SOURCE_ANCHORS: Record<string, SourceRegion[]> = {
  "loaf start": [
    region(
      "src/cli/commands/lifecycle.tsx",
      '.command("start <feature>")',
      '.command("advance <to>")',
    ),
  ],
  "loaf advance": [
    region("src/cli/commands/lifecycle.tsx", '.command("advance <to>")', '.command("status")'),
  ],
  "loaf spec submit": [
    region("src/cli/commands/spec.tsx", '.command("submit")', '.command("init")'),
    region("src/cli/spec-submit-batch.ts", "export function buildSpecSubmitBatch"),
  ],
  "loaf spec edit": [
    region("src/cli/commands/spec.tsx", '.command("edit")', "for (const cfg of REGISTER_SPEC_ADD)"),
    region("src/cli/spec-submit-batch.ts", "export function buildSpecSubmitBatch"),
  ],
  "loaf spec add-req": [region("src/cli/commands/spec.tsx", 'name: "req"', 'name: "scenario"')],
  "loaf spec add-scenario": [
    region("src/cli/commands/spec.tsx", 'name: "scenario"', 'name: "visual"'),
  ],
  "loaf spec add-visual": [
    region("src/cli/commands/spec.tsx", 'name: "visual"', "function specAddTextKey"),
  ],
  "loaf tasks submit": [
    region("src/cli/commands/tasks.tsx", '.command("submit")', '.command("add")'),
  ],
  "loaf tasks add": [
    region("src/cli/commands/tasks.tsx", '.command("add")', '.command("claim <task-id>")'),
  ],
  "loaf tasks claim": [
    region(
      "src/cli/commands/tasks.tsx",
      '.command("claim <task-id>")',
      '.command("abandon <task-id>")',
    ),
  ],
  "loaf tasks abandon": [
    region("src/cli/commands/tasks.tsx", '.command("abandon <task-id>")', '.command("list")'),
  ],
  "loaf tasks complete": [
    region(
      "src/cli/commands/tasks.tsx",
      '.command("complete <task-id>")',
      '.command("amend <task-id>")',
    ),
  ],
  "loaf tasks amend": [
    region(
      "src/cli/commands/tasks.tsx",
      '.command("amend <task-id>")',
      '.command("register-red <task-id>")',
    ),
  ],
  "loaf tasks register-red": [
    region(
      "src/cli/commands/tasks.tsx",
      '.command("register-red <task-id>")',
      'tasksCmd.command("step")',
    ),
  ],
  "loaf tasks step start": [
    region("src/cli/commands/tasks.tsx", '.command("start")', '.command("done")'),
  ],
  "loaf tasks step done": [region("src/cli/commands/tasks.tsx", '.command("done")')],
  "loaf evidence add": [
    region("src/cli/commands/evidence.tsx", '.command("add")', '.command("waive <obligation-id>")'),
  ],
  "loaf waive": [region("src/cli/commands/evidence.tsx", '.command("waive <obligation-id>")')],
  "loaf finding raise": [
    region("src/cli/commands/finding.tsx", '.command("raise")', '.command("list")'),
    region("src/cli/batch-builders.ts", "export function buildFindingRaiseBatch"),
  ],
  "loaf finding close": [region("src/cli/commands/finding.tsx", '.command("close <fnd-id>")')],
  "loaf pending raise": [
    region("src/cli/commands/pending.tsx", '.command("raise")', '.command("list")'),
  ],
  "loaf pending resolve": [region("src/cli/commands/pending.tsx", '.command("resolve")')],
  "loaf gate decide": [
    region("src/cli/commands/gate.tsx", '.command("decide <gate-name>")'),
    region(
      "src/cli/batch-builders.ts",
      "export function buildGateApprovalBatch",
      "export type FindingRaiseBatch",
    ),
  ],
  "loaf resume": [
    region("src/cli/commands/terminal-settle.tsx", '.command("resume")', '.command("handoff")'),
  ],
  "loaf deliver": [
    region("src/cli/commands/terminal-execute.tsx", '.command("deliver")', '.command("archive")'),
  ],
  "loaf settle": [
    region("src/cli/commands/terminal-settle.tsx", '.command("settle")', '.command("resume")'),
  ],
  "loaf archive": [
    region("src/cli/commands/terminal-execute.tsx", '.command("archive")', '.command("abandon")'),
  ],
  "loaf abandon": [region("src/cli/commands/terminal-execute.tsx", '.command("abandon")')],
  "loaf spike convert": [
    region("src/cli/commands/profile-config.tsx", '.command("convert")', '.command("profile")'),
  ],
  "loaf profile escalate": [
    region("src/cli/commands/profile-config.tsx", '.command("escalate")', '.command("config")'),
  ],
  "loaf lessons add": [region("src/cli/commands/lessons.tsx", '.command("add")')],
};

const NON_JOURNAL_EXECUTABLE_COMMANDS = new Set([
  "loaf status",
  "loaf next",
  "loaf handoff",
  "loaf config init",
  "loaf doctor",
  "loaf spec init",
  "loaf tasks list",
  "loaf tasks next",
  "loaf tasks schema",
  "loaf evidence schema",
  "loaf pending list",
  "loaf pending status",
  "loaf hook",
  "loaf tui",
  "loaf sessions list",
  "loaf check",
  "loaf verify status",
  "loaf board",
  "loaf prune",
  "loaf prune restore",
  "loaf finding list",
  "loaf finding schema",
  "loaf spec schema",
  "loaf state schema",
]);

describe("drift gate: protocol §10.8 command to journal kind table", () => {
  test("documented command mappings equal runtime registration/helper literals", () => {
    const documented = parseJournalKindTable(readFileSync(PROTOCOL_PATH, "utf8"));
    const runtime = new Map(
      Object.entries(JOURNAL_KIND_SOURCE_ANCHORS).map(([command, regions]) => [
        command,
        extractJournalKinds(regions),
      ]),
    );
    expect([...documented.keys()].sort()).toEqual([...runtime.keys()].sort());
    for (const [command, kinds] of runtime) {
      expect(sorted(documented.get(command) ?? new Set()), command).toEqual(sorted(kinds));
    }
  });

  test("every live executable is explicitly classified journal-emitting or non-journal", async () => {
    const inventory = await collectInventory();
    const live = new Set(
      inventory.commands
        .filter((command) => !command.isGroup || command.isExecutable)
        .map((command) => `loaf ${command.path}`),
    );
    const classified = new Set([
      ...Object.keys(JOURNAL_KIND_SOURCE_ANCHORS),
      ...NON_JOURNAL_EXECUTABLE_COMMANDS,
    ]);
    expect(sorted(classified)).toEqual(sorted(live));

    for (const [command, regions] of Object.entries(JOURNAL_KIND_SOURCE_ANCHORS)) {
      if (command === "loaf tasks complete") continue;
      expect(
        extractJournalKinds(regions).size,
        `${command} source anchor must emit a kind`,
      ).toBeGreaterThan(0);
    }
  });
});

function region(file: string, start: string, end?: string): SourceRegion {
  return end === undefined ? { file, start } : { file, start, end };
}

function discoverSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { recursive: true }) as string[]) {
    if (!/\.(?:[cm]?[jt]sx?)$/.test(entry)) continue;
    files.push(path.join(root, entry));
  }
  return files;
}

function scanEnvKeys(files: string[]): Set<string> {
  const keys = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const pattern = new RegExp(ENV_RG_PATTERN, "g");
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match !== null) {
      keys.add(match[1] ?? match[2] ?? "");
      match = pattern.exec(text);
    }
  }
  keys.delete("");
  return keys;
}

function difference(input: Set<string>, ...subtract: Set<string>[]): Set<string> {
  return new Set([...input].filter((key) => subtract.every((set) => !set.has(key))));
}

function parseEnvironmentTable(text: string): Map<string, Set<string>> {
  const section = between(text, "**Env vars**:", "**`LOAF_*` 命名**");
  const tiers = new Map<string, Set<string>>();
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith("|") || /^\|[-:|]+\|?$/.test(line.replace(/\s/g, ""))) continue;
    const cells = splitMarkdownRow(line);
    const env = cells[0]?.match(/`([A-Z][A-Z0-9_]*)`/)?.[1];
    if (!env || /inventory:future/.test(line)) continue;
    const tier = cells[1]?.trim();
    if (!tier || tier === "Tier") continue;
    const set = tiers.get(tier) ?? new Set<string>();
    set.add(env);
    tiers.set(tier, set);
  }
  return tiers;
}

function protocolSectionHeadings(text: string): Set<string> {
  const headings = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^#{1,6}\s+(\d+(?:\.\d+)*)\b/);
    if (match?.[1]) headings.add(match[1]);
  }
  return headings;
}

function parseJournalKindTable(text: string): Map<string, Set<string>> {
  const section = between(
    text,
    "**Journal entry kind emitted by each Tier 1 mutator**",
    "Read-only 命令(",
  );
  const knownKinds = new Set(Object.keys(KIND_REGISTRY));
  const result = new Map<string, Set<string>>();
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith("|") || /inventory:future/.test(line)) continue;
    const cells = splitMarkdownRow(line);
    const code = cells[0]?.match(/`(loaf [^`]+)`/)?.[1];
    if (!code) continue;
    const command = code.match(/^loaf(?:\s+[a-z][a-z0-9-]*)+/)?.[0];
    if (!command) continue;
    const kinds = new Set<string>();
    for (const match of (cells[1] ?? "").matchAll(/`([^`]+)`/g)) {
      const token = match[1] ?? "";
      if (knownKinds.has(token)) kinds.add(token);
    }
    result.set(command, kinds);
  }
  return result;
}

function extractJournalKinds(regions: SourceRegion[]): Set<string> {
  const knownKinds = new Set(Object.keys(KIND_REGISTRY));
  const kinds = new Set<string>();
  for (const anchor of regions) {
    const file = path.join(REPO_ROOT, anchor.file);
    const text = readFileSync(file, "utf8");
    const start = text.indexOf(anchor.start);
    if (start < 0) throw new Error(`${anchor.file}: missing source anchor ${anchor.start}`);
    const end =
      anchor.end === undefined
        ? text.length
        : text.indexOf(anchor.end, start + anchor.start.length);
    if (end < 0) throw new Error(`${anchor.file}: missing end anchor ${anchor.end}`);
    const slice = text.slice(start, end);
    for (const match of slice.matchAll(/(?:kind|entryKind):\s*["']([^"']+)["']/g)) {
      const kind = match[1] ?? "";
      if (knownKinds.has(kind)) kinds.add(kind);
    }
  }
  return kinds;
}

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|\s*$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function between(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error(`missing protocol anchor: ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`missing protocol anchor: ${endMarker}`);
  return text.slice(start, end);
}

function sorted(values: Set<string>): string[] {
  return [...values].sort();
}
