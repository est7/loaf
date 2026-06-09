// prune slice 4 — audit log (RED-first).
//
// M2: a kernel that journals every state change must not have an unaudited
// delete. Each executed prune appends one line to ~/.loaf/prune-log.jsonl
// (append-only); `loaf prune --history` reads it back.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { appendPruneLog, readPruneLog, type PruneAuditEntry } from "../../src/cli/prune/audit.js";

let root: string;
let logPath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "prune-audit-"));
  logPath = path.join(root, "nested", "prune-log.jsonl"); // nested → must mkdir parent
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const entry = (n: number, mode: "trash" | "purge"): PruneAuditEntry => ({
  at: `2026-06-09T0${n}:00:00.000Z`,
  scope: "all",
  mode,
  actor: "cli:loaf@test",
  pruned: [{ session_id: `id-${n}`, feature: `feat-${n}`, orphan: false }],
  skipped: [],
});

describe("prune audit log", () => {
  test("append → read round-trips entries in order", async () => {
    await appendPruneLog(logPath, entry(1, "trash"));
    await appendPruneLog(logPath, entry(2, "purge"));

    const log = await readPruneLog(logPath);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ at: "2026-06-09T01:00:00.000Z", mode: "trash" });
    expect(log[1]).toMatchObject({ at: "2026-06-09T02:00:00.000Z", mode: "purge" });
    expect(log[0]?.pruned[0]).toMatchObject({ session_id: "id-1", feature: "feat-1" });
  });

  test("append is append-only (does not overwrite prior lines)", async () => {
    await appendPruneLog(logPath, entry(1, "trash"));
    await appendPruneLog(logPath, entry(2, "trash"));
    await appendPruneLog(logPath, entry(3, "trash"));
    expect(await readPruneLog(logPath)).toHaveLength(3);
    // raw file has one JSON object per line, newline-terminated
    const raw = await fs.readFile(logPath, "utf8");
    expect(raw.trimEnd().split("\n")).toHaveLength(3);
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("read of a missing log returns empty", async () => {
    expect(await readPruneLog(logPath)).toEqual([]);
  });

  test("read tolerates blank trailing lines", async () => {
    await appendPruneLog(logPath, entry(1, "trash"));
    await fs.appendFile(logPath, "\n  \n");
    expect(await readPruneLog(logPath)).toHaveLength(1);
  });
});
