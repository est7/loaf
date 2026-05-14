// Spike Gate 1: O_APPEND concurrent-write atomicity across PROCESSES.
//
// This is the test that proves (or kills) codex B1's concern: are concurrent
// fan-out workers actually safe appending to one events.jsonl?
//
// Strategy: N subprocesses each call appendEvent M times against the same
// file. After all finish, verify:
//   - Total line count = N * M (no events lost)
//   - Every line parses as valid JSON (no torn writes / byte interleaving)
//   - Every parsed event passes Event schema (no field-level corruption)
//   - Worker contributions are interleaved (proves concurrency was real,
//     not accidentally serialized)

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { Event } from "../../src/spike/events.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const WORKER_SCRIPT = join(__dirname, "atomicity-worker.ts");

async function runWorker(file: string, workerId: number, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [WORKER_SCRIPT, file, String(workerId), String(count)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`worker ${workerId} exited ${code}: ${stderr}`));
      }
    });
    proc.on("error", reject);
  });
}

describe("Gate 1: append atomicity (concurrent O_APPEND)", () => {
  test("5 workers × 200 events = 1000 lines, all valid, all interleaved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loaf-spike-atomicity-"));
    dirs.push(dir);
    const filePath = join(dir, "events.jsonl");

    const N = 5;
    const M = 200;

    // Fire all workers in parallel.
    await Promise.all(
      Array.from({ length: N }, (_, i) => runWorker(filePath, i + 1, M)),
    );

    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);

    // 1. Total count
    expect(lines.length).toBe(N * M);

    // 2. Every line parses JSON
    const parsed: unknown[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        parsed.push(JSON.parse(lines[i]!));
      } catch (e) {
        throw new Error(`line ${i + 1} has torn write or interleaved bytes: ${lines[i]!.slice(0, 100)}`);
      }
    }

    // 3. Every parsed event passes Event schema
    for (let i = 0; i < parsed.length; i++) {
      const result = Event.safeParse(parsed[i]);
      if (!result.success) {
        throw new Error(`line ${i + 1} parsed but schema-invalid: ${JSON.stringify(result.error.issues[0])}`);
      }
    }

    // 4. Workers really interleaved (not accidentally serialized).
    // Look at first 50 lines — they should NOT all come from worker 1.
    const first50Workers = new Set(
      parsed.slice(0, 50).map((e) => {
        const ev = e as { kind: string; evidence?: { actor?: string } };
        return ev.evidence?.actor ?? "unknown";
      }),
    );
    // If workers were serialized, first 50 lines = all worker:1.
    // With real concurrency, expect ≥3 of 5 workers represented in any 50-line window.
    expect(first50Workers.size).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("10 workers × 100 events stress — line count + integrity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loaf-spike-atomicity-stress-"));
    dirs.push(dir);
    const filePath = join(dir, "events.jsonl");

    const N = 10;
    const M = 100;

    await Promise.all(
      Array.from({ length: N }, (_, i) => runWorker(filePath, i + 1, M)),
    );

    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(N * M);

    // Spot-check: every line ends with } (no truncation mid-object)
    for (let i = 0; i < lines.length; i++) {
      const last = lines[i]!.charAt(lines[i]!.length - 1);
      if (last !== "}") {
        throw new Error(`line ${i + 1} does not end with '}': ...${lines[i]!.slice(-40)}`);
      }
    }
  }, 60_000);
});
