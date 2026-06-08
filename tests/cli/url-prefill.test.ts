// Phase 16 SC-3 — sanitizeArgvForUrl + buildReportUrl (URL query prefill).
//
// Per codex r206 PATCH H: conservative allowlist. Command + subcommand
// + flag NAMES + non-sensitive enum-like values only. Redact all option
// values by default, especially:
//   - --input (inline JSON or path leak)
//   - --reason / --answer / --summary (free-text user data)
//   - path-like values (file system layout)
//   - inline JSON (any arg starting with `{` or `[`)
//
// Crash log JSON keeps full argv; the URL query is the user-pasteable
// surface that must be sanitized.

import { describe, expect, test } from "vitest";

import { buildReportUrl, sanitizeArgvForUrl } from "../../src/cli/url-prefill.js";

describe("Phase 16 SC-3 — sanitizeArgvForUrl (allowlist + redact)", () => {
  test("command + subcommand pass through unchanged", () => {
    const argv = ["loaf", "spec", "submit"];
    expect(sanitizeArgvForUrl(argv)).toBe("loaf spec submit");
  });

  test("codex r208 PATCH 2 — unknown positional (potentially sensitive feature slug) REDACTED", () => {
    // `acme-secret-launch` is a feature id positional after `start`. It
    // could be a launch codename / customer name / etc. — must NOT leak
    // to a public URL query.
    const argv = ["loaf", "start", "acme-secret-launch"];
    expect(sanitizeArgvForUrl(argv)).toBe("loaf start <redacted>");
  });

  test("codex r208 PATCH 2 — sub_state positional (public enum) passes through", () => {
    const argv = ["loaf", "advance", "EXECUTE.work"];
    expect(sanitizeArgvForUrl(argv)).toBe("loaf advance EXECUTE.work");
  });

  test("codex r208 PATCH 2 — gate name positional (public enum) passes through", () => {
    const argv = ["loaf", "gate", "decide", "spec-lock", "--approve"];
    expect(sanitizeArgvForUrl(argv)).toBe("loaf gate decide spec-lock --approve");
  });

  test("codex r208 PATCH 2 — task id positional (sensitive-by-default) REDACTED", () => {
    const argv = ["loaf", "tasks", "abandon", "T-007", "--reason", "scope-cut"];
    expect(sanitizeArgvForUrl(argv)).toBe("loaf tasks abandon <redacted> --reason <redacted>");
  });

  test("flag names pass through; values for sensitive flags get redacted", () => {
    const argv = ["loaf", "evidence", "add", "--input", '{"foo":1}', "--feature", "F-042"];
    const out = sanitizeArgvForUrl(argv);
    // --feature is an allowlisted flag for value pass-through (matches
    // /^[A-Z]+-[0-9]+$/ or simple slug); --input is always redacted
    expect(out).toBe("loaf evidence add --input <redacted> --feature F-042");
  });

  test("--reason / --answer / --summary always redacted (free text)", () => {
    const argv = [
      "loaf",
      "finding",
      "raise",
      "--reason",
      "Spec gap with sensitive PII inside",
      "--answer",
      "secret answer",
      "--summary",
      "long summary text",
    ];
    expect(sanitizeArgvForUrl(argv)).toBe(
      "loaf finding raise --reason <redacted> --answer <redacted> --summary <redacted>",
    );
  });

  test("inline JSON value (starts with { or [) always redacted regardless of flag", () => {
    const argv = ["loaf", "tasks", "submit", "--input", '[{"id":"T-001"}]'];
    expect(sanitizeArgvForUrl(argv)).toBe("loaf tasks submit --input <redacted>");
  });

  test("path-like value always redacted (contains / or starts with ./ or ../)", () => {
    const argv = ["loaf", "spec", "submit", "--input", "/Users/secret/file.json"];
    expect(sanitizeArgvForUrl(argv)).toBe("loaf spec submit --input <redacted>");
    expect(sanitizeArgvForUrl(["loaf", "spec", "submit", "--input", "./req.json"])).toBe(
      "loaf spec submit --input <redacted>",
    );
  });

  test("--ceremony with enum-like value passes through (feature positional REDACTED per r208 PATCH 2)", () => {
    // F-001 is a feature id positional after `start` — sensitive-by-default
    // post-codex-r208 PATCH 2. --ceremony standard pair still passes
    // through (ceremony is allowlisted + standard is a known preset).
    const argv = ["loaf", "start", "F-001", "--ceremony", "standard"];
    expect(sanitizeArgvForUrl(argv)).toBe("loaf start <redacted> --ceremony standard");
  });

  test("--format json/text passes through (enum-like)", () => {
    const argv = ["loaf", "status", "--feature", "F-042", "--format", "json"];
    expect(sanitizeArgvForUrl(argv)).toBe("loaf status --feature F-042 --format json");
  });
});

describe("Phase 16 SC-3 — buildReportUrl (query assembly)", () => {
  test("includes loaf_version + last_command + crash_log_path (sanitized)", () => {
    const url = buildReportUrl({
      base: "https://github.com/loaf-cli/loaf/issues/new",
      loaf_version: "0.1.0",
      schema_version: "2",
      phase: null,
      sub_state: null,
      argv: ["loaf", "advance", "EXECUTE.work", "--feature", "F-042"],
      crash_log_path: "/Users/test/.loaf/crashes/2026-05-26T05-00-00-000Z.json",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://github.com/loaf-cli/loaf/issues/new");
    expect(parsed.searchParams.get("loaf_version")).toBe("0.1.0");
    expect(parsed.searchParams.get("schema_version")).toBe("2");
    expect(parsed.searchParams.get("last_command")).toBe(
      "loaf advance EXECUTE.work --feature F-042",
    );
    expect(parsed.searchParams.get("crash_log_path")).toBe(
      "/Users/test/.loaf/crashes/2026-05-26T05-00-00-000Z.json",
    );
  });

  test("phase / sub_state appear in query when present", () => {
    const url = buildReportUrl({
      base: "https://example.invalid/new",
      loaf_version: "0.1.0",
      schema_version: "2",
      phase: "EXECUTE",
      sub_state: "EXECUTE.work",
      argv: ["loaf", "status"],
      crash_log_path: null,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("phase")).toBe("EXECUTE");
    expect(parsed.searchParams.get("sub_state")).toBe("EXECUTE.work");
  });

  test("redact-by-default holds inside the URL query", () => {
    const url = buildReportUrl({
      base: "https://example.invalid/new",
      loaf_version: "0.1.0",
      schema_version: "2",
      phase: null,
      sub_state: null,
      argv: ["loaf", "finding", "raise", "--reason", "the actual reason text"],
      crash_log_path: null,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("last_command")).toBe("loaf finding raise --reason <redacted>");
    expect(parsed.searchParams.get("last_command")).not.toContain("actual reason");
  });
});
