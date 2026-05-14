#!/usr/bin/env bun
// Atomicity test worker. Spawned by atomicity.test.ts.
// Args: <file-path> <worker-id> <event-count>

import { appendEvent } from "../../src/spike/append.js";
import { EVENT_VERSION, type Event } from "../../src/spike/events.js";

function requireArg(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`missing ${name}; usage: bun atomicity-worker.ts <file> <worker-id> <count>`);
    process.exit(2);
  }
  return value;
}

const filePath = requireArg("file", process.argv[2]);
const workerIdRaw = requireArg("worker-id", process.argv[3]);
const countRaw = requireArg("count", process.argv[4]);

const workerId = parseInt(workerIdRaw, 10);
const count = parseInt(countRaw, 10);

if (!Number.isFinite(workerId) || !Number.isFinite(count)) {
  console.error("worker-id and count must be integers");
  process.exit(2);
}

async function main(): Promise<void> {
  for (let i = 0; i < count; i++) {
    const event: Event = {
      version: EVENT_VERSION,
      kind: "evidence_added",
      at: new Date().toISOString(),
      evidence: {
        id: `EV-${String(workerId * 10_000 + i).padStart(6, "0")}`, // disjoint id space per worker
        kind: "manual",
        result: "passed",
        covers: [],
        actor: `worker:${workerId}`,
        summary: `worker ${workerId} event ${i}`,
      },
    };
    // No fsync per write for perf — only at the very end.
    await appendEvent(filePath, event, { fsync: i === count - 1 });
  }
}

main().catch((err) => {
  console.error(`worker ${workerId} failed:`, err);
  process.exit(1);
});
