// Phase 16 SC-9b — pure listSessions tests.
//
// Covers:
//   - empty / nonexistent registry → ok with empty rows + empty warnings
//   - happy path with multiple entries → rows sorted by `at` desc
//   - --in-cwd filter (filterCwd parameter)
//   - corrupt JSON entry → silently absent from rows; warning surfaced
//   - orphan-cwd entry (registry's cwd field points at deleted dir) →
//     listed when no filter; NOT listed with filter; warning surfaced

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { listSessions, formatAtRelative } from "../../src/cli/sessions-list.js";
import { PROJECTION_SCHEMA_VERSION, type RegistryFile } from "../../src/core/projection-schema.js";

async function tmpRegDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc9b-reg-"));
}

async function writeRegistryEntry(
  regDir: string,
  overrides: Partial<RegistryFile> & { session_id: string },
): Promise<void> {
  const file: RegistryFile = {
    schema_version: PROJECTION_SCHEMA_VERSION,
    at: "2026-05-28T14:00:00.000Z",
    session_label: "",
    feature: "auth-refresh",
    cwd: "/tmp",
    workspace: "default",
    phase: "TRIAGE",
    sub_state: "TRIAGE.score",
    iteration: 1,
    active_tasks: [],
    pending: null,
    pending_queue_depth: 0,
    ceremony_label: "standard",
    ...overrides,
  };
  await fs.writeFile(path.join(regDir, `${file.session_id}.json`), JSON.stringify(file), "utf8");
}

describe("SC-9b — listSessions pure cases", () => {
  test("T1: empty registry dir → ok, empty rows + empty warnings", async () => {
    const dir = await tmpRegDir();
    const result = await listSessions({ registryDir: dir });
    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("T2: nonexistent registry dir → ok, empty rows (ENOENT treated as empty)", async () => {
    const result = await listSessions({ registryDir: "/tmp/loaf-sc9b-DOES-NOT-EXIST" });
    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("T3: 2 entries → sorted by `at` desc", async () => {
    const dir = await tmpRegDir();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc9b-cwd-"));
    await writeRegistryEntry(dir, {
      session_id: "550e8400-e29b-41d4-a716-000000000001",
      feature: "older-feature",
      at: "2026-05-28T10:00:00.000Z",
      cwd,
    });
    await writeRegistryEntry(dir, {
      session_id: "550e8400-e29b-41d4-a716-000000000002",
      feature: "newer-feature",
      at: "2026-05-28T14:00:00.000Z",
      cwd,
    });
    const result = await listSessions({ registryDir: dir });
    expect(result.ok).toBe(true);
    expect(result.rows.length).toBe(2);
    expect(result.rows[0]!.feature).toBe("newer-feature");
    expect(result.rows[1]!.feature).toBe("older-feature");
  });

  test("T4: --in-cwd filterCwd matches → only matching rows returned", async () => {
    const dir = await tmpRegDir();
    const cwdA = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc9b-cwdA-"));
    const cwdB = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc9b-cwdB-"));
    await writeRegistryEntry(dir, {
      session_id: "550e8400-e29b-41d4-a716-00000000000a",
      cwd: cwdA,
    });
    await writeRegistryEntry(dir, {
      session_id: "550e8400-e29b-41d4-a716-00000000000b",
      cwd: cwdB,
    });

    const canonicalA = await fs.realpath(cwdA);
    const result = await listSessions({ registryDir: dir, filterCwd: canonicalA });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.cwd).toBe(cwdA);
  });

  test("T5: corrupt JSON entry → silently absent from rows; warning surfaced", async () => {
    const dir = await tmpRegDir();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc9b-cwd-"));
    await writeRegistryEntry(dir, { session_id: "550e8400-e29b-41d4-a716-000000000010", cwd });
    // Corrupt entry — invalid JSON
    await fs.writeFile(path.join(dir, "corrupt-id.json"), "{not valid json", "utf8");

    const result = await listSessions({ registryDir: dir });
    expect(result.rows.length).toBe(1);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]!.reason).toBe("corrupt-json");
    expect(result.warnings[0]!.file).toBe("corrupt-id.json");
  });

  test("T6: orphan-cwd entry — listed WITHOUT filter; NOT listed WITH filter; warning surfaced both times", async () => {
    const dir = await tmpRegDir();
    const validCwd = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc9b-valid-"));
    await writeRegistryEntry(dir, {
      session_id: "550e8400-e29b-41d4-a716-000000000020",
      cwd: validCwd,
    });
    // Orphan: registry references a dir that doesn't exist
    await writeRegistryEntry(dir, {
      session_id: "550e8400-e29b-41d4-a716-000000000021",
      feature: "orphan-feature",
      cwd: "/tmp/loaf-sc9b-DELETED-DIR-DOES-NOT-EXIST",
    });

    // Without filter: orphan IS listed, warning emitted
    const r1 = await listSessions({ registryDir: dir });
    expect(r1.rows.length).toBe(2);
    expect(r1.warnings.some((w) => w.reason === "orphan-cwd")).toBe(true);

    // With filter: orphan NOT in match, warning still emitted
    const canonicalValid = await fs.realpath(validCwd);
    const r2 = await listSessions({ registryDir: dir, filterCwd: canonicalValid });
    expect(r2.rows.length).toBe(1);
    expect(r2.rows[0]!.feature).toBe("auth-refresh"); // default
    expect(r2.warnings.some((w) => w.reason === "orphan-cwd")).toBe(true);
  });

  test("T7: 0 valid + 1 corrupt → ok, empty rows + warning for the corrupt one", async () => {
    const dir = await tmpRegDir();
    await fs.writeFile(path.join(dir, "only-corrupt.json"), "garbage", "utf8");
    const result = await listSessions({ registryDir: dir });
    expect(result.rows).toEqual([]);
    expect(result.warnings.length).toBe(1);
  });

  test("T8: schema-invalid entry → silently absent from rows; warning surfaced with reason='schema-invalid'", async () => {
    const dir = await tmpRegDir();
    // Valid JSON but missing required fields
    await fs.writeFile(
      path.join(dir, "schema-bad.json"),
      JSON.stringify({ session_id: "not a uuid" }),
      "utf8",
    );
    const result = await listSessions({ registryDir: dir });
    expect(result.rows).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]!.reason).toBe("schema-invalid");
  });
});

describe("SC-9b — formatAtRelative", () => {
  test("≤7 days → relative; >7 days → ISO; future → ISO", () => {
    const now = new Date("2026-05-28T14:00:00.000Z");
    // 5 minutes ago
    expect(formatAtRelative("2026-05-28T13:55:00.000Z", now)).toBe("5 minutes ago");
    // 1 hour ago
    expect(formatAtRelative("2026-05-28T13:00:00.000Z", now)).toBe("1 hour ago");
    // 2 days ago
    expect(formatAtRelative("2026-05-26T14:00:00.000Z", now)).toBe("2 days ago");
    // 10 days ago → ISO
    expect(formatAtRelative("2026-05-18T14:00:00.000Z", now)).toBe("2026-05-18T14:00:00.000Z");
    // future → ISO
    expect(formatAtRelative("2026-05-29T14:00:00.000Z", now)).toBe("2026-05-29T14:00:00.000Z");
  });

  test("just now (<1 minute)", () => {
    const now = new Date("2026-05-28T14:00:00.000Z");
    expect(formatAtRelative("2026-05-28T13:59:30.000Z", now)).toBe("just now");
  });
});
