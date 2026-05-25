import { describe, expect, test, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseProtocolMarkers,
  parseProtocolMarkersFromText,
  type ParserResult,
} from "./inventory/protocol-parser.js";
import { collectInventory, type Inventory } from "./inventory/help-collector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PROTOCOL_PATH = path.join(REPO_ROOT, "docs", "protocol.md");
const BASELINE_PATH = path.join(__dirname, "inventory", "diagnostic-baseline.json");
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.tsx");

type Baseline = {
  entries: Array<{
    code: string;
    emit_locations: Array<{ file: string; line: number }>;
    removal_sc: string;
    reason: string;
  }>;
};

type Finding = {
  kind:
    | "missing-command"
    | "extra-command"
    | "uncataloged-code"
    | "future-without-baseline";
  name: string;
  doc_location: string;
  runtime_location: string;
  suggestion: string;
};

let inventory: Inventory;
let protocolParse: ParserResult;
let baseline: Baseline;

beforeAll(() => {
  inventory = collectInventory();
  protocolParse = parseProtocolMarkers(PROTOCOL_PATH);
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}, 120_000);

describe("protocol-parser: marker discovery + fail-closed errors", () => {
  test("real protocol.md parses without parser errors", () => {
    if (protocolParse.errors.length > 0) {
      throw new Error(
        `Parser found ${protocolParse.errors.length} errors in protocol.md:\n` +
          protocolParse.errors.map((e) => `  [${e.kind}] ${e.location} — ${e.detail}`).join("\n"),
      );
    }
    expect(protocolParse.errors).toEqual([]);
  });

  test("real protocol.md has at least two marker blocks: globalFlags + commands", () => {
    const tags = protocolParse.blocks.map((b) => b.tag);
    expect(tags).toContain("v0.1.0 globalFlags");
    expect(tags).toContain("v0.1.0 commands");
  });

  test("fail-closed: inventory:current-end without preceding begin → MARKER_MISSING", () => {
    const text = "# X\n\n<!-- inventory:current-end -->\n";
    const result = parseProtocolMarkersFromText(text);
    const codes = result.errors.map((e) => e.kind);
    expect(codes).toContain("MARKER_MISSING");
  });

  test("fail-closed: inventory:current-begin without matching end → MARKER_UNCLOSED", () => {
    const text = "<!-- inventory:current-begin v0.1.0 demo -->\n| a | b |\n|---|---|\n| x | y |\n";
    const result = parseProtocolMarkersFromText(text);
    const codes = result.errors.map((e) => e.kind);
    expect(codes).toContain("MARKER_UNCLOSED");
  });

  test("fail-closed: nested inventory:current-begin → MARKER_DUPLICATED", () => {
    const text = [
      "<!-- inventory:current-begin v0.1.0 outer -->",
      "<!-- inventory:current-begin v0.1.0 inner -->",
      "<!-- inventory:current-end -->",
      "<!-- inventory:current-end -->",
    ].join("\n");
    const result = parseProtocolMarkersFromText(text);
    const codes = result.errors.map((e) => e.kind);
    expect(codes).toContain("MARKER_DUPLICATED");
  });

  test("fail-closed: inventory:future without reason= → FUTURE_NO_REASON", () => {
    const text = [
      "<!-- inventory:current-begin v0.1.0 demo -->",
      "| name | desc |",
      "|---|---|",
      "| `loaf future-cmd` <!-- inventory:future --> | aspirational |",
      "<!-- inventory:current-end -->",
    ].join("\n");
    const result = parseProtocolMarkersFromText(text);
    const codes = result.errors.map((e) => e.kind);
    expect(codes).toContain("FUTURE_NO_REASON");
  });

  test("fail-closed: inventory:placeholder without reason= → PLACEHOLDER_NO_REASON", () => {
    const text = [
      "<!-- inventory:current-begin v0.1.0 demo -->",
      "| name | desc |",
      "|---|---|",
      "| `<artifact>` <!-- inventory:placeholder --> | generic |",
      "<!-- inventory:current-end -->",
    ].join("\n");
    const result = parseProtocolMarkersFromText(text);
    const codes = result.errors.map((e) => e.kind);
    expect(codes).toContain("PLACEHOLDER_NO_REASON");
  });
});

describe("protocol-parser: name extraction", () => {
  test("extracts command name with subcommand prefix", () => {
    const text = [
      "<!-- inventory:current-begin v0.1.0 demo -->",
      "| 命令 | exit |",
      "|---|---|",
      "| `loaf tasks step done --task T-N --step <s>` | 0 / 2 |",
      "<!-- inventory:current-end -->",
    ].join("\n");
    const r = parseProtocolMarkersFromText(text);
    expect(r.errors).toEqual([]);
    expect(r.blocks[0]?.rows[0]?.name).toBe("loaf tasks step done");
  });

  test("extracts flag name from --flag <arg> form", () => {
    const text = [
      "<!-- inventory:current-begin v0.1.0 demo -->",
      "| Flag | Notes |",
      "|---|---|",
      "| `--ceremony <preset>` | quick/light/... |",
      "<!-- inventory:current-end -->",
    ].join("\n");
    const r = parseProtocolMarkersFromText(text);
    expect(r.errors).toEqual([]);
    expect(r.blocks[0]?.rows[0]?.name).toBe("--ceremony");
  });

  test("future-annotated rows carry skipReason and ARE in the rows array", () => {
    const text = [
      "<!-- inventory:current-begin v0.1.0 demo -->",
      "| 命令 | exit |",
      "|---|---|",
      "| `loaf resume` <!-- inventory:future reason=\"SC-13 lifecycle\" --> | 0 |",
      "<!-- inventory:current-end -->",
    ].join("\n");
    const r = parseProtocolMarkersFromText(text);
    expect(r.errors).toEqual([]);
    const row = r.blocks[0]?.rows[0];
    expect(row?.name).toBe("loaf resume");
    expect(row?.skipReason).toEqual({ type: "future", reason: "SC-13 lifecycle" });
  });
});

describe("help-collector: snapshots current cli.tsx surface", () => {
  test("captures top-level global flags", () => {
    const names = inventory.globalFlags.map((f) => f.name);
    expect(names).toContain("--json");
    expect(names).toContain("--help");
    expect(names).toContain("--version");
  });

  test("captures top-level command set", () => {
    const tops = inventory.commands.filter((c) => !c.path.includes(" ")).map((c) => c.path);
    // Sentinel set from cli.tsx at 0a159c0 (Slice 4 close + GA scripts + cleanup)
    for (const expected of [
      "start",
      "advance",
      "status",
      "spec",
      "tasks",
      "pending",
      "evidence",
      "finding",
      "gate",
      "deliver",
      "settle",
      "doctor",
      "archive",
      "abandon",
      "spike",
      "profile",
    ]) {
      expect(tops, `missing top-level command ${expected}`).toContain(expected);
    }
  });

  test("classifies group vs leaf — `spec` is group, `start` is leaf", () => {
    const spec = inventory.commands.find((c) => c.path === "spec");
    const start = inventory.commands.find((c) => c.path === "start");
    expect(spec?.isGroup, "spec must be a group (has subcommands)").toBe(true);
    expect(start?.isGroup, "start must be a leaf").toBe(false);
  });

  test("captures subcommand flags — `start` has --ceremony", () => {
    const start = inventory.commands.find((c) => c.path === "start");
    const flags = start?.flags.map((f) => f.name) ?? [];
    expect(flags).toContain("--ceremony");
    expect(flags).toContain("--label");
    expect(flags).toContain("--workspace");
    expect(flags).toContain("--feature-dir");
  });

  test("recurses one level: `spec add-req` appears as leaf with --input", () => {
    const cmd = inventory.commands.find((c) => c.path === "spec add-req");
    expect(cmd, "spec add-req must exist as leaf").toBeDefined();
    expect(cmd?.isGroup).toBe(false);
    const flagNames = cmd?.flags.map((f) => f.name) ?? [];
    expect(flagNames).toContain("--input");
  });
});

describe("protocol-parser: escaped pipe + malformed first cell (codex r191 BLOCKER 1)", () => {
  test("row with escaped `\\|` inside backticks parses without error", () => {
    const text = [
      "<!-- inventory:current-begin v0.1.0 demo -->",
      "| 命令 | 用途 | exit |",
      "|---|---|---|",
      "| `loaf tasks amend <T-N> (--policy <...> \\| --input <file> --finding <FND-N>)` | 两条互斥 surface | 0 / 2 |",
      "<!-- inventory:current-end -->",
    ].join("\n");
    const r = parseProtocolMarkersFromText(text);
    expect(r.errors).toEqual([]);
    expect(r.blocks[0]?.rows).toHaveLength(1);
    expect(r.blocks[0]?.rows[0]?.name).toBe("loaf tasks amend");
  });

  test("row with escaped `\\|` inside `[--status open\\|closed]` parses without error", () => {
    const text = [
      "<!-- inventory:current-begin v0.1.0 demo -->",
      "| 命令 | 用途 | exit |",
      "|---|---|---|",
      "| `loaf finding list [--status open\\|closed]` | 列 findings | 0 |",
      "<!-- inventory:current-end -->",
    ].join("\n");
    const r = parseProtocolMarkersFromText(text);
    expect(r.errors).toEqual([]);
    expect(r.blocks[0]?.rows[0]?.name).toBe("loaf finding list");
  });

  test("fail-closed: unmatched backticks in first cell → ROW_MALFORMED", () => {
    const text = [
      "<!-- inventory:current-begin v0.1.0 demo -->",
      "| 命令 | exit |",
      "|---|---|",
      "| `loaf bogus-unmatched | 0 |",
      "<!-- inventory:current-end -->",
    ].join("\n");
    const r = parseProtocolMarkersFromText(text);
    const codes = r.errors.map((e) => e.kind);
    expect(codes).toContain("ROW_MALFORMED");
  });
});

describe("drift gate: protocol §10.8 current-surface ↔ cli.tsx command set", () => {
  test("Direction A — every enforced doc command exists in Commander tree", () => {
    const findings = diffCommands(protocolParse, inventory).filter(
      (f) => f.kind === "missing-command",
    );
    if (findings.length > 0) throw new Error(formatFindings(findings));
    expect(findings).toEqual([]);
  });

  test("Direction B — every runtime leaf command is documented (current or future-tagged)", () => {
    const findings = diffCommands(protocolParse, inventory).filter(
      (f) => f.kind === "extra-command",
    );
    if (findings.length > 0) throw new Error(formatFindings(findings));
    expect(findings).toEqual([]);
  });

  test("regression: synthetic extra runtime command would trigger extra-command finding", () => {
    // Inject a phantom command not present in protocol.md §10.8.
    const synthetic: Inventory = {
      globalFlags: inventory.globalFlags,
      commands: [
        ...inventory.commands,
        {
          path: "phantom-cmd",
          isGroup: false,
          flags: [],
          description: "synthetic test command",
        },
      ],
    };
    const findings = diffCommands(protocolParse, synthetic).filter(
      (f) => f.kind === "extra-command",
    );
    expect(findings.some((f) => f.name === "loaf phantom-cmd")).toBe(true);
  });
});

describe("drift gate: protocol §10.7 globalFlags ↔ cli.tsx top-level flags (codex r191 BLOCKER 3)", () => {
  test("Direction A — every enforced doc global flag exists in runtime", () => {
    const findings = diffGlobalFlags(protocolParse, inventory).filter(
      (f) => f.kind === "missing-command",
    );
    if (findings.length > 0) throw new Error(formatFindings(findings));
    expect(findings).toEqual([]);
  });

  test("Direction B — every runtime global flag is documented in §10.7", () => {
    const findings = diffGlobalFlags(protocolParse, inventory).filter(
      (f) => f.kind === "extra-command",
    );
    if (findings.length > 0) throw new Error(formatFindings(findings));
    expect(findings).toEqual([]);
  });
});

describe("drift gate: DiagnosticCode emit ⊆ catalog ∪ baseline", () => {
  test("no NEW uncataloged code in src/cli.tsx beyond baseline", () => {
    const findings = diffDiagnostics(baseline);
    if (findings.length > 0) {
      throw new Error(formatFindings(findings));
    }
    expect(findings).toEqual([]);
  });

  test("baseline entries are emitted by cli.tsx (no stale baseline)", () => {
    const cliText = readFileSync(CLI_PATH, "utf8");
    for (const entry of baseline.entries) {
      const pattern = new RegExp(`"${entry.code}"`);
      expect(
        pattern.test(cliText),
        `baseline lists ${entry.code} but cli.tsx no longer emits it; remove from baseline`,
      ).toBe(true);
    }
  });
});

// ── helpers ───────────────────────────────────────────────────────────

function diffCommands(parsed: ParserResult, inv: Inventory): Finding[] {
  const findings: Finding[] = [];
  const commandBlock = parsed.blocks.find((b) => b.tag === "v0.1.0 commands");
  if (!commandBlock) {
    findings.push({
      kind: "missing-command",
      name: "<no v0.1.0 commands block found>",
      doc_location: "docs/protocol.md",
      runtime_location: "n/a",
      suggestion:
        "Add <!-- inventory:current-begin v0.1.0 commands --> ... <!-- inventory:current-end --> markers around the §10.8 command table.",
    });
    return findings;
  }

  // Build name sets for diffing.
  //   docEnforced — non-skipped rows; runtime MUST have these
  //   docAll      — every row in the block (incl. future/placeholder skips);
  //                  runtime MAY have these but doesn't have to
  const docEnforced = new Set<string>();
  const docAll = new Set<string>();
  for (const row of commandBlock.rows) {
    if (!row.name.startsWith("loaf ")) continue;
    const cmdPath = row.name.slice(5);
    if (cmdPath === "") continue;
    docAll.add(cmdPath);
    if (!row.skipReason) docEnforced.add(cmdPath);
  }

  const runtimePaths = new Set(inv.commands.map((c) => c.path));

  // Direction A: protocol → runtime. Every enforced doc command must appear
  // in the Commander tree. Allow group→leaf prefix match (e.g. docs say
  // `tasks step done`; runtime emits that exact path).
  for (const docName of docEnforced) {
    if (runtimePaths.has(docName)) continue;
    let foundPrefix = false;
    for (const rp of runtimePaths) {
      if (rp === docName || rp.startsWith(docName + " ")) {
        foundPrefix = true;
        break;
      }
    }
    if (!foundPrefix) {
      findings.push({
        kind: "missing-command",
        name: `loaf ${docName}`,
        doc_location: `docs/protocol.md §10.8`,
        runtime_location: "absent",
        suggestion: `Either implement \`loaf ${docName}\` in src/cli.tsx, or move the row to the future-surface section with <!-- inventory:future reason="SC-N" -->.`,
      });
    }
  }

  // Direction B: runtime → protocol. Every runtime LEAF command must have
  // some doc row (current or skipped). Groups (namespaces like `spec`,
  // `tasks`, `gate`) are exempt — their leaves carry the documentation.
  // (codex r191 BLOCKER 2)
  for (const cmd of inv.commands) {
    if (cmd.isGroup) continue;
    if (docAll.has(cmd.path)) continue;
    // Accept docs that document a strict prefix (e.g. doc has `tasks amend`,
    // runtime exposes `tasks amend` directly OR as `tasks amend <T-N>` form).
    let foundDocPrefix = false;
    for (const docName of docAll) {
      if (cmd.path === docName) {
        foundDocPrefix = true;
        break;
      }
      // Doc names should not normally be longer than runtime paths, but allow
      // both directions of prefix match for safety with placeholder rows.
      if (cmd.path.startsWith(docName + " ") || docName.startsWith(cmd.path + " ")) {
        foundDocPrefix = true;
        break;
      }
    }
    if (!foundDocPrefix) {
      findings.push({
        kind: "extra-command",
        name: `loaf ${cmd.path}`,
        doc_location: "absent",
        runtime_location: "src/cli.tsx",
        suggestion: `Add a row in docs/protocol.md §10.8 current-surface block for \`loaf ${cmd.path}\`, OR explicitly mark its row as future/placeholder if it's not part of v0.1.0.`,
      });
    }
  }
  return findings;
}

function diffGlobalFlags(parsed: ParserResult, inv: Inventory): Finding[] {
  const findings: Finding[] = [];
  const flagBlock = parsed.blocks.find((b) => b.tag === "v0.1.0 globalFlags");
  if (!flagBlock) {
    findings.push({
      kind: "missing-command",
      name: "<no v0.1.0 globalFlags block found>",
      doc_location: "docs/protocol.md §10.7",
      runtime_location: "n/a",
      suggestion:
        "Add <!-- inventory:current-begin v0.1.0 globalFlags --> ... <!-- inventory:current-end --> markers around the §10.7 global-flag table.",
    });
    return findings;
  }

  // docEnforced = non-skipped flag rows; runtime MUST expose these as global flags.
  const docEnforced = new Set<string>();
  const docAll = new Set<string>();
  for (const row of flagBlock.rows) {
    if (!row.name.startsWith("--")) continue;
    docAll.add(row.name);
    if (!row.skipReason) docEnforced.add(row.name);
  }
  const runtimeGlobal = new Set(inv.globalFlags.map((f) => f.name));

  // Direction A: protocol → runtime
  for (const docFlag of docEnforced) {
    if (!runtimeGlobal.has(docFlag)) {
      findings.push({
        kind: "missing-command",
        name: docFlag,
        doc_location: "docs/protocol.md §10.7",
        runtime_location: "absent (no global flag of this name)",
        suggestion: `Either expose \`${docFlag}\` as a top-level global flag in src/cli.tsx, or annotate the row with <!-- inventory:future reason="SC-N" --> / <!-- inventory:placeholder reason="..." -->.`,
      });
    }
  }
  // Direction B: runtime → protocol
  for (const flagName of runtimeGlobal) {
    if (docAll.has(flagName)) continue;
    findings.push({
      kind: "extra-command",
      name: flagName,
      doc_location: "absent",
      runtime_location: "src/cli.tsx (top-level Commander program)",
      suggestion: `Add a row for \`${flagName}\` to the §10.7 global-flag table, OR annotate as future/placeholder.`,
    });
  }
  return findings;
}

function diffDiagnostics(bl: Baseline): Finding[] {
  const findings: Finding[] = [];
  const cliText = readFileSync(CLI_PATH, "utf8");
  // Regex captures every `fail("CODE", ...)`, `failRebuild("CODE", ...)`, and
  // `emit*("CODE", ...)` call, plus bare object literal `code: "CODE"` patterns
  // used in some emit paths. (codex r191 PATCH 4 — add failRebuild)
  const emitRe = /\b(?:fail(?:[A-Z][A-Za-z0-9]*)?|emit\w*)\(\s*["']([A-Z][A-Z0-9_]+)["']/g;
  const codes = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = emitRe.exec(cliText)) !== null) {
    codes.add(m[1] ?? "");
  }
  const codeFieldRe = /\bcode:\s*["']([A-Z][A-Z0-9_]+)["']/g;
  while ((m = codeFieldRe.exec(cliText)) !== null) {
    codes.add(m[1] ?? "");
  }

  const catalog = loadCatalogCodes();
  const baselineCodes = new Set(bl.entries.map((e) => e.code));

  for (const code of codes) {
    if (code === "") continue;
    if (catalog.has(code)) continue;
    if (baselineCodes.has(code)) continue;
    findings.push({
      kind: "uncataloged-code",
      name: code,
      doc_location: "docs/schemas.ts §39 ERROR_CATALOG",
      runtime_location: "src/cli.tsx (multiple sites)",
      suggestion: `Either register ${code} in docs/schemas.ts DiagnosticCode + ERROR_CATALOG + i18n bundles, or add it to tests/scripts/inventory/diagnostic-baseline.json with a removal_sc target.`,
    });
  }
  return findings;
}

function loadCatalogCodes(): Set<string> {
  const schemasPath = path.join(REPO_ROOT, "docs", "schemas.ts");
  const text = readFileSync(schemasPath, "utf8");
  // Anchor on the actual enum declaration — `DiagnosticCode` appears in
  // comments before the declaration, so first-match is wrong. The pattern
  // is `export const DiagnosticCode = z.enum([` followed by quoted strings
  // until `]);`.
  const declRe = /export\s+const\s+DiagnosticCode\s*=\s*z\.enum\(\[/;
  const declMatch = text.match(declRe);
  if (!declMatch || declMatch.index === undefined) return new Set();
  const startIdx = declMatch.index + declMatch[0].length;
  const after = text.slice(startIdx);
  const endIdx = after.indexOf("]);");
  if (endIdx < 0) return new Set();
  const block = after.slice(0, endIdx);
  const codes = new Set<string>();
  for (const m of block.matchAll(/["']([A-Z][A-Z0-9_]+)["']/g)) {
    codes.add(m[1] ?? "");
  }
  return codes;
}

function formatFindings(findings: Finding[]): string {
  const lines = ["inventory drift findings:"];
  for (const f of findings) {
    lines.push(`  [${f.kind}] ${f.name}`);
    lines.push(`    doc:     ${f.doc_location}`);
    lines.push(`    runtime: ${f.runtime_location}`);
    lines.push(`    fix:     ${f.suggestion}`);
  }
  return lines.join("\n");
}

// Re-export Finding for the JSON emitter script
export type { Finding };
export { diffCommands, diffDiagnostics, formatFindings };
