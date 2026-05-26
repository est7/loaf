// Phase 16 SC-2 — crash log writer unit tests.
//
// Pure unit tests for src/core/crash-log.ts. Dependency-injects `now`,
// `homeDir`, and `writeStderr` so the test runs hermetically — no real
// $HOME writes, no timing flake. Codex r196 PATCH F: avoid LOAF_TEST_*
// env vars and avoid spawning real CLI with timing-based SIGINT for the
// pure unit layer; integration coverage lives in cli-exit-semantics.test.ts.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  CrashLogEnvelope,
  UNEXPECTED_ERROR,
  writeCrashLog,
} from "../../src/core/crash-log.js";

async function tmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-crashlog-"));
}

const FIXED_NOW = new Date("2026-05-26T03:50:00.000Z");

describe("Phase 16 SC-2 — crash-log writer", () => {
  test("writes a parseable JSON envelope to ~/.loaf/crashes/<iso>.json", async () => {
    const home = await tmpHome();
    try {
      const err = new Error("boom");
      err.stack = "Error: boom\n    at synthetic:1:1";
      const written = await writeCrashLog(
        {
          argv: ["loaf", "advance", "EXECUTE.work", "--feature", "F-042"],
          cwd: "/tmp/repo",
          version: "0.1.0",
          error: err,
        },
        {
          now: () => FIXED_NOW,
          homeDir: () => home,
        },
      );
      expect(written, "writeCrashLog returns absolute path on success").not.toBeNull();
      expect(written!).toMatch(/\.loaf\/crashes\/2026-05-26T03-50-00\.000Z\.json$/);

      const raw = await fs.readFile(written!, "utf8");
      const envelope = CrashLogEnvelope.parse(JSON.parse(raw));
      expect(envelope.exitCode).toBe(1);
      expect(envelope.error.name).toBe("Error");
      expect(envelope.error.message).toBe("boom");
      expect(envelope.error.stack).toContain("synthetic:1:1");
      expect(envelope.argv).toEqual([
        "loaf",
        "advance",
        "EXECUTE.work",
        "--feature",
        "F-042",
      ]);
      expect(envelope.cwd).toBe("/tmp/repo");
      expect(envelope.version).toBe("0.1.0");
      // best-effort feature extraction from argv `--feature <NAME>`
      expect(envelope.feature).toBe("F-042");
      expect(envelope.iso).toBe("2026-05-26T03:50:00.000Z");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("creates ~/.loaf/crashes/ with mode 0700 and file with mode 0600", async () => {
    const home = await tmpHome();
    try {
      const written = await writeCrashLog(
        {
          argv: ["loaf", "status"],
          cwd: "/tmp",
          version: "0.1.0",
          error: new Error("x"),
        },
        { now: () => FIXED_NOW, homeDir: () => home },
      );
      expect(written).not.toBeNull();

      const dirStat = await fs.stat(path.join(home, ".loaf", "crashes"));
      // mask off type bits; only permission bits matter
      expect(dirStat.mode & 0o777).toBe(0o700);

      const fileStat = await fs.stat(written!);
      expect(fileStat.mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("on unwritable home (EACCES on dir create), returns null and invokes writeStderr fallback", async () => {
    // Inject a homeDir that exists but is read-only — the inner mkdir will EACCES.
    const home = await tmpHome();
    await fs.chmod(home, 0o500);
    let stderr = "";
    try {
      const written = await writeCrashLog(
        {
          argv: ["loaf", "status"],
          cwd: "/tmp",
          version: "0.1.0",
          error: new Error("x"),
        },
        {
          now: () => FIXED_NOW,
          homeDir: () => home,
          writeStderr: (s: string) => {
            stderr += s;
          },
        },
      );
      expect(written, "fallback returns null instead of throwing").toBeNull();
      expect(stderr, "fallback writes a one-line diagnostic to writeStderr").toMatch(
        /crash log unwritable/i,
      );
    } finally {
      // restore perms for cleanup
      await fs.chmod(home, 0o700);
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("UNEXPECTED_ERROR sentinel is exported as a string constant (NOT a DiagnosticCode)", () => {
    // Codex r196 PATCH E: sentinel lives in src/core/crash-log.ts, not in
    // docs/schemas.ts DiagnosticCode (that union is exit-2-only). Inventory
    // test scans `src/cli.tsx` for `code: "..."` patterns; placing it here
    // means it does NOT get picked up as an uncataloged emit.
    expect(UNEXPECTED_ERROR).toBe("UNEXPECTED_ERROR");
  });

  test("argv without --feature → envelope.feature is null", async () => {
    const home = await tmpHome();
    try {
      const written = await writeCrashLog(
        {
          argv: ["loaf", "status"],
          cwd: "/tmp",
          version: "0.1.0",
          error: new Error("x"),
        },
        { now: () => FIXED_NOW, homeDir: () => home },
      );
      const env = CrashLogEnvelope.parse(JSON.parse(await fs.readFile(written!, "utf8")));
      expect(env.feature).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
