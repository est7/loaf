import { describe, expect, test } from "vitest";

import { SUB_STATE_CONTRACTS as MACHINE_CONTRACTS } from "../../src/core/machine.js";
import {
  SUB_STATE_CONTRACTS,
  SUB_STATE_CONTRACT_BY_STATE,
  SubStateContract,
  promptInjectFor,
} from "../../src/core/sub-state-contracts.js";

describe("derived sub-state machine contracts", () => {
  test("runtime shim exposes the machine-derived array without copying", () => {
    expect(SUB_STATE_CONTRACTS).toBe(MACHINE_CONTRACTS);
  });

  test("every derived contract parses through the runtime schema", () => {
    for (const contract of SUB_STATE_CONTRACTS) {
      const result = SubStateContract.safeParse(contract);
      expect(result.success, `contract ${contract.sub_state} failed schema`).toBe(true);
    }
  });

  test("BY_STATE and promptInjectFor cover every contract", () => {
    for (const contract of SUB_STATE_CONTRACTS) {
      expect(SUB_STATE_CONTRACT_BY_STATE[contract.sub_state]).toBe(contract);
      expect(promptInjectFor(contract.sub_state)).toBe(contract.prompt_inject);
    }
    expect(promptInjectFor("NOPE.unknown")).toBeUndefined();
  });
});
