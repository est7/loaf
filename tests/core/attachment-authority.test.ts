import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  AttachmentAuthorityError,
  readAttachment,
  readAttachmentSource,
  binaryAttachmentRef,
  writeAttachment,
} from "../../src/core/attachment-authority.js";
import type { AttachmentRef, JournalEntry } from "../../src/core/journal-entry.js";

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "loaf-attachment-authority-"));
}

function owner(
  kind: JournalEntry["kind"] = "lesson:recorded",
  entryId = "JE-000009",
): Pick<JournalEntry, "entry_id" | "kind"> {
  return { entry_id: entryId, kind };
}

function refFor(refPath: string, body: Buffer | string): AttachmentRef {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    path: refPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

async function expectAuthorityCode(
  promise: Promise<unknown>,
  code: AttachmentAuthorityError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "AttachmentAuthorityError",
    code,
  });
}

describe("attachment authority reads", () => {
  test("reads a valid owner slot and verifies its bytes", async () => {
    const root = await tmpRoot();
    const body = "verified lesson";
    const ref = await writeAttachment(root, owner(), "summary", body, { fsync: false });

    await expect(readAttachment(root, owner(), "summary", ref)).resolves.toEqual(Buffer.from(body));
  });

  test("rejects another entry bucket and a wrong slot filename", async () => {
    const root = await tmpRoot();
    const body = "not authorized here";
    const otherPath = "attachments/JE-000010/summary.txt";
    const wrongSlotPath = "attachments/JE-000009/other.txt";
    for (const refPath of [otherPath, wrongSlotPath]) {
      await expectAuthorityCode(
        readAttachment(root, owner(), "summary", refFor(refPath, body)),
        "ATTACHMENT_UNAUTHORIZED",
      );
    }
  });

  test("rejects intermediate and final symlinks", async () => {
    const outside = await tmpRoot();
    const outsideFile = path.join(outside, "sentinel.txt");
    await fs.writeFile(outsideFile, "outside");

    const intermediateRoot = await tmpRoot();
    await fs.symlink(outside, path.join(intermediateRoot, "attachments"));
    await expectAuthorityCode(
      readAttachment(
        intermediateRoot,
        owner(),
        "summary",
        refFor("attachments/JE-000009/summary.txt", "outside"),
      ),
      "ATTACHMENT_UNSAFE_PATH",
    );

    const finalRoot = await tmpRoot();
    const entryDir = path.join(finalRoot, "attachments", "JE-000009");
    await fs.mkdir(entryDir, { recursive: true });
    await fs.symlink(outsideFile, path.join(entryDir, "summary.txt"));
    await expectAuthorityCode(
      readAttachment(
        finalRoot,
        owner(),
        "summary",
        refFor("attachments/JE-000009/summary.txt", "outside"),
      ),
      "ATTACHMENT_UNSAFE_PATH",
    );
  });

  test("rejects directories, size mismatch, and hash mismatch", async () => {
    const root = await tmpRoot();
    const entryDir = path.join(root, "attachments", "JE-000009");
    await fs.mkdir(path.join(entryDir, "summary.txt"), { recursive: true });
    await expectAuthorityCode(
      readAttachment(root, owner(), "summary", refFor("attachments/JE-000009/summary.txt", "")),
      "ATTACHMENT_NOT_FILE",
    );

    await fs.rm(path.join(entryDir, "summary.txt"), { recursive: true });
    await fs.writeFile(path.join(entryDir, "summary.txt"), "actual");
    const valid = refFor("attachments/JE-000009/summary.txt", "actual");
    await expectAuthorityCode(
      readAttachment(root, owner(), "summary", { ...valid, size: valid.size + 1 }),
      "ATTACHMENT_INTEGRITY",
    );
    await expectAuthorityCode(
      readAttachment(root, owner(), "summary", { ...valid, sha256: "0".repeat(64) }),
      "ATTACHMENT_INTEGRITY",
    );
  });
});

describe("attachment authority writes", () => {
  test("refuses to replace an escaping final symlink", async () => {
    const root = await tmpRoot();
    const outside = path.join(await tmpRoot(), "sentinel.txt");
    await fs.writeFile(outside, "keep");
    const entryDir = path.join(root, "attachments", "JE-000009");
    await fs.mkdir(entryDir, { recursive: true });
    await fs.symlink(outside, path.join(entryDir, "summary.txt"));

    await expectAuthorityCode(
      writeAttachment(root, owner(), "summary", "replacement", { fsync: false }),
      "ATTACHMENT_UNSAFE_PATH",
    );
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("keep");
  });
});

test("binary capture remains authoritative if the source pathname is replaced before copy", async () => {
  const root = await tmpRoot();
  const source = path.join(await tmpRoot(), "screen.png");
  const capturedBytes = Buffer.from([0, 255, 12, 24, 128]);
  await fs.writeFile(source, capturedBytes);
  const body = await readAttachmentSource(source);
  const newSource = source + ".new";
  await fs.writeFile(newSource, "replacement bytes");
  await fs.rename(newSource, source);
  const evidenceOwner = owner("evidence:added");
  const expected = binaryAttachmentRef(evidenceOwner, 0, body);
  const actual = await writeAttachment(root, evidenceOwner, "evidence.1", body, { fsync: false });
  expect(actual).toEqual({
    path: "attachments/JE-000009/evidence-000001.bin",
    sha256: createHash("sha256").update(capturedBytes).digest("hex"),
    size: capturedBytes.length,
  });
  expect(actual).toEqual(expected);
  expect(await readAttachment(root, evidenceOwner, "evidence.1", actual)).toEqual(capturedBytes);
  expect(await fs.readFile(source, "utf8")).toBe("replacement bytes");
});
