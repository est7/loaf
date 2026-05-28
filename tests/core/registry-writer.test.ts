// Phase 16 SC-7 — pure registry-writer unit tests.
//
// Covers:
//   - buildRegistryFile field derivation (full + fallback paths)
//   - composePendingJson-based pending head + queue depth (codex r280 P3)
//   - session_label empty-string fallback (codex r280 P2)
//   - writeRegistryFile atomic write + 0o600 mode + no tmp leftover

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  buildRegistryFile,
  writeRegistryFile,
  defaultRegistryDir,
} from "../../src/core/registry-writer.js";
import {
  RegistryFile,
  PROJECTION_SCHEMA_VERSION,
} from "../../src/core/projection-schema.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import { mutate } from "../../src/core/journal-mutate.js";
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

const FIXED_NOW = new Date("2026-05-28T12:00:00.000Z");
const FIXED_CWD = "/tmp/fake-project";

async function tmpRegDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc7-reg-"));
}

async function tmpFeatureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc7-feat-"));
}

/** Create a feature with a session:started entry on disk + return the
 *  loaded snapshot + entries for builder input. Uses real mutate(). */
async function seedSession(
  featureName: string,
  payloadOverrides: Record<string, unknown> = {},
): Promise<{ snapshot: ReturnType<typeof initialSnapshot>; entries: readonly unknown[]; featureDir: string }> {
  const dir = await tmpFeatureDir();
  const result = await mutate(
    {
      at: "2026-05-28T11:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: featureName,
        ceremony: STANDARD_CEREMONY,
        ...payloadOverrides,
      },
    },
    {
      feature_dir: dir,
      snapshot: initialSnapshot(),
      tail_seq: -1,
      entries: [],
      meta: emptyMeta(),
      fsync: false,
      // Inject tmp registry dir so the mutate's own step 9 doesn't
      // write to the real ~/.loaf/registry/.
      registryWriter: { registryDir: await tmpRegDir() },
    },
  );
  if (!result.ok) throw new Error(`seedSession failed: ${result.code}`);
  return {
    snapshot: result.snapshot,
    entries: [result.entry],
    featureDir: dir,
  };
}

describe("SC-7 — buildRegistryFile shape derivation", () => {
  test("T1: returns null when snapshot.state is null", () => {
    const result = buildRegistryFile({
      snapshot: initialSnapshot(),
      entries: [],
      now: FIXED_NOW,
      cwd: FIXED_CWD,
    });
    expect(result).toBeNull();
  });

  test("T2: full field derivation from session:started", async () => {
    const { snapshot, entries } = await seedSession("auth-refresh", {
      session_label: "test session for SC-7",
      workspace: "my-workspace",
      ceremony_label: "standard",
    });
    const result = buildRegistryFile({
      snapshot,
      entries: entries as never,
      now: FIXED_NOW,
      cwd: FIXED_CWD,
    });
    expect(result).not.toBeNull();
    expect(result!.schema_version).toBe(PROJECTION_SCHEMA_VERSION);
    expect(result!.at).toBe("2026-05-28T12:00:00.000Z");
    expect(result!.session_id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result!.session_label).toBe("test session for SC-7");
    expect(result!.feature).toBe("auth-refresh");
    expect(result!.cwd).toBe(FIXED_CWD);
    expect(result!.workspace).toBe("my-workspace");
    expect(result!.ceremony_label).toBe("standard");
    expect(result!.phase).toBe("TRIAGE");
    expect(result!.sub_state).toBe("TRIAGE.score");
    expect(result!.iteration).toBe(1);
    expect(result!.active_tasks).toEqual([]);
    expect(result!.pending).toBeNull();
    expect(result!.pending_queue_depth).toBe(0);
  });

  test("T3: session_label empty-string fallback (codex r280 P2)", async () => {
    const { snapshot, entries } = await seedSession("auth-refresh");
    // No session_label override → omitted from payload → fallback ""
    const result = buildRegistryFile({
      snapshot,
      entries: entries as never,
      now: FIXED_NOW,
      cwd: FIXED_CWD,
    });
    expect(result!.session_label).toBe("");
    // Schema parses (NOT null, NOT undefined)
    expect(typeof result!.session_label).toBe("string");
  });

  test("T4: workspace defaults to 'default' when payload omits", async () => {
    const { snapshot, entries } = await seedSession("auth-refresh");
    const result = buildRegistryFile({
      snapshot,
      entries: entries as never,
      now: FIXED_NOW,
      cwd: FIXED_CWD,
    });
    expect(result!.workspace).toBe("default");
  });

  test("T5: ceremony_label defaults to '' when payload omits", async () => {
    const { snapshot, entries } = await seedSession("auth-refresh");
    const result = buildRegistryFile({
      snapshot,
      entries: entries as never,
      now: FIXED_NOW,
      cwd: FIXED_CWD,
    });
    expect(result!.ceremony_label).toBe("");
  });

  test("T6: feature derived from session:started payload (NOT featureDir basename)", async () => {
    // Regression: in tests featureDir is a tmpdir basename like
    // `loaf-cli-test-XXX` which doesn't match the kebab-case regex.
    // The canonical source is the session:started payload.
    const { snapshot, entries } = await seedSession("kebab-name");
    const result = buildRegistryFile({
      snapshot,
      entries: entries as never,
      now: FIXED_NOW,
      cwd: FIXED_CWD,
    });
    expect(result!.feature).toBe("kebab-name");
  });
});

describe("SC-7 — writeRegistryFile atomic + mode 0o600", () => {
  test("T7: writes correct file at expected path with mode 0o600", async () => {
    const regDir = await tmpRegDir();
    const file: RegistryFile = {
      schema_version: PROJECTION_SCHEMA_VERSION,
      at: "2026-05-28T12:00:00.000Z",
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      session_label: "",
      feature: "auth-refresh",
      cwd: "/tmp/x",
      workspace: "default",
      phase: "TRIAGE",
      sub_state: "TRIAGE.score",
      iteration: 1,
      active_tasks: [],
      pending: null,
      pending_queue_depth: 0,
      ceremony_label: "",
    };
    await writeRegistryFile(file.session_id, file, { registryDir: regDir });

    const target = path.join(regDir, `${file.session_id}.json`);
    const stat = await fs.stat(target);
    expect(stat.isFile()).toBe(true);
    // Mode 0o600 (owner rw only) — mask to file mode bits
    expect(stat.mode & 0o777).toBe(0o600);

    const content = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.session_id).toBe(file.session_id);
  });

  test("T8: creates registryDir on first write (mkdir -p)", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc7-mkdir-"));
    const regDir = path.join(parent, "nested", "registry");
    // Precondition: doesn't exist
    await expect(fs.stat(regDir)).rejects.toMatchObject({ code: "ENOENT" });

    const file: RegistryFile = {
      schema_version: PROJECTION_SCHEMA_VERSION,
      at: "2026-05-28T12:00:00.000Z",
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      session_label: "",
      feature: "auth-refresh",
      cwd: "/tmp/x",
      workspace: "default",
      phase: "TRIAGE",
      sub_state: "TRIAGE.score",
      iteration: 1,
      active_tasks: [],
      pending: null,
      pending_queue_depth: 0,
      ceremony_label: "",
    };
    await writeRegistryFile(file.session_id, file, { registryDir: regDir });

    // Post-write: dir exists
    const stat = await fs.stat(regDir);
    expect(stat.isDirectory()).toBe(true);
  });

  test("T9: no tmp leftovers after successful write", async () => {
    const regDir = await tmpRegDir();
    const file: RegistryFile = {
      schema_version: PROJECTION_SCHEMA_VERSION,
      at: "2026-05-28T12:00:00.000Z",
      session_id: "550e8400-e29b-41d4-a716-446655440001",
      session_label: "",
      feature: "f",
      cwd: "/tmp/x",
      workspace: "default",
      phase: "TRIAGE",
      sub_state: "TRIAGE.score",
      iteration: 1,
      active_tasks: [],
      pending: null,
      pending_queue_depth: 0,
      ceremony_label: "",
    };
    await writeRegistryFile(file.session_id, file, { registryDir: regDir });

    const files = await fs.readdir(regDir);
    const tmps = files.filter((f) => f.includes(".tmp-"));
    expect(tmps).toEqual([]);
  });
});

describe("SC-7 — defaultRegistryDir contract + test isolation (codex r281 P1)", () => {
  test("T10: defaultRegistryDir honors LOAF_REGISTRY_DIR env override + falls back to ~/.loaf/registry", () => {
    const real = path.join(os.homedir(), ".loaf", "registry");

    const saved = process.env["LOAF_REGISTRY_DIR"];
    try {
      // Explicit env override wins
      process.env["LOAF_REGISTRY_DIR"] = "/tmp/explicit-override";
      expect(defaultRegistryDir()).toBe("/tmp/explicit-override");

      // Unset → real ~/.loaf/registry/
      delete process.env["LOAF_REGISTRY_DIR"];
      expect(defaultRegistryDir()).toBe(real);

      // Empty string treated as "unset" (defensive)
      process.env["LOAF_REGISTRY_DIR"] = "";
      expect(defaultRegistryDir()).toBe(real);
    } finally {
      if (saved === undefined) delete process.env["LOAF_REGISTRY_DIR"];
      else process.env["LOAF_REGISTRY_DIR"] = saved;
    }
  });

  test("T11-isolation: under test runs, vitest setup makes defaultRegistryDir NOT point at real ~/.loaf/registry", () => {
    // The vitest setup file (tests/setup-registry-isolation.ts) creates
    // a tmp dir + sets LOAF_REGISTRY_DIR. Any test that doesn't override
    // gets the tmp dir, NOT the real user registry. This is the
    // hermetic-suite guarantee codex r281 P1 required.
    const real = path.join(os.homedir(), ".loaf", "registry");
    expect(defaultRegistryDir()).not.toBe(real);
    expect(defaultRegistryDir()).toMatch(/loaf-vitest-reg-/);
  });
});
