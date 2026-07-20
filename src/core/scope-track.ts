// PostToolUse scope-path normalization. This is deliberately separate from
// write-guard's frozen lexical `normalizeToRepoRoot`: audit scope records the
// filesystem-resolved target, including symlink resolution and missing-leaf
// reconstruction.

import { promises as fs } from "node:fs";
import path from "node:path";

import { ScopePath } from "./journal-entry.js";

export type NormalizedScopePath =
  | { ok: true; kind: "scope" | "internal"; path: string }
  | { ok: false; reason: "outside_repo_root" | "invalid_scope_path"; path: string };

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function realpathWithMissingSuffix(absolute: string): Promise<string> {
  const suffix: string[] = [];
  let candidate = absolute;
  while (true) {
    try {
      const existing = await fs.realpath(candidate);
      return path.resolve(existing, ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      suffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

/** Resolve a hook path to the canonical repo-relative POSIX audit path. */
export async function normalizeScopePath(
  targetPath: string,
  repoRoot: string,
): Promise<NormalizedScopePath> {
  const lexicalRoot = path.resolve(repoRoot);
  const canonicalRoot = await fs.realpath(lexicalRoot);
  const requested = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(lexicalRoot, targetPath);

  // A lexical escape stays rejected even if an outside symlink happens to
  // point back into the repo. Absolute canonical-root paths remain valid when
  // the selected repoRoot itself is a symlink.
  if (!isContained(lexicalRoot, requested) && !isContained(canonicalRoot, requested)) {
    return { ok: false, reason: "outside_repo_root", path: targetPath };
  }

  const canonicalTarget = await realpathWithMissingSuffix(requested);
  if (!isContained(canonicalRoot, canonicalTarget)) {
    return { ok: false, reason: "outside_repo_root", path: targetPath };
  }

  const relative = path.relative(canonicalRoot, canonicalTarget).split(path.sep).join("/");
  if (relative === ".loaf" || relative.startsWith(".loaf/")) {
    return { ok: true, kind: "internal", path: relative };
  }
  const parsed = ScopePath.safeParse(relative);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_scope_path", path: relative };
  }
  return { ok: true, kind: "scope", path: parsed.data };
}
