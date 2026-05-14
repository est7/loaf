import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { CliUsageError } from "../src/core/errors.js";
import { appendHelloRecord, readHelloRecords } from "../src/core/jsonl-store.js";

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("jsonl store", () => {
  test("appends and reads records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loaf-cli-"));
    createdDirs.push(directory);

    const filePath = join(directory, "history.jsonl");

    await appendHelloRecord(filePath, {
      command: "hello",
      name: "est9",
      message: "Hello, est9!",
      createdAt: "2026-05-12T15:30:00.000Z",
    });

    expect(await readHelloRecords(filePath)).toEqual([
      {
        command: "hello",
        name: "est9",
        message: "Hello, est9!",
        createdAt: "2026-05-12T15:30:00.000Z",
      },
    ]);

    expect(await readFile(filePath, "utf8")).toContain("\"command\":\"hello\"");
  });

  test("returns an empty array when the file does not exist yet", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loaf-cli-"));
    createdDirs.push(directory);

    expect(await readHelloRecords(join(directory, "missing.jsonl"))).toEqual([]);
  });

  test("fails fast on invalid jsonl content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loaf-cli-"));
    createdDirs.push(directory);

    const filePath = join(directory, "history.jsonl");
    await writeFile(filePath, "not-json\n", "utf8");

    await expect(readHelloRecords(filePath)).rejects.toThrow(CliUsageError);
  });
});
