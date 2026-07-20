import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  collectQuotedCommandReferences,
  findInvalidCommandReferences,
  findInvalidRepositoryPaths,
} from "./inventory/document-references.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SKILLS_ROOT = path.join(REPO_ROOT, "skills");
const SKILL_FILES = collectSkillFiles(SKILLS_ROOT);

describe("skills semantic drift gate", () => {
  test("command resolution follows group aliases and trailing positionals", async () => {
    expect(
      await findInvalidCommandReferences([
        "loaf log",
        "loaf log list",
        "loaf tasks claim T-001",
      ]),
    ).toEqual([]);
  });

  test("quoted loaf commands exist in the live Commander surface", async () => {
    const ownersByReference = new Map<string, string[]>();
    for (const filePath of SKILL_FILES) {
      const relativePath = path.relative(REPO_ROOT, filePath);
      for (const reference of collectQuotedCommandReferences(readFileSync(filePath, "utf8"))) {
        const owners = ownersByReference.get(reference) ?? [];
        owners.push(relativePath);
        ownersByReference.set(reference, owners);
      }
    }

    const invalid = await findInvalidCommandReferences(ownersByReference.keys());
    const failures = invalid.flatMap((reference) =>
      (ownersByReference.get(reference) ?? []).map((owner) => `${owner}: ${reference}`),
    );
    expect(failures.sort()).toEqual([]);
  });

  test("repository paths and relative Markdown links exist", () => {
    const failures: string[] = [];
    for (const filePath of SKILL_FILES) {
      const relativePath = path.relative(REPO_ROOT, filePath);
      const text = readFileSync(filePath, "utf8");
      for (const reference of findInvalidRepositoryPaths(text, REPO_ROOT)) {
        failures.push(`${relativePath}: ${reference}`);
      }
      for (const target of collectRelativeMarkdownLinks(text)) {
        const resolved = path.resolve(path.dirname(filePath), target);
        if (
          /[{}*<>]/.test(target) ||
          !resolved.startsWith(`${REPO_ROOT}${path.sep}`) ||
          !existsSync(resolved)
        ) {
          failures.push(`${relativePath}: ${target}`);
        }
      }
    }
    expect(failures.sort()).toEqual([]);
  });
});

function collectSkillFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectSkillFiles(entryPath));
    else if (entry.name === "SKILL.md") files.push(entryPath);
  }
  return files.sort();
}

function collectRelativeMarkdownLinks(text: string): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = (match[1] ?? "").split("#", 1)[0]!.trim();
    if (target === "" || target.startsWith("#") || /^[a-z]+:/i.test(target)) continue;
    links.push(target);
  }
  return links;
}
