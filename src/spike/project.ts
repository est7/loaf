// Read events.jsonl + project to Snapshot.
//
// On parse failure: spike-pragmatic = throw. Real impl reports the bad line
// number and offers recovery (events.jsonl truncate-after-last-good).

import { promises as fsp } from "node:fs";
import { Event } from "./events.js";
import { project as projectEvents, type Snapshot } from "./reducer.js";

export async function readAndProject(filePath: string): Promise<Snapshot> {
  let content: string;
  try {
    content = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No log = empty initial snapshot
      return projectEvents([]);
    }
    throw err;
  }

  const events = parseLog(content);
  return projectEvents(events);
}

export function parseLog(content: string): Event[] {
  const lines = content.split("\n");
  const events: Event[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.length === 0) continue; // tolerate trailing newline + empty separator
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new ParseError("BAD_JSON", `line ${i + 1}: invalid JSON`, {
        line: i + 1,
        snippet: raw.slice(0, 80),
        cause: (e as Error).message,
      });
    }
    const result = Event.safeParse(parsed);
    if (!result.success) {
      throw new ParseError("BAD_EVENT_SHAPE", `line ${i + 1}: event schema validation failed`, {
        line: i + 1,
        issues: result.error.issues.slice(0, 5),
      });
    }
    events.push(result.data);
  }
  return events;
}

export class ParseError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

export { project } from "./reducer.js";
export type { Snapshot } from "./snapshot.js";
