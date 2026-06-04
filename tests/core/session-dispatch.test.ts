// Phase 16 SC-8 — session-dispatch resolver pure unit tests.
//
// Covers protocol §10.3 5-level precedence + --feature-dir matrix +
// per-source error semantics. Auto-pick (level 5) has its own test
// file because it needs more elaborate cwd setup.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { resolveDispatch } from "../../src/core/session-dispatch.js";
import { mutate } from "../../src/core/journal-mutate.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import { emptyMeta } from "../../src/core/snapshot.js";
import type { Ceremony } from "../../src/core/journal-entry.js";

const STANDARD_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

async function tmpRegDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc8-reg-"));
}

async function tmpCwd(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc8-cwd-"));
}

/** Create a real feature session at cwd/.loaf/<feature>/ + registry
 *  entry. Returns the session_id so tests can use --session lookups. */
async function seedFeatureWithRegistry(
  cwd: string,
  feature: string,
  registryDir: string,
  sessionIdOverride?: string,
): Promise<string> {
  const sessionId = sessionIdOverride ?? `550e8400-e29b-41d4-a716-${Math.random().toString(16).slice(2, 14).padStart(12, "0")}`;
  const featureDir = path.join(cwd, ".loaf", feature);
  await fs.mkdir(featureDir, { recursive: true });

  const result = await mutate(
    {
      at: "2026-05-28T13:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: {
        session_id: sessionId,
        feature,
        ceremony: STANDARD_CEREMONY,
      },
    },
    {
      feature_dir: featureDir,
      snapshot: initialSnapshot(),
      tail_seq: -1,
      entries: [],
      meta: emptyMeta(),
      fsync: false,
      registryWriter: {
        registryDir,
        cwd: () => cwd, // critical: registry's cwd field = test's cwd
      },
    },
  );
  if (!result.ok) throw new Error(`seed failed: ${result.code}`);
  return sessionId;
}

describe("SC-8 — session dispatch resolver, session sources", () => {
  test("T1: --session <full UUID> registered + cwd match → DispatchOk", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const sid = await seedFeatureWithRegistry(cwd, "auth-refresh", regDir);

    const result = await resolveDispatch({
      argv: ["--session", sid],
      env: {},
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("session-flag");
      expect(result.sessionId).toBe(sid);
      expect(result.feature).toBe("auth-refresh");
    }
  });

  test("T2: --session <full UUID> registered + cwd MISMATCH → SESSION_CWD_MISMATCH", async () => {
    const cwd = await tmpCwd();
    const otherCwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const sid = await seedFeatureWithRegistry(cwd, "auth-refresh", regDir);

    const result = await resolveDispatch({
      argv: ["--session", sid],
      env: {},
      cwd: otherCwd, // mismatch
      registryDir: regDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SESSION_CWD_MISMATCH");
      expect(result.detail.registered_cwd).toBe(cwd);
      expect(result.detail.current_cwd).toBe(otherCwd);
    }
  });

  test("T3: --session <prefix ≥8 chars> single match → DispatchOk", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const sid = await seedFeatureWithRegistry(cwd, "auth-refresh", regDir);

    const prefix = sid.slice(0, 8);
    const result = await resolveDispatch({
      argv: ["--session", prefix],
      env: {},
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sessionId).toBe(sid);
  });

  test("T4: --session <prefix> multiple matches → SESSION_SHORT_AMBIGUOUS", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    // Both UUIDs share the prefix "550e8400"
    const sid1 = "550e8400-e29b-41d4-a716-aaaaaaaaaaaa";
    const sid2 = "550e8400-e29b-41d4-a716-bbbbbbbbbbbb";
    await seedFeatureWithRegistry(cwd, "feature-a", regDir, sid1);
    const cwd2 = await tmpCwd();
    await seedFeatureWithRegistry(cwd2, "feature-b", regDir, sid2);

    const result = await resolveDispatch({
      argv: ["--session", "550e8400"],
      env: {},
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SESSION_SHORT_AMBIGUOUS");
      expect((result.detail.candidate_list as string[]).sort()).toEqual([sid1, sid2].sort());
    }
  });

  test("T5: --session matches no registry entry → SESSION_NOT_FOUND", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    // No seed — registry is empty

    const result = await resolveDispatch({
      argv: ["--session", "deadbeef-dead-beef-dead-beefdeadbeef"],
      env: {},
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SESSION_NOT_FOUND");
  });

  test("T6: --session prefix <8 chars → USAGE (too short)", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();

    const result = await resolveDispatch({
      argv: ["--session", "abc"],
      env: {},
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("USAGE");
      expect(result.message).toContain("too short");
    }
  });

  // L4 regression: a matched-but-unreadable registry entry collapses to the
  // strict SESSION_NOT_FOUND "cannot be parsed" surface (shared readRegistryEntry,
  // strict policy). Pre-L4 dispatch tests covered no-entry / ambiguity / mismatch
  // but not this parse-failure path.
  test("T6b: --session matches a corrupt-JSON registry entry → SESSION_NOT_FOUND (cannot be parsed)", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const sid = "550e8400-e29b-41d4-a716-0000000000cc";
    await fs.writeFile(path.join(regDir, `${sid}.json`), "{ not json");

    const result = await resolveDispatch({ argv: ["--session", sid], env: {}, cwd, registryDir: regDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SESSION_NOT_FOUND");
      expect(result.message).toContain("cannot be parsed");
    }
  });

  test("T6c: --session matches a schema-invalid registry entry → SESSION_NOT_FOUND (cannot be parsed)", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const sid = "550e8400-e29b-41d4-a716-0000000000dd";
    await fs.writeFile(path.join(regDir, `${sid}.json`), JSON.stringify({ session_id: sid }));

    const result = await resolveDispatch({ argv: ["--session", sid], env: {}, cwd, registryDir: regDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SESSION_NOT_FOUND");
      expect(result.message).toContain("cannot be parsed");
    }
  });
});

describe("SC-8 — session dispatch resolver, feature sources", () => {
  test("T7: --feature <name> with valid state.json → DispatchOk sessionId from projection", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const sid = await seedFeatureWithRegistry(cwd, "auth-refresh", regDir);

    const result = await resolveDispatch({
      argv: ["--feature", "auth-refresh"],
      env: {},
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("feature-flag");
      expect(result.sessionId).toBe(sid);
      expect(result.feature).toBe("auth-refresh");
    }
  });

  test("T8: --feature missing state.json → FEATURE_NOT_FOUND", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    // No seed — no .loaf/missing/

    const result = await resolveDispatch({
      argv: ["--feature", "missing"],
      env: {},
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FEATURE_NOT_FOUND");
  });
});

describe("SC-8 — env sources + precedence", () => {
  test("T9: $LOAF_SESSION env → DispatchOk source=session-env", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const sid = await seedFeatureWithRegistry(cwd, "auth-refresh", regDir);

    const result = await resolveDispatch({
      argv: [],
      env: { LOAF_SESSION: sid },
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe("session-env");
  });

  test("T10: $LOAF_FEATURE env → DispatchOk source=feature-env", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    await seedFeatureWithRegistry(cwd, "auth-refresh", regDir);

    const result = await resolveDispatch({
      argv: [],
      env: { LOAF_FEATURE: "auth-refresh" },
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe("feature-env");
  });

  test("T11: flag precedence — --session beats --feature beats env", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const sid = await seedFeatureWithRegistry(cwd, "feature-from-session", regDir);

    // Both --session and --feature given; --session wins
    const result = await resolveDispatch({
      argv: ["--session", sid, "--feature", "other-feature"],
      env: { LOAF_SESSION: "ignored", LOAF_FEATURE: "ignored" },
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("session-flag");
      expect(result.feature).toBe("feature-from-session");
    }
  });

  test("T12: env precedence — $LOAF_SESSION beats $LOAF_FEATURE", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const sid = await seedFeatureWithRegistry(cwd, "feature-from-env-session", regDir);

    const result = await resolveDispatch({
      argv: [],
      env: { LOAF_SESSION: sid, LOAF_FEATURE: "other" },
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe("session-env");
  });
});

describe("SC-8 — --feature-dir matrix (codex r285 P1 + r286 locked)", () => {
  test("T-fd-1: --feature X --feature-dir <override> → DispatchOk feature=X, featureDir=override", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const overrideDir = path.join(await tmpCwd(), "explicit-override");
    await fs.mkdir(overrideDir, { recursive: true });
    // Seed at the override location explicitly
    await mutate(
      {
        at: "2026-05-28T13:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-fffd00000001",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      },
      {
        feature_dir: overrideDir,
        snapshot: initialSnapshot(),
        tail_seq: -1,
        entries: [],
        meta: emptyMeta(),
        fsync: false,
        registryWriter: { registryDir: regDir },
      },
    );

    const result = await resolveDispatch({
      argv: ["--feature", "auth-refresh", "--feature-dir", overrideDir],
      env: {},
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.featureDir).toBe(overrideDir);
      expect(result.feature).toBe("auth-refresh");
    }
  });

  test("T-fd-2: --session + --feature-dir → USAGE (mutually exclusive)", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const result = await resolveDispatch({
      argv: ["--session", "550e8400-e29b-41d4-a716-aaaaaaaaaaaa", "--feature-dir", "/tmp/x"],
      env: {},
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("USAGE");
      expect(result.detail.conflicting).toEqual(["--session", "--feature-dir"]);
    }
  });

  test("T-fd-3: bare --feature-dir (no feature name) → USAGE", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const result = await resolveDispatch({
      argv: ["--feature-dir", "/tmp/x"],
      env: {},
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("USAGE");
      expect(result.detail.conflicting).toEqual(["--feature-dir"]);
    }
  });

  test("T-fd-4: $LOAF_FEATURE + --feature-dir → DispatchOk override applies", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const overrideDir = path.join(await tmpCwd(), "env-override");
    await fs.mkdir(overrideDir, { recursive: true });
    await mutate(
      {
        at: "2026-05-28T13:00:00.000Z",
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "session:started",
        payload: {
          session_id: "550e8400-e29b-41d4-a716-fffd00000002",
          feature: "auth-refresh",
          ceremony: STANDARD_CEREMONY,
        },
      },
      {
        feature_dir: overrideDir,
        snapshot: initialSnapshot(),
        tail_seq: -1,
        entries: [],
        meta: emptyMeta(),
        fsync: false,
        registryWriter: { registryDir: regDir },
      },
    );

    const result = await resolveDispatch({
      argv: ["--feature-dir", overrideDir],
      env: { LOAF_FEATURE: "auth-refresh" },
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("feature-env");
      expect(result.featureDir).toBe(overrideDir);
    }
  });

  test("T-fd-5: $LOAF_SESSION + --feature-dir → USAGE (mutually exclusive)", async () => {
    const cwd = await tmpCwd();
    const regDir = await tmpRegDir();
    const result = await resolveDispatch({
      argv: ["--feature-dir", "/tmp/x"],
      env: { LOAF_SESSION: "550e8400-e29b-41d4-a716-aaaaaaaaaaaa" },
      cwd,
      registryDir: regDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("USAGE");
      expect(result.detail.conflicting).toEqual(["$LOAF_SESSION", "--feature-dir"]);
    }
  });
});
