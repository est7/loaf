import { promises as fs } from "node:fs";

import { describe, expect, test } from "vitest";

describe("SessionRuntimeFile doctor --rebuild exemption", () => {
  test("doctor rebuild seam and projection writer do not import or reference runtime storage", async () => {
    const doctor = await fs.readFile("src/cli/commands/profile-config.tsx", "utf8");
    const projections = await fs.readFile("src/core/projection-writer.ts", "utf8");
    expect(doctor).toContain("writeProjections");
    for (const source of [doctor, projections]) {
      expect(source).not.toMatch(/from ["'][^"']*session-runtime/);
      expect(source).not.toMatch(/\b(?:read|write)SessionRuntimeFile\b|\bwithRuntimeLock\b/);
    }
  });
});
