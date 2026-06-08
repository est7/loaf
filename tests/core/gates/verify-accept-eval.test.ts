// verify-accept-eval — Slice 1.C sub-cycle 4.
//
// IO boundary tests for evaluateVerifyAccept(snapshot, featureDir):
// composes readSpecFrontmatter (disk read) + verifyAcceptCheck (pure).
// Mirrors the integration-tested IO model from spec-lock-eval (covered
// in tests/core/journal-mutate.test.ts via sub-cycle 1.B 3c Pass 1.5
// tests). This file adds focused unit-level coverage for the spec.md
// read-failure mapping into check 1 FailedCheck.

import { describe, expect, test } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { evaluateVerifyAccept } from "../../../src/core/gates/verify-accept-eval.js";
import { initialSnapshot } from "../../../src/core/reducer.js";
import type { Snapshot } from "../../../src/core/reducer.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-verify-accept-eval-"));
}

function execSnapshot(): Snapshot {
  const base = initialSnapshot();
  return {
    ...base,
    state: {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "F-001",
      phase: "VERIFY",
      sub_state: "VERIFY.accept",
      iteration: 1,
      spec_locked: true,
      verify_accepted: false,
      spec_version: 1,
      ceremony: {
        spec_phase: true,
        verify_phase: true,
        settle_phase: false,
        strict_spec_review: false,
        lessons_required: "skip",
        strict_drift_check: false,
      },
    },
    tasks_based_on: { spec: 1 },
  };
}

// Minimal valid spec.md frontmatter with a single ubiquitous REQ that has
// acceptance_na set so no SCEN/VIS coverage is required — keeps the
// happy-path snapshot lean while still exercising the full IO + check
// pipeline.
const SPEC_MD_MINIMAL = `---
schema_version: 2
spec_version: 1
feature:
  id: F-001
  name: OAuth refresh
intent: keep auth invisible during refresh roundtrips
adr_refs: []
needs_clarification: []
requirements:
  - id: REQ-AUTH-001
    type: ubiquitous
    response: the system shall preserve the original request after refresh
    acceptance_na: true
    acceptance_na_reason: covered by manual UX walk-through scope
scenarios: []
---

# OAuth refresh

(spec body...)
`;

describe("evaluateVerifyAccept — IO boundary mapping", () => {
  test("SPEC_NOT_FOUND → check:1 FailedCheck with subcode detail", async () => {
    const dir = await tmpFeatureDir();
    // No spec.md created.
    const result = await evaluateVerifyAccept(execSnapshot(), dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.check).toBe(1);
    expect(result.checks[0]!.code).toBe("SPEC_FRONTMATTER_INVALID");
    expect(result.checks[0]!.detail?.subcode).toBe("SPEC_NOT_FOUND");
  });

  test("SPEC_YAML_INVALID → check:1 FailedCheck preserves subcode", async () => {
    const dir = await tmpFeatureDir();
    await fs.writeFile(path.join(dir, "spec.md"), "---\n[: bogus yaml :]\n---\n");
    const result = await evaluateVerifyAccept(execSnapshot(), dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.checks[0]!.code).toBe("SPEC_FRONTMATTER_INVALID");
    expect(result.checks[0]!.detail?.subcode).toBe("SPEC_YAML_INVALID");
  });

  test("SPEC_FRONTMATTER_INVALID (schema-invalid) → check:1 FailedCheck preserves subcode", async () => {
    const dir = await tmpFeatureDir();
    await fs.writeFile(
      path.join(dir, "spec.md"),
      `---
schema_version: 99
spec_version: 1
---
`,
    );
    const result = await evaluateVerifyAccept(execSnapshot(), dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.checks[0]!.code).toBe("SPEC_FRONTMATTER_INVALID");
    expect(result.checks[0]!.detail?.subcode).toBe("SPEC_FRONTMATTER_INVALID");
  });

  test("happy: valid spec.md + clean snapshot → verifyAcceptCheck passes through ok=true", async () => {
    const dir = await tmpFeatureDir();
    await fs.writeFile(path.join(dir, "spec.md"), SPEC_MD_MINIMAL);
    // Snapshot has no done tasks → no RUN/REVIEW lane obligations;
    // REQ has acceptance_na so check 3 is skipped; no findings → check 2 ok;
    // tasks_based_on aligned with spec_version → check 4 precondition ok.
    const result = await evaluateVerifyAccept(execSnapshot(), dir);
    expect(result.ok).toBe(true);
  });

  test("valid spec.md + dirty snapshot (open finding) → verifyAcceptCheck failure passes through", async () => {
    const dir = await tmpFeatureDir();
    await fs.writeFile(path.join(dir, "spec.md"), SPEC_MD_MINIMAL);
    const snap = execSnapshot();
    snap.findings.push({
      id: "FND-001",
      category: "impl-defect",
      action: "fix-impl",
      status: "open",
    });
    const result = await evaluateVerifyAccept(snap, dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.checks.some((c) => c.code === "OPEN_FINDINGS_PRESENT")).toBe(true);
    // Spec read succeeded → no SPEC_FRONTMATTER_INVALID surfaces.
    expect(result.checks.every((c) => c.code !== "SPEC_FRONTMATTER_INVALID")).toBe(true);
  });
});
