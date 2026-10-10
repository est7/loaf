import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { trackPendingScope } from "../../src/core/pending-scope.js";
import type { SessionRuntimeFile } from "../../src/core/projection-schema.js";
import { loadSession } from "../../src/core/cli-runtime.js";
import * as sessionLoader from "../../src/core/cli-runtime.js";
import type { JournalEntry, ScopeRecordedPayload, SubState } from "../../src/core/journal-entry.js";
import {
  readSessionRuntimeFile,
  writeSessionRuntimeFile,
  sessionRuntimeFilePath,
  withRuntimeLock,
} from "../../src/core/session-runtime.js";
import * as scopePaths from "../../src/core/scope-track.js";

const at = "2026-07-20T11:20:00.000Z";
type Pending = SessionRuntimeFile["pending_scope"];
async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-pending-scope-"));
  const identity = { session_id: "pending-table", cwd };
  const runtime = { runtimeDir: path.join(cwd, "runtime"), now: () => new Date(at) };
  return { cwd, identity, runtime, featureDir: path.join(cwd, ".loaf", "pending-table") };
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

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function writeHistory(
  f: Fixture,
  coverage?: ScopeRecordedPayload["paths"],
  sessionId = f.identity.session_id,
): Promise<void> {
  const entries: JournalEntry[] = [
    {
      seq: 0,
      entry_id: "JE-000001",
      at,
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: {
        session_id: sessionId,
        feature: "pending-table",
        ceremony_label: "quick",
        workspace: "default",
        loaf_version_required: "^0.10.0",
        ceremony: {
          spec_phase: false,
          verify_phase: false,
          settle_phase: false,
          strict_spec_review: false,
          lessons_required: "skip",
          strict_drift_check: false,
        },
      },
    },
  ];
  if (coverage !== undefined) {
    for (const [from, to] of [
      ["TRIAGE.score", "TRIAGE.confirm"],
      ["TRIAGE.confirm", "EXECUTE.plan"],
      ["EXECUTE.plan", "EXECUTE.work"],
    ]) {
      const seq = entries.length;
      entries.push({
        seq,
        entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
        at,
        actor: "cli:loaf",
        entry_schema_version: 1,
        kind: "event:phase_advanced",
        payload: { from, to },
      });
    }
    entries.push({
      seq: 4,
      entry_id: "JE-000005",
      at,
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "scope:recorded",
      payload: { iteration: 1, paths: coverage },
      batch_id: "550e8400-e29b-41d4-a716-446655440000",
      batch_index: 0,
      batch_count: 2,
    });
    entries.push({
      seq: 5,
      entry_id: "JE-000006",
      at,
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "event:phase_advanced",
      payload: { from: "EXECUTE.work", to: "EXECUTE.done" },
      batch_id: "550e8400-e29b-41d4-a716-446655440000",
      batch_index: 1,
      batch_count: 2,
    });
  }
  await fs.mkdir(f.featureDir, { recursive: true });
  await fs.writeFile(
    path.join(f.featureDir, "journal.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  // Establish that the independently built fixture is canonical replayable history.
  expect((await loadSession(f.featureDir, { ensureDir: false })).snapshot.state?.session_id).toBe(
    sessionId,
  );
}

function trackOptions(f: Fixture, targetPath = "src/new.ts") {
  return {
    targetPath,
    featureDir: f.featureDir,
    identity: f.identity,
    debug: false,
    cursor: { sub_state: "EXECUTE.work" as const, iteration: 2 },
    runtime: f.runtime,
  };
}

async function runtimeBytes(f: Fixture): Promise<string> {
  return await fs.readFile(sessionRuntimeFilePath(f.identity.session_id, f.runtime), "utf8");
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
    name: "older iteration without a closure fact carries all pending paths",
    current: { iteration: 1, paths: ["src/previous.ts"] },
    subState: "EXECUTE.work",
    iteration: 2,
    target: "src/current.ts",
    expected: { iteration: 2, paths: ["src/current.ts", "src/previous.ts"] },
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
    let historyRead: ReturnType<typeof vi.spyOn> | undefined;
    try {
      if (row.current !== "absent") await seed(f, row.current);
      if (row.name.startsWith("older iteration")) await writeHistory(f);
      historyRead = vi.spyOn(sessionLoader, "loadSession");
      const result = await trackPendingScope({
        targetPath: row.target,
        identity: f.identity,
        featureDir: f.featureDir,
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
      expect(historyRead).toHaveBeenCalledTimes(row.name.startsWith("older iteration") ? 1 : 0);
      if (row.name.startsWith("older iteration"))
        expect(historyRead).toHaveBeenCalledWith(f.featureDir, { ensureDir: false });
    } finally {
      historyRead?.mockRestore();
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
          featureDir: f.featureDir,
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
        featureDir: f.featureDir,
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
          featureDir: f.featureDir,
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

describe("pending scope rollover", () => {
  test.each([
    "array",
    "inline",
    "sidecar",
  ])("%s origin coverage excludes recorded paths, carries late paths and deduplicates a second hook", async (encoding) => {
    const f = await fixture();
    try {
      const text = JSON.stringify(["src/recorded.ts"]);
      const relative = "attachments/JE-000005/paths.txt";
      await fs.mkdir(path.join(f.featureDir, "attachments", "JE-000005"), { recursive: true });
      await fs.writeFile(path.join(f.featureDir, relative), text);
      const paths: ScopeRecordedPayload["paths"] =
        encoding === "array"
          ? ["src/recorded.ts"]
          : encoding === "inline"
            ? { mode: "inline", text }
            : {
                mode: "sidecar",
                ref: {
                  path: relative,
                  sha256: createHash("sha256").update(text).digest("hex"),
                  size: Buffer.byteLength(text),
                },
              };
      await writeHistory(f, paths);
      await seed(f, { iteration: 1, paths: ["src/late.ts", "src/recorded.ts", "src/𐀀.ts"] });
      const journalBefore = await fs.readFile(path.join(f.featureDir, "journal.jsonl"), "utf8");
      const historyRead = vi.spyOn(sessionLoader, "loadSession");
      try {
        const now = vi.fn(() => new Date(at));
        await trackPendingScope({
          ...trackOptions(f, "src/\uE000.ts"),
          runtime: { ...f.runtime, now },
        });
        expect(now).toHaveBeenCalledTimes(2);
        expect(await runtimeBytes(f)).toBe(
          JSON.stringify({
            schema_version: 2,
            ...f.identity,
            cwd: await fs.realpath(f.cwd),
            debug: true,
            heartbeat_at: at,
            pending_scope: { iteration: 2, paths: ["src/late.ts", "src/\uE000.ts", "src/𐀀.ts"] },
          }),
        );
        await trackPendingScope(trackOptions(f, "src/late.ts"));
        expect(historyRead).toHaveBeenCalledTimes(1);
        expect((await readSessionRuntimeFile(f.identity, f.runtime))?.pending_scope).toEqual({
          iteration: 2,
          paths: ["src/late.ts", "src/\uE000.ts", "src/𐀀.ts"],
        });
      } finally {
        historyRead.mockRestore();
      }
      // Canonical replay remains at iteration 1 / EXECUTE.done; accumulation
      // must use the cursor captured before the hook waited on its lock.
      expect((await loadSession(f.featureDir, { ensureDir: false })).snapshot.state).toMatchObject({
        iteration: 1,
        sub_state: "EXECUTE.done",
      });
      expect(await fs.readFile(path.join(f.featureDir, "journal.jsonl"), "utf8")).toBe(
        journalBefore,
      );
      expect(await fs.readdir(f.featureDir)).toEqual(["attachments", "journal.jsonl"]);
    } finally {
      await fs.rm(f.cwd, { recursive: true, force: true });
    }
  });

  test("fully covered prior paths stay out of the next pending set", async () => {
    const f = await fixture();
    try {
      await writeHistory(f, ["src/recorded.ts"]);
      await seed(f, { iteration: 1, paths: ["src/recorded.ts"] });
      await trackPendingScope(trackOptions(f));
      expect((await readSessionRuntimeFile(f.identity, f.runtime))?.pending_scope).toEqual({
        iteration: 2,
        paths: ["src/new.ts"],
      });
    } finally {
      await fs.rm(f.cwd, { recursive: true, force: true });
    }
  });

  test.each([
    "missing-feature",
    "missing-journal",
    "malformed",
    "invalid-replay",
    "mismatched",
    "unreadable",
  ])("%s history fails closed without publishing heartbeat or creating history", async (fault) => {
    const f = await fixture();
    try {
      await seed(f, { iteration: 1, paths: ["src/late.ts"] });
      if (fault !== "missing-feature")
        await writeHistory(
          f,
          undefined,
          fault === "mismatched" ? "another-session" : f.identity.session_id,
        );
      const file = path.join(f.featureDir, "journal.jsonl");
      if (fault === "missing-journal" || fault === "unreadable") await fs.unlink(file);
      if (fault === "unreadable") await fs.mkdir(file);
      if (fault === "malformed") await fs.writeFile(file, "{broken\n");
      if (fault === "invalid-replay") {
        const entry = JSON.parse((await fs.readFile(file, "utf8")).trim());
        entry.actor = "worker:not-authorized-to-start";
        await fs.writeFile(file, JSON.stringify(entry) + "\n");
      }
      const before = await runtimeBytes(f);
      await expect(trackPendingScope(trackOptions(f))).rejects.toThrow(
        fault === "missing-feature" || fault === "missing-journal" || fault === "mismatched"
          ? "scope-track history does not match the selected session identity"
          : /failed to load session|EISDIR/,
      );
      expect(await runtimeBytes(f)).toBe(before);
      expect(await fs.readdir(f.runtime.runtimeDir)).toEqual([`${f.identity.session_id}.json`]);
      if (fault === "missing-feature")
        await expect(fs.stat(f.featureDir)).rejects.toMatchObject({ code: "ENOENT" });
      if (fault === "missing-journal")
        await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(f.cwd, { recursive: true, force: true });
    }
  });

  test.each([
    "missing",
    "corrupt",
    "noncanonical",
  ])("%s origin sidecar failure leaves all pending runtime bytes unchanged", async (fault) => {
    const f = await fixture();
    try {
      const relative = "attachments/JE-000005/paths.txt";
      const text =
        fault === "noncanonical" ? '[ "src/recorded.ts" ]' : JSON.stringify(["src/recorded.ts"]);
      await fs.mkdir(path.join(f.featureDir, "attachments", "JE-000005"), { recursive: true });
      if (fault !== "missing")
        await fs.writeFile(
          path.join(f.featureDir, relative),
          fault === "corrupt" ? "corrupted" : text,
        );
      await writeHistory(f, {
        mode: "sidecar",
        ref: {
          path: relative,
          sha256: createHash("sha256").update(text).digest("hex"),
          size: Buffer.byteLength(text),
        },
      });
      await seed(f, { iteration: 1, paths: ["src/late.ts", "src/recorded.ts"] });
      const before = await runtimeBytes(f);
      const attempt = trackPendingScope(trackOptions(f));
      if (fault === "noncanonical")
        await expect(attempt).rejects.toThrow("scope paths sidecar is not canonical JSON");
      else
        await expect(attempt).rejects.toMatchObject({
          code: fault === "missing" ? "ATTACHMENT_MISSING" : "ATTACHMENT_INTEGRITY",
        });
      expect(await runtimeBytes(f)).toBe(before);
    } finally {
      await fs.rm(f.cwd, { recursive: true, force: true });
    }
  });

  test("history coverage is read only after acquiring the runtime lock", async () => {
    const f = await fixture();
    try {
      await writeHistory(f, ["src/a.ts"]);
      await seed(f, { iteration: 1, paths: ["src/a.ts", "src/b.ts"] });
      let release!: () => void;
      let acquired!: () => void;
      const holding = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const writer = withRuntimeLock(
        f.identity,
        "hold-for-history-change",
        async (current) => {
          acquired();
          await holding;
          if (current === null) throw new Error("fixture runtime missing");
          return current;
        },
        f.runtime,
      );
      await locked;
      const historyRead = vi.spyOn(sessionLoader, "loadSession");
      let hook: ReturnType<typeof trackPendingScope> | undefined;
      try {
        hook = trackPendingScope(trackOptions(f));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(historyRead).not.toHaveBeenCalled();
        await writeHistory(f, ["src/b.ts"]);
      } finally {
        release();
        await writer;
        await hook;
        historyRead.mockRestore();
      }
      expect((await readSessionRuntimeFile(f.identity, f.runtime))?.pending_scope).toEqual({
        iteration: 2,
        paths: ["src/a.ts", "src/new.ts"],
      });
    } finally {
      await fs.rm(f.cwd, { recursive: true, force: true });
    }
  });
});
