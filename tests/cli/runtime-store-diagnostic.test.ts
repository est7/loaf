import { describe, expect, test } from "vitest";
import { RuntimeStoreError } from "../../src/core/session-runtime.js";
import { runtimeStoreDiagnostic } from "../../src/cli/runtime-store-diagnostic.js";

if (false) {
  // @ts-expect-error every runtime lock status requires observed lock metadata.
  new RuntimeStoreError("RUNTIME_LOCK_TIMEOUT", "timeout");
}

describe("runtime status diagnostic mapping", () => {
  test.each([
    "RUNTIME_LOCK_TIMEOUT",
    "RUNTIME_LOCK_INVALID",
  ] as const)("%s preserves the established LOCK_TIMEOUT mapping and actual metadata", (code) => {
    const holder = {
      pid: 123,
      acquired_at: "2026-10-10T00:00:00.000Z",
      operation: "scope-track",
      owner: "a".repeat(32),
    };
    const error = new RuntimeStoreError(code, "observed failure", holder, {
      lock_path: "/runtime/session.lock",
      timeout_seconds: 0.125,
    });
    expect(runtimeStoreDiagnostic(error, "session-runtime")).toEqual({
      code: "LOCK_TIMEOUT",
      detail: {
        source: "session-runtime",
        runtime_code: code,
        reason: "observed failure",
        holder,
        lock_path: "/runtime/session.lock",
        timeout_seconds: 0.125,
      },
    });
  });
  test("identity errors retain their technical cause through SCHEMA_VALIDATION_FAILED", () => {
    expect(
      runtimeStoreDiagnostic(
        new RuntimeStoreError("RUNTIME_IDENTITY_MISMATCH", "selected cwd is unreadable"),
        "session-runtime",
      ),
    ).toEqual({
      code: "SCHEMA_VALIDATION_FAILED",
      detail: {
        source: "session-runtime",
        runtime_code: "RUNTIME_IDENTITY_MISMATCH",
        reason: "selected cwd is unreadable",
      },
    });
  });
});
