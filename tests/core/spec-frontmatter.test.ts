// readSpecFrontmatter — disk I/O + YAML + zod validate boundary.
//
// Subcodes preserved so caller (sub-cycle 3 mutateBatch wire) can map to
// gate-result check 1 with detail.subcode (codex r20 GO v2).

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { readSpecFrontmatter } from "../../src/core/spec-frontmatter.js";

const tmpDirs: string[] = [];

async function makeFeatureDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-spec-frontmatter-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const HAPPY_FRONTMATTER = `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: OAuth token refresh
intent: users should not perceive auth recovery flows in flight
adr_refs: []
requirements:
  - id: REQ-AUTH-001
    type: ubiquitous
    response: the system shall handle the case under all conditions
    acceptance_na: true
    acceptance_na_reason: subjective UX validated via manual testing scope
scenarios: []
needs_clarification: []
---

## Why

prose body here
`;

describe("readSpecFrontmatter — disk + YAML + zod boundary", () => {
  test("SPEC_NOT_FOUND when spec.md is missing", async () => {
    const dir = await makeFeatureDir();
    const result = await readSpecFrontmatter(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SPEC_NOT_FOUND");
      expect(result.message).toMatch(/spec\.md not found/);
      expect(result.detail?.path).toMatch(/spec\.md$/);
    }
  });

  test("SPEC_YAML_INVALID when frontmatter fence is missing", async () => {
    const dir = await makeFeatureDir();
    await fs.writeFile(path.join(dir, "spec.md"), "## just prose, no frontmatter\n");
    const result = await readSpecFrontmatter(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SPEC_YAML_INVALID");
      expect(result.message).toMatch(/missing.*frontmatter/i);
    }
  });

  test("SPEC_YAML_INVALID when frontmatter YAML is syntactically broken", async () => {
    const dir = await makeFeatureDir();
    await fs.writeFile(
      path.join(dir, "spec.md"),
      "---\nfeature: {id: F-001, name: missing closing brace\nintent: broken\n---\n",
    );
    const result = await readSpecFrontmatter(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SPEC_YAML_INVALID");
    }
  });

  test("SPEC_FRONTMATTER_INVALID when YAML parses but zod validation fails", async () => {
    const dir = await makeFeatureDir();
    // missing required `intent` field
    await fs.writeFile(
      path.join(dir, "spec.md"),
      `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: feat
adr_refs: []
requirements: []
scenarios: []
needs_clarification: []
---
`,
    );
    const result = await readSpecFrontmatter(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SPEC_FRONTMATTER_INVALID");
      expect(result.detail?.issues).toBeDefined();
    }
  });

  test("happy path returns parsed SpecFrontmatter", async () => {
    const dir = await makeFeatureDir();
    await fs.writeFile(path.join(dir, "spec.md"), HAPPY_FRONTMATTER);
    const result = await readSpecFrontmatter(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frontmatter.feature.id).toBe("F-001");
      expect(result.frontmatter.requirements).toHaveLength(1);
      expect(result.frontmatter.requirements[0]!.id).toBe("REQ-AUTH-001");
    }
  });

  test("SPEC_FRONTMATTER_INVALID rejects legacy schema_version=1 (codex r21 fix)", async () => {
    const dir = await makeFeatureDir();
    await fs.writeFile(
      path.join(dir, "spec.md"),
      `---
schema_version: 1
spec_version: 1
feature:
  id: F-001
  name: feat
intent: twenty char minimum intent body here for parse
adr_refs: []
requirements: []
scenarios: []
needs_clarification: []
---
`,
    );
    const result = await readSpecFrontmatter(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SPEC_FRONTMATTER_INVALID");
    }
  });

  test("structural REQ without verifiability passes through (lands at check 5 in caller)", async () => {
    // codex r20 GO v2 — frontmatter parser is shape-only; missing
    // verifiability is reachable as spec-lock check 5, not check 1.
    const dir = await makeFeatureDir();
    await fs.writeFile(
      path.join(dir, "spec.md"),
      `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: feat
intent: twenty char minimum intent body here for parse
adr_refs: []
requirements:
  - id: REQ-AUTH-002
    type: ubiquitous
    response: the system shall provide reasonable behavior here
scenarios: []
needs_clarification: []
---
`,
    );
    const result = await readSpecFrontmatter(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frontmatter.requirements).toHaveLength(1);
      // confirms layer split — readSpec accepts unverifiable REQ
    }
  });
});
