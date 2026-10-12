import { afterEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { main } from "../../src/cli.js";
import { replayJournal } from "../../src/core/journal-bootstrap.js";
import { acquireFeatureWriteLease } from "../../src/core/feature-write-lease.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function cli(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await main(["node", "loaf", ...args, "--format", "json"]);
    return { exit, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

async function session() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-tail-cli-"));
  roots.push(root);
  const dir = path.join(root, ".loaf", "repair");
  const started = await cli(["start", "repair", "--feature-dir", dir]);
  expect(started.exit, started.stderr).toBe(0);
  const journal = path.join(dir, "journal.jsonl");
  const prefix = await fs.readFile(journal, "utf8");
  const doctor = (flags: string[] = []) =>
    cli(["doctor", "--check-tail", "--feature", "repair", "--feature-dir", dir, ...flags]);
  return { root, dir, journal, prefix, doctor };
}

function resumed(seq: number, extra: Record<string, unknown> = {}) {
  return (
    JSON.stringify({
      seq,
      entry_id: `JE-${String(seq + 1).padStart(6, "0")}`,
      at: "2026-10-12T06:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:resumed",
      payload: {},
      ...extra,
    }) + "\n"
  );
}

describe("doctor --check-tail", () => {
  test("torn tail repair preserves exact prefix, rebuilds meta and repeats as noop", async () => {
    const s = await session();
    const tail = '{"seq":1,"partial":';
    await fs.appendFile(s.journal, tail);
    expect((await replayJournal(s.journal)).ok).toBe(false);
    const rebuildOnly = await cli([
      "doctor",
      "--rebuild",
      "--feature",
      "repair",
      "--feature-dir",
      s.dir,
    ]);
    expect(rebuildOnly.exit).toBe(2);
    expect(await fs.readFile(s.journal, "utf8")).toBe(s.prefix + tail);
    const repaired = await s.doctor();
    expect(repaired.exit, repaired.stderr).toBe(0);
    expect(JSON.parse(repaired.stdout)).toMatchObject({
      ok: true,
      action: "drop_partial_line",
      truncated_bytes: Buffer.byteLength(tail),
      truncated_entries: 0,
      tail_seq: 0,
    });
    expect(await fs.readFile(s.journal, "utf8")).toBe(s.prefix);
    expect((await replayJournal(s.journal)).ok).toBe(true);
    const status = await cli(["status", "--feature", "repair", "--feature-dir", s.dir]);
    expect(status.exit, status.stderr).toBe(0);
    const again = await s.doctor();
    expect(again.exit, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({
      action: "noop",
      truncated_bytes: 0,
      tail_seq: 0,
    });
  });

  test("invalid complete tail is removed without changing committed entries", async () => {
    const s = await session();
    const tail = "invalid trailing JSON\n";
    await fs.appendFile(s.journal, tail);
    const result = await s.doctor();
    expect(result.exit, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "drop_invalid_tail",
      truncated_bytes: Buffer.byteLength(tail),
      truncated_entries: 1,
    });
    expect(await fs.readFile(s.journal, "utf8")).toBe(s.prefix);
  });

  test("incomplete batch is removed as a whole", async () => {
    const s = await session();
    const batch = { batch_id: "550e8400-e29b-41d4-a716-446655440000", batch_count: 3 };
    const tail =
      resumed(1, { ...batch, batch_index: 0 }) + resumed(2, { ...batch, batch_index: 1 });
    await fs.appendFile(s.journal, tail);
    const result = await s.doctor();
    expect(result.exit, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "drop_partial_batch",
      truncated_bytes: Buffer.byteLength(tail),
      truncated_entries: 2,
    });
    expect(await fs.readFile(s.journal, "utf8")).toBe(s.prefix);
  });

  test.each([
    { kind: "future:entry", entry_schema_version: 1, reason: "unknown_kind" },
    { kind: "session:resumed", entry_schema_version: 999, reason: "entry_schema_version_too_new" },
  ])("newer writer ($reason) refuses repair without touching bytes", async ({
    reason,
    ...extra
  }) => {
    const s = await session();
    const before = s.prefix + resumed(1, extra) + '{"partial":';
    await fs.writeFile(s.journal, before);
    const result = await s.doctor();
    expect(result.exit).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "JOURNAL_TAIL_REQUIRES_NEWER_LOAF",
      detail: { reason },
    });
    expect(await fs.readFile(s.journal, "utf8")).toBe(before);
  });

  test("interior corruption is reported and not silently removed", async () => {
    const s = await session();
    const before = s.prefix + "invalid interior\n" + resumed(1);
    await fs.writeFile(s.journal, before);
    const result = await s.doctor();
    expect(result.exit).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "DOCTOR_REBUILD_FAILED",
      detail: { replay_code: "INVALID_ENTRY", recovery: { action: "noop" } },
    });
    expect(await fs.readFile(s.journal, "utf8")).toBe(before);
  });

  test("projection failure reports committed truncation and releases the lease", async () => {
    const s = await session();
    await fs.appendFile(s.journal, '{"partial":');
    const state = path.join(s.dir, "snapshots", "state.json");
    await fs.unlink(state);
    await fs.mkdir(state);
    const result = await s.doctor();
    expect(result.exit).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "DOCTOR_REBUILD_FAILED",
      detail: { reason: "projection_write_failed", recovery: { action: "drop_partial_line" } },
    });
    expect(await fs.readFile(s.journal, "utf8")).toBe(s.prefix);
    const lease = await acquireFeatureWriteLease(s.dir, "test:release", { timeoutMs: 20 });
    await lease.release();
  });

  test("repair waits for the feature lease before truncating", async () => {
    const s = await session();
    const before = s.prefix + '{"partial":';
    await fs.writeFile(s.journal, before);
    const lease = await acquireFeatureWriteLease(s.dir, "test:held");
    const repair = s.doctor();
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await fs.readFile(s.journal, "utf8")).toBe(before);
    } finally {
      await lease.release();
    }
    const result = await repair;
    expect(result.exit, result.stderr).toBe(0);
    expect(await fs.readFile(s.journal, "utf8")).toBe(s.prefix);
  });

  test.each(["--dry-run", "--rebuild"])("rejects %s without changing the journal", async (flag) => {
    const s = await session();
    const before = s.prefix + '{"partial":';
    await fs.writeFile(s.journal, before);
    const result = await s.doctor([flag]);
    expect(result.exit).toBe(2);
    expect(JSON.parse(result.stderr).code).toBe(
      flag === "--dry-run" ? "DRY_RUN_NOT_APPLICABLE" : "MUTUALLY_EXCLUSIVE_FLAGS",
    );
    expect(await fs.readFile(s.journal, "utf8")).toBe(before);
  });
});
