// W8 regression — production hook stdin resolution (codex W8 BLOCK).
//
// The in-process hook tests (hook-write-side-end-to-end.test.ts) drive stdin by
// INJECTING `MainDeps.readStdin` / `isStdinTty`, so they validate the seam but
// NOT the production pipe path. W8 Phase 0 moved `resolveHookPath` onto
// CommandContext, whose `readStdin` has no internal default and throws when
// absent — and main() was passing it only via a conditional `deps.readStdin`
// spread, so a real (no-injected-deps) invocation with piped, non-TTY stdin
// crashed with `UNEXPECTED_ERROR — readStdin dep not provided`.
//
// This test exercises the binary as a child process with REAL piped stdin and
// NO injected deps — the only way to catch a wiring regression between main()'s
// production defaults and CommandContext. Must spawn (not runCli) by design.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_ENTRY = path.join(REPO_ROOT, "src", "cli.tsx");

function runPiped(args: string[], stdin: string): { status: number; stderr: string; stdout: string } {
  const r = spawnSync("bun", [CLI_ENTRY, ...args], {
    input: stdin, // real pipe → non-TTY stdin, no injected MainDeps.readStdin
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

describe("W8 regression — hook stdin resolves from the production default reader", () => {
  test("`hook scope-track` with piped JSON + no injected readStdin does NOT crash on the wiring", () => {
    const payload = JSON.stringify({ tool_input: { file_path: "src/cli.tsx" } });
    const r = runPiped(["hook", "scope-track", "--feature", "dummy"], payload);

    // The precise regression guard: ctx.resolveHookPath must receive a reader.
    expect(r.stderr).not.toContain("readStdin dep not provided");
    expect(r.stderr).not.toContain("UNEXPECTED_ERROR");
    // Pre-fix this exited 1 (crash); the production hook path is a clean allow.
    expect(r.status).toBe(0);
  });
});
