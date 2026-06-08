import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  buildBoardSnapshot,
  statusBucket,
  toBoardSessionSummary,
} from "../../src/cli/board/model.js";
import { PROJECTION_SCHEMA_VERSION, type RegistryFile } from "../../src/core/projection-schema.js";
import type { SessionRow } from "../../src/cli/sessions-list.js";

async function tmpRegDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-board-reg-"));
}

async function writeRegistryEntry(
  regDir: string,
  overrides: Partial<RegistryFile> & { session_id: string },
): Promise<void> {
  const { session_id, ...rest } = overrides;
  const file: RegistryFile = {
    schema_version: PROJECTION_SCHEMA_VERSION,
    at: "2026-06-08T10:00:00.000Z",
    session_id,
    session_label: "",
    feature: "auth-refresh",
    cwd: "/tmp",
    workspace: "default",
    phase: "EXECUTE",
    sub_state: "EXECUTE.work",
    iteration: 1,
    active_tasks: [],
    pending: null,
    pending_queue_depth: 0,
    ceremony_label: "standard",
    ...rest,
  };
  await fs.writeFile(path.join(regDir, `${file.session_id}.json`), JSON.stringify(file), "utf8");
}

function row(overrides: Partial<SessionRow>): SessionRow {
  return {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    session_id_short: "550e8400",
    session_label: "",
    feature: "auth-refresh",
    phase: "EXECUTE",
    sub_state: "EXECUTE.work",
    at: "2026-06-08T10:00:00.000Z",
    cwd: "/tmp",
    workspace: "default",
    iteration: 1,
    pending_queue_depth: 0,
    active_tasks: [],
    ceremony_label: "standard",
    ...overrides,
  };
}

describe("board model", () => {
  test("statusBucket preserves TUI precedence for done, blocked, running, idle", () => {
    expect(statusBucket(row({ sub_state: "DONE.delivered" }))).toBe("done");
    expect(statusBucket(row({ pending_queue_depth: 1, active_tasks: ["T-001"] }))).toBe("blocked");
    expect(statusBucket(row({ active_tasks: ["T-001"] }))).toBe("running");
    expect(statusBucket(row({ sub_state: "SPEC.plan" }))).toBe("idle");
  });

  test("toBoardSessionSummary falls back from empty label to feature", () => {
    expect(toBoardSessionSummary(row({ session_label: "" })).label).toBe("auth-refresh");
    expect(toBoardSessionSummary(row({ session_label: "Auth refresh fix" })).label).toBe(
      "Auth refresh fix",
    );
  });

  test("buildBoardSnapshot applies cwd filtering and totals", async () => {
    const registryDir = await tmpRegDir();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-board-cwd-"));
    const otherCwd = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-board-other-"));
    await writeRegistryEntry(registryDir, {
      session_id: "550e8400-e29b-41d4-a716-000000000001",
      cwd,
      active_tasks: ["T-001"],
    });
    await writeRegistryEntry(registryDir, {
      session_id: "550e8400-e29b-41d4-a716-000000000002",
      cwd,
      pending_queue_depth: 1,
    });
    await writeRegistryEntry(registryDir, {
      session_id: "550e8400-e29b-41d4-a716-000000000003",
      cwd: otherCwd,
      sub_state: "DONE.delivered",
      phase: "DONE",
    });

    const snapshot = await buildBoardSnapshot({
      registryDir,
      scope: "cwd",
      cwd,
      now: new Date("2026-06-08T11:00:00.000Z"),
    });

    expect(snapshot.sessions.map((session) => session.session_id_short)).toEqual([
      "550e8400",
      "550e8400",
    ]);
    expect(snapshot.totals).toMatchObject({
      sessions: 2,
      active: 2,
      blocked: 1,
      running: 1,
      done: 0,
    });
    expect(snapshot.generated_at).toBe("2026-06-08T11:00:00.000Z");
  });
});
