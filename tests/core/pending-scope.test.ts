import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { trackPendingScope } from "../../src/core/pending-scope.js";
import type { SessionRuntimeFile } from "../../src/core/projection-schema.js";
import type { SubState } from "../../src/core/journal-entry.js";
import {
  readSessionRuntimeFile,
  writeSessionRuntimeFile,
  sessionRuntimeFilePath,
} from "../../src/core/session-runtime.js";
import * as scopePaths from "../../src/core/scope-track.js";

const at = "2026-07-20T11:20:00.000Z";
type Pending = SessionRuntimeFile["pending_scope"];
async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-pending-scope-"));
  const identity = { session_id: "pending-table", cwd };
  const runtime = { runtimeDir: path.join(cwd, "runtime"), now: () => new Date(at) };
  return { cwd, identity, runtime };
}
async function seed(f: Awaited<ReturnType<typeof fixture>>, pending: Pending) {
  await writeSessionRuntimeFile(
    f.identity,
    {
      schema_version: 2,
      ...f.identity,
      debug: true,
      heartbeat_at: "2026-07-20T11:00:00.000Z",
      pending_scope: pending,
    },
    f.runtime,
  );
}
const cases: Array<{
  name: string;
  current: Pending | "absent";
  subState: SubState;
  iteration: number;
  target: string;
  expected: Pending;
  accepted: boolean;
  internal?: boolean;
}> = [
  {
    name: "missing runtime accumulates at work",
    current: "absent",
    subState: "EXECUTE.work",
    iteration: 1,
    target: "src/a.ts",
    expected: { iteration: 1, paths: ["src/a.ts"] },
    accepted: true,
  },
  {
    name: "missing runtime at non-work is heartbeat-only",
    current: "absent",
    subState: "TRIAGE.score",
    iteration: 1,
    target: "src/a.ts",
    expected: null,
    accepted: true,
  },
  {
    name: "null pending accumulates",
    current: null,
    subState: "EXECUTE.work",
    iteration: 2,
    target: "src/a.ts",
    expected: { iteration: 2, paths: ["src/a.ts"] },
    accepted: true,
  },
  {
    name: "same iteration deduplicates",
    current: { iteration: 2, paths: ["src/a.ts"] },
    subState: "EXECUTE.work",
    iteration: 2,
    target: "src/a.ts",
    expected: { iteration: 2, paths: ["src/a.ts"] },
    accepted: true,
  },
  {
    name: "extraction baseline resets older iteration",
    current: { iteration: 1, paths: ["src/previous.ts"] },
    subState: "EXECUTE.work",
    iteration: 2,
    target: "src/current.ts",
    expected: { iteration: 2, paths: ["src/current.ts"] },
    accepted: true,
  },
  {
    name: "future pending retains original reset behavior",
    current: { iteration: 3, paths: ["src/previous.ts"] },
    subState: "EXECUTE.work",
    iteration: 2,
    target: "src/current.ts",
    expected: { iteration: 2, paths: ["src/current.ts"] },
    accepted: true,
  },
  {
    name: "internal path preserves old iteration",
    current: { iteration: 1, paths: ["src/kept.ts"] },
    subState: "EXECUTE.work",
    iteration: 2,
    target: ".loaf/state.json",
    expected: { iteration: 1, paths: ["src/kept.ts"] },
    accepted: true,
    internal: true,
  },
  {
    name: "non-work preserves pending",
    current: { iteration: 1, paths: ["src/kept.ts"] },
    subState: "VERIFY.run",
    iteration: 2,
    target: "src/ignored.ts",
    expected: { iteration: 1, paths: ["src/kept.ts"] },
    accepted: true,
  },
  {
    name: "outside path preserves pending",
    current: { iteration: 1, paths: ["src/kept.ts"] },
    subState: "EXECUTE.work",
    iteration: 2,
    target: "../outside.ts",
    expected: { iteration: 1, paths: ["src/kept.ts"] },
    accepted: false,
  },
  {
    name: "canonical UTF-8 order differs from default JS sort",
    current: { iteration: 1, paths: ["src/𐀀.ts"] },
    subState: "EXECUTE.work",
    iteration: 1,
    target: "src/\uE000.ts",
    expected: { iteration: 1, paths: ["src/\uE000.ts", "src/𐀀.ts"] },
    accepted: true,
  },
];

describe("pending scope accumulation", () => {
  test.each(cases)("$name", async (row) => {
    const f = await fixture();
    try {
      if (row.current !== "absent") await seed(f, row.current);
      const result = await trackPendingScope({
        targetPath: row.target,
        identity: f.identity,
        debug: false,
        cursor: { sub_state: row.subState, iteration: row.iteration },
        runtime: f.runtime,
      });
      expect(result.ok).toBe(row.accepted);
      if (row.accepted)
        expect(result).toEqual({
          ok: true,
          kind: row.internal ? "internal" : "scope",
          path: row.target,
        });
      else expect(result).toEqual({ ok: false, reason: "outside_repo_root", path: row.target });
      const expected = {
        schema_version: 2,
        session_id: f.identity.session_id,
        cwd: await fs.realpath(f.cwd),
        debug: row.current !== "absent",
        heartbeat_at: at,
        pending_scope: row.expected,
      };
      expect(
        await fs.readFile(sessionRuntimeFilePath(f.identity.session_id, f.runtime), "utf8"),
      ).toBe(JSON.stringify(expected));
    } finally {
      await fs.rm(f.cwd, { recursive: true, force: true });
    }
  });

  test("normalization exception becomes an invalid result after heartbeat publication", async () => {
    const f = await fixture();
    const spy = vi
      .spyOn(scopePaths, "normalizeScopePath")
      .mockRejectedValueOnce(new Error("resolver unavailable"));
    try {
      await expect(
        trackPendingScope({
          targetPath: "src/failed.ts",
          identity: f.identity,
          debug: false,
          cursor: { sub_state: "EXECUTE.work", iteration: 1 },
          runtime: f.runtime,
        }),
      ).resolves.toEqual({ ok: false, reason: "invalid_scope_path", path: "src/failed.ts" });
      expect(await readSessionRuntimeFile(f.identity, f.runtime)).toMatchObject({
        heartbeat_at: at,
        pending_scope: null,
      });
    } finally {
      spy.mockRestore();
      await fs.rm(f.cwd, { recursive: true, force: true });
    }
  });

  test("heartbeat is captured before the lock clock, with no extra clock read", async () => {
    const f = await fixture();
    const now = vi
      .fn()
      .mockReturnValueOnce(new Date(at))
      .mockReturnValue(new Date("2026-07-20T11:21:00.000Z"));
    try {
      await trackPendingScope({
        targetPath: "src/a.ts",
        identity: f.identity,
        debug: false,
        cursor: { sub_state: "EXECUTE.work", iteration: 1 },
        runtime: { ...f.runtime, now },
      });
      expect(now).toHaveBeenCalledTimes(2);
      expect(await readSessionRuntimeFile(f.identity, f.runtime)).toMatchObject({
        heartbeat_at: at,
      });
    } finally {
      await fs.rm(f.cwd, { recursive: true, force: true });
    }
  });

  test.each([
    "malformed",
    "mismatched",
  ])("%s runtime fails closed even for an outside path", async (kind) => {
    const f = await fixture();
    try {
      await seed(f, { iteration: 1, paths: ["src/kept.ts"] });
      const file = sessionRuntimeFilePath(f.identity.session_id, f.runtime);
      const bytes =
        kind === "malformed"
          ? "{broken"
          : JSON.stringify({
              schema_version: 2,
              ...f.identity,
              session_id: "other-session",
              debug: false,
              heartbeat_at: at,
              pending_scope: null,
            });
      await fs.writeFile(file, bytes);
      await expect(
        trackPendingScope({
          targetPath: "../outside.ts",
          identity: f.identity,
          debug: false,
          cursor: { sub_state: "EXECUTE.work", iteration: 1 },
          runtime: f.runtime,
        }),
      ).rejects.toMatchObject({
        code: kind === "malformed" ? "RUNTIME_FILE_INVALID" : "RUNTIME_IDENTITY_MISMATCH",
      });
      expect(await fs.readFile(file, "utf8")).toBe(bytes);
    } finally {
      await fs.rm(f.cwd, { recursive: true, force: true });
    }
  });
});
