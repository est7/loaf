// SC-6c registered-inventory behavior coverage and dry-run protocol invariants.

import { describe, expect, test, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { createCommandContext } from "../../src/cli/command-context.js";
import { createCommandMutator } from "../../src/cli/command-mutator.js";
import { createJsonInputIngestor } from "../../src/cli/input-ingestion.js";
import { createI18n, BUILTIN_BUNDLES } from "../../src/cli/i18n.js";
import { createCommandProgram, createPolicyCommandProgram } from "../../src/cli/command-program.js";
import { commandPolicyInventory, type CommandPolicy } from "../../src/cli/command-policy.js";
import { CommandPolicyComplete } from "../../src/cli/command-action-policy.js";
import { DiagnosticCode, ERROR_CATALOG } from "../../src/core/error-catalog.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function readRepo(rel: string): Promise<string> {
  return await fs.readFile(path.join(REPO_ROOT, rel), "utf8");
}

// Discover every leaf and exercise its installed hook, not a manually listed subset.
// Expected outcomes follow the declared category contract; labels come from the
// public registration path, independently of production commandLabel().
class BusinessBoundary extends Error {}

function probeProgram(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const argv = ["node", "loaf", ...args];
  const i18n = createI18n("en", BUILTIN_BUNDLES);
  const ctx = createCommandContext(argv, {
    i18n,
    writeStdout: (line) => stdout.push(line),
    writeStderr: (line) => stderr.push(line),
  });
  const input = createJsonInputIngestor({
    readStdin: async () => {
      throw new Error("inventory probe must not read business input");
    },
    isStdinTty: () => false,
  });
  const program = createCommandProgram(
    ctx,
    createCommandMutator(ctx, { registryWriter: undefined }),
    input,
    i18n,
    "cli:inventory-test",
    {},
    () => false,
    () => new Date("2026-01-01T00:00:00Z"),
  );
  let reached: string | undefined;
  program.hook("preAction", (_root, command) => {
    reached = command.name();
    throw new BusinessBoundary();
  });
  return { program, argv, ctx, stdout, stderr, reached: () => reached };
}

function invocation(command: Command): string[] {
  const chain: Command[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent)
    chain.unshift(current);
  return chain.flatMap((part) => [
    part.name(),
    ...part.registeredArguments
      .filter((arg) => arg.required)
      .map((arg) => arg.argChoices?.[0] ?? "probe"),
    ...part.options
      .filter((option) => option.mandatory && option.defaultValue === undefined)
      .flatMap((option) =>
        option.required
          ? [option.long ?? option.short!, option.argChoices?.[0] ?? "probe"]
          : [option.long ?? option.short!],
      ),
  ]);
}

const leaves = commandPolicyInventory(createPolicyCommandProgram()).filter(
  ({ command }) => command.commands.length === 0,
);
const rejectingTypes = new Map([
  ["read-only", "read-only"],
  ["wrapping", "wrapping"],
  ["projection-writer", "projection-writer"],
  ["scaffold-writer", "scaffold-writer"],
  ["spec-edit", "wrapping"],
]);

function modes(policy: CommandPolicy) {
  const result: Array<{
    flags: string[];
    schema: boolean;
    commandType: string | undefined;
    suffix: string;
  }> = [
    {
      flags: [],
      schema: policy.schema?.kind === "artifact",
      commandType: rejectingTypes.get(policy.dryRun),
      suffix: "",
    },
  ];
  if (policy.schema?.kind === "input")
    result.push({
      flags: ["--schema"],
      schema: true,
      commandType: "read-only",
      suffix: " --schema",
    });
  if (policy.dryRun === "spec-edit")
    for (const value of ["", "/missing"])
      result.push({
        flags: [`--input=${value}`],
        schema: false,
        commandType: undefined,
        suffix: "",
      });
  if (policy.selectors === "recovery")
    result.push({
      flags: ["--rebuild"],
      schema: false,
      commandType: "read-only",
      suffix: " --rebuild",
    });
  return result;
}

describe("SC-6c — registered inventory covers installed action policy", () => {
  afterEach(() => vi.unstubAllEnvs());
  test.each(leaves)("$path: every registered mode preserves rejection or continuation", async ({
    command,
    policy,
    path: label,
  }) => {
    expect(policy, `missing policy for ${label}`).toBeDefined();
    vi.stubEnv("LOAF_SESSION", undefined);
    vi.stubEnv("LOAF_FEATURE", undefined);
    for (const mode of modes(policy!)) {
      for (const dryRun of [false, true]) {
        const probe = probeProgram([
          ...invocation(command),
          ...mode.flags,
          ...(dryRun ? ["--dry-run"] : []),
          "--format=json",
        ]);
        const rejected = dryRun && mode.commandType !== undefined;
        await expect(
          probe.program.parseAsync(probe.argv),
          `${label} ${mode.flags} dry-run=${dryRun}`,
        ).rejects.toBeInstanceOf(
          rejected || mode.schema ? CommandPolicyComplete : BusinessBoundary,
        );
        if (rejected) {
          expect(probe.reached()).toBeUndefined();
          expect(probe.stdout).toEqual([]);
          expect(probe.ctx.exitCode).toBe(2);
          expect(JSON.parse(probe.stderr.join(""))).toMatchObject({
            code: "DRY_RUN_NOT_APPLICABLE",
            detail: { command: label + mode.suffix, command_type: mode.commandType },
          });
        } else if (mode.schema) {
          expect(probe.reached()).toBeUndefined();
          expect(probe.ctx.exitCode).toBe(0);
          expect(probe.stderr).toEqual([]);
          const schema = JSON.parse(probe.stdout.join(""));
          expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
          expect(schema.type === "object" || Array.isArray(schema.anyOf)).toBe(true);
        } else {
          expect(probe.reached()).toBe(command.name());
          expect(probe.ctx.exitCode).toBe(0);
          expect(probe.stdout).toEqual([]);
          expect(probe.stderr).toEqual([]);
        }
      }
    }
  });
});

describe("SC-13b — §10.7 dry-run classification ↔ runtime/SC-6c drift gate (codex r349)", () => {
  test("`resume` is NOT in the §10.7 Read-only list (it's a mutator)", async () => {
    const protocolText = await readRepo("docs/protocol.md");
    // Find the Read-only command list line (single line listing in §10.7)
    const readOnlyLine = protocolText
      .split("\n")
      .find((line) => line.includes("Read-only 命令") && line.includes("status"));
    expect(readOnlyLine, "expected to find §10.7 Read-only commands row").toBeDefined();
    // Match a word-boundary `resume` (not "resumes" / "resumed" / "session:resumed")
    const hasResume = /[\s/(]resume[\s/),]/.test(readOnlyLine!);
    expect(
      hasResume,
      "docs/protocol.md §10.7 Read-only list still mentions `resume` — but resume is a mutator (Phase 16 SC-13b); move it to the Mutating list",
    ).toBe(false);
  });

  test("`resume` IS in the §10.7 Mutating list (Phase 16 SC-13b)", async () => {
    const protocolText = await readRepo("docs/protocol.md");
    const mutatingLine = protocolText
      .split("\n")
      .find((line) => line.includes("Mutating 命令") && line.includes("advance"));
    expect(mutatingLine, "expected to find §10.7 Mutating commands row").toBeDefined();
    const hasResume = /[\s/(`]resume[\s/),`*]/.test(mutatingLine!);
    expect(
      hasResume,
      "docs/protocol.md §10.7 Mutating list must include `resume` (Phase 16 SC-13b mutator)",
    ).toBe(true);
  });

  test("§10.7 has a `Projection-writer` category for `handoff` (Phase 16 SC-13a)", async () => {
    const protocolText = await readRepo("docs/protocol.md");
    expect(
      protocolText.includes("Projection-writer"),
      "docs/protocol.md §10.7 must include a Projection-writer category covering `handoff`",
    ).toBe(true);
  });

  test("§10.7 has a `Scaffold-writer` category for `config init`", async () => {
    const protocolText = await readRepo("docs/protocol.md");
    const scaffoldLine = protocolText
      .split("\n")
      .find(
        (line) =>
          line.startsWith("|") && line.includes("Scaffold-writer") && line.includes("config init"),
      );
    expect(
      scaffoldLine,
      "docs/protocol.md §10.7 must include a Scaffold-writer category covering `config init`",
    ).toBeDefined();
    expect(scaffoldLine).toContain('"scaffold-writer"');
  });

  test("§10.7 Hook category row exists (Phase 16 SC-15a)", async () => {
    const protocolText = await readRepo("docs/protocol.md");
    const hookLine = protocolText
      .split("\n")
      .find((line) => line.startsWith("|") && line.includes("Hook 入口") && line.includes("hook"));
    expect(hookLine, "expected §10.7 Hook 入口 row").toBeDefined();
  });

  test("`hook` is NOT in non-Hook §10.7 rows (Phase 16 SC-15a — codex r364 P2)", async () => {
    const protocolText = await readRepo("docs/protocol.md");
    const lines = protocolText.split("\n");
    const CATEGORIES = [
      "Mutating 命令",
      "Read-only 命令",
      "Wrapping 命令",
      "Projection-writer 命令",
    ] as const;
    for (const category of CATEGORIES) {
      const row = lines.find((l) => {
        if (!l.startsWith("|") || !l.includes(category)) return false;
        if (category === "Mutating 命令") return l.includes("走 §11.2 10-step transaction");
        // Other categories use either `reject` or `**reject**` (markdown bold).
        return /reject\*?\*?\s*`--dry-run`/.test(l);
      });
      expect(row, `expected §10.7 ${category} dry-run row to exist`).toBeDefined();
      const hasHook = /[\s/(`]hook[\s/),`*]/.test(row!);
      expect(
        hasHook,
        `§10.7 ${category} row mentions \`hook\` — but hooks have their own dedicated category; remove from ${category}`,
      ).toBe(false);
    }
  });

  test("`tui` is NOT in the §10.7 dry-run Wrapping row (Phase 16 SC-14 — TUI is read-only for dry-run, not wrapping)", async () => {
    const protocolText = await readRepo("docs/protocol.md");
    // Target the §10.7 dry-run table row specifically — it's a table
    // row (starts with `|`) AND mentions reject `--dry-run`. The
    // signal-handling prose at §10.4 also uses "Wrapping 命令" but for
    // signal handling, not dry-run classification. Filter to table
    // rows only.
    const wrappingDryRunRow = protocolText
      .split("\n")
      .find(
        (line) =>
          line.startsWith("|") &&
          line.includes("Wrapping 命令") &&
          line.includes("reject `--dry-run`"),
      );
    expect(wrappingDryRunRow, "expected to find §10.7 Wrapping dry-run table row").toBeDefined();
    const hasTui = /[\s/(`]tui[\s/),`*]/.test(wrappingDryRunRow!);
    expect(
      hasTui,
      "docs/protocol.md §10.7 Wrapping dry-run row still mentions `tui` — but tui is read-only (Phase 16 SC-14); remove from Wrapping",
    ).toBe(false);
  });
});

describe("SC-6c — every mutator call carries dryRun in MutateContext", () => {
  test("static: command handlers cannot bypass CommandMutator dry-run wiring", async () => {
    const familyDir = path.join(REPO_ROOT, "src", "cli", "commands");
    const familyFiles = (await fs.readdir(familyDir, { recursive: true })).filter(
      (f) => f.endsWith(".tsx") || f.endsWith(".ts"),
    );
    const familySources = await Promise.all(
      familyFiles.map((f) => fs.readFile(path.join(familyDir, f), "utf8")),
    );
    const source = familySources.join("\n");

    const mutatorSource = await readRepo("src/cli/command-mutator.ts");
    expect(
      /const\s+createMutationContext\s*=[\s\S]{0,400}?dryRun\s*:\s*ctx\.dryRun/.test(mutatorSource),
      "CommandMutator must wire `dryRun: ctx.dryRun` in its private context factory",
    ).toBe(true);
    expect(source).not.toMatch(/from\s+["'][^"']*journal-mutate\.js["']/);
    expect(source).not.toMatch(/\b(?:mutator\.)?(?:mctxFor|finishMutate)\b/);
    expect(source).not.toMatch(/\bawait\s+mutate(?:Batch)?\s*\(/);
    expect(
      source.match(/await\s+mutator\.(?:run|runBatch|runPreparedBatch)\s*\(/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(28);
  });
});

describe("SC-6c — protocol + schema invariants", () => {
  test("protocol: --dry-run row has no inventory:future annotation", async () => {
    const md = await readRepo("docs/protocol.md");
    const row = md.match(/^\| `--dry-run`[^\n]*$/m);
    expect(row).not.toBeNull();
    expect(row![0]).not.toContain("inventory:future");
  });

  test("schema: DRY_RUN_NOT_APPLICABLE in ERROR_CATALOG + derived DiagnosticCode", () => {
    expect(ERROR_CATALOG).toHaveProperty("DRY_RUN_NOT_APPLICABLE");
    expect(DiagnosticCode.options).toContain("DRY_RUN_NOT_APPLICABLE");
  });

  test("i18n: DRY_RUN_NOT_APPLICABLE flat-string in both en + zh", async () => {
    const en = await readRepo("i18n/en.json");
    const zh = await readRepo("i18n/zh.json");
    const enObj = JSON.parse(en) as { diagnostic: Record<string, string> };
    const zhObj = JSON.parse(zh) as { diagnostic: Record<string, string> };
    expect(enObj.diagnostic["DRY_RUN_NOT_APPLICABLE"]).toBeTypeOf("string");
    expect(zhObj.diagnostic["DRY_RUN_NOT_APPLICABLE"]).toBeTypeOf("string");
    // Placeholders present
    expect(enObj.diagnostic["DRY_RUN_NOT_APPLICABLE"]).toContain("{command}");
    expect(enObj.diagnostic["DRY_RUN_NOT_APPLICABLE"]).toContain("{command_type}");
  });
});
