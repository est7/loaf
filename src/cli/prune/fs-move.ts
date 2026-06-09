// Shared cross-device move primitives for prune execute (slice 2) + restore
// (slice 3). Trash may live on a different mount than a project's `.loaf`, so a
// plain `fs.rename` can fail EXDEV; fall back to copy + remove.

import { promises as fs } from "node:fs";

/**
 * Rename a directory; copy+rm across devices. Returns false (not an error) when
 * the source is already gone (ENOENT) so callers can degrade gracefully.
 */
export async function moveDir(src: string, dest: string): Promise<boolean> {
  try {
    await fs.rename(src, dest);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    if (code === "EXDEV") {
      await fs.cp(src, dest, { recursive: true });
      await fs.rm(src, { recursive: true, force: true });
      return true;
    }
    throw err;
  }
}

/** Rename a file; copy+unlink across devices. */
export async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await fs.copyFile(src, dest);
      await fs.rm(src, { force: true });
    } else {
      throw err;
    }
  }
}
