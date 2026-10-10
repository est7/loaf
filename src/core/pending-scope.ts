// Machine-local pending-scope lifecycle policy. session-runtime owns storage
// validation, identity fencing, atomic publication and the runtime lock.
import type { SessionRuntimeFile, StateProjection } from "./projection-schema.js";
import { compareScopePathBytes } from "./journal-entry.js";
import { normalizeScopePath, type NormalizedScopePath } from "./scope-track.js";
import {
  withRuntimeLock,
  type RuntimeIdentity,
  type RuntimeStoreOptions,
} from "./session-runtime.js";

function runtimeOrInitial(
  current: SessionRuntimeFile | null,
  identity: RuntimeIdentity,
  debug: boolean,
  heartbeatAt: string,
): SessionRuntimeFile {
  return (
    current ?? {
      schema_version: 2,
      session_id: identity.session_id,
      cwd: identity.cwd,
      debug,
      heartbeat_at: heartbeatAt,
      pending_scope: null,
    }
  );
}

export interface TrackPendingScopeOptions {
  targetPath: string;
  identity: RuntimeIdentity;
  debug: boolean;
  /** Cursor captured by the trusted session read before waiting on the lock. */
  cursor: Pick<StateProjection, "sub_state" | "iteration">;
  runtime: RuntimeStoreOptions;
}

/** Normalize and accumulate a PostToolUse path, publishing heartbeat even on
 * path rejection. Storage failures propagate before the caller renders that
 * rejection; the lock still owns the complete read-modify-write operation. */
export async function trackPendingScope(
  options: TrackPendingScopeOptions,
): Promise<NormalizedScopePath> {
  let normalized: NormalizedScopePath;
  try {
    normalized = await normalizeScopePath(options.targetPath, options.identity.cwd);
  } catch {
    normalized = { ok: false, reason: "invalid_scope_path", path: options.targetPath };
  }
  const heartbeatAt = options.runtime.now().toISOString();
  await withRuntimeLock(
    options.identity,
    "scope-track",
    (current) => {
      const base = runtimeOrInitial(current, options.identity, options.debug, heartbeatAt);
      if (
        !normalized.ok ||
        normalized.kind === "internal" ||
        options.cursor.sub_state !== "EXECUTE.work"
      ) {
        return { ...base, heartbeat_at: heartbeatAt };
      }
      const paths = new Set(
        base.pending_scope?.iteration === options.cursor.iteration ? base.pending_scope.paths : [],
      );
      paths.add(normalized.path);
      return {
        ...base,
        heartbeat_at: heartbeatAt,
        pending_scope: {
          iteration: options.cursor.iteration,
          paths: [...paths].sort(compareScopePathBytes),
        },
      };
    },
    options.runtime,
  );
  return normalized;
}
