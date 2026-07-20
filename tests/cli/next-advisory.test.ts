import { describe, expect, test } from "vitest";

import { buildNextAdvisory } from "../../src/cli/next-advisory.js";
import { BUILTIN_BUNDLES, createI18n } from "../../src/cli/i18n.js";
import type { BuildNextOutputInput } from "../../src/core/next-action.js";

const STANDARD = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
} as const;

function input(overrides: Partial<BuildNextOutputInput> = {}): BuildNextOutputInput {
  return {
    feature: "auth-refresh",
    feature_dir: "/repo/.loaf/auth-refresh",
    phase: "TRIAGE",
    sub_state: "TRIAGE.score",
    ceremony: STANDARD,
    spec_locked: false,
    verify_accepted: false,
    pending: [],
    ...overrides,
  };
}

describe("buildNextAdvisory", () => {
  test("non-blocking action reuses buildNextOutput and becomes a scoped runnable command", () => {
    expect(
      buildNextAdvisory(createI18n("en", BUILTIN_BUNDLES), input(), {
        kind: "feature-dir",
        value: "/tmp/feature dir",
      }),
    ).toBe("loaf advance TRIAGE.confirm --feature-dir '/tmp/feature dir'");
  });

  test("blocking human action becomes a localized, runnable loaf-next pointer", () => {
    const specDesign = input({ phase: "SPEC", sub_state: "SPEC.design" });
    const selector = { kind: "feature", value: "auth-refresh" } as const;

    expect(buildNextAdvisory(createI18n("en", BUILTIN_BUNDLES), specDesign, selector)).toBe(
      "run `loaf next --feature auth-refresh --format json` for the full command",
    );
    expect(buildNextAdvisory(createI18n("zh", BUILTIN_BUNDLES), specDesign, selector)).toBe(
      "运行 `loaf next --feature auth-refresh --format json` 获取完整命令",
    );
  });

  test("shell-quotes selectors so the advertised command remains copy-pasteable", () => {
    expect(
      buildNextAdvisory(createI18n("en", BUILTIN_BUNDLES), input(), {
        kind: "feature",
        value: "owner's feature",
      }),
    ).toBe("loaf advance TRIAGE.confirm --feature 'owner'\"'\"'s feature'");
  });
});
