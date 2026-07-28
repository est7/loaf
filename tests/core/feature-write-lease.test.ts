import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  acquireFeatureWriteLease,
  releaseFeatureWriteLeasesForSignalSync,
} from "../../src/core/feature-write-lease.js";
import { CONCURRENCY_INVARIANTS } from "../../src/core/concurrency-contract.js";

async function tmpFeature(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loaf-feature-lease-"));
}

const NOW = new Date("2026-07-27T12:00:00.000Z");

function options(overrides: Record<string, unknown> = {}) {
  return {
    now: () => NOW,
    pid: 4242,
    isPidAlive: (pid: number) => pid === 4242,
    timeoutMs: 10,
    retryDelayMs: 1,
    sleep: async () => {},
    fsync: false,
    ...overrides,
  };
}

describe("feature write lease", () => {
  test("publishes the acyclic runtime-first lock order", () => {
    expect(CONCURRENCY_INVARIANTS.lock_order).toContain(
      "session-runtime lock first, feature write lease second",
    );
    expect(CONCURRENCY_INVARIANTS.lock_order).toContain("no feature-then-runtime edge");
  });

  test("creates a 0600 PID/token lease and releases its own generation", async () => {
    const dir = await tmpFeature();
    const lease = await acquireFeatureWriteLease(dir, "test", options());
    const lockPath = path.join(dir, ".lock");
    const payload = JSON.parse(await fs.readFile(lockPath, "utf8"));

    expect(payload).toMatchObject({
      pid: 4242,
      acquired_at: NOW.toISOString(),
      operation: "test",
    });
    expect(payload.owner).toMatch(/^[0-9a-f]{32}$/);
    expect((await fs.stat(lockPath)).mode & 0o777).toBe(0o600);

    await lease.release();
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("bounded-waits for a live owner and returns typed LOCK_TIMEOUT", async () => {
    const dir = await tmpFeature();
    await fs.writeFile(
      path.join(dir, ".lock"),
      JSON.stringify({
        pid: 4242,
        acquired_at: NOW.toISOString(),
        operation: "live",
        owner: "a".repeat(32),
      }),
      { mode: 0o600 },
    );

    await expect(acquireFeatureWriteLease(dir, "contender", options())).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
      holder: { pid: 4242, operation: "live" },
    });
  });

  test("a contender enters only after the live owner releases", async () => {
    const dir = await tmpFeature();
    const first = await acquireFeatureWriteLease(dir, "first", options());
    let released = false;
    const contender = await acquireFeatureWriteLease(
      dir,
      "second",
      options({
        timeoutMs: 20,
        sleep: async () => {
          expect(released).toBe(false);
          released = true;
          await first.release();
        },
      }),
    );
    expect(released).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, ".lock"), "utf8")).operation).toBe("second");
    await contender.release();
  });

  test("reclaims a dead owner only after generation revalidation", async () => {
    const dir = await tmpFeature();
    await fs.writeFile(
      path.join(dir, ".lock"),
      JSON.stringify({
        pid: 7777,
        acquired_at: NOW.toISOString(),
        operation: "dead",
        owner: "b".repeat(32),
      }),
      { mode: 0o600 },
    );

    const lease = await acquireFeatureWriteLease(
      dir,
      "recovered",
      options({ isPidAlive: () => false }),
    );
    expect(JSON.parse(await fs.readFile(path.join(dir, ".lock"), "utf8")).operation).toBe(
      "recovered",
    );
    await lease.release();
  });

  test("malformed lease state fails closed", async () => {
    const dir = await tmpFeature();
    await fs.writeFile(path.join(dir, ".lock"), "{not-json", { mode: 0o600 });

    await expect(acquireFeatureWriteLease(dir, "blocked", options())).rejects.toMatchObject({
      code: "LOCK_INVALID",
    });
    await expect(fs.readFile(path.join(dir, ".lock"), "utf8")).resolves.toBe("{not-json");
  });

  test("legacy empty lock is reclaimed only after its compatibility age", async () => {
    const dir = await tmpFeature();
    const lockPath = path.join(dir, ".lock");
    await fs.writeFile(lockPath, "");
    const old = new Date(NOW.getTime() - 60_000);
    await fs.utimes(lockPath, old, old);

    const lease = await acquireFeatureWriteLease(
      dir,
      "legacy-recovery",
      options({ legacyLockStaleMs: 30_000 }),
    );
    await lease.release();
  });

  test("release and signal cleanup preserve a foreign successor generation", async () => {
    const dir = await tmpFeature();
    const lease = await acquireFeatureWriteLease(dir, "original", options());
    const lockPath = path.join(dir, ".lock");
    const foreign = {
      pid: 4242,
      acquired_at: NOW.toISOString(),
      operation: "successor",
      owner: "f".repeat(32),
    };
    await fs.writeFile(lockPath, JSON.stringify(foreign), { mode: 0o600 });

    await lease.release();
    releaseFeatureWriteLeasesForSignalSync();
    expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toEqual(foreign);
  });
});
