// Phase 16 SC-3 — readJsonInput (IO + JSON parse + error mapping).
//
// Companion to parseInputSource — handles the IO side of protocol §10.7
// `--input <-|inline|path>`. Codex r206 PATCH F: classification and
// reading are deliberately separated so neither becomes a shallow module.
//
// DI'd: readFile + readStdin + JSON.parse implicit. Returns a typed
// success/failure shape rather than throwing — failures map to catalog
// codes (INPUT_FILE_NOT_FOUND / SCHEMA_VALIDATION_FAILED) so the caller
// can route through ctx.failure without bespoke error handling.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { parseInputSource } from "../../src/cli/input-source.js";
import { readJsonInput, type ReadJsonInputDeps } from "../../src/cli/input-read.js";

async function tmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-input-read-"));
}

const NEVER_STDIN: ReadJsonInputDeps["readStdin"] = async () => {
  throw new Error("readStdin should not be called in this test");
};

describe("Phase 16 SC-3 — readJsonInput (IO + parse)", () => {
  test("inline JSON object → parsed value", async () => {
    const source = parseInputSource('{"foo":1,"bar":"baz"}');
    const r = await readJsonInput(source, { readStdin: NEVER_STDIN });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ foo: 1, bar: "baz" });
  });

  test("inline JSON array → parsed value", async () => {
    const source = parseInputSource('[1,2,3]');
    const r = await readJsonInput(source, { readStdin: NEVER_STDIN });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([1, 2, 3]);
  });

  test("file path → reads + parses JSON", async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "req.json");
    await fs.writeFile(filePath, '{"id":"REQ-FOO-001"}', "utf8");
    try {
      const source = parseInputSource(filePath);
      const r = await readJsonInput(source, { readStdin: NEVER_STDIN });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ id: "REQ-FOO-001" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("file path that does not exist → { ok: false, code: INPUT_FILE_NOT_FOUND }", async () => {
    const source = parseInputSource("/tmp/does/not/exist-loaf-sc3.json");
    const r = await readJsonInput(source, { readStdin: NEVER_STDIN });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("INPUT_FILE_NOT_FOUND");
      expect(r.detail).toMatchObject({ path: "/tmp/does/not/exist-loaf-sc3.json" });
    }
  });

  test("inline malformed JSON → { ok: false, code: SCHEMA_VALIDATION_FAILED }", async () => {
    const source = parseInputSource('{not json}');
    const r = await readJsonInput(source, { readStdin: NEVER_STDIN });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("SCHEMA_VALIDATION_FAILED");
      expect(r.message).toMatch(/json/i);
    }
  });

  test("stdin → readStdin invoked + parsed value returned", async () => {
    const source = parseInputSource("-");
    const r = await readJsonInput(source, {
      readStdin: async () => '{"from":"stdin"}',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ from: "stdin" });
  });

  test("Phase 16 SC-4b — readStdin throws → { ok:false, code:'MISSING_INPUT' }", async () => {
    // Preserves the pre-SC-4b `loaf tasks submit -` / `loaf tasks add -`
    // stdin-read-failure semantic (cli.tsx emitted MISSING_INPUT for
    // readFileSync(0) throws). After SC-4b the same lane goes through
    // readJsonInput which must propagate the same code. NOT mapped to
    // INPUT_FILE_NOT_FOUND (no file) or SCHEMA_VALIDATION_FAILED (no
    // JSON parse attempted) — codex r224 PATCH 4 distinct semantic.
    const source = parseInputSource("-");
    const r = await readJsonInput(source, {
      readStdin: async () => {
        throw new Error("EAGAIN: stdin closed");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MISSING_INPUT");
      expect(r.message).toMatch(/stdin/i);
      expect(r.detail).toMatchObject({ cause: expect.stringContaining("EAGAIN") });
    }
  });
});
