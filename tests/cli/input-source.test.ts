// Phase 16 SC-3 — InputSource classification (pure).
//
// `parseInputSource(arg)` per protocol §10.7 + ADR-0004 A11:
//   1. "-"                → { kind: "stdin" }
//   2. matches /^[\{\[]/ → { kind: "inline", value }
//   3. else              → { kind: "file", path: value }
//
// Codex r206 PATCH F: this layer is classification ONLY — no IO, no JSON
// parse, no error mapping. readJsonInput() (separate module) handles
// reading + parsing + error mapping.

import { describe, expect, test } from "vitest";

import { InputSourceResolver, parseInputSource } from "../../src/cli/input-source.js";

describe("Phase 16 SC-3 — parseInputSource (pure classification)", () => {
  test("canonical schema accepts runtime shapes and rejects the retired docs discriminant", () => {
    expect(InputSourceResolver.safeParse({ kind: "stdin" }).success).toBe(true);
    expect(InputSourceResolver.safeParse({ kind: "inline", value: "{}" }).success).toBe(true);
    expect(InputSourceResolver.safeParse({ kind: "file", path: "input.json" }).success).toBe(true);
    expect(InputSourceResolver.safeParse({ source: "inline", raw: "{}" }).success).toBe(false);
  });

  test("`-` → { kind: 'stdin' }", () => {
    expect(parseInputSource("-")).toEqual({ kind: "stdin" });
  });

  test("inline JSON object `{...}` → { kind: 'inline', value }", () => {
    const arg = '{"feature":"F-007","ceremony":"standard"}';
    expect(parseInputSource(arg)).toEqual({ kind: "inline", value: arg });
  });

  test("inline JSON array `[...]` → { kind: 'inline', value }", () => {
    const arg = '[{"id":"REQ-FOO-001"},{"id":"REQ-FOO-002"}]';
    expect(parseInputSource(arg)).toEqual({ kind: "inline", value: arg });
  });

  test("inline JSON with leading whitespace before `{` still treats as inline", () => {
    // Protocol regex /^[\{\[]/ is strict — leading whitespace pushes
    // the arg to the file-path lane. Documented behavior, tested here.
    const arg = '  {"foo":1}';
    expect(parseInputSource(arg)).toEqual({ kind: "file", path: arg });
  });

  test("bare file path → { kind: 'file', path }", () => {
    expect(parseInputSource("/tmp/req.json")).toEqual({
      kind: "file",
      path: "/tmp/req.json",
    });
  });

  test("relative file path → { kind: 'file', path }", () => {
    expect(parseInputSource("fixtures/req.json")).toEqual({
      kind: "file",
      path: "fixtures/req.json",
    });
  });

  test("path starting with single `-` not equal to literal `-` → file path", () => {
    // Defensive: `--foo` is a Commander flag, not an input arg, but if it
    // somehow lands here, classify as file (will then ENOENT) — never as
    // stdin (only literal "-").
    expect(parseInputSource("-foo")).toEqual({ kind: "file", path: "-foo" });
    expect(parseInputSource("--foo")).toEqual({ kind: "file", path: "--foo" });
  });
});
