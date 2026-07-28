// Central filesystem authority for internal long-text attachments.
//
// The lexical AttachmentRef schema prevents traversal syntax. This module
// additionally binds every ref to its owning journal entry and declared
// payload slot, rejects symlinked path components, and performs integrity
// verification from the same open file handle used to read the bytes.

import { createHash, randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import type { AttachmentRef } from "./attachment-ref.js";
import type { JournalEntry } from "./journal-entry.js";

type AttachmentOwner = Pick<JournalEntry, "entry_id" | "kind">;

const LONG_TEXT_SLOTS = {
  "evidence:added": { summary: "summary.txt" },
  "lesson:recorded": { summary: "summary.txt" },
  "scope:recorded": { paths: "paths.txt" },
  "migration:snapshot_imported": {
    state: "migration/state.json",
    tasks: "migration/tasks.json",
    spec_md: "migration/spec.md",
    evidence: "migration/evidence.jsonl",
    findings: "migration/findings.jsonl",
    pending: "migration/pending.json",
  },
} as const satisfies Partial<Record<JournalEntry["kind"], Readonly<Record<string, string>>>>;

export type AttachmentAuthorityCode =
  | "ATTACHMENT_UNAUTHORIZED"
  | "ATTACHMENT_UNSAFE_PATH"
  | "ATTACHMENT_MISSING"
  | "ATTACHMENT_NOT_FILE"
  | "ATTACHMENT_INTEGRITY";

export class AttachmentAuthorityError extends Error {
  constructor(
    readonly code: AttachmentAuthorityCode,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AttachmentAuthorityError";
  }
}

export interface AttachmentWriteOptions {
  fsync?: boolean;
}

export function attachmentFieldsFor(kind: JournalEntry["kind"]): readonly string[] {
  return Object.keys(LONG_TEXT_SLOTS[kind as keyof typeof LONG_TEXT_SLOTS] ?? {});
}

function expectedRelativePath(owner: AttachmentOwner, field: string): string {
  const slots = LONG_TEXT_SLOTS[owner.kind as keyof typeof LONG_TEXT_SLOTS] as
    | Readonly<Record<string, string>>
    | undefined;
  const suffix = slots?.[field];
  if (!suffix) {
    throw new AttachmentAuthorityError(
      "ATTACHMENT_UNAUTHORIZED",
      `attachment slot ${owner.kind}.${field} is not registered`,
      { entry_id: owner.entry_id, kind: owner.kind, field },
    );
  }
  return `attachments/${owner.entry_id}/${suffix}`;
}

function assertAuthorizedRef(owner: AttachmentOwner, field: string, ref: AttachmentRef): string {
  const expected = expectedRelativePath(owner, field);
  if (ref.path !== expected) {
    throw new AttachmentAuthorityError(
      "ATTACHMENT_UNAUTHORIZED",
      `attachment ref ${ref.path} does not own slot ${owner.entry_id}:${owner.kind}.${field}`,
      { expected, actual: ref.path, entry_id: owner.entry_id, kind: owner.kind, field },
    );
  }
  return expected;
}

export function assertAttachmentOwnership(
  owner: AttachmentOwner,
  field: string,
  ref: AttachmentRef,
): void {
  assertAuthorizedRef(owner, field, ref);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function realFeatureRoot(featureDir: string): Promise<string> {
  const root = await fs.realpath(featureDir);
  const stat = await fs.lstat(root);
  if (!stat.isDirectory()) {
    throw new AttachmentAuthorityError(
      "ATTACHMENT_UNSAFE_PATH",
      `feature attachment root is not a directory: ${featureDir}`,
    );
  }
  return root;
}

async function prepareParent(root: string, relativeFile: string, create: boolean): Promise<string> {
  const parentSegments = path.posix.dirname(relativeFile).split("/");
  let current = root;
  for (const segment of parentSegments) {
    current = path.join(current, segment);
    if (create) {
      await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }

    let stat: Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AttachmentAuthorityError(
          "ATTACHMENT_MISSING",
          `attachment directory is missing: ${current}`,
          { path: current },
        );
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new AttachmentAuthorityError(
        "ATTACHMENT_UNSAFE_PATH",
        `attachment directory must not be a symlink: ${current}`,
        { path: current },
      );
    }
    if (!stat.isDirectory()) {
      throw new AttachmentAuthorityError(
        "ATTACHMENT_UNSAFE_PATH",
        `attachment path component is not a directory: ${current}`,
        { path: current },
      );
    }
    const real = await fs.realpath(current);
    if (!isInside(root, real)) {
      throw new AttachmentAuthorityError(
        "ATTACHMENT_UNSAFE_PATH",
        `attachment directory escapes the feature root: ${current}`,
        { path: current, resolved: real },
      );
    }
  }
  return current;
}

async function inspectFinalPath(finalPath: string): Promise<"missing" | "file"> {
  try {
    const stat = await fs.lstat(finalPath);
    if (stat.isSymbolicLink()) {
      throw new AttachmentAuthorityError(
        "ATTACHMENT_UNSAFE_PATH",
        `attachment file must not be a symlink: ${finalPath}`,
        { path: finalPath },
      );
    }
    if (!stat.isFile()) {
      throw new AttachmentAuthorityError(
        "ATTACHMENT_NOT_FILE",
        `attachment target is not a regular file: ${finalPath}`,
        { path: finalPath },
      );
    }
    return "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export async function readAttachment(
  featureDir: string,
  owner: AttachmentOwner,
  field: string,
  ref: AttachmentRef,
): Promise<Buffer> {
  const relative = assertAuthorizedRef(owner, field, ref);
  const root = await realFeatureRoot(featureDir);
  await prepareParent(root, relative, false);
  const finalPath = path.join(root, ...relative.split("/"));
  const state = await inspectFinalPath(finalPath);
  if (state === "missing") {
    throw new AttachmentAuthorityError(
      "ATTACHMENT_MISSING",
      `attachment file is missing: ${ref.path}`,
      { path: ref.path },
    );
  }

  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(finalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new AttachmentAuthorityError(
        "ATTACHMENT_MISSING",
        `attachment file is missing: ${ref.path}`,
        { path: ref.path },
      );
    }
    if (code === "ELOOP") {
      throw new AttachmentAuthorityError(
        "ATTACHMENT_UNSAFE_PATH",
        `attachment file became a symlink: ${ref.path}`,
        { path: ref.path },
      );
    }
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new AttachmentAuthorityError(
        "ATTACHMENT_NOT_FILE",
        `attachment target is not a regular file: ${ref.path}`,
        { path: ref.path },
      );
    }
    const body = await handle.readFile();
    const actualSha256 = createHash("sha256").update(body).digest("hex");
    if (
      stat.size !== body.byteLength ||
      body.byteLength !== ref.size ||
      actualSha256 !== ref.sha256
    ) {
      throw new AttachmentAuthorityError(
        "ATTACHMENT_INTEGRITY",
        `attachment ${ref.path} integrity mismatch`,
        {
          expected_size: ref.size,
          actual_size: body.byteLength,
          expected_sha256: ref.sha256,
          actual_sha256: actualSha256,
        },
      );
    }
    return body;
  } finally {
    await handle.close();
  }
}

export async function writeAttachment(
  featureDir: string,
  owner: AttachmentOwner,
  field: string,
  content: string | Buffer,
  opts: AttachmentWriteOptions = {},
): Promise<AttachmentRef> {
  const relative = expectedRelativePath(owner, field);
  const root = await realFeatureRoot(featureDir);
  const parent = await prepareParent(root, relative, true);
  const finalPath = path.join(root, ...relative.split("/"));
  await inspectFinalPath(finalPath);

  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const tmpPath = path.join(
    parent,
    `.${path.basename(finalPath)}.tmp-${randomBytes(6).toString("hex")}`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      tmpPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o644,
    );
    await handle.writeFile(body);
    if (opts.fsync ?? true) await handle.sync();
    await handle.close();
    handle = undefined;

    // Recheck immediately before rename so a pre-existing escaping symlink is
    // never replaced as an apparently harmless retry.
    await inspectFinalPath(finalPath);
    await fs.rename(tmpPath, finalPath);
    if (opts.fsync ?? true) {
      const directory = await fs.open(parent, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tmpPath).catch(() => {});
  }

  return {
    path: relative,
    sha256: createHash("sha256").update(body).digest("hex"),
    size: body.byteLength,
  };
}
