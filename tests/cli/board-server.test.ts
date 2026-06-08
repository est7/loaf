import { afterEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { BUILTIN_BUNDLES, createI18n } from "../../src/cli/i18n.js";
import { startBoardServer, type BoardServerHandle } from "../../src/cli/board/server.js";
import { PROJECTION_SCHEMA_VERSION, type RegistryFile } from "../../src/core/projection-schema.js";

let openServers: BoardServerHandle[] = [];

afterEach(async () => {
  await Promise.all(openServers.map((server) => server.close()));
  openServers = [];
});

async function tmpRegDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-board-server-reg-"));
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
    session_label: "Board smoke",
    feature: "auth-refresh",
    cwd: "/tmp",
    workspace: "default",
    phase: "EXECUTE",
    sub_state: "EXECUTE.work",
    iteration: 1,
    active_tasks: ["T-001"],
    pending: null,
    pending_queue_depth: 0,
    ceremony_label: "standard",
    ...rest,
  };
  await fs.writeFile(path.join(regDir, `${file.session_id}.json`), JSON.stringify(file), "utf8");
}

describe("loaf board server", () => {
  test("serves the board shell and session list API", async () => {
    const registryDir = await tmpRegDir();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-board-server-cwd-"));
    await writeRegistryEntry(registryDir, {
      session_id: "550e8400-e29b-41d4-a716-000000000010",
      cwd,
    });
    const server = await startBoardServer({ registryDir, cwd, port: 0 });
    openServers.push(server);

    const html = await fetch(server.url).then((response) => response.text());
    expect(html).toContain("Loaf Live Board");
    expect(html).toContain("/api/sessions");

    const sessions = (await fetch(`${server.url}api/sessions?scope=cwd`).then((response) =>
      response.json(),
    )) as { totals: { sessions: number }; sessions: Array<{ label: string; status_bucket: string }> };
    expect(sessions.totals.sessions).toBe(1);
    expect(sessions.sessions[0]!.label).toBe("Board smoke");
    expect(sessions.sessions[0]!.status_bucket).toBe("running");
  });

  test("serves board chrome through the injected CLI i18n bundle", async () => {
    const server = await startBoardServer({
      registryDir: await tmpRegDir(),
      port: 0,
      i18n: createI18n("zh", BUILTIN_BUNDLES),
    });
    openServers.push(server);

    const html = await fetch(server.url).then((response) => response.text());
    expect(html).toContain('<html lang="zh">');
    expect(html).toContain("Loaf 实时看板");
    expect(html).toContain('"EXECUTE","title":"执行"');
    expect(html).toContain('"EXECUTE.work":"执行 / 任务进行中"');
  });

  test("non-GET workflow calls are rejected with 405", async () => {
    const server = await startBoardServer({ registryDir: await tmpRegDir(), port: 0 });
    openServers.push(server);

    const response = await fetch(`${server.url}api/sessions`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  test("unknown session detail returns stable 404 JSON", async () => {
    const server = await startBoardServer({ registryDir: await tmpRegDir(), port: 0 });
    openServers.push(server);

    const response = await fetch(`${server.url}api/sessions/550e8400-e29b-41d4-a716-000000000099`);
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      ok: false,
      code: "SESSION_NOT_FOUND",
    });
  });
});
