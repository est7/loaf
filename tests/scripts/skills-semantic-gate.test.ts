import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  collectQuotedCommandReferences,
  findInvalidCommandReferences,
  findInvalidRepositoryPaths,
} from "./inventory/document-references.js";
import {
  classifySkillAdvice,
  parseSkillSupervisionContract,
} from "../helpers/skill-supervision-contract.js";
import { NextOwnerVerb } from "../../src/core/reducer/transition.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SKILLS_ROOT = path.join(REPO_ROOT, "skills");
const SKILL_FILES = collectSkillFiles(SKILLS_ROOT);

describe("skills semantic drift gate", () => {
  test("verify reads kernel-derived lane applicability instead of deciding it", () => {
    const skill = readFileSync(path.join(SKILLS_ROOT, "verify", "SKILL.md"), "utf8");
    expect(skill).toContain("loaf verify status --feature <F> --format json");
    expect(skill).toContain("kernel-derived `lanes[]`");
    expect(skill).toContain("`loaf next` is routing only");
    expect(skill).not.toContain("Decide which lanes apply");
    expect(skill).not.toContain("compute which verify lanes apply");
  });

  test("execute explains RED step outcome, bug-only registration, and actor ownership", () => {
    const skill = readFileSync(path.join(SKILLS_ROOT, "execute", "SKILL.md"), "utf8");
    expect(skill).toContain("step outcome");
    expect(skill).toContain("evidence outcome");
    expect(skill).toContain("ordering proof");
    expect(skill).toContain("behavioral task labelled `bug`");
    expect(skill).toContain("payload `actor` is the evidence attester");
    expect(skill).toContain("journal envelope actor is writer provenance");
  });

  test("protocol preserves evidence attester versus writer provenance", () => {
    const protocol = readFileSync(path.join(REPO_ROOT, "docs", "protocol.md"), "utf8");
    expect(protocol).toContain("payload.actor = evidence attester");
    expect(protocol).toContain("journal envelope actor = writer provenance");
    expect(protocol).toContain("deliberately allowed to differ");
  });

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

  test("the checked-in skill layer declares the supervision boundary", () => {
    const contract = readFileSync(path.join(SKILLS_ROOT, "CONTRACT.md"), "utf8");
    const run = readFileSync(path.join(SKILLS_ROOT, "run", "SKILL.md"), "utf8");
    expect(contract).toContain("live in-repository plugin contract");
    expect(contract).toContain("`LOAF_USER` supplies actor identity only");
    expect(contract).toContain("waiver or manual evidence/attestation");
    expect(run).toContain("continue across non-blocking machine routes");
    expect(run).toContain("Do not create a redundant `go` checkpoint");
    expect(run).toContain("it does not approve anything");
  });

  test("run skill publishes an executable ownership classification", () => {
    const run = readFileSync(path.join(SKILLS_ROOT, "run", "SKILL.md"), "utf8");
    const supervision = parseSkillSupervisionContract(run);
    expect(supervision.route_command).toBe("loaf next");
    expect(
      classifySkillAdvice(supervision, {
        command: "loaf advance SPEC.plan --feature-dir /tmp/feature",
        owner_verb: "advance",
      }),
    ).toEqual({ kind: "automatic" });
    expect(
      classifySkillAdvice(supervision, {
        command: "loaf deliver --feature-dir /tmp/feature",
        owner_verb: "deliver",
      }),
    ).toEqual({ kind: "human-stop", id: "deliver" });
    expect(
      classifySkillAdvice(supervision, {
        command: "loaf settle --feature-dir /tmp/feature",
        owner_verb: "settle",
      }),
    ).toEqual({ kind: "human-stop", id: "settle" });
    expect(
      new Set([
        ...supervision.automatic_owner_verbs,
        ...supervision.human_stops.map((stop) => stop.owner_verb),
      ]),
    ).toEqual(new Set(NextOwnerVerb.options));
  });

  test("supervision classification fails when a required human stop drifts", () => {
    const run = readFileSync(path.join(SKILLS_ROOT, "run", "SKILL.md"), "utf8");
    const drifted = parseSkillSupervisionContract(
      run.replace('"command_prefix": "loaf deliver"', '"command_prefix": "loaf ship"'),
    );
    expect(() =>
      classifySkillAdvice(drifted, {
        command: "loaf deliver --feature-dir /tmp/feature",
        owner_verb: "deliver",
      }),
    ).toThrow("does not classify deliver");
  });

  test("supervision contract rejects contradictory automatic and human ownership", () => {
    const run = readFileSync(path.join(SKILLS_ROOT, "run", "SKILL.md"), "utf8");
    expect(() =>
      parseSkillSupervisionContract(
        run.replace(
          '"automatic_owner_verbs": ["advance", "tasks next"]',
          '"automatic_owner_verbs": ["advance", "tasks next", "deliver"]',
        ),
      ),
    ).toThrow("ownership overlaps: deliver");
  });

  test("supervision contract rejects incomplete kernel owner coverage", () => {
    const run = readFileSync(path.join(SKILLS_ROOT, "run", "SKILL.md"), "utf8");
    const withoutSettle = run.replace(
      /    \{\n      "id": "settle",\n      "command_prefix": "loaf settle",\n      "owner_verb": "settle"\n    \},\n/,
      "",
    );
    expect(withoutSettle).not.toBe(run);
    expect(() => parseSkillSupervisionContract(withoutSettle)).toThrow(
      "ownership is incomplete: settle",
    );
  });

  test("skill instructions never authorize direct loaf artifact mutation", () => {
    for (const filePath of SKILL_FILES) {
      const text = readFileSync(filePath, "utf8");
      for (const line of text.split("\n")) {
        if (!/(?:write|edit|append|overwrite).{0,24}`?\.loaf\//i.test(line)) continue;
        expect(line, path.relative(REPO_ROOT, filePath)).toMatch(
          /\b(?:never|must not|do not|don't)\b/i,
        );
      }
    }
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
