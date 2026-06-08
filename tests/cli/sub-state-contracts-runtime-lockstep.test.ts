// Phase 16 SC-15b — SUB_STATE_CONTRACTS runtime/docs lockstep drift gate.
//
// Catches drift between `docs/schemas.ts:SUB_STATE_CONTRACTS` (canonical)
// and `src/core/sub-state-contracts.ts` (runtime mirror). The mirror is
// full (not prompt-only) per codex GO Q-C lock, so the lockstep compares
// the entire contract objects, not just prompt_inject.

import { describe, expect, test } from "vitest";

import {
  SUB_STATE_CONTRACTS as DOCS_CONTRACTS,
  SubStateContract as DocsSubStateContract,
} from "../../docs/schemas.js";
import {
  SUB_STATE_CONTRACTS,
  SUB_STATE_CONTRACT_BY_STATE,
  promptInjectFor,
} from "../../src/core/sub-state-contracts.js";

// JSON round-trip normalizes optional `mutation_rights` (undefined vs
// absent) so deep-equality is stable across the optional field.
function norm(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("SUB_STATE_CONTRACTS runtime/docs lockstep", () => {
  test("same length + same sub_state order", () => {
    expect(SUB_STATE_CONTRACTS.map((c) => c.sub_state)).toEqual(
      DOCS_CONTRACTS.map((c) => c.sub_state),
    );
  });

  test("every contract deep-equals its docs counterpart (full object)", () => {
    expect(norm(SUB_STATE_CONTRACTS)).toEqual(norm(DOCS_CONTRACTS));
  });

  test("every runtime contract parses through docs SubStateContract schema", () => {
    for (const contract of SUB_STATE_CONTRACTS) {
      const result = DocsSubStateContract.safeParse(contract);
      expect(result.success, `contract ${contract.sub_state} failed docs schema`).toBe(true);
    }
  });

  test("BY_STATE map covers every contract + promptInjectFor agrees", () => {
    for (const contract of SUB_STATE_CONTRACTS) {
      expect(SUB_STATE_CONTRACT_BY_STATE[contract.sub_state]).toBe(contract);
      expect(promptInjectFor(contract.sub_state)).toBe(contract.prompt_inject);
    }
    expect(promptInjectFor("NOPE.unknown")).toBeUndefined();
  });
});
