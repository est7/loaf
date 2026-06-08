// Phase 16 SC-12a-2 — pure tests for runEditor tokenizer + production
// wrapper boundary semantics (codex r336 P1/P2 lock).

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { EditorTokenizeError, runEditor, tokenizeEditor } from "../../src/cli/run-editor.js";

// ───────────────────────────────────────────────────────────────────────
// tokenizeEditor — 7 fixture cases per codex r336 P2 contract
// ───────────────────────────────────────────────────────────────────────
describe("tokenizeEditor — shell-style word split with quote grouping", () => {
  test("bare executable: 'vi' → ['vi']", () => {
    expect(tokenizeEditor("vi")).toEqual(["vi"]);
  });

  test("exec + single flag: 'vim -f' → ['vim', '-f']", () => {
    expect(tokenizeEditor("vim -f")).toEqual(["vim", "-f"]);
  });

  test("exec + single flag: 'code -w' → ['code', '-w']", () => {
    expect(tokenizeEditor("code -w")).toEqual(["code", "-w"]);
  });

  test("angle brackets stay literal (no shell redirect)", () => {
    expect(tokenizeEditor("node <stub.js>")).toEqual(["node", "<stub.js>"]);
  });

  test("quote grouping: double + single quotes preserve whitespace inside", () => {
    expect(tokenizeEditor(`"node" '<stub path with spaces>.js' --flag`)).toEqual([
      "node",
      "<stub path with spaces>.js",
      "--flag",
    ]);
  });

  test("unmatched double quote → EditorTokenizeError", () => {
    expect(() => tokenizeEditor(`node "<unmatched`)).toThrow(EditorTokenizeError);
  });

  test("unmatched single quote → EditorTokenizeError", () => {
    expect(() => tokenizeEditor(`node '<unmatched`)).toThrow(EditorTokenizeError);
  });

  test("whitespace-only → []", () => {
    expect(tokenizeEditor("   ")).toEqual([]);
  });

  test("empty string → []", () => {
    expect(tokenizeEditor("")).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────
// runEditor — production wrapper behavior (3 cases against real procs)
// ───────────────────────────────────────────────────────────────────────
describe("runEditor — production wrapper", () => {
  test("happy: editor=true (noop, exits 0) → code:0 signal:null no error", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc12-rune-"));
    const filePath = path.join(tmp, "spec.md");
    await fs.writeFile(filePath, "fixture content");
    const result = await runEditor({
      filePath,
      editor: "true", // POSIX `true` — exits 0 immediately
      cwd: tmp,
      env: process.env,
    });
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.error).toBeUndefined();
  });

  test("non-zero exit: editor=false → code:1 signal:null no error", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc12-rune-"));
    const filePath = path.join(tmp, "spec.md");
    await fs.writeFile(filePath, "fixture content");
    const result = await runEditor({
      filePath,
      editor: "false", // POSIX `false` — exits 1
      cwd: tmp,
      env: process.env,
    });
    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.error).toBeUndefined();
  });

  test("spawn error: editor=/nonexistent/loaf-sc12-fake-editor → code:127 error set", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc12-rune-"));
    const filePath = path.join(tmp, "spec.md");
    await fs.writeFile(filePath, "fixture content");
    const result = await runEditor({
      filePath,
      editor: "/nonexistent/loaf-sc12-fake-editor",
      cwd: tmp,
      env: process.env,
    });
    expect(result.code).toBe(127);
    expect(result.error).toBeDefined();
  });

  test("unmatched quote (codex r339 P1) → code:127 error=EDITOR_TOKENIZE_ERROR (does NOT throw)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc12-rune-"));
    const filePath = path.join(tmp, "spec.md");
    await fs.writeFile(filePath, "x");
    const result = await runEditor({
      filePath,
      editor: `node "<unmatched`,
      cwd: tmp,
      env: process.env,
    });
    expect(result.code).toBe(127);
    expect(result.error).toBe("EDITOR_TOKENIZE_ERROR");
  });

  test("empty editor (after tokenize → []) → code:127 error=EDITOR_EMPTY", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sc12-rune-"));
    const filePath = path.join(tmp, "spec.md");
    await fs.writeFile(filePath, "x");
    const result = await runEditor({
      filePath,
      editor: "", // bypassing the cli.tsx fallback path explicitly
      cwd: tmp,
      env: process.env,
    });
    expect(result.code).toBe(127);
    expect(result.error).toBe("EDITOR_EMPTY");
  });
});
