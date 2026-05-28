// Phase 16 SC-7 — runtime import-boundary guard.
//
// Per codex r280 P1: runtime core modules must NOT import from
// `docs/schemas.ts`. The canonical Zod source lives in docs/, but
// `src/core/*` mirrors the subset it needs in `src/core/projection-schema.ts`
// (matching the existing StateProjection / TasksJson / etc. pattern).
//
// This guard scans src/core/registry-writer.ts (the SC-7 new module)
// AND src/core/journal-mutate.ts (which gained registry imports) +
// asserts neither imports from `docs/`.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..",
);

async function readRepo(rel: string): Promise<string> {
  return await fs.readFile(path.join(REPO_ROOT, rel), "utf8");
}

describe("SC-7 — runtime ↔ docs import boundary", () => {
  test("src/core/registry-writer.ts does NOT import from docs/", async () => {
    const source = await readRepo("src/core/registry-writer.ts");
    expect(source).not.toMatch(/from\s+["'][^"']*docs\//);
    expect(source).not.toMatch(/import\s+["'][^"']*docs\//);
  });

  test("src/core/projection-schema.ts (the runtime mirror) does NOT import from docs/", async () => {
    const source = await readRepo("src/core/projection-schema.ts");
    expect(source).not.toMatch(/from\s+["'][^"']*docs\//);
  });
});
