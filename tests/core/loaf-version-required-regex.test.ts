// RC blocker fix (codex r181 → r182): widen `loaf_version_required`
// regex on both the journal payload (SessionStartedPayload) and the
// state projection (StateProjection) to accept semver prerelease and
// build-metadata identifiers. Without this fix the version pin the
// CLI auto-derives from package.json (`^${packageJson.version}`) fails
// schema validation whenever the package is an RC, alpha, build, or
// any non-stable pre-release — exactly the moment release smoke runs.
//
// Backward-compatible widening:
//   accept old:    `^0.1.0`, `~1.0`, `1.2`, `1.2.3`
//   accept new:    `^0.1.0-rc.1`, `~1.2.3+build.5`, `^1.2.3-alpha.1+build.7`
//   reject still:  `not-a-version`, `^1`, `^1.2.3.4`, `^1.2.3-`, `^1.2.3+`

import { describe, expect, test } from "vitest";

import { SessionStartedPayload } from "../../src/core/journal-entry.js";
import { StateProjection } from "../../src/core/projection-schema.js";

const baseSessionStartedPayload = {
  session_id: "550e8400-e29b-41d4-a716-446655440000",
  feature: "auth-refresh",
  ceremony: {
    spec_phase: true,
    verify_phase: true,
    settle_phase: false,
    strict_spec_review: false,
    lessons_required: "skip" as const,
    strict_drift_check: false,
  },
};

const baseStateProjection = {
  schema_version: 2 as const,
  session_id: "550e8400-e29b-41d4-a716-446655440000",
  session_label: null,
  workspace: "default",
  phase: "TRIAGE" as const,
  sub_state: "TRIAGE.score" as const,
  iteration: 1,
  spec_locked: false,
  verify_accepted: false,
  pending: [],
  ceremony: baseSessionStartedPayload.ceremony,
  ceremony_label: "",
  complexity_score: null,
  based_on: { spec: 0, tasks: 0 },
  spec_version: 0,
  created_at: "2026-05-15T10:00:00.000Z",
  updated_at: "2026-05-15T10:00:00.000Z",
};

const ACCEPT_LEGACY = ["^0.1.0", "~1.0", "1.2", "1.2.3", "^1.2.3", "~1.2.3"];

const ACCEPT_PRE_OR_BUILD = [
  // RC: the case that broke release smoke at HEAD `4aff76f` after
  // bumping package.json to 0.1.0-rc.1.
  "^0.1.0-rc.1",
  "0.1.0-rc.1",
  "^1.2.3-alpha.1",
  "~1.2.3-beta.2",
  // build metadata
  "1.2.3+build.5",
  "^1.2.3+sha.abc1234",
  // both
  "^1.2.3-alpha.1+build.7",
];

const REJECT = [
  "not-a-version",
  "^1",            // missing minor
  "^1.2.3.4",      // four segments — protocol pin is three at most
  "^1.2.3-",       // empty prerelease segment
  "^1.2.3+",       // empty build segment
  "",              // empty string
  "v1.2.3",        // leading `v` not in our prefix set
];

describe("loaf_version_required regex — backward-compatible widening (RC blocker)", () => {
  test.each(ACCEPT_LEGACY)("SessionStartedPayload accepts legacy pin: %s", (pin) => {
    const r = SessionStartedPayload.safeParse({
      ...baseSessionStartedPayload,
      loaf_version_required: pin,
    });
    expect(r.success).toBe(true);
  });

  test.each(ACCEPT_LEGACY)("StateProjection accepts legacy pin: %s", (pin) => {
    const r = StateProjection.safeParse({
      ...baseStateProjection,
      loaf_version_required: pin,
    });
    expect(r.success).toBe(true);
  });

  test.each(ACCEPT_PRE_OR_BUILD)(
    "SessionStartedPayload accepts semver prerelease/build pin: %s",
    (pin) => {
      const r = SessionStartedPayload.safeParse({
        ...baseSessionStartedPayload,
        loaf_version_required: pin,
      });
      expect(r.success).toBe(true);
    },
  );

  test.each(ACCEPT_PRE_OR_BUILD)(
    "StateProjection accepts semver prerelease/build pin: %s",
    (pin) => {
      const r = StateProjection.safeParse({
        ...baseStateProjection,
        loaf_version_required: pin,
      });
      expect(r.success).toBe(true);
    },
  );

  test.each(REJECT)("SessionStartedPayload rejects malformed pin: %s", (pin) => {
    const r = SessionStartedPayload.safeParse({
      ...baseSessionStartedPayload,
      loaf_version_required: pin,
    });
    expect(r.success).toBe(false);
  });

  test.each(REJECT)("StateProjection rejects malformed pin: %s", (pin) => {
    const r = StateProjection.safeParse({
      ...baseStateProjection,
      loaf_version_required: pin,
    });
    expect(r.success).toBe(false);
  });
});
