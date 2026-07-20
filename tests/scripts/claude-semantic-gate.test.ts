import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  collectCommandReferences,
  findInvalidCommandReferences,
  findInvalidRepositoryPaths,
} from "./inventory/document-references.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLAUDE_PATH = path.join(REPO_ROOT, "CLAUDE.md");
const CLAUDE = readFileSync(CLAUDE_PATH, "utf8");

const CLAIM_PATTERN =
  /<!-- claude-semantic-claim: ([a-z0-9-]+) owner=([^\s]+) -->\r?\n([\s\S]*?)\r?\n<!-- \/claude-semantic-claim -->/g;

type SemanticClaim = {
  id: string;
  owner: string;
  body: string;
  source: string;
};

type ClaimPolicy = {
  owner: string;
  check: (claim: SemanticClaim) => void;
};

const CLAIM_POLICIES: ReadonlyMap<string, ClaimPolicy> = new Map([
  ["protocol-revision", { owner: "docs/protocol.md", check: checkProtocolRevision }],
]);

describe("CLAUDE.md semantic drift gate", () => {
  test("intentional mirrored claims have an explicit owner-backed checker", () => {
    const claims = parseClaims(CLAUDE);
    expect(claims.map((claim) => claim.id).sort()).toEqual([...CLAIM_POLICIES.keys()].sort());

    for (const claim of claims) {
      const policy = CLAIM_POLICIES.get(claim.id);
      expect(policy, `${claim.id} must have an owner-backed checker`).toBeDefined();
      if (policy === undefined) continue;
      expect(claim.owner, `${claim.id} owner`).toBe(policy.owner);
      expect(existsSync(path.join(REPO_ROOT, claim.owner)), `${claim.id} owner exists`).toBe(true);
      policy.check(claim);
    }

    const starts = CLAUDE.match(/<!-- claude-semantic-claim:/g)?.length ?? 0;
    const ends = CLAUDE.match(/<!-- \/claude-semantic-claim -->/g)?.length ?? 0;
    expect(starts, "every claim start must parse").toBe(claims.length);
    expect(ends, "every claim end must parse").toBe(claims.length);
  });

  test("repository file references exist and do not hide behind glob syntax", () => {
    expect(findInvalidRepositoryPaths(CLAUDE, REPO_ROOT)).toEqual([]);
  });

  test("documented loaf commands exist in the live Commander surface", async () => {
    expect(await findInvalidCommandReferences(collectCommandReferences(CLAUDE))).toEqual([]);
  });

  test("revision, kind-count, and ID-format mirrors cannot bypass the claim allowlist", () => {
    const unclaimed = CLAUDE.replace(CLAIM_PATTERN, "");
    expect(unclaimed.match(/\brev\s+\d+(?:\.\d+)+\b/gi) ?? []).toEqual([]);
    expect(unclaimed.match(/\b\d+\s+kinds?\b/gi) ?? []).toEqual([]);
    expect(unclaimed.match(/^#{1,6}\s+Id formats?\b.*$/gim) ?? []).toEqual([]);
    expect(
      unclaimed.match(/\b(?:F|JE|T|PEND|EV|FND)-N{3,6}\b|\b(?:REQ|SCEN|VIS)-<NS>-NNN\b/g) ?? [],
    ).toEqual([]);
  });
});

function parseClaims(text: string): SemanticClaim[] {
  return [...text.matchAll(CLAIM_PATTERN)].map((match) => ({
    id: match[1] ?? "",
    owner: match[2] ?? "",
    body: match[3] ?? "",
    source: match[0],
  }));
}

function checkProtocolRevision(claim: SemanticClaim): void {
  const documented = claim.body.match(/\brev\s+(\d+(?:\.\d+)*)\b/i)?.[1];
  const ownerText = readFileSync(path.join(REPO_ROOT, claim.owner), "utf8");
  const owned = ownerText.match(/^#\s+.+\brev\s+(\d+(?:\.\d+)*)\b/im)?.[1];
  expect(documented, claim.source).toBeDefined();
  expect(documented, claim.source).toBe(owned);
}
