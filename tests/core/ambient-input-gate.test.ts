import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const CORE_DIR = fileURLToPath(new URL("../../src/core", import.meta.url));

const AMBIENT_READ =
  /\b(?:process\.env(?:\[|\.)|(?:os\.)?homedir\s*\(|process\.cwd\s*\(|Date\.now\s*\(|new\s+Date\s*\(\s*\)|Math\.random\s*\(|execFileSync\s*\()/;

type Allowance = {
  tier: "needs-di-retrofit" | "already-di-seamed";
  file: string;
  lines: RegExp[];
};

const ALLOWANCES: Allowance[] = [
  {
    tier: "needs-di-retrofit",
    file: "journal-append.ts",
    lines: [/written_at:\s*new Date\(\)\.toISOString\(\)/],
  },
  {
    tier: "needs-di-retrofit",
    file: "journal-bootstrap.ts",
    lines: [/written_at:\s*new Date\(\)\.toISOString\(\)/],
  },
  {
    tier: "already-di-seamed",
    file: "registry-writer.ts",
    lines: [/process\.env\["LOAF_REGISTRY_DIR"\]/, /os\.homedir\(\)/],
  },
  {
    tier: "already-di-seamed",
    file: "registry-writer.ts",
    lines: [/Date\.now\(\).*Math\.random\(\)/],
  },
  {
    tier: "already-di-seamed",
    file: "crash-log.ts",
    lines: [/now:\s*\(\)\s*=>\s*new Date\(\)/, /homeDir:\s*\(\)\s*=>\s*os\.homedir\(\)/],
  },
  {
    tier: "already-di-seamed",
    file: "migration.ts",
    lines: [
      /at:\s*opts\.migrated_at\s*\?\?\s*new Date\(\)\.toISOString\(\)/,
      /migrated_at:\s*opts\.migrated_at\s*\?\?\s*new Date\(\)\.toISOString\(\)/,
    ],
  },
  {
    tier: "already-di-seamed",
    file: "journal-mutate.ts",
    lines: [
      /now:\s*ctx\.registryWriter\?\.now\?\.\(\)\s*\?\?\s*new Date\(\)/,
      /cwd:\s*ctx\.registryWriter\?\.cwd\?\.\(\)\s*\?\?\s*process\.cwd\(\)/,
    ],
  },
  {
    tier: "already-di-seamed",
    file: "cli-runtime.ts",
    lines: [/path\.join\(process\.cwd\(\),\s*"\.loaf",\s*feature\)/],
  },
  {
    tier: "already-di-seamed",
    file: "cli-runtime.ts",
    lines: [/execFileSync\("git",\s*\["config",\s*"user\.email"\]/],
  },
  {
    tier: "already-di-seamed",
    file: "feature-write-lease.ts",
    lines: [/const now = options\.now \?\? \(\(\) => new Date\(\)\);/],
  },
];

type Match = { file: string; line: string };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [absolute] : [];
  });
}

function ambientMatches(file: string, source: string): Match[] {
  let inBlockComment = false;
  const codeLines = source.split("\n").map((sourceLine) => {
    let line = sourceLine;
    let code = "";
    while (line.length > 0) {
      if (inBlockComment) {
        const end = line.indexOf("*/");
        if (end === -1) return code;
        inBlockComment = false;
        line = line.slice(end + 2);
        continue;
      }
      const lineComment = line.indexOf("//");
      const blockComment = line.indexOf("/*");
      if (lineComment !== -1 && (blockComment === -1 || lineComment < blockComment)) {
        return code + line.slice(0, lineComment);
      }
      if (blockComment === -1) return code + line;
      code += line.slice(0, blockComment);
      line = line.slice(blockComment + 2);
      inBlockComment = true;
    }
    return code;
  });
  return codeLines
    .map((line) => line.trim())
    .filter((line) => AMBIENT_READ.test(line))
    .map((line) => ({ file, line }));
}

describe("core ambient-input gate", () => {
  test("the locked nine-site allowance inventory is exact", () => {
    const matches = sourceFiles(CORE_DIR).flatMap((absolute) =>
      ambientMatches(path.relative(CORE_DIR, absolute), readFileSync(absolute, "utf8")),
    );
    const unexpected = matches.filter(
      (match) =>
        !ALLOWANCES.some(
          (allowance) =>
            allowance.file === match.file &&
            allowance.lines.some((allowedLine) => allowedLine.test(match.line)),
        ),
    );
    const staleAllowances = ALLOWANCES.flatMap((allowance) =>
      allowance.lines
        .filter(
          (allowedLine) =>
            !matches.some((match) => match.file === allowance.file && allowedLine.test(match.line)),
        )
        .map((allowedLine) => ({
          tier: allowance.tier,
          file: allowance.file,
          pattern: allowedLine.source,
        })),
    );

    expect(ALLOWANCES).toHaveLength(10);
    expect(unexpected).toEqual([]);
    expect(staleAllowances).toEqual([]);
  });

  test("direct ambient reads are detected without matching constant dates", () => {
    const envProbe = "const token = process.e" + 'nv["TOKEN"];';
    expect(ambientMatches("probe.ts", envProbe)).toHaveLength(1);
    expect(ambientMatches("probe.ts", "const epoch = new Date(0);")).toEqual([]);
  });
});
