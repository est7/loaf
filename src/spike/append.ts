// appendEvent — the B4-eliminating primitive.
//
// Contract (codex B1 refinement — PIPE_BUF is not the right citation;
// regular files need explicit discipline):
//   1. Open with O_APPEND. Each write() syscall starts at current EOF;
//      kernel atomically advances offset and writes. Concurrent writers
//      do not overlap byte ranges.
//   2. Encode event to ONE byte buffer (utf-8 JSON + '\n'). Single write
//      syscall. No streaming, no buffered Writer/Stream APIs.
//   3. Buffer MUST be ≤ EVENT_BYTE_LIMIT (4096). This is our self-imposed
//      ceiling — not a POSIX guarantee, just defensive sizing to stay well
//      below the smallest plausible kernel chunk boundary on local FS.
//   4. Handle short write (returned bytes < buffer.length). On short write,
//      ABORT — append-only semantics broken. Spike-pragmatic: throw. Real
//      impl should escalate to a structured incident (this is rare on
//      local FS; common on network FS, which we don't support).
//   5. fsync after write — durability guarantee. Configurable per call
//      (default true).
//   6. Restrictions: local FS only. NFS / SMB / fuse-with-weak-append
//      semantics out of scope. This is a stable promise, documented for
//      users.

import { promises as fsp } from "node:fs";
import { O_APPEND, O_CREAT, O_WRONLY } from "node:constants";
import { EVENT_BYTE_LIMIT, type Event } from "./events.js";

export interface AppendOptions {
  fsync?: boolean;
}

export async function appendEvent(
  filePath: string,
  event: Event,
  opts: AppendOptions = {},
): Promise<void> {
  const fsyncEnabled = opts.fsync ?? true;
  const line = JSON.stringify(event) + "\n";
  const buf = Buffer.from(line, "utf8");

  if (buf.length > EVENT_BYTE_LIMIT) {
    throw new AppendError(
      "EVENT_OVERSIZE",
      `event encoded to ${buf.length} bytes; limit ${EVENT_BYTE_LIMIT}`,
      { kind: event.kind, bytes: buf.length },
    );
  }

  // Open with O_APPEND | O_WRONLY | O_CREAT. Mode 0644 for visibility.
  const fh = await fsp.open(filePath, O_APPEND | O_WRONLY | O_CREAT, 0o644);
  try {
    const result = await fh.write(buf, 0, buf.length);
    if (result.bytesWritten !== buf.length) {
      throw new AppendError(
        "SHORT_WRITE",
        `wrote ${result.bytesWritten} of ${buf.length} bytes — append integrity broken`,
        { wrote: result.bytesWritten, want: buf.length },
      );
    }
    if (fsyncEnabled) {
      await fh.sync();
    }
  } finally {
    await fh.close();
  }
}

export class AppendError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = "AppendError";
  }
}
