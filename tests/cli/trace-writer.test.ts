// Phase 16 SC-6b — pure trace.jsonl writer tests.
//
// Covers:
//   - buildTraceEntry shape + ISO `at` + kind:"cli"
//   - stdout_summary JSON parse path + 256-char truncation (json + text)
//   - 14-flag redaction table × 2 forms (space + equals)
//   - appendTraceLine writes one newline-terminated line
//   - concurrent appendTraceLine atomic (POSIX O_APPEND)
//
// E2E + DI failure-injection live in
// `tests/cli/debug-end-to-end.test.ts`.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  buildTraceEntry,
  defaultAppendTraceLine,
  redactArgv,
  summarizeStdout,
  type TraceEntry,
} from "../../src/cli/trace-writer.js";

async function tmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc6b-writer-"));
}

describe("SC-6b — buildTraceEntry shape", () => {
  test("T9: required fields + schema_version=2 + kind=cli", () => {
    const entry = buildTraceEntry({
      now: new Date("2026-05-28T03:00:00.123Z"),
      feature: "auth-refresh",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      subState: "EXECUTE.work",
      cmd: "loaf advance EXECUTE.done",
      argv: ["advance", "EXECUTE.done", "--feature", "auth-refresh"],
      exit: 0,
      wallMs: 42,
      rawStdout: '{"ok":true}',
      outputMode: "json",
    });
    expect(entry.schema_version).toBe(2);
    expect(entry.kind).toBe("cli");
    expect(entry.feature).toBe("auth-refresh");
    expect(entry.session_id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(entry.sub_state).toBe("EXECUTE.work");
    expect(entry.cmd).toBe("loaf advance EXECUTE.done");
    expect(entry.exit).toBe(0);
    expect(entry.wall_ms).toBe(42);
  });

  test("T10: ISO-8601 `at` from injected Date", () => {
    const entry = buildTraceEntry({
      now: new Date("2026-05-28T03:00:00.123Z"),
      feature: "f",
      sessionId: null,
      subState: null,
      cmd: "loaf start",
      argv: ["start", "f"],
      exit: 0,
      wallMs: 1,
      rawStdout: "",
      outputMode: "text",
    });
    expect(entry.at).toBe("2026-05-28T03:00:00.123Z");
  });
});

describe("SC-6b — stdout_summary", () => {
  test("T11: JSON mode parses + re-stringifies (drops whitespace)", () => {
    const raw = '{\n  "ok": true,\n  "feature": "auth-refresh"\n}';
    expect(summarizeStdout(raw, "json")).toBe('{"ok":true,"feature":"auth-refresh"}');
  });

  test("T12: JSON mode falls back to text truncation on parse fail", () => {
    const raw = "not valid json at all";
    expect(summarizeStdout(raw, "json")).toBe("not valid json at all");
  });

  test("T13: text mode truncates at 256 chars", () => {
    const raw = "x".repeat(500);
    const out = summarizeStdout(raw, "text");
    expect(out.length).toBe(256);
    expect(out).toBe("x".repeat(256));
  });

  test("T14: text mode passes short stdout verbatim", () => {
    expect(summarizeStdout("abc", "text")).toBe("abc");
  });
});

describe("SC-6b — redactArgv (14-flag × 2-form table)", () => {
  const REDACTED_FLAGS = [
    "--feature-dir",
    "--input",
    "--reason",
    "--answer",
    "--question",
    "--options",
    "--label",
    "--summary",
    "--evidence-summary",
    "--evidence-reason",
    "--feature-name",
    "--intent",
    "--workspace",
    "--evidence-actor",
  ];

  for (const flag of REDACTED_FLAGS) {
    test(`T15 [${flag}] — space form: --flag value → --flag <name>`, () => {
      const placeholder = `<${flag.slice(2)}>`;
      const out = redactArgv(["loaf", "x", flag, "sensitive value here"]);
      expect(out).toEqual(["loaf", "x", flag, placeholder]);
    });

    test(`T16 [${flag}] — equals form: --flag=value → --flag=<name>`, () => {
      const placeholder = `<${flag.slice(2)}>`;
      const out = redactArgv(["loaf", "x", `${flag}=sensitive value here`]);
      expect(out).toEqual(["loaf", "x", `${flag}=${placeholder}`]);
    });
  }

  test("T17: non-redacted flags pass verbatim", () => {
    const out = redactArgv([
      "loaf", "advance", "EXECUTE.done",
      "--feature", "auth-refresh",
      "--ceremony", "standard",
      "--format", "json",
    ]);
    expect(out).toEqual([
      "loaf", "advance", "EXECUTE.done",
      "--feature", "auth-refresh",
      "--ceremony", "standard",
      "--format", "json",
    ]);
  });

  test("T18: idempotent — already-redacted values stay placeholders", () => {
    const once = redactArgv(["loaf", "x", "--reason", "secret"]);
    const twice = redactArgv(once);
    expect(twice).toEqual(once);
  });
});

describe("SC-6b — defaultAppendTraceLine: file IO", () => {
  test("T19: writes one newline-terminated JSON line to <featureDir>/trace.jsonl", async () => {
    const dir = await tmpDir();
    const entry: TraceEntry = {
      schema_version: 2,
      kind: "cli",
      at: "2026-05-28T03:00:00.123Z",
      feature: "f",
      session_id: null,
      sub_state: null,
      cmd: "loaf start f",
      argv: ["start", "f"],
      exit: 0,
      wall_ms: 5,
      stdout_summary: "",
    };
    await defaultAppendTraceLine(dir, entry);

    const content = await fs.readFile(path.join(dir, "trace.jsonl"), "utf8");
    expect(content.endsWith("\n")).toBe(true);
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.kind).toBe("cli");
    expect(parsed.feature).toBe("f");
  });

  test("T20: concurrent appends — both writes land as complete lines (POSIX O_APPEND)", async () => {
    const dir = await tmpDir();
    const mkEntry = (n: number): TraceEntry => ({
      schema_version: 2,
      kind: "cli",
      at: "2026-05-28T03:00:00.000Z",
      feature: `f${n}`,
      session_id: null,
      sub_state: null,
      cmd: `loaf cmd${n}`,
      argv: [`cmd${n}`],
      exit: 0,
      wall_ms: n,
      stdout_summary: "x".repeat(100),
    });
    await Promise.all([
      defaultAppendTraceLine(dir, mkEntry(1)),
      defaultAppendTraceLine(dir, mkEntry(2)),
    ]);
    const content = await fs.readFile(path.join(dir, "trace.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
    // Each line is a complete parseable JSON object — proves no
    // interleaving.
    const ids = lines.map((l) => JSON.parse(l).feature as string).sort();
    expect(ids).toEqual(["f1", "f2"]);
  });
});
