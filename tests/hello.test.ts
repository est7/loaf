import { describe, expect, test, vi } from "vitest";
import { CliUsageError } from "../src/core/errors.js";
import { createHelloRecord } from "../src/core/hello.js";

describe("createHelloRecord", () => {
  test("returns a default greeting when no name is provided", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T15:30:00.000Z"));

    expect(createHelloRecord({})).toEqual({
      command: "hello",
      name: "world",
      message: "Hello, world!",
      createdAt: "2026-05-12T15:30:00.000Z",
    });

    vi.useRealTimers();
  });

  test("uppercases the greeting when requested", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T15:30:00.000Z"));

    expect(createHelloRecord({ name: "est9", uppercase: true })).toEqual({
      command: "hello",
      name: "est9",
      message: "HELLO, EST9!",
      createdAt: "2026-05-12T15:30:00.000Z",
    });

    vi.useRealTimers();
  });

  test("rejects invalid names", () => {
    expect(() => createHelloRecord({ name: "bad/name" })).toThrow(CliUsageError);
  });
});
