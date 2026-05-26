// Phase 16 SC-2 — unexpected-error crash log writer.
//
// Per protocol.md §10.5 + §10.9: exit 1 = unexpected internal error
// (panic / IO crash / out of disk); writes a stack-bearing envelope to
// `~/.loaf/crashes/<ts>.json` and emits a one-line stderr pointer.
//
// Codex r196 PATCH B / E pinned the contract:
//   - Path: user-scoped `os.homedir()/.loaf/crashes/<safeIso>.json`.
//     Project-local `.loaf/crashes` was rejected (would force a new
//     public env var `LOAF_HOME` not in §10.3).
//   - File extension: `.json` (the envelope IS JSON; the older `.log`
//     suffix in protocol.md is updated in the same SC).
//   - Sentinel code: `UNEXPECTED_ERROR` (NOT a DiagnosticCode). The
//     `ErrorEntry` schema in docs/schemas.ts is locked at
//     `exit_code: z.literal(2)`, and §39 explicitly scopes
//     DiagnosticCode to user-recoverable exit-2 failures. Widening that
//     schema is out of SC-2 scope.
//   - No journal read in the crash path: the boundary is already
//     handling a failure; reopening the same possibly-corrupt session
//     risks a second fault and muddles the discriminator. `feature` is
//     best-effort parsed from argv only.
//   - Permissions: dir 0700, file 0600. On write failure: stderr-only
//     fallback (one line) + return null. Never double-fault.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

/** Sentinel code stamped into the JSON envelope and (when `--json` is
 *  set) onto the boundary stderr payload. Lives here, not in
 *  src/cli.tsx, so the SC-0 inventory regex (`code: "CODE"` scan over
 *  cli.tsx) does NOT pick it up as an uncataloged DiagnosticCode emit. */
export const UNEXPECTED_ERROR = "UNEXPECTED_ERROR" as const;

export const CrashLogEnvelope = z.object({
  iso: z.string(),
  version: z.string(),
  argv: z.array(z.string()),
  cwd: z.string(),
  feature: z.string().nullable(),
  exitCode: z.literal(1),
  error: z.object({
    name: z.string(),
    message: z.string(),
    stack: z.string().nullable(),
  }),
});
export type CrashLogEnvelope = z.infer<typeof CrashLogEnvelope>;

export type WriteCrashLogDeps = {
  now: () => Date;
  homeDir: () => string;
  writeStderr: (s: string) => void;
};

export type WriteCrashLogInput = {
  argv: readonly string[];
  cwd: string;
  version: string;
  error: Error;
};

const DEFAULT_DEPS: WriteCrashLogDeps = {
  now: () => new Date(),
  homeDir: () => os.homedir(),
  writeStderr: (s) => process.stderr.write(s),
};

/** Best-effort `--feature <NAME>` extractor. Stays in this module so the
 *  boundary doesn't have to know argv shape; null on miss. */
function extractFeature(argv: readonly string[]): string | null {
  const i = argv.indexOf("--feature");
  if (i < 0 || i + 1 >= argv.length) return null;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

/** ISO 8601 with `:` replaced so the filename is portable across
 *  Windows/macOS/Linux without escaping. */
function safeIso(d: Date): string {
  return d.toISOString().replace(/:/g, "-");
}

/** Write a crash log envelope and return its absolute path. On any IO
 *  failure (EACCES, ENOSPC, unwritable parent), emit a one-line stderr
 *  diagnostic via `deps.writeStderr` and return null. Never throws —
 *  the caller is already in an error boundary and a second fault would
 *  obscure the original cause. */
export async function writeCrashLog(
  input: WriteCrashLogInput,
  depsPartial?: Partial<WriteCrashLogDeps>,
): Promise<string | null> {
  const deps: WriteCrashLogDeps = { ...DEFAULT_DEPS, ...depsPartial };
  // Capture `now` once so envelope.iso and the filename safeIso() agree
  // byte-for-byte. Two separate deps.now() calls could differ by ms and
  // make the filename's <ts>.json not match envelope.iso exactly (codex
  // r198 nit).
  const now = deps.now();
  const envelope: CrashLogEnvelope = {
    iso: now.toISOString(),
    version: input.version,
    argv: [...input.argv],
    cwd: input.cwd,
    feature: extractFeature(input.argv),
    exitCode: 1,
    error: {
      name: input.error.name,
      message: input.error.message,
      stack: input.error.stack ?? null,
    },
  };
  const dir = path.join(deps.homeDir(), ".loaf", "crashes");
  const file = path.join(dir, `${safeIso(now)}.json`);
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir's `mode` is masked by umask; re-chmod to guarantee 0700.
    await fs.chmod(dir, 0o700);
    await fs.writeFile(file, JSON.stringify(envelope, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.chmod(file, 0o600);
    return file;
  } catch (err) {
    deps.writeStderr(
      `loaf: crash log unwritable at ${file} — ${(err as Error).message}\n`,
    );
    return null;
  }
}
