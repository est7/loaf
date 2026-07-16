import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { generateFsmMermaid } from "../../scripts/gen-fsm-artifacts.js";

const DRIFT_MESSAGE =
  "FSM artifact drift detected. Run `bun run gen:fsm` and commit docs/fsm.mmd.";

async function readCommittedArtifact(): Promise<string> {
  try {
    return await readFile(new URL("../../docs/fsm.mmd", import.meta.url), "utf8");
  } catch (cause) {
    throw new Error(DRIFT_MESSAGE, { cause });
  }
}

describe("FSM Mermaid artifact", () => {
  test("committed docs/fsm.mmd matches the deterministic generator", async () => {
    const generated = generateFsmMermaid();
    const committed = await readCommittedArtifact();

    expect(committed, DRIFT_MESSAGE).toBe(generated);
    expect(generateFsmMermaid()).toBe(generated);
  });

  test("renders composite phases and owner-aware transitions only", () => {
    const generated = generateFsmMermaid();

    expect(generated).toContain("stateDiagram-v2\n");
    for (const phase of ["TRIAGE", "SPEC", "EXECUTE", "VERIFY", "SETTLE", "DONE"]) {
      expect(generated).toContain(`  state ${phase} {\n`);
    }

    expect(generated).toContain("  TRIAGE_score --> TRIAGE_confirm\n");
    expect(generated).toContain(
      "  TRIAGE_confirm --> SPEC_proposal : spec_phase_required\n",
    );
    expect(generated).toContain(
      "  VERIFY_accept --> SETTLE_reconcile : settle_phase_required && verify_accepted_required\n",
    );
    expect(generated).toContain(
      "  EXECUTE_done --> DONE_delivered : session:delivered\n",
    );
    expect(generated).toContain(
      "  SETTLE_lessons --> DONE_archived : session:archived\n",
    );
    expect(generated).not.toContain("contract:next");
    expect(generated).not.toContain("EXECUTE_work --> EXECUTE_work");
    expect(generated).not.toContain("VERIFY_plan --> VERIFY_review");
  });
});
