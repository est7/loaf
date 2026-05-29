// Phase 16 SC-9c — `loaf check <path>` pure module tests.
//
// Covers checkFile dispatch + mapZodIssues cap + KIND_DISPATCH per kind.
// Codex r309 lock — RED matrix:
//   - per-kind happy: spec / tasks / evidence / finding / pending / state
//   - --kind override (basename mismatches kind)
//   - basename auto-detect
//   - unknown basename → USAGE specify --kind
//   - invalid JSON → SCHEMA_VALIDATION_FAILED subcode=invalid-json
//   - missing frontmatter (spec) → subcode=missing-frontmatter
//   - invalid YAML (spec) → subcode=invalid-yaml
//   - Zod fail → subcode=zod + errors[] shape
//   - mapZodIssues cap with truncation = false (issues=5)
//   - mapZodIssues cap with truncation = true (issues=50 → errors=20, error_count=50)
//   - did-you-mean: `tasks` + no file → USAGE suggestion
//   - did-you-mean: `./tasks` (no file) → INPUT_FILE_NOT_FOUND, NO suggestion
//   - did-you-mean: real file named "tasks" exists → normal flow (unknown kind USAGE)
//   - INPUT_FILE_NOT_FOUND for absent file

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

import {
  CHECK_KINDS,
  KIND_DISPATCH,
  MAX_CHECK_ERRORS,
  checkFile,
  mapZodIssues,
} from "../../src/cli/check-file.js";

async function tmp(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc9c-"));
}

const VALID_SPEC_MD = `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: OAuth token refresh
intent: users should not perceive auth recovery flows in flight
adr_refs: []
requirements: []
scenarios: []
needs_clarification: []
---

## Why
prose
`;

const VALID_TASKS_JSON = JSON.stringify({
  schema_version: 2,
  version: 1,
  based_on: { spec: 1 },
  tasks: [],
});

const VALID_EVIDENCE_JSON = JSON.stringify({
  schema_version: 2,
  evidence: [],
});

const VALID_FINDINGS_JSON = JSON.stringify({
  schema_version: 2,
  findings: [],
});

const VALID_PENDING_JSON = JSON.stringify({
  schema_version: 2,
  pending: [],
});

const VALID_STATE_JSON = JSON.stringify({
  schema_version: 2,
  session_id: "550e8400-e29b-41d4-a716-446655440000",
  session_label: null,
  workspace: "default",
  loaf_version_required: null,
  phase: "TRIAGE",
  sub_state: "TRIAGE.score",
  iteration: 1,
  spec_locked: false,
  verify_accepted: false,
  pending: [],
  ceremony: {
    spec_phase: true,
    verify_phase: true,
    settle_phase: false,
    strict_spec_review: false,
    lessons_required: "skip",
    strict_drift_check: false,
  },
  ceremony_label: "standard",
  complexity_score: null,
  based_on: { spec: 0, tasks: 0 },
  spec_version: 0,
  created_at: "2026-05-29T05:00:00.000Z",
  updated_at: "2026-05-29T05:00:00.000Z",
});

// ───────────────────────────────────────────────────────────────────────
// Per-kind happy paths
// ───────────────────────────────────────────────────────────────────────
describe("checkFile — per-kind happy paths", () => {
  for (const [kind, raw] of [
    ["spec", VALID_SPEC_MD],
    ["tasks", VALID_TASKS_JSON],
    ["evidence", VALID_EVIDENCE_JSON],
    ["finding", VALID_FINDINGS_JSON],
    ["pending", VALID_PENDING_JSON],
    ["state", VALID_STATE_JSON],
  ] as const) {
    test(`${kind}: valid file → ok=true with kind + absolute path`, async () => {
      const dir = await tmp();
      const filePath = path.join(dir, KIND_DISPATCH[kind].basename);
      await fs.writeFile(filePath, raw);
      const result = await checkFile({ path: filePath });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.kind).toBe(kind);
      expect(result.path).toBe(filePath);
    });
  }
});

// ───────────────────────────────────────────────────────────────────────
// --kind explicit override
// ───────────────────────────────────────────────────────────────────────
describe("checkFile — --kind override", () => {
  test("explicit --kind tasks overrides non-matching basename", async () => {
    const dir = await tmp();
    const filePath = path.join(dir, "scratch.json");
    await fs.writeFile(filePath, VALID_TASKS_JSON);
    const result = await checkFile({ path: filePath, kind: "tasks" });
    expect(result.ok).toBe(true);
  });

  test("explicit --kind spec on .md file with frontmatter", async () => {
    const dir = await tmp();
    const filePath = path.join(dir, "alternate-spec.md");
    await fs.writeFile(filePath, VALID_SPEC_MD);
    const result = await checkFile({ path: filePath, kind: "spec" });
    expect(result.ok).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Kind detection edge cases
// ───────────────────────────────────────────────────────────────────────
describe("checkFile — kind detection", () => {
  test("unknown basename + no --kind → USAGE specify --kind", async () => {
    const dir = await tmp();
    const filePath = path.join(dir, "random.json");
    await fs.writeFile(filePath, "{}");
    const result = await checkFile({ path: filePath });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("USAGE");
    expect(result.detail["hint"]).toBe("specify --kind");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Parse failures
// ───────────────────────────────────────────────────────────────────────
describe("checkFile — parse failures", () => {
  test("invalid JSON → SCHEMA_VALIDATION_FAILED subcode=invalid-json", async () => {
    const dir = await tmp();
    const filePath = path.join(dir, "tasks.json");
    await fs.writeFile(filePath, "not valid json {");
    const result = await checkFile({ path: filePath });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(result.detail["subcode"]).toBe("invalid-json");
  });

  test("spec missing frontmatter → subcode=missing-frontmatter", async () => {
    const dir = await tmp();
    const filePath = path.join(dir, "spec.md");
    await fs.writeFile(filePath, "# No frontmatter here\nprose only\n");
    const result = await checkFile({ path: filePath });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(result.detail["subcode"]).toBe("missing-frontmatter");
  });

  test("spec invalid YAML → subcode=invalid-yaml", async () => {
    const dir = await tmp();
    const filePath = path.join(dir, "spec.md");
    await fs.writeFile(filePath, "---\n: : not valid yaml @ :\n---\nbody\n");
    const result = await checkFile({ path: filePath });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(result.detail["subcode"]).toBe("invalid-yaml");
  });

  test("Zod fail → subcode=zod + errors[] shape", async () => {
    const dir = await tmp();
    const filePath = path.join(dir, "tasks.json");
    await fs.writeFile(filePath, JSON.stringify({ wrong: "shape" }));
    const result = await checkFile({ path: filePath });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(result.detail["subcode"]).toBe("zod");
    expect(Array.isArray(result.detail["errors"])).toBe(true);
    const errors = result.detail["errors"] as Array<unknown>;
    expect(errors.length).toBeGreaterThan(0);
    const first = errors[0] as Record<string, unknown>;
    expect(typeof first["path"]).toBe("string");
    expect(typeof first["message"]).toBe("string");
    expect(typeof first["code"]).toBe("string");
  });
});

// ───────────────────────────────────────────────────────────────────────
// mapZodIssues cap (codex r309 B2)
// ───────────────────────────────────────────────────────────────────────
describe("mapZodIssues — MAX_CHECK_ERRORS cap", () => {
  test("issues=5 → truncated=false, errors.length=5, error_count=5", () => {
    const schema = z.object({ items: z.array(z.number()) });
    const result = schema.safeParse({ items: ["a", "b", "c", "d", "e"] });
    if (result.success) throw new Error("test fixture invalid");
    const issues = mapZodIssues(result.error);
    expect(issues.truncated).toBe(false);
    expect(issues.error_count).toBe(5);
    expect(issues.errors).toHaveLength(5);
  });

  test("issues=50 → truncated=true, errors.length=20, error_count=50", () => {
    const schema = z.object({ items: z.array(z.number()) });
    const items = Array.from({ length: 50 }, () => "x");
    const result = schema.safeParse({ items });
    if (result.success) throw new Error("test fixture invalid");
    const issues = mapZodIssues(result.error);
    expect(issues.truncated).toBe(true);
    expect(issues.error_count).toBe(50);
    expect(issues.errors).toHaveLength(MAX_CHECK_ERRORS);
    expect(MAX_CHECK_ERRORS).toBe(20);
  });
});

// ───────────────────────────────────────────────────────────────────────
// did-you-mean (codex r309 N2)
// ───────────────────────────────────────────────────────────────────────
describe("checkFile — did-you-mean for `loaf check tasks`", () => {
  test("literal arg `tasks` + no file at path → USAGE with suggestion", async () => {
    const dir = await tmp();
    const result = await checkFile({ path: "tasks", cwd: dir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("USAGE");
    expect(result.message).toContain("'loaf tasks check'");
    expect(result.detail["suggestion"]).toBe("loaf tasks check");
  });

  test("`./tasks` (no file) → INPUT_FILE_NOT_FOUND (not USAGE — codex r311)", async () => {
    const dir = await tmp();
    // r311 lock: explicit dot-slash bypasses did-you-mean; file does not
    // exist → must surface as INPUT_FILE_NOT_FOUND, NOT USAGE specify
    // --kind. The existence check precedes kind resolution.
    const result = await checkFile({ path: "./tasks", cwd: dir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("INPUT_FILE_NOT_FOUND");
    expect(result.message).not.toContain("'loaf tasks check'");
  });

  test("real file named `tasks` exists → USAGE specify --kind (no suggestion)", async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "tasks"), "{}");
    const result = await checkFile({ path: "tasks", cwd: dir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // File exists; basename "tasks" doesn't auto-detect to any kind.
    // r311: file-exists → USAGE specify --kind (NOT did-you-mean, NOT
    // INPUT_FILE_NOT_FOUND).
    expect(result.code).toBe("USAGE");
    expect(result.message).toContain("specify --kind");
    expect(result.message).not.toContain("'loaf tasks check'");
  });
});

describe("checkFile — r311: file-existence before kind resolution", () => {
  test("non-tasks noun `evidence` no-file → INPUT_FILE_NOT_FOUND (NOT USAGE)", async () => {
    const dir = await tmp();
    const result = await checkFile({ path: "evidence", cwd: dir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("INPUT_FILE_NOT_FOUND");
  });

  test("non-tasks noun `spec` no-file → INPUT_FILE_NOT_FOUND", async () => {
    const dir = await tmp();
    const result = await checkFile({ path: "spec", cwd: dir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("INPUT_FILE_NOT_FOUND");
  });

  test("missing random.json → INPUT_FILE_NOT_FOUND (file check beats kind check)", async () => {
    const dir = await tmp();
    const result = await checkFile({ path: path.join(dir, "random.json") });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("INPUT_FILE_NOT_FOUND");
  });

  test("existing random.json (unknown basename) → USAGE specify --kind", async () => {
    const dir = await tmp();
    const filePath = path.join(dir, "random.json");
    await fs.writeFile(filePath, "{}");
    const result = await checkFile({ path: filePath });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("USAGE");
    expect(result.detail["hint"]).toBe("specify --kind");
  });
});

// ───────────────────────────────────────────────────────────────────────
// INPUT_FILE_NOT_FOUND
// ───────────────────────────────────────────────────────────────────────
describe("checkFile — file not found", () => {
  test("non-tasks basename + no file → INPUT_FILE_NOT_FOUND", async () => {
    const dir = await tmp();
    const filePath = path.join(dir, "tasks.json");
    const result = await checkFile({ path: filePath });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("INPUT_FILE_NOT_FOUND");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Sanity — CHECK_KINDS and KIND_DISPATCH stay in sync
// ───────────────────────────────────────────────────────────────────────
describe("CHECK_KINDS / KIND_DISPATCH consistency", () => {
  test("every CHECK_KINDS entry has a KIND_DISPATCH row", () => {
    for (const k of CHECK_KINDS) {
      expect(KIND_DISPATCH[k]).toBeDefined();
    }
  });

  test("KIND_DISPATCH.finding maps to plural findings.json basename (singular CLI noun, plural file)", () => {
    expect(KIND_DISPATCH.finding.basename).toBe("findings.json");
  });
});
