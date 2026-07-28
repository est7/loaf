// Stage 4 — sidecar pipeline (§11.2 step 4) + orphan GC.
//
// Tests verify the LongTextField promotion semantics and the orphan GC scan
// behavior. Crash-injection harness (full step 2a-4c boundary coverage)
// remains future work; this MVP test exercises step 4 outcomes.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

import {
  cleanupOrphanSidecars,
  listOrphanSidecars,
  promoteSidecars,
} from "../../src/core/sidecar.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";

async function tmpRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "loaf-sidecar-"));
}

function entryWithSummary(text: string, mode: "inline" | "sidecar" = "inline"): JournalEntry {
  return {
    seq: 0,
    entry_id: "JE-000001",
    at: "2026-05-15T10:00:00.000Z",
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind: "evidence:added",
    payload: {
      summary:
        mode === "inline"
          ? { mode: "inline", text }
          : { mode: "sidecar", ref: { path: "x", sha256: "0".repeat(64), size: 0 } },
    },
  };
}

describe("promoteSidecars — Stage 4 §11.2 step 4", () => {
  test("small inline LongTextField stays inline (≤ threshold)", async () => {
    const root = await tmpRoot();
    const e = entryWithSummary("hello");
    const promoted = await promoteSidecars(e, root, { fsync: false });
    expect(promoted).toEqual(e);

    // No attachments dir written when nothing promoted.
    await expect(fs.readdir(path.join(root, "attachments"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("oversize inline LongTextField promotes to sidecar form", async () => {
    const root = await tmpRoot();
    const big = "x".repeat(10_000);
    const e = entryWithSummary(big);
    const promoted = await promoteSidecars(e, root, { fsync: false });

    const promotedField = (
      promoted.payload as {
        summary: { mode: string; ref?: { path: string; sha256: string; size: number } };
      }
    ).summary;
    expect(promotedField.mode).toBe("sidecar");
    expect(promotedField.ref).toBeDefined();
    expect(promotedField.ref!.path).toBe(`attachments/${e.entry_id}/summary.txt`);
    expect(promotedField.ref!.size).toBe(Buffer.byteLength(big, "utf8"));

    // sha256 of file content matches the AttachmentRef declaration.
    const fileBytes = await fs.readFile(path.join(root, promotedField.ref!.path));
    const expectedSha = createHash("sha256").update(fileBytes).digest("hex");
    expect(promotedField.ref!.sha256).toBe(expectedSha);
  });

  test("threshold override lets tests promote smaller payloads", async () => {
    const root = await tmpRoot();
    const e = entryWithSummary("smallish");
    const promoted = await promoteSidecars(e, root, { threshold_bytes: 4, fsync: false });
    const field = (promoted.payload as { summary: { mode: string } }).summary;
    expect(field.mode).toBe("sidecar");
  });

  test("entry without LongTextField payload passes through unchanged", async () => {
    const root = await tmpRoot();
    const e: JournalEntry = {
      seq: 0,
      entry_id: "JE-000001",
      at: "2026-05-15T10:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "pending:added",
      payload: { id: "PEND-001" },
    };
    const promoted = await promoteSidecars(e, root, { fsync: false });
    expect(promoted).toEqual(e);
  });

  test("LongTextField-shaped data outside the explicit kind/field registry is not promoted", async () => {
    const root = await tmpRoot();
    const e = {
      ...entryWithSummary("kept"),
      payload: { fake: { mode: "inline", text: "x".repeat(10_000) } },
    } as JournalEntry;

    const promoted = await promoteSidecars(e, root, { fsync: false });
    expect(promoted).toEqual(e);
    await expect(fs.readdir(path.join(root, "attachments"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("an existing sidecar ref must own the entry bucket and registered slot", async () => {
    const root = await tmpRoot();
    const e = entryWithSummary("ignored", "sidecar");
    (
      e.payload as {
        summary: { mode: "sidecar"; ref: { path: string } };
      }
    ).summary.ref.path = "attachments/JE-000002/summary.txt";

    await expect(promoteSidecars(e, root, { fsync: false })).rejects.toMatchObject({
      code: "ATTACHMENT_UNAUTHORIZED",
    });
  });
});

describe("listOrphanSidecars / cleanupOrphanSidecars — orphan GC", () => {
  test("entry dir not in live set is reported as orphan", async () => {
    const root = await tmpRoot();
    await fs.mkdir(path.join(root, "attachments", "JE-000001"), { recursive: true });
    await fs.writeFile(path.join(root, "attachments", "JE-000001", "summary.txt"), "hi");

    const scan = await listOrphanSidecars(root, new Set([]));
    expect(scan.orphan_entry_dirs).toHaveLength(1);
    expect(scan.orphan_entry_dirs[0]).toContain("JE-000001");
  });

  test("live entry dir with .tmp-* file reports tmp as orphan but keeps dir", async () => {
    const root = await tmpRoot();
    const dir = path.join(root, "attachments", "JE-000001");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "summary.txt"), "kept");
    await fs.writeFile(path.join(dir, "summary.txt.tmp-abc123"), "stray");

    const scan = await listOrphanSidecars(root, new Set(["JE-000001"]));
    expect(scan.orphan_entry_dirs).toHaveLength(0);
    expect(scan.orphan_tmp_files).toHaveLength(1);
  });

  test("cleanupOrphanSidecars removes orphan entry dirs + tmp files", async () => {
    const root = await tmpRoot();
    await fs.mkdir(path.join(root, "attachments", "JE-000099"), { recursive: true });
    await fs.writeFile(path.join(root, "attachments", "JE-000099", "x.txt"), "byebye");
    await fs.mkdir(path.join(root, "attachments", "JE-000001"), { recursive: true });
    await fs.writeFile(path.join(root, "attachments", "JE-000001", "summary.txt.tmp-xyz"), "stray");

    await cleanupOrphanSidecars(root, new Set(["JE-000001"]));

    await expect(fs.access(path.join(root, "attachments", "JE-000099"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.access(path.join(root, "attachments", "JE-000001", "summary.txt.tmp-xyz")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("empty attachments dir yields empty scan (idempotent)", async () => {
    const root = await tmpRoot();
    const scan = await listOrphanSidecars(root, new Set([]));
    expect(scan.orphan_entry_dirs).toEqual([]);
    expect(scan.orphan_tmp_files).toEqual([]);
  });
});
