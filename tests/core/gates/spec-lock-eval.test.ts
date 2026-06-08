// spec-lock-eval — IO boundary tests for evaluateSpecLock(snapshot, featureDir).
//
// L7: evaluateSpecLock and evaluateVerifyAccept now share their gate-mode body
// via gateEvalFromCheck. verify-accept-eval.test.ts pins the factory from the
// verify-accept adapter; this file gives SYMMETRIC direct coverage from the
// spec-lock adapter — proving the same factory maps a spec.md read failure to a
// spec-lock-typed `check:1` SPEC_FRONTMATTER_INVALID row with the read subcode
// preserved. (spec-lock happy-path + the 8 pure checks are integration-tested
// via tests/core/journal-mutate.test.ts Pass 1.5.)

import { describe, expect, test } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { evaluateSpecLock } from "../../../src/core/gates/spec-lock-eval.js";
import { initialSnapshot } from "../../../src/core/reducer.js";
import type { Snapshot } from "../../../src/core/reducer.js";

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-spec-lock-eval-"));
}

function specDesignSnapshot(): Snapshot {
  const base = initialSnapshot();
  return {
    ...base,
    state: {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "F-001",
      phase: "SPEC",
      sub_state: "SPEC.design",
      iteration: 1,
      spec_locked: false,
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
  };
}

describe("evaluateSpecLock — IO boundary mapping (shared gateEvalFromCheck)", () => {
  test("SPEC_NOT_FOUND → check:1 FailedCheck with subcode detail", async () => {
    const dir = await tmpFeatureDir();
    // No spec.md created.
    const result = await evaluateSpecLock(specDesignSnapshot(), dir);
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
    const result = await evaluateSpecLock(specDesignSnapshot(), dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.checks[0]!.code).toBe("SPEC_FRONTMATTER_INVALID");
    expect(result.checks[0]!.detail?.subcode).toBe("SPEC_YAML_INVALID");
  });

  test("SPEC_FRONTMATTER_INVALID (schema-invalid) → check:1 preserves subcode", async () => {
    const dir = await tmpFeatureDir();
    await fs.writeFile(
      path.join(dir, "spec.md"),
      "---\nschema_version: 99\nspec_version: 1\n---\n",
    );
    const result = await evaluateSpecLock(specDesignSnapshot(), dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.checks[0]!.code).toBe("SPEC_FRONTMATTER_INVALID");
    expect(result.checks[0]!.detail?.subcode).toBe("SPEC_FRONTMATTER_INVALID");
  });
});
