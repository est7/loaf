// Canonical JSON input ingestion (classification + policy + IO + diagnostics).
//
// Covers the complete protocol §10.7 `--input <-|inline|path>` boundary.
//
// DI'd: readFile + readStdin + JSON.parse implicit. Returns a typed
// success/failure shape rather than throwing — failures map to catalog
// codes (INPUT_FILE_NOT_FOUND / SCHEMA_VALIDATION_FAILED) so the caller
// can route through ctx.failure without bespoke error handling.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import type { CommandContext } from "../../src/cli/command-context.js";
import {
  createJsonInputIngestor,
  type JsonInputDeclaration,
  type JsonInputIngestorDeps,
} from "../../src/cli/input-ingestion.js";

async function tmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-input-read-"));
}

const NEVER_STDIN: JsonInputIngestorDeps["readStdin"] = async () => {
  throw new Error("readStdin should not be called in this test");
};

const DECLARATION: JsonInputDeclaration = {
  command: "loaf test",
  helpPrefix: "JSON source",
  inlineLabel: "inline JSON",
  stdinExpectation: "piped input",
};

type Failure = {
  route: "failure" | "emit-failure";
  code: string;
  message: string;
  detail?: Record<string, unknown>;
};

function recordingContext(failures: Failure[]): CommandContext {
  return {
    failure(code: string, message: string, detail?: Record<string, unknown>): void {
      failures.push({
        route: "failure",
        code,
        message,
        ...(detail === undefined ? {} : { detail }),
      });
    },
    emitFailure(code: string, message: string, detail?: Record<string, unknown>): void {
      failures.push({
        route: "emit-failure",
        code,
        message,
        ...(detail === undefined ? {} : { detail }),
      });
    },
  } as unknown as CommandContext;
}

function ingestor(
  overrides: Partial<JsonInputIngestorDeps> = {},
): ReturnType<typeof createJsonInputIngestor> {
  return createJsonInputIngestor({
    readStdin: NEVER_STDIN,
    isStdinTty: () => false,
    ...overrides,
  });
}

describe("JSON input ingestion", () => {
  test("inline JSON object → parsed value", async () => {
    const r = await ingestor().readJson(recordingContext([]), '{"foo":1,"bar":"baz"}', DECLARATION);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ foo: 1, bar: "baz" });
  });

  test("inline JSON array → parsed value", async () => {
    const r = await ingestor().readJson(recordingContext([]), "[1,2,3]", DECLARATION);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([1, 2, 3]);
  });

  test("file path → reads + parses JSON", async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "req.json");
    await fs.writeFile(filePath, '{"id":"REQ-FOO-001"}', "utf8");
    try {
      const r = await ingestor().readJson(recordingContext([]), filePath, DECLARATION);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ id: "REQ-FOO-001" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("file path that does not exist → { ok: false, code: INPUT_FILE_NOT_FOUND }", async () => {
    const failures: Failure[] = [];
    const r = await ingestor().readJson(
      recordingContext(failures),
      "/tmp/does/not/exist-loaf-sc3.json",
      DECLARATION,
    );
    expect(r.ok).toBe(false);
    expect(failures).toEqual([
      expect.objectContaining({
        route: "failure",
        code: "INPUT_FILE_NOT_FOUND",
        detail: { path: "/tmp/does/not/exist-loaf-sc3.json" },
      }),
    ]);
  });

  test("inline malformed JSON → { ok: false, code: SCHEMA_VALIDATION_FAILED }", async () => {
    const failures: Failure[] = [];
    const r = await ingestor().readJson(recordingContext(failures), "{not json}", DECLARATION);
    expect(r.ok).toBe(false);
    expect(failures[0]).toMatchObject({
      route: "failure",
      code: "SCHEMA_VALIDATION_FAILED",
      message: expect.stringMatching(/json/i),
    });
  });

  test("stdin → readStdin invoked + parsed value returned", async () => {
    const r = await ingestor({
      readStdin: async () => '{"from":"stdin"}',
    }).readJson(recordingContext([]), "-", DECLARATION);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ from: "stdin" });
  });

  test("Phase 16 SC-4b — readStdin throws → { ok:false, code:'MISSING_INPUT' }", async () => {
    // Preserves the pre-SC-4b `loaf tasks submit -` / `loaf tasks add -`
    // stdin-read-failure semantic (cli.tsx emitted MISSING_INPUT for
    // readFileSync(0) throws). After SC-4b the same lane goes through
    // JsonInputIngestor must propagate the same code. NOT mapped to
    // INPUT_FILE_NOT_FOUND (no file) or SCHEMA_VALIDATION_FAILED (no
    // JSON parse attempted) — codex r224 PATCH 4 distinct semantic.
    const failures: Failure[] = [];
    const r = await ingestor({
      readStdin: async () => {
        throw new Error("EAGAIN: stdin closed");
      },
    }).readJson(recordingContext(failures), "-", DECLARATION);
    expect(r.ok).toBe(false);
    expect(failures[0]).toMatchObject({
      route: "failure",
      code: "MISSING_INPUT",
      message: expect.stringMatching(/stdin/i),
      detail: { cause: expect.stringContaining("EAGAIN") },
    });
  });

  test("TTY stdin is rejected before read and uses declaration wording", async () => {
    const failures: Failure[] = [];
    let reads = 0;
    const r = await ingestor({
      isStdinTty: () => true,
      readStdin: async () => {
        reads += 1;
        return "{}";
      },
    }).readJson(recordingContext(failures), "-", DECLARATION);

    expect(r.ok).toBe(false);
    expect(reads).toBe(0);
    expect(failures[0]).toMatchObject({
      route: "failure",
      code: "USAGE",
      message: expect.stringContaining("`loaf test --input -` expects piped input"),
    });
  });

  test("missing optional input uses the declaration's route and message", async () => {
    const failures: Failure[] = [];
    const declaration: JsonInputDeclaration = {
      ...DECLARATION,
      missing: { route: "emit-failure", message: "use --input or --schema" },
    };
    const r = await ingestor().readJson(recordingContext(failures), undefined, declaration);

    expect(r.ok).toBe(false);
    expect(failures).toEqual([
      {
        route: "emit-failure",
        code: "MISSING_INPUT",
        message: "use --input or --schema",
      },
    ]);
  });
});
