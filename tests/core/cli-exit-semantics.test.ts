// Phase 16 SC-2 — CLI top-level exit-semantics boundary tests.
//
// Covers protocol §10.9 (exit 1 unexpected / exit 2 user/state / 130
// SIGINT) and the codex r188 Q1 verdict. The boundary lives in
// src/cli.tsx top-level try/catch; this file proves:
//
//   - Unhandled throws escape to exit 1 + crash log + UNEXPECTED_ERROR
//     sentinel (text + --json modes)
//   - Catalogued user/state errors stay at exit 2 (regression)
//   - Commander parse errors stay at exit 2 (regression)
//   - failRebuild() exit-1 paths normalize to exit 2 (SC-1 catalog drift
//     closure — DOCTOR_REBUILD_FAILED / DOCTOR_REBUILD_MIGRATED_UNSUPPORTED
//     are catalogued exit_code: 2; codex r196 PATCH A)
//   - SIGINT handler is exit 130, installed idempotently, written
//     without timing-based test (codex r196 PATCH C — use DI)

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { main } from "../../src/cli.js";
import {
  installSigintHandler,
  type SigintHandlerDeps,
} from "../../src/cli.js";

async function runCli(
  argv: string[],
  homeDir?: string,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origHome = process.env["HOME"];
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    outChunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    errChunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  if (homeDir !== undefined) process.env["HOME"] = homeDir;
  try {
    const exit = await main(["node", "loaf", ...argv]);
    return { exit, stdout: outChunks.join(""), stderr: errChunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    if (origHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = origHome;
  }
}

async function tmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-exit-"));
}

async function tmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-home-"));
}

describe("Phase 16 SC-2 — top-level boundary: exit 1 on unhandled throw", () => {
  test("corrupt journal in feature-dir → exit 1 + UNEXPECTED_ERROR + crash log written", async () => {
    const home = await tmpHome();
    const featureDir = await tmpDir();
    try {
      // Write a journal line that survives line-split but fails envelope parse
      // → replayJournal returns !ok → loadSession throws (cli-runtime.ts:62-64).
      // `loaf advance` is a loadSession-using path with no specific catch,
      // so the throw escapes to main()'s top-level boundary.
      await fs.writeFile(
        path.join(featureDir, "journal.jsonl"),
        '{"not":"a journal entry"}\n',
        "utf8",
      );
      const r = await runCli(
        ["advance", "EXECUTE.work", "--feature", "X", "--feature-dir", featureDir],
        home,
      );
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("UNEXPECTED_ERROR");
      expect(r.stderr).toMatch(/crash log/i);

      // crash log file landed under $HOME/.loaf/crashes/
      const crashes = path.join(home, ".loaf", "crashes");
      const files = await fs.readdir(crashes);
      expect(files.length, "exactly one crash log written").toBe(1);
      const envelope = JSON.parse(
        await fs.readFile(path.join(crashes, files[0]!), "utf8"),
      );
      expect(envelope.exitCode).toBe(1);
      expect(envelope.argv).toContain("advance");
      expect(envelope.error.message).toMatch(/failed to load session/i);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(featureDir, { recursive: true, force: true });
    }
  });

  test("--json mode: corrupt journal → stderr single-line JSON {code:UNEXPECTED_ERROR, crash_log:...}, stdout empty", async () => {
    const home = await tmpHome();
    const featureDir = await tmpDir();
    try {
      await fs.writeFile(
        path.join(featureDir, "journal.jsonl"),
        '{"not":"a journal entry"}\n',
        "utf8",
      );
      const r = await runCli(
        [
          "advance",
          "EXECUTE.work",
          "--feature",
          "X",
          "--feature-dir",
          featureDir,
          "--json",
        ],
        home,
      );
      expect(r.exit).toBe(1);
      expect(r.stdout).toBe("");
      // stderr should be exactly one JSON line (modulo trailing newline)
      const lines = r.stderr.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBe(1);
      const obj = JSON.parse(lines[0]!);
      expect(obj.ok).toBe(false);
      expect(obj.code).toBe("UNEXPECTED_ERROR");
      expect(obj.crash_log, "JSON envelope carries the crash log path").toMatch(
        /\.loaf\/crashes\/.+\.json$/,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(featureDir, { recursive: true, force: true });
    }
  });
});

describe("Phase 16 SC-2 — regression: catalogued exit-2 paths unchanged", () => {
  test("`loaf start --ceremony bogus` still exits 2 via INVALID_PRESET (fail path)", async () => {
    const r = await runCli(["start", "F-001", "--ceremony", "bogus", "--feature-dir", "/tmp/none"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("INVALID_PRESET");
  });

  test("Commander parse error (`--unknown-flag`) still exits 2", async () => {
    const r = await runCli(["status", "--unknown-flag"]);
    expect(r.exit).toBe(2);
  });
});

describe("Phase 16 SC-2 — failRebuild normalization (SC-1 catalog drift closure)", () => {
  // Before SC-2: cli.tsx:1075-1084 failRebuild() set exit=1 for these codes
  // even though SC-1 catalogued them at exit_code: 2. After SC-2: the
  // failRebuild helper normalizes to emitFailure() / exit 2 — matching the
  // catalog and removing the exit-1-without-crash-log oddity codex r196
  // PATCH A flagged.

  test("`loaf doctor` (bare, no --rebuild) — DOCTOR_MODE_NOT_IMPLEMENTED stays exit 2 (unchanged)", async () => {
    const r = await runCli(["doctor"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("DOCTOR_MODE_NOT_IMPLEMENTED");
  });

  test("unreplayable journal under `doctor --rebuild` now exits 2 (was 1)", async () => {
    const dir = await tmpDir();
    try {
      await fs.writeFile(
        path.join(dir, "journal.jsonl"),
        '{"not":"a journal entry"}\n',
        "utf8",
      );
      const r = await runCli([
        "doctor",
        "--rebuild",
        "--feature",
        "X",
        "--feature-dir",
        dir,
      ]);
      expect(r.exit).toBe(2);
      expect(r.stderr).toContain("cannot be replayed");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Phase 16 SC-2 — SIGINT handler: exit 130 via DI (codex r196 PATCH C)", () => {
  test("installSigintHandler({writeStderr, exit}) writes 'interrupted' and calls exit(130)", () => {
    let stderr = "";
    let exitCalled: number | null = null;
    const deps: SigintHandlerDeps = {
      writeStderr: (s: string) => {
        stderr += s;
      },
      exit: (code: number) => {
        exitCalled = code;
      },
    };
    const handler = installSigintHandler(deps);
    handler();
    expect(stderr).toMatch(/interrupted/i);
    expect(stderr).toMatch(/SIGINT/);
    expect(exitCalled).toBe(130);
  });

  test("installSigintHandler is idempotent — calling install twice does not leak listeners", () => {
    const before = process.listenerCount("SIGINT");
    const deps: SigintHandlerDeps = {
      writeStderr: () => {},
      exit: () => {},
    };
    installSigintHandler(deps);
    installSigintHandler(deps);
    installSigintHandler(deps);
    const after = process.listenerCount("SIGINT");
    // At most one new listener over the baseline — even after 3 install calls
    expect(after - before).toBeLessThanOrEqual(1);
  });
});
