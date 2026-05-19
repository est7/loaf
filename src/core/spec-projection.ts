// spec.md projection writer — derived-output boundary for the SPEC
// frontmatter (Slice A SC-A2). Mirrors sidecar.ts's pure-compose vs
// IO-write split.
//
// Wire point: journal-mutate.ts post-appendMany Pass 5. Journal is
// authoritative (appendMany single-fsync write); spec.md is a derived
// projection synced after journal append succeeds. On write failure,
// mutateBatch surfaces PROJECTION_WRITE_FAILED — `loaf doctor --rebuild`
// is the recovery path (Slice 5 D), NOT retry of the originating CLI
// command (the journal already records the change, retry would hit
// DUPLICATE_*_ID).
//
// Reader-writer fence grammar shared via splitFrontmatter() in
// spec-frontmatter.ts (codex r90 — both sides MUST agree).

import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { stringify as yamlStringify } from "yaml";

import { SpecFrontmatter, SCHEMA_VERSION } from "./spec-schema.js";
import { splitFrontmatter } from "./spec-frontmatter.js";
import type { Snapshot } from "./reducer.js";

/**
 * Composes the spec.md content (frontmatter + preserved body) from a
 * snapshot. Pure: no IO. Validates the composed frontmatter against
 * SpecFrontmatter zod BEFORE stringify (codex r90 strict gate — catches
 * snapshot drift from a future reducer change).
 *
 * Throws when `snapshot.spec_header` or `snapshot.state` is null. Callers
 * must check those preconditions OR scope this call to a batch known to
 * contain a spec-emitting kind. The Pass 5 wire in journal-mutate scopes
 * by SPEC_EMITTING_KINDS, so an unexpected null here signals projection
 * corruption and gets surfaced as PROJECTION_WRITE_FAILED.
 */
export function composeSpecMdFrontmatter(
  snapshot: Snapshot,
  existingBody: string = "",
): string {
  if (snapshot.state === null) {
    throw new Error(
      "composeSpecMdFrontmatter: snapshot.state is null (no session) — cannot project spec.md without spec_version",
    );
  }
  if (snapshot.spec_header === null) {
    throw new Error(
      "composeSpecMdFrontmatter: snapshot.spec_header is null — invariant violation, spec-emitting batch reached projection writer without populated header",
    );
  }
  const fm = {
    schema_version: SCHEMA_VERSION,
    spec_version: snapshot.state.spec_version,
    feature: snapshot.spec_header.feature,
    intent: snapshot.spec_header.intent,
    adr_refs: snapshot.spec_header.adr_refs,
    requirements: snapshot.requirements,
    scenarios: snapshot.scenarios,
    visual_contracts: snapshot.visual_contracts,
    needs_clarification: snapshot.spec_header.needs_clarification,
  };
  // Strict gate: parse() throws on mismatch. Defense-in-depth against a
  // future reducer drift that leaves snapshot inconsistent.
  SpecFrontmatter.parse(fm);
  const yaml = yamlStringify(fm);
  return `---\n${yaml}---\n${existingBody}`;
}

/**
 * Writes the derived spec.md to disk atomically. Pattern mirrors
 * snapshot.writeMeta:70-89 / codex r84 Q3:
 *   1. random tmp suffix (avoids collision / TOCTOU surprises)
 *   2. write tmp + fsync the tmp file
 *   3. rename tmp → final (atomic on same FS)
 *   4. best-effort fsync parent dir (durability across power loss)
 *
 * Preserves the existing markdown body (everything after the closing
 * `---\n` of the prior frontmatter) verbatim. User-owned content;
 * SC-A2 does not interpret, strip, or warn.
 *
 * Invariant guarantee (codex r90 Q7): final spec.md is absent or
 * unchanged on failure, never partially replaced. Tmp file residue
 * after mid-write failure is acceptable under the existing
 * crash/doctor model; callers should not assert "no tmp leftover".
 *
 * Does NOT acquire the per-feature lock. Callers must invoke from
 * within the outer mutateBatch critical section (MVP single-writer
 * assumption — see TODO at journal-mutate.ts Pass 5).
 */
export async function writeDerivedSpecMd(
  snapshot: Snapshot,
  featureDir: string,
): Promise<void> {
  const specPath = path.join(featureDir, "spec.md");

  // Preserve existing body across re-write.
  let existingBody = "";
  try {
    const raw = await fsp.readFile(specPath, "utf8");
    existingBody = splitFrontmatter(raw).body;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // ENOENT — no existing spec.md, will create fresh with empty body.
  }

  const content = composeSpecMdFrontmatter(snapshot, existingBody);

  const tmp = `${specPath}.tmp-${randomBytes(6).toString("hex")}`;
  await fsp.writeFile(tmp, content, { mode: 0o644 });

  let fh = await fsp.open(tmp, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }

  await fsp.rename(tmp, specPath);

  // Best-effort parent fsync. Some filesystems (tmpfs) reject dir
  // fsync; mirror snapshot.writeMeta's tolerance.
  try {
    fh = await fsp.open(path.dirname(specPath), "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    /* best-effort dir fsync */
  }
}
