// Internal sidecar reference vocabulary.
//
// AttachmentRef is persistence state, not public authoring input. Internal
// writers materialize long text below the owning journal entry bucket:
//
//   attachments/<entry_id>/<slot...>
//
// This module owns the lexical contract only. Filesystem authorization,
// entry/slot ownership, symlink handling, and integrity-checked IO live in the
// attachment authority introduced by the next architecture slice.

import path from "node:path";

import { z } from "zod";

const ATTACHMENT_ENTRY_ID = /^JE-\d{6,}$/;

export const AttachmentPath = z
  .string()
  .min(1)
  .regex(/^attachments\/JE-\d{6,}\/[^/\\\0]+(?:\/[^/\\\0]+)*$/, {
    message: "attachment path must use attachments/<entry_id>/<file> POSIX form",
  })
  .superRefine((value, ctx) => {
    if (value.includes("\0")) {
      ctx.addIssue({ code: "custom", message: "attachment path must not contain NUL" });
    }
    if (value.includes("\\")) {
      ctx.addIssue({ code: "custom", message: "attachment path must use POSIX separators" });
    }
    if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
      ctx.addIssue({ code: "custom", message: "attachment path must be feature-relative" });
    }

    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      ctx.addIssue({
        code: "custom",
        message: "attachment path must not contain empty, '.' or '..' segments",
      });
    }
    if (segments[0] !== "attachments") {
      ctx.addIssue({ code: "custom", message: "attachment path must start with attachments/" });
    }
    if (!ATTACHMENT_ENTRY_ID.test(segments[1] ?? "")) {
      ctx.addIssue({
        code: "custom",
        message: "attachment path must use an attachments/<entry_id>/ bucket",
      });
    }
    if (segments.length < 3) {
      ctx.addIssue({
        code: "custom",
        message: "attachment path must identify a file inside the entry bucket",
      });
    }
  });
export type AttachmentPath = z.infer<typeof AttachmentPath>;

export const AttachmentRef = z
  .object({
    path: AttachmentPath,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
  })
  .strict();
export type AttachmentRef = z.infer<typeof AttachmentRef>;

export const SIDECAR_THRESHOLD_BYTES = 8 * 1024;

export const InlineLongTextField = z
  .object({ mode: z.literal("inline"), text: z.string() })
  .strict();
export type InlineLongTextField = z.infer<typeof InlineLongTextField>;

export const LongTextField = z.discriminatedUnion("mode", [
  InlineLongTextField,
  z.object({ mode: z.literal("sidecar"), ref: AttachmentRef }).strict(),
]);
export type LongTextField = z.infer<typeof LongTextField>;
