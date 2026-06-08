import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mktempd, runShellScript, safeRm } from "./_helpers.js";

const fixtures: string[] = [];
const driftProbe = "finding_" + "close";

function track(root: string): string {
  fixtures.push(root);
  return root;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) safeRm(root);
});

function writeProbe(root: string, relativePath: string, body: string): void {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

describe("check-event-drift.sh", () => {
  test("ignores generated dist sourcemap drift probes", () => {
    const root = track(mktempd("event-drift-dist-"));

    // dist is excluded because it is generated output, not because
    // driftProbe is acceptable in canonical source.
    writeProbe(root, "dist/__drift-probe.map", `${driftProbe}\n`);

    const result = runShellScript("check-event-drift.sh", [root]);

    expect(result.exit, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("0 drift hits");
  });

  test("still catches canonical source drift probes", () => {
    const root = track(mktempd("event-drift-src-"));
    writeProbe(root, "src/__drift-probe.ts", `${driftProbe}\n`);

    const result = runShellScript("check-event-drift.sh", [root]);

    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("canonical event-name drift detected");
    expect(result.stdout).toContain("src/__drift-probe.ts");
  });
});
